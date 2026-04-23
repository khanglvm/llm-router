import { getActiveRuntimeState } from "./instance-state.js";
import { reclaimPort } from "./port-reclaim.js";
import { startWebConsoleServer } from "./web-console-server.js";

const DEV_ROUTER_STOP_REASON = "Stopping the dev router because the dev web console exited.";

function normalizeHost(value) {
  return String(value || "127.0.0.1").trim() || "127.0.0.1";
}

function shouldRestartStaleDevRouter(runtimeBeforeStart, runtimeAfterStart, snapshot) {
  if (!runtimeBeforeStart || !runtimeAfterStart || !snapshot?.router?.running) return false;
  if (Number(runtimeBeforeStart.pid) !== Number(runtimeAfterStart.pid)) return false;
  if (snapshot?.config?.parseError) return false;
  if (!Number(snapshot?.config?.providerCount)) return false;

  const localServer = snapshot?.config?.localServer || {};
  return Number(runtimeAfterStart.port) === Number(localServer.port)
    && normalizeHost(runtimeAfterStart.host) === normalizeHost(localServer.host);
}

async function stopDevRouterAfterExit(server, onError) {
  if (!server || typeof server.stopRouter !== "function") return;

  try {
    await server.stopRouter({
      reason: DEV_ROUTER_STOP_REASON,
      reclaimPortIfStopped: true
    });
  } catch (error) {
    onError(`Failed stopping the dev router during shutdown: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function startManagedDevWebConsole(options = {}, deps = {}) {
  const line = typeof deps.line === "function" ? deps.line : console.log;
  const error = typeof deps.error === "function" ? deps.error : console.error;
  const startWebConsoleServerFn = typeof deps.startWebConsoleServer === "function"
    ? deps.startWebConsoleServer
    : startWebConsoleServer;
  const getActiveRuntimeStateFn = typeof deps.getActiveRuntimeState === "function"
    ? deps.getActiveRuntimeState
    : getActiveRuntimeState;
  const reclaimPortFn = typeof deps.reclaimPort === "function"
    ? deps.reclaimPort
    : (args) => reclaimPort(args, deps);
  const serverOptions = {
    ...options,
    devMode: true
  };
  const runtimeBeforeStart = await getActiveRuntimeStateFn().catch(() => null);

  let server;
  try {
    server = await startWebConsoleServerFn(serverOptions);
  } catch (startError) {
    if (startError?.code !== "EADDRINUSE") throw startError;

    const reclaimed = await reclaimPortFn({
      port: serverOptions.port,
      line,
      error
    });
    if (!reclaimed?.ok) {
      throw new Error(reclaimed?.errorMessage || `Failed to reclaim port ${serverOptions.port}.`);
    }

    line(`Port ${serverOptions.port} reclaimed successfully.`);
    server = await startWebConsoleServerFn(serverOptions);
  }

  const startupSnapshot = typeof server.getSnapshot === "function"
    ? await server.getSnapshot().catch(() => null)
    : null;
  const runtimeAfterStart = await getActiveRuntimeStateFn().catch(() => null);
  if (shouldRestartStaleDevRouter(runtimeBeforeStart, runtimeAfterStart, startupSnapshot)
    && typeof server.restartRouter === "function") {
    await server.restartRouter(startupSnapshot.config.localServer);
  }

  let stopRouterPromise = null;
  const ensureDevRouterStopped = () => {
    if (stopRouterPromise) return stopRouterPromise;
    stopRouterPromise = stopDevRouterAfterExit(server, error);
    return stopRouterPromise;
  };

  const done = (async () => {
    let result;
    try {
      result = await server.done;
    } finally {
      await ensureDevRouterStopped();
    }
    return result;
  })();

  let shutdownPromise = null;
  const shutdown = async (reason = "dev-console-closed") => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await ensureDevRouterStopped();
      await server.close(reason);
      return done;
    })();
    return shutdownPromise;
  };

  return {
    ...server,
    done,
    shutdown
  };
}
