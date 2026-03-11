import { DEFAULT_MODEL_ALIAS_ID } from "../../runtime/config.js";
import {
  buildRateLimitBucketsFromDraftRows,
  RATE_LIMIT_ALL_MODELS_SELECTOR
} from "./rate-limit-utils.js";

function safeClone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function dedupeStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeAliasLookup(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.startsWith("alias:") ? text.slice("alias:".length).trim() : text;
}

function buildDefaultAlias(config = {}, aliases = {}) {
  const existingDefault = aliases?.[DEFAULT_MODEL_ALIAS_ID];
  if (existingDefault && typeof existingDefault === "object" && !Array.isArray(existingDefault)) {
    return {
      ...existingDefault,
      id: DEFAULT_MODEL_ALIAS_ID,
      strategy: String(existingDefault.strategy || "ordered").trim() || "ordered",
      targets: rewriteAliasTargetList(existingDefault.targets || [], (ref) => ref),
      fallbackTargets: rewriteAliasTargetList(existingDefault.fallbackTargets || [], (ref) => ref)
    };
  }

  const configuredDefault = String(config?.defaultModel || "").trim();
  if (!configuredDefault || configuredDefault === "smart") {
    return {
      id: DEFAULT_MODEL_ALIAS_ID,
      strategy: "ordered",
      targets: [],
      fallbackTargets: []
    };
  }

  const aliasFromDefault = normalizeAliasLookup(configuredDefault);
  if (aliasFromDefault && aliases?.[aliasFromDefault]) {
    const sourceAlias = aliases[aliasFromDefault];
    return {
      ...sourceAlias,
      id: DEFAULT_MODEL_ALIAS_ID,
      strategy: String(sourceAlias.strategy || "ordered").trim() || "ordered",
      targets: rewriteAliasTargetList(sourceAlias.targets || [], (ref) => ref),
      fallbackTargets: rewriteAliasTargetList(sourceAlias.fallbackTargets || [], (ref) => ref)
    };
  }

  return {
    id: DEFAULT_MODEL_ALIAS_ID,
    strategy: "ordered",
    targets: configuredDefault ? [{ ref: configuredDefault }] : [],
    fallbackTargets: []
  };
}

function ensureDefaultAlias(config = {}) {
  if (!config.modelAliases || typeof config.modelAliases !== "object" || Array.isArray(config.modelAliases)) {
    config.modelAliases = {};
  }
  config.modelAliases[DEFAULT_MODEL_ALIAS_ID] = buildDefaultAlias(config, config.modelAliases);
  return config;
}

function collectManagedRouteRefs(config = {}) {
  const refs = new Set();
  for (const aliasId of Object.keys(config?.modelAliases || {})) {
    const normalizedAliasId = String(aliasId || "").trim();
    if (normalizedAliasId) refs.add(normalizedAliasId);
  }
  for (const provider of (config?.providers || [])) {
    const providerId = String(provider?.id || "").trim();
    if (!providerId) continue;
    for (const model of (provider?.models || [])) {
      const modelId = String(model?.id || "").trim();
      if (!modelId) continue;
      refs.add(`${providerId}/${modelId}`);
    }
  }
  return refs;
}

function pickFallbackDefaultModel(config = {}) {
  const aliasIds = Object.keys(config?.modelAliases || {}).map((aliasId) => String(aliasId || "").trim()).filter(Boolean);
  if (aliasIds.includes(DEFAULT_MODEL_ALIAS_ID)) return DEFAULT_MODEL_ALIAS_ID;
  if (aliasIds.length > 0) return aliasIds[0];

  for (const provider of (config?.providers || [])) {
    const providerId = String(provider?.id || "").trim();
    if (!providerId) continue;
    for (const model of (provider?.models || [])) {
      const modelId = String(model?.id || "").trim();
      if (!modelId) continue;
      return `${providerId}/${modelId}`;
    }
  }

  return "";
}

function ensureTopLevelRoutes(config = {}) {
  ensureDefaultAlias(config);
  const knownRoutes = collectManagedRouteRefs(config);
  config.defaultModel = DEFAULT_MODEL_ALIAS_ID;

  if (!config.amp || typeof config.amp !== "object" || Array.isArray(config.amp)) {
    return config;
  }

  const nextAmpDefaultRoute = String(config.amp.defaultRoute || "").trim();
  if (!nextAmpDefaultRoute || !knownRoutes.has(normalizeAliasLookup(nextAmpDefaultRoute))) {
    const fallback = String(config.defaultModel || "").trim() || pickFallbackDefaultModel(config);
    if (fallback) {
      config.amp.defaultRoute = fallback;
    } else {
      delete config.amp.defaultRoute;
    }
  }

  return config;
}

