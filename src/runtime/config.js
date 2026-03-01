/**
 * Runtime config helpers for both local Node route and Cloudflare Worker route.
 * Config source is user-managed (e.g. ~/.llm-router.json or LLM_ROUTER_CONFIG_JSON secret).
 */

import { FORMATS } from "../translator/index.js";

export const CONFIG_VERSION = 2;
export const MIN_SUPPORTED_CONFIG_VERSION = 1;
export const PROVIDER_ID_PATTERN = /^[a-z][a-zA-Z0-9-]*$/;
const DEFAULT_PROVIDER_USER_AGENT_NAME = "AICodeClient";
const DEFAULT_PROVIDER_USER_AGENT_VERSION = "1.0.0";
export const DEFAULT_PROVIDER_USER_AGENT = buildDefaultProviderUserAgent();

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const LEGACY_CONFIG_VERSION = 1;
const NORMALIZATION_ISSUES_SYMBOL = Symbol("runtimeNormalizationIssues");
const ROUTING_INDEX_SYMBOL = Symbol("runtimeRoutingIndex");
const ALLOWED_ALIAS_STRATEGIES = new Set([
  "auto",
  "ordered",
  "round-robin",
  "weighted-rr",
  "quota-aware-weighted-rr"
]);
const ALLOWED_RATE_LIMIT_WINDOW_UNITS = new Set([
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month"
]);
const ALIAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
let runtimeEnvCache = null;

function readNodeRuntimeInfo() {
  if (typeof process === "undefined" || !process) {
    return { runtime: "runtime/unknown", platform: "unknown", arch: "unknown" };
  }

  const runtimeVersion = process?.versions?.node ? String(process.versions.node) : "";
  const runtime = runtimeVersion ? `node/${runtimeVersion}` : "runtime/unknown";
  const platform = process?.platform ? String(process.platform) : "unknown";
  const arch = process?.arch ? String(process.arch) : "unknown";
  return { runtime, platform, arch };
}

function buildDefaultProviderUserAgent() {
  const { runtime, platform, arch } = readNodeRuntimeInfo();
  return `${DEFAULT_PROVIDER_USER_AGENT_NAME}/${DEFAULT_PROVIDER_USER_AGENT_VERSION} (${platform}; ${arch}) ${runtime}`;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.floor(parsed);
  if (normalized <= 0) return undefined;
  return normalized;
}

function parseConfigVersionNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.floor(parsed);
  if (normalized <= 0) return undefined;
  return normalized;
}

function normalizeMetadataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function slugifyId(value, fallback = "provider") {
  const slug = String(value || fallback)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function sanitizeRateLimitBucketName(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function resolveUniqueRateLimitBucketId(baseId, reservedIds) {
  const normalizedBase = String(baseId || "").trim() || "bucket";
  if (!(reservedIds instanceof Set)) return normalizedBase;
  if (!reservedIds.has(normalizedBase)) return normalizedBase;
  let suffix = 2;
  let candidate = `${normalizedBase}-${suffix}`;
  while (reservedIds.has(candidate)) {
    suffix += 1;
    candidate = `${normalizedBase}-${suffix}`;
  }
  return candidate;
}

function sanitizeEndpointUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return "";
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "";
  }

  // Explicitly drop auth/hash components from persisted endpoint URLs.
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

function parseRouteReference(value) {
  const text = String(value || "").trim();
  if (!text) return { type: "invalid", ref: "", reason: "empty" };
  if (/\s/.test(text)) return { type: "invalid", ref: text, reason: "contains-whitespace" };

  if (text.startsWith("alias:")) {
    const aliasId = text.slice("alias:".length).trim();
    if (!aliasId || !ALIAS_ID_PATTERN.test(aliasId)) {
      return { type: "invalid", ref: text, reason: "invalid-alias" };
    }
    return { type: "alias", ref: text, aliasId };
  }

  const slashIndex = text.indexOf("/");
  if (slashIndex > 0 && slashIndex < text.length - 1) {
    const providerId = text.slice(0, slashIndex);
    const modelId = text.slice(slashIndex + 1);
    if (!providerId || !modelId) {
      return { type: "invalid", ref: text, reason: "invalid-direct-ref" };
    }
    return { type: "direct", ref: text, providerId, modelId };
  }

  if (!ALIAS_ID_PATTERN.test(text)) {
    return { type: "invalid", ref: text, reason: "invalid-alias" };
  }
  return { type: "alias", ref: text, aliasId: text };
}

function normalizeAliasTargetEntry(target) {
  if (typeof target === "string") {
    return { ref: target.trim() };
  }
  if (!target || typeof target !== "object") return null;

  const ref = target.ref || target.target || target.route || target.model;
  if (!ref || typeof ref !== "string") return null;

  return {
    ref: ref.trim(),
    weight: Number.isFinite(target.weight) ? Number(target.weight) : undefined,
    metadata: normalizeMetadataObject(target.metadata)
  };
}

function normalizeAliasEntry(aliasId, rawAlias) {
  if (!rawAlias || typeof rawAlias !== "object" || Array.isArray(rawAlias)) return null;

  const strategy = typeof rawAlias.strategy === "string"
    ? rawAlias.strategy.trim().toLowerCase()
    : "ordered";
  const targets = dedupeAliasTargets(
    toArray(rawAlias.targets)
      .map(normalizeAliasTargetEntry)
      .filter(Boolean)
      .filter((target) => target.ref)
  );
  const fallbackTargets = dedupeAliasTargets(
    toArray(rawAlias.fallbackTargets ?? rawAlias["fallback-targets"] ?? rawAlias.fallbacks)
      .map(normalizeAliasTargetEntry)
      .filter(Boolean)
      .filter((target) => target.ref)
  );

  return {
    id: aliasId,
    strategy,
    targets,
    fallbackTargets,
    metadata: normalizeMetadataObject(rawAlias.metadata)
  };
}

function dedupeAliasTargets(targets) {
  const seen = new Set();
  const result = [];
  for (const target of (targets || [])) {
    const ref = String(target?.ref || "").trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    result.push({
      ref,
      weight: Number.isFinite(target?.weight) ? Number(target.weight) : undefined,
      metadata: normalizeMetadataObject(target?.metadata)
    });
  }
  return result;
}

function normalizeRateLimitBucketEntry(entry, index = 0, { reservedIds } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const unitRaw =
    entry.window?.unit ??
    entry.windowUnit ??
    entry["window-unit"];
  const sizeRaw =
    entry.window?.size ??
    entry.windowSize ??
    entry["window-size"];
  const models = dedupeStrings(toArray(entry.models ?? entry.model));
  const explicitId = String(entry.id || "").trim();
  const name = sanitizeRateLimitBucketName(entry.name);
  const id = explicitId || resolveUniqueRateLimitBucketId(
    slugifyId(name || `bucket-${index + 1}`, "bucket"),
    reservedIds
  );
  reservedIds?.add(id);

  return {
    id,
    ...(name ? { name } : {}),
    models,
    requests: parsePositiveInteger(entry.requests),
    window: {
      unit: typeof unitRaw === "string" ? unitRaw.trim().toLowerCase() : "",
      size: parsePositiveInteger(sizeRaw)
    },
    metadata: normalizeMetadataObject(entry.metadata)
  };
}

function normalizeAuthConfig(rawAuth) {
  if (!rawAuth || typeof rawAuth !== "object") return null;
  const type = rawAuth.type || rawAuth.kind;
  if (!type) return null;
  const headerName = typeof rawAuth.headerName === "string"
    ? rawAuth.headerName.trim()
    : (typeof rawAuth.header === "string" ? rawAuth.header.trim() : "");
  if (headerName && /[\r\n]/.test(headerName)) {
    return null;
  }
  return {
    type,
    headerName: headerName || undefined,
    prefix: rawAuth.prefix || undefined
  };
}

function normalizeModelEntry(model) {
  if (typeof model === "string") {
    return { id: model };
  }
  if (!model || typeof model !== "object") return null;
  const id = model.id || model.name || model.model;
  if (!id || typeof id !== "string") return null;
  const rawFallbacks =
    model.fallbackModels ??
    model["fallback-models"] ??
    model.silentFallbacks ??
    model["silent-fallbacks"] ??
    model.fallbacks;
  const fallbackModels = dedupeStrings(toArray(rawFallbacks));
  return {
    id,
    aliases: dedupeStrings(model.aliases || model.alias || []),
    formats: dedupeStrings(model.formats || model.format || [])
      .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE),
    enabled: model.enabled !== false,
    contextWindow: Number.isFinite(model.contextWindow) ? Number(model.contextWindow) : undefined,
    cost: model.cost,
    metadata: model.metadata && typeof model.metadata === "object" ? model.metadata : undefined,
    ...(rawFallbacks !== undefined ? { fallbackModels } : {})
  };
}

