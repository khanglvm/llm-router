import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  clearRuntimeState,
  getRuntimeStatePath,
  isProcessRunning,
  readRuntimeState,
  stopProcessByPid
} from "./instance-state.js";
import { FIXED_LOCAL_ROUTER_HOST, FIXED_LOCAL_ROUTER_PORT } from "./local-server-settings.js";

const BACKEND_STATE_SUFFIX = "backend";
const DEFAULT_BACKEND_READY_TIMEOUT_MS = 12000;
const DEFAULT_BACKEND_HEALTH_POLL_MS = 2000;
const DEFAULT_PROXY_RETRY_TIMEOUT_MS = 20000;
const DEFAULT_PROXY_RETRY_INTERVAL_MS = 125;
const RETRYABLE_PROXY_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET"
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatHostForUrl(host, port) {
  const value = String(host || "127.0.0.1").trim() || "127.0.0.1";
  if (!value.includes(":")) return `${value}:${port}`;
  if (value.startsWith("[") && value.endsWith("]")) return `${value}:${port}`;
  return `[${value}]:${port}`;
}

function normalizeRequestPath(rawUrl) {
  const value = String(rawUrl || "/").trim() || "/";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      const parsed = new URL(value);
      return `${parsed.pathname}${parsed.search}` || "/";
    } catch {
      return "/";
    }
  }
  if (value.startsWith("/")) return value;
  return `/${value}`;
}

function buildRequestUrl(req, fallbackHost) {
  const requestPath = normalizeRequestPath(req.url);
  return `http://${fallbackHost}${requestPath}`;
}

function hasRequestBody(method) {
  const upper = String(method || "GET").toUpperCase();
  return upper !== "GET" && upper !== "HEAD";
}

async function readRequestBodyBuffer(req) {
  if (!hasRequestBody(req.method)) return null;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function buildFetchRequest(req, backendOrigin, bodyBuffer) {
  const method = String(req.method || "GET").toUpperCase();
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }

  const socketIp = typeof req.socket?.remoteAddress === "string"
    ? req.socket.remoteAddress
    : "";
  if (socketIp) {
    headers.set("x-real-ip", socketIp);
  }

  const requestUrl = `${backendOrigin}${normalizeRequestPath(req.url)}`;
  if (!hasRequestBody(method)) {
    return {
      url: requestUrl,
      init: { method, headers }
    };
  }

  return {
    url: requestUrl,
    init: {
      method,
      headers,
      body: bodyBuffer ?? Buffer.alloc(0),
      duplex: "half"
    }
  };
}

async function writeFetchResponseToNode(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const readable = Readable.fromWeb(response.body);
  readable.on("error", (error) => {
    res.destroy(error);
  });
  readable.pipe(res);
}

function deriveAuxiliaryStatePath(basePath, suffix) {
  const parsed = path.parse(basePath);
  const ext = parsed.ext || ".json";
  return path.join(parsed.dir, `${parsed.name}.${suffix}${ext}`);
}

export function getBackendRuntimeStatePath({ env = process.env } = {}) {
  return deriveAuxiliaryStatePath(getRuntimeStatePath({ env }), BACKEND_STATE_SUFFIX);
}

async function readActiveRuntimeStateFromPath(filePath, deps = {}) {
  const readRuntimeStateFn = typeof deps.readRuntimeState === "function" ? deps.readRuntimeState : readRuntimeState;
  const clearRuntimeStateFn = typeof deps.clearRuntimeState === "function" ? deps.clearRuntimeState : clearRuntimeState;

  let runtime = null;
  try {
    runtime = await readRuntimeStateFn(filePath);
  } catch {
    runtime = null;
  }

  if (!runtime) return null;
  if (isProcessRunning(runtime.pid)) return runtime;

  try {
    await clearRuntimeStateFn({ pid: runtime.pid }, filePath);
  } catch {
    // ignore cleanup failure for stale state
  }
  return null;
}

async function allocateLoopbackPort(host = FIXED_LOCAL_ROUTER_HOST) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? Number(address.port) : 0;
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

function appendRecentOutput(current, chunk, maxChars = 4000) {
  if (!chunk) return current;
  const combined = `${current}${chunk}`;
  return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}

