import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

const DEFAULT_INSTANCE_STATE_FILENAME = ".llm-router.runtime.json";

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
    host: String(raw.host || "127.0.0.1"),
    port: Number.isFinite(Number(raw.port)) ? Number(raw.port) : 8787,
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
      host: "127.0.0.1",
      port: 8787,
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

export function spawnDetachedStart({
  cliPath,
  configPath,
  host = "127.0.0.1",
  port = 8787,
  watchConfig = true,
  watchBinary = true,
  requireAuth = false
}) {
  const finalCliPath = String(cliPath || process.env.LLM_ROUTER_CLI_PATH || process.argv[1] || "").trim();
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
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      LLM_ROUTER_CLI_PATH: finalCliPath
    }
  });
  child.unref();
  return child.pid;
}