function sanitizeModelFallbackReferences(providers) {
  const validQualifiedModels = new Set();
  for (const provider of (providers || [])) {
    if (provider.enabled === false) continue;
    for (const model of (provider.models || [])) {
      if (model.enabled === false) continue;
      validQualifiedModels.add(`${provider.id}/${model.id}`);
    }
  }

  return (providers || []).map((provider) => ({
    ...provider,
    models: (provider.models || []).map((model) => {
      const selfId = `${provider.id}/${model.id}`;
      const nextFallbacks = dedupeStrings(model.fallbackModels || [])
        .filter((item) => item !== selfId)
        .filter((item) => validQualifiedModels.has(item));

      if (nextFallbacks.length > 0 || Object.prototype.hasOwnProperty.call(model, "fallbackModels")) {
        return {
          ...model,
          fallbackModels: nextFallbacks
        };
      }

      return model;
    })
  }));
}

function normalizeBaseUrlByFormat(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  const openai = typeof value.openai === "string" ? sanitizeEndpointUrl(value.openai) : "";
  const claude =
    typeof value.claude === "string" ? sanitizeEndpointUrl(value.claude)
      : (typeof value.anthropic === "string" ? sanitizeEndpointUrl(value.anthropic) : "");

  if (openai) out[FORMATS.OPENAI] = openai;
  if (claude) out[FORMATS.CLAUDE] = claude;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeProvider(provider, index = 0) {
  if (!provider || typeof provider !== "object") return null;

  const name = provider.name || provider.id || `provider-${index + 1}`;
  const id = slugifyId(provider.id || provider.name || `provider-${index + 1}`);
  const baseUrlByFormat = normalizeBaseUrlByFormat(
    provider.baseUrlByFormat ||
    provider["base-url-by-format"] ||
    provider.endpointByFormat ||
    provider["endpoint-by-format"] ||
    provider.endpoints
  );
  const explicitBaseUrl = sanitizeEndpointUrl(provider.baseUrl || provider["base-url"] || provider.endpoint || "");
  const rawFormat = provider.format || provider.responseFormat || provider["response-format"];
  const preferredFormat = [FORMATS.OPENAI, FORMATS.CLAUDE].includes(rawFormat) ? rawFormat : undefined;
  const endpointFormats = baseUrlByFormat ? Object.keys(baseUrlByFormat) : [];
  const formats = dedupeStrings([
    ...toArray(provider.formats),
    ...endpointFormats,
    ...(preferredFormat ? [preferredFormat] : [])
  ]).filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
  const orderedFormats = preferredFormat
    ? dedupeStrings([preferredFormat, ...formats])
    : formats;
  const baseUrl = explicitBaseUrl
    || (preferredFormat && baseUrlByFormat?.[preferredFormat])
    || (baseUrlByFormat?.[orderedFormats[0]])
    || baseUrlByFormat?.[FORMATS.OPENAI]
    || baseUrlByFormat?.[FORMATS.CLAUDE]
    || "";

  const normalizedModels = toArray(provider.models)
    .map(normalizeModelEntry)
    .filter(Boolean)
    .filter((item) => item.enabled !== false);
  const reservedRateLimitBucketIds = new Set();
  const normalizedRateLimits = toArray(provider.rateLimits ?? provider["rate-limits"])
    .map((entry, bucketIndex) => normalizeRateLimitBucketEntry(entry, bucketIndex, {
      reservedIds: reservedRateLimitBucketIds
    }))
    .filter(Boolean);

  const auth = normalizeAuthConfig(provider.auth) || null;
  const authByFormat = provider.authByFormat && typeof provider.authByFormat === "object"
    ? Object.fromEntries(
        Object.entries(provider.authByFormat)
          .map(([fmt, cfg]) => [fmt, normalizeAuthConfig(cfg)])
          .filter(([, cfg]) => cfg)
      )
    : undefined;

  return {
    id,
    name,
    enabled: provider.enabled !== false,
    baseUrl,
    baseUrlByFormat,
    apiKey: typeof provider.apiKey === "string" ? provider.apiKey : (typeof provider.credential === "string" ? provider.credential : undefined),
    apiKeyEnv: typeof provider.apiKeyEnv === "string" ? provider.apiKeyEnv : undefined,
    format: preferredFormat || orderedFormats[0],
    formats: orderedFormats,
    auth,
    authByFormat,
    headers: provider.headers && typeof provider.headers === "object" ? provider.headers : {},
    anthropicVersion: provider.anthropicVersion || provider["anthropic-version"] || undefined,
    anthropicBeta: provider.anthropicBeta || provider["anthropic-beta"] || undefined,
    models: normalizedModels,
    rateLimits: normalizedRateLimits,
    metadata: normalizeMetadataObject(provider.metadata),
    lastProbe: provider.lastProbe && typeof provider.lastProbe === "object" ? provider.lastProbe : undefined
  };
}

function normalizeModelAliases(rawModelAliases) {
  if (!rawModelAliases || typeof rawModelAliases !== "object" || Array.isArray(rawModelAliases)) {
    return {
      aliases: {},
      duplicateAliasIds: []
    };
  }

  const out = {};
  const duplicateAliasIds = [];
  for (const [aliasIdRaw, rawAlias] of Object.entries(rawModelAliases)) {
    const aliasId = String(aliasIdRaw || "").trim();
    if (!aliasId) continue;
    const normalizedAlias = normalizeAliasEntry(aliasId, rawAlias);
    if (!normalizedAlias) continue;
    if (Object.prototype.hasOwnProperty.call(out, aliasId)) {
      duplicateAliasIds.push(aliasId);
    }
    out[aliasId] = normalizedAlias;
  }
  return {
    aliases: out,
    duplicateAliasIds
  };
}

function normalizeAmpRouteRefMap(rawMap, {
  normalizeKey = (value) => String(value || "").trim()
} = {}) {
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) return {};

  const out = {};
  for (const [rawKey, rawValue] of Object.entries(rawMap)) {
    const key = normalizeKey(rawKey);
    const ref = typeof rawValue === "string"
      ? rawValue.trim()
      : (typeof rawValue?.ref === "string" ? rawValue.ref.trim() : "");
    if (!key || !ref) continue;
    out[key] = ref;
  }
  return out;
}

