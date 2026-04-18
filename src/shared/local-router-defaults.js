export const LOCAL_ROUTER_HOST = "127.0.0.1";
export const LOCAL_ROUTER_PORT = 8376;
export const LOCAL_ROUTER_ORIGIN = `http://${LOCAL_ROUTER_HOST}:${LOCAL_ROUTER_PORT}`;
export const LOCAL_ROUTER_OPENAI_BASE_URL = `${LOCAL_ROUTER_ORIGIN}/openai/v1`;
export const LOCAL_ROUTER_ANTHROPIC_BASE_URL = `${LOCAL_ROUTER_ORIGIN}/anthropic`;
const DEFAULT_ACTIVITY_LOG_SETTINGS = Object.freeze({
  enabled: true
});

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeHost(value, fallback = LOCAL_ROUTER_HOST) {
  const text = String(value || fallback).trim();
  return text || fallback;
}

function normalizePort(value, fallback = LOCAL_ROUTER_PORT) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

export function buildLocalRouterSettings(source = {}, fallback = {}) {
  const base = {
    host: normalizeHost(fallback?.host, LOCAL_ROUTER_HOST),
    port: normalizePort(fallback?.port, LOCAL_ROUTER_PORT),
    watchConfig: toBoolean(fallback?.watchConfig, true),
    watchBinary: toBoolean(fallback?.watchBinary, true),
    requireAuth: toBoolean(fallback?.requireAuth, false)
  };

  return {
    host: normalizeHost(source?.host, base.host),
    port: normalizePort(source?.port, base.port),
    watchConfig: toBoolean(source?.watchConfig, base.watchConfig),
    watchBinary: toBoolean(source?.watchBinary, base.watchBinary),
    requireAuth: toBoolean(source?.requireAuth, base.requireAuth)
  };
}

export function buildPersistedLocalServerMetadata(source = {}, fallback = {}) {
  const resolved = buildLocalRouterSettings(source, fallback);
  const defaults = buildLocalRouterSettings();
  const metadata = {};

  if (resolved.watchConfig !== defaults.watchConfig) metadata.watchConfig = resolved.watchConfig;
  if (resolved.watchBinary !== defaults.watchBinary) metadata.watchBinary = resolved.watchBinary;
  if (resolved.requireAuth !== defaults.requireAuth) metadata.requireAuth = resolved.requireAuth;

  return metadata;
}

export function buildActivityLogSettings(source = {}, fallback = {}) {
  const base = {
    enabled: toBoolean(fallback?.enabled, DEFAULT_ACTIVITY_LOG_SETTINGS.enabled)
  };

  return {
    enabled: toBoolean(source?.enabled, base.enabled)
  };
}

export function buildPersistedActivityLogMetadata(source = {}, fallback = {}) {
  const resolved = buildActivityLogSettings(source, fallback);
  const defaults = buildActivityLogSettings();
  const metadata = {};

  if (resolved.enabled !== defaults.enabled) metadata.enabled = resolved.enabled;

  return metadata;
}

export function readActivityLogSettings(config, fallback = DEFAULT_ACTIVITY_LOG_SETTINGS) {
  return buildActivityLogSettings(config?.metadata?.activityLog, fallback);
}

export function applyActivityLogSettings(config, settings) {
  const next = config && typeof config === "object" && !Array.isArray(config)
    ? JSON.parse(JSON.stringify(config))
    : {};
  const resolved = readActivityLogSettings({ metadata: { activityLog: settings } }, DEFAULT_ACTIVITY_LOG_SETTINGS);
  const persisted = buildPersistedActivityLogMetadata(resolved);
  const metadata = next.metadata && typeof next.metadata === "object" && !Array.isArray(next.metadata)
    ? { ...next.metadata }
    : {};

  if (Object.keys(persisted).length > 0) {
    next.metadata = {
      ...metadata,
      activityLog: persisted
    };
  } else if (Object.prototype.hasOwnProperty.call(metadata, "activityLog")) {
    delete metadata.activityLog;
    if (Object.keys(metadata).length > 0) {
      next.metadata = metadata;
    } else {
      delete next.metadata;
    }
  }

  return next;
}

export function sanitizeRuntimeMetadata(metadata) {
  if (!isPlainObject(metadata)) return {};

  const next = { ...metadata };
  if (Object.prototype.hasOwnProperty.call(next, "localServer")) {
    const localServer = buildPersistedLocalServerMetadata(next.localServer);
    if (Object.keys(localServer).length > 0) {
      next.localServer = localServer;
    } else {
      delete next.localServer;
    }
  }
  if (Object.prototype.hasOwnProperty.call(next, "activityLog")) {
    const activityLog = buildPersistedActivityLogMetadata(next.activityLog);
    if (Object.keys(activityLog).length > 0) {
      next.activityLog = activityLog;
    } else {
      delete next.activityLog;
    }
  }

  return next;
}
