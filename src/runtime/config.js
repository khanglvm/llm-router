/**
 * Runtime config helpers for both local Node route and Cloudflare Worker route.
 * Config source is user-managed (e.g. ~/.llm-router.json or LLM_ROUTER_CONFIG_JSON secret).
 */

import { FORMATS } from "../translator/index.js";
import {
  CODEX_SUBSCRIPTION_MODELS,
  CLAUDE_CODE_SUBSCRIPTION_MODELS
} from "./subscription-constants.js";
import { sanitizeRuntimeMetadata } from "../shared/local-router-defaults.js";

export const CONFIG_VERSION = 2;
export const MIN_SUPPORTED_CONFIG_VERSION = 1;
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const DEFAULT_MODEL_ALIAS_ID = "default";
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
const SUBSCRIPTION_PROVIDER_TYPES = Object.freeze({
  CHATGPT_CODEX: "chatgpt-codex",
  CLAUDE_CODE: "claude-code"
});
export const OLLAMA_PROVIDER_TYPE = "ollama";
export const OLLAMA_KEEP_ALIVE_PATTERN = /^(-1|0|\d+(s|m|h))$/;
export const OLLAMA_KEEP_ALIVE_OPTIONS = Object.freeze([
  "5m", "10m", "30m", "1h", "24h", "-1", "0"
]);
const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
const OLLAMA_DEFAULT_KEEP_ALIVE = "5m";
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

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
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

function normalizeBooleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeAmpModelMappingEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const from = String(
    entry.from ??
    entry.match ??
    entry.pattern ??
    entry.model ??
    ""
  ).trim();
  const to = String(
    entry.to ??
    entry.target ??
    entry.route ??
    entry.ref ??
    ""
  ).trim();
  const sourceRouteKey = normalizeAmpRouteKey(
    entry.sourceRouteKey ??
    entry["source-route-key"] ??
    ""
  );

  if (!from || (!to && !sourceRouteKey)) return null;

  return {
    from,
    ...(to ? { to } : {}),
    ...(sourceRouteKey ? { sourceRouteKey } : {})
  };
}

function normalizeAmpIdentifierText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[–—]+/g, "-")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeAmpVersionToken(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, ".")
    .replace(/\s+/g, "");
  if (!text) return "";
  if (/^\d+-\d+$/.test(text)) return text.replace(/-/g, ".");
  return text;
}

function normalizeAmpSignatureKey(value) {
  const text = normalizeAmpIdentifierText(String(value || "").replace(/^@+/, ""));
  if (!text) return "";
  return `@${text}`;
}

function normalizeAmpRouteKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.trim().startsWith("@")) return normalizeAmpSignatureKey(text);
  return normalizeAmpSubagentKey(text);
}

function normalizeAmpRouteMappings(rawMappings) {
  if (rawMappings === undefined || rawMappings === null || rawMappings === "") return undefined;
  const out = {};
  const source = Array.isArray(rawMappings)
    ? rawMappings
    : (typeof rawMappings === "object" && rawMappings !== null
      ? Object.entries(rawMappings).map(([name, to]) => ({ name, to }))
      : []);

  for (const entry of source) {
    if (!entry || typeof entry !== "object") continue;
    const key = normalizeAmpRouteKey(
      entry.id ?? entry.key ?? entry.name ?? entry.agent ?? entry.subagent ?? entry.signature
    );
    const target = String(entry.to ?? entry.target ?? entry.route ?? entry.ref ?? "").trim();
    if (!key || !target) continue;
    out[key] = target;
  }

  return out;
}

function normalizeAmpMatchEntry(entry) {
  if (typeof entry === "string") {
    const text = String(entry || "").trim();
    return text ? text : null;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const vendor = normalizeAmpIdentifierText(entry.vendor);
  const family = normalizeAmpIdentifierText(entry.family);
  const version = normalizeAmpVersionToken(entry.version ?? entry.modelVersion);
  const versionPrefix = normalizeAmpVersionToken(entry.versionPrefix ?? entry.versionStartsWith);
  const variant = normalizeAmpIdentifierText(entry.variant ?? entry.modelVariant);
  const variantPrefix = normalizeAmpIdentifierText(entry.variantPrefix ?? entry.variantStartsWith);
  const modifiers = dedupeStrings(
    toArray(entry.modifiers ?? entry.flags ?? entry.tags)
      .map((value) => normalizeAmpIdentifierText(value))
      .filter(Boolean)
  );
  const normalized = {
    ...(vendor ? { vendor } : {}),
    ...(family ? { family } : {}),
    ...(version ? { version } : {}),
    ...(versionPrefix ? { versionPrefix } : {}),
    ...(variant ? { variant } : {}),
    ...(variantPrefix ? { variantPrefix } : {}),
    ...(modifiers.length > 0 ? { modifiers } : {}),
    ...(normalizeBooleanValue(entry.variantAbsent, false) ? { variantAbsent: true } : {})
  };

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeAmpMatchList(value) {
  return toArray(value)
    .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    .map((entry) => normalizeAmpMatchEntry(entry))
    .filter(Boolean);
}

function normalizeAmpEntityDefinitionEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const id = normalizeAmpSubagentKey(entry.id ?? entry.agent ?? entry.subagent ?? entry.name ?? entry.key);
  const type = normalizeAmpIdentifierText(entry.type ?? entry.kind ?? entry.category);
  const aliases = dedupeStrings(
    toArray(entry.aliases ?? entry.alias)
      .map((value) => normalizeAmpSubagentKey(value))
      .filter(Boolean)
  );
  const match = normalizeAmpMatchList(
    entry.match ?? entry.matches ?? entry.patterns ?? entry.models ?? entry.model ?? entry.pattern
  );
  const signatures = dedupeStrings(
    toArray(entry.signatures ?? entry.signatureIds ?? entry.signature)
      .map((value) => normalizeAmpSignatureKey(value))
      .filter(Boolean)
  );
  const route = String(entry.route ?? entry.to ?? entry.target ?? entry.ref ?? "").trim();
  if (!id) return null;

  return {
    id,
    ...(type ? { type } : {}),
    ...(typeof entry.description === "string" && entry.description.trim()
      ? { description: entry.description.trim() }
      : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(match.length > 0 ? { match } : {}),
    ...(signatures.length > 0 ? { signatures } : {}),
    ...(route ? { route } : {}),
    ...(entry.enabled === false ? { enabled: false } : {})
  };
}

function normalizeAmpSignatureDefinitionEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const id = normalizeAmpSignatureKey(entry.id ?? entry.signature ?? entry.name ?? entry.key);
  const aliases = dedupeStrings(
    toArray(entry.aliases ?? entry.alias)
      .map((value) => normalizeAmpSignatureKey(value))
      .filter(Boolean)
  );
  const match = normalizeAmpMatchList(
    entry.match ?? entry.matches ?? entry.patterns ?? entry.models ?? entry.model ?? entry.pattern
  );
  const route = String(entry.route ?? entry.to ?? entry.target ?? entry.ref ?? "").trim();
  if (!id) return null;

  return {
    id,
    ...(typeof entry.description === "string" && entry.description.trim()
      ? { description: entry.description.trim() }
      : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(match.length > 0 ? { match } : {}),
    ...(route ? { route } : {}),
    ...(entry.enabled === false ? { enabled: false } : {})
  };
}

function normalizeAmpDefinitionList(value, entryNormalizer) {
  if (value === undefined || value === null || value === "") return undefined;
  const entries = Array.isArray(value)
    ? value
    : (typeof value === "object" && value !== null
      ? Object.entries(value).map(([id, entry]) => ({
          ...(entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}),
          id: entry?.id ?? id
        }))
      : []);

  const seen = new Set();
  const out = [];
  for (const entry of entries.map((candidate) => entryNormalizer(candidate)).filter(Boolean)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function normalizeAmpOverrides(rawOverrides) {
  if (rawOverrides === undefined || rawOverrides === null || rawOverrides === "") return undefined;
  const source = rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)
    ? rawOverrides
    : {};
  const entities = normalizeAmpDefinitionList(source.entities, normalizeAmpEntityDefinitionEntry);
  const signatures = normalizeAmpDefinitionList(source.signatures, normalizeAmpSignatureDefinitionEntry);
  if (entities === undefined && signatures === undefined) return undefined;
  return {
    ...(entities !== undefined ? { entities } : {}),
    ...(signatures !== undefined ? { signatures } : {})
  };
}

function normalizeAmpFallbackAction(value) {
  const text = normalizeAmpIdentifierText(value);
  if (!text) return undefined;
  if (["default", "default-route", "defaultroute"].includes(text)) return "default-route";
  if (["default-model", "defaultmodel"].includes(text)) return "default-model";
  if (["upstream", "proxy", "proxy-upstream"].includes(text)) return "upstream";
  if (["none", "disabled", "off"].includes(text)) return "none";
  return undefined;
}

function normalizeAmpFallback(rawFallback) {
  if (rawFallback === undefined || rawFallback === null || rawFallback === "") return undefined;
  const source = rawFallback && typeof rawFallback === "object" && !Array.isArray(rawFallback)
    ? rawFallback
    : {};
  const onUnknown = normalizeAmpFallbackAction(source.onUnknown ?? source["on-unknown"]);
  const onAmbiguous = normalizeAmpFallbackAction(source.onAmbiguous ?? source["on-ambiguous"]);
  const hasProxyFlag = hasOwn(source, "proxyUpstream") || hasOwn(source, "proxy-upstream");
  const proxyUpstream = hasProxyFlag
    ? normalizeBooleanValue(source.proxyUpstream ?? source["proxy-upstream"], true)
    : undefined;
  if (onUnknown === undefined && onAmbiguous === undefined && proxyUpstream === undefined) return undefined;
  return {
    ...(onUnknown ? { onUnknown } : {}),
    ...(onAmbiguous ? { onAmbiguous } : {}),
    ...(proxyUpstream !== undefined ? { proxyUpstream } : {})
  };
}

function normalizeAmpPreset(value) {
  if (value === undefined || value === null) return undefined;
  const text = normalizeAmpIdentifierText(value);
  if (!text) return "builtin";
  if (["default", "builtin", "builtins"].includes(text)) return "builtin";
  if (["none", "disabled", "off"].includes(text)) return "none";
  return text;
}

function normalizeAmpSubagentKey(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (["lookat", "look-at", "look_at", "look at"].includes(text)) return "look-at";
  if (["title", "titling"].includes(text)) return "title";
  return text;
}

function normalizeAmpSubagentMappings(rawMappings) {
  if (rawMappings === undefined || rawMappings === null || rawMappings === "") return {};
  const out = {};
  const source = Array.isArray(rawMappings)
    ? rawMappings
    : (typeof rawMappings === "object" && rawMappings !== null
      ? Object.entries(rawMappings).map(([agent, to]) => ({ agent, to }))
      : []);
  for (const entry of source) {
    if (!entry || typeof entry !== "object") continue;
    const key = normalizeAmpSubagentKey(entry.agent ?? entry.subagent ?? entry.name ?? entry.id);
    const target = String(entry.to ?? entry.target ?? entry.route ?? entry.ref ?? "").trim();
    if (!key || !target) continue;
    out[key] = target;
  }
  return out;
}

function normalizeAmpSubagentDefinitionEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const id = normalizeAmpSubagentKey(entry.id ?? entry.agent ?? entry.subagent ?? entry.name ?? entry.key);
  const patterns = dedupeStrings(toArray(entry.patterns ?? entry.matches ?? entry.models ?? entry.model ?? entry.pattern));
  if (!id || patterns.length === 0) return null;

  return {
    id,
    patterns
  };
}

function normalizeAmpSubagentDefinitions(rawDefinitions) {
  if (rawDefinitions === undefined || rawDefinitions === null || rawDefinitions === "") return undefined;
  if (!Array.isArray(rawDefinitions)) return undefined;

  const seen = new Set();
  const out = [];
  for (const entry of rawDefinitions.map(normalizeAmpSubagentDefinitionEntry).filter(Boolean)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

const AMP_WEB_SEARCH_PROVIDER_IDS = Object.freeze([
  "brave",
  "tavily",
  "exa",
  "searxng"
]);

const AMP_WEB_SEARCH_PROVIDER_DEFAULT_LIMITS = Object.freeze({
  brave: 1000,
  tavily: 1000,
  exa: 1000,
  searxng: 0
});
const AMP_WEB_SEARCH_DEFAULT_COUNT = 5;
const AMP_WEB_SEARCH_MIN_COUNT = 1;
const AMP_WEB_SEARCH_MAX_COUNT = 20;

function looksLikeHostedWebSearchRouteId(value) {
  const text = String(value || "").trim();
  return text.includes("/") && parseRouteReference(text).type === "direct";
}

function buildHostedWebSearchRouteId(providerId, modelId) {
  const normalizedProviderId = String(providerId || "").trim();
  const normalizedModelId = String(modelId || "").trim();
  if (!normalizedProviderId || !normalizedModelId) return "";
  return `${normalizedProviderId}/${normalizedModelId}`;
}

function normalizeHostedWebSearchProviderRoute(entry, explicitId = "") {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const explicitRouteId = String(explicitId || "").trim();
  const providerId = String(
    entry.providerId
    ?? entry.provider
    ?? entry.routeProviderId
    ?? entry["provider-id"]
    ?? ""
  ).trim();
  const modelId = String(
    entry.model
    ?? entry.modelId
    ?? entry.routeModelId
    ?? entry["model-id"]
    ?? ""
  ).trim();
  const routeId = String(
    explicitRouteId
    || entry.id
    || buildHostedWebSearchRouteId(providerId, modelId)
  ).trim();
  if (!looksLikeHostedWebSearchRouteId(routeId)) return null;

  const parsed = parseRouteReference(routeId);
  if (parsed.type !== "direct") return null;
  const normalizedProviderId = providerId || parsed.providerId;
  const normalizedModelId = modelId || parsed.modelId;
  const normalizedRouteId = buildHostedWebSearchRouteId(normalizedProviderId, normalizedModelId);
  if (!normalizedRouteId || normalizedRouteId !== routeId) return null;

  return {
    id: normalizedRouteId,
    providerId: normalizedProviderId,
    model: normalizedModelId
  };
}

function normalizeAmpWebSearchProviderId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return AMP_WEB_SEARCH_PROVIDER_IDS.includes(normalized) ? normalized : "";
}

function normalizeAmpWebSearchStrategy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "ordered";
  if (normalized === "quota-balance" || normalized === "quota-balanced") return "quota-balance";
  if (normalized === "quota-aware-weighted-rr") return "quota-balance";
  return "ordered";
}

function parseNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function parseAmpWebSearchCount(value, fallback = AMP_WEB_SEARCH_DEFAULT_COUNT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(AMP_WEB_SEARCH_MAX_COUNT, Math.max(AMP_WEB_SEARCH_MIN_COUNT, Math.floor(parsed)));
}

function hasOwnWebSearchProviderField(entry, keys = []) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(entry, key) && entry[key] !== undefined && entry[key] !== null && String(entry[key]).trim() !== "");
}