function normalizeAmpAgentModeMap(rawMap) {
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) return {};

  const out = {};
  for (const [rawAgent, rawModes] of Object.entries(rawMap)) {
    const agent = String(rawAgent || "").trim().toLowerCase();
    if (!agent || !rawModes || typeof rawModes !== "object" || Array.isArray(rawModes)) continue;
    const normalizedModes = normalizeAmpRouteRefMap(rawModes, {
      normalizeKey: (value) => String(value || "").trim().toLowerCase()
    });
    if (Object.keys(normalizedModes).length === 0) continue;
    out[agent] = normalizedModes;
  }
  return out;
}

function normalizeAmpRouting(rawAmpRouting) {
  if (!rawAmpRouting || typeof rawAmpRouting !== "object" || Array.isArray(rawAmpRouting)) {
    return undefined;
  }

  const fallbackRoute = typeof rawAmpRouting.fallbackRoute === "string"
    ? rawAmpRouting.fallbackRoute.trim()
    : (typeof rawAmpRouting["fallback-route"] === "string" ? rawAmpRouting["fallback-route"].trim() : "");

  return {
    enabled: rawAmpRouting.enabled !== false,
    ...(fallbackRoute ? { fallbackRoute } : {}),
    modeMap: normalizeAmpRouteRefMap(
      rawAmpRouting.modeMap ?? rawAmpRouting["mode-map"] ?? rawAmpRouting.modes,
      { normalizeKey: (value) => String(value || "").trim().toLowerCase() }
    ),
    agentMap: normalizeAmpRouteRefMap(
      rawAmpRouting.agentMap ?? rawAmpRouting["agent-map"] ?? rawAmpRouting.agents,
      { normalizeKey: (value) => String(value || "").trim().toLowerCase() }
    ),
    agentModeMap: normalizeAmpAgentModeMap(
      rawAmpRouting.agentModeMap ?? rawAmpRouting["agent-mode-map"] ?? rawAmpRouting.agentModes
    ),
    applicationMap: normalizeAmpRouteRefMap(
      rawAmpRouting.applicationMap ?? rawAmpRouting["application-map"] ?? rawAmpRouting.applications,
      { normalizeKey: (value) => String(value || "").trim().toLowerCase() }
    ),
    modelMap: normalizeAmpRouteRefMap(
      rawAmpRouting.modelMap ?? rawAmpRouting["model-map"] ?? rawAmpRouting.modelMappings ?? rawAmpRouting["model-mappings"]
    ),
    metadata: normalizeMetadataObject(rawAmpRouting.metadata)
  };
}

function hasV2ConfigFields(raw, providers, modelAliases) {
  if (Object.keys(modelAliases || {}).length > 0) return true;
  if (raw?.ampRouting || raw?.["amp-routing"]) return true;
  if ((providers || []).some((provider) => Array.isArray(provider.rateLimits) && provider.rateLimits.length > 0)) {
    return true;
  }
  if (raw && typeof raw === "object") {
    const rawModelAliases = raw.modelAliases || raw["model-aliases"];
    if (rawModelAliases && typeof rawModelAliases === "object" && !Array.isArray(rawModelAliases) && Object.keys(rawModelAliases).length > 0) {
      return true;
    }
    if (toArray(raw.providers).some((provider) => {
      const rawRateLimits = provider?.rateLimits ?? provider?.["rate-limits"];
      if (Array.isArray(rawRateLimits)) return rawRateLimits.length > 0;
      return Boolean(rawRateLimits);
    })) return true;
  }
  return false;
}

function inferMinimumRequiredConfigVersion(raw, providers, modelAliases) {
  return hasV2ConfigFields(raw, providers, modelAliases)
    ? CONFIG_VERSION
    : MIN_SUPPORTED_CONFIG_VERSION;
}

function inferNormalizedConfigVersion(raw, providers, modelAliases) {
  const explicitVersion = parseConfigVersionNumber(raw?.version);
  const minimumRequiredVersion = inferMinimumRequiredConfigVersion(raw, providers, modelAliases);
  if (explicitVersion === undefined) return minimumRequiredVersion;
  return Math.max(explicitVersion, minimumRequiredVersion);
}

export function detectRuntimeConfigVersion(rawConfig) {
  const raw = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const explicitVersion = parseConfigVersionNumber(raw?.version);
  if (explicitVersion !== undefined) return explicitVersion;
  return hasV2ConfigFields(
    raw,
    toArray(raw.providers).filter(Boolean),
    raw.modelAliases || raw["model-aliases"] || {}
  )
    ? CONFIG_VERSION
    : LEGACY_CONFIG_VERSION;
}

export function assertSupportedRuntimeConfigVersion(rawConfigOrVersion, {
  minVersion = MIN_SUPPORTED_CONFIG_VERSION,
  maxVersion = CONFIG_VERSION,
  allowFutureVersion = true
} = {}) {
  const version = typeof rawConfigOrVersion === "number"
    ? parseConfigVersionNumber(rawConfigOrVersion)
    : detectRuntimeConfigVersion(rawConfigOrVersion);

  if (version === undefined) {
    throw new Error("Config.version must be a positive integer when specified.");
  }
  if (version < minVersion) {
    throw new Error(`Unsupported config version '${version}'. Minimum supported version is ${minVersion}.`);
  }
  if (!allowFutureVersion && version > maxVersion) {
    throw new Error(`Unsupported config version '${version}'. This runtime supports versions ${minVersion}-${maxVersion}.`);
  }
  return version;
}

function migrateConfigV1ToV2(rawConfig) {
  const raw = rawConfig && typeof rawConfig === "object" ? structuredClone(rawConfig) : {};
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  raw.providers = providers.map((provider) => {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) return provider;
    const nextProvider = { ...provider };
    if (nextProvider.rateLimits === undefined && nextProvider["rate-limits"] === undefined) {
      nextProvider.rateLimits = [];
    }
    return nextProvider;
  });
  if (raw.modelAliases === undefined && raw["model-aliases"] === undefined) {
    raw.modelAliases = {};
  }
  raw.version = 2;
  return raw;
}

const CONFIG_VERSION_MIGRATIONS = new Map([
  [1, migrateConfigV1ToV2]
]);

export function migrateRuntimeConfig(rawConfig, {
  targetVersion = CONFIG_VERSION
} = {}) {
  const normalizedTargetVersion = parseConfigVersionNumber(targetVersion);
  if (normalizedTargetVersion === undefined) {
    throw new Error(`Invalid migration target version '${targetVersion}'.`);
  }
  assertSupportedRuntimeConfigVersion(normalizedTargetVersion);

  let current = assertSupportedRuntimeConfigVersion(rawConfig, { allowFutureVersion: true });
  if (normalizedTargetVersion < current) {
    return structuredClone(rawConfig);
  }

  let migrated = rawConfig && typeof rawConfig === "object" ? structuredClone(rawConfig) : {};
  while (current < normalizedTargetVersion) {
    const migrateStep = CONFIG_VERSION_MIGRATIONS.get(current);
    if (typeof migrateStep !== "function") {
      throw new Error(`No migration path from config version '${current}' to '${normalizedTargetVersion}'.`);
    }
    migrated = migrateStep(migrated);
    current = assertSupportedRuntimeConfigVersion(migrated, { allowFutureVersion: true });
  }

  if (parseConfigVersionNumber(migrated?.version) !== normalizedTargetVersion) {
    migrated.version = normalizedTargetVersion;
  }
  return migrated;
}