function rewriteProviderModelRef(ref, providerId, renameMap, validModelIds) {
  const text = String(ref || "").trim();
  if (!text) return "";
  const prefix = `${providerId}/`;
  if (!text.startsWith(prefix)) return text;

  const modelId = text.slice(prefix.length);
  const nextModelId = renameMap.get(modelId) || modelId;
  if (!validModelIds.has(nextModelId)) return "";
  return `${providerId}/${nextModelId}`;
}

function rewriteProviderReference(ref, currentProviderId, nextProviderId = "") {
  const text = String(ref || "").trim();
  if (!text) return "";
  const prefix = `${currentProviderId}/`;
  if (!text.startsWith(prefix)) return text;
  if (!nextProviderId) return "";
  return `${nextProviderId}/${text.slice(prefix.length)}`;
}

function normalizeEndpointCandidates(values = []) {
  return dedupeStrings(Array.isArray(values) ? values : [values]);
}

function rewriteProviderEndpoints(provider = {}, endpoints = []) {
  const nextProvider = { ...provider };
  const nextEndpoints = normalizeEndpointCandidates(endpoints);
  const primaryEndpoint = String(nextEndpoints[0] || "").trim();
  let nextMetadata = nextProvider.metadata && typeof nextProvider.metadata === "object" && !Array.isArray(nextProvider.metadata)
    ? { ...nextProvider.metadata }
    : null;
  const shouldPersistEndpointCandidates = nextEndpoints.length > 1
    || Boolean(nextMetadata && Object.prototype.hasOwnProperty.call(nextMetadata, "endpointCandidates"));

  if (!primaryEndpoint) {
    delete nextProvider.baseUrl;
    delete nextProvider.baseUrlByFormat;
    if (nextMetadata && Object.prototype.hasOwnProperty.call(nextMetadata, "endpointCandidates")) {
      delete nextMetadata.endpointCandidates;
    }
  } else {
    nextProvider.baseUrl = primaryEndpoint;
    const baseUrlByFormat = nextProvider.baseUrlByFormat && typeof nextProvider.baseUrlByFormat === "object" && !Array.isArray(nextProvider.baseUrlByFormat)
      ? nextProvider.baseUrlByFormat
      : null;
    if (baseUrlByFormat && Object.keys(baseUrlByFormat).length > 0) {
      nextProvider.baseUrlByFormat = Object.fromEntries(Object.keys(baseUrlByFormat).map((format) => [format, primaryEndpoint]));
    }
    if (shouldPersistEndpointCandidates) {
      nextMetadata = nextMetadata || {};
      nextMetadata.endpointCandidates = nextEndpoints;
    }
  }

  if (nextMetadata && Object.keys(nextMetadata).length > 0) {
    nextProvider.metadata = nextMetadata;
  } else if (nextMetadata) {
    delete nextProvider.metadata;
  }

  return nextProvider;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildLegacyRateLimitDraftRows(draftProvider = {}) {
  const hasLegacyFields =
    draftProvider?.rateLimitLimit !== undefined
    || draftProvider?.rateLimitWindowValue !== undefined
    || draftProvider?.rateLimitWindowUnit !== undefined;
  if (!hasLegacyFields) return [];
  return [{
    sourceId: String(draftProvider?.rateLimitSourceId || "").trim(),
    models: [RATE_LIMIT_ALL_MODELS_SELECTOR],
    requests: draftProvider?.rateLimitLimit,
    windowValue: draftProvider?.rateLimitWindowValue,
    windowUnit: draftProvider?.rateLimitWindowUnit
  }];
}

function rewriteRateLimits(provider = {}, draftProvider = {}, providerId = "") {
  const nextProvider = { ...provider };
  const currentRateLimits = Array.isArray(nextProvider.rateLimits)
    ? nextProvider.rateLimits.map((rateLimit) => (rateLimit && typeof rateLimit === "object" ? safeClone(rateLimit) : rateLimit)).filter(Boolean)
    : [];
  const draftRows = Array.isArray(draftProvider?.rateLimitRows)
    ? draftProvider.rateLimitRows
    : buildLegacyRateLimitDraftRows(draftProvider);
  const currentPrimary = currentRateLimits[0] && typeof currentRateLimits[0] === "object" ? currentRateLimits[0] : null;
  const currentRequests = Number(currentPrimary?.requests ?? currentPrimary?.limit) || 60;
  const currentWindowSize = Number(currentPrimary?.window?.size ?? currentPrimary?.window?.value) || 1;
  const currentWindowUnit = String(currentPrimary?.window?.unit || "minute").trim() || "minute";
  const existingBucketsBySourceId = new Map(
    currentRateLimits
      .map((bucket) => [String(bucket?.id || "").trim(), bucket])
      .filter(([bucketId]) => Boolean(bucketId))
  );

  nextProvider.rateLimits = buildRateLimitBucketsFromDraftRows(draftRows, {
    existingBucketsBySourceId,
    fallbackRequests: currentRequests,
    fallbackWindowValue: currentWindowSize,
    fallbackWindowUnit: currentWindowUnit
  });
  return nextProvider;
}

function rewriteAliasReference(ref, fromAliasId, toAliasId = "") {
  const text = String(ref || "").trim();
  if (!text) return "";
  if (text === fromAliasId) return toAliasId;
  if (text === `alias:${fromAliasId}`) return toAliasId ? `alias:${toAliasId}` : "";
  return text;
}

function rewriteAliasTargetList(targets = [], rewriter) {
  const seenRefs = new Set();
  const nextTargets = [];

  for (const target of (Array.isArray(targets) ? targets : [])) {
    const currentRef = String(target?.ref || "").trim();
    if (!currentRef) continue;
    const nextRef = String(rewriter(currentRef) || "").trim();
    if (!nextRef || seenRefs.has(nextRef)) continue;
    seenRefs.add(nextRef);
    nextTargets.push({
      ...target,
      ref: nextRef
    });
  }

  return nextTargets;
}

function cleanupAliasReferences(config = {}) {
  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};
  const nextAliases = {};

  for (const [aliasId, alias] of Object.entries(aliases)) {
    const targets = rewriteAliasTargetList(alias?.targets || [], (ref) => ref);
    const fallbackTargets = rewriteAliasTargetList(alias?.fallbackTargets || [], (ref) => ref);
    nextAliases[aliasId] = {
      ...alias,
      targets,
      fallbackTargets
    };
  }

  config.modelAliases = nextAliases;
  return ensureTopLevelRoutes(config);
}