function normalizeAmpWebSearchProviderEntry(entry, explicitId = "", { preserveUnconfigured = true, inheritedCount = AMP_WEB_SEARCH_DEFAULT_COUNT } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const hostedRoute = normalizeHostedWebSearchProviderRoute(entry, explicitId);
  if (hostedRoute) return hostedRoute;

  const id = normalizeAmpWebSearchProviderId(
    explicitId
    || entry.id
    || entry.provider
    || entry.backend
    || entry.name
  );
  if (!id) return null;

  const apiKey = String(
    entry.apiKey
    ?? entry["api-key"]
    ?? entry.key
    ?? ""
  ).trim();
  const url = sanitizeEndpointUrl(
    entry.url
    ?? entry.baseUrl
    ?? entry["base-url"]
    ?? entry.searxngUrl
    ?? entry["searxng-url"]
    ?? ""
  ).replace(/\/+$/, "");
  const hasExplicitCount = hasOwnWebSearchProviderField(entry, ["count", "resultCount", "result-count", "resultsPerCall", "results-per-call"]);
  const hasExplicitLimit = hasOwnWebSearchProviderField(entry, ["limit", "monthlyLimit", "monthly-limit", "quota"]);
  const hasExplicitRemaining = hasOwnWebSearchProviderField(entry, ["remaining", "remainingQuota", "remaining-quota", "remainingQueries", "remaining-queries"]);
  const hasCredential = id === "searxng" ? Boolean(url) : Boolean(apiKey);
  if (!preserveUnconfigured && !hasCredential && !hasExplicitCount && !hasExplicitLimit && !hasExplicitRemaining) {
    return null;
  }

  const count = parseAmpWebSearchCount(
    entry.count
    ?? entry.resultCount
    ?? entry["result-count"]
    ?? entry.resultsPerCall
    ?? entry["results-per-call"],
    inheritedCount
  );
  const includeQuotaDefaults = hasCredential || hasExplicitLimit || hasExplicitRemaining;
  const limitFallback = includeQuotaDefaults ? (AMP_WEB_SEARCH_PROVIDER_DEFAULT_LIMITS[id] || 0) : 0;
  const limit = parseNonNegativeInteger(
    entry.limit
    ?? entry.monthlyLimit
    ?? entry["monthly-limit"]
    ?? entry.quota
    ?? limitFallback,
    limitFallback
  );
  const remainingFallback = limit > 0 ? limit : 0;
  const remaining = parseNonNegativeInteger(
    entry.remaining
    ?? entry.remainingQuota
    ?? entry["remaining-quota"]
    ?? entry.remainingQueries
    ?? entry["remaining-queries"]
    ?? remainingFallback,
    remainingFallback
  );

  const normalizedEntry = {
    id,
    ...(id === "searxng"
      ? (url ? { url } : {})
      : (apiKey ? { apiKey } : {})),
    ...(count !== AMP_WEB_SEARCH_DEFAULT_COUNT ? { count } : {}),
    ...(hasExplicitLimit || (includeQuotaDefaults && limit > 0) ? { limit } : {}),
    ...(hasExplicitRemaining || (includeQuotaDefaults && (limit > 0 || remaining > 0))
      ? { remaining: limit > 0 ? Math.min(remaining, limit) : remaining }
      : {})
  };

  return normalizedEntry;
}

function normalizeAmpWebSearchProviders(rawProviders, rawWebSearch = {}) {
  const inheritedCount = parseAmpWebSearchCount(rawWebSearch.count, AMP_WEB_SEARCH_DEFAULT_COUNT);
  if (Array.isArray(rawProviders)) {
    const ordered = [];
    const seen = new Set();
    for (const entry of rawProviders) {
      const normalized = normalizeAmpWebSearchProviderEntry(entry, "", {
        preserveUnconfigured: true,
        inheritedCount
      });
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      ordered.push(normalized);
    }
    return ordered;
  }

  if (rawProviders && typeof rawProviders === "object") {
    const ordered = [];
    const seen = new Set();
    for (const [providerId, entry] of Object.entries(rawProviders)) {
      const normalized = normalizeAmpWebSearchProviderEntry(entry, providerId, {
        preserveUnconfigured: true,
        inheritedCount
      });
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      ordered.push(normalized);
    }
    return ordered;
  }

  const legacyPreferredBackend = normalizeAmpWebSearchProviderId(
    rawWebSearch.preferredBackend ?? rawWebSearch["preferred-backend"]
  );
  const legacyEntries = [
    normalizeAmpWebSearchProviderEntry({
      apiKey: rawWebSearch.braveApiKey ?? rawWebSearch["brave-api-key"],
      count: rawWebSearch.count,
      limit: rawWebSearch.braveMonthlyLimit ?? rawWebSearch["brave-monthly-limit"],
      remaining: rawWebSearch.braveRemaining ?? rawWebSearch["brave-remaining"]
    }, "brave", { preserveUnconfigured: false, inheritedCount }),
    normalizeAmpWebSearchProviderEntry({
      apiKey: rawWebSearch.tavilyApiKey ?? rawWebSearch["tavily-api-key"],
      count: rawWebSearch.count,
      limit: rawWebSearch.tavilyMonthlyLimit ?? rawWebSearch["tavily-monthly-limit"],
      remaining: rawWebSearch.tavilyRemaining ?? rawWebSearch["tavily-remaining"]
    }, "tavily", { preserveUnconfigured: false, inheritedCount }),
    normalizeAmpWebSearchProviderEntry({
      apiKey: rawWebSearch.exaApiKey ?? rawWebSearch["exa-api-key"],
      count: rawWebSearch.count,
      limit: rawWebSearch.exaMonthlyLimit ?? rawWebSearch["exa-monthly-limit"],
      remaining: rawWebSearch.exaRemaining ?? rawWebSearch["exa-remaining"]
    }, "exa", { preserveUnconfigured: false, inheritedCount }),
    normalizeAmpWebSearchProviderEntry({
      count: rawWebSearch.count,
      url: rawWebSearch.searxngUrl ?? rawWebSearch["searxng-url"] ?? rawWebSearch.url
    }, "searxng", { preserveUnconfigured: false, inheritedCount })
  ].filter(Boolean);

  if (!legacyPreferredBackend) return legacyEntries;

  return [
    ...legacyEntries.filter((entry) => entry.id === legacyPreferredBackend),
    ...legacyEntries.filter((entry) => entry.id !== legacyPreferredBackend)
  ];
}

