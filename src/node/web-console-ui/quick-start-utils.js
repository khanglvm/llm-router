import { QUICK_START_FALLBACK_USER_AGENT, QUICK_START_PROVIDER_ID_PATTERN, QUICK_START_ALIAS_ID_PATTERN, QUICK_START_CONNECTION_CATEGORIES, QUICK_START_DEFAULT_ENDPOINT_BY_PROTOCOL } from "./constants.js";
import { CODEX_SUBSCRIPTION_MODELS, CLAUDE_CODE_SUBSCRIPTION_MODELS } from "../../runtime/subscription-constants.js";
import { DEFAULT_MODEL_ALIAS_ID } from "../../runtime/config.js";
import { buildRateLimitBucketsFromDraftRows, validateRateLimitDraftRows, RATE_LIMIT_ALL_MODELS_SELECTOR } from "./rate-limit-utils.js";
import { safeClone, looksLikeEnvVarName, slugifyProviderId, createMasterKey, createRateLimitDraftRows, createRateLimitDraftRow, mergeChipValuesAndDraft, resolveRateLimitDraftRows } from "./utils.js";
import { findPresetByKey, findPresetByHost, PROVIDER_PRESET_BY_KEY, PROVIDER_PRESET_FREE_TIER_RPM_BY_HOST, presetModelCache } from "./provider-presets.js";

// ── Header / endpoint utils ──

export function getQuickStartDefaultHeaderRows(defaultProviderUserAgent = QUICK_START_FALLBACK_USER_AGENT) {
  return [{ name: "User-Agent", value: String(defaultProviderUserAgent || QUICK_START_FALLBACK_USER_AGENT) }];
}

export function normalizeQuickStartHeaderRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    name: String(row?.name || ""),
    value: row?.value === undefined || row?.value === null ? "" : String(row.value)
  }));
}

export function headerObjectToRows(headers, defaultProviderUserAgent = QUICK_START_FALLBACK_USER_AGENT) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return getQuickStartDefaultHeaderRows(defaultProviderUserAgent);
  }

  const rows = Object.entries(headers)
    .map(([name, value]) => ({
      name: String(name || ""),
      value: value === undefined || value === null ? "" : String(value)
    }))
    .filter((row) => row.name.trim());

  return rows.length > 0 ? rows : getQuickStartDefaultHeaderRows(defaultProviderUserAgent);
}

export function headerRowsToObject(rows = []) {
  const output = {};
  for (const row of normalizeQuickStartHeaderRows(rows)) {
    const name = String(row.name || "").trim();
    if (!name) continue;
    const isUserAgent = name.toLowerCase() === "user-agent";
    const value = String(row.value || "").trim();
    if (!value && !isUserAgent) continue;
    output[name] = value;
  }
  return output;
}

export function buildQuickStartApiSignature(quickStart = {}) {
  return JSON.stringify({
    connectionType: String(quickStart?.connectionType || ""),
    endpoints: Array.isArray(quickStart?.endpoints) ? quickStart.endpoints.map((entry) => String(entry || "").trim()).filter(Boolean) : [],
    apiKeyEnv: String(quickStart?.apiKeyEnv || "").trim(),
    headers: headerRowsToObject(quickStart?.headerRows || [])
  });
}

export function isProviderReference(value, providerId) {
  return String(value || "").trim().startsWith(`${providerId}/`);
}

export function pickFallbackDefaultModel(config) {
  const aliasIds = Object.keys(config?.modelAliases || {});
  if (aliasIds.includes(DEFAULT_MODEL_ALIAS_ID)) return DEFAULT_MODEL_ALIAS_ID;
  if (aliasIds.length > 0) return aliasIds[0];
  const provider = (config?.providers || []).find((entry) => (entry?.models || []).length > 0);
  return provider?.models?.[0]?.id ? `${provider.id}/${provider.models[0].id}` : undefined;
}

// ── Quick start state / config ──

