import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { FIXED_LOCAL_ROUTER_HOST, FIXED_LOCAL_ROUTER_PORT } from "./local-server-settings.js";

const DEFAULT_INSTANCE_STATE_FILENAME = ".llm-router.runtime.json";
const MAX_START_OUTPUT_CHARS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(text)) return true;
  if (["0", "false", "no", "n"].includes(text)) return false;
  return fallback;
}

function normalizeRuntimeState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pid = Number(raw.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  return {
    pid,
    host: String(raw.host || FIXED_LOCAL_ROUTER_HOST),
    port: Number.isFinite(Number(raw.port)) ? Number(raw.port) : FIXED_LOCAL_ROUTER_PORT,
    configPath: String(raw.configPath || ""),
    watchConfig: normalizeBoolean(raw.watchConfig, true),
    watchBinary: normalizeBoolean(raw.watchBinary, true),
    requireAuth: normalizeBoolean(raw.requireAuth, false),
    managedByStartup: normalizeBoolean(raw.managedByStartup, false),
    cliPath: String(raw.cliPath || ""),
    startedAt: String(raw.startedAt || new Date().toISOString()),
    version: String(raw.version || "")
  };
}

function normalizeHost(value, fallback = FIXED_LOCAL_ROUTER_HOST) {
  return String(value || fallback).trim() || fallback;
}

function normalizeCliPath(value) {
  const target = String(value || "").trim();
  if (!target) return "";
  return path.isAbsolute(target) ? target : path.resolve(target);
}

function appendRecentOutput(current, chunk, maxChars = MAX_START_OUTPUT_CHARS) {
  if (!chunk) return current;
  const combined = `${current}${chunk}`;
  return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}

function formatStartFailureMessage(baseMessage, { stderr = "", stdout = "" } = {}) {
  const detail = String(stderr || "").trim() || String(stdout || "").trim();
  return detail ? `${baseMessage}\n${detail}` : baseMessage;
}

function runtimeMatchesStartOptions(runtime, {
  configPath,
  host = FIXED_LOCAL_ROUTER_HOST,
  port = FIXED_LOCAL_ROUTER_PORT,
  watchConfig = true,
  watchBinary = true,
  requireAuth = false
} = {}) {
  const normalized = normalizeRuntimeState(runtime);
  if (!normalized) return false;

  return normalizeHost(normalized.host) === normalizeHost(host)
    && Number(normalized.port) === Number(port)
    && String(normalized.configPath || "").trim() === String(configPath || "").trim()
    && normalized.watchConfig === normalizeBoolean(watchConfig, true)
    && normalized.watchBinary === normalizeBoolean(watchBinary, true)
    && normalized.requireAuth === normalizeBoolean(requireAuth, false);
}

export function getRuntimeStatePath() {
  return path.join(os.homedir(), DEFAULT_INSTANCE_STATE_FILENAME);
}