function normalizeProviderModelRows(rows = []) {
  const seenIds = new Set();
  const normalizedRows = [];

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const id = String(row?.id || "").trim();
    const sourceId = String(row?.sourceId || row?.originalId || "").trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    normalizedRows.push({ id, sourceId });
  }

  return normalizedRows;
}

function normalizeAliasTargetRows(rows = []) {
  const seenRefs = new Set();
  const normalizedRows = [];

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const ref = String(row?.ref || "").trim();
    const sourceRef = String(row?.sourceRef || row?.originalRef || "").trim();
    const rawWeight = String(row?.weight ?? "").trim();
    const parsedWeight = Math.floor(Number(rawWeight));
    if (!ref || seenRefs.has(ref)) continue;
    seenRefs.add(ref);
    normalizedRows.push({
      ref,
      sourceRef,
      ...(rawWeight ? { weight: (Number.isFinite(parsedWeight) && parsedWeight > 0 ? parsedWeight : 1) } : {})
    });
  }

  return normalizedRows;
}

export function applyProviderModelEdits(config = {}, providerId, rows = []) {
  const nextConfig = safeClone(config);
  const providerList = Array.isArray(nextConfig.providers) ? nextConfig.providers : [];
  const providerIndex = providerList.findIndex((provider) => provider?.id === providerId);
  if (providerIndex === -1) return nextConfig;

  const provider = providerList[providerIndex];
  const existingModels = Array.isArray(provider?.models) ? provider.models : [];
  const existingModelMap = new Map(existingModels.map((model) => [String(model?.id || "").trim(), model]));
  const normalizedRows = normalizeProviderModelRows(rows);
  const usedSourceIds = new Set();
  const renameMap = new Map();
  const nextModels = [];

  for (const row of normalizedRows) {
    const existingBySourceId = row.sourceId && existingModelMap.has(row.sourceId) && !usedSourceIds.has(row.sourceId)
      ? row.sourceId
      : "";
    const existingByCurrentId = !existingBySourceId && existingModelMap.has(row.id) && !usedSourceIds.has(row.id)
      ? row.id
      : "";
    const matchedSourceId = existingBySourceId || existingByCurrentId;

    if (matchedSourceId) {
      usedSourceIds.add(matchedSourceId);
      if (matchedSourceId !== row.id) {
        renameMap.set(matchedSourceId, row.id);
      }
      nextModels.push({
        ...existingModelMap.get(matchedSourceId),
        id: row.id
      });
      continue;
    }

    nextModels.push({ id: row.id });
  }

  const validModelIds = new Set(nextModels.map((model) => String(model?.id || "").trim()).filter(Boolean));

  provider.models = nextModels;
  provider.rateLimits = (Array.isArray(provider.rateLimits) ? provider.rateLimits : []).map((bucket) => {
    const bucketModels = Array.isArray(bucket?.models) ? bucket.models : [];
    return {
      ...bucket,
      models: dedupeStrings(bucketModels.map((modelId) => {
        if (String(modelId || "").trim() === "all") return "all";
        const nextModelId = renameMap.get(String(modelId || "").trim()) || String(modelId || "").trim();
        return validModelIds.has(nextModelId) ? nextModelId : "";
      }))
    };
  });

  nextConfig.providers = providerList.map((entry, index) => (index === providerIndex ? provider : entry)).map((entry) => ({
    ...entry,
    models: (Array.isArray(entry?.models) ? entry.models : []).map((model) => {
      if (!Array.isArray(model?.fallbackModels)) return model;
      return {
        ...model,
        fallbackModels: dedupeStrings(model.fallbackModels.map((ref) => rewriteProviderModelRef(ref, providerId, renameMap, validModelIds)))
      };
    })
  }));

  const existingAliases = nextConfig.modelAliases && typeof nextConfig.modelAliases === "object" && !Array.isArray(nextConfig.modelAliases)
    ? nextConfig.modelAliases
    : {};
  const nextAliases = {};

  for (const [aliasId, alias] of Object.entries(existingAliases)) {
    const targets = rewriteAliasTargetList(alias?.targets || [], (ref) => rewriteProviderModelRef(ref, providerId, renameMap, validModelIds));
    const fallbackTargets = rewriteAliasTargetList(alias?.fallbackTargets || [], (ref) => rewriteProviderModelRef(ref, providerId, renameMap, validModelIds));
    nextAliases[aliasId] = {
      ...alias,
      targets,
      fallbackTargets
    };
  }

  nextConfig.modelAliases = nextAliases;
  nextConfig.defaultModel = rewriteProviderModelRef(nextConfig.defaultModel, providerId, renameMap, validModelIds);
  if (nextConfig?.amp && typeof nextConfig.amp === "object" && !Array.isArray(nextConfig.amp)) {
    nextConfig.amp.defaultRoute = rewriteProviderModelRef(nextConfig.amp.defaultRoute, providerId, renameMap, validModelIds);
  }

  return ensureTopLevelRoutes(nextConfig);
}