export function removeProviderFromConfig(config, providerId) {
  const next = safeClone(config && typeof config === "object" ? config : {});
  next.providers = (Array.isArray(next.providers) ? next.providers : []).filter((provider) => provider?.id !== providerId);

  const remainingModelRefs = new Set(
    (next.providers || []).flatMap((provider) =>
      (provider.models || []).map((model) => `${provider.id}/${model.id}`)
    )
  );

  const aliases = next.modelAliases && typeof next.modelAliases === "object" ? next.modelAliases : {};
  const nextAliases = {};
  for (const [aliasId, alias] of Object.entries(aliases)) {
    const targets = Array.isArray(alias?.targets)
      ? alias.targets.filter((target) => !isProviderReference(target?.ref, providerId))
      : [];
    const fallbackTargets = Array.isArray(alias?.fallbackTargets)
      ? alias.fallbackTargets.filter((target) => !isProviderReference(target?.ref, providerId))
      : [];

    nextAliases[aliasId] = {
      ...alias,
      ...(Array.isArray(alias?.targets) ? { targets } : {}),
      ...(Array.isArray(alias?.fallbackTargets) ? { fallbackTargets } : {})
    };
  }
  next.modelAliases = nextAliases;

  if (next.defaultModel && !next.modelAliases?.[next.defaultModel] && !remainingModelRefs.has(next.defaultModel)) {
    next.defaultModel = DEFAULT_MODEL_ALIAS_ID;
  }

  if (next?.amp?.defaultRoute && !next.modelAliases?.[next.amp.defaultRoute] && !remainingModelRefs.has(next.amp.defaultRoute)) {
    next.amp = {
      ...next.amp,
      defaultRoute: next.defaultModel || pickFallbackDefaultModel(next)
    };
  }

  return next;
}

export function collectQuickStartEndpoints(provider = {}) {
  const fromMetadata = Array.isArray(provider?.metadata?.endpointCandidates) ? provider.metadata.endpointCandidates : [];
  const fromConfig = [provider?.baseUrl, ...Object.values(provider?.baseUrlByFormat || {})];
  return Array.from(new Set((fromMetadata.length > 0 ? fromMetadata : fromConfig)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)));
}

export function getStoredProviderCredentialPayload(provider = {}) {
  const apiKeyEnv = String(provider?.apiKeyEnv || "").trim();
  if (apiKeyEnv) return { apiKeyEnv };

  const apiKey = String(provider?.apiKey || provider?.credential || "").trim();
  return apiKey ? { apiKey } : {};
}

export function getDraftProviderCredentialPayload(draftProvider = {}, provider = {}) {
  if (draftProvider && Object.prototype.hasOwnProperty.call(draftProvider, "credentialInput")) {
    const credentialInput = String(draftProvider?.credentialInput || "").trim();
    if (!credentialInput) return {};
    return looksLikeEnvVarName(credentialInput)
      ? { apiKeyEnv: credentialInput }
      : { apiKey: credentialInput };
  }

  return getStoredProviderCredentialPayload(provider);
}

export function inferQuickStartConnectionType(provider = {}) {
  if (provider?.type === "subscription") {
    return "subscription";
  }
  return "api";
}

export function inferQuickStartPresetKey(provider = {}) {
  if (provider?.type === "subscription") {
    return provider?.subscriptionType === "claude-code" ? "oauth-claude" : "oauth-gpt";
  }
  const endpoints = collectQuickStartEndpoints(provider);
  for (const ep of endpoints) {
    try {
      const host = new URL(String(ep || "")).hostname;
      const preset = findPresetByHost(host);
      if (preset) return preset.key;
    } catch { /* ignore */ }
  }
  return "custom";
}

export function createProviderInlineDraftState(provider = {}) {
  const endpoints = collectQuickStartEndpoints(provider);
  const connectionType = inferQuickStartConnectionType(provider);
  const presetKey = inferQuickStartPresetKey(provider);
  const rateLimitDefaults = getQuickStartRateLimitDefaults(presetKey);
  return {
    id: String(provider?.id || "").trim(),
    name: String(provider?.name || provider?.id || "").trim(),
    credentialInput: connectionType === "api"
      ? String(provider?.apiKeyEnv || provider?.apiKey || provider?.credential || "").trim()
      : "",
    endpoints: connectionType === "api" ? endpoints : [],
    endpointDraft: "",
    rateLimitRows: connectionType === "api"
      ? createRateLimitDraftRows(provider?.rateLimits, {
          keyPrefix: `provider-${provider?.id || "new"}-rate-limit`,
          defaults: rateLimitDefaults,
          includeDefault: true
        })
      : []
  };
}

