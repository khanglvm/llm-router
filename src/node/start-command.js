import path from "node:path";
import { watch as fsWatch, existsSync, readFileSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { configFileExists, getDefaultConfigPath, readConfigFile } from "./config-store.js";
import { clearRuntimeState, writeRuntimeState } from "./instance-state.js";
import { startLocalRouteServer } from "./local-server.js";
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

function parsePidList(text) {
  const matches = String(text || "").match(/\d+/g) || [];
  return [...new Set(matches
    .map((token) => Number(token))
    .filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function listListeningPidsWithLsof(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
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

function listListeningPidsWithFuser(port) {
  const result = spawnSync("fuser", ["-n", "tcp", String(port)], {
    encoding: "utf8"
  });
  if (result.error) {
    return { ok: false, pids: [], tool: "fuser", error: result.error };
  }

  return {
    ok: true,
    pids: parsePidList(`${result.stdout || ""}\n${result.stderr || ""}`),
    tool: "fuser"
  };
}

function listListeningPids(port) {
  const lsof = listListeningPidsWithLsof(port);
  if (lsof.ok) return lsof;

  const fuser = listListeningPidsWithFuser(port);
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

async function waitForPortToRelease(port, timeoutMs = 4000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const probe = listListeningPids(port);
    if (!probe.ok || probe.pids.length === 0) {
      return true;
    }
    await sleep(150);
  }

  const finalProbe = listListeningPids(port);
  return !finalProbe.ok || finalProbe.pids.length === 0;
}

async function reclaimPort({ port, line, error }) {
  const probe = listListeningPids(port);
  if (!probe.ok) {
    return {
      ok: false,
      errorMessage: `Port ${port} is in use but process lookup failed (${probe.error instanceof Error ? probe.error.message : String(probe.error || "unknown error")}).`
    };
  }

  const targets = probe.pids.filter((pid) => pid !== process.pid);
  if (targets.length === 0) {
    return {
      ok: false,
      errorMessage: `Port ${port} is in use but no external listener PID was detected.`
    };
  }

  line(`Port ${port} is already in use. Stopping existing listener(s): ${targets.join(", ")}.`);

  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (killError) {
      error(`Failed sending SIGTERM to pid ${pid}: ${killError instanceof Error ? killError.message : String(killError)}`);
    }
  }

  let released = await waitForPortToRelease(port, 3000);
  if (!released) {
    const remaining = listListeningPids(port);
    const remainingTargets = (remaining.pids || []).filter((pid) => pid !== process.pid);

    if (remainingTargets.length > 0) {
      line(`Port ${port} still busy. Force killing listener(s): ${remainingTargets.join(", ")}.`);
      for (const pid of remainingTargets) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (killError) {
          error(`Failed sending SIGKILL to pid ${pid}: ${killError instanceof Error ? killError.message : String(killError)}`);
        }
      }
      released = await waitForPortToRelease(port, 2000);
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

export async function runStartCommand(options = {}) {
  const configPath = options.configPath || getDefaultConfigPath();
  const host = options.host || "127.0.0.1";
  const port = toNumber(options.port, 8787);
  const watchConfig = toBoolean(options.watchConfig, true);
  const watchBinary = toBoolean(options.watchBinary, true);
  const binaryWatchIntervalMs = Math.max(
    1000,
    toNumber(options.binaryWatchIntervalMs ?? process.env.LLM_ROUTER_BINARY_WATCH_INTERVAL_MS, 15000)
  );
  const requireAuth = toBoolean(options.requireAuth, false);
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

  let server;
  try {
    server = await startLocalRouteServer({ port, host, configPath, requireAuth });
  } catch (startError) {
    if (startError?.code !== "EADDRINUSE") {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: `Failed to start llm-router on http://${host}:${port}: ${startError instanceof Error ? startError.message : String(startError)}`
      };
    }

    const reclaimed = await reclaimPort({ port, line, error });
    if (!reclaimed.ok) {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: reclaimed.errorMessage
      };
    }

    try {
      server = await startLocalRouteServer({ port, host, configPath, requireAuth });
      line(`Port ${port} reclaimed successfully.`);
    } catch (retryError) {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: `Failed to start llm-router after reclaiming port ${port}: ${retryError instanceof Error ? retryError.message : String(retryError)}`
      };
    }
  }
  line(`LLM Router started on http://${host}:${port}`);
  line(`Anthropic base URL: http://${host}:${port}/anthropic`);
  line(`OpenAI base URL: http://${host}:${port}/openai`);
  for (const row of summarizeConfig(config, configPath)) {
    line(row);
  }
  line(`Local auth: ${requireAuth ? "required (masterKey)" : "disabled"}`);
  line(`Config watch auto-restart: ${watchConfig ? "enabled" : "disabled"}`);
  line(`Binary update watch: ${watchBinary ? "enabled" : "disabled"}${managedByStartup ? " (startup-managed auto-restart)" : ""}`);
  line("Press Ctrl+C to stop.");

  let shuttingDown = false;
  let restarting = false;
  let debounceTimer = null;
  let watcher = null;
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

  const restartServer = async (reason) => {
    if (restarting || shuttingDown) return;
    restarting = true;
    try {
      const latestConfig = await readConfigFile(configPath);
      if (!configHasProvider(latestConfig)) {
        error(`Config changed (${reason}) but has no providers. Keeping current server.`);
        return;
      }
      if (requireAuth && !latestConfig.masterKey) {
        error(`Config changed (${reason}) but masterKey is missing while local auth is required. Keeping current server.`);
        return;
      }

      await closeServer();
      server = await startLocalRouteServer({ port, host, configPath, requireAuth });
      line(`Restarted llm-router after config change (${reason})`);
    } catch (restartError) {
      error(`Failed to restart after config change: ${restartError instanceof Error ? restartError.message : String(restartError)}`);
    } finally {
      restarting = false;
    }
  };

  if (watchConfig) {
    const configDir = path.dirname(configPath);
    const configFile = path.basename(configPath);
    try {
      watcher = fsWatch(configDir, (eventType, filename) => {
        if (shuttingDown) return;
        if (!filename) return;
        if (String(filename) !== configFile) return;

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void restartServer(eventType || "change");
        }, 300);
      });
    } catch (watchError) {
      error(`Config watch disabled: ${watchError instanceof Error ? watchError.message : String(watchError)}`);
    }
  }

  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        if (debounceTimer) clearTimeout(debounceTimer);
        watcher?.close?.();
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
      if (shuttingDown || restarting || binaryRelaunching) return;
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