function normalizeAmpWebSearchConfig(rawWebSearch) {
  if (!rawWebSearch || typeof rawWebSearch !== "object" || Array.isArray(rawWebSearch)) return undefined;

  const providers = normalizeAmpWebSearchProviders(rawWebSearch.providers, rawWebSearch);
  const count = parseAmpWebSearchCount(rawWebSearch.count, AMP_WEB_SEARCH_DEFAULT_COUNT);

  return {
    strategy: normalizeAmpWebSearchStrategy(rawWebSearch.strategy),
    count,
    providers,
    interceptInternalSearch: normalizeBooleanValue(
      rawWebSearch.interceptInternalSearch ?? rawWebSearch["intercept-internal-search"],
      false
    )
  };
}

function supportsOpenAIHostedWebSearchRoute(provider, model) {
  const providerFormats = dedupeStrings([...(provider?.formats || []), provider?.format]);
  if (!providerFormats.includes(FORMATS.OPENAI)) return false;

  const modelId = String(model?.id || "").trim();
  const preferredFormat = modelId
    ? String(provider?.lastProbe?.modelPreferredFormat?.[modelId] || "").trim()
    : "";
  if (preferredFormat) {
    return preferredFormat === FORMATS.OPENAI;
  }

  const probedFormats = modelId
    ? dedupeStrings(provider?.lastProbe?.modelSupport?.[modelId] || [])
    : [];
  if (probedFormats.length > 0) {
    return probedFormats.includes(FORMATS.OPENAI);
  }

  const modelFormats = dedupeStrings([...(model?.formats || []), model?.format]);
  return modelFormats.length === 0 || modelFormats.includes(FORMATS.OPENAI);
}

function normalizeAmpConfig(rawAmp) {
  const source = rawAmp && typeof rawAmp === "object" && !Array.isArray(rawAmp)
    ? rawAmp
    : {};
  const hasProxyWebSearchToUpstream = hasOwn(source, "proxyWebSearchToUpstream") || hasOwn(source, "proxy-web-search-to-upstream");
  const hasPreset = hasOwn(source, "preset");
  const hasDefaultRoute = hasOwn(source, "defaultRoute") || hasOwn(source, "default-route");
  const hasRoutes = hasOwn(source, "routes");
  const hasRawModelRoutes = hasOwn(source, "rawModelRoutes") || hasOwn(source, "raw-model-routes");
  const hasOverrides = hasOwn(source, "overrides");
  const hasFallback = hasOwn(source, "fallback");
  const hasWebSearch = hasOwn(source, "webSearch")
    || hasOwn(source, "web-search")
    || [
      "preferredBackend",
      "preferred-backend",
      "count",
      "braveApiKey",
      "brave-api-key",
      "tavilyApiKey",
      "tavily-api-key",
      "exaApiKey",
      "exa-api-key",
      "searxngUrl",
      "searxng-url",
      "braveMonthlyLimit",
      "brave-monthly-limit",
      "tavilyMonthlyLimit",
      "tavily-monthly-limit",
      "exaMonthlyLimit",
      "exa-monthly-limit",
      "braveRemaining",
      "brave-remaining",
      "tavilyRemaining",
      "tavily-remaining",
      "exaRemaining",
      "exa-remaining"
    ].some((key) => hasOwn(source, key));
  const normalizedSubagentDefinitions = normalizeAmpSubagentDefinitions(
    source.subagentDefinitions ?? source["subagent-definitions"]
  );
  const normalizedPreset = normalizeAmpPreset(source.preset);
  const normalizedDefaultRoute = String(source.defaultRoute ?? source["default-route"] ?? "").trim();
  const normalizedRoutes = normalizeAmpRouteMappings(source.routes);
  const normalizedRawModelRoutes = toArray(
    source.rawModelRoutes ?? source["raw-model-routes"]
  )
    .map(normalizeAmpModelMappingEntry)
    .filter(Boolean);
  const normalizedOverrides = normalizeAmpOverrides(source.overrides);
  const normalizedFallback = normalizeAmpFallback(source.fallback);
  const normalizedWebSearch = normalizeAmpWebSearchConfig(source.webSearch ?? source["web-search"] ?? source);

  return {
    upstreamUrl: sanitizeEndpointUrl(
      source.upstreamUrl ??
      source["upstream-url"] ??
      source.baseUrl ??
      source["base-url"] ??
      ""
    ),
    upstreamApiKey: String(
      source.upstreamApiKey ??
      source["upstream-api-key"] ??
      ""
    ).trim() || undefined,
    restrictManagementToLocalhost: normalizeBooleanValue(
      source.restrictManagementToLocalhost ?? source["restrict-management-to-localhost"],
      false
    ),
    forceModelMappings: normalizeBooleanValue(
      source.forceModelMappings ?? source["force-model-mappings"],
      false
    ),
    ...(hasProxyWebSearchToUpstream
      ? {
          proxyWebSearchToUpstream: normalizeBooleanValue(
            source.proxyWebSearchToUpstream ?? source["proxy-web-search-to-upstream"],
            false
          )
        }
      : {}),
    modelMappings: toArray(
      source.modelMappings ?? source["model-mappings"]
    )
      .map(normalizeAmpModelMappingEntry)
      .filter(Boolean),
    subagentMappings: normalizeAmpSubagentMappings(
      source.subagentMappings ?? source["subagent-mappings"]
    ),
    ...(hasPreset
      ? {
          preset: normalizedPreset
        }
      : {}),
    ...(hasDefaultRoute
      ? {
          defaultRoute: normalizedDefaultRoute
        }
      : {}),
    ...(hasRoutes
      ? {
          routes: normalizedRoutes || {}
        }
      : {}),
    ...(hasRawModelRoutes
      ? {
          rawModelRoutes: normalizedRawModelRoutes
        }
      : {}),
    ...(hasOverrides && normalizedOverrides !== undefined
      ? {
          overrides: normalizedOverrides
        }
      : {}),
    ...(hasFallback && normalizedFallback !== undefined
      ? {
          fallback: normalizedFallback
        }
      : {}),
    ...(hasWebSearch && normalizedWebSearch !== undefined
      ? {
          webSearch: normalizedWebSearch
        }
      : {}),
    ...(normalizedSubagentDefinitions !== undefined
      ? {
          subagentDefinitions: normalizedSubagentDefinitions
        }
      : {})
  };
}

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseAmpModelPattern(pattern) {
  const text = String(pattern || "").trim();
  if (!text) return null;

  if (text.startsWith("/") && text.lastIndexOf("/") > 0) {
    const endIndex = text.lastIndexOf("/");
    const source = text.slice(1, endIndex);
    const flags = text.slice(endIndex + 1);
    try {
      return new RegExp(source, flags);
    } catch {
      return null;
    }
  }

  if (text.includes("*")) {
    return new RegExp(`^${escapeRegex(text).replace(/\\\*/g, ".*")}$`);
  }

  return null;
}

function canonicalizeAmpModelText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("/") && text.lastIndexOf("/") > 0) return text;

  return text
    .toLowerCase()
    .replace(/[–—]+/g, "-")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\bclaude-(opus|sonnet|haiku)-(\d+)-(\d+)\b/g, "claude-$1-$2.$3")
    .replace(/\b(opus|sonnet|haiku)-(\d+)-(\d+)\b/g, "$1-$2.$3")
    .replace(/\bgpt-(\d+)-(\d+)(?=$|[-])\b/g, "gpt-$1.$2")
    .replace(/\bgemini-(\d+)-(\d+)(?=-)\b/g, "gemini-$1.$2")
    .replace(/^-+|-+$/g, "");
}

function isAmpVersionToken(value) {
  const text = normalizeAmpVersionToken(value);
  return /^\d+(?:\.\d+)?$/.test(text);
}

function parseAmpModelDescriptor(value) {
  const raw = String(value || "").trim();
  const canonical = canonicalizeAmpModelText(raw);
  const tokens = canonical
    .split(/[\/-]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const descriptor = {
    raw,
    canonical,
    vendor: "",
    family: "",
    version: "",
    variant: "",
    variantChain: "",
    modifiers: []
  };

  if (tokens.length === 0) return descriptor;

  if (tokens[0] === "claude" || ["opus", "sonnet", "haiku"].includes(tokens[0])) {
    descriptor.vendor = "anthropic";
    let cursor = tokens[0] === "claude" ? 1 : 0;
    descriptor.family = tokens[cursor] || "";
    cursor += 1;
    if (isAmpVersionToken(tokens[cursor])) {
      descriptor.version = normalizeAmpVersionToken(tokens[cursor]);
      cursor += 1;
    } else if (/^\d+$/.test(tokens[cursor] || "") && /^\d+$/.test(tokens[cursor + 1] || "")) {
      descriptor.version = `${tokens[cursor]}.${tokens[cursor + 1]}`;
      cursor += 2;
    }
    const rest = tokens.slice(cursor);
    descriptor.variant = rest[0] || "";
    descriptor.variantChain = rest.join("-");
    descriptor.modifiers = rest.slice(1);
    return descriptor;
  }

  if (tokens[0] === "gpt") {
    descriptor.vendor = "openai";
    descriptor.family = "gpt";
    let cursor = 1;
    if (isAmpVersionToken(tokens[cursor])) {
      descriptor.version = normalizeAmpVersionToken(tokens[cursor]);
      cursor += 1;
    }
    const rest = tokens.slice(cursor);
    descriptor.variant = rest[0] || "";
    descriptor.variantChain = rest.join("-");
    descriptor.modifiers = rest.slice(1);
    return descriptor;
  }

  if (tokens[0] === "gemini") {
    descriptor.vendor = "google";
    descriptor.family = "gemini";
    let cursor = 1;
    if (isAmpVersionToken(tokens[cursor])) {
      descriptor.version = normalizeAmpVersionToken(tokens[cursor]);
      cursor += 1;
    }
    const rest = tokens.slice(cursor);
    descriptor.variant = rest[0] || "";
    descriptor.variantChain = rest.join("-");
    descriptor.modifiers = rest.slice(1);
    return descriptor;
  }

  return descriptor;
}

function matchAmpModelSelector(selector, value, descriptor = parseAmpModelDescriptor(value)) {
  if (typeof selector === "string") return matchAmpModelPattern(selector, value);
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) return false;

  if (selector.vendor && selector.vendor !== descriptor.vendor) return false;
  if (selector.family && selector.family !== descriptor.family) return false;
  if (selector.version && selector.version !== descriptor.version) return false;
  if (selector.versionPrefix && !String(descriptor.version || "").startsWith(selector.versionPrefix)) return false;
  if (selector.variant && selector.variant !== descriptor.variant) return false;
  if (selector.variantPrefix && !String(descriptor.variantChain || "").startsWith(selector.variantPrefix)) return false;
  if (selector.variantAbsent === true && descriptor.variantChain) return false;
  if (Array.isArray(selector.modifiers) && selector.modifiers.some((modifier) => !descriptor.modifiers.includes(modifier))) return false;

  return true;
}