export async function readRuntimeState(filePath = getRuntimeStatePath()) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeRuntimeState(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeRuntimeState(state, filePath = getRuntimeStatePath()) {
  const normalized = normalizeRuntimeState(state);
  if (!normalized) throw new Error("Invalid runtime state.");

  const folder = path.dirname(filePath);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  return normalized;
}

export async function clearRuntimeState({ pid } = {}, filePath = getRuntimeStatePath()) {
  if (pid !== undefined && pid !== null) {
    const current = await readRuntimeState(filePath);
    if (!current) return false;
    if (Number(current.pid) !== Number(pid)) return false;
  }

  try {
    await fs.rm(filePath, { force: true });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function isProcessRunning(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

export async function getActiveRuntimeState({ cleanupStale = true } = {}) {
  const state = await readRuntimeState();
  if (!state) return null;
  if (isProcessRunning(state.pid)) return state;

  if (cleanupStale) {
    await clearRuntimeState({ pid: state.pid });
  }
  return null;
}

export async function stopProcessByPid(pid, { graceMs = 4000 } = {}) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, reason: "Invalid pid." };
  }

  if (!isProcessRunning(id)) {
    return { ok: true, alreadyStopped: true };
  }

  try {
    process.kill(id, "SIGTERM");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < graceMs) {
    if (!isProcessRunning(id)) {
      return { ok: true, signal: "SIGTERM" };
    }
    await sleep(150);
  }

  if (!isProcessRunning(id)) {
    return { ok: true, signal: "SIGTERM" };
  }

  try {
    process.kill(id, "SIGKILL");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  await sleep(150);
  if (isProcessRunning(id)) {
    return { ok: false, reason: `Process ${id} is still running after SIGKILL.` };
  }
  return { ok: true, signal: "SIGKILL" };
}

export function buildStartArgsFromState(state) {
  const target = normalizeRuntimeState(state);
  if (!target) {
    return {
      configPath: "",
      host: FIXED_LOCAL_ROUTER_HOST,
      port: FIXED_LOCAL_ROUTER_PORT,
      watchConfig: true,
      watchBinary: true,
      requireAuth: false
    };
  }
  return {
    configPath: target.configPath,
    host: target.host,
    port: target.port,
    watchConfig: target.watchConfig,
    watchBinary: target.watchBinary,
    requireAuth: target.requireAuth
  };
}

export async function waitForRuntimeMatch(options = {}, deps = {}) {
  const getActiveRuntimeStateFn = typeof deps.getActiveRuntimeState === "function"
    ? deps.getActiveRuntimeState
    : getActiveRuntimeState;
  const timeoutMs = Number.isFinite(Number(deps.timeoutMs)) ? Math.max(250, Number(deps.timeoutMs)) : 8000;
  const pollIntervalMs = Number.isFinite(Number(deps.pollIntervalMs)) ? Math.max(50, Number(deps.pollIntervalMs)) : 125;
  const requireManagedByStartup = deps.requireManagedByStartup === true;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const runtime = await getActiveRuntimeStateFn().catch(() => null);
    if (runtimeMatchesStartOptions(runtime, options)
      && (!requireManagedByStartup || runtime?.managedByStartup)) {
      return runtime;
    }
    await sleep(pollIntervalMs);
  }

  return null;
}

export function spawnStartProcess({
  cliPath,
  configPath,
  host = FIXED_LOCAL_ROUTER_HOST,
  port = FIXED_LOCAL_ROUTER_PORT,
  watchConfig = true,
  watchBinary = true,
  requireAuth = false
}, {
  detached = true,
  stdio = "ignore",
  unref = false,
  env = process.env
} = {}) {
  const finalCliPath = normalizeCliPath(cliPath || env.LLM_ROUTER_CLI_PATH || process.argv[1] || "");
  if (!finalCliPath) throw new Error("Cannot spawn llm-router start: CLI path is unknown.");

  const args = [
    finalCliPath,
    "start",
    `--config=${configPath}`,
    `--host=${host}`,
    `--port=${port}`,
    `--watch-config=${watchConfig ? "true" : "false"}`,
    `--watch-binary=${watchBinary ? "true" : "false"}`,
    `--require-auth=${requireAuth ? "true" : "false"}`
  ];

  const child = spawn(process.execPath, args, {
    detached,
    stdio,
    env: {
      ...env,
      LLM_ROUTER_CLI_PATH: finalCliPath
    }
  });

  if (unref) child.unref();
  return child;
}

export async function startDetachedRouterService(options = {}, deps = {}) {
  const getActiveRuntimeStateFn = typeof deps.getActiveRuntimeState === "function"
    ? deps.getActiveRuntimeState
    : getActiveRuntimeState;
  const spawnStartProcessFn = typeof deps.spawnStartProcess === "function"
    ? deps.spawnStartProcess
    : spawnStartProcess;
  const timeoutMs = Number.isFinite(Number(deps.timeoutMs)) ? Math.max(250, Number(deps.timeoutMs)) : 8000;
  const pollIntervalMs = Number.isFinite(Number(deps.pollIntervalMs)) ? Math.max(50, Number(deps.pollIntervalMs)) : 125;

  let child;
  try {
    child = spawnStartProcessFn(options, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      unref: false,
      env: deps.env || process.env
    });
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }

  let childError = null;
  let childExit = null;
  let stdout = "";
  let stderr = "";
  const onStdout = (chunk) => {
    stdout = appendRecentOutput(stdout, chunk);
  };
  const onStderr = (chunk) => {
    stderr = appendRecentOutput(stderr, chunk);
  };
  child.stdout?.setEncoding?.("utf8");
  child.stderr?.setEncoding?.("utf8");
  child.stdout?.on?.("data", onStdout);
  child.stderr?.on?.("data", onStderr);
  child.once("error", (error) => {
    childError = error;
  });
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });

  const cleanupChildIo = () => {
    child.stdout?.off?.("data", onStdout);
    child.stderr?.off?.("data", onStderr);
    child.stdout?.destroy?.();
    child.stderr?.destroy?.();
  };

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const runtime = await getActiveRuntimeStateFn().catch(() => null);
    if (runtimeMatchesStartOptions(runtime, options)) {
      cleanupChildIo();
      child.unref();
      return {
        ok: true,
        pid: child.pid,
        runtime
      };
    }

    if (childError) {
      cleanupChildIo();
      return {
        ok: false,
        errorMessage: formatStartFailureMessage(
          childError instanceof Error ? childError.message : String(childError),
          { stderr, stdout }
        )
      };
    }

    if (childExit) {
      cleanupChildIo();
      return {
        ok: false,
        errorMessage: formatStartFailureMessage(
          `llm-router exited before becoming ready (${childExit.signal || childExit.code || "unknown"}).`,
          { stderr, stdout }
        ),
        exitCode: childExit.code,
        signal: childExit.signal || ""
      };
    }

    await sleep(pollIntervalMs);
  }

  cleanupChildIo();
  child.unref();
  return {
    ok: false,
    errorMessage: formatStartFailureMessage(
      `Timed out waiting for llm-router to start on http://${normalizeHost(options.host)}:${Number(options.port || FIXED_LOCAL_ROUTER_PORT)}.`,
      { stderr, stdout }
    ),
    pid: child.pid
  };
}

export function spawnDetachedStart({
  cliPath,
  configPath,
  host = FIXED_LOCAL_ROUTER_HOST,
  port = FIXED_LOCAL_ROUTER_PORT,
  watchConfig = true,
  watchBinary = true,
  requireAuth = false
}) {
  const child = spawnStartProcess({
    cliPath,
    configPath,
    host,
    port,
    watchConfig,
    watchBinary,
    requireAuth
  }, {
    detached: true,
    stdio: "ignore",
    unref: true,
    env: process.env
  });
  return child.pid;
}