export function getQuickStartConnectionLabel(presetKey) {
  const preset = findPresetByKey(presetKey);
  return preset.label || "API Key";
}

export function detectPresetHostFromEndpoints(endpoints) {
  for (const ep of (endpoints || [])) {
    try {
      const host = new URL(String(ep || "")).hostname;
      if (PROVIDER_PRESET_FREE_TIER_RPM_BY_HOST[host]) return host;
    } catch { /* ignore */ }
  }
  return null;
}

export function buildPresetFreeTierRateLimitRows(presetHost, modelIds) {
  const limits = PROVIDER_PRESET_FREE_TIER_RPM_BY_HOST[presetHost];
  if (!limits || !Array.isArray(modelIds) || modelIds.length === 0) return null;
  const defaultLimit = limits._default || 30;
  return modelIds.map((modelId, index) => createRateLimitDraftRow({
    models: [String(modelId)],
    requests: limits[modelId] || defaultLimit,
    window: { size: 1, unit: "minute" }
  }, { keyPrefix: `preset-rl`, index }));
}

export function pickFreeTierProbeModels(modelIds) {
  const tiers = new Map();
  for (const id of modelIds) {
    const lower = id.toLowerCase();
    const tier = lower.includes("flash-lite") ? "flash-lite"
      : lower.includes("flash") ? "flash"
      : lower.includes("pro") ? "pro"
      : lower;
    if (!tiers.has(tier)) tiers.set(tier, id);
  }
  return [...tiers.values()];
}

export function getQuickStartSuggestedModelIds(presetKey, protocol = "openai") {
  const cached = presetModelCache.get(presetKey);
  if (cached?.length) return [...cached];
  const preset = findPresetByKey(presetKey);
  const models = preset.defaultModels;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    return [...(models[protocol] || models.openai || [])];
  }
  return Array.isArray(models) ? [...models] : [];
}

export function getQuickStartRateLimitDefaults(presetKey) {
  const preset = findPresetByKey(presetKey);
  return preset.rateLimitDefaults || PROVIDER_PRESET_BY_KEY.custom.rateLimitDefaults;
}

export function deduplicateProviderId(baseId, baseName, existingProviders = []) {
  const ids = new Set((existingProviders || []).map((p) => p?.id).filter(Boolean));
  if (!ids.has(baseId)) return { providerId: baseId, providerName: baseName };
  let n = 2;
  while (ids.has(`${baseId}-${n}`)) n++;
  return { providerId: `${baseId}-${n}`, providerName: `${baseName} ${n}` };
}

export function getQuickStartConnectionDefaults(presetKey, protocol = "openai") {
  const preset = findPresetByKey(presetKey);
  const rateLimitDefaults = getQuickStartRateLimitDefaults(presetKey);
  const isApi = preset.category === "api";

  return {
    providerName: preset.providerName,
    providerId: preset.providerId,
    endpoints: isApi && preset.endpoint ? [preset.endpoint] : [],
    apiKeyEnv: isApi ? (preset.apiKeyEnv || "") : "",
    subscriptionProfile: isApi ? "" : "",
    modelIds: presetKey === "custom" ? [] : getQuickStartSuggestedModelIds(presetKey, protocol),
    rateLimitRows: isApi
      ? createRateLimitDraftRows([], {
          keyPrefix: `quick-start-${presetKey}-rate-limit`,
          defaults: rateLimitDefaults,
          includeDefault: true
        })
      : []
  };
}

export function findQuickStartAliasEntry(baseConfig = {}, providerId = "", { aliasId = "" } = {}) {
  if (!providerId) return null;
  const aliases = baseConfig?.modelAliases && typeof baseConfig.modelAliases === "object" && !Array.isArray(baseConfig.modelAliases)
    ? baseConfig.modelAliases
    : {};
  const entries = aliasId
    ? [[aliasId, aliases[aliasId]]]
    : Object.entries(aliases);

  for (const [candidateAliasId, alias] of entries) {
    if (!alias || typeof alias !== "object") continue;
    const targets = Array.isArray(alias?.targets) ? alias.targets : [];
    const fallbackTargets = Array.isArray(alias?.fallbackTargets) ? alias.fallbackTargets : [];
    if ([...targets, ...fallbackTargets].some((target) => isProviderReference(target?.ref, providerId))) {
      return { aliasId: candidateAliasId, alias };
    }
  }
  return null;
}

