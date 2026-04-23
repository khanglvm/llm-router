import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { deriveLlamacppLaunchProfile } from "./llamacpp-runtime-profile.js";

export const LLAMACPP_DEFAULT_HOST = "127.0.0.1";
export const LLAMACPP_DEFAULT_PORT = 39391;
const LLAMACPP_EXECUTABLE = "llama-server";
const FALLBACK_LLAMACPP_PATHS = Object.freeze([
  "/opt/homebrew/bin/llama-server",
  "/usr/local/bin/llama-server"
]);
const COMMON_SOURCE_BUILD_PATHS = Object.freeze([
  "src/llama-cpp/build/bin/llama-server",
  "src/llama.cpp/build/bin/llama-server",
  "src/llama-cpp-turboquant/build/bin/llama-server",
  "src/llama.cpp-turboquant/build/bin/llama-server"
]);

let managedLlamacppRuntime = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePort(value, fallback = LLAMACPP_DEFAULT_PORT) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

function normalizePathEntries(entries) {
  return Array.isArray(entries)
    ? entries.map((entry) => normalizeString(entry)).filter(Boolean)
    : [];
}

function readConfiguredLlamacppRuntime(config) {
  const runtime = config?.metadata?.localModels?.runtime?.llamacpp;
  if (!isPlainObject(runtime)) {
    return {
      startWithRouter: false,
      command: "",
      host: LLAMACPP_DEFAULT_HOST,
      port: LLAMACPP_DEFAULT_PORT
    };
  }

  return {
    startWithRouter: runtime.startWithRouter === true,
    command: normalizeString(runtime.selectedCommand || runtime.manualCommand || runtime.command || runtime.path),
    host: normalizeString(runtime.host) || LLAMACPP_DEFAULT_HOST,
    port: normalizePort(runtime.port, LLAMACPP_DEFAULT_PORT)
  };
}

function buildPreloadModels(config) {
  const library = config?.metadata?.localModels?.library;
  const variants = config?.metadata?.localModels?.variants;
  if (!isPlainObject(library) || !isPlainObject(variants)) return [];

  const preloadModels = [];
  for (const variant of Object.values(variants)) {
    if (!isPlainObject(variant)) continue;
    if (variant.runtime !== "llamacpp" || variant.preload !== true || variant.enabled !== true) continue;
    const baseModel = library[variant.baseModelId];
    const modelPath = normalizeString(baseModel?.path);
    if (!modelPath) continue;
    preloadModels.push({
      variantId: normalizeString(variant.id),
      variant,
      baseModel,
      modelPath,
      contextWindow: Number.isFinite(Number(variant.contextWindow)) ? Number(variant.contextWindow) : undefined
    });
  }
  return preloadModels;
}

function detectLlamacppSystemProfile(system = {}) {
  const totalMemoryBytes = Number(system?.totalMemoryBytes);
  return {
    platform: normalizeString(system?.platform) || process.platform,
    unifiedMemory: system?.unifiedMemory === true || process.platform === "darwin",
    totalMemoryBytes: Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 ? totalMemoryBytes : os.totalmem()
  };
}

export function detectLlamacppCandidates({
  envPathEntries = process.env.PATH?.split(path.delimiter) || [],
  homeDir = os.homedir(),
  existingPaths = null
} = {}) {
  const seen = new Set();
  const candidates = [];
  const searchTargets = [
    ...normalizePathEntries(envPathEntries).map((entry) => ({
      path: path.join(entry, LLAMACPP_EXECUTABLE),
      source: "path"
    })),
    ...FALLBACK_LLAMACPP_PATHS.map((entry) => ({
      path: entry,
      source: "homebrew"
    })),
    ...COMMON_SOURCE_BUILD_PATHS.map((entry) => ({
      path: path.join(homeDir, entry),
      source: "source-build"
    }))
  ];

  for (const target of searchTargets) {
    const candidatePath = normalizeString(target.path);
    if (seen.has(candidatePath)) continue;
    seen.add(candidatePath);
    const exists = existingPaths instanceof Set ? existingPaths.has(candidatePath) : existsSync(candidatePath);
    if (!exists) continue;
    candidates.push({
      id: candidatePath,
      label: candidatePath,
      path: candidatePath,
      source: target.source
    });
  }

  return candidates;
}

export function buildLlamacppLaunchArgs({
  command,
  host = LLAMACPP_DEFAULT_HOST,
  port = LLAMACPP_DEFAULT_PORT,
  preloadModels = [],
  launchProfile = null
} = {}) {
  const firstModel = Array.isArray(preloadModels) ? preloadModels[0] : null;
  const args = [
    normalizeString(command),
    "--host", normalizeString(host) || LLAMACPP_DEFAULT_HOST,
    "--port", String(normalizePort(port, LLAMACPP_DEFAULT_PORT)),
    ...((Array.isArray(launchProfile?.args) ? launchProfile.args : []).filter(Boolean))
  ];

  if (!launchProfile && firstModel?.modelPath) {
    args.push("-m", firstModel.modelPath);
    if (Number.isFinite(Number(firstModel.contextWindow)) && Number(firstModel.contextWindow) > 0) {
      args.push("-c", String(Math.floor(Number(firstModel.contextWindow))));
    }
  }

  return args.filter(Boolean);
}

