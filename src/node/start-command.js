import path from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { configFileExists, getDefaultConfigPath, readConfigFile, readConfigFileState, writeConfigFile } from "./config-store.js";
import { buildStartArgsFromState, clearRuntimeState, getActiveRuntimeState, stopProcessByPid, waitForRuntimeMatch, writeRuntimeState } from "./instance-state.js";
import {
  FIXED_LOCAL_ROUTER_HOST,
  applyLocalServerSettings,
  areLocalServerSettingsEqual,
  readLocalServerSettings
} from "./local-server-settings.js";
import { resolveListenPort } from "./listen-port.js";
import { startLocalRouteServer } from "./local-server.js";
import { startRouterSupervisor } from "./router-supervisor.js";
import { reclaimPort, stopStartupManagedListener } from "./port-reclaim.js";
import { installStartup, startupStatus } from "./startup-manager.js";
import { ensureConfiguredLlamacppRuntimeStarted, stopManagedLlamacppRuntime } from "./llamacpp-runtime.js";
import { configHasProvider, sanitizeConfigForDisplay } from "../runtime/config.js";

function summarizeConfig(config, configPath) {
  const target = sanitizeConfigForDisplay(config);
  const lines = [];
  lines.push(`Config: ${configPath}`);
  lines.push(`Default model: ${target.defaultModel || "(not set)"}`);
  lines.push(`Master key: ${target.masterKey || "(not set)"}`);
  lines.push(`AMP upstream URL: ${target.amp?.upstreamUrl || "(disabled)"}`);
  lines.push(`AMP upstream API key: ${target.amp?.upstreamApiKey || "(not set)"}`);
  lines.push(`AMP restrict management to localhost: ${target.amp?.restrictManagementToLocalhost === true ? "yes" : "no"}`);
  lines.push(`AMP force model mappings: ${target.amp?.forceModelMappings === true ? "yes" : "no"}`);
  lines.push(`AMP model mappings: ${(target.amp?.modelMappings || []).map((mapping) => `${mapping.from}->${mapping.to}`).join(", ") || "(none)"}`);
  const ampDefinitions = Array.isArray(target.amp?.subagentDefinitions) ? target.amp.subagentDefinitions : null;
  lines.push(`AMP subagent definitions: ${ampDefinitions ? ampDefinitions.map((entry) => `${entry.id}=>${(entry.patterns || []).join("|")}`).join(", ") || "(none)" : "(default built-ins)"}`);
  lines.push(`AMP subagent mappings: ${Object.entries(target.amp?.subagentMappings || {}).map(([agent, route]) => `${agent}->${route}`).join(", ") || "(none)"}`);

  if (!target.providers || target.providers.length === 0) {
    lines.push("Providers: (none)");
    return lines;
  }

  lines.push("Providers:");
  for (const provider of target.providers) {
    lines.push(`- ${provider.id} (${provider.name})`);
    lines.push(`  baseUrl=${provider.baseUrl}`);
    if (provider.baseUrlByFormat?.openai) {
      lines.push(`  openaiBaseUrl=${provider.baseUrlByFormat.openai}`);
    }
    if (provider.baseUrlByFormat?.claude) {
      lines.push(`  claudeBaseUrl=${provider.baseUrlByFormat.claude}`);
    }
    lines.push(`  formats=${(provider.formats || []).join(", ") || provider.format || "unknown"}`);
    lines.push(`  apiKey=${provider.apiKey || "(from env/hidden)"}`);
    lines.push(`  models=${(provider.models || []).map((model) => {
      const fallbacks = (model.fallbackModels || []).join("|");
      return fallbacks ? `${model.id}{fallback:${fallbacks}}` : model.id;
    }).join(", ") || "(none)"}`);
  }

  return lines;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatStartupConfigMigrationMessage(configState, configPath) {
  if (!configState?.changed) return "";

  const beforeVersion = Number(configState.beforeVersion);
  const afterVersion = Number(configState.afterVersion);
  const versionChanged = Number.isInteger(beforeVersion) && Number.isInteger(afterVersion) && beforeVersion !== afterVersion;
  const baseMessage = versionChanged
    ? `Config auto-migrated from v${beforeVersion} to v${afterVersion}`
    : "Config auto-normalized for startup compatibility";

  if (configState.persisted) {
    return `${baseMessage} and saved to ${configPath}.`;
  }

  if (configState.persistError) {
    const detail = configState.persistError instanceof Error
      ? configState.persistError.message
      : String(configState.persistError);
    return `${baseMessage} for this run, but could not be saved to ${configPath}: ${detail}`;
  }

  return "";
}

function safeRealpath(filePath) {
  if (!filePath) return "";
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function resolvePackageJsonPathFromCliPath(cliPath) {
  if (!cliPath) return "";
  let dir = path.dirname(cliPath);
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return "";
}

function readPackageVersion(packageJsonPath) {
  if (!packageJsonPath || !existsSync(packageJsonPath)) return "";
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof parsed?.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
}

function snapshotCliVersionState(cliPath) {
  const realpath = safeRealpath(cliPath);
  const packageJsonPath = resolvePackageJsonPathFromCliPath(realpath);
  const version = readPackageVersion(packageJsonPath);
  return { cliPath, realpath, packageJsonPath, version };
}

function buildStartArgs({
  configPath,
  host = FIXED_LOCAL_ROUTER_HOST,
  port = FIXED_LOCAL_ROUTER_PORT,
  watchConfig,
  watchBinary,
  requireAuth,
  useConfigDefaults = false,
  command = "start"
}) {
  const args = [
    command,
    `--config=${configPath}`,
    `--host=${host}`,
    `--port=${port}`
  ];
  if (useConfigDefaults) return args;
  args.push(
    `--watch-config=${watchConfig ? "true" : "false"}`,
    `--watch-binary=${watchBinary ? "true" : "false"}`,
    `--require-auth=${requireAuth ? "true" : "false"}`
  );
  return args;
}

function spawnReplacementCli({ cliPath, startArgs }) {
  return new Promise((resolve) => {
    try {
      const env = { ...process.env };
      env.LLM_ROUTER_CLI_PATH = cliPath;
      delete env.LLM_ROUTER_MANAGED_BY_STARTUP;

      const child = spawn(process.execPath, [cliPath, ...startArgs], {
        stdio: "inherit",
        env
      });

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      child.once("spawn", () => finish({ ok: true, pid: child.pid }));
      child.once("error", (error) => finish({ ok: false, error }));
    } catch (error) {
      resolve({ ok: false, error });
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStartupConflictChoice(value) {
  const raw = typeof value === "object" && value !== null
    ? (value.action ?? value.choice ?? "")
    : value;
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return "";
  if (["1", "restart", "restart-startup", "restart_startup", "restart-startup-managed"].includes(normalized)) {
    return "restart-startup";
  }
  if (["2", "stop-start", "stop-and-start-here", "takeover", "manual-takeover"].includes(normalized)) {
    return "stop-and-start-here";
  }
  if (["3", "exit", "quit", "cancel"].includes(normalized)) {
    return "exit";
  }
  return "";
}

async function detectStartupManagedConflictOnPort(port, deps = {}) {
  const getActiveRuntimeStateFn = typeof deps.getActiveRuntimeState === "function"
    ? deps.getActiveRuntimeState
    : getActiveRuntimeState;
  const startupStatusFn = typeof deps.startupStatus === "function"
    ? deps.startupStatus
    : startupStatus;

  let runtime = null;
  try {
    runtime = await getActiveRuntimeStateFn();
  } catch {
    runtime = null;
  }

  if (runtime?.managedByStartup && Number(runtime.port) === Number(port)) {
    return {
      running: true,
      runtime,
      source: "runtime-state"
    };
  }

  let status = null;
  try {
    status = await startupStatusFn();
  } catch {
    status = null;
  }

  if (status?.running) {
    return {
      running: true,
      runtime,
      status,
      source: "startup-status"
    };
  }

  return {
    running: false,
    runtime,
    status,
    source: "none"
  };
}

async function handoffToStartupManagedWithLatest({
  runtimeState,
  fallbackStartArgs,
  cliPath,
  line,
  error
}, deps = {}) {
  const getActiveRuntimeStateFn = typeof deps.getActiveRuntimeState === "function"
    ? deps.getActiveRuntimeState
    : getActiveRuntimeState;
  const stopProcessByPidFn = typeof deps.stopProcessByPid === "function"
    ? deps.stopProcessByPid
    : stopProcessByPid;
  const clearRuntimeStateFn = typeof deps.clearRuntimeState === "function"
    ? deps.clearRuntimeState
    : clearRuntimeState;
  const reclaimPortFn = typeof deps.reclaimPort === "function"
    ? deps.reclaimPort
    : (args) => reclaimPort(args, deps);
  const installStartupFn = typeof deps.installStartup === "function"
    ? deps.installStartup
    : installStartup;
  const waitForRuntimeMatchFn = typeof deps.waitForRuntimeMatch === "function"
    ? deps.waitForRuntimeMatch
    : (options, waitOptions = {}) => waitForRuntimeMatch(options, waitOptions);

  const startArgs = runtimeState?.managedByStartup
    ? buildStartArgsFromState(runtimeState)
    : fallbackStartArgs;

  let activeRuntime = null;
  try {
    activeRuntime = await getActiveRuntimeStateFn();
  } catch {
    activeRuntime = null;
  }

  if (activeRuntime && Number(activeRuntime.pid) !== Number(process.pid) && !activeRuntime.managedByStartup) {
    const stopped = await stopProcessByPidFn(activeRuntime.pid);
    if (!stopped?.ok) {
      return {
        ok: false,
        errorMessage: stopped?.reason || `Failed to stop existing LLM Router pid ${activeRuntime.pid}.`
      };
    }
    await clearRuntimeStateFn({ pid: activeRuntime.pid });
    line(`Stopped manual LLM Router on http://${activeRuntime.host}:${activeRuntime.port} so the startup service can own the router.`);
  }

  const reclaimed = await reclaimPortFn({ port: startArgs.port, line, error });
  if (!reclaimed.ok) {
    return {
      ok: false,
      errorMessage: reclaimed.errorMessage
    };
  }

  try {
    await clearRuntimeStateFn();
    const detail = await installStartupFn({
      configPath: startArgs.configPath,
      host: startArgs.host,
      port: startArgs.port,
      watchConfig: startArgs.watchConfig,
      watchBinary: startArgs.watchBinary,
      requireAuth: startArgs.requireAuth,
      cliPath
    });
    const runtime = await waitForRuntimeMatchFn(startArgs, {
      getActiveRuntimeState: getActiveRuntimeStateFn,
      requireManagedByStartup: true
    });
    if (!runtime) {
      return {
        ok: false,
        errorMessage: `Startup-managed LLM Router did not become ready on http://${startArgs.host}:${startArgs.port}.`
      };
    }
    return {
      ok: true,
      detail,
      runtime,
      startArgs
    };
  } catch (startupRestartError) {
    const message = startupRestartError instanceof Error ? startupRestartError.message : String(startupRestartError);
    error(`Failed restarting startup-managed service: ${message}`);
    return {
      ok: false,
      errorMessage: `Failed to restart the startup-managed LLM Router instance with the latest installed version: ${message}`
    };
  }
}

async function attemptServerStartAfterStartupStop(buildLocalServerOptions, deps = {}, {
  attempts = 24,
  delayMs = 250
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const startLocalRouteServerFn = typeof deps.startLocalRouteServer === "function" ? deps.startLocalRouteServer : startLocalRouteServer;
      const server = await startLocalRouteServerFn(buildLocalServerOptions());
      return { ok: true, server };
    } catch (error) {
      lastError = error;
      if (error?.code !== "EADDRINUSE") {
        return { ok: false, error };
      }
      if (attempt < attempts - 1) {
        await sleep(delayMs);
      }
    }
  }
  return { ok: false, error: lastError };
}

async function runRouterRuntimeCommand(options = {}) {
  const configPath = options.configPath || getDefaultConfigPath();
  const backendMode = options.backendMode === true;
  const requestedWatchConfig = options.watchConfig;
  const requestedWatchBinary = options.watchBinary;
  const binaryWatchIntervalMs = Math.max(
    1000,
    toNumber(options.binaryWatchIntervalMs ?? process.env.LLM_ROUTER_BINARY_WATCH_INTERVAL_MS, 15000)
  );
  const requestedRequireAuth = options.requireAuth;
  const onStartupConflict = typeof options.onStartupConflict === "function" ? options.onStartupConflict : null;
  const managedByStartup = options.managedByStartup === true || process.env.LLM_ROUTER_MANAGED_BY_STARTUP === "1";
  const cliPathForWatch = String(options.cliPathForWatch || process.env.LLM_ROUTER_CLI_PATH || process.argv[1] || "");
  const startCommand = String(options.startCommand || (backendMode ? "start-runtime" : "start")).trim() || "start";
  const line = typeof options.onLine === "function" ? options.onLine : console.log;
  const error = typeof options.onError === "function" ? options.onError : console.error;
  const startLocalRouteServerFn = typeof options.startLocalRouteServer === "function" ? options.startLocalRouteServer : startLocalRouteServer;
  const getActiveRuntimeStateFn = typeof options.getActiveRuntimeState === "function" ? options.getActiveRuntimeState : getActiveRuntimeState;
  const stopProcessByPidFn = typeof options.stopProcessByPid === "function" ? options.stopProcessByPid : stopProcessByPid;
  const clearRuntimeStateFn = typeof options.clearRuntimeState === "function" ? options.clearRuntimeState : clearRuntimeState;
  const installStartupFn = typeof options.installStartup === "function" ? options.installStartup : installStartup;
  const startupStatusFn = typeof options.startupStatus === "function" ? options.startupStatus : startupStatus;
  const reclaimPortFn = typeof options.reclaimPort === "function"
    ? options.reclaimPort
    : (args) => reclaimPort(args, options);
  const waitForRuntimeMatchFn = typeof options.waitForRuntimeMatch === "function"
    ? options.waitForRuntimeMatch
    : (startOptions, waitOptions = {}) => waitForRuntimeMatch(startOptions, waitOptions);

  if (!(await configFileExists(configPath))) {
    return {
      ok: false,
      exitCode: 2,
      errorMessage: [
        `Config file not found: ${configPath}`,
        "Run 'llr config' to create provider config or 'llr -h' for help."
      ].join("\n")
    };
  }

  let configState;
  try {
    configState = await readConfigFileState(configPath);
  } catch (readConfigError) {
    return {
      ok: false,
      exitCode: 2,
      errorMessage: `Failed to load config from ${configPath}: ${readConfigError instanceof Error ? readConfigError.message : String(readConfigError)}`
    };
  }

  const configMigrationMessage = formatStartupConfigMigrationMessage(configState, configPath);
  if (configMigrationMessage) {
    if (configState.persistError) {
      error(configMigrationMessage);
    } else {
      line(configMigrationMessage);
    }
  }

  let config = configState.config;
  const persistedLocalServer = readLocalServerSettings(config);
  const host = backendMode
    ? String(options.host || FIXED_LOCAL_ROUTER_HOST).trim() || FIXED_LOCAL_ROUTER_HOST
    : FIXED_LOCAL_ROUTER_HOST;
  const port = backendMode
    ? Math.max(1, Number(options.port || FIXED_LOCAL_ROUTER_PORT))
    : resolveListenPort({ explicitPort: persistedLocalServer.port });
  const watchConfig = requestedWatchConfig === undefined ? persistedLocalServer.watchConfig : toBoolean(requestedWatchConfig, persistedLocalServer.watchConfig);
  const watchBinary = requestedWatchBinary === undefined ? persistedLocalServer.watchBinary : toBoolean(requestedWatchBinary, persistedLocalServer.watchBinary);
  const requireAuth = requestedRequireAuth === undefined ? persistedLocalServer.requireAuth : toBoolean(requestedRequireAuth, persistedLocalServer.requireAuth);
  const resolvedLocalServer = { host, port, watchConfig, watchBinary, requireAuth };

  if (!areLocalServerSettingsEqual(persistedLocalServer, resolvedLocalServer)) {
    config = await readConfigFile(configPath, { persistMigrated: false });
    config = applyLocalServerSettings(config, resolvedLocalServer);
    config = await writeConfigFile(config, configPath);
  }
  if (!configHasProvider(config)) {
    return {
      ok: false,
      exitCode: 2,
      errorMessage: [
        `No providers configured in ${configPath}`,
        "Run 'llr config' to add a provider or 'llr -h' for help."
      ].join("\n")
    };
  }

  if (requireAuth && !config.masterKey) {
    return {
      ok: false,
      exitCode: 2,
      errorMessage: [
        `Local auth requires masterKey in ${configPath}.`,
        "Run 'llr config --operation=set-master-key --master-key=...' or start without --require-auth."
      ].join("\n")
    };
  }

  const requestedStartArgs = {
    configPath,
    host,
    port,
    watchConfig,
    watchBinary,
    requireAuth
  };

  const startup = backendMode ? null : await startupStatusFn().catch(() => null);
  if (!backendMode && !managedByStartup && startup?.installed) {
    const handoff = await handoffToStartupManagedWithLatest({
      runtimeState: null,
      fallbackStartArgs: requestedStartArgs,
      cliPath: cliPathForWatch,
      line,
      error
    }, {
      getActiveRuntimeState: getActiveRuntimeStateFn,
      stopProcessByPid: stopProcessByPidFn,
      clearRuntimeState: clearRuntimeStateFn,
      reclaimPort: reclaimPortFn,
      installStartup: installStartupFn,
      waitForRuntimeMatch: waitForRuntimeMatchFn,
      startupStatus: startupStatusFn,
      onLine: line,
      onError: error
    });
    if (!handoff.ok) {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: handoff.errorMessage
      };
    }
    return {
      ok: true,
      exitCode: 0,
      data: [
        `Startup-managed LLM Router is active on http://${handoff.runtime.host}:${handoff.runtime.port}.`,
        `manager=${handoff.detail?.manager || startup.manager || "unknown"}`,
        `service=${handoff.detail?.serviceId || startup.serviceId || "unknown"}`
      ].join("\n")
    };
  }

  let restartRequestedByConfig = false;
  let requestGracefulRelaunch = async () => {};

  const buildLocalServerOptions = () => ({
    port,
    host,
    configPath,
    watchConfig,
    requireAuth,
    validateConfig: (nextConfig) => {
      if (!configHasProvider(nextConfig)) {
        return "Config has no enabled providers.";
      }
      if (requireAuth && !nextConfig.masterKey) {
        return "masterKey is missing while --require-auth=true.";
      }
      return "";
    },
    onConfigReload: (nextConfig, reason) => {
      if (reason === "startup") return;
      const nextLocalServer = readLocalServerSettings(nextConfig, resolvedLocalServer);
      if (!areLocalServerSettingsEqual(nextLocalServer, resolvedLocalServer)) {
        if (restartRequestedByConfig) return;
        restartRequestedByConfig = true;
        void requestGracefulRelaunch({
          reasonMessage: `Local server settings changed in config (${reason}). Restarting to apply local router settings...`,
          manualRestartMessage: "Local server settings changed, but this process cannot resolve its CLI path. Restart `llr start` manually to apply them.",
          configPath,
          ...nextLocalServer
        });
        return;
      }

      line(`Config hot-reloaded in memory (${reason}).`);
      if (!configHasProvider(nextConfig)) {
        error("Reloaded config has no enabled providers.");
      }
    },
    onConfigReloadError: (reloadError, reason) => {
      error(`Config reload ignored (${reason}): ${reloadError instanceof Error ? reloadError.message : String(reloadError)}`);
    }
  });

  const activeRuntime = await getActiveRuntimeStateFn().catch(() => null);
  if (activeRuntime && Number(activeRuntime.pid) !== Number(process.pid)) {
    return {
      ok: false,
      exitCode: 1,
      errorMessage: `Another LLM Router instance is already running at http://${activeRuntime.host}:${activeRuntime.port}. Stop it before starting a new one.`
    };
  }

  let server;
  try {
    server = await startLocalRouteServerFn(buildLocalServerOptions());
  } catch (startError) {
    if (startError?.code !== "EADDRINUSE") {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: `Failed to start LLM Router on http://${host}:${port}: ${startError instanceof Error ? startError.message : String(startError)}`
      };
    }

    if (!managedByStartup && onStartupConflict) {
      const conflict = await detectStartupManagedConflictOnPort(port, { getActiveRuntimeState: getActiveRuntimeStateFn, startupStatus: startupStatusFn });
      if (conflict.running) {
        let choice = "";
        try {
          choice = normalizeStartupConflictChoice(await onStartupConflict({
            port,
            host,
            configPath,
            startup: conflict
          }));
        } catch (promptError) {
          error(`Failed reading startup conflict prompt: ${promptError instanceof Error ? promptError.message : String(promptError)}`);
        }

        if (choice === "restart-startup") {
          const restarted = await handoffToStartupManagedWithLatest({
            runtimeState: conflict.runtime,
            fallbackStartArgs: requestedStartArgs,
            cliPath: cliPathForWatch,
            line,
            error
          }, {
            getActiveRuntimeState: getActiveRuntimeStateFn,
            stopProcessByPid: stopProcessByPidFn,
            clearRuntimeState: clearRuntimeStateFn,
            reclaimPort: reclaimPortFn,
            installStartup: installStartupFn,
            waitForRuntimeMatch: waitForRuntimeMatchFn,
            startupStatus: startupStatusFn,
            onLine: line,
            onError: error
          });
          if (!restarted.ok) {
            return {
              ok: false,
              exitCode: 1,
              errorMessage: restarted.errorMessage
            };
          }
          return {
            ok: true,
            exitCode: 0,
            data: [
              "Restarted the startup-managed LLM Router instance with the latest installed version.",
              `manager=${restarted.detail?.manager || "unknown"}`,
              `service=${restarted.detail?.serviceId || "unknown"}`
            ].join("\n")
          };
        }

        if (choice === "exit") {
          return {
            ok: true,
            exitCode: 0,
            data: `Startup-managed LLM Router is still running on port ${port}. Exiting without changes.`
          };
        }

        if (choice === "stop-and-start-here") {
          const stopped = await stopStartupManagedListener({ port, line, error });
          if (!stopped.ok) {
            return {
              ok: false,
              exitCode: 1,
              errorMessage: stopped.errorMessage
            };
          }

          line("Startup-managed instance stopped. Starting LLM Router in this terminal...");
          const takeoverStart = await attemptServerStartAfterStartupStop(buildLocalServerOptions, { startLocalRouteServer: startLocalRouteServerFn });
          if (takeoverStart.ok) {
            server = takeoverStart.server;
            line(`Port ${port} reclaimed successfully.`);
          } else if (takeoverStart.error?.code !== "EADDRINUSE") {
            return {
              ok: false,
              exitCode: 1,
              errorMessage: `Failed to start LLM Router on http://${host}:${port}: ${takeoverStart.error instanceof Error ? takeoverStart.error.message : String(takeoverStart.error)}`
            };
          }
        }
      }
    }

    if (server) {
      // Startup conflict handling already resolved the bind conflict.
    } else {
      const reclaimed = await reclaimPortFn({ port, line, error });
      if (!reclaimed.ok) {
        return {
          ok: false,
          exitCode: 1,
          errorMessage: reclaimed.errorMessage
        };
      }

      try {
        server = await startLocalRouteServerFn(buildLocalServerOptions());
        line(`Port ${port} reclaimed successfully.`);
      } catch (retryError) {
        return {
          ok: false,
          exitCode: 1,
          errorMessage: `Failed to start LLM Router after reclaiming port ${port}: ${retryError instanceof Error ? retryError.message : String(retryError)}`
        };
      }
    }
  }
  line(`LLM Router started on http://${host}:${port}`);
  line(`Anthropic base URL: http://${host}:${port}/anthropic`);
  line(`OpenAI base URL: http://${host}:${port}/openai`);
  for (const row of summarizeConfig(config, configPath)) {
    line(row);
  }
  line(`Local auth: ${requireAuth ? "required (masterKey)" : "disabled"}`);
  line(`Config hot reload: ${watchConfig ? "enabled" : "disabled"} (in-memory, no process restart)`);
  line(`Binary update watch: ${watchBinary ? "enabled" : "disabled"}${managedByStartup ? " (startup-managed auto-restart)" : ""}`);
  line("Press Ctrl+C to stop.");

  let shuttingDown = false;
  let binaryWatchTimer = null;
  let binaryState = watchBinary && cliPathForWatch ? snapshotCliVersionState(cliPathForWatch) : null;
  let binaryNoticeSent = false;
  let relaunchInProgress = false;
  const runtimeVersion = binaryState?.version || readPackageVersion(resolvePackageJsonPathFromCliPath(safeRealpath(cliPathForWatch)));

  try {
    await writeRuntimeState({
      pid: process.pid,
      host,
      port,
      configPath,
      watchConfig,
      watchBinary,
      requireAuth,
      managedByStartup,
      cliPath: cliPathForWatch,
      startedAt: new Date().toISOString(),
      version: runtimeVersion
    });
  } catch (stateError) {
    error(`Failed to write runtime state file: ${stateError instanceof Error ? stateError.message : String(stateError)}`);
  }

  const closeServer = async () => {
    if (!server) return;
    const active = server;
    server = null;
    await new Promise((resolve) => active.close(() => resolve()));
  };

  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        if (binaryWatchTimer) clearInterval(binaryWatchTimer);
      } catch {
        // ignore
      }
      await closeServer();
      await clearRuntimeStateFn({ pid: process.pid });
      resolveDone();
    };

  requestGracefulRelaunch = async ({
    reasonMessage = "",
    manualRestartMessage = "",
    cliPath = cliPathForWatch || process.argv[1],
    configPath: nextConfigPath = configPath,
    host: nextHost = host,
    port: nextPort = port,
    watchConfig: nextWatchConfig = watchConfig,
    watchBinary: nextWatchBinary = watchBinary,
    requireAuth: nextRequireAuth = requireAuth
  } = {}) => {
    if (shuttingDown || relaunchInProgress) return;
    relaunchInProgress = true;

    if (reasonMessage) {
      line(reasonMessage);
    }

    if (managedByStartup) {
      await shutdown();
      process.exit(0);
      return;
    }

    if (!cliPath) {
      relaunchInProgress = false;
      error(manualRestartMessage || "LLM Router needs a manual restart because its CLI path cannot be resolved.");
      return;
    }

    await shutdown();
    const launch = await spawnReplacementCli({
      cliPath,
      startArgs: buildStartArgs({
        command: startCommand,
        configPath: nextConfigPath,
        host: nextHost,
        port: nextPort,
        watchConfig: nextWatchConfig,
        watchBinary: nextWatchBinary,
        requireAuth: nextRequireAuth
      })
    });
    if (!launch.ok) {
      error(`Failed to relaunch LLM Router: ${launch.error instanceof Error ? launch.error.message : String(launch.error)}`);
      process.exit(1);
      return;
    }

    line(`Started the replacement LLM Router process (pid ${launch.pid || "unknown"}).`);
    process.exit(0);
  };

  if (watchBinary && binaryState) {
    binaryWatchTimer = setInterval(() => {
      if (shuttingDown || relaunchInProgress) return;
      const nextState = snapshotCliVersionState(binaryState.cliPath);
      const changed =
        nextState.realpath !== binaryState.realpath ||
        (nextState.version && binaryState.version && nextState.version !== binaryState.version);

      if (!changed) return;

      const from = binaryState.version || binaryState.realpath || "(unknown)";
      const to = nextState.version || nextState.realpath || "(unknown)";
      binaryState = nextState;

      const cliPath = nextState.cliPath || cliPathForWatch || process.argv[1];
      if (!managedByStartup && !cliPath) {
        if (!binaryNoticeSent) {
          binaryNoticeSent = true;
          line(`Detected LLM Router update (${from} -> ${to}). Restart this process to run the new version.`);
        }
        return;
      }

      void requestGracefulRelaunch({
        reasonMessage: managedByStartup
          ? `Detected LLM Router update (${from} -> ${to}). Draining current requests before the startup manager relaunches the latest version.`
          : `Detected LLM Router update (${from} -> ${to}). Gracefully relaunching the latest version...`,
        manualRestartMessage: "Detected an updated LLM Router binary, but this process cannot resolve its CLI path. Restart it manually to run the new version.",
        cliPath
      }).catch((relaunchError) => {
        error(`Failed during LLM Router auto-relaunch: ${relaunchError instanceof Error ? relaunchError.message : String(relaunchError)}`);
        process.exit(1);
      });
    }, binaryWatchIntervalMs);
  }

  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGUSR2", () => {
    void requestGracefulRelaunch({
      reasonMessage: managedByStartup
        ? "Received runtime upgrade signal. Draining current requests before the startup manager relaunches the latest version..."
        : "Received runtime upgrade signal. Gracefully restarting to activate the newly installed version...",
      manualRestartMessage: "Received a runtime upgrade signal, but this process cannot resolve its CLI path. Restart it manually to activate the new version."
    }).catch((relaunchError) => {
      error(`Failed during the runtime upgrade relaunch: ${relaunchError instanceof Error ? relaunchError.message : String(relaunchError)}`);
      process.exit(1);
    });
  });

  await donePromise;

  return {
    ok: true,
    exitCode: 0,
    data: "Server stopped."
  };
}