function attachRoutingIndex(config, routingIndex) {
  Object.defineProperty(config, ROUTING_INDEX_SYMBOL, {
    value: routingIndex,
    enumerable: false,
    writable: true,
    configurable: true
  });
  return config;
}

export function buildRoutingIndex(config) {
  const index = {
    modelByRef: new Map(),
    modelByAliasRef: new Map(),
    aliasById: new Map(),
    providerById: new Map(),
    modelIdsByProvider: new Map()
  };

  for (const provider of (config?.providers || [])) {
    if (!provider || provider.enabled === false) continue;
    index.providerById.set(provider.id, provider);
    const providerModelIds = new Set();

    for (const model of (provider.models || [])) {
      if (!model || model.enabled === false) continue;
      const directRef = `${provider.id}/${model.id}`;
      providerModelIds.add(model.id);
      index.modelByRef.set(directRef, { provider, model, ref: directRef });
      for (const alias of (model.aliases || [])) {
        const aliasRef = `${provider.id}/${alias}`;
        if (!index.modelByAliasRef.has(aliasRef)) {
          index.modelByAliasRef.set(aliasRef, { provider, model, ref: directRef });
        }
      }
    }

    index.modelIdsByProvider.set(provider.id, providerModelIds);
  }

  for (const [aliasId, alias] of Object.entries(config?.modelAliases || {})) {
    if (!alias || typeof alias !== "object") continue;
    index.aliasById.set(aliasId, alias);
  }

  return index;
}

function getRoutingIndex(config) {
  if (!config || typeof config !== "object") return buildRoutingIndex(config);
  if (config[ROUTING_INDEX_SYMBOL]) return config[ROUTING_INDEX_SYMBOL];
  return attachRoutingIndex(config, buildRoutingIndex(config))[ROUTING_INDEX_SYMBOL];
}

export function normalizeRuntimeConfig(rawConfig, options = {}) {
  const rawInput = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const migrateToVersion = options && Object.prototype.hasOwnProperty.call(options, "migrateToVersion")
    ? options.migrateToVersion
    : undefined;
  const inputVersion = assertSupportedRuntimeConfigVersion(rawInput, { allowFutureVersion: true });
  const targetVersion = migrateToVersion !== undefined
    ? parseConfigVersionNumber(migrateToVersion)
    : undefined;
  const shouldMigrate = targetVersion !== undefined
    && Number.isFinite(inputVersion)
    && inputVersion < targetVersion;
  const raw = shouldMigrate
    ? migrateRuntimeConfig(rawInput, { targetVersion })
    : rawInput;
  const providers = sanitizeModelFallbackReferences(
    toArray(raw.providers)
    .map(normalizeProvider)
    .filter(Boolean)
    .filter((provider) => provider.enabled !== false)
  );
  const modelAliasResult = normalizeModelAliases(raw.modelAliases || raw["model-aliases"]);
  const modelAliases = modelAliasResult.aliases;
  const ampRouting = normalizeAmpRouting(raw.ampRouting || raw["amp-routing"]);

  const masterKey = typeof raw.masterKey === "string"
    ? raw.masterKey
    : (typeof raw["master-key"] === "string" ? raw["master-key"] : undefined);

  const defaultModel = typeof raw.defaultModel === "string"
    ? raw.defaultModel
    : (typeof raw["default-model"] === "string" ? raw["default-model"] : undefined);

  const normalized = {
    version: inferNormalizedConfigVersion(raw, providers, modelAliases),
    masterKey,
    defaultModel,
    providers,
    modelAliases,
    ampRouting,
    metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}
  };
  Object.defineProperty(normalized, NORMALIZATION_ISSUES_SYMBOL, {
    value: {
      duplicateAliasIds: modelAliasResult.duplicateAliasIds
    },
    enumerable: false,
    writable: true,
    configurable: true
  });
  return attachRoutingIndex(normalized, buildRoutingIndex(normalized));
}

export function parseRuntimeConfigJson(json, options = undefined) {
  return normalizeRuntimeConfig(JSON.parse(json), options);
}

export function configHasProvider(config) {
  return Array.isArray(config?.providers) && config.providers.some((provider) => provider.enabled !== false);
}

export function resolveRouteReference(config, ref) {
  const index = getRoutingIndex(config);
  const parsedRef = parseRouteReference(ref);
  if (parsedRef.type === "direct") {
    return index.modelByRef.get(parsedRef.ref) || index.modelByAliasRef.get(parsedRef.ref) || null;
  }
  if (parsedRef.type === "alias") {
    const alias = index.aliasById.get(parsedRef.aliasId);
    return alias ? { aliasId: parsedRef.aliasId, alias, ref: parsedRef.aliasId, type: "alias" } : null;
  }
  return null;
}

function collectAliasReferenceEntries(alias, aliasId) {
  const refs = [];
  for (const [listName, targets] of [
    ["targets", alias?.targets || []],
    ["fallbackTargets", alias?.fallbackTargets || []]
  ]) {
    for (let index = 0; index < targets.length; index += 1) {
      refs.push({
        aliasId,
        listName,
        index,
        target: targets[index]
      });
    }
  }
  return refs;
}

function validateProviderRateLimits(config, routingIndex, errors) {
  for (const provider of (config?.providers || [])) {
    const seenBucketIds = new Set();
    const knownModelIds = routingIndex.modelIdsByProvider.get(provider?.id) || new Set();
    for (const bucket of (provider?.rateLimits || [])) {
      const bucketId = String(bucket?.id || "").trim();
      if (!bucketId) {
        errors.push(`Provider '${provider?.id || "(unknown)"}' has a rate-limit bucket missing id.`);
      } else if (seenBucketIds.has(bucketId)) {
        errors.push(`Provider '${provider?.id || "(unknown)"}' has duplicate rate-limit bucket id '${bucketId}'.`);
      } else {
        seenBucketIds.add(bucketId);
      }

      const modelSelectors = dedupeStrings(bucket?.models || []);
      if (modelSelectors.length === 0) {
        errors.push(`Rate-limit bucket '${bucketId || "(unknown)"}' on provider '${provider?.id || "(unknown)"}' must define models.`);
      }
      const hasAll = modelSelectors.includes("all");
      if (hasAll && modelSelectors.length > 1) {
        errors.push(`Rate-limit bucket '${bucketId || "(unknown)"}' on provider '${provider?.id || "(unknown)"}' cannot combine 'all' with specific models.`);
      }
      for (const selector of modelSelectors) {
        if (selector === "all") continue;
        if (!knownModelIds.has(selector)) {
          errors.push(`Rate-limit bucket '${bucketId || "(unknown)"}' on provider '${provider?.id || "(unknown)"}' has unknown model selector '${selector}'.`);
        }
      }

      if (!parsePositiveInteger(bucket?.requests)) {
        errors.push(`Rate-limit bucket '${bucketId || "(unknown)"}' on provider '${provider?.id || "(unknown)"}' must define requests as a positive integer.`);
      }

      const windowUnit = typeof bucket?.window?.unit === "string"
        ? bucket.window.unit.trim().toLowerCase()
        : "";
      if (!ALLOWED_RATE_LIMIT_WINDOW_UNITS.has(windowUnit)) {
        errors.push(`Rate-limit bucket '${bucketId || "(unknown)"}' on provider '${provider?.id || "(unknown)"}' has invalid window unit '${bucket?.window?.unit || ""}'.`);
      }
      if (!parsePositiveInteger(bucket?.window?.size)) {
        errors.push(`Rate-limit bucket '${bucketId || "(unknown)"}' on provider '${provider?.id || "(unknown)"}' must define window.size as a positive integer.`);
      }
    }
  }
}

