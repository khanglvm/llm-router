export const LOCAL_ROUTER_HOST = "127.0.0.1";
export const LOCAL_ROUTER_PORT = 8376;
export const LOCAL_ROUTER_ORIGIN = `http://${LOCAL_ROUTER_HOST}:${LOCAL_ROUTER_PORT}`;
export const LOCAL_ROUTER_OPENAI_BASE_URL = `${LOCAL_ROUTER_ORIGIN}/openai/v1`;
export const LOCAL_ROUTER_ANTHROPIC_BASE_URL = `${LOCAL_ROUTER_ORIGIN}/anthropic`;

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

export function buildLocalRouterSettings(source = {}, fallback = {}) {
  const base = {
    watchConfig: toBoolean(fallback?.watchConfig, true),
    watchBinary: toBoolean(fallback?.watchBinary, true),
    requireAuth: toBoolean(fallback?.requireAuth, false)
  };

  return {
    host: LOCAL_ROUTER_HOST,
    port: LOCAL_ROUTER_PORT,
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

  return next;
}
