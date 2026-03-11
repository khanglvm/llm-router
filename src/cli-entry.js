#!/usr/bin/env node

import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { getDefaultConfigPath } from "./node/config-store.js";
import { FIXED_LOCAL_ROUTER_HOST, FIXED_LOCAL_ROUTER_PORT } from "./node/local-server-settings.js";
import { resolveListenPort } from "./node/listen-port.js";
import { runStartCommand } from "./node/start-command.js";
import { runWebCommand } from "./node/web-command.js";

function parseSimpleArgs(argv) {
  const positional = [];
  const args = {};
  let wantsHelp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "-h" || token === "--help" || token === "help") {
      wantsHelp = true;
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const separator = body.indexOf("=");
      if (separator >= 0) {
        args[body.slice(0, separator)] = body.slice(separator + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          args[body] = next;
          i += 1;
        } else {
          args[body] = true;
        }
      }
      continue;
    }

    positional.push(token);
  }

  return { positional, args, wantsHelp };
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function isBooleanLikeToken(value) {
  if (value === undefined || value === null) return false;
  return /^(?:1|0|true|false|yes|no|y|n|on|off)$/i.test(String(value).trim());
}

function readRawFlagValue(argv, flagName) {
  const prefix = `--${flagName}`;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === prefix) {
      const next = argv[index + 1];
      if (isBooleanLikeToken(next)) {
        return next;
      }
      return true;
    }
    if (token.startsWith(`${prefix}=`)) {
      return token.slice(prefix.length + 1);
    }
  }

  return undefined;
}

function stripFlagFromArgv(argv, flagName) {
  const prefix = `--${flagName}`;
  const nextArgv = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === prefix) {
      const next = argv[index + 1];
      if (isBooleanLikeToken(next)) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith(`${prefix}=`)) {
      continue;
    }
    nextArgv.push(token);
  }

  return nextArgv;
}

function hasExplicitConfigOperation(args = {}) {
  return Boolean(String(args.operation || args.op || "").trim());
}

function buildWebCommandOptions(args = {}) {
  return {
    configPath: args.config || args.configPath || getDefaultConfigPath(),
    host: args.host || "127.0.0.1",
    port: args.port,
    open: parseBoolean(args.open, true),
    routerHost: FIXED_LOCAL_ROUTER_HOST,
    routerPort: FIXED_LOCAL_ROUTER_PORT,
    routerWatchConfig: parseBoolean(args["router-watch-config"] ?? args.routerWatchConfig, true),
    routerWatchBinary: parseBoolean(args["router-watch-binary"] ?? args.routerWatchBinary, true),
    routerRequireAuth: parseBoolean(args["router-require-auth"] ?? args.routerRequireAuth, false),
    allowRemoteClients: parseBoolean(args["allow-remote-clients"] ?? args.allowRemoteClients, false),
    cliPathForRouter: String(process.env.LLM_ROUTER_CLI_PATH || process.argv[1] || "").trim()
  };
}

async function runWebFastPath(args, runWebCommandImpl = runWebCommand) {
  const result = await runWebCommandImpl(buildWebCommandOptions(args));

  if (!result.ok && result.errorMessage) {
    console.error(result.errorMessage);
  }

  return result.exitCode ?? (result.ok ? 0 : 1);
}

async function promptStartupConflictResolution({ port }) {
  if (!(process.stdout.isTTY && process.stdin.isTTY)) return "";

  const ui = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const lines = [
    "",
    `Port ${port} is already used by the llm-router startup service.`,
    "Choose an action:",
    "1. Restart service",
    "2. Run here instead",
    "3. Cancel"
  ];
  console.log(lines.join("\n"));

  try {
    while (true) {
      const input = String(await ui.question("Select [1/2/3]: ")).trim();
      if (input === "1") return "restart-startup";
      if (input === "2") return "stop-and-start-here";
      if (input === "3") return "exit";
      console.log("Invalid choice. Enter 1, 2, or 3.");
    }
  } finally {
    ui.close();
  }
}

async function runStartFastPath(args) {
  const result = await runStartCommand({
    configPath: args.config || args.configPath || getDefaultConfigPath(),
    host: FIXED_LOCAL_ROUTER_HOST,
    port: resolveListenPort({ explicitPort: args.port }),
    watchConfig: parseBoolean(args["watch-config"] ?? args.watchConfig, true),
    watchBinary: parseBoolean(args["watch-binary"] ?? args.watchBinary, true),
    requireAuth: parseBoolean(args["require-auth"] ?? args.requireAuth, false),
    onStartupConflict: (payload) => promptStartupConflictResolution(payload),
    cliPathForWatch: process.argv[1],
    onLine: (line) => console.log(line),
    onError: (line) => console.error(line)
  });

  if (!result.ok && result.errorMessage) {
    console.error(result.errorMessage);
  }

  return result.exitCode ?? (result.ok ? 0 : 1);
}

