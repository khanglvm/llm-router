import path from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { configFileExists, getDefaultConfigPath, readConfigFile } from "./config-store.js";
import { buildStartArgsFromState, clearRuntimeState, getActiveRuntimeState, writeRuntimeState } from "./instance-state.js";
import { resolveListenPort } from "./listen-port.js";
import { startLocalRouteServer } from "./local-server.js";
import { reclaimPort, stopStartupManagedListener } from "./port-reclaim.js";
import { installStartup, startupStatus } from "./startup-manager.js";
import { configHasProvider, sanitizeConfigForDisplay } from "../runtime/config.js";

function summarizeConfig(config, configPath) {
  const target = sanitizeConfigForDisplay(config);
  const lines = [];
  lines.push(`Config: ${configPath}`);
  lines.push(`Default model: ${target.defaultModel || "(not set)"}`);
  lines.push(`Master key: ${target.masterKey || "(not set)"}`);

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

function buildStartArgs({ configPath, host, port, watchConfig, watchBinary, requireAuth }) {
  return [
    "start",
    `--config=${configPath}`,
    `--host=${host}`,
    `--port=${port}`,
    `--watch-config=${watchConfig ? "true" : "false"}`,
    `--watch-binary=${watchBinary ? "true" : "false"}`,
    `--require-auth=${requireAuth ? "true" : "false"}`
  ];
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

async function detectStartupManagedConflictOnPort(port) {
  let runtime = null;
  try {
    runtime = await getActiveRuntimeState();
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
    status = await startupStatus();
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

async function restartStartupManagedWithLatest({
  runtimeState,
  fallbackStartArgs,
  error
}) {
  const startArgs = runtimeState?.managedByStartup
    ? buildStartArgsFromState(runtimeState)
    : fallbackStartArgs;
  try {
    const restarted = await installStartup({
      configPath: startArgs.configPath,
      host: startArgs.host,
      port: startArgs.port,
      watchConfig: startArgs.watchConfig,
      watchBinary: startArgs.watchBinary,
      requireAuth: startArgs.requireAuth
    });
    await clearRuntimeState();
    return {
      ok: true,
      detail: restarted
    };
  } catch (startupRestartError) {
    const message = startupRestartError instanceof Error ? startupRestartError.message : String(startupRestartError);
    error(`Failed restarting startup-managed service: ${message}`);
    return {
      ok: false,
      errorMessage: `Failed to restart startup-managed llm-router with latest installed version: ${message}`
    };
  }
}

async function attemptServerStartAfterStartupStop(buildLocalServerOptions, {
  attempts = 24,
  delayMs = 250
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const server = await startLocalRouteServer(buildLocalServerOptions());
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

export async function runStartCommand(options = {}) {
  const configPath = options.configPath || getDefaultConfigPath();
  const host = options.host || "127.0.0.1";
  const port = resolveListenPort({ explicitPort: options.port });
  const watchConfig = toBoolean(options.watchConfig, true);
  const watchBinary = toBoolean(options.watchBinary, true);
  const binaryWatchIntervalMs = Math.max(
    1000,
    toNumber(options.binaryWatchIntervalMs ?? process.env.LLM_ROUTER_BINARY_WATCH_INTERVAL_MS, 15000)
  );
  const requireAuth = toBoolean(options.requireAuth, false);
  const onStartupConflict = typeof options.onStartupConflict === "function" ? options.onStartupConflict : null;
  const managedByStartup = options.managedByStartup === true || process.env.LLM_ROUTER_MANAGED_BY_STARTUP === "1";
  const cliPathForWatch = String(options.cliPathForWatch || process.env.LLM_ROUTER_CLI_PATH || process.argv[1] || "");
  const line = typeof options.onLine === "function" ? options.onLine : console.log;
  const error = typeof options.onError === "function" ? options.onError : console.error;

  if (!(await configFileExists(configPath))) {
    return {
      ok: false,
      exitCode: 2,
      errorMessage: [
        `Config file not found: ${configPath}`,
        "Run 'llm-router config' to create provider config or 'llm-router -h' for help."
      ].join("\n")
    };
  }

  const config = await readConfigFile(configPath);
  if (!configHasProvider(config)) {
    return {
      ok: false,
      exitCode: 2,
      errorMessage: [
        `No providers configured in ${configPath}`,
        "Run 'llm-router config' to add a provider or 'llm-router -h' for help."
      ].join("\n")
    };
  }

  if (requireAuth && !config.masterKey) {
    return {
      ok: false,
      exitCode: 2,
      errorMessage: [
        `Local auth requires masterKey in ${configPath}.`,
        "Run 'llm-router config --operation=set-master-key --master-key=...' or start without --require-auth."
      ].join("\n")
    };
  }

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
      line(`Config hot-reloaded in memory (${reason}).`);
      if (!configHasProvider(nextConfig)) {
        error("Reloaded config has no enabled providers.");
      }
    },
    onConfigReloadError: (reloadError, reason) => {
      error(`Config reload ignored (${reason}): ${reloadError instanceof Error ? reloadError.message : String(reloadError)}`);
    }
  });

  let server;
  try {
    server = await startLocalRouteServer(buildLocalServerOptions());
  } catch (startError) {
    if (startError?.code !== "EADDRINUSE") {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: `Failed to start llm-router on http://${host}:${port}: ${startError instanceof Error ? startError.message : String(startError)}`
      };
    }

    if (!managedByStartup && onStartupConflict) {
      const conflict = await detectStartupManagedConflictOnPort(port);
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
          const restarted = await restartStartupManagedWithLatest({
            runtimeState: conflict.runtime,
            fallbackStartArgs: {
              configPath,
              host,
              port,
              watchConfig,
              watchBinary,
              requireAuth
            },
            error
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
              "Restarted startup-managed llm-router instance with latest installed version.",
              `manager=${restarted.detail?.manager || "unknown"}`,
              `service=${restarted.detail?.serviceId || "unknown"}`
            ].join("\n")
          };
        }

        if (choice === "exit") {
          return {
            ok: true,
            exitCode: 0,
            data: `Startup-managed llm-router is still running on port ${port}. Exiting without changes.`
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

          line("Startup-managed instance stopped. Starting llm-router in this terminal...");
          const takeoverStart = await attemptServerStartAfterStartupStop(buildLocalServerOptions);
          if (takeoverStart.ok) {
            server = takeoverStart.server;
            line(`Port ${port} reclaimed successfully.`);
          } else if (takeoverStart.error?.code !== "EADDRINUSE") {
            return {
              ok: false,
              exitCode: 1,
              errorMessage: `Failed to start llm-router on http://${host}:${port}: ${takeoverStart.error instanceof Error ? takeoverStart.error.message : String(takeoverStart.error)}`
            };
          }
        }
      }
    }

    if (server) {
      // Startup conflict handling already resolved the bind conflict.
    } else {
      const reclaimed = await reclaimPort({ port, line, error });
      if (!reclaimed.ok) {
        return {
          ok: false,
          exitCode: 1,
          errorMessage: reclaimed.errorMessage
        };
      }

      try {
        server = await startLocalRouteServer(buildLocalServerOptions());
        line(`Port ${port} reclaimed successfully.`);
      } catch (retryError) {
        return {
          ok: false,
          exitCode: 1,
          errorMessage: `Failed to start llm-router after reclaiming port ${port}: ${retryError instanceof Error ? retryError.message : String(retryError)}`
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
  let binaryRelaunching = false;
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
      await clearRuntimeState({ pid: process.pid });
      resolveDone();
    };

  if (watchBinary && binaryState) {
    binaryWatchTimer = setInterval(() => {
      if (shuttingDown || binaryRelaunching) return;
      const nextState = snapshotCliVersionState(binaryState.cliPath);
      const changed =
        nextState.realpath !== binaryState.realpath ||
        (nextState.version && binaryState.version && nextState.version !== binaryState.version);

      if (!changed) return;

      const from = binaryState.version || binaryState.realpath || "(unknown)";
      const to = nextState.version || nextState.realpath || "(unknown)";
      binaryState = nextState;

      if (managedByStartup) {
        line(`Detected llm-router update (${from} -> ${to}). Exiting for startup manager to relaunch latest version.`);
        void shutdown().then(() => {
          process.exit(0);
        });
        return;
      }

      const cliPath = nextState.cliPath || cliPathForWatch || process.argv[1];
      if (!cliPath) {
        if (!binaryNoticeSent) {
          binaryNoticeSent = true;
          line(`Detected llm-router update (${from} -> ${to}). Restart this process to run the new version.`);
        }
        return;
      }

      binaryRelaunching = true;
      void (async () => {
        try {
          line(`Detected llm-router update (${from} -> ${to}). Relaunching latest version...`);
          await shutdown();
          const launch = await spawnReplacementCli({
            cliPath,
            startArgs: buildStartArgs({ configPath, host, port, watchConfig, watchBinary, requireAuth })
          });
          if (!launch.ok) {
            error(`Failed to relaunch updated llm-router: ${launch.error instanceof Error ? launch.error.message : String(launch.error)}`);
            process.exit(1);
            return;
          }

          line(`Started updated llm-router process (pid ${launch.pid || "unknown"}).`);
          process.exit(0);
        } catch (relaunchError) {
          error(`Failed during llm-router auto-relaunch: ${relaunchError instanceof Error ? relaunchError.message : String(relaunchError)}`);
          process.exit(1);
        }
      })();
    }, binaryWatchIntervalMs);
  }

  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });

  await donePromise;

  return {
    ok: true,
    exitCode: 0,
    data: "Server stopped."
  };
}