function detectAliasCycles(config, errors) {
  const aliases = config?.modelAliases || {};
  const visiting = new Set();
  const visited = new Set();
  const cycleErrors = new Set();

  const walk = (aliasId, path) => {
    if (visiting.has(aliasId)) {
      const cycleStartIndex = path.indexOf(aliasId);
      const cyclePath = cycleStartIndex >= 0
        ? [...path.slice(cycleStartIndex), aliasId]
        : [...path, aliasId];
      const label = cyclePath.join(" -> ");
      if (!cycleErrors.has(label)) {
        cycleErrors.add(label);
        errors.push(`Alias cycle detected: ${label}`);
      }
      return;
    }
    if (visited.has(aliasId)) return;

    const alias = aliases[aliasId];
    if (!alias) return;
    visiting.add(aliasId);
    const nextPath = [...path, aliasId];

    for (const target of [...(alias.targets || []), ...(alias.fallbackTargets || [])]) {
      const parsed = parseRouteReference(target?.ref);
      if (parsed.type !== "alias") continue;
      if (!aliases[parsed.aliasId]) continue;
      walk(parsed.aliasId, nextPath);
    }

    visiting.delete(aliasId);
    visited.add(aliasId);
  };

  for (const aliasId of Object.keys(aliases)) {
    walk(aliasId, []);
  }
}

function validateModelAliases(config, routingIndex, errors) {
  const aliases = config?.modelAliases || {};
  const normalizationIssues = config?.[NORMALIZATION_ISSUES_SYMBOL];
  for (const duplicateAliasId of (normalizationIssues?.duplicateAliasIds || [])) {
    errors.push(`Duplicate alias id '${duplicateAliasId}'.`);
  }

  for (const [aliasId, alias] of Object.entries(aliases)) {
    if (!ALIAS_ID_PATTERN.test(aliasId)) {
      errors.push(`Alias id '${aliasId}' is invalid.`);
    }

    if (!ALLOWED_ALIAS_STRATEGIES.has(alias?.strategy || "ordered")) {
      errors.push(`Alias '${aliasId}' has unsupported strategy '${alias?.strategy}'.`);
    }
    if (!Array.isArray(alias?.targets) || alias.targets.length === 0) {
      errors.push(`Alias '${aliasId}' must define at least one target.`);
    }

    for (const entry of collectAliasReferenceEntries(alias, aliasId)) {
      const ref = String(entry.target?.ref || "").trim();
      const parsed = parseRouteReference(ref);
      const context = `Alias '${entry.aliasId}' ${entry.listName}[${entry.index}]`;

      if (parsed.type === "invalid") {
        errors.push(`${context} has invalid ref '${ref}'.`);
        continue;
      }

      if (parsed.type === "direct") {
        const resolved = routingIndex.modelByRef.get(parsed.ref) || routingIndex.modelByAliasRef.get(parsed.ref);
        if (!resolved) {
          errors.push(`${context} references unknown model '${parsed.ref}'.`);
        }
        continue;
      }

      if (!routingIndex.aliasById.has(parsed.aliasId)) {
        errors.push(`${context} references unknown alias '${parsed.aliasId}'.`);
      }
    }
  }

  detectAliasCycles(config, errors);
}

function validateAmpRouting(config, routingIndex, errors) {
  const ampRouting = config?.ampRouting;
  if (ampRouting === undefined) return;
  if (!ampRouting || typeof ampRouting !== "object" || Array.isArray(ampRouting)) {
    errors.push("Config.ampRouting must be an object.");
    return;
  }

  const validateRef = (ref, context) => {
    const parsed = parseRouteReference(ref);
    if (parsed.type === "invalid") {
      errors.push(`${context} has invalid ref '${ref}'.`);
      return;
    }
    if (parsed.type === "direct") {
      const resolved = routingIndex.modelByRef.get(parsed.ref) || routingIndex.modelByAliasRef.get(parsed.ref);
      if (!resolved) {
        errors.push(`${context} references unknown model '${parsed.ref}'.`);
      }
      return;
    }
    if (!routingIndex.aliasById.has(parsed.aliasId)) {
      errors.push(`${context} references unknown alias '${parsed.aliasId}'.`);
    }
  };

  if (typeof ampRouting.fallbackRoute === "string" && ampRouting.fallbackRoute.trim()) {
    validateRef(ampRouting.fallbackRoute.trim(), "ampRouting.fallbackRoute");
  }

  for (const [mode, ref] of Object.entries(ampRouting.modeMap || {})) {
    validateRef(ref, `ampRouting.modeMap.${mode}`);
  }
  for (const [agent, ref] of Object.entries(ampRouting.agentMap || {})) {
    validateRef(ref, `ampRouting.agentMap.${agent}`);
  }
  for (const [application, ref] of Object.entries(ampRouting.applicationMap || {})) {
    validateRef(ref, `ampRouting.applicationMap.${application}`);
  }
  for (const [model, ref] of Object.entries(ampRouting.modelMap || {})) {
    validateRef(ref, `ampRouting.modelMap.${model}`);
  }
  for (const [agent, modeMap] of Object.entries(ampRouting.agentModeMap || {})) {
    for (const [mode, ref] of Object.entries(modeMap || {})) {
      validateRef(ref, `ampRouting.agentModeMap.${agent}.${mode}`);
    }
  }
}

export function validateRuntimeConfig(config, { requireMasterKey = false, requireProvider = false } = {}) {
  const errors = [];

  if (!config || typeof config !== "object") {
    errors.push("Config is missing or invalid.");
    return errors;
  }

  try {
    assertSupportedRuntimeConfigVersion(config);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!Array.isArray(config.providers)) {
    errors.push("Config.providers must be an array.");
  }

  if (config.modelAliases !== undefined && (!config.modelAliases || typeof config.modelAliases !== "object" || Array.isArray(config.modelAliases))) {
    errors.push("Config.modelAliases must be an object.");
  }

  if (requireProvider && !configHasProvider(config)) {
    errors.push("At least one enabled provider is required.");
  }

  for (const provider of (config.providers || [])) {
    if (!provider.id) errors.push("Provider missing id.");
    if (provider.id && !PROVIDER_ID_PATTERN.test(provider.id)) {
      errors.push(`Provider id '${provider.id}' is invalid. Use slug/camelCase (e.g. openrouter or myProvider).`);
    }
    if (!provider.baseUrl) errors.push(`Provider ${provider.id || "(unknown)"} missing baseUrl.`);
    if (!provider.format && (!provider.formats || provider.formats.length === 0)) {
      errors.push(`Provider ${provider.id || "(unknown)"} missing detected format.`);
    }
    if (!Array.isArray(provider.models) || provider.models.length === 0) {
      errors.push(`Provider ${provider.id || "(unknown)"} must define at least one model.`);
    }
  }

  const routingIndex = getRoutingIndex(config);
  validateProviderRateLimits(config, routingIndex, errors);
  validateModelAliases(config, routingIndex, errors);
  validateAmpRouting(config, routingIndex, errors);

  if (requireMasterKey && !config.masterKey) {
    errors.push("masterKey is required for worker deployment/export.");
  }

  return errors;
}