export function getQuickStartAliasTargetModelIds(aliasEntry, providerId = "", fallbackModelIds = []) {
  const normalizedFallbackModelIds = Array.from(new Set((fallbackModelIds || []).map((modelId) => String(modelId || "").trim()).filter(Boolean)));
  if (!providerId || !aliasEntry?.alias) return normalizedFallbackModelIds;

  const allowedModelIds = new Set(normalizedFallbackModelIds);
  const aliasTargets = Array.isArray(aliasEntry.alias?.targets) ? aliasEntry.alias.targets : [];
  const orderedAliasModelIds = [];

  for (const target of aliasTargets) {
    const ref = String(target?.ref || "").trim();
    if (!isProviderReference(ref, providerId)) continue;
    const modelId = ref.slice(providerId.length + 1);
    if (!allowedModelIds.has(modelId) || orderedAliasModelIds.includes(modelId)) continue;
    orderedAliasModelIds.push(modelId);
  }

  return orderedAliasModelIds.length > 0 ? orderedAliasModelIds : normalizedFallbackModelIds;
}

export function syncQuickStartAliasModelIds(aliasModelIds = [], modelIds = []) {
  const normalizedModelIds = Array.from(new Set((modelIds || []).map((modelId) => String(modelId || "").trim()).filter(Boolean)));
  const remaining = new Set(normalizedModelIds);
  const ordered = [];

  for (const modelId of (aliasModelIds || []).map((entry) => String(entry || "").trim()).filter(Boolean)) {
    if (!remaining.has(modelId)) continue;
    ordered.push(modelId);
    remaining.delete(modelId);
  }

  return [
    ...ordered,
    ...normalizedModelIds.filter((modelId) => remaining.has(modelId))
  ];
}

export function rewriteQuickStartAliasTarget(target, { fromProviderId, toProviderId, allowedModelIds }) {
  if (!target || typeof target !== "object") return target;
  const ref = String(target.ref || "").trim();
  if (!fromProviderId || !isProviderReference(ref, fromProviderId)) return target;
  const modelId = ref.slice(fromProviderId.length + 1);
  if (!allowedModelIds.has(modelId)) return null;
  return {
    ...target,
    ref: `${toProviderId}/${modelId}`
  };
}

export function rewriteQuickStartAlias(alias, options) {
  if (!alias || typeof alias !== "object") return alias;
  const nextAlias = { ...alias };
  const hasTargets = Array.isArray(alias.targets);
  const hasFallbackTargets = Array.isArray(alias.fallbackTargets);

  if (hasTargets) {
    nextAlias.targets = alias.targets
      .map((target) => rewriteQuickStartAliasTarget(target, options))
      .filter(Boolean);
  }
  if (hasFallbackTargets) {
    nextAlias.fallbackTargets = alias.fallbackTargets
      .map((target) => rewriteQuickStartAliasTarget(target, options))
      .filter(Boolean);
  }

  return nextAlias;
}

export function rewriteQuickStartProviderRef(value, { fromProviderId, toProviderId, allowedModelIds }) {
  const ref = String(value || "").trim();
  if (!ref || !fromProviderId || !isProviderReference(ref, fromProviderId)) return ref;
  const modelId = ref.slice(fromProviderId.length + 1);
  if (!allowedModelIds.has(modelId)) return "";
  return `${toProviderId}/${modelId}`;
}

export function collectQuickStartProviderRefs(providers = []) {
  return new Set(
    (providers || []).flatMap((provider) =>
      (provider?.models || []).map((model) => `${provider.id}/${model.id}`)
    )
  );
}