function matchAmpModelPattern(pattern, value) {
  const normalizedValue = String(value || "").trim();
  const normalizedPattern = String(pattern || "").trim();
  if (!normalizedPattern || !normalizedValue) return false;

  const valueCandidates = dedupeStrings([
    normalizedValue,
    canonicalizeAmpModelText(normalizedValue)
  ]);
  const patternCandidates = normalizedPattern.startsWith("/") && normalizedPattern.lastIndexOf("/") > 0
    ? [normalizedPattern]
    : dedupeStrings([
        normalizedPattern,
        canonicalizeAmpModelText(normalizedPattern)
      ]);

  for (const candidatePattern of patternCandidates) {
    if (valueCandidates.includes(candidatePattern)) return true;
    const regex = parseAmpModelPattern(candidatePattern);
    if (regex && valueCandidates.some((candidateValue) => regex.test(candidateValue))) return true;
  }

  return false;
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
    entry["window.unit"] ??
    entry.windowUnit ??
    entry["window-unit"];
  const sizeRaw =
    entry.window?.size ??
    entry.window?.value ??
    entry["window.size"] ??
    entry["window.value"] ??
    entry.windowSize ??
    entry["window-size"];
  const requestsRaw =
    entry.requests ??
    entry.limit ??
    entry["requests-per-window"];
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
    requests: parsePositiveInteger(requestsRaw),
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

// Keep in sync with CAPABILITY_DEFINITIONS in src/node/web-console-ui/capability-utils.js
const MODEL_CAPABILITY_KEYS = [
  "supportsReasoning", "supportsThinking", "supportsResponseFormat",
  "supportsLogprobs", "supportsServiceTier", "supportsPrediction",
  "supportsStreamOptions"
];

function normalizeModelCapabilities(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const result = {};
  let hasAny = false;
  for (const key of MODEL_CAPABILITY_KEYS) {
    if (typeof raw[key] === "boolean") {
      result[key] = raw[key];
      hasAny = true;
    }
  }
  return hasAny ? result : undefined;
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
  const capabilities = normalizeModelCapabilities(model.capabilities);
  return {
    id,
    aliases: dedupeStrings(model.aliases || model.alias || []),
    formats: dedupeStrings(model.formats || model.format || [])
      .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE),
    enabled: model.enabled !== false,
    variant: typeof model.variant === "string" ? model.variant.trim() : undefined,
    contextWindow: Number.isFinite(model.contextWindow) ? Number(model.contextWindow) : undefined,
    cost: model.cost,
    metadata: model.metadata && typeof model.metadata === "object" ? model.metadata : undefined,
    ...(rawFallbacks !== undefined ? { fallbackModels } : {}),
    ...(capabilities ? { capabilities } : {})
  };
}

function normalizeSubscriptionModels(models, subscriptionType) {
  const normalizedModels = toArray(models)
    .map(normalizeModelEntry)
    .filter(Boolean)
    .filter((item) => item.enabled !== false);

  const defaultModelsByType = {
    [SUBSCRIPTION_PROVIDER_TYPES.CHATGPT_CODEX]: CODEX_SUBSCRIPTION_MODELS,
    [SUBSCRIPTION_PROVIDER_TYPES.CLAUDE_CODE]: CLAUDE_CODE_SUBSCRIPTION_MODELS
  };
  const defaultModels = defaultModelsByType[subscriptionType];
  if (!defaultModels) return normalizedModels;
  if (normalizedModels.length > 0) return normalizedModels;
  return defaultModels.map((modelId) => ({ id: modelId }));
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

function normalizeOllamaManagedModel(entry) {
  if (!entry || typeof entry !== "object") return { keepAlive: OLLAMA_DEFAULT_KEEP_ALIVE, pinned: false, autoLoad: false };
  const keepAlive = typeof entry.keepAlive === "string" && OLLAMA_KEEP_ALIVE_PATTERN.test(entry.keepAlive)
    ? entry.keepAlive : OLLAMA_DEFAULT_KEEP_ALIVE;
  const contextLength = Number.isFinite(entry.contextLength) && entry.contextLength > 0
    ? Math.round(entry.contextLength) : undefined;
  return {
    keepAlive,
    contextLength,
    pinned: entry.pinned === true,
    autoLoad: entry.autoLoad === true
  };
}

export function normalizeOllamaConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { enabled: false, baseUrl: OLLAMA_DEFAULT_BASE_URL, autoConnect: true, defaultKeepAlive: OLLAMA_DEFAULT_KEEP_ALIVE, managedModels: {}, autoLoadModels: [] };
  }
  const baseUrl = sanitizeEndpointUrl(raw.baseUrl || raw["base-url"] || OLLAMA_DEFAULT_BASE_URL)
    || OLLAMA_DEFAULT_BASE_URL;
  const defaultKeepAlive = typeof raw.defaultKeepAlive === "string" && OLLAMA_KEEP_ALIVE_PATTERN.test(raw.defaultKeepAlive)
    ? raw.defaultKeepAlive : OLLAMA_DEFAULT_KEEP_ALIVE;
  const managedModels = {};
  if (raw.managedModels && typeof raw.managedModels === "object" && !Array.isArray(raw.managedModels)) {
    for (const [modelId, entry] of Object.entries(raw.managedModels)) {
      if (typeof modelId === "string" && modelId.trim()) {
        managedModels[modelId.trim()] = normalizeOllamaManagedModel(entry);
      }
    }
  }
  const autoLoadModels = dedupeStrings(toArray(raw.autoLoadModels || raw["auto-load-models"]));
  return {
    enabled: raw.enabled !== false,
    baseUrl,
    autoConnect: raw.autoConnect !== false,
    defaultKeepAlive,
    managedModels,
    autoLoadModels
  };
}