function formatStartFailureMessage(baseMessage, { stderr = "", stdout = "" } = {}) {
  const detail = String(stderr || "").trim() || String(stdout || "").trim();
  return detail ? `${baseMessage}\n${detail}` : baseMessage;
}

function createBackendStartArgs({
  configPath,
  host = FIXED_LOCAL_ROUTER_HOST,
  port,
  watchConfig = true,
  watchBinary = true,
  requireAuth = false
}) {
  return [
    "start-runtime",
    `--config=${configPath}`,
    `--host=${host}`,
    `--port=${port}`,
    `--watch-config=${watchConfig ? "true" : "false"}`,
    `--watch-binary=${watchBinary ? "true" : "false"}`,
    `--require-auth=${requireAuth ? "true" : "false"}`
  ];
}

function shouldRetryProxyError(fetchError) {
  const code = String(fetchError?.code || fetchError?.cause?.code || "").trim();
  if (RETRYABLE_PROXY_ERROR_CODES.has(code)) return true;
  const message = String(fetchError?.message || fetchError || "").toLowerCase();
  return message.includes("econnrefused")
    || message.includes("other side closed")
    || message.includes("socket")
    || message.includes("fetch failed")
    || message.includes("connect timeout");
}

function sendProxyUnavailable(res, message) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = 503;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(`${JSON.stringify({
    error: "Router backend unavailable",
    message
  })}\n`);
}