export function applyProviderInlineEdits(config = {}, currentProviderId = "", draftProvider = {}) {
  const nextConfig = safeClone(config);
  const providerList = Array.isArray(nextConfig.providers) ? nextConfig.providers : [];
  const providerIndex = providerList.findIndex((provider) => provider?.id === currentProviderId);
  if (providerIndex === -1) return nextConfig;

  const currentProvider = providerList[providerIndex] || {};
  const nextProviderId = String(draftProvider?.id || currentProviderId || "").trim();
  const nextProviderName = String(draftProvider?.name ?? currentProvider?.name ?? "").trim();
  const nextEndpoints = normalizeEndpointCandidates(
    Array.isArray(draftProvider?.endpoints) ? draftProvider.endpoints : [draftProvider?.endpoint]
  );
  const isSubscription = currentProvider?.type === "subscription";
  const renamedProviderId = nextProviderId || currentProviderId;

  let nextProvider = {
    ...currentProvider,
    id: renamedProviderId,
    name: nextProviderName || renamedProviderId
  };

  if (!isSubscription) {
    nextProvider = rewriteProviderEndpoints(nextProvider, nextEndpoints);
    nextProvider = rewriteRateLimits(nextProvider, draftProvider, renamedProviderId);
  }

  providerList[providerIndex] = nextProvider;
  nextConfig.providers = providerList.map((provider) => ({
    ...provider,
    models: (Array.isArray(provider?.models) ? provider.models : []).map((model) => {
      if (!Array.isArray(model?.fallbackModels)) return model;
      return {
        ...model,
        fallbackModels: dedupeStrings(model.fallbackModels.map((ref) => rewriteProviderReference(ref, currentProviderId, renamedProviderId)))
      };
    })
  }));

  if (renamedProviderId !== currentProviderId) {
    const aliasMap = nextConfig.modelAliases && typeof nextConfig.modelAliases === "object" && !Array.isArray(nextConfig.modelAliases)
      ? nextConfig.modelAliases
      : {};
    const nextAliases = {};

    for (const [aliasId, alias] of Object.entries(aliasMap)) {
      nextAliases[aliasId] = {
        ...alias,
        targets: rewriteAliasTargetList(alias?.targets || [], (ref) => rewriteProviderReference(ref, currentProviderId, renamedProviderId)),
        fallbackTargets: rewriteAliasTargetList(alias?.fallbackTargets || [], (ref) => rewriteProviderReference(ref, currentProviderId, renamedProviderId))
      };
    }

    nextConfig.modelAliases = nextAliases;
    nextConfig.defaultModel = rewriteProviderReference(nextConfig.defaultModel, currentProviderId, renamedProviderId);
    if (nextConfig?.amp && typeof nextConfig.amp === "object" && !Array.isArray(nextConfig.amp)) {
      nextConfig.amp.defaultRoute = rewriteProviderReference(nextConfig.amp.defaultRoute, currentProviderId, renamedProviderId);
    }
  }

  return ensureTopLevelRoutes(nextConfig);
}