function normalizeProvider(provider, index = 0) {
  if (!provider || typeof provider !== "object") return null;

  const name = provider.name || provider.id || `provider-${index + 1}`;
  const id = slugifyId(provider.id || provider.name || `provider-${index + 1}`);
  const providerType = provider.type || null;
  const isSubscription = providerType === "subscription";
  const isOllama = providerType === OLLAMA_PROVIDER_TYPE;

  // Subscription-specific fields
  const subscriptionType = isSubscription ? (provider.subscriptionType || provider.subscription_type || null) : null;
  const subscriptionProfile = isSubscription ? (provider.subscriptionProfile || provider.subscription_profile || id) : null;
  
  const baseUrlByFormat = normalizeBaseUrlByFormat(
    provider.baseUrlByFormat ||
    provider["base-url-by-format"] ||
    provider.endpointByFormat ||
    provider["endpoint-by-format"] ||
    provider.endpoints
  );
  
  // Subscription providers have a fixed endpoint, so baseUrl is optional
  // Ollama defaults to localhost:11434/v1 for OpenAI compat
  const ollamaDefaultUrl = OLLAMA_DEFAULT_BASE_URL + "/v1";
  const explicitBaseUrl = sanitizeEndpointUrl(
    provider.baseUrl || provider["base-url"] || provider.endpoint || (isOllama ? ollamaDefaultUrl : "")
  );
    
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
    
  // Subscription providers have type-specific target formats.
  const defaultSubscriptionFormat = subscriptionType === SUBSCRIPTION_PROVIDER_TYPES.CLAUDE_CODE
    ? FORMATS.CLAUDE
    : FORMATS.OPENAI;
  const defaultFormat = isSubscription ? defaultSubscriptionFormat
    : isOllama ? FORMATS.OPENAI
    : (orderedFormats[0] || FORMATS.OPENAI);
  
  const baseUrl = explicitBaseUrl
    || (preferredFormat && baseUrlByFormat?.[preferredFormat])
    || (baseUrlByFormat?.[orderedFormats[0]])
    || baseUrlByFormat?.[FORMATS.OPENAI]
    || baseUrlByFormat?.[FORMATS.CLAUDE]
    || "";

  const normalizedModels = isSubscription
    ? normalizeSubscriptionModels(provider.models, subscriptionType)
    : toArray(provider.models)
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

  const baseConfig = {
    id,
    name,
    type: providerType,
    enabled: provider.enabled !== false,
    baseUrl,
    baseUrlByFormat,
    apiKey: isOllama ? (typeof provider.apiKey === "string" ? provider.apiKey : "ollama")
      : (typeof provider.apiKey === "string" ? provider.apiKey : (typeof provider.credential === "string" ? provider.credential : undefined)),
    apiKeyEnv: typeof provider.apiKeyEnv === "string" ? provider.apiKeyEnv : undefined,
    format: preferredFormat || defaultFormat,
    formats: orderedFormats.length > 0 ? orderedFormats : [defaultFormat],
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
  
  // Add subscription-specific fields
  if (isSubscription) {
    baseConfig.subscriptionType = subscriptionType;
    baseConfig.subscriptionProfile = subscriptionProfile;
  }
  
  return baseConfig;
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

function buildDefaultModelAlias(defaultModel, aliases = {}) {
  const existingDefault = aliases?.[DEFAULT_MODEL_ALIAS_ID];
  if (existingDefault && typeof existingDefault === "object" && !Array.isArray(existingDefault)) {
    return {
      ...existingDefault,
      id: DEFAULT_MODEL_ALIAS_ID,
      strategy: String(existingDefault.strategy || "ordered").trim().toLowerCase() || "ordered",
      targets: dedupeAliasTargets(existingDefault.targets || []),
      fallbackTargets: dedupeAliasTargets(existingDefault.fallbackTargets || [])
    };
  }

  const configuredDefault = String(defaultModel || "").trim();
  if (!configuredDefault || configuredDefault === "smart") {
    return {
      id: DEFAULT_MODEL_ALIAS_ID,
      strategy: "ordered",
      targets: [],
      fallbackTargets: []
    };
  }

  const parsed = parseRouteReference(configuredDefault);
  if (parsed.type === "alias" && aliases?.[parsed.aliasId]) {
    const aliasedDefault = aliases[parsed.aliasId];
    return {
      ...aliasedDefault,
      id: DEFAULT_MODEL_ALIAS_ID,
      strategy: String(aliasedDefault.strategy || "ordered").trim().toLowerCase() || "ordered",
      targets: dedupeAliasTargets(aliasedDefault.targets || []),
      fallbackTargets: dedupeAliasTargets(aliasedDefault.fallbackTargets || [])
    };
  }

  return {
    id: DEFAULT_MODEL_ALIAS_ID,
    strategy: "ordered",
    targets: dedupeAliasTargets([{ ref: configuredDefault }]),
    fallbackTargets: []
  };
}

function ensureDefaultModelAlias(defaultModel, aliases = {}) {
  const nextAliases = {
    ...(aliases && typeof aliases === "object" && !Array.isArray(aliases) ? aliases : {})
  };
  nextAliases[DEFAULT_MODEL_ALIAS_ID] = buildDefaultModelAlias(defaultModel, nextAliases);
  return nextAliases;
}

function hasV2ConfigFields(raw, providers, modelAliases) {
  if (Object.keys(modelAliases || {}).length > 0) return true;
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
  const rawDefaultModel = typeof raw.defaultModel === "string"
    ? raw.defaultModel
    : (typeof raw["default-model"] === "string" ? raw["default-model"] : undefined);
  const modelAliases = ensureDefaultModelAlias(rawDefaultModel, modelAliasResult.aliases);

  const masterKey = typeof raw.masterKey === "string"
    ? raw.masterKey
    : (typeof raw["master-key"] === "string" ? raw["master-key"] : undefined);

  const defaultModel = rawDefaultModel;
  const rawAmp = raw.amp ?? raw.ampcode ?? raw["amp-code"];
  const rawAmpObject = rawAmp && typeof rawAmp === "object" && !Array.isArray(rawAmp)
    ? rawAmp
    : {};
  const rawWebSearch = raw.webSearch ?? raw["web-search"];
  const amp = normalizeAmpConfig(rawAmp);
  const webSearch = normalizeAmpWebSearchConfig(rawWebSearch)
    ?? (amp?.webSearch && typeof amp.webSearch === "object" && !Array.isArray(amp.webSearch)
      ? amp.webSearch
      : undefined);
  const normalizedAmp = webSearch && amp?.webSearch && typeof amp.webSearch === "object" && !Array.isArray(amp.webSearch)
    ? Object.fromEntries(
        Object.entries(amp).filter(([key]) => key !== "webSearch")
      )
    : amp;

  const ollama = normalizeOllamaConfig(raw.ollama);

  const normalized = {
    version: inferNormalizedConfigVersion(raw, providers, modelAliases),
    masterKey,
    defaultModel,
    providers,
    modelAliases,
    amp: normalizedAmp,
    ...(webSearch ? { webSearch } : {}),
    ollama,
    metadata: sanitizeRuntimeMetadata(raw.metadata)
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

function getDefaultRouteReference(config, routingIndex = getRoutingIndex(config)) {
  if (routingIndex?.aliasById?.has(DEFAULT_MODEL_ALIAS_ID)) {
    return DEFAULT_MODEL_ALIAS_ID;
  }
  return String(config?.defaultModel || "").trim();
}

function getSmartRouteReference(config, routingIndex = getRoutingIndex(config)) {
  if (routingIndex?.aliasById?.has("smart")) {
    return "smart";
  }
  return getDefaultRouteReference(config, routingIndex);
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

function validateAmpRouteReference(ref, routingIndex, errors, context) {
  const parsed = parseRouteReference(ref);
  if (parsed.type === "invalid") {
    errors.push(`${context} has invalid ref '${ref}'.`);
    return;
  }
  if (parsed.type === "direct") {
    const resolved = routingIndex.modelByRef.get(parsed.ref) || routingIndex.modelByAliasRef.get(parsed.ref);
    if (!resolved) errors.push(`${context} references unknown model '${parsed.ref}'.`);
    return;
  }
  if (!routingIndex.aliasById.has(parsed.aliasId)) {
    errors.push(`${context} references unknown alias '${parsed.aliasId}'.`);
  }
}

function validateAmpConfig(config, routingIndex, errors) {
  const amp = config?.amp;
  if (!amp || typeof amp !== "object") return;

  if (amp.defaultRoute) {
    validateAmpRouteReference(String(amp.defaultRoute), routingIndex, errors, "AMP defaultRoute");
  }

  for (const [key, ref] of Object.entries(amp.routes && typeof amp.routes === "object" ? amp.routes : {})) {
    if (!ref) continue;
    validateAmpRouteReference(String(ref), routingIndex, errors, `AMP route '${key}'`);
  }

  for (const mapping of (Array.isArray(amp.rawModelRoutes) ? amp.rawModelRoutes : [])) {
    if (!mapping?.to) continue;
    validateAmpRouteReference(String(mapping.to), routingIndex, errors, `AMP rawModelRoute '${mapping.from || "(match)"}'`);
  }

  for (const entry of (amp?.overrides?.entities || [])) {
    if (!entry?.route) continue;
    validateAmpRouteReference(String(entry.route), routingIndex, errors, `AMP override entity '${entry.id || "(unknown)"}'`);
  }

  for (const entry of (amp?.overrides?.signatures || [])) {
    if (!entry?.route) continue;
    validateAmpRouteReference(String(entry.route), routingIndex, errors, `AMP override signature '${entry.id || "(unknown)"}'`);
  }

  const webSearch = config?.webSearch ?? amp?.webSearch;
  if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) {
    if (!["ordered", "quota-balance"].includes(String(webSearch.strategy || "ordered").trim())) {
      errors.push(`webSearch has unsupported strategy '${webSearch.strategy}'.`);
    }

    const providers = Array.isArray(webSearch.providers) ? webSearch.providers : [];
    const seenProviderIds = new Set();
    for (const provider of providers) {
      const providerId = String(provider?.id || "").trim();
      if (!providerId) {
        errors.push("webSearch provider is missing id.");
        continue;
      }
      if (seenProviderIds.has(providerId)) {
        errors.push(`webSearch provider '${providerId}' is duplicated.`);
      } else {
        seenProviderIds.add(providerId);
      }

      if (AMP_WEB_SEARCH_PROVIDER_IDS.includes(providerId)) {
        const count = provider?.count;
        if (count !== undefined && (!Number.isFinite(Number(count)) || Number(count) < AMP_WEB_SEARCH_MIN_COUNT || Number(count) > AMP_WEB_SEARCH_MAX_COUNT)) {
          errors.push(`webSearch provider '${providerId}' has invalid count '${count}'.`);
        }

        const limit = provider?.limit;
        if (limit !== undefined && (!Number.isFinite(Number(limit)) || Number(limit) < 0)) {
          errors.push(`webSearch provider '${providerId}' has invalid limit '${limit}'.`);
        }

        const remaining = provider?.remaining;
        if (remaining !== undefined && (!Number.isFinite(Number(remaining)) || Number(remaining) < 0)) {
          errors.push(`webSearch provider '${providerId}' has invalid remaining '${remaining}'.`);
        }
        if (
          remaining !== undefined
          && Number.isFinite(Number(limit))
          && Number(limit) > 0
          && Number(remaining) > Number(limit)
        ) {
          errors.push(`webSearch provider '${providerId}' remaining cannot exceed limit.`);
        }
        continue;
      }

      const hostedRoute = normalizeHostedWebSearchProviderRoute(provider, providerId);
      if (!hostedRoute) {
        errors.push(`webSearch provider '${providerId}' is unsupported.`);
        continue;
      }

      const resolvedRoute = resolveRouteReference(config, hostedRoute.id);
      if (!resolvedRoute?.provider || !resolvedRoute?.model) {
        errors.push(`webSearch provider '${providerId}' does not reference a configured provider/model route.`);
        continue;
      }

      if (!supportsOpenAIHostedWebSearchRoute(resolvedRoute.provider, resolvedRoute.model)) {
        errors.push(`webSearch provider '${providerId}' must reference an OpenAI-compatible provider/model route.`);
      }
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
    const isSubscriptionProvider = provider?.type === "subscription";
    if (!provider.id) errors.push("Provider missing id.");
    if (provider.id && !PROVIDER_ID_PATTERN.test(provider.id)) {
      errors.push(`Provider id '${provider.id}' is invalid. Use lowercase slug format (e.g. openrouter-primary).`);
    }
    if (!isSubscriptionProvider && !provider.baseUrl) errors.push(`Provider ${provider.id || "(unknown)"} missing baseUrl.`);
    if (isSubscriptionProvider && !provider.subscriptionType) {
      errors.push(`Subscription provider ${provider.id || "(unknown)"} missing subscriptionType.`);
    }
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
  validateAmpConfig(config, routingIndex, errors);

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

export function resolveProviderUrl(provider, targetFormat, requestKind = undefined) {
  const baseUrl = sanitizeEndpointUrl(provider?.baseUrlByFormat?.[targetFormat] || provider?.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return "";
  const isVersionedApiRoot = /\/v\d+(?:\.\d+)?$/i.test(baseUrl);

  if (targetFormat === FORMATS.OPENAI) {
    if (requestKind === "responses") {
      if (baseUrl.endsWith("/responses")) return baseUrl;
      if (baseUrl.endsWith("/v1") || isVersionedApiRoot) return `${baseUrl}/responses`;
      return `${baseUrl}/v1/responses`;
    }
    if (requestKind === "completions") {
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
  const sanitizedWebSearch = config.webSearch && typeof config.webSearch === "object" && !Array.isArray(config.webSearch)
    ? {
        ...config.webSearch,
        providers: (Array.isArray(config.webSearch.providers) ? config.webSearch.providers : []).map((provider) => ({
          ...provider,
          apiKey: provider?.apiKey ? maskSecret(provider.apiKey) : undefined
        }))
      }
    : undefined;
  const sanitizedAmp = config.amp
    ? {
        ...config.amp,
        upstreamApiKey: config.amp.upstreamApiKey ? maskSecret(config.amp.upstreamApiKey) : undefined,
        ...(config.amp.webSearch && typeof config.amp.webSearch === "object" && !Array.isArray(config.amp.webSearch)
          ? {
              webSearch: {
                ...config.amp.webSearch,
                providers: (Array.isArray(config.amp.webSearch.providers) ? config.amp.webSearch.providers : []).map((provider) => ({
                  ...provider,
                  apiKey: provider?.apiKey ? maskSecret(provider.apiKey) : undefined
                }))
              }
            }
          : {})
      }
    : undefined;

  return {
    ...config,
    masterKey: config.masterKey ? maskSecret(config.masterKey) : undefined,
    ...(sanitizedWebSearch ? { webSearch: sanitizedWebSearch } : {}),
    amp: sanitizedAmp,
    providers: (config.providers || []).map((provider) => ({
      ...provider,
      apiKey: provider.apiKey ? maskSecret(provider.apiKey) : undefined
    }))
  };
}

function getConfiguredModelFormats(model) {
  return dedupeStrings([...(model?.formats || []), model?.format])
    .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
}

function getProbedModelFormats(provider, model) {
  const modelId = typeof model?.id === "string" ? model.id.trim() : "";
  if (!modelId) return [];

  const preferredFormat = provider?.lastProbe?.modelPreferredFormat?.[modelId];
  if (preferredFormat === FORMATS.OPENAI || preferredFormat === FORMATS.CLAUDE) {
    return [preferredFormat];
  }

  return dedupeStrings(provider?.lastProbe?.modelSupport?.[modelId] || [])
    .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
}

function getRuntimeModelFormats(provider, model) {
  const probedFormats = getProbedModelFormats(provider, model);
  if (probedFormats.length > 0) return probedFormats;
  return getConfiguredModelFormats(model);
}

function buildTargetCandidate(provider, model, sourceFormat, target = undefined) {
  const providerFormats = dedupeStrings([...(provider?.formats || []), provider?.format])
    .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
  const modelFormats = getRuntimeModelFormats(provider, model);
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
  const modelFormats = getRuntimeModelFormats(provider, model);
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

function sortAmpCandidates(candidates, providerHint) {
  if (!providerHint) return candidates;
  const hint = String(providerHint || "").trim().toLowerCase();
  return [...candidates].sort((left, right) => {
    const leftScore = left?.providerId === hint ? 0 : 1;
    const rightScore = right?.providerId === hint ? 0 : 1;
    return leftScore - rightScore;
  });
}

function attachAmpCandidateMetadata(candidate, details) {
  if (!candidate) return candidate;
  return {
    ...candidate,
    amp: {
      requestedModel: details.requestedModel,
      resolvedInputModel: details.resolvedInputModel,
      providerHint: details.providerHint || undefined,
      mappedFrom: details.mappedFrom || undefined,
      subagents: Array.isArray(details.ampSubagents) && details.ampSubagents.length > 0 ? details.ampSubagents : undefined,
      entities: Array.isArray(details.ampEntities) && details.ampEntities.length > 0 ? details.ampEntities : undefined,
      signatures: Array.isArray(details.ampSignatures) && details.ampSignatures.length > 0 ? details.ampSignatures : undefined
    }
  };
}

function decorateAmpResolvedRoute(route, details) {
  if (!route || !route.primary) return route;
  return {
    ...route,
    routeType: `amp-${details.routeType || route.routeType || "direct"}`,
    routeMetadata: {
      ...(route.routeMetadata && typeof route.routeMetadata === "object" ? route.routeMetadata : {}),
      amp: {
        requestedModel: details.requestedModel,
        resolvedInputModel: details.resolvedInputModel,
        providerHint: details.providerHint || undefined,
        mappedFrom: details.mappedFrom || undefined,
        subagents: Array.isArray(details.ampSubagents) && details.ampSubagents.length > 0 ? details.ampSubagents : undefined,
        entities: Array.isArray(details.ampEntities) && details.ampEntities.length > 0 ? details.ampEntities : undefined,
        signatures: Array.isArray(details.ampSignatures) && details.ampSignatures.length > 0 ? details.ampSignatures : undefined
      }
    },
    primary: attachAmpCandidateMetadata(route.primary, details),
    fallbacks: (route.fallbacks || []).map((candidate) => attachAmpCandidateMetadata(candidate, details))
  };
}

function resolveBareModelRoutePlan(config, bareModelId, normalizedRequested, sourceFormat, routingIndex, options = {}) {
  const exactCandidates = [];
  const aliasCandidates = [];
  const seen = new Set();

  for (const provider of (config?.providers || [])) {
    if (!provider || provider.enabled === false) continue;

    for (const model of (provider.models || [])) {
      if (!model || model.enabled === false) continue;
      const isExactMatch = model.id === bareModelId;
      const isAliasMatch = !isExactMatch && (model.aliases || []).includes(bareModelId);
      if (!isExactMatch && !isAliasMatch) continue;
      if (!modelSupportsProviderFormat(provider, model)) continue;

      const candidate = buildTargetCandidate(provider, model, sourceFormat);
      if (seen.has(candidate.requestModelId)) continue;
      seen.add(candidate.requestModelId);

      if (isExactMatch) {
        exactCandidates.push(candidate);
      } else {
        aliasCandidates.push(candidate);
      }
    }
  }

  const candidates = [
    ...sortAmpCandidates(exactCandidates, options.providerHint),
    ...sortAmpCandidates(aliasCandidates, options.providerHint)
  ];
  const primary = candidates[0] || null;

  if (!primary) {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      routeType: "bare-model",
      routeRef: bareModelId,
      primary: null,
      fallbacks: [],
      error: `Model '${bareModelId}' is not configured under any enabled provider.`
    };
  }

  return {
    requestedModel: normalizedRequested,
    resolvedModel: bareModelId,
    routeType: "bare-model",
    routeRef: bareModelId,
    routeStrategy: "ordered",
    primary,
    fallbacks: candidates.slice(1)
  };
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
    const hasConfiguredTargets = (alias.targets || []).length > 0 || (alias.fallbackTargets || []).length > 0;
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      routeType: "alias",
      routeRef: aliasId,
      primary: null,
      fallbacks: [],
      error: hasConfiguredTargets
        ? `Alias '${aliasId}' has no resolvable target candidates.`
        : `Alias '${aliasId}' has no target candidates configured.`
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

function resolveRequestedRouteCore(config, effectiveRequested, normalizedRequested, sourceFormat, routingIndex) {
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

function resolveAmpMappedModel(config, requestedModel) {
  const mappings = Array.isArray(config?.amp?.modelMappings)
    ? config.amp.modelMappings
    : [];

  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== "object") continue;
    if (!matchAmpModelPattern(mapping.from, requestedModel)) continue;
    const target = String(mapping.to || "").trim();
    if (target) return target;
  }

  return "";
}

export const DEFAULT_AMP_SIGNATURE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "@anthropic-opus",
    description: "Anthropic Opus family used by AMP smart-like flows.",
    match: [{ vendor: "anthropic", family: "opus", variantAbsent: true }],
    defaultMatch: "claude-opus-{number}"
  }),
  Object.freeze({
    id: "@anthropic-sonnet",
    description: "Anthropic Sonnet family used by AMP librarian-like flows.",
    match: [{ vendor: "anthropic", family: "sonnet", variantAbsent: true }],
    defaultMatch: "claude-sonnet-{number}"
  }),
  Object.freeze({
    id: "@anthropic-haiku-shared",
    description: "Anthropic Haiku family shared by AMP rush/title-like flows.",
    match: [{ vendor: "anthropic", family: "haiku", variantAbsent: true }],
    defaultMatch: "claude-haiku-{number}"
  }),
  Object.freeze({
    id: "@openai-gpt-base",
    description: "Base GPT family currently observed for AMP Oracle-like flows.",
    match: [{ vendor: "openai", family: "gpt", variantAbsent: true }],
    defaultMatch: "gpt-{number}"
  }),
  Object.freeze({
    id: "@openai-gpt-codex",
    description: "OpenAI GPT Codex family used by AMP deep-like flows.",
    match: [{ vendor: "openai", family: "gpt", variantPrefix: "codex" }, "gpt-*-codex*"],
    defaultMatch: "gpt-*-codex*"
  }),
  Object.freeze({
    id: "@google-gemini-pro",
    description: "Google Gemini Pro family used by AMP review-like flows.",
    match: [{ vendor: "google", family: "gemini", variant: "pro" }, "gemini-*-pro*"],
    defaultMatch: "gemini-*-pro*"
  }),
  Object.freeze({
    id: "@google-gemini-pro-image",
    description: "Google Gemini image family used by AMP painter-like flows.",
    match: ["gemini-3-pro-image", "gemini-3-pro-image*", "gemini-*-image*"],
    defaultMatch: "gemini-*-image*"
  }),
  Object.freeze({
    id: "@google-gemini-flash-shared",
    description: "Google Gemini Flash family shared by AMP search/look-at/handoff-like flows.",
    match: [{ vendor: "google", family: "gemini", variantPrefix: "flash" }, "gemini-*-flash*"],
    defaultMatch: "gemini-*-flash*"
  })
]);

export const DEFAULT_AMP_ENTITY_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "smart", type: "mode", description: "Unconstrained state-of-the-art model use", signatures: ["@anthropic-opus"] }),
  Object.freeze({ id: "rush", type: "mode", description: "Faster and cheaper, for small well-defined tasks", signatures: ["@anthropic-haiku-shared"] }),
  Object.freeze({ id: "deep", type: "mode", description: "Deep reasoning with extended thinking", signatures: ["@openai-gpt-codex"] }),
  Object.freeze({ id: "review", type: "feature", description: "Bug identification and code review assistance", signatures: ["@google-gemini-pro"] }),
  Object.freeze({ id: "search", type: "agent", description: "Fast, accurate codebase retrieval", signatures: ["@google-gemini-flash-shared"] }),
  Object.freeze({ id: "oracle", type: "agent", description: "Complex reasoning and planning on code", signatures: ["@openai-gpt-base"] }),
  Object.freeze({ id: "librarian", type: "agent", description: "Large-scale retrieval and research on external code", signatures: ["@anthropic-sonnet"] }),
  Object.freeze({ id: "look-at", type: "system", description: "Image, PDF, and media file analysis", aliases: ["look at", "lookat"], signatures: ["@google-gemini-flash-shared"] }),
  Object.freeze({ id: "painter", type: "system", description: "Image generation and editing", signatures: ["@google-gemini-pro-image"] }),
  Object.freeze({ id: "handoff", type: "system", description: "Fallback context analysis for task continuation", signatures: ["@google-gemini-flash-shared"] }),
  Object.freeze({ id: "title", type: "system", description: "Fast title generation for threads", aliases: ["titling"], signatures: ["@anthropic-haiku-shared"] })
]);

export const DEFAULT_AMP_SUBAGENT_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "oracle", patterns: ["/^gpt-\\d+(?:\\.\\d+)?$/"] }),
  Object.freeze({ id: "librarian", patterns: ["/^(?:claude-)?sonnet-\\d+(?:\\.\\d+)?$/"] }),
  Object.freeze({ id: "title", patterns: ["/^(?:claude-)?haiku-\\d+(?:\\.\\d+)?$/"] }),
  Object.freeze({ id: "painter", patterns: ["gemini-3-pro-image", "gemini-3-pro-image*"] }),
  Object.freeze({ id: "search", patterns: ["gemini-2.5-flash", "gemini-2.5-flash*", "gemini-3-flash", "gemini-3-flash*"] }),
  Object.freeze({ id: "look-at", patterns: ["gemini-2.5-flash", "gemini-2.5-flash*", "gemini-3-flash", "gemini-3-flash*"] }),
  Object.freeze({ id: "handoff", patterns: ["gemini-3-flash", "gemini-3-flash*"] })
]);