export async function startRouterSupervisor(options = {}, deps = {}) {
  const host = String(options.host || FIXED_LOCAL_ROUTER_HOST).trim() || FIXED_LOCAL_ROUTER_HOST;
  const port = Number.isInteger(Number(options.port)) ? Number(options.port) : FIXED_LOCAL_ROUTER_PORT;
  const configPath = String(options.configPath || "").trim();
  const watchConfig = options.watchConfig !== false;
  const watchBinary = options.watchBinary !== false;
  const requireAuth = options.requireAuth === true;
  const cliPath = String(options.cliPath || process.env.LLM_ROUTER_CLI_PATH || process.argv[1] || "").trim();
  const line = typeof options.onLine === "function" ? options.onLine : console.log;
  const error = typeof options.onError === "function" ? options.onError : console.error;
  const backendStatePath = String(options.backendStatePath || getBackendRuntimeStatePath({ env: deps.env || process.env })).trim();
  const backendHost = String(options.backendHost || FIXED_LOCAL_ROUTER_HOST).trim() || FIXED_LOCAL_ROUTER_HOST;
  const backendPort = Number.isInteger(Number(options.backendPort))
    ? Number(options.backendPort)
    : await allocateLoopbackPort(backendHost);
  const backendReadyTimeoutMs = Number.isFinite(Number(options.backendReadyTimeoutMs))
    ? Math.max(1000, Number(options.backendReadyTimeoutMs))
    : DEFAULT_BACKEND_READY_TIMEOUT_MS;
  const backendHealthPollMs = Number.isFinite(Number(options.backendHealthPollMs))
    ? Math.max(250, Number(options.backendHealthPollMs))
    : DEFAULT_BACKEND_HEALTH_POLL_MS;
  const proxyRetryTimeoutMs = Number.isFinite(Number(options.proxyRetryTimeoutMs))
    ? Math.max(1000, Number(options.proxyRetryTimeoutMs))
    : DEFAULT_PROXY_RETRY_TIMEOUT_MS;
  const proxyRetryIntervalMs = Number.isFinite(Number(options.proxyRetryIntervalMs))
    ? Math.max(25, Number(options.proxyRetryIntervalMs))
    : DEFAULT_PROXY_RETRY_INTERVAL_MS;

  const spawnFn = typeof deps.spawn === "function" ? deps.spawn : spawn;
  const stopProcessByPidFn = typeof deps.stopProcessByPid === "function" ? deps.stopProcessByPid : stopProcessByPid;
  const clearRuntimeStateFn = typeof deps.clearRuntimeState === "function" ? deps.clearRuntimeState : clearRuntimeState;
  const signalProcess = typeof deps.signalProcess === "function" ? deps.signalProcess : process.kill;

  let shuttingDown = false;
  let ensuringBackend = null;
  let backendChild = null;
  let healthTimer = null;
  const socketRequestCounts = new Map();

  async function stopBackendIfRunning() {
    const runtime = await readActiveRuntimeStateFromPath(backendStatePath, deps);
    if (!runtime) return { ok: true, alreadyStopped: true };

    const stopped = await stopProcessByPidFn(runtime.pid);
    if (stopped?.ok) {
      await clearRuntimeStateFn({ pid: runtime.pid }, backendStatePath).catch(() => {});
      return stopped;
    }
    return stopped || { ok: false, reason: `Failed stopping backend pid ${runtime.pid}.` };
  }

  async function spawnBackend(reason = "startup") {
    const activeRuntime = await readActiveRuntimeStateFromPath(backendStatePath, deps);
    if (activeRuntime
      && Number(activeRuntime.port) === Number(backendPort)
      && String(activeRuntime.configPath || "").trim() === configPath
      && Boolean(activeRuntime.watchConfig !== false) === Boolean(watchConfig)
      && Boolean(activeRuntime.watchBinary !== false) === Boolean(watchBinary)
      && Boolean(activeRuntime.requireAuth === true) === Boolean(requireAuth)) {
      return activeRuntime;
    }

    if (activeRuntime) {
      const stopped = await stopBackendIfRunning();
      if (!stopped?.ok) {
        throw new Error(stopped?.reason || `Failed stopping stale backend pid ${activeRuntime.pid}.`);
      }
    } else {
      await clearRuntimeStateFn({}, backendStatePath).catch(() => {});
    }

    const args = createBackendStartArgs({
      configPath,
      host: backendHost,
      port: backendPort,
      watchConfig,
      watchBinary,
      requireAuth
    });

    let child;
    try {
      child = spawnFn(process.execPath, [cliPath, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...(deps.env || process.env),
          LLM_ROUTER_CLI_PATH: cliPath,
          LLM_ROUTER_RUNTIME_STATE_PATH: backendStatePath
        }
      });
    } catch (spawnError) {
      throw new Error(spawnError instanceof Error ? spawnError.message : String(spawnError));
    }

    backendChild = child;
    let childError = null;
    let childExit = null;
    let stdout = "";
    let stderr = "";
    const onStdout = (chunk) => {
      stdout = appendRecentOutput(stdout, chunk);
    };
    const onStderr = (chunk) => {
      stderr = appendRecentOutput(stderr, chunk);
    };
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", onStdout);
    child.stderr?.on?.("data", onStderr);
    child.once("error", (spawnError) => {
      childError = spawnError;
    });
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
      if (shuttingDown) return;
      setTimeout(() => {
        if (shuttingDown) return;
        void ensureBackendRunning(`backend-exit:${reason}`).catch((restartError) => {
          error(`Failed restoring router backend after exit: ${restartError instanceof Error ? restartError.message : String(restartError)}`);
        });
      }, 250);
    });

    const cleanupPipes = () => {
      child.stdout?.off?.("data", onStdout);
      child.stderr?.off?.("data", onStderr);
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
    };

    const startedAt = Date.now();
    while (Date.now() - startedAt < backendReadyTimeoutMs) {
      const runtime = await readActiveRuntimeStateFromPath(backendStatePath, deps);
      if (runtime
        && Number(runtime.port) === Number(backendPort)
        && String(runtime.configPath || "").trim() === configPath) {
        cleanupPipes();
        return runtime;
      }

      if (childError) {
        cleanupPipes();
        throw new Error(formatStartFailureMessage(
          childError instanceof Error ? childError.message : String(childError),
          { stderr, stdout }
        ));
      }

      if (childExit) {
        cleanupPipes();
        throw new Error(formatStartFailureMessage(
          `Router backend exited before becoming ready (${childExit.signal || childExit.code || "unknown"}).`,
          { stderr, stdout }
        ));
      }

      await sleep(125);
    }

    cleanupPipes();
    throw new Error(formatStartFailureMessage(
      `Timed out waiting for router backend to start on http://${formatHostForUrl(backendHost, backendPort)}.`,
      { stderr, stdout }
    ));
  }

  async function ensureBackendRunning(reason = "runtime-check") {
    if (shuttingDown) {
      throw new Error("Router supervisor is shutting down.");
    }
    if (ensuringBackend) return ensuringBackend;

    ensuringBackend = Promise.resolve()
      .then(async () => {
        const active = await readActiveRuntimeStateFromPath(backendStatePath, deps);
        if (active
          && Number(active.port) === Number(backendPort)
          && String(active.configPath || "").trim() === configPath) {
          return active;
        }
        line(`Starting router backend (${reason}) on http://${formatHostForUrl(backendHost, backendPort)}...`);
        return spawnBackend(reason);
      })
      .finally(() => {
        ensuringBackend = null;
      });

    return ensuringBackend;
  }

  async function requestBackendUpgrade(signal = "SIGUSR2") {
    const runtime = await ensureBackendRunning("upgrade-request");
    try {
      signalProcess(runtime.pid, signal);
      return { ok: true, pid: runtime.pid, signal };
    } catch (signalError) {
      return {
        ok: false,
        reason: signalError instanceof Error ? signalError.message : String(signalError)
      };
    }
  }

  function closeSocketIfIdle(socket) {
    if (!socket || socket.destroyed) return;
    if (Number(socketRequestCounts.get(socket) || 0) > 0) return;
    socket.end();
  }

  const server = http.createServer(async (req, res) => {
    const socket = req.socket;
    socketRequestCounts.set(socket, Number(socketRequestCounts.get(socket) || 0) + 1);
    let finalized = false;
    const finalizeRequest = () => {
      if (finalized) return;
      finalized = true;
      const remaining = Math.max(0, Number(socketRequestCounts.get(socket) || 0) - 1);
      if (remaining > 0) {
        socketRequestCounts.set(socket, remaining);
        return;
      }
      socketRequestCounts.set(socket, 0);
      if (shuttingDown) {
        closeSocketIfIdle(socket);
      }
    };
    res.once("finish", finalizeRequest);
    res.once("close", finalizeRequest);

    let bodyBuffer = null;
    try {
      bodyBuffer = await readRequestBodyBuffer(req);
      const startedAt = Date.now();
      let lastError = null;

      while (Date.now() - startedAt < proxyRetryTimeoutMs) {
        const runtime = await ensureBackendRunning("proxy-request");
        const backendOrigin = `http://${formatHostForUrl(runtime.host || backendHost, runtime.port || backendPort)}`;

        try {
          const { url, init } = buildFetchRequest(req, backendOrigin, bodyBuffer);
          const response = await fetch(url, init);
          await writeFetchResponseToNode(res, response);
          return;
        } catch (proxyError) {
          lastError = proxyError;
          if (!shouldRetryProxyError(proxyError)) {
            throw proxyError;
          }
          await sleep(proxyRetryIntervalMs);
        }
      }

      throw lastError || new Error("Timed out waiting for the router backend.");
    } catch (proxyError) {
      error(`Router supervisor proxy failed: ${proxyError instanceof Error ? proxyError.message : String(proxyError)}`);
      sendProxyUnavailable(res, proxyError instanceof Error ? proxyError.message : String(proxyError));
    }
  });

  server.on("connection", (socket) => {
    socketRequestCounts.set(socket, Number(socketRequestCounts.get(socket) || 0));
    socket.on("close", () => {
      socketRequestCounts.delete(socket);
    });
  });

  await ensureBackendRunning("startup");

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  healthTimer = setInterval(() => {
    if (shuttingDown) return;
    void ensureBackendRunning("health-check").catch((restartError) => {
      error(`Router backend health check failed: ${restartError instanceof Error ? restartError.message : String(restartError)}`);
    });
  }, backendHealthPollMs);
  healthTimer.unref?.();

  server.requestBackendUpgrade = (signal = "SIGUSR2") => requestBackendUpgrade(signal);
  server.getBackendRuntime = () => readActiveRuntimeStateFromPath(backendStatePath, deps);
  server.backendRuntimeStatePath = backendStatePath;
  server.backendPort = backendPort;

  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    shuttingDown = true;
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    server.closeIdleConnections?.();
    for (const socket of socketRequestCounts.keys()) {
      closeSocketIfIdle(socket);
    }
    originalClose(async () => {
      await stopBackendIfRunning().catch(() => {});
      callback?.();
    });
    return server;
  };

  return server;
}
