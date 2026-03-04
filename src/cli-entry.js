#!/usr/bin/env node

import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { getDefaultConfigPath } from "./node/config-store.js";
import { resolveListenPort } from "./node/listen-port.js";
import { runStartCommand } from "./node/start-command.js";

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
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

async function promptStartupConflictResolution({ port }) {
  if (!(process.stdout.isTTY && process.stdin.isTTY)) return "";

  const ui = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const lines = [
    "",
    `A startup-managed llm-router instance is already running on port ${port}.`,
    "Choose how to continue:",
    "1. Restart startup-managed llm-router instance (use latest installed version)",
    "2. Stop running instance and start it here",
    "3. Exit"
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
    host: args.host || "127.0.0.1",
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

async function runSnapCli(argv, isTTY) {
  const [{ createRegistry, runSingleModuleCli }, { default: routerModule }] = await Promise.all([
    import("@levu/snap/dist/index.js"),
    import("./cli/router-module.js")
  ]);

  const registry = createRegistry([routerModule]);
  return runSingleModuleCli({
    registry,
    argv,
    moduleId: "router",
    defaultActionId: "config",
    helpDefaultTarget: "module",
    isTTY
  });
}

export async function runCli(argv = process.argv.slice(2), isTTY = undefined) {
  const parsed = parseSimpleArgs(argv);
  const first = parsed.positional[0];
  const firstIsStart = first === "start";

  // Bare invocation opens the interactive config manager.
  if (!first && !parsed.wantsHelp) {
    return runSnapCli(["config"], isTTY);
  }

  // Fast-path explicit local start without loading Snap to minimize startup overhead.
  if (firstIsStart && !parsed.wantsHelp) {
    const startArgs = argv.slice(1);
    const parsedStart = parseSimpleArgs(startArgs);
    return runStartFastPath(parsedStart.args);
  }

  const normalized = [...argv];
  if (normalized[0] === "help") normalized[0] = "--help";
  if (normalized[0] === "setup") normalized[0] = "config";
  return runSnapCli(normalized, isTTY);
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
