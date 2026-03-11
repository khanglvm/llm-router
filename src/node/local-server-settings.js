import {
  LOCAL_ROUTER_HOST as FIXED_LOCAL_ROUTER_HOST,
  LOCAL_ROUTER_PORT as FIXED_LOCAL_ROUTER_PORT,
  LOCAL_ROUTER_ORIGIN,
  buildLocalRouterSettings,
  buildPersistedLocalServerMetadata
} from "../shared/local-router-defaults.js";

export { FIXED_LOCAL_ROUTER_HOST, FIXED_LOCAL_ROUTER_PORT };

const DEFAULT_LOCAL_SERVER_SETTINGS = Object.freeze(buildLocalRouterSettings());

export function getDefaultLocalServerSettings() {
  return { ...DEFAULT_LOCAL_SERVER_SETTINGS };
}

export function getFixedLocalRouterOrigin() {
  return LOCAL_ROUTER_ORIGIN;
}

export function readLocalServerSettings(config, fallback = DEFAULT_LOCAL_SERVER_SETTINGS) {
  return buildLocalRouterSettings(config?.metadata?.localServer, fallback);
}

export function applyLocalServerSettings(config, settings) {
  const next = config && typeof config === "object" && !Array.isArray(config)
    ? JSON.parse(JSON.stringify(config))
    : {};
  const resolved = readLocalServerSettings({ metadata: { localServer: settings } }, DEFAULT_LOCAL_SERVER_SETTINGS);
  const persisted = buildPersistedLocalServerMetadata(resolved);
  const metadata = next.metadata && typeof next.metadata === "object" && !Array.isArray(next.metadata)
    ? { ...next.metadata }
    : {};

  if (Object.keys(persisted).length > 0) {
    next.metadata = {
      ...metadata,
      localServer: persisted
    };
  } else if (Object.prototype.hasOwnProperty.call(metadata, "localServer")) {
    delete metadata.localServer;
    if (Object.keys(metadata).length > 0) {
      next.metadata = metadata;
    } else {
      delete next.metadata;
    }
  }

  return next;
}

export function sanitizePersistedLocalServerConfig(config) {
  const next = config && typeof config === "object" && !Array.isArray(config)
    ? JSON.parse(JSON.stringify(config))
    : {};
  const metadata = next.metadata;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return next;
  }

  const normalizedLocalServer = buildPersistedLocalServerMetadata(metadata.localServer);
  const nextMetadata = { ...metadata };

  if (Object.keys(normalizedLocalServer).length > 0) {
    nextMetadata.localServer = normalizedLocalServer;
  } else {
    delete nextMetadata.localServer;
  }

  if (Object.keys(nextMetadata).length > 0) {
    next.metadata = nextMetadata;
  } else {
    delete next.metadata;
  }

  return next;
}

export function areLocalServerSettingsEqual(left, right) {
  const a = readLocalServerSettings({ metadata: { localServer: left } }, DEFAULT_LOCAL_SERVER_SETTINGS);
  const b = readLocalServerSettings({ metadata: { localServer: right } }, DEFAULT_LOCAL_SERVER_SETTINGS);
  return a.host === b.host
    && a.port === b.port
    && a.watchConfig === b.watchConfig
    && a.watchBinary === b.watchBinary
    && a.requireAuth === b.requireAuth;
}

export function formatStartupLabel(startup = {}) {
  const managerMap = {
    launchd: "LaunchAgent",
    "systemd-user": "Systemd User",
    unknown: "Startup service",
    unsupported: "Startup service"
  };
  const manager = managerMap[startup.manager] || startup.manager || "Startup service";
  if (!startup.installed) return `${manager} not installed`;
  return startup.running ? `${manager} is running` : `${manager} is installed`;
}

export function formatStartupDetail(startup = {}) {
  const managerMap = {
    launchd: "Managed by launchd",
    "systemd-user": "Managed by systemd --user",
    unknown: "Managed by startup service",
    unsupported: "Startup not supported"
  };

  if (startup.detail && typeof startup.detail === "string") {
    const text = startup.detail.trim();
    if (text) {
      if (text.includes("Could not find service") || text.includes("service could not be found")) {
        return "No installed startup service was found.";
      }
      const compact = text.replace(/\s+/g, " ").trim();
      if (compact.length <= 140) return compact;
    }
  }

  return managerMap[startup.manager] || "Startup service status unavailable";
}