export function shouldExitTuiOnKeypress(character, key = {}) {
  const sequence = typeof key?.sequence === "string" && key.sequence
    ? key.sequence
    : (typeof character === "string" ? character : "");
  return sequence === "" || (key?.ctrl === true && String(key?.name || "").toLowerCase() === "c");
}

export function installTuiSigintExitHandler({
  input = process.stdin,
  isTTY = Boolean(process.stdout.isTTY && process.stdin?.isTTY),
  exit = (code) => process.exit(code)
} = {}) {
  if (!isTTY || !input || typeof input.on !== "function" || typeof input.off !== "function") {
    return () => {};
  }

  const onKeypress = (character, key) => {
    if (shouldExitTuiOnKeypress(character, key)) {
      exit(130);
    }
  };

  input.on("keypress", onKeypress);
  return () => {
    input.off("keypress", onKeypress);
  };
}

async function runSnapCli(argv, isTTY) {
  const [{ createRegistry, runSingleModuleCli }, { default: routerModule }] = await Promise.all([
    import("@levu/snap/dist/index.js"),
    import("./cli/router-module.js")
  ]);

  const registry = createRegistry([routerModule]);
  const disposeSigintHandler = installTuiSigintExitHandler({ isTTY });
  try {
    return await runSingleModuleCli({
      registry,
      argv,
      moduleId: "router",
      defaultActionId: "config",
      helpDefaultTarget: "module",
      isTTY
    });
  } finally {
    disposeSigintHandler();
  }
}

export async function runCli(argv = process.argv.slice(2), isTTY = undefined, overrides = {}) {
  const runSnapCliImpl = overrides.runSnapCli || runSnapCli;
  const runStartFastPathImpl = overrides.runStartFastPath || runStartFastPath;
  const runWebCommandImpl = overrides.runWebCommand || runWebCommand;
  const tuiRequested = parseBoolean(readRawFlagValue(argv, "tui"), false);
  const normalizedArgv = stripFlagFromArgv(argv, "tui");
  const parsed = parseSimpleArgs(normalizedArgv);
  const first = parsed.positional[0];
  const firstIsStart = first === "start";
  const firstIsWeb = first === "web";
  const firstIsConfig = first === "config";
  const explicitConfigOperation = hasExplicitConfigOperation(parsed.args);

  // Bare invocation opens the browser-based console by default.
  if (!first && !parsed.wantsHelp) {
    if (tuiRequested || explicitConfigOperation) {
      return runSnapCliImpl(["config", ...normalizedArgv], isTTY);
    }
    return runWebFastPath(parsed.args, runWebCommandImpl);
  }

  // Fast-path explicit local start without loading Snap to minimize startup overhead.
  if (firstIsStart && !parsed.wantsHelp) {
    const startArgs = normalizedArgv.slice(1);
    const parsedStart = parseSimpleArgs(startArgs);
    return runStartFastPathImpl(parsedStart.args);
  }

  if (firstIsWeb && !parsed.wantsHelp) {
    const webArgs = normalizedArgv.slice(1);
    const parsedWeb = parseSimpleArgs(webArgs);
    return runWebFastPath(parsedWeb.args, runWebCommandImpl);
  }

  if (firstIsConfig && !parsed.wantsHelp && !explicitConfigOperation) {
    if (tuiRequested) {
      return runSnapCliImpl(normalizedArgv, isTTY);
    }

    const configArgs = parseSimpleArgs(normalizedArgv.slice(1));
    return runWebFastPath(configArgs.args, runWebCommandImpl);
  }

  const normalized = [...normalizedArgv];
  if (normalized[0] === "help") normalized[0] = "--help";
  if (normalized[0] === "setup") normalized[0] = "config";
  return runSnapCliImpl(normalized, isTTY);
}

function resolveExecutablePath(filePath) {
  if (!filePath) return "";
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

const isMain = (() => {
  const modulePath = resolveExecutablePath(fileURLToPath(import.meta.url));
  const argvPath = resolveExecutablePath(process.argv[1]);
  return Boolean(argvPath) && modulePath === argvPath;
})();

if (isMain) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