async function runRouterSupervisorCommand(options = {}) {
  const configPath = options.configPath || getDefaultConfigPath();
  const requestedWatchConfig = options.watchConfig;
  const requestedWatchBinary = options.watchBinary;
  const requestedRequireAuth = options.requireAuth;
  const managedByStartup = options.managedByStartup === true || process.env.LLM_ROUTER_MANAGED_BY_STARTUP === "1";
  const cliPathForWatch = String(options.cliPathForWatch || process.env.LLM_ROUTER_CLI_PATH || process.argv[1] || "");
  const line = typeof options.onLine === "function" ? options.onLine : console.log;
  const error = typeof options.onError === "function" ? options.onError : console.error;
  const getActiveRuntimeStateFn = typeof options.getActiveRuntimeState === "function" ? options.getActiveRuntimeState : getActiveRuntimeState;
  const stopProcessByPidFn = typeof options.stopProcessByPid === "function" ? options.stopProcessByPid : stopProcessByPid;
  const clearRuntimeStateFn = typeof options.clearRuntimeState === "function" ? options.clearRuntimeState : clearRuntimeState;
  const installStartupFn = typeof options.installStartup === "function" ? options.installStartup : installStartup;
  const startupStatusFn = typeof options.startupStatus === "function" ? options.startupStatus : startupStatus;
  const reclaimPortFn = typeof options.reclaimPort === "function"
    ? options.reclaimPort
    : (args) => reclaimPort(args, options);
  const waitForRuntimeMatchFn = typeof options.waitForRuntimeMatch === "function"
    ? options.waitForRuntimeMatch
    : (startOptions, waitOptions = {}) => waitForRuntimeMatch(startOptions, waitOptions);
  const startRouterSupervisorFn = typeof options.startRouterSupervisor === "function"
    ? options.startRouterSupervisor
    : (startOptions) => startRouterSupervisor(startOptions, options);
  const ensureConfiguredLlamacppRuntimeStartedFn = typeof options.ensureConfiguredLlamacppRuntimeStarted === "function"
    ? options.ensureConfiguredLlamacppRuntimeStarted
    : ensureConfiguredLlamacppRuntimeStarted;
  const stopManagedLlamacppRuntimeFn = typeof options.stopManagedLlamacppRuntime === "function"
    ? options.stopManagedLlamacppRuntime
    : stopManagedLlamacppRuntime;

  if (!(await configFileExists(configPath))) {
    return {
      ok: false,
      exitCode: 2,
      errorMessage: [
        `Config file not found: ${configPath}`,
        "Run 'llr config' to create provider config or 'llr -h' for help."
      ].join("\n")
    };
  }

  let configState;
  try {
    configState = await readConfigFileState(configPath);
  } catch (readConfigError) {
    return {
      ok: false,
      exitCode: 2,
      errorMessage: `Failed to load config from ${configPath}: ${readConfigError instanceof Error ? readConfigError.message : String(readConfigError)}`
    };
  }

  const configMigrationMessage = formatStartupConfigMigrationMessage(configState, configPath);
  if (configMigrationMessage) {
    if (configState.persistError) {
      error(configMigrationMessage);
    } else {
      line(configMigrationMessage);
    }
  }

  let config = configState.config;
  const persistedLocalServer = readLocalServerSettings(config);
  const host = FIXED_LOCAL_ROUTER_HOST;
  const port = resolveListenPort({ explicitPort: persistedLocalServer.port });
  const watchConfig = requestedWatchConfig === undefined ? persistedLocalServer.watchConfig : toBoolean(requestedWatchConfig, persistedLocalServer.watchConfig);
  const watchBinary = requestedWatchBinary === undefined ? persistedLocalServer.watchBinary : toBoolean(requestedWatchBinary, persistedLocalServer.watchBinary);
  const requireAuth = requestedRequireAuth === undefined ? persistedLocalServer.requireAuth : toBoolean(requestedRequireAuth, persistedLocalServer.requireAuth);
  const resolvedLocalServer = { host, port, watchConfig, watchBinary, requireAuth };

  if (!areLocalServerSettingsEqual(persistedLocalServer, resolvedLocalServer)) {
    config = await readConfigFile(configPath, { persistMigrated: false });
    config = applyLocalServerSettings(config, resolvedLocalServer);
    config = await writeConfigFile(config, configPath);
  }
  if (!configHasProvider(config)) {
    return {
      ok: false,
      exitCode: 2,
      errorMessage: [
        `No providers configured in ${configPath}`,
        "Run 'llr config' to add a provider or 'llr -h' for help."
      ].join("\n")
    };
  }

  if (requireAuth && !config.masterKey) {
    return {
      ok: false,
      exitCode: 2,
      errorMessage: [
        `Local auth requires masterKey in ${configPath}.`,
        "Run 'llr config --operation=set-master-key --master-key=...' or start without --require-auth."
      ].join("\n")
    };
  }

  await ensureConfiguredLlamacppRuntimeStartedFn(config, { line, error });

  const requestedStartArgs = {
    configPath,
    host,
    port,
    watchConfig,
    watchBinary,
    requireAuth
  };

  const startup = await startupStatusFn().catch(() => null);
  if (!managedByStartup && startup?.installed) {
    const handoff = await handoffToStartupManagedWithLatest({
      runtimeState: null,
      fallbackStartArgs: requestedStartArgs,
      cliPath: cliPathForWatch,
      line,
      error
    }, {
      getActiveRuntimeState: getActiveRuntimeStateFn,
      stopProcessByPid: stopProcessByPidFn,
      clearRuntimeState: clearRuntimeStateFn,
      reclaimPort: reclaimPortFn,
      installStartup: installStartupFn,
      waitForRuntimeMatch: waitForRuntimeMatchFn,
      startupStatus: startupStatusFn,
      onLine: line,
      onError: error
    });
    if (!handoff.ok) {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: handoff.errorMessage
      };
    }
    return {
      ok: true,
      exitCode: 0,
      data: [
        `Startup-managed LLM Router is active on http://${handoff.runtime.host}:${handoff.runtime.port}.`,
        `manager=${handoff.detail?.manager || startup.manager || "unknown"}`,
        `service=${handoff.detail?.serviceId || startup.serviceId || "unknown"}`
      ].join("\n")
    };
  }

  const activeRuntime = await getActiveRuntimeStateFn().catch(() => null);
  if (activeRuntime && Number(activeRuntime.pid) !== Number(process.pid)) {
    return {
      ok: false,
      exitCode: 1,
      errorMessage: `Another LLM Router instance is already running at http://${activeRuntime.host}:${activeRuntime.port}. Stop it before starting a new one.`
    };
  }

  let server;
  try {
    server = await startRouterSupervisorFn({
      host,
      port,
      configPath,
      watchConfig,
      watchBinary,
      requireAuth,
      cliPath: cliPathForWatch,
      onLine: line,
      onError: error
    });
  } catch (startError) {
    if (startError?.code !== "EADDRINUSE") {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: `Failed to start LLM Router on http://${host}:${port}: ${startError instanceof Error ? startError.message : String(startError)}`
      };
    }

    const reclaimed = await reclaimPortFn({ port, line, error });
    if (!reclaimed.ok) {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: reclaimed.errorMessage
      };
    }

    try {
      server = await startRouterSupervisorFn({
        host,
        port,
        configPath,
        watchConfig,
        watchBinary,
        requireAuth,
        cliPath: cliPathForWatch,
        onLine: line,
        onError: error
      });
      line(`Port ${port} reclaimed successfully.`);
    } catch (retryError) {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: `Failed to start LLM Router after reclaiming port ${port}: ${retryError instanceof Error ? retryError.message : String(retryError)}`
      };
    }
  }

  const runtimeVersion = readPackageVersion(resolvePackageJsonPathFromCliPath(safeRealpath(cliPathForWatch)));
  try {
    await writeRuntimeState({
      pid: process.pid,
      host,
      port,
      configPath,
      watchConfig,
      watchBinary,
      requireAuth,
      managedByStartup,
      cliPath: cliPathForWatch,
      startedAt: new Date().toISOString(),
      version: runtimeVersion
    });
  } catch (stateError) {
    error(`Failed to write runtime state file: ${stateError instanceof Error ? stateError.message : String(stateError)}`);
  }

  line(`LLM Router started on http://${host}:${port}`);
  line(`Anthropic base URL: http://${host}:${port}/anthropic`);
  line(`OpenAI base URL: http://${host}:${port}/openai`);
  for (const row of summarizeConfig(config, configPath)) {
    line(row);
  }
  line(`Local auth: ${requireAuth ? "required (masterKey)" : "disabled"}`);
  line(`Config hot reload: ${watchConfig ? "enabled" : "disabled"} (backend hot reload via supervisor)`);
  line(`Binary update watch: ${watchBinary ? "enabled" : "disabled"} (backend hot-swap via supervisor)`);
  line("Press Ctrl+C to stop.");

  let shuttingDown = false;
  let shutdownPromise = null;
  const donePromise = new Promise((resolve) => {
    server.once("close", resolve);
  });
  const shutdown = async () => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      await stopManagedLlamacppRuntimeFn({ line, error });
      await new Promise((resolve) => server.close(() => resolve()));
      await clearRuntimeStateFn({ pid: process.pid });
    })();
    return shutdownPromise;
  };

  const handleSigInt = () => { void shutdown(); };
  const handleSigTerm = () => { void shutdown(); };
  const handleSigUsr2 = () => {
    void server.requestBackendUpgrade("SIGUSR2").then((result) => {
      if (!result?.ok) {
        error(`Failed forwarding runtime upgrade signal to router backend: ${result?.reason || "unknown error"}`);
      }
    }).catch((upgradeError) => {
      error(`Failed forwarding runtime upgrade signal to router backend: ${upgradeError instanceof Error ? upgradeError.message : String(upgradeError)}`);
    });
  };
  process.once("SIGINT", handleSigInt);
  process.once("SIGTERM", handleSigTerm);
  process.on("SIGUSR2", handleSigUsr2);

  await donePromise;
  if (shutdownPromise) {
    await shutdownPromise;
  } else {
    await stopManagedLlamacppRuntimeFn({ line, error });
  }

  process.removeListener("SIGINT", handleSigInt);
  process.removeListener("SIGTERM", handleSigTerm);
  process.removeListener("SIGUSR2", handleSigUsr2);

  return {
    ok: true,
    exitCode: 0,
    data: "Server stopped."
  };
}

export async function runStartCommand(options = {}) {
  if (options.backendMode === true) {
    return runRouterRuntimeCommand(options);
  }
  return runRouterSupervisorCommand(options);
}
