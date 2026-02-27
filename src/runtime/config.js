/**
 * Runtime config helpers for both local Node route and Cloudflare Worker route.
 * Config source is user-managed (e.g. ~/.llm-router.json or LLM_ROUTER_CONFIG_JSON secret).
 */

import { FORMATS } from "../translator/index.js";

export const CONFIG_VERSION = 1;
export const PROVIDER_ID_PATTERN = /^[a-z][a-zA-Z0-9-]*$/;
export const DEFAULT_PROVIDER_USER_AGENT = "llm-router (+https://github.com/khanglvm/llm-router)";

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
let runtimeEnvCache = null;

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

function slugifyId(value, fallback = "provider") {
  const slug = String(value || fallback)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
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
    lastProbe: provider.lastProbe && typeof provider.lastProbe === "object" ? provider.lastProbe : undefined
  };
}

export function normalizeRuntimeConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const providers = sanitizeModelFallbackReferences(
    toArray(raw.providers)
    .map(normalizeProvider)
    .filter(Boolean)
    .filter((provider) => provider.enabled !== false)
  );

  const masterKey = typeof raw.masterKey === "string"
    ? raw.masterKey
    : (typeof raw["master-key"] === "string" ? raw["master-key"] : undefined);

  const defaultModel = typeof raw.defaultModel === "string"
    ? raw.defaultModel
    : (typeof raw["default-model"] === "string" ? raw["default-model"] : undefined);

  return {
    version: Number.isFinite(raw.version) ? Number(raw.version) : CONFIG_VERSION,
    masterKey,
    defaultModel,
    providers,
    metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}
  };
}

export function parseRuntimeConfigJson(json) {
  return normalizeRuntimeConfig(JSON.parse(json));
}

export function configHasProvider(config) {
  return Array.isArray(config?.providers) && config.providers.some((provider) => provider.enabled !== false);
}

export function validateRuntimeConfig(config, { requireMasterKey = false, requireProvider = false } = {}) {
  const errors = [];

  if (!config || typeof config !== "object") {
    errors.push("Config is missing or invalid.");
    return errors;
  }

  if (!Array.isArray(config.providers)) {
    errors.push("Config.providers must be an array.");
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

export function resolveProviderUrl(provider, targetFormat) {
  const baseUrl = sanitizeEndpointUrl(provider?.baseUrlByFormat?.[targetFormat] || provider?.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return "";
  const isVersionedApiRoot = /\/v\d+(?:\.\d+)?$/i.test(baseUrl);

  if (targetFormat === FORMATS.OPENAI) {
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

function buildTargetCandidate(provider, model, sourceFormat) {
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

  return {
    providerId: provider.id,
    providerName: provider.name,
    provider,
    modelId: model.id,
    model,
    backend: model.id,
    targetFormat,
    requestModelId: `${provider.id}/${model.id}`
  };
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

function resolveQualifiedModel(config, qualifiedModel) {
  const value = String(qualifiedModel || "").trim();
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) return null;

  const providerId = value.slice(0, slashIndex);
  const modelId = value.slice(slashIndex + 1);
  const provider = (config.providers || []).find((item) => item.id === providerId && item.enabled !== false);
  if (!provider) return null;

  const model = findModelById(provider, modelId);
  if (!model) return null;

  return { provider, model };
}

export function resolveRequestModel(config, requestedModel, sourceFormat = FORMATS.CLAUDE) {
  const normalizedRequested = typeof requestedModel === "string" && requestedModel.trim()
    ? requestedModel.trim()
    : "smart";

  const defaultModel = config.defaultModel || "smart";
  const effectiveRequested = normalizedRequested === "smart" ? defaultModel : normalizedRequested;

  // Provider-qualified model syntax is required: provider/model
  const slashIndex = effectiveRequested.indexOf("/");
  if (slashIndex <= 0 || slashIndex === effectiveRequested.length - 1) {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      primary: null,
      fallbacks: [],
      error: "Model must use the 'provider/model' convention."
    };
  }

  const providerId = effectiveRequested.slice(0, slashIndex);
  const modelName = effectiveRequested.slice(slashIndex + 1);
  const provider = (config.providers || []).find((item) => item.id === providerId && item.enabled !== false);

  if (!provider) {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      primary: null,
      fallbacks: [],
      error: `Provider '${providerId}' not found.`
    };
  }

  const model = findModelById(provider, modelName);
  if (!model) {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      primary: null,
      fallbacks: [],
      error: `Model '${modelName}' is not configured under provider '${providerId}'.`
    };
  }

  if (!modelSupportsProviderFormat(provider, model)) {
    return {
      requestedModel: normalizedRequested,
      resolvedModel: null,
      primary: null,
      fallbacks: [],
      error: `Model '${modelName}' is configured for unsupported endpoint formats under provider '${providerId}'.`
    };
  }

  const primary = buildTargetCandidate(provider, model, sourceFormat);
  const fallbackCandidates = [];
  const seen = new Set([primary.requestModelId]);

  for (const fallbackEntry of (model.fallbackModels || [])) {
    const resolvedFallback = resolveQualifiedModel(config, fallbackEntry);
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
    primary,
    fallbacks: fallbackCandidates
  };
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
      parsed: rawJson ? parseRuntimeConfigJson(rawJson) : normalizeRuntimeConfig({}),
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