export function createQuickStartState(baseConfig = {}, { seedMode = "blank", targetProviderId = "", defaultProviderUserAgent = QUICK_START_FALLBACK_USER_AGENT } = {}) {
  const providerList = Array.isArray(baseConfig?.providers) ? baseConfig.providers : [];
  const targetedProvider = targetProviderId
    ? providerList.find((entry) => entry?.id === targetProviderId) || null
    : null;
  const useExistingProvider = seedMode === "existing" || Boolean(targetedProvider);
  const provider = useExistingProvider ? (targetedProvider || providerList[0] || {}) : {};
  const connectionType = useExistingProvider ? inferQuickStartConnectionType(provider) : "api";
  const presetKey = useExistingProvider ? inferQuickStartPresetKey(provider) : "custom";
  const protocol = provider?.format === "claude" ? "claude" : "openai";
  const defaults = getQuickStartConnectionDefaults(presetKey, protocol);
  const rateLimitDefaults = getQuickStartRateLimitDefaults(presetKey);
  const providerModels = Array.isArray(provider?.models)
    ? provider.models.map((model) => model?.id).filter(Boolean)
    : [];
  const resolvedProviderId = String(provider?.id || defaults.providerId || slugifyProviderId(provider?.name || defaults.providerName || "my-provider") || "my-provider");
  const aliasEntry = useExistingProvider
    ? findQuickStartAliasEntry(baseConfig, resolvedProviderId, { aliasId: DEFAULT_MODEL_ALIAS_ID })
    : null;
  const resolvedModelIds = providerModels.length > 0 ? providerModels : [...defaults.modelIds];
  const modelContextWindows = Object.fromEntries(
    (Array.isArray(provider?.models) ? provider.models : [])
      .map((model) => {
        const modelId = String(model?.id || "").trim();
        const contextWindow = Number(model?.contextWindow);
        if (!modelId || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
        return [modelId, Math.floor(contextWindow)];
      })
      .filter(Boolean)
  );
  const headerRows = connectionType === "api"
    ? headerObjectToRows(provider?.headers, defaultProviderUserAgent)
    : [];

  return {
    connectionType,
    selectedConnection: presetKey,
    providerName: String(provider?.name || defaults.providerName),
    providerId: resolvedProviderId,
    endpoints: collectQuickStartEndpoints(provider).length > 0 ? collectQuickStartEndpoints(provider) : defaults.endpoints,
    endpointDraft: "",
    apiKeyEnv: String(provider?.apiKeyEnv || provider?.apiKey || defaults.apiKeyEnv),
    subscriptionProfile: String(provider?.subscriptionProfile || defaults.subscriptionProfile),
    modelIds: resolvedModelIds,
    modelContextWindows,
    modelDraft: "",
    aliasModelIds: getQuickStartAliasTargetModelIds(aliasEntry, resolvedProviderId, resolvedModelIds),
    headerRows,
    rateLimitRows: connectionType === "api"
      ? createRateLimitDraftRows(provider?.rateLimits, {
          keyPrefix: `quick-start-${resolvedProviderId}-rate-limit`,
          defaults: rateLimitDefaults,
          includeDefault: true
        })
      : [],
    enableAlias: true,
    aliasId: DEFAULT_MODEL_ALIAS_ID,
    sourceAliasId: aliasEntry?.aliasId || "",
    useAliasAsDefault: useExistingProvider ? Boolean(aliasEntry) : true
  };
}

export function buildQuickStartModelEntries(modelIds, modelPreferredFormat = {}, modelContextWindows = {}) {
  return (modelIds || []).map((id) => {
    const preferred = modelPreferredFormat[id];
    const contextWindow = Number(modelContextWindows?.[id]);
    return {
      id,
      ...(preferred ? { formats: [preferred] } : {}),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.floor(contextWindow) } : {})
    };
  });
}

export function resolveQuickStartSubscriptionProfile(quickStart = {}) {
  const providerId = slugifyProviderId(quickStart?.providerId || quickStart?.providerName || "") || "";
  return String(quickStart?.subscriptionProfile || providerId || "default").trim() || providerId || "default";
}

