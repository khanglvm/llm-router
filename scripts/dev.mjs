import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultConfigPath, getDefaultDevConfigPath } from "../src/node/config-store.js";
import { startManagedDevWebConsole } from "../src/node/dev-command.js";
import { RUNTIME_STATE_PATH_ENV } from "../src/node/instance-state.js";
import { resolveLargeRequestLogPath } from "../src/node/large-request-log.js";
import { openBrowser, resolveWebListenPort } from "../src/node/web-command.js";
import {
  DEFAULT_LARGE_REQUEST_LOG_THRESHOLD_BYTES,
  LARGE_REQUEST_LOG_ENABLED_ENV,
  LARGE_REQUEST_LOG_PATH_ENV,
  LARGE_REQUEST_LOG_THRESHOLD_ENV
} from "../src/runtime/handler/large-request-log.js";

const DEFAULT_DEV_WEB_PORT = 8789;
const DEFAULT_DEV_ROUTER_PORT = 8377;
const TERM_COLORS = process.stdout.isTTY
  ? {
    reset: "\u001b[0m",
    dim: "\u001b[2m",
    yellow: "\u001b[33m",
    amberBg: "\u001b[48;5;214m",
    black: "\u001b[30m"
  }
  : {
    reset: "",
    dim: "",
    yellow: "",
    amberBg: "",
    black: ""
  };

function formatDevBadge() {
  return `${TERM_COLORS.amberBg}${TERM_COLORS.black} DEV MODE ${TERM_COLORS.reset}`;
}

function formatMutedLabel(label) {
  return `${TERM_COLORS.dim}${label}${TERM_COLORS.reset}`;
}

function parseSimpleArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const separator = body.indexOf("=");
    if (separator >= 0) {
      args[body.slice(0, separator)] = body.slice(separator + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      args[body] = next;
      i += 1;
    } else {
      args[body] = true;
    }
  }
  return args;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function toPort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

function resolveDevRuntimeStatePath(configPath) {
  const absoluteConfigPath = path.resolve(String(configPath || getDefaultDevConfigPath()).trim() || getDefaultDevConfigPath());
  const configDir = path.dirname(absoluteConfigPath);
  const configStem = path.basename(absoluteConfigPath)
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return path.join(configDir, `.${configStem || "llm-router-dev"}.runtime.json`);
}

const args = parseSimpleArgs(process.argv.slice(2));
const configPath = String(args.config || args.configPath || getDefaultDevConfigPath()).trim() || getDefaultDevConfigPath();
const host = String(args.host || "127.0.0.1").trim() || "127.0.0.1";
const port = resolveWebListenPort({
  explicitPort: args.port,
  env: process.env,
  defaultPort: DEFAULT_DEV_WEB_PORT
});
const routerPort = toPort(args["router-port"] ?? args.routerPort, DEFAULT_DEV_ROUTER_PORT);
const shouldOpen = toBoolean(args.open, true);
if (!String(process.env[RUNTIME_STATE_PATH_ENV] || "").trim()) {
  process.env[RUNTIME_STATE_PATH_ENV] = resolveDevRuntimeStatePath(configPath);
}
const largeRequestLogPath = resolveLargeRequestLogPath(configPath, "", process.env);
if (!String(process.env[LARGE_REQUEST_LOG_ENABLED_ENV] || "").trim()) {
  process.env[LARGE_REQUEST_LOG_ENABLED_ENV] = "1";
}
if (!String(process.env[LARGE_REQUEST_LOG_THRESHOLD_ENV] || "").trim()) {
  process.env[LARGE_REQUEST_LOG_THRESHOLD_ENV] = String(DEFAULT_LARGE_REQUEST_LOG_THRESHOLD_BYTES);
}
if (!String(process.env[LARGE_REQUEST_LOG_PATH_ENV] || "").trim()) {
  process.env[LARGE_REQUEST_LOG_PATH_ENV] = largeRequestLogPath;
}
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliPathForRouter = path.resolve(scriptDir, "../src/cli-entry.js");

const server = await startManagedDevWebConsole({
  host,
  port,
  configPath,
  productionConfigPath: getDefaultConfigPath(),
  routerHost: String(args["router-host"] || args.routerHost || "127.0.0.1").trim() || "127.0.0.1",
  routerPort,
  routerWatchConfig: toBoolean(args["router-watch-config"] ?? args.routerWatchConfig, true),
  routerWatchBinary: toBoolean(args["router-watch-binary"] ?? args.routerWatchBinary, true),
  routerRequireAuth: toBoolean(args["router-require-auth"] ?? args.routerRequireAuth, false),
  allowRemoteClients: toBoolean(args["allow-remote-clients"] ?? args.allowRemoteClients, false),
  cliPathForRouter
});

console.log(`${formatDevBadge()} ${TERM_COLORS.yellow}LLM Router dev console started on ${server.url}${TERM_COLORS.reset}`);
console.log(`${formatMutedLabel("Dev config:")} ${configPath}`);
console.log(`${formatMutedLabel("Production config:")} ${getDefaultConfigPath()}`);
console.log(`${formatMutedLabel("Dev router target:")} http://${String(args["router-host"] || args.routerHost || "127.0.0.1").trim() || "127.0.0.1"}:${routerPort}`);
console.log(`${formatMutedLabel("Large request log:")} ${process.env[LARGE_REQUEST_LOG_PATH_ENV]} (threshold ${process.env[LARGE_REQUEST_LOG_THRESHOLD_ENV]} bytes)`);
console.log(`${formatMutedLabel("Watch mode:")} web UI assets + router source files`);
console.log(`${formatMutedLabel("Lifecycle:")} stale dev web/router listeners are reclaimed automatically on the next run`);

if (shouldOpen) {
  try {
    openBrowser(server.url);
    console.log("Opening your default browser...");
  } catch (error) {
    console.error(`Could not open browser automatically: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`Open this URL manually: ${server.url}`);
  }
}

const handleSignal = (signal) => {
  console.log(`Received ${signal}. Closing dev web console and attempting dev router cleanup...`);
  void server.shutdown(signal.toLowerCase());
};
process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);

await server.done;
process.removeListener("SIGINT", handleSignal);
process.removeListener("SIGTERM", handleSignal);