export function resolveProviderApiKey(provider, env = undefined) {
  if (provider?.apiKey) return provider.apiKey;
  if (provider?.apiKeyEnv && env && provider.apiKeyEnv in env) {
    return env[provider.apiKeyEnv];
  }
  return undefined;
}

export function resolveProviderFormat(provider, sourceFormat = undefined) {
  const supported = dedupeStrings([...(provider?.formats || []), provider?.format]);
  if (sourceFormat && supported.includes(sourceFormat)) return sourceFormat;
  if (supported.includes(FORMATS.CLAUDE) && sourceFormat === FORMATS.CLAUDE) return FORMATS.CLAUDE;
  if (provider?.format) return provider.format;
  if (supported.length > 0) return supported[0];
  return FORMATS.OPENAI;
}

export function resolveProviderUrl(provider, targetFormat, options = {}) {
  const baseUrl = sanitizeEndpointUrl(provider?.baseUrlByFormat?.[targetFormat] || provider?.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return "";
  const isVersionedApiRoot = /\/v\d+(?:\.\d+)?$/i.test(baseUrl);
  const operation = String(options?.operation || "").trim().toLowerCase();

  if (targetFormat === FORMATS.OPENAI) {
    if (operation === "responses") {
      if (baseUrl.endsWith("/responses")) return baseUrl;
      if (baseUrl.endsWith("/v1") || isVersionedApiRoot) return `${baseUrl}/responses`;
      return `${baseUrl}/v1/responses`;
    }
    if (operation === "completions") {
      if (baseUrl.endsWith("/completions")) return baseUrl;
      if (baseUrl.endsWith("/v1") || isVersionedApiRoot) return `${baseUrl}/completions`;
      return `${baseUrl}/v1/completions`;
    }
    if (baseUrl.endsWith("/chat/completions")) return baseUrl;
    if (baseUrl.endsWith("/v1") || isVersionedApiRoot) return `${baseUrl}/chat/completions`;
    return `${baseUrl}/v1/chat/completions`;
  }

  if (targetFormat === FORMATS.CLAUDE) {
    if (baseUrl.endsWith("/v1/messages") || baseUrl.endsWith("/messages")) return baseUrl;
    if (baseUrl.endsWith("/v1") || isVersionedApiRoot) return `${baseUrl}/messages`;
    return `${baseUrl}/v1/messages`;
  }

  return baseUrl;
}

function pickProviderAuth(provider, targetFormat) {
  if (provider?.authByFormat && provider.authByFormat[targetFormat]) {
    return provider.authByFormat[targetFormat];
  }
  if (provider?.auth) return provider.auth;
  if (targetFormat === FORMATS.CLAUDE) {
    return { type: "x-api-key" };
  }
  return { type: "bearer" };
}

function hasHeaderName(headers, name) {
  const lower = String(name).toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === lower);
}

function normalizeCustomHeaders(rawHeaders) {
  const out = {};
  let userAgentExplicitlyDisabled = false;
  const blockedHeaders = new Set([
    "connection",
    "content-length",
    "host",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]);

  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    return { headers: out, userAgentExplicitlyDisabled };
  }

  for (const [name, value] of Object.entries(rawHeaders)) {
    if (typeof name !== "string" || !name.trim()) continue;
    if (/[\r\n]/.test(name)) continue;
    const lower = name.toLowerCase();
    if (blockedHeaders.has(lower)) continue;
    const isUserAgent = lower === "user-agent";

    if (value === undefined || value === null || value === false) {
      if (isUserAgent) userAgentExplicitlyDisabled = true;
      continue;
    }

    const text = String(value);
    if (/[\r\n]/.test(text)) continue;
    if (!text && isUserAgent) {
      userAgentExplicitlyDisabled = true;
      continue;
    }
    if (!text) continue;
    out[name] = text;
  }

  return { headers: out, userAgentExplicitlyDisabled };
}

export function buildProviderHeaders(provider, env = undefined, targetFormat = undefined) {
  const format = targetFormat || resolveProviderFormat(provider);
  const { headers: customHeaders, userAgentExplicitlyDisabled } = normalizeCustomHeaders(provider?.headers);
  const headers = {
    "Content-Type": "application/json",
    ...customHeaders
  };

  if (!userAgentExplicitlyDisabled && !hasHeaderName(headers, "user-agent")) {
    headers["User-Agent"] = DEFAULT_PROVIDER_USER_AGENT;
  }

  const apiKey = resolveProviderApiKey(provider, env);
  const auth = pickProviderAuth(provider, format);

  if (apiKey) {
    if (auth?.type === "x-api-key") {
      headers["x-api-key"] = apiKey;
    } else if (auth?.type === "header" && auth.headerName) {
      headers[auth.headerName] = `${auth.prefix || ""}${apiKey}`;
    } else if (auth?.type !== "none") {
      headers["Authorization"] = `${auth?.prefix || "Bearer "}${apiKey}`;
    }
  }

  if (format === FORMATS.CLAUDE) {
    if (!headers["anthropic-version"] && !headers["Anthropic-Version"]) {
      headers["anthropic-version"] = provider?.anthropicVersion || DEFAULT_ANTHROPIC_VERSION;
    }
    if (provider?.anthropicBeta && !headers["anthropic-beta"] && !headers["Anthropic-Beta"]) {
      headers["anthropic-beta"] = provider.anthropicBeta;
    }
  }

  return headers;
}

