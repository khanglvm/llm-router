import { spawnSync } from "node:child_process";
import { clearRuntimeState, getActiveRuntimeState } from "./instance-state.js";
import { startupStatus, stopStartup } from "./startup-manager.js";

export function parsePidList(text) {
  const tokens = String(text || "")
    .split(/[\s\r\n]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return [...new Set(tokens
    .filter((token) => /^\d+$/.test(token))
    .map((token) => Number(token))
    .filter((pid) => Number.isInteger(pid) && pid > 0))];
}

export function parseFuserPidList(text) {
  const normalized = String(text || "")
    .replace(/\b\d+\/tcp:\s*/gi, " ")
    .trim();
  if (!normalized) return [];
  return parsePidList(normalized);
}

function listListeningPidsWithLsof(port, spawnSyncImpl) {
  const result = spawnSyncImpl("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8"
  });
  if (result.error) {
    return { ok: false, pids: [], tool: "lsof", error: result.error };
  }

  return {
    ok: true,
    pids: parsePidList(result.stdout),
    tool: "lsof"
  };
}

function listListeningPidsWithFuser(port, spawnSyncImpl) {
  const result = spawnSyncImpl("fuser", ["-n", "tcp", String(port)], {
    encoding: "utf8"
  });
  if (result.error) {
    return { ok: false, pids: [], tool: "fuser", error: result.error };
  }

  return {
    ok: true,
    pids: parseFuserPidList(result.stdout),
    tool: "fuser"
  };
}

export function listListeningPids(port, deps = {}) {
  const spawnSyncImpl = typeof deps.spawnSync === "function" ? deps.spawnSync : spawnSync;
  const lsof = listListeningPidsWithLsof(port, spawnSyncImpl);
  if (lsof.ok) return lsof;

  const fuser = listListeningPidsWithFuser(port, spawnSyncImpl);
  if (fuser.ok) return fuser;

  return {
    ok: false,
    pids: [],
    tool: "none",
    error: lsof.error || fuser.error
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPortToRelease(port, timeoutMs = 4000, deps = {}) {
  const listListeningPidsFn = typeof deps.listListeningPids === "function"
    ? deps.listListeningPids
    : (targetPort) => listListeningPids(targetPort, deps);
  const sleepFn = typeof deps.sleep === "function" ? deps.sleep : sleep;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const probe = listListeningPidsFn(port);
    if (!probe.ok) {
      await sleepFn(150);
      continue;
    }
    if (probe.pids.length === 0) {
      return true;
    }
    await sleepFn(150);
  }

  const finalProbe = listListeningPidsFn(port);
  if (!finalProbe.ok) return false;
  return finalProbe.pids.length === 0;
}

export async function stopStartupManagedListener({ port, line, error }, deps = {}) {
  const getActiveRuntimeStateFn = typeof deps.getActiveRuntimeState === "function"
    ? deps.getActiveRuntimeState
    : getActiveRuntimeState;
  const startupStatusFn = typeof deps.startupStatus === "function"
    ? deps.startupStatus
    : startupStatus;
  const stopStartupFn = typeof deps.stopStartup === "function"
    ? deps.stopStartup
    : stopStartup;
  const clearRuntimeStateFn = typeof deps.clearRuntimeState === "function"
    ? deps.clearRuntimeState
    : clearRuntimeState;

  let activeRuntimeState = null;
  try {
    activeRuntimeState = await getActiveRuntimeStateFn();
  } catch {
    activeRuntimeState = null;
  }

  let shouldStopStartup = false;
  if (activeRuntimeState?.managedByStartup) {
    shouldStopStartup = Number(activeRuntimeState.port) === Number(port);
  } else if (!activeRuntimeState) {
    try {
      const status = await startupStatusFn();
      shouldStopStartup = Boolean(status?.running);
    } catch {
      shouldStopStartup = false;
    }
  }

  if (!shouldStopStartup) return { ok: true, attempted: false };

  line(`Detected startup-managed llm-router on port ${port}. Stopping startup service before reclaim.`);
  try {
    await stopStartupFn();
    await clearRuntimeStateFn();
    return { ok: true, attempted: true };
  } catch (startupError) {
    error(`Failed stopping startup-managed service: ${startupError instanceof Error ? startupError.message : String(startupError)}`);
    return {
      ok: false,
      attempted: true,
      errorMessage: `Port ${port} is occupied by a startup-managed llm-router service and could not be stopped automatically. Stop it with 'llm-router stop' or 'llm-router config --operation=startup-uninstall' and retry.`
    };
  }
}

export async function reclaimPort({ port, line, error }, deps = {}) {
  const selfPid = Number.isInteger(deps.selfPid) ? deps.selfPid : process.pid;
  const stopStartupManagedListenerFn = typeof deps.stopStartupManagedListener === "function"
    ? deps.stopStartupManagedListener
    : (args) => stopStartupManagedListener(args, deps);
  const listListeningPidsFn = typeof deps.listListeningPids === "function"
    ? deps.listListeningPids
    : (targetPort) => listListeningPids(targetPort, deps);
  const waitForPortToReleaseFn = typeof deps.waitForPortToRelease === "function"
    ? deps.waitForPortToRelease
    : (targetPort, timeoutMs) => waitForPortToRelease(targetPort, timeoutMs, deps);
  const killFn = typeof deps.kill === "function" ? deps.kill : process.kill.bind(process);

  const startupStop = await stopStartupManagedListenerFn({ port, line, error });
  if (!startupStop.ok) {
    return {
      ok: false,
      errorMessage: startupStop.errorMessage
    };
  }

  const probe = listListeningPidsFn(port);
  if (!probe.ok) {
    return {
      ok: false,
      errorMessage: `Port ${port} is in use but process lookup failed (${probe.error instanceof Error ? probe.error.message : String(probe.error || "unknown error")}).`
    };
  }

  const targets = probe.pids.filter((pid) => pid !== selfPid);
  if (targets.length === 0) {
    return {
      ok: false,
      errorMessage: `Port ${port} is in use but no external listener PID was detected.`
    };
  }

  line(`Port ${port} is already in use. Stopping existing listener(s): ${targets.join(", ")}.`);

  for (const pid of targets) {
    try {
      killFn(pid, "SIGTERM");
    } catch (killError) {
      error(`Failed sending SIGTERM to pid ${pid}: ${killError instanceof Error ? killError.message : String(killError)}`);
    }
  }

  let released = await waitForPortToReleaseFn(port, 3000);
  if (!released) {
    const remaining = listListeningPidsFn(port);
    const remainingTargets = (remaining.pids || []).filter((pid) => pid !== selfPid);

    if (remainingTargets.length > 0) {
      line(`Port ${port} still busy. Force killing listener(s): ${remainingTargets.join(", ")}.`);
      for (const pid of remainingTargets) {
        try {
          killFn(pid, "SIGKILL");
        } catch (killError) {
          error(`Failed sending SIGKILL to pid ${pid}: ${killError instanceof Error ? killError.message : String(killError)}`);
        }
      }
      released = await waitForPortToReleaseFn(port, 2000);
    }
  }

  if (!released) {
    return {
      ok: false,
      errorMessage: `Failed to reclaim port ${port}; listener process is still running.`
    };
  }

  return {
    ok: true
  };
}

