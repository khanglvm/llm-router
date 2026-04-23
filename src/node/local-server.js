/**
 * Local HTTP server wrapper around the shared fetch handler.
 */

import http from "node:http";
import path from "node:path";
import { watch as fsWatch } from "node:fs";
import { Readable } from "node:stream";
import { createFetchHandler } from "../runtime/handler.js";
import { readConfigFile, getDefaultConfigPath } from "./config-store.js";
import { FIXED_LOCAL_ROUTER_HOST, FIXED_LOCAL_ROUTER_PORT } from "./local-server-settings.js";
import { readActivityLogSettings } from "../shared/local-router-defaults.js";
import { appendActivityLogEntry, resolveActivityLogPath } from "./activity-log.js";
import { appendLargeRequestLogEntry, resolveLargeRequestLogPath } from "./large-request-log.js";
import { isLargeRequestLoggingEnabled } from "../runtime/handler/large-request-log.js";
import {
  startConfiguredLlamacppRuntime,
  stopManagedLlamacppRuntime
} from "./llamacpp-runtime.js";

const DEFAULT_CONFIG_RELOAD_DEBOUNCE_MS = 300;
const MAX_CONFIG_RELOAD_DEBOUNCE_MS = 5000;

function resolveReloadDebounceMs(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_CONFIG_RELOAD_DEBOUNCE_MS;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CONFIG_RELOAD_DEBOUNCE_MS;
  }

  return Math.min(parsed, MAX_CONFIG_RELOAD_DEBOUNCE_MS);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createLiveConfigStore({
  configPath,
  watchConfig = true,
  reloadDebounceMs = DEFAULT_CONFIG_RELOAD_DEBOUNCE_MS,
  validateConfig,
  onReload,
  onReloadError
}) {
  let currentConfig = null;
  let initialLoadPromise = null;
  let inFlightReload = null;
  let queuedReloadReason = "";
  let watcher = null;
  let reloadTimer = null;
  let closed = false;

  const configDir = path.dirname(configPath);
  const configFile = path.basename(configPath);

  const emitReloadError = (error, reason) => {
    if (typeof onReloadError === "function") {
      onReloadError(error, reason);
      return;
    }

    console.error(`[llm-router] Failed reloading config (${reason}): ${formatError(error)}`);
  };

  async function loadAndSwap(reason) {
    try {
      const next = await readConfigFile(configPath);
      if (typeof validateConfig === "function") {
        const validationError = validateConfig(next);
        if (validationError) {
          throw new Error(validationError);
        }
      }

      currentConfig = next;
      if (typeof onReload === "function") {
        onReload(next, reason);
      }
      return currentConfig;
    } catch (error) {
      emitReloadError(error, reason);
      if (!currentConfig) throw error;
      return currentConfig;
    }
  }

  async function triggerReload(reason) {
    if (closed) return currentConfig;
    if (inFlightReload) {
      queuedReloadReason = reason;
      return inFlightReload;
    }

    inFlightReload = loadAndSwap(reason)
      .finally(() => {
        inFlightReload = null;
        if (queuedReloadReason && !closed) {
          const nextReason = queuedReloadReason;
          queuedReloadReason = "";
          void triggerReload(nextReason);
        }
      });

    return inFlightReload;
  }

  function scheduleReload(reason) {
    if (closed) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      void triggerReload(reason);
    }, reloadDebounceMs);
  }

  function startWatcher() {
    if (!watchConfig) return;
    try {
      watcher = fsWatch(configDir, (eventType, filename) => {
        if (closed) return;
        if (!filename) return;
        if (String(filename) !== configFile) return;
        scheduleReload(eventType || "change");
      });
    } catch (error) {
      emitReloadError(error, "watch-init");
    }
  }

  async function getConfig() {
    if (currentConfig) return currentConfig;
    if (!initialLoadPromise) {
      initialLoadPromise = triggerReload("startup")
        .finally(() => {
          initialLoadPromise = null;
        });
    }
    return initialLoadPromise;
  }

  function close() {
    closed = true;
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  }

  startWatcher();

  return {
    getConfig,
    reloadNow: async (reason = "manual") => triggerReload(reason),
    close
  };
}

function formatHostForUrl(host, port) {
  const value = String(host || "127.0.0.1").trim();
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
  const path = normalizeRequestPath(req.url);
  return `http://${fallbackHost}${path}`;
}

function nodeRequestToFetchRequest(req, fallbackHost) {
  const url = buildRequestUrl(req, fallbackHost);
  const method = req.method || "GET";
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }

  // Use the actual socket address for local IP allowlist checks.
  const socketIp = typeof req.socket?.remoteAddress === "string"
    ? req.socket.remoteAddress
    : "";
  if (socketIp) {
    headers.set("x-real-ip", socketIp);
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  if (!hasBody) {
    return new Request(url, { method, headers });
  }

  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(req),
    duplex: "half"
  });
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