function getAmpSubagentDefinitions(config) {
  const configuredDefinitions = Array.isArray(config?.amp?.subagentDefinitions)
    ? config.amp.subagentDefinitions
    : undefined;
  if (configuredDefinitions !== undefined) return configuredDefinitions;
  return DEFAULT_AMP_SUBAGENT_DEFINITIONS;
}

function ampHasNewRoutingSchema(config) {
  const amp = config?.amp;
  return Boolean(
    amp
    && (
      hasOwn(amp, "preset")
      || hasOwn(amp, "defaultRoute")
      || hasOwn(amp, "routes")
      || hasOwn(amp, "rawModelRoutes")
      || hasOwn(amp, "overrides")
      || hasOwn(amp, "fallback")
    )
  );
}

function mergeAmpDefinitionEntries(baseEntries, overrideEntries = []) {
  const merged = new Map();
  for (const entry of baseEntries || []) {
    if (!entry?.id) continue;
    merged.set(entry.id, { ...entry });
  }

  for (const entry of overrideEntries || []) {
    if (!entry?.id) continue;
    if (entry.enabled === false) {
      merged.delete(entry.id);
      continue;
    }
    const current = merged.get(entry.id) || {};
    merged.set(entry.id, {
      ...current,
      ...entry,
      ...(current.aliases || entry.aliases
        ? { aliases: dedupeStrings([...(current.aliases || []), ...(entry.aliases || [])]) }
        : {}),
      ...(current.signatures || entry.signatures
        ? { signatures: dedupeStrings([...(current.signatures || []), ...(entry.signatures || [])]) }
        : {}),
      ...(entry.match !== undefined
        ? { match: entry.match }
        : (current.match !== undefined ? { match: current.match } : {}))
    });
  }

  return [...merged.values()];
}