export function buildQuickStartConfig(baseConfig = {}, quickStart, testedProviderConfig = null, { targetProviderId = "" } = {}) {
  const next = safeClone(baseConfig && typeof baseConfig === "object" ? baseConfig : {});
  const providerId = slugifyProviderId(quickStart?.providerId || quickStart?.providerName || "my-provider") || "my-provider";
  const providerName = String(quickStart?.providerName || providerId).trim() || providerId;
  const modelIds = Array.isArray(quickStart?.modelIds) ? quickStart.modelIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
  const orderedModelIds = syncQuickStartAliasModelIds(quickStart?.aliasModelIds, modelIds);
  const effectiveRateLimitDefaults = getQuickStartRateLimitDefaults(quickStart?.selectedConnection || quickStart?.connectionType);
  const resolvedRateLimitRows = Array.isArray(quickStart?.rateLimitRows)
    ? quickStart.rateLimitRows
    : [];
  const effectiveApiRateLimitRows = resolvedRateLimitRows.length > 0
    ? resolvedRateLimitRows
    : [{
        models: [RATE_LIMIT_ALL_MODELS_SELECTOR],
        requests: effectiveRateLimitDefaults.limit,
        windowValue: effectiveRateLimitDefaults.windowValue,
        windowUnit: effectiveRateLimitDefaults.windowUnit
      }];
  const hadProviders = Array.isArray(baseConfig?.providers) && baseConfig.providers.length > 0;
  const sourceProviderId = String(targetProviderId || "").trim();
  const sourceAliasId = String(quickStart?.sourceAliasId || "").trim();
  let provider;

  if (quickStart?.connectionType === "api") {
    const endpoints = Array.isArray(quickStart?.endpoints) ? quickStart.endpoints.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
    const workingFormats = Array.isArray(testedProviderConfig?.workingFormats)
      ? testedProviderConfig.workingFormats.filter(Boolean)
      : [];
    const preferredFormat = testedProviderConfig?.preferredFormat || workingFormats[0] || "openai";
    const baseUrlByFormat = testedProviderConfig?.baseUrlByFormat && typeof testedProviderConfig.baseUrlByFormat === "object"
      ? testedProviderConfig.baseUrlByFormat
      : (endpoints[0] ? { [preferredFormat]: endpoints[0] } : undefined);
    const baseUrl = (preferredFormat && baseUrlByFormat?.[preferredFormat])
      || baseUrlByFormat?.openai
      || baseUrlByFormat?.claude
      || endpoints[0]
      || "";
    const confirmedModelIds = Array.isArray(testedProviderConfig?.models) && testedProviderConfig.models.length > 0
      ? orderedModelIds.filter((id) => testedProviderConfig.models.includes(id))
      : orderedModelIds;
    const effectiveModelIds = confirmedModelIds.length > 0 ? confirmedModelIds : orderedModelIds;
    const providerMetadata = endpoints.length > 1 ? { endpointCandidates: endpoints } : undefined;

    const credentialInput = String(quickStart?.apiKeyEnv || "").trim();
    const providerCredential = looksLikeEnvVarName(credentialInput)
      ? { apiKeyEnv: credentialInput }
      : (credentialInput ? { apiKey: credentialInput } : {});
    const customHeaders = headerRowsToObject(quickStart?.headerRows || []);

    provider = {
      id: providerId,
      name: providerName,
      baseUrl,
      baseUrlByFormat,
      ...providerCredential,
      ...(Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {}),
      format: preferredFormat,
      formats: workingFormats.length > 0 ? workingFormats : [preferredFormat],
      models: buildQuickStartModelEntries(
        effectiveModelIds,
        testedProviderConfig?.modelPreferredFormat || {},
        quickStart?.modelContextWindows || {}
      ),
      ...(providerMetadata ? { metadata: providerMetadata } : {})
    };
  } else {
    const preset = findPresetByKey(quickStart?.selectedConnection || "oauth-gpt");
    const subscriptionType = preset.subscriptionType || "chatgpt-codex";
    const providerFormat = preset.format || "openai";

    provider = {
      id: providerId,
      name: providerName,
      type: "subscription",
      subscriptionType,
      subscriptionProfile: resolveQuickStartSubscriptionProfile(quickStart),
      format: providerFormat,
      formats: [providerFormat],
      models: buildQuickStartModelEntries(orderedModelIds, {}, quickStart?.modelContextWindows || {})
    };
  }

  provider.rateLimits = quickStart?.connectionType === "api"
    ? buildRateLimitBucketsFromDraftRows(effectiveApiRateLimitRows, {
        fallbackRequests: effectiveRateLimitDefaults.limit,
        fallbackWindowValue: effectiveRateLimitDefaults.windowValue,
        fallbackWindowUnit: effectiveRateLimitDefaults.windowUnit
      })
    : buildRateLimitBucketsFromDraftRows([{
        models: [RATE_LIMIT_ALL_MODELS_SELECTOR],
        requests: effectiveRateLimitDefaults.limit,
        windowValue: effectiveRateLimitDefaults.windowValue,
        windowUnit: effectiveRateLimitDefaults.windowUnit
      }], {
        fallbackRequests: effectiveRateLimitDefaults.limit,
        fallbackWindowValue: effectiveRateLimitDefaults.windowValue,
        fallbackWindowUnit: effectiveRateLimitDefaults.windowUnit
      });

  if (!String(next.masterKey || "").trim()) {
    next.masterKey = createMasterKey();
  }

  next.version = typeof next.version === "number" ? next.version : 2;

  const existingProviders = Array.isArray(next.providers) ? next.providers : [];
  let providerIndex = sourceProviderId
    ? existingProviders.findIndex((entry) => entry?.id === sourceProviderId)
    : -1;
  if (providerIndex === -1) {
    providerIndex = existingProviders.findIndex((entry) => entry?.id === providerId);
  }
  next.providers = providerIndex === -1
    ? [...existingProviders, provider]
    : existingProviders.map((entry, index) => (index === providerIndex ? provider : entry));

  const existingAliases = next.modelAliases && typeof next.modelAliases === "object" && !Array.isArray(next.modelAliases)
    ? next.modelAliases
    : {};
  const allowedModelIds = new Set((provider.models || []).map((model) => model.id));
  const shouldManageDefaultAlias = !hadProviders || quickStart?.useAliasAsDefault === true;
  const nextAliases = {};

  for (const [aliasId, alias] of Object.entries(existingAliases)) {
    const rewrittenAlias = sourceProviderId
      ? rewriteQuickStartAlias(alias, { fromProviderId: sourceProviderId, toProviderId: providerId, allowedModelIds })
      : alias;
    nextAliases[aliasId] = rewrittenAlias;
  }

  const primaryRef = provider.models?.[0]?.id ? `${providerId}/${provider.models[0].id}` : "";
  const aliasTargetModelIds = (orderedModelIds.length > 0 ? orderedModelIds : (provider.models || []).map((model) => model.id))
    .filter((modelId) => allowedModelIds.has(modelId));
  const defaultAliasId = DEFAULT_MODEL_ALIAS_ID;
  const existingDefaultAlias = nextAliases[defaultAliasId] && typeof nextAliases[defaultAliasId] === "object"
    ? nextAliases[defaultAliasId]
    : { id: defaultAliasId, strategy: "ordered", targets: [], fallbackTargets: [] };
  nextAliases[defaultAliasId] = shouldManageDefaultAlias
    ? {
        ...existingDefaultAlias,
        id: defaultAliasId,
        strategy: "ordered",
        targets: aliasTargetModelIds.map((modelId) => ({ ref: `${providerId}/${modelId}` })),
        fallbackTargets: []
      }
    : {
        ...existingDefaultAlias,
        id: defaultAliasId,
        strategy: String(existingDefaultAlias.strategy || "ordered").trim() || "ordered",
        targets: Array.isArray(existingDefaultAlias.targets) ? existingDefaultAlias.targets : [],
        fallbackTargets: Array.isArray(existingDefaultAlias.fallbackTargets) ? existingDefaultAlias.fallbackTargets : []
      };
  next.modelAliases = nextAliases;

  const remainingModelRefs = collectQuickStartProviderRefs(next.providers);
  next.defaultModel = DEFAULT_MODEL_ALIAS_ID;

  if (!next.amp || typeof next.amp !== "object" || Array.isArray(next.amp)) {
    next.amp = { restrictManagementToLocalhost: true, overrides: { entities: [] } };
  }
  if (next.amp.restrictManagementToLocalhost === undefined) {
    next.amp.restrictManagementToLocalhost = true;
  }
  if (!next.amp.overrides || typeof next.amp.overrides !== "object" || Array.isArray(next.amp.overrides)) {
    next.amp.overrides = { entities: [] };
  }
  if (!Array.isArray(next.amp.overrides.entities)) {
    next.amp.overrides.entities = [];
  }

  let nextAmpDefaultRoute = String(next.amp.defaultRoute || "").trim();
  if (sourceProviderId) {
    nextAmpDefaultRoute = rewriteQuickStartProviderRef(nextAmpDefaultRoute, {
      fromProviderId: sourceProviderId,
      toProviderId: providerId,
      allowedModelIds
    });
  }
  if (shouldManageDefaultAlias || !nextAmpDefaultRoute || (!next.modelAliases?.[nextAmpDefaultRoute] && !remainingModelRefs.has(nextAmpDefaultRoute))) {
    nextAmpDefaultRoute = DEFAULT_MODEL_ALIAS_ID;
  }
  if (nextAmpDefaultRoute) {
    next.amp.defaultRoute = nextAmpDefaultRoute;
  }

  if (!next.metadata || typeof next.metadata !== "object" || Array.isArray(next.metadata)) {
    next.metadata = {};
  }

  return next;
}

