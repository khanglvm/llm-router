import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

export function normalizeAmpClientSettingsScope(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "workspace") return "workspace";
  if (normalized === "global") return "global";
  return "";
}

export function normalizeAmpClientProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return "";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }

  if ([
    "localhost",
    "0.0.0.0",
    "::",
    "[::]",
    "::0",
    "[::0]",
    "::1",
    "[::1]"
  ].includes(parsed.hostname.toLowerCase())) {
    parsed.hostname = "127.0.0.1";
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";

  const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "/";
  parsed.pathname = normalizedPath;
  const out = parsed.toString();
  return normalizedPath === "/" && out.endsWith("/") ? out.slice(0, -1) : out;
}

export function resolveAmpClientSettingsFilePath({
  scope = "global",
  explicitPath = "",
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const direct = String(explicitPath || "").trim();
  if (direct) return path.resolve(direct);

  const normalizedScope = normalizeAmpClientSettingsScope(scope) || "global";
  if (normalizedScope === "workspace") {
    return path.resolve(cwd, ".amp", "settings.json");
  }

  const envOverride = String(env?.AMP_SETTINGS_FILE || "").trim();
  if (envOverride) return path.resolve(envOverride);

  const configHome = String(env?.XDG_CONFIG_HOME || "").trim() || path.join(homeDir, ".config");
  return path.join(configHome, "amp", "settings.json");
}

export function resolveAmpClientSecretsFilePath({
  explicitPath = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const direct = String(explicitPath || env?.AMP_SECRETS_FILE || "").trim();
  if (direct) return path.resolve(direct);

  const dataHome = String(env?.XDG_DATA_HOME || "").trim() || path.join(homeDir, ".local", "share");
  return path.join(dataHome, "amp", "secrets.json");
}

async function readJsonObjectFile(filePath, label) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must contain a JSON object.`);
    }
    return {
      data: parsed,
      existed: true
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        data: {},
        existed: false
      };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} contains invalid JSON.`);
    }
    throw error;
  }
}

async function writeJsonObjectFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

