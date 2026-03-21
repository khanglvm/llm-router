import { spawn } from "node:child_process";
import { getDefaultConfigPath } from "./config-store.js";
import { FIXED_LOCAL_ROUTER_HOST, FIXED_LOCAL_ROUTER_PORT } from "./local-server-settings.js";
import { reclaimPort } from "./port-reclaim.js";
import { startWebConsoleServer } from "./web-console-server.js";

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
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return fallback;
  return parsed;
}

export function resolveWebListenPort({ explicitPort, env = process.env, defaultPort = 8788 } = {}) {
  return toPort(explicitPort, toPort(env.LLM_ROUTER_WEB_PORT, toPort(env.PORT, defaultPort)));
}

export function openBrowser(url) {
  const platform = process.platform;
  if (platform === "darwin") {
    const child = spawn("open", [url], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }

  if (platform === "win32") {
    const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }

  const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function runWebCommand(options = {}) {
  const host = String(options.host || "127.0.0.1").trim() || "127.0.0.1";
  const port = resolveWebListenPort({ explicitPort: options.port, env: options.env });
  const configPath = String(options.configPath || options.config || getDefaultConfigPath()).trim() || getDefaultConfigPath();
  const shouldOpen = toBoolean(options.open ?? options.openBrowser, true);
  const line = typeof options.onLine === "function" ? options.onLine : console.log;
  const error = typeof options.onError === "function" ? options.onError : console.error;

  const onPortConflict = typeof options.onPortConflict === "function" ? options.onPortConflict : null;
  const reclaimPortFn = typeof options.reclaimPort === "function" ? options.reclaimPort : (args) => reclaimPort(args, options);

  const buildServerOptions = () => ({
    host,
    port,
    configPath,
    routerHost: FIXED_LOCAL_ROUTER_HOST,
    routerPort: FIXED_LOCAL_ROUTER_PORT,
    routerWatchConfig: toBoolean(options.routerWatchConfig ?? options["router-watch-config"], true),
    routerWatchBinary: toBoolean(options.routerWatchBinary ?? options["router-watch-binary"], true),
    routerRequireAuth: toBoolean(options.routerRequireAuth ?? options["router-require-auth"], false),
    allowRemoteClients: toBoolean(options.allowRemoteClients ?? options["allow-remote-clients"], false),
    cliPathForRouter: String(options.cliPathForRouter || process.env.LLM_ROUTER_CLI_PATH || process.argv[1] || "").trim()
  });

  let server;
  try {
    server = await startWebConsoleServer(buildServerOptions());
  } catch (startError) {
    if (startError?.code !== "EADDRINUSE") {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: `Failed to start the LLM Router web console: ${startError instanceof Error ? startError.message : String(startError)}`
      };
    }

    if (!onPortConflict) {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: `Port ${port} is already in use. Stop the existing listener or use a different port (--port=<number> or LLM_ROUTER_WEB_PORT env).`
      };
    }

    let userChoice;
    try {
      userChoice = await onPortConflict({ port, host });
    } catch {
      userChoice = false;
    }

    if (!userChoice) {
      return {
        ok: true,
        exitCode: 0,
        data: `Port ${port} is in use. Web console launch cancelled.`
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
      server = await startWebConsoleServer(buildServerOptions());
      line(`Port ${port} reclaimed successfully.`);
    } catch (retryError) {
      return {
        ok: false,
        exitCode: 1,
        errorMessage: `Failed to start the LLM Router web console after reclaiming port ${port}: ${retryError instanceof Error ? retryError.message : String(retryError)}`
      };
    }
  }

  line(`LLM Router web console started on ${server.url}`);
  line(`Config file: ${configPath}`);
  line("Use the in-app Exit Web button or Ctrl+C to stop the web console.");
  line("Closing the web console leaves the router service running.");

  if (shouldOpen) {
    try {
      openBrowser(server.url);
      line("Opening your default browser...");
    } catch (openError) {
      error(`Could not open browser automatically: ${openError instanceof Error ? openError.message : String(openError)}`);
      line(`Open this URL manually: ${server.url}`);
    }
  }

  const handleSignal = (signal) => {
    line(`Received ${signal}. Closing web console (router stays running)...`);
    void server.close(signal.toLowerCase());
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  await server.done;

  process.removeListener("SIGINT", handleSignal);
  process.removeListener("SIGTERM", handleSignal);

  return {
    ok: true,
    exitCode: 0,
    data: "Web console stopped. Router service keeps running."
  };
}