export function maskSecret(value) {
  if (!value || typeof value !== "string") return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function sanitizeConfigForDisplay(config) {
  return {
    ...config,
    masterKey: config.masterKey ? maskSecret(config.masterKey) : undefined,
    providers: (config.providers || []).map((provider) => ({
      ...provider,
      apiKey: provider.apiKey ? maskSecret(provider.apiKey) : undefined
    }))
  };
}

function buildTargetCandidate(provider, model, sourceFormat, target = undefined) {
  const providerFormats = dedupeStrings([...(provider?.formats || []), provider?.format])
    .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
  const modelFormats = dedupeStrings([...(model?.formats || []), model?.format])
    .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
  const supportedFormats = modelFormats.length > 0
    ? providerFormats.filter((fmt) => modelFormats.includes(fmt))
    : providerFormats;

  let targetFormat = sourceFormat && supportedFormats.includes(sourceFormat)
    ? sourceFormat
    : undefined;

  if (!targetFormat && supportedFormats.length > 0) {
    if (sourceFormat === FORMATS.CLAUDE && supportedFormats.includes(FORMATS.CLAUDE)) {
      targetFormat = FORMATS.CLAUDE;
    } else if (sourceFormat === FORMATS.OPENAI && supportedFormats.includes(FORMATS.OPENAI)) {
      targetFormat = FORMATS.OPENAI;
    } else {
      targetFormat = supportedFormats[0];
    }
  }

  if (!targetFormat) {
    targetFormat = resolveProviderFormat(provider, sourceFormat);
  }

  const candidate = {
    providerId: provider.id,
    providerName: provider.name,
    provider,
    modelId: model.id,
    model,
    backend: model.id,
    targetFormat,
    requestModelId: `${provider.id}/${model.id}`
  };

  if (Number.isFinite(target?.weight) && Number(target.weight) > 0) {
    candidate.routeWeight = Number(target.weight);
  }
  if (target?.metadata && typeof target.metadata === "object") {
    candidate.routeTargetMetadata = target.metadata;
  }
  if (typeof target?.ref === "string" && target.ref.trim()) {
    candidate.routeTargetRef = target.ref.trim();
  }

  return candidate;
}

function applyAliasTargetOptions(candidate, target, routeTier) {
  if (!candidate || !target) return candidate;

  const nextCandidate = { ...candidate };
  if (Number.isFinite(target?.weight) && Number(target.weight) > 0) {
    nextCandidate.routeWeight = Number(target.weight);
  }
  if (target?.metadata && typeof target.metadata === "object") {
    nextCandidate.routeTargetMetadata = target.metadata;
  }
  if (typeof target?.ref === "string" && target.ref.trim()) {
    nextCandidate.routeTargetRef = target.ref.trim();
  }
  if (routeTier) {
    nextCandidate.routeTier = routeTier;
  }
  return nextCandidate;
}

function modelSupportsProviderFormat(provider, model) {
  const providerFormats = dedupeStrings([...(provider.formats || []), provider.format])
    .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
  const modelFormats = dedupeStrings([...(model.formats || []), model.format])
    .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
  if (modelFormats.length === 0) return true;
  return providerFormats.some((fmt) => modelFormats.includes(fmt));
}

function findModelById(provider, modelId) {
  return (provider.models || []).find((model) => model.id === modelId || (model.aliases || []).includes(modelId));
}

function resolveQualifiedModel(config, qualifiedModel, routingIndex = getRoutingIndex(config)) {
  const parsed = parseRouteReference(qualifiedModel);
  if (parsed.type !== "direct") return null;
  return routingIndex.modelByRef.get(parsed.ref) || routingIndex.modelByAliasRef.get(parsed.ref) || null;
}

function resolveDirectRoutePlan(config, effectiveRequested, normalizedRequested, sourceFormat, routingIndex) {
  const parsed = parseRouteReference(effectiveRequested);
  if (parsed.type !== "direct") {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      routeType: "unknown",
      routeRef: null,
      primary: null,
      fallbacks: [],
      error: "Model must use a configured alias id or the 'provider/model' convention."
    };
  }

  const provider = routingIndex.providerById.get(parsed.providerId);
  if (!provider) {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      routeType: "direct",
      routeRef: parsed.ref,
      primary: null,
      fallbacks: [],
      error: `Provider '${parsed.providerId}' not found.`
    };
  }

  const model = findModelById(provider, parsed.modelId);
  if (!model) {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      routeType: "direct",
      routeRef: parsed.ref,
      primary: null,
      fallbacks: [],
      error: `Model '${parsed.modelId}' is not configured under provider '${parsed.providerId}'.`
    };
  }

  if (!modelSupportsProviderFormat(provider, model)) {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      routeType: "direct",
      routeRef: parsed.ref,
      primary: null,
      fallbacks: [],
      error: `Model '${parsed.modelId}' is configured for unsupported endpoint formats under provider '${parsed.providerId}'.`
    };
  }

  const primary = buildTargetCandidate(provider, model, sourceFormat);
  const fallbackCandidates = [];
  const seen = new Set([primary.requestModelId]);

  for (const fallbackEntry of (model.fallbackModels || [])) {
    const resolvedFallback = resolveQualifiedModel(config, fallbackEntry, routingIndex);
    if (!resolvedFallback) continue;
    if (!modelSupportsProviderFormat(resolvedFallback.provider, resolvedFallback.model)) continue;

    const fallbackCandidate = buildTargetCandidate(resolvedFallback.provider, resolvedFallback.model, sourceFormat);
    if (seen.has(fallbackCandidate.requestModelId)) continue;
    seen.add(fallbackCandidate.requestModelId);
    fallbackCandidates.push(fallbackCandidate);
  }

  return {
    requestedModel: normalizedRequested,
    resolvedModel: `${provider.id}/${model.id}`,
    routeType: "direct",
    routeRef: `${provider.id}/${model.id}`,
    primary,
    fallbacks: fallbackCandidates
  };
}

function expandAliasReferenceCandidates(config, aliasId, sourceFormat, routingIndex, stack = []) {
  if (stack.includes(aliasId)) {
    return { candidates: [], error: `Alias cycle detected: ${[...stack, aliasId].join(" -> ")}` };
  }

  const alias = routingIndex.aliasById.get(aliasId);
  if (!alias) {
    return { candidates: [], error: `Alias '${aliasId}' not found.` };
  }

  const candidates = [];
  const dedupe = new Set();
  const nextStack = [...stack, aliasId];
  for (const target of [...(alias.targets || []), ...(alias.fallbackTargets || [])]) {
    const parsed = parseRouteReference(target?.ref);
    if (parsed.type === "invalid") {
      return { candidates: [], error: `Alias '${aliasId}' has invalid ref '${target?.ref || ""}'.` };
    }

    if (parsed.type === "direct") {
      const resolved = resolveQualifiedModel(config, parsed.ref, routingIndex);
      if (!resolved) {
        return { candidates: [], error: `Alias '${aliasId}' references unknown model '${parsed.ref}'.` };
      }
      if (!modelSupportsProviderFormat(resolved.provider, resolved.model)) {
        continue;
      }
      const candidate = buildTargetCandidate(resolved.provider, resolved.model, sourceFormat, target);
      if (dedupe.has(candidate.requestModelId)) continue;
      dedupe.add(candidate.requestModelId);
      candidates.push(candidate);
      continue;
    }

    const expandedAlias = expandAliasReferenceCandidates(
      config,
      parsed.aliasId,
      sourceFormat,
      routingIndex,
      nextStack
    );
    if (expandedAlias.error) return expandedAlias;
    for (const candidate of expandedAlias.candidates) {
      if (dedupe.has(candidate.requestModelId)) continue;
      dedupe.add(candidate.requestModelId);
      candidates.push(candidate);
    }
  }

  return { candidates };
}