export function hasCompletedProviderSetup(config = {}) {
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  return providers.some((provider) => {
    if (provider?.enabled === false) return false;
    const models = Array.isArray(provider?.models)
      ? provider.models.filter((model) => String(model?.id || "").trim())
      : [];
    const rateLimits = Array.isArray(provider?.rateLimits) ? provider.rateLimits : [];
    return models.length > 0 && rateLimits.length > 0;
  });
}

export function getQuickStartStepError(stepIndex, quickStart, baseConfig = {}, { targetProviderId = "" } = {}) {
  const providerId = slugifyProviderId(quickStart?.providerId || quickStart?.providerName || "");
  const modelIds = mergeChipValuesAndDraft(quickStart?.modelIds, quickStart?.modelDraft);
  const aliasModelIds = syncQuickStartAliasModelIds(quickStart?.aliasModelIds, modelIds);
  const rateLimitRows = resolveRateLimitDraftRows(quickStart?.rateLimitRows);
  const endpoints = quickStart?.connectionType === "api"
    ? mergeChipValuesAndDraft(quickStart?.endpoints, quickStart?.endpointDraft)
    : [];
  const providerList = Array.isArray(baseConfig?.providers) ? baseConfig.providers : [];
  const aliasMap = baseConfig?.modelAliases && typeof baseConfig.modelAliases === "object" && !Array.isArray(baseConfig.modelAliases)
    ? baseConfig.modelAliases
    : {};

  if (stepIndex === 0) {
    if (!String(quickStart?.providerName || "").trim()) return "Add a provider name to continue.";
    if (!providerId || !QUICK_START_PROVIDER_ID_PATTERN.test(providerId)) return "Provider id must start with a letter and use lowercase letters, numbers, or hyphens.";
    if (providerList.some((provider) => provider?.id === providerId && provider?.id !== targetProviderId)) {
      return "Provider id already exists. Choose another id or edit that provider instead.";
    }
    if (quickStart?.connectionType === "api") {
      if (endpoints.length === 0) return "Add at least one endpoint to continue.";
      if (!String(quickStart?.apiKeyEnv || "").trim()) return "API key or env is required before testing config.";
    }
  }

  if (stepIndex === 1) {
    if (modelIds.length === 0) return "Add at least one model id.";
    if (quickStart?.connectionType === "api") {
      const rateLimitIssue = validateRateLimitDraftRows(rateLimitRows, {
        knownModelIds: modelIds,
        requireAtLeastOne: true
      });
      if (rateLimitIssue) return rateLimitIssue;
    }
  }

  if (stepIndex === 2) {
    if (quickStart?.useAliasAsDefault && Object.prototype.hasOwnProperty.call(aliasMap, String(quickStart?.aliasId || DEFAULT_MODEL_ALIAS_ID).trim()) === false) {
      return "";
    }
  }

  return "";
}

// ── Internal dependency notes ──
// The following are referenced from app.jsx scope and not yet in separate modules:
//   safeClone, looksLikeEnvVarName, slugifyProviderId, createRateLimitDraftRows,
//   createRateLimitDraftRow, mergeChipValuesAndDraft, resolveRateLimitDraftRows,
//   validateRateLimitDraftRows, createMasterKey,
//   findPresetByKey, findPresetByHost, PROVIDER_PRESET_BY_KEY,
//   PROVIDER_PRESET_FREE_TIER_RPM_BY_HOST, presetModelCache