export function parseLlamacppValidationOutput(output = "") {
  const text = String(output || "").trim();
  const lowered = text.toLowerCase();
  const supportsHost = /(^|\s)--host(\s|$)/m.test(text);
  const supportsPort = /(^|\s)--port(\s|$)/m.test(text);
  const referencesModelFlag = /(^|\s)(-m,\s+)?--model(\s|$)/m.test(text);
  const looksLikeServerHelp = supportsHost && supportsPort && referencesModelFlag;
  const kind = lowered.includes("llama-server") || looksLikeServerHelp ? "server" : "";

  return {
    ok: Boolean(kind) && supportsHost && supportsPort,
    kind,
    supportsHost,
    supportsPort,
    isTurboQuant: lowered.includes("turboquant") || /\bturbo[234]\b/.test(lowered)
  };
}

export function validateLlamacppCommand(command, { spawnSyncImpl = spawnSync } = {}) {
  const target = normalizeString(command);
  if (!target) {
    return {
      ok: false,
      errorMessage: "No llama.cpp command is configured."
    };
  }

  const result = spawnSyncImpl(target, ["--help"], {
    encoding: "utf8"
  });
  if (result?.error) {
    return {
      ok: false,
      errorMessage: result.error instanceof Error ? result.error.message : String(result.error)
    };
  }

  const parsed = parseLlamacppValidationOutput(`${result?.stdout || ""}\n${result?.stderr || ""}`);
  if (!parsed.ok) {
    return {
      ok: false,
      errorMessage: `Command '${target}' does not appear to be a compatible llama-server binary.`,
      ...parsed
    };
  }

  return {
    ok: true,
    ...parsed
  };
}

async function startConfiguredRuntime(config, {
  line = () => {},
  error = () => {},
  requireAutostart = true
} = {}, {
  spawnSyncImpl = spawnSync,
  spawnImpl = spawn
} = {}) {
  const runtime = readConfiguredLlamacppRuntime(config);
  if (requireAutostart && !runtime.startWithRouter) {
    return { ok: true, skipped: true, reason: "autostart-disabled" };
  }

  if (!runtime.command) {
    const errorMessage = "llama.cpp autostart is enabled, but no runtime command is configured.";
    error(errorMessage);
    return { ok: false, errorMessage };
  }

  if (managedLlamacppRuntime
    && managedLlamacppRuntime.command === runtime.command
    && managedLlamacppRuntime.host === runtime.host
    && managedLlamacppRuntime.port === runtime.port
    && managedLlamacppRuntime.child?.exitCode === null
    && managedLlamacppRuntime.child?.killed !== true) {
    return { ok: true, alreadyRunning: true, runtime: managedLlamacppRuntime };
  }

  const validation = validateLlamacppCommand(runtime.command, { spawnSyncImpl });
  if (!validation.ok) {
    error(validation.errorMessage || `Failed validating llama.cpp runtime '${runtime.command}'.`);
    return validation;
  }

  const preloadModels = buildPreloadModels(config);
  const firstModel = Array.isArray(preloadModels) ? preloadModels[0] : null;
  const launchProfile = firstModel?.variant && firstModel?.baseModel
    ? deriveLlamacppLaunchProfile({
      variant: firstModel.variant,
      baseModel: firstModel.baseModel,
      system: detectLlamacppSystemProfile(deps.system)
    })
    : null;
  const args = buildLlamacppLaunchArgs({
    command: runtime.command,
    host: runtime.host,
    port: runtime.port,
    preloadModels,
    launchProfile
  });

  return new Promise((resolve) => {
    let settled = false;
    const child = spawnImpl(args[0], args.slice(1), {
      stdio: "ignore"
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.once("spawn", () => {
      managedLlamacppRuntime = {
        child,
        command: runtime.command,
        host: runtime.host,
        port: runtime.port,
        args
      };
      child.once("exit", () => {
        if (managedLlamacppRuntime?.child === child) {
          managedLlamacppRuntime = null;
        }
      });
      if (typeof child.unref === "function") child.unref();
      line(`Started llama.cpp runtime on http://${runtime.host}:${runtime.port}${validation.isTurboQuant ? " (TurboQuant detected)" : ""}.`);
      finish({ ok: true, runtime: managedLlamacppRuntime, validation });
    });

    child.once("error", (spawnError) => {
      const errorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
      error(`Failed starting llama.cpp runtime: ${errorMessage}`);
      finish({ ok: false, errorMessage });
    });
  });
}

export async function ensureConfiguredLlamacppRuntimeStarted(config, callbacks = {}, deps = {}) {
  return startConfiguredRuntime(config, {
    ...callbacks,
    requireAutostart: true
  }, deps);
}

export async function startConfiguredLlamacppRuntime(config, callbacks = {}, deps = {}) {
  return startConfiguredRuntime(config, {
    ...callbacks,
    requireAutostart: false
  }, deps);
}

export async function stopManagedLlamacppRuntime({
  line = () => {},
  error = () => {}
} = {}) {
  const active = managedLlamacppRuntime;
  if (!active?.child) {
    return { ok: true, skipped: true, reason: "not-running" };
  }

  managedLlamacppRuntime = null;
  try {
    active.child.kill("SIGTERM");
    line("Stopped managed llama.cpp runtime.");
    return { ok: true };
  } catch (stopError) {
    const errorMessage = stopError instanceof Error ? stopError.message : String(stopError);
    error(`Failed stopping llama.cpp runtime: ${errorMessage}`);
    return { ok: false, errorMessage };
  }
}