export function applyModelAliasEdits(config = {}, currentAliasId = "", draftAlias = {}) {
  const nextConfig = safeClone(config);
  const aliasMap = nextConfig.modelAliases && typeof nextConfig.modelAliases === "object" && !Array.isArray(nextConfig.modelAliases)
    ? nextConfig.modelAliases
    : {};
  const existingAlias = currentAliasId ? aliasMap[currentAliasId] : undefined;
  const nextAliasId = currentAliasId === DEFAULT_MODEL_ALIAS_ID
    ? DEFAULT_MODEL_ALIAS_ID
    : String(draftAlias?.id || currentAliasId || "").trim();
  if (!nextAliasId) return nextConfig;

  const currentTargetsByRef = new Map((existingAlias?.targets || []).map((target) => [String(target?.ref || "").trim(), target]));
  const currentFallbackTargetsByRef = new Map((existingAlias?.fallbackTargets || []).map((target) => [String(target?.ref || "").trim(), target]));

  const usedPrimarySources = new Set();
  const targets = normalizeAliasTargetRows(draftAlias?.targets).map((row) => {
    const matchedSourceRef = row.sourceRef && currentTargetsByRef.has(row.sourceRef) && !usedPrimarySources.has(row.sourceRef)
      ? row.sourceRef
      : (currentTargetsByRef.has(row.ref) && !usedPrimarySources.has(row.ref) ? row.ref : "");
    if (matchedSourceRef) usedPrimarySources.add(matchedSourceRef);
    return {
      ...(matchedSourceRef ? currentTargetsByRef.get(matchedSourceRef) : {}),
      ref: row.ref,
      ...(row.weight !== undefined ? { weight: row.weight } : {})
    };
  });

  const usedFallbackSources = new Set();
  const fallbackTargets = normalizeAliasTargetRows(draftAlias?.fallbackTargets).map((row) => {
    const matchedSourceRef = row.sourceRef && currentFallbackTargetsByRef.has(row.sourceRef) && !usedFallbackSources.has(row.sourceRef)
      ? row.sourceRef
      : (currentFallbackTargetsByRef.has(row.ref) && !usedFallbackSources.has(row.ref) ? row.ref : "");
    if (matchedSourceRef) usedFallbackSources.add(matchedSourceRef);
    return {
      ...(matchedSourceRef ? currentFallbackTargetsByRef.get(matchedSourceRef) : {}),
      ref: row.ref,
      ...(row.weight !== undefined ? { weight: row.weight } : {})
    };
  });

  if (currentAliasId && currentAliasId !== nextAliasId) {
    delete aliasMap[currentAliasId];
  }

  aliasMap[nextAliasId] = {
    ...(existingAlias?.metadata ? { metadata: existingAlias.metadata } : {}),
    ...(draftAlias?.metadata && typeof draftAlias.metadata === "object" && !Array.isArray(draftAlias.metadata)
      ? { metadata: draftAlias.metadata }
      : {}),
    id: nextAliasId,
    strategy: String(draftAlias?.strategy || existingAlias?.strategy || "ordered").trim() || "ordered",
    targets,
    fallbackTargets
  };

  nextConfig.modelAliases = aliasMap;

  if (currentAliasId && currentAliasId !== nextAliasId) {
    for (const [aliasId, alias] of Object.entries(aliasMap)) {
      if (aliasId === nextAliasId) continue;
      alias.targets = rewriteAliasTargetList(alias?.targets || [], (ref) => rewriteAliasReference(ref, currentAliasId, nextAliasId));
      alias.fallbackTargets = rewriteAliasTargetList(alias?.fallbackTargets || [], (ref) => rewriteAliasReference(ref, currentAliasId, nextAliasId));
    }
    nextConfig.defaultModel = rewriteAliasReference(nextConfig.defaultModel, currentAliasId, nextAliasId);
    if (nextConfig?.amp && typeof nextConfig.amp === "object" && !Array.isArray(nextConfig.amp)) {
      nextConfig.amp.defaultRoute = rewriteAliasReference(nextConfig.amp.defaultRoute, currentAliasId, nextAliasId);
    }
  }

  return cleanupAliasReferences(nextConfig);
}