function dedupeTrimmedStrings(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

async function findAmpClientApiKeyForUrl(endpointUrl, {
  env = process.env,
  homeDir = os.homedir(),
  explicitSecretsFile = ""
} = {}) {
  const normalizedUrl = normalizeAmpClientProxyUrl(endpointUrl);
  if (!normalizedUrl) return "";

  try {
    const secretsFilePath = resolveAmpClientSecretsFilePath({
      explicitPath: explicitSecretsFile,
      env,
      homeDir
    });
    const secretsState = await readJsonObjectFile(secretsFilePath, `AMP secrets file '${secretsFilePath}'`);
    const candidates = dedupeTrimmedStrings([
      `apiKey@${normalizedUrl}`,
      normalizedUrl.endsWith("/") ? `apiKey@${normalizedUrl.slice(0, -1)}` : `apiKey@${normalizedUrl}/`
    ]);
    for (const fieldName of candidates) {
      const value = String(secretsState.data?.[fieldName] || "").trim();
      if (value) return value;
    }
  } catch {
  }

  return "";
}

function hasConfiguredAmpRouting(amp) {
  const source = amp && typeof amp === "object" && !Array.isArray(amp) ? amp : {};
  if (String(source.defaultRoute || "").trim()) return true;
  if (Array.isArray(source.rawModelRoutes) && source.rawModelRoutes.length > 0) return true;
  if (Array.isArray(source.modelMappings) && source.modelMappings.length > 0) return true;
  if (source.routes && typeof source.routes === "object" && Object.keys(source.routes).length > 0) return true;
  if (source.subagentMappings && typeof source.subagentMappings === "object" && Object.keys(source.subagentMappings).length > 0) return true;
  return false;
}

export function resolveAmpBootstrapRouteRef(config = {}) {
  const configuredDefault = String(config?.defaultModel || "").trim();
  if (configuredDefault) return configuredDefault;

  for (const provider of Array.isArray(config?.providers) ? config.providers : []) {
    if (provider?.enabled === false) continue;
    const providerId = String(provider?.id || "").trim();
    if (!providerId) continue;
    const firstModel = Array.isArray(provider?.models)
      ? provider.models.find((entry) => String(entry?.id || "").trim())
      : null;
    if (firstModel?.id) return `${providerId}/${firstModel.id}`;
  }

  return "";
}

export async function applyAmpRecommendedConnectionDefaults({
  amp,
  patchPlan,
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const nextAmp = amp && typeof amp === "object" && !Array.isArray(amp)
    ? structuredClone(amp)
    : {};
  let changed = false;
  let discoveredUpstreamApiKey = false;

  if (!String(nextAmp.upstreamUrl || "").trim()) {
    nextAmp.upstreamUrl = "https://ampcode.com";
    changed = true;
  }

  if (nextAmp.restrictManagementToLocalhost !== true) {
    nextAmp.restrictManagementToLocalhost = true;
    changed = true;
  }

  if (!String(nextAmp.upstreamApiKey || "").trim()) {
    const discoveredUpstreamApiKeyValue = await findAmpClientApiKeyForUrl(nextAmp.upstreamUrl, {
      env,
      homeDir,
      explicitSecretsFile: patchPlan?.secretsFilePath || ""
    });
    if (discoveredUpstreamApiKeyValue) {
      nextAmp.upstreamApiKey = discoveredUpstreamApiKeyValue;
      changed = true;
      discoveredUpstreamApiKey = true;
    }
  }

  if (!String(nextAmp.preset || "").trim()) {
    nextAmp.preset = "builtin";
    changed = true;
  }

  return {
    amp: nextAmp,
    changed,
    discoveredUpstreamApiKey,
    error: ""
  };
}

export async function maybeBootstrapAmpConfig({
  config,
  amp,
  patchPlan,
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const base = await applyAmpRecommendedConnectionDefaults({
    amp,
    patchPlan,
    env,
    homeDir
  });
  const nextAmp = base.amp;
  let changed = base.changed === true;
  const discoveredUpstreamApiKey = base.discoveredUpstreamApiKey === true;

  if (!hasConfiguredAmpRouting(nextAmp)) {
    const bootstrapRouteRef = resolveAmpBootstrapRouteRef(config);
    if (!bootstrapRouteRef) {
      return {
        amp: nextAmp,
        changed,
        bootstrapRouteRef: "",
        discoveredUpstreamApiKey,
        error: "AMP bootstrap needs defaultModel (or at least one provider model) before wiring AMP. Set defaultModel first or add a provider/model."
      };
    }
    nextAmp.defaultRoute = bootstrapRouteRef;
    changed = true;
    return {
      amp: nextAmp,
      changed,
      bootstrapRouteRef,
      discoveredUpstreamApiKey,
      error: ""
    };
  }

  return {
    amp: nextAmp,
    changed,
    bootstrapRouteRef: String(nextAmp.defaultRoute || "").trim(),
    discoveredUpstreamApiKey,
    error: ""
  };
}

export function buildAmpClientPatchPlan({
  scope = "",
  settingsFilePath = "",
  secretsFilePath = "",
  endpointUrl = "",
  apiKey = "",
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const normalizedScope = normalizeAmpClientSettingsScope(scope);
  const normalizedUrl = normalizeAmpClientProxyUrl(endpointUrl);
  if (!normalizedScope || !normalizedUrl) return null;

  return {
    scope: normalizedScope,
    settingsFilePath: resolveAmpClientSettingsFilePath({
      scope: normalizedScope,
      explicitPath: settingsFilePath,
      cwd,
      env,
      homeDir
    }),
    secretsFilePath: resolveAmpClientSecretsFilePath({
      explicitPath: secretsFilePath,
      env,
      homeDir
    }),
    endpointUrl: normalizedUrl,
    apiKey: String(apiKey || "").trim()
  };
}

export async function readAmpClientRoutingState({
  scope = "global",
  settingsFilePath = "",
  endpointUrl = "",
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const normalizedScope = normalizeAmpClientSettingsScope(scope) || "global";
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveAmpClientSettingsFilePath({
    scope: normalizedScope,
    cwd,
    env,
    homeDir
  })).trim());
  const targetUrl = normalizeAmpClientProxyUrl(endpointUrl);
  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `AMP settings file '${resolvedSettingsPath}'`);
  const configuredUrl = normalizeAmpClientProxyUrl(settingsState.data?.["amp.url"] || "");

  return {
    scope: normalizedScope,
    settingsFilePath: resolvedSettingsPath,
    configuredUrl,
    routedViaRouter: Boolean(targetUrl && configuredUrl && configuredUrl === targetUrl),
    settingsExists: settingsState.existed
  };
}

export async function patchAmpClientConfigFiles({
  settingsFilePath,
  secretsFilePath,
  endpointUrl,
  apiKey
} = {}) {
  const normalizedUrl = normalizeAmpClientProxyUrl(endpointUrl);
  const normalizedApiKey = String(apiKey || "").trim();
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveAmpClientSettingsFilePath()).trim());
  const resolvedSecretsPath = path.resolve(String(secretsFilePath || resolveAmpClientSecretsFilePath()).trim());

  if (!normalizedUrl) {
    throw new Error("AMP client endpoint URL must be a valid http:// or https:// URL.");
  }
  if (!normalizedApiKey) {
    throw new Error("AMP client API key is required.");
  }

  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `AMP settings file '${resolvedSettingsPath}'`);
  settingsState.data["amp.url"] = normalizedUrl;
  await writeJsonObjectFile(resolvedSettingsPath, settingsState.data);

  const secretsState = await readJsonObjectFile(resolvedSecretsPath, `AMP secrets file '${resolvedSecretsPath}'`);
  const secretFieldName = `apiKey@${normalizedUrl}`;
  secretsState.data[secretFieldName] = normalizedApiKey;
  await writeJsonObjectFile(resolvedSecretsPath, secretsState.data);

  return {
    settingsFilePath: resolvedSettingsPath,
    secretsFilePath: resolvedSecretsPath,
    endpointUrl: normalizedUrl,
    secretFieldName,
    settingsCreated: !settingsState.existed,
    secretsCreated: !secretsState.existed
  };
}