function resolveAliasRoutePlan(config, aliasId, normalizedRequested, sourceFormat, routingIndex) {
  const alias = routingIndex.aliasById.get(aliasId);
  if (!alias) {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      routeType: "alias",
      routeRef: aliasId,
      primary: null,
      fallbacks: [],
      error: `Alias '${aliasId}' not found.`
    };
  }

  const primaryCandidates = [];
  const fallbackCandidates = [];
  const seen = new Set();

  for (const target of (alias.targets || [])) {
    const parsed = parseRouteReference(target?.ref);
    if (parsed.type === "invalid") {
      return {
        requestedModel: normalizedRequested,
        resolvedModel: null,
        routeType: "alias",
        routeRef: aliasId,
        primary: null,
        fallbacks: [],
        error: `Alias '${aliasId}' has invalid ref '${target?.ref || ""}'.`
      };
    }

    const expanded = parsed.type === "direct"
      ? (() => {
          const resolved = resolveQualifiedModel(config, parsed.ref, routingIndex);
          if (!resolved) return { candidates: [], error: `Alias '${aliasId}' references unknown model '${parsed.ref}'.` };
          if (!modelSupportsProviderFormat(resolved.provider, resolved.model)) return { candidates: [] };
          return { candidates: [buildTargetCandidate(resolved.provider, resolved.model, sourceFormat, target)] };
        })()
      : expandAliasReferenceCandidates(config, parsed.aliasId, sourceFormat, routingIndex, [aliasId]);
    if (expanded.error) {
      return {
        requestedModel: normalizedRequested,
        resolvedModel: null,
        routeType: "alias",
        routeRef: aliasId,
        primary: null,
        fallbacks: [],
        error: expanded.error
      };
    }
    for (const candidate of (expanded.candidates || [])) {
      const routedCandidate = applyAliasTargetOptions(candidate, target, "primary");
      if (seen.has(routedCandidate.requestModelId)) continue;
      seen.add(routedCandidate.requestModelId);
      primaryCandidates.push(routedCandidate);
    }
  }

  for (const target of (alias.fallbackTargets || [])) {
    const parsed = parseRouteReference(target?.ref);
    if (parsed.type === "invalid") {
      return {
        requestedModel: normalizedRequested,
        resolvedModel: null,
        routeType: "alias",
        routeRef: aliasId,
        primary: null,
        fallbacks: [],
        error: `Alias '${aliasId}' has invalid fallback ref '${target?.ref || ""}'.`
      };
    }

    const expanded = parsed.type === "direct"
      ? (() => {
          const resolved = resolveQualifiedModel(config, parsed.ref, routingIndex);
          if (!resolved) return { candidates: [], error: `Alias '${aliasId}' references unknown model '${parsed.ref}'.` };
          if (!modelSupportsProviderFormat(resolved.provider, resolved.model)) return { candidates: [] };
          return { candidates: [buildTargetCandidate(resolved.provider, resolved.model, sourceFormat, target)] };
        })()
      : expandAliasReferenceCandidates(config, parsed.aliasId, sourceFormat, routingIndex, [aliasId]);
    if (expanded.error) {
      return {
        requestedModel: normalizedRequested,
        resolvedModel: null,
        routeType: "alias",
        routeRef: aliasId,
        primary: null,
        fallbacks: [],
        error: expanded.error
      };
    }

    for (const candidate of (expanded.candidates || [])) {
      const routedCandidate = applyAliasTargetOptions(candidate, target, "fallback");
      if (seen.has(routedCandidate.requestModelId)) continue;
      seen.add(routedCandidate.requestModelId);
      fallbackCandidates.push(routedCandidate);
    }
  }

  const primary = primaryCandidates[0] || null;
  if (!primary) {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      routeType: "alias",
      routeRef: aliasId,
      primary: null,
      fallbacks: [],
      error: `Alias '${aliasId}' has no resolvable target candidates.`
    };
  }

  return {
    requestedModel: normalizedRequested,
    resolvedModel: aliasId,
    routeType: "alias",
    routeRef: aliasId,
    routeStrategy: alias.strategy || "ordered",
    routeMetadata: alias.metadata || undefined,
    primary,
    fallbacks: [...primaryCandidates.slice(1), ...fallbackCandidates]
  };
}

export function resolveRequestedRoute(config, requestedModel, sourceFormat = FORMATS.CLAUDE) {
  const normalizedRequested = typeof requestedModel === "string" && requestedModel.trim()
    ? requestedModel.trim()
    : "smart";
  const defaultModel = config?.defaultModel || "smart";
  const effectiveRequested = normalizedRequested === "smart"
    ? defaultModel
    : normalizedRequested;

  if (effectiveRequested === "smart") {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      routeType: "unknown",
      routeRef: null,
      primary: null,
      fallbacks: [],
      error: "No default model is configured."
    };
  }

  const routingIndex = getRoutingIndex(config);
  const parsed = parseRouteReference(effectiveRequested);
  if (parsed.type === "alias") {
    return resolveAliasRoutePlan(config, parsed.aliasId, normalizedRequested, sourceFormat, routingIndex);
  }

  return resolveDirectRoutePlan(
    config,
    effectiveRequested,
    normalizedRequested,
    sourceFormat,
    routingIndex
  );
}

export function resolveRequestModel(config, requestedModel, sourceFormat = FORMATS.CLAUDE) {
  return resolveRequestedRoute(config, requestedModel, sourceFormat);
}

export function listConfiguredModels(config, { endpointFormat } = {}) {
  const rows = [];
  const now = Date.now();

  for (const provider of (config.providers || [])) {
    if (provider.enabled === false) continue;

    for (const model of (provider.models || [])) {
      if (model.enabled === false) continue;

      rows.push({
        id: `${provider.id}/${model.id}`,
        object: "model",
        created: now,
        owned_by: provider.id,
        provider_id: provider.id,
        provider_name: provider.name,
        formats: (model.formats && model.formats.length > 0) ? model.formats : (provider.formats || []),
        endpoint_format_supported: endpointFormat
          ? ((model.formats && model.formats.length > 0) ? model.formats.includes(endpointFormat) : (provider.formats || []).includes(endpointFormat))
          : undefined,
        context_window: model.contextWindow,
        cost: model.cost,
        model_formats: model.formats || [],
        fallback_models: model.fallbackModels || []
      });
    }
  }

  return rows;
}

export function runtimeConfigFromEnv(env = {}) {
  const rawJson =
    env.LLM_ROUTER_CONFIG_JSON ||
    env.ROUTE_CONFIG_JSON ||
    env.LLM_ROUTER_JSON;
  const overrideMasterKey = typeof env.LLM_ROUTER_MASTER_KEY === "string"
    ? env.LLM_ROUTER_MASTER_KEY
    : "";

  if (!runtimeEnvCache || runtimeEnvCache.rawJson !== rawJson) {
    runtimeEnvCache = {
      rawJson,
      parsed: rawJson
        ? parseRuntimeConfigJson(rawJson, { migrateToVersion: CONFIG_VERSION })
        : normalizeRuntimeConfig({}, { migrateToVersion: CONFIG_VERSION }),
      overrideMasterKey: null,
      resolved: null
    };
  }

  if (
    runtimeEnvCache.resolved &&
    runtimeEnvCache.overrideMasterKey === overrideMasterKey
  ) {
    return runtimeEnvCache.resolved;
  }

  if (!overrideMasterKey) {
    runtimeEnvCache.overrideMasterKey = overrideMasterKey;
    runtimeEnvCache.resolved = runtimeEnvCache.parsed;
    return runtimeEnvCache.resolved;
  }

  runtimeEnvCache.overrideMasterKey = overrideMasterKey;
  runtimeEnvCache.resolved = {
    ...runtimeEnvCache.parsed,
    masterKey: overrideMasterKey
  };
  return runtimeEnvCache.resolved;
}