function getAmpPresetEntityDefinitions(config) {
  const preset = normalizeAmpPreset(config?.amp?.preset) || "builtin";
  if (preset === "none") return [];
  return DEFAULT_AMP_ENTITY_DEFINITIONS;
}

function getAmpPresetSignatureDefinitions(config) {
  const preset = normalizeAmpPreset(config?.amp?.preset) || "builtin";
  if (preset === "none") return [];
  return DEFAULT_AMP_SIGNATURE_DEFINITIONS;
}

function getAmpEntityDefinitions(config) {
  return mergeAmpDefinitionEntries(
    getAmpPresetEntityDefinitions(config),
    config?.amp?.overrides?.entities
  );
}

function getAmpSignatureDefinitions(config) {
  return mergeAmpDefinitionEntries(
    getAmpPresetSignatureDefinitions(config),
    config?.amp?.overrides?.signatures
  );
}

function findAmpMatchingSignatures(config, requestedModel) {
  const descriptor = parseAmpModelDescriptor(requestedModel);
  return getAmpSignatureDefinitions(config)
    .filter((entry) => Array.isArray(entry?.match) && entry.match.some((selector) => matchAmpModelSelector(selector, requestedModel, descriptor)));
}

function findAmpMatchingEntities(config, requestedModel, matchingSignatures) {
  const descriptor = parseAmpModelDescriptor(requestedModel);
  const matchedSignatureIds = new Set((matchingSignatures || []).map((entry) => entry.id));
  return getAmpEntityDefinitions(config)
    .filter((entry) => {
      const directMatch = Array.isArray(entry?.match) && entry.match.some((selector) => matchAmpModelSelector(selector, requestedModel, descriptor));
      const signatureMatch = Array.isArray(entry?.signatures) && entry.signatures.some((id) => matchedSignatureIds.has(id));
      return directMatch || signatureMatch;
    });
}

function resolveAmpConfiguredDefinitionTarget(definitions, routes, propertyName = "route") {
  const activeDefinitions = Array.isArray(definitions) ? definitions : [];
  if (activeDefinitions.length === 0) return { target: "", ambiguous: false };

  const configuredMatches = activeDefinitions
    .map((entry) => ({ id: entry.id, target: String(entry?.[propertyName] || routes?.[entry.id] || "").trim() }))
    .filter((entry) => entry.target);

  if (configuredMatches.length === 0) {
    return { target: "", ambiguous: false };
  }

  const uniqueTargets = [...new Set(configuredMatches.map((entry) => entry.target))];
  if (activeDefinitions.length > 1 && configuredMatches.length !== activeDefinitions.length) {
    return { target: "", ambiguous: true };
  }
  if (uniqueTargets.length !== 1) {
    return { target: "", ambiguous: true };
  }

  return {
    target: uniqueTargets[0],
    ambiguous: false
  };
}

function resolveAmpRawModelMappedTarget(config, requestedModel, routingIndex) {
  const mappings = Array.isArray(config?.amp?.rawModelRoutes)
    ? config.amp.rawModelRoutes
    : [];

  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== "object") continue;
    if (!matchAmpModelPattern(mapping.from, requestedModel)) continue;
    const target = String(mapping.to || "").trim();
    if (target) return target;

    const sourceRouteKey = String(mapping.sourceRouteKey || "").trim();
    if (!sourceRouteKey) continue;

    const routeTarget = String(config?.amp?.routes?.[sourceRouteKey] || "").trim();
    if (routeTarget) return routeTarget;

    const ampDefaultTarget = String(config?.amp?.defaultRoute || "").trim();
    if (ampDefaultTarget) return ampDefaultTarget;

    const globalDefaultTarget = getDefaultRouteReference(config, routingIndex);
    if (globalDefaultTarget) return globalDefaultTarget;
  }

  return "";
}

function getAmpFallbackAction(config, { ambiguous = false } = {}) {
  const fallback = config?.amp?.fallback && typeof config.amp.fallback === "object"
    ? config.amp.fallback
    : {};
  return ambiguous
    ? (fallback.onAmbiguous || undefined)
    : (fallback.onUnknown || undefined);
}

function shouldAllowAmpUpstreamProxy(config, fallbackAction) {
  const proxyUpstream = config?.amp?.fallback?.proxyUpstream;
  if (fallbackAction === "none") return false;
  if (proxyUpstream === false) return false;
  return true;
}

function buildAmpUnresolvedRoute(normalizedRequested, error, { allowAmpProxy = true } = {}) {
  return {
    requestedModel: normalizedRequested,
    resolvedModel: null,
    routeType: "unknown",
    routeRef: null,
    primary: null,
    fallbacks: [],
    error,
    allowAmpProxy
  };
}

function resolveAmpSubagentMappedModel(config, requestedModel) {
  const mappings = config?.amp?.subagentMappings && typeof config.amp.subagentMappings === "object"
    ? config.amp.subagentMappings
    : {};
  const matchingProfiles = getAmpSubagentDefinitions(config)
    .filter((profile) => Array.isArray(profile?.patterns) && profile.patterns.some((pattern) => matchAmpModelPattern(pattern, requestedModel)));
  if (matchingProfiles.length === 0) return { target: "", subagents: [], ambiguous: false };

  const configuredMatches = matchingProfiles
    .map((profile) => ({ subagent: profile.id, target: String(mappings[profile.id] || "").trim() }))
    .filter((entry) => entry.target);

  if (configuredMatches.length === 0) {
    return { target: "", subagents: matchingProfiles.map((profile) => profile.id), ambiguous: false };
  }

  const uniqueTargets = [...new Set(configuredMatches.map((entry) => entry.target))];
  if (matchingProfiles.length > 1 && configuredMatches.length !== matchingProfiles.length) {
    return { target: "", subagents: matchingProfiles.map((profile) => profile.id), ambiguous: true };
  }
  if (uniqueTargets.length !== 1) {
    return { target: "", subagents: matchingProfiles.map((profile) => profile.id), ambiguous: true };
  }

  return {
    target: uniqueTargets[0],
    subagents: matchingProfiles.map((profile) => profile.id),
    ambiguous: false
  };
}