export async function unpatchAmpClientConfigFiles({
  settingsFilePath,
  secretsFilePath,
  endpointUrl = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveAmpClientSettingsFilePath({
    env,
    homeDir
  })).trim());
  const resolvedSecretsPath = path.resolve(String(secretsFilePath || resolveAmpClientSecretsFilePath({
    env,
    homeDir
  })).trim());

  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `AMP settings file '${resolvedSettingsPath}'`);
  const configuredUrl = normalizeAmpClientProxyUrl(settingsState.data?.["amp.url"] || "");
  const removedEndpointUrl = normalizeAmpClientProxyUrl(endpointUrl) || configuredUrl;
  const hadAmpUrl = Object.prototype.hasOwnProperty.call(settingsState.data, "amp.url");
  if (hadAmpUrl) {
    delete settingsState.data["amp.url"];
    await writeJsonObjectFile(resolvedSettingsPath, settingsState.data);
  }

  const secretsState = await readJsonObjectFile(resolvedSecretsPath, `AMP secrets file '${resolvedSecretsPath}'`);
  const secretFieldsRemoved = [];
  const candidateUrls = dedupeTrimmedStrings([
    removedEndpointUrl,
    configuredUrl
  ].flatMap((url) => (
    url
      ? [url, `${url}/`]
      : []
  )));

  for (const url of candidateUrls) {
    const fieldName = `apiKey@${url}`;
    if (!Object.prototype.hasOwnProperty.call(secretsState.data, fieldName)) continue;
    delete secretsState.data[fieldName];
    secretFieldsRemoved.push(fieldName);
  }

  if (secretFieldsRemoved.length > 0) {
    await writeJsonObjectFile(resolvedSecretsPath, secretsState.data);
  }

  return {
    settingsFilePath: resolvedSettingsPath,
    secretsFilePath: resolvedSecretsPath,
    removedEndpointUrl,
    settingsUpdated: hadAmpUrl,
    secretFieldsRemoved,
    settingsExisted: settingsState.existed,
    secretsExisted: secretsState.existed
  };
}