export function removeModelAlias(config = {}, aliasId = "") {
  const nextConfig = safeClone(config);
  const targetAliasId = String(aliasId || "").trim();
  if (!targetAliasId) return nextConfig;

  const aliasMap = nextConfig.modelAliases && typeof nextConfig.modelAliases === "object" && !Array.isArray(nextConfig.modelAliases)
    ? nextConfig.modelAliases
    : {};
  if (!Object.prototype.hasOwnProperty.call(aliasMap, targetAliasId)) return nextConfig;

  if (targetAliasId === DEFAULT_MODEL_ALIAS_ID) {
    aliasMap[targetAliasId] = {
      ...aliasMap[targetAliasId],
      id: DEFAULT_MODEL_ALIAS_ID,
      strategy: String(aliasMap[targetAliasId]?.strategy || "ordered").trim() || "ordered",
      targets: [],
      fallbackTargets: []
    };
    nextConfig.modelAliases = aliasMap;
    return ensureTopLevelRoutes(nextConfig);
  }

  delete aliasMap[targetAliasId];
  nextConfig.modelAliases = aliasMap;

  for (const alias of Object.values(aliasMap)) {
    alias.targets = rewriteAliasTargetList(alias?.targets || [], (ref) => rewriteAliasReference(ref, targetAliasId));
    alias.fallbackTargets = rewriteAliasTargetList(alias?.fallbackTargets || [], (ref) => rewriteAliasReference(ref, targetAliasId));
  }

  nextConfig.defaultModel = rewriteAliasReference(nextConfig.defaultModel, targetAliasId);
  if (nextConfig?.amp && typeof nextConfig.amp === "object" && !Array.isArray(nextConfig.amp)) {
    nextConfig.amp.defaultRoute = rewriteAliasReference(nextConfig.amp.defaultRoute, targetAliasId);
  }

  return cleanupAliasReferences(nextConfig);
}

export function createAliasDraftState(aliasId = "", alias = {}) {
  return {
    id: String(aliasId || alias?.id || "").trim(),
    strategy: String(alias?.strategy || "ordered").trim() || "ordered",
    targets: (Array.isArray(alias?.targets) ? alias.targets : []).map((target, index) => ({
      key: `target-${aliasId || "alias"}-${index}-${String(target?.ref || "").trim() || "empty"}`,
      ref: String(target?.ref || "").trim(),
      sourceRef: String(target?.ref || "").trim(),
      weight: String(Number.isFinite(Number(target?.weight)) && Number(target.weight) > 0 ? Math.floor(Number(target.weight)) : 1)
    })),
    fallbackTargets: (Array.isArray(alias?.fallbackTargets) ? alias.fallbackTargets : []).map((target, index) => ({
      key: `fallback-${aliasId || "alias"}-${index}-${String(target?.ref || "").trim() || "empty"}`,
      ref: String(target?.ref || "").trim(),
      sourceRef: String(target?.ref || "").trim(),
      weight: String(Number.isFinite(Number(target?.weight)) && Number(target.weight) > 0 ? Math.floor(Number(target.weight)) : 1)
    }))
  };
}

export function createProviderModelDraftRows(provider = {}) {
  return (Array.isArray(provider?.models) ? provider.models : []).map((model, index) => ({
    key: `model-${provider?.id || "provider"}-${index}-${String(model?.id || "").trim() || "empty"}`,
    id: String(model?.id || "").trim(),
    sourceId: String(model?.id || "").trim()
  }));
}