function resolveAmpRequestedRoute(config, effectiveRequested, normalizedRequested, sourceFormat, routingIndex, options = {}) {
  const providerHint = String(options.providerHint || "").trim().toLowerCase();
  const forceModelMappings = config?.amp?.forceModelMappings === true;

  const resolveLocalRoute = (targetModel, details = {}) => {
    const mappedFrom = String(details.mappedFrom || "").trim();
    const routeTypeOverride = String(details.routeTypeOverride || "").trim();
    const ampSubagents = Array.isArray(details.ampSubagents) ? details.ampSubagents.filter(Boolean) : [];
    const ampEntities = Array.isArray(details.ampEntities) ? details.ampEntities.filter(Boolean) : [];
    const ampSignatures = Array.isArray(details.ampSignatures) ? details.ampSignatures.filter(Boolean) : [];
    const coreRoute = resolveRequestedRouteCore(config, targetModel, normalizedRequested, sourceFormat, routingIndex);
    if (coreRoute?.primary) {
      return decorateAmpResolvedRoute(coreRoute, {
        requestedModel: normalizedRequested,
        resolvedInputModel: targetModel,
        providerHint,
        mappedFrom,
        ampSubagents,
        ampEntities,
        ampSignatures,
        routeType: routeTypeOverride || coreRoute.routeType
      });
    }

    if (!String(targetModel || "").includes("/")) {
      const bareRoute = resolveBareModelRoutePlan(config, targetModel, normalizedRequested, sourceFormat, routingIndex, {
        providerHint
      });
      if (bareRoute?.primary) {
        return decorateAmpResolvedRoute(bareRoute, {
          requestedModel: normalizedRequested,
          resolvedInputModel: targetModel,
          providerHint,
          mappedFrom,
          ampSubagents,
          ampEntities,
          ampSignatures,
          routeType: routeTypeOverride || bareRoute.routeType
        });
      }
    }

    return coreRoute;
  };

  const localRoute = resolveLocalRoute(effectiveRequested);

  if (ampHasNewRoutingSchema(config)) {
    const matchingSignatures = findAmpMatchingSignatures(config, effectiveRequested);
    const matchingEntities = findAmpMatchingEntities(config, effectiveRequested, matchingSignatures);
    const signatureIds = matchingSignatures.map((entry) => entry.id);
    const entityIds = matchingEntities.map((entry) => entry.id);
    const routes = config?.amp?.routes && typeof config.amp.routes === "object"
      ? config.amp.routes
      : {};
    const entityTarget = resolveAmpConfiguredDefinitionTarget(matchingEntities, routes);
    const signatureTarget = resolveAmpConfiguredDefinitionTarget(matchingSignatures, routes);
    const rawMappedTarget = resolveAmpRawModelMappedTarget(config, effectiveRequested, routingIndex);

    const entityRoute = entityTarget.target
      ? resolveLocalRoute(entityTarget.target, {
          mappedFrom: effectiveRequested,
          ampSubagents: entityIds,
          ampEntities: entityIds,
          ampSignatures: signatureIds,
          routeTypeOverride: "entity"
        })
      : null;
    const signatureRoute = signatureTarget.target
      ? resolveLocalRoute(signatureTarget.target, {
          mappedFrom: effectiveRequested,
          ampSubagents: entityIds,
          ampEntities: entityIds,
          ampSignatures: signatureIds,
          routeTypeOverride: "signature"
        })
      : null;
    const rawMappedRoute = rawMappedTarget && rawMappedTarget !== effectiveRequested
      ? resolveLocalRoute(rawMappedTarget, {
          mappedFrom: effectiveRequested,
          ampSubagents: entityIds,
          ampEntities: entityIds,
          ampSignatures: signatureIds,
          routeTypeOverride: "raw-model-route"
        })
      : null;

    const ambiguous = entityTarget.ambiguous || signatureTarget.ambiguous;
    const fallbackAction = getAmpFallbackAction(config, { ambiguous });
    const ampDefaultTarget = String(config?.amp?.defaultRoute || "").trim();
    const globalDefaultTarget = getDefaultRouteReference(config, routingIndex);
    const selectedDefaultTarget = fallbackAction === "none" || fallbackAction === "upstream"
      ? ""
      : (fallbackAction === "default-model"
        ? globalDefaultTarget
        : (ampDefaultTarget || globalDefaultTarget));
    const selectedDefaultRouteType = fallbackAction === "default-model"
      ? "default-model"
      : (ampDefaultTarget ? "default-route" : "default-model");
    const shouldFallbackToDefault = Boolean(
      selectedDefaultTarget
      && selectedDefaultTarget !== effectiveRequested
      && selectedDefaultTarget !== entityTarget.target
      && selectedDefaultTarget !== signatureTarget.target
      && selectedDefaultTarget !== rawMappedTarget
      && !entityRoute?.primary
      && !signatureRoute?.primary
      && !rawMappedRoute?.primary
      && !localRoute?.primary
    );
    const defaultRoute = shouldFallbackToDefault
      ? resolveLocalRoute(selectedDefaultTarget, {
          mappedFrom: effectiveRequested,
          ampSubagents: entityIds,
          ampEntities: entityIds,
          ampSignatures: signatureIds,
          routeTypeOverride: selectedDefaultRouteType
        })
      : null;

    if (entityRoute?.primary) return entityRoute;
    if (signatureRoute?.primary) return signatureRoute;

    if (forceModelMappings) {
      if (rawMappedRoute?.primary) return rawMappedRoute;
      if (localRoute?.primary) return localRoute;
    } else {
      if (localRoute?.primary) return localRoute;
      if (rawMappedRoute?.primary) return rawMappedRoute;
    }

    if (defaultRoute?.primary) return defaultRoute;

    const allowAmpProxy = shouldAllowAmpUpstreamProxy(config, fallbackAction);
    const matchedLabel = ambiguous
      ? `Matched AMP entities/signatures ambiguously (${entityIds.join(", ") || "none"}; ${signatureIds.join(", ") || "none"}).`
      : `No AMP route matched '${effectiveRequested}'.`;

    const unresolvedCandidate = defaultRoute || rawMappedRoute || signatureRoute || entityRoute || localRoute;
    if (unresolvedCandidate) {
      return {
        ...unresolvedCandidate,
        error: unresolvedCandidate.error || matchedLabel,
        allowAmpProxy
      };
    }

    return buildAmpUnresolvedRoute(normalizedRequested, matchedLabel, { allowAmpProxy });
  }

  const defaultAmpTarget = getDefaultRouteReference(config, routingIndex);
  const subagentMapped = resolveAmpSubagentMappedModel(config, effectiveRequested);
  const subagentRoute = subagentMapped.target
    ? resolveLocalRoute(subagentMapped.target, {
        mappedFrom: effectiveRequested,
        ampSubagents: subagentMapped.subagents,
        routeTypeOverride: "subagent"
      })
    : null;
  const mappedModel = resolveAmpMappedModel(config, effectiveRequested);
  const mappedRoute = mappedModel && mappedModel !== effectiveRequested
    ? resolveLocalRoute(mappedModel, { mappedFrom: effectiveRequested, routeTypeOverride: "mapped" })
    : null;
  const shouldFallbackToDefault = Boolean(
    defaultAmpTarget
    && defaultAmpTarget !== effectiveRequested
    && defaultAmpTarget !== mappedModel
    && defaultAmpTarget !== subagentMapped.target
    && !localRoute?.primary
    && !subagentRoute?.primary
    && !mappedRoute?.primary
  );
  const defaultRoute = shouldFallbackToDefault
    ? resolveLocalRoute(defaultAmpTarget, { mappedFrom: effectiveRequested, routeTypeOverride: "default-model" })
    : null;

  if (forceModelMappings) {
    if (subagentRoute?.primary) return subagentRoute;
    if (mappedRoute?.primary) return mappedRoute;
    if (localRoute?.primary) return localRoute;
    return defaultRoute || localRoute;
  }

  if (subagentRoute?.primary) return subagentRoute;
  if (localRoute?.primary) return localRoute;
  if (mappedRoute?.primary) return mappedRoute;
  return defaultRoute || mappedRoute || subagentRoute || localRoute;
}

export function resolveRequestedRoute(config, requestedModel, sourceFormat = FORMATS.CLAUDE, options = {}) {
  const routingIndex = getRoutingIndex(config);
  const normalizedRequested = typeof requestedModel === "string" && requestedModel.trim()
    ? requestedModel.trim()
    : "smart";
  const smartRouteReference = normalizedRequested === "smart"
    ? getSmartRouteReference(config, routingIndex)
    : "";
  const effectiveRequested = normalizedRequested === "smart"
    ? (smartRouteReference || "smart")
    : normalizedRequested;

  if (normalizedRequested === "smart" && !smartRouteReference) {
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

  if (options?.clientType === "amp") {
    const resolvedAmpRoute = resolveAmpRequestedRoute(
      config,
      effectiveRequested,
      normalizedRequested,
      sourceFormat,
      routingIndex,
      options
    );
    if (!resolvedAmpRoute?.primary && effectiveRequested === DEFAULT_MODEL_ALIAS_ID) {
      return {
        ...resolvedAmpRoute,
        statusCode: 500
      };
    }
    return resolvedAmpRoute;
  }

  let resolvedRoute = resolveRequestedRouteCore(config, effectiveRequested, normalizedRequested, sourceFormat, routingIndex);

  if (!resolvedRoute?.primary && !String(effectiveRequested || "").includes("/")) {
    const bareRoute = resolveBareModelRoutePlan(config, effectiveRequested, normalizedRequested, sourceFormat, routingIndex, {});
    if (bareRoute?.primary) {
      resolvedRoute = bareRoute;
    }
  }

  if (!resolvedRoute?.primary && effectiveRequested === DEFAULT_MODEL_ALIAS_ID) {
    return {
      ...resolvedRoute,
      statusCode: 500
    };
  }
  return resolvedRoute;
}

export function resolveRequestModel(config, requestedModel, sourceFormat = FORMATS.CLAUDE, options = {}) {
  return resolveRequestedRoute(config, requestedModel, sourceFormat, options);
}

export function listConfiguredModels(config, { endpointFormat } = {}) {
  const rows = [];
  const now = Date.now();

  for (const provider of (config.providers || [])) {
    if (provider.enabled === false) continue;

    for (const model of (provider.models || [])) {
      if (model.enabled === false) continue;
      const modelFormats = getRuntimeModelFormats(provider, model);

      rows.push({
        id: `${provider.id}/${model.id}`,
        object: "model",
        created: now,
        owned_by: provider.id,
        provider_id: provider.id,
        provider_name: provider.name,
        formats: modelFormats.length > 0 ? modelFormats : (provider.formats || []),
        endpoint_format_supported: endpointFormat
          ? (modelFormats.length > 0 ? modelFormats.includes(endpointFormat) : (provider.formats || []).includes(endpointFormat))
          : undefined,
        context_window: model.contextWindow,
        cost: model.cost,
        model_formats: modelFormats,
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