function buildVariantLlamacppRuntimeConfig(config, variantKey) {
  const normalizedVariantKey = normalizeString(variantKey);
  const runtime = config?.metadata?.localModels?.runtime?.llamacpp;
  const variants = config?.metadata?.localModels?.variants;
  const library = config?.metadata?.localModels?.library;
  const variant = variants?.[normalizedVariantKey];
  if (!runtime || !variant || variant.runtime !== "llamacpp") return null;

  const baseModelId = normalizeString(variant?.baseModelId);
  const baseModel = library?.[baseModelId];
  if (!baseModel) return null;

  return {
    metadata: {
      localModels: {
        runtime: {
          llamacpp: { ...runtime }
        },
        library: {
          [baseModelId]: { ...baseModel }
        },
        variants: {
          [normalizedVariantKey]: {
            ...variant,
            enabled: true,
            preload: true
          }
        }
      }
    }
  };
}

export async function startLocalRouteServer({
  port = FIXED_LOCAL_ROUTER_PORT,
  host = FIXED_LOCAL_ROUTER_HOST,
  configPath = getDefaultConfigPath(),
  activityLogPath = "",
  largeRequestLogPath = "",
  watchConfig = true,
  configReloadDebounceMs = process.env.LLM_ROUTER_CONFIG_RELOAD_DEBOUNCE_MS,
  validateConfig,
  onConfigReload,
  onConfigReloadError,
  requireAuth = false,
  createFetchHandlerImpl = createFetchHandler,
  startConfiguredLlamacppRuntimeImpl = startConfiguredLlamacppRuntime,
  stopManagedLlamacppRuntimeImpl = stopManagedLlamacppRuntime
} = {}) {
  const reloadDebounceMs = resolveReloadDebounceMs(configReloadDebounceMs);
  const resolvedActivityLogPath = resolveActivityLogPath(configPath, activityLogPath);
  const resolvedLargeRequestLogPath = resolveLargeRequestLogPath(configPath, largeRequestLogPath, process.env);
  let activityLogEnabled = true;
  const configStore = createLiveConfigStore({
    configPath,
    watchConfig,
    reloadDebounceMs,
    validateConfig,
    onReload: (nextConfig, reason) => {
      activityLogEnabled = readActivityLogSettings(nextConfig).enabled;
      if (typeof onConfigReload === "function") {
        onConfigReload(nextConfig, reason);
      }
    },
    onReloadError: onConfigReloadError
  });
  const initialConfig = await configStore.getConfig();
  activityLogEnabled = readActivityLogSettings(initialConfig).enabled;

  const fetchHandler = createFetchHandlerImpl({
    ignoreAuth: !requireAuth,
    runtime: "node",
    getConfig: () => configStore.getConfig(),
    resolveLocalRuntimeBaseUrl: async ({ candidate }) => {
      const variantKey = candidate?.model?.metadata?.localVariantKey;
      const config = await configStore.getConfig();
      const targetedConfig = buildVariantLlamacppRuntimeConfig(config, variantKey);
      if (!targetedConfig) return "";

      const started = await startConfiguredLlamacppRuntimeImpl(targetedConfig);
      if (!started?.ok) {
        throw new Error(started?.errorMessage || `Failed starting local runtime for ${normalizeString(variantKey) || "unknown variant"}.`);
      }
      return normalizeString(started?.runtime?.baseUrl);
    },
    defaultStateStoreBackend: "file",
    onActivityLog: (entry) => {
      if (!activityLogEnabled) return;
      void appendActivityLogEntry(resolvedActivityLogPath, {
        ...entry,
        source: entry?.source || "runtime"
      }).catch((error) => {
        console.warn(`[llm-router] Failed writing activity log: ${formatError(error)}`);
      });
    },
    onLargeRequestLog: (entry) => {
      if (!isLargeRequestLoggingEnabled(process.env)) return;
      void appendLargeRequestLogEntry(resolvedLargeRequestLogPath, entry).catch((error) => {
        console.warn(`[llm-router] Failed writing large request log: ${formatError(error)}`);
      });
    }
  });

  const fallbackHost = formatHostForUrl(host, port);
  let shuttingDown = false;
  const socketRequestCounts = new Map();

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

    try {
      const request = nodeRequestToFetchRequest(req, fallbackHost);
      const response = await fetchHandler(request, {}, undefined);
      await writeFetchResponseToNode(res, response);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  });

  server.on("connection", (socket) => {
    socketRequestCounts.set(socket, Number(socketRequestCounts.get(socket) || 0));
    socket.on("close", () => {
      socketRequestCounts.delete(socket);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    shuttingDown = true;
    Promise.resolve()
      .then(() => stopManagedLlamacppRuntimeImpl().catch(() => {}))
      .then(() => configStore.close())
      .then(() => (typeof fetchHandler.close === "function" ? fetchHandler.close() : undefined))
      .finally(() => {
        server.closeIdleConnections?.();
        for (const socket of socketRequestCounts.keys()) {
          closeSocketIfIdle(socket);
        }
        originalClose(callback);
      });
    return server;
  };

  return server;
}
