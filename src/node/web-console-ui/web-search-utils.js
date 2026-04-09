import { AMP_WEB_SEARCH_PROVIDER_OPTIONS, AMP_WEB_SEARCH_PROVIDER_META, AMP_WEB_SEARCH_DEFAULT_COUNT, AMP_WEB_SEARCH_MIN_COUNT, AMP_WEB_SEARCH_MAX_COUNT } from "./constants.js";
import { ensureAmpDraftConfigShape, parseAmpWebSearchInteger } from "./amp-utils.js";
import { safeClone } from "./utils.js";

export function ensureWebSearchConfigShape(config = {}) {
  const next = config && typeof config === "object" && !Array.isArray(config)
    ? config
    : {};
  const legacyWebSearch = next.amp?.webSearch && typeof next.amp.webSearch === "object" && !Array.isArray(next.amp.webSearch)
    ? safeClone(next.amp.webSearch)
    : null;

  if (!next.webSearch || typeof next.webSearch !== "object" || Array.isArray(next.webSearch)) {
    next.webSearch = legacyWebSearch || {};
  }

  if (next.amp && typeof next.amp === "object" && !Array.isArray(next.amp) && Object.prototype.hasOwnProperty.call(next.amp, "webSearch")) {
    delete next.amp.webSearch;
  }

  const strategy = String(next.webSearch.strategy || "").trim();
  next.webSearch.strategy = strategy === "quota-balance" ? "quota-balance" : "ordered";
  if (next.webSearch.count !== undefined && next.webSearch.count !== null && String(next.webSearch.count).trim() !== "") {
    next.webSearch.count = parseAmpWebSearchInteger(next.webSearch.count, AMP_WEB_SEARCH_DEFAULT_COUNT, {
      min: AMP_WEB_SEARCH_MIN_COUNT,
      max: AMP_WEB_SEARCH_MAX_COUNT
    });
  } else {
    delete next.webSearch.count;
  }
  if (!Array.isArray(next.webSearch.providers)) {
    next.webSearch.providers = [];
  }
  return next.webSearch;
}

export function isHostedWebSearchProviderId(value = "") {
  const text = String(value || "").trim();
  return text.includes("/");
}

export function normalizeWebSearchProviderKey(value = "") {
  const text = String(value || "").trim();
  return isHostedWebSearchProviderId(text) ? text : text.toLowerCase();
}

export function buildHostedWebSearchProviderId(providerId = "", modelId = "") {
  const normalizedProviderId = String(providerId || "").trim();
  const normalizedModelId = String(modelId || "").trim();
  if (!normalizedProviderId || !normalizedModelId) return "";
  return `${normalizedProviderId}/${normalizedModelId}`;
}

export function getWebSearchProviderFormats(provider = {}) {
  return [...new Set(
    [provider?.format, ...(Array.isArray(provider?.formats) ? provider.formats : [])]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value === "openai" || value === "claude")
  )];
}

export function getWebSearchModelFormats(provider = {}, model = {}) {
  const modelId = String(model?.id || "").trim();
  const preferredFormat = modelId ? String(provider?.lastProbe?.modelPreferredFormat?.[modelId] || "").trim().toLowerCase() : "";
  if (preferredFormat === "openai" || preferredFormat === "claude") {
    return [preferredFormat];
  }

  const probedFormats = modelId
    ? [...new Set(
      (Array.isArray(provider?.lastProbe?.modelSupport?.[modelId]) ? provider.lastProbe.modelSupport[modelId] : [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter((value) => value === "openai" || value === "claude")
    )]
    : [];
  if (probedFormats.length > 0) return probedFormats;

  return [...new Set(
    [model?.format, ...(Array.isArray(model?.formats) ? model.formats : [])]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value === "openai" || value === "claude")
  )];
}

export function providerHasHostedWebSearchConnection(provider = {}) {
  const subscriptionType = String(provider?.subscriptionType || provider?.subscription_type || "").trim().toLowerCase();
  if (String(provider?.type || "").trim().toLowerCase() === "subscription") {
    return subscriptionType === "chatgpt-codex";
  }

  const providerFormats = getWebSearchProviderFormats(provider);
  if (!providerFormats.includes("openai")) return false;
  return Boolean(String(provider?.baseUrlByFormat?.openai || provider?.baseUrl || "").trim());
}

export function providerHasHostedWebSearchAuth(provider = {}) {
  if (String(provider?.type || "").trim().toLowerCase() === "subscription") {
    return String(provider?.subscriptionType || provider?.subscription_type || "").trim().toLowerCase() === "chatgpt-codex";
  }
  if (String(provider?.apiKey || "").trim() || String(provider?.apiKeyEnv || "").trim()) return true;
  if (String(provider?.auth?.type || "").trim().toLowerCase() === "none") return true;

  return Object.keys(provider?.headers && typeof provider.headers === "object" ? provider.headers : {})
    .some((key) => {
      const normalized = String(key || "").trim().toLowerCase();
      return normalized === "authorization" || normalized === "x-api-key";
    });
}

export function modelSupportsHostedWebSearch(provider = {}, model = {}) {
  if (!providerHasHostedWebSearchConnection(provider)) return false;
  const modelFormats = getWebSearchModelFormats(provider, model);
  return modelFormats.length === 0 || modelFormats.includes("openai");
}

export function hasWebSearchDraftField(entry = {}, keys = []) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(entry, key) && entry[key] !== undefined && entry[key] !== null && String(entry[key]).trim() !== "");
}

export function normalizeBuiltinWebSearchProviderDraft(entry = {}, explicitId = "") {
  const providerId = String(explicitId || entry?.id || "").trim().toLowerCase();
  const providerMeta = AMP_WEB_SEARCH_PROVIDER_META[providerId];
  if (!providerMeta) return null;

  const credentialField = providerMeta.credentialField;
  const credentialValue = String(entry?.[credentialField] || "").trim();
  const hasExplicitCount = hasWebSearchDraftField(entry, ["count", "resultCount", "result-count", "resultsPerCall", "results-per-call"]);
  const hasExplicitLimit = hasWebSearchDraftField(entry, ["limit", "monthlyLimit", "monthly-limit", "quota"]);
  const hasExplicitRemaining = hasWebSearchDraftField(entry, ["remaining", "remainingQuota", "remaining-quota", "remainingQueries", "remaining-queries"]);
  const includeQuotaDefaults = Boolean(credentialValue) || hasExplicitLimit || hasExplicitRemaining;
  const defaultLimit = includeQuotaDefaults ? (Number(providerMeta.defaultLimit) || 0) : 0;
  const count = parseAmpWebSearchInteger(
    entry?.count ?? entry?.resultCount ?? entry?.["result-count"] ?? entry?.resultsPerCall ?? entry?.["results-per-call"],
    AMP_WEB_SEARCH_DEFAULT_COUNT,
    { min: AMP_WEB_SEARCH_MIN_COUNT, max: AMP_WEB_SEARCH_MAX_COUNT }
  );
  const limit = parseAmpWebSearchInteger(entry?.limit, defaultLimit, { min: 0 });
  const remainingFallback = limit > 0 ? limit : 0;
  const remaining = parseAmpWebSearchInteger(entry?.remaining, remainingFallback, { min: 0 });

  return {
    kind: "builtin",
    id: providerId,
    [credentialField]: credentialValue,
    ...(hasExplicitCount && count !== AMP_WEB_SEARCH_DEFAULT_COUNT ? { count } : {}),
    ...(hasExplicitLimit || (includeQuotaDefaults && limit > 0) ? { limit } : {}),
    ...(hasExplicitRemaining || (includeQuotaDefaults && (limit > 0 || remaining > 0))
      ? { remaining: limit > 0 ? Math.min(remaining, limit) : remaining }
      : {})
  };
}

export function normalizeHostedWebSearchProviderDraft(entry = {}, explicitId = "") {
  const routeId = String(
    explicitId
    || entry?.id
    || buildHostedWebSearchProviderId(entry?.providerId ?? entry?.provider, entry?.model ?? entry?.modelId)
  ).trim();
  if (!isHostedWebSearchProviderId(routeId)) return null;
  const providerId = String(entry?.providerId ?? entry?.provider ?? routeId.slice(0, routeId.indexOf("/"))).trim();
  const modelId = String(entry?.model ?? entry?.modelId ?? routeId.slice(routeId.indexOf("/") + 1)).trim();
  const normalizedRouteId = buildHostedWebSearchProviderId(providerId, modelId);
  if (!normalizedRouteId || normalizedRouteId !== routeId) return null;

  return {
    kind: "hosted",
    id: normalizedRouteId,
    providerId,
    model: modelId
  };
}

export function normalizeWebSearchProviderDraft(entry = {}, explicitId = "") {
  return normalizeHostedWebSearchProviderDraft(entry, explicitId)
    || normalizeBuiltinWebSearchProviderDraft(entry, explicitId);
}

export function buildHostedWebSearchCandidateGroups(config = {}, existingIds = new Set()) {
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  return providers
    .map((provider) => {
      const providerId = String(provider?.id || "").trim();
      if (!providerId || provider?.enabled === false || !providerHasHostedWebSearchConnection(provider) || !providerHasHostedWebSearchAuth(provider)) {
        return null;
      }
      const models = (Array.isArray(provider?.models) ? provider.models : [])
        .map((model) => {
          const modelId = String(model?.id || "").trim();
          const routeId = buildHostedWebSearchProviderId(providerId, modelId);
          if (!modelId || !routeId || existingIds.has(routeId)) return null;
          if (!modelSupportsHostedWebSearch(provider, model)) return null;
          if (!modelId.toLowerCase().includes("gpt")) return null;
          return {
            value: modelId,
            label: modelId,
            routeId
          };
        })
        .filter(Boolean);
      if (models.length === 0) return null;
      return {
        providerId,
        providerLabel: String(provider?.name || providerId).trim() || providerId,
        providerHint: String(provider?.subscriptionType || "").trim().toLowerCase() === "chatgpt-codex"
          ? "ChatGPT subscription"
          : (String(provider?.baseUrlByFormat?.openai || provider?.baseUrl || "").trim() || "OpenAI-compatible endpoint"),
        models
      };
    })
    .filter(Boolean);
}

export function buildWebSearchProviderRows(config = {}, snapshot = null) {
  const nextConfig = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(nextConfig);
  const configuredProviders = Array.isArray(webSearch.providers)
    ? webSearch.providers
        .map((provider) => normalizeWebSearchProviderDraft(provider, provider?.id))
        .filter(Boolean)
    : [];
  const configuredIds = new Set(configuredProviders.map((provider) => normalizeWebSearchProviderKey(provider.id)));
  const orderedProviders = [
    ...configuredProviders,
    ...AMP_WEB_SEARCH_PROVIDER_OPTIONS
      .filter((provider) => !configuredIds.has(provider.id))
      .map((provider) => normalizeBuiltinWebSearchProviderDraft({ id: provider.id }, provider.id))
      .filter(Boolean)
  ];
  const snapshotProviders = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
  const snapshotById = new Map(
    snapshotProviders
      .map((provider) => [normalizeWebSearchProviderKey(provider?.id), provider])
      .filter(([providerId]) => Boolean(providerId))
  );
  const providerConfigById = new Map(
    (Array.isArray(config?.providers) ? config.providers : [])
      .map((provider) => [String(provider?.id || "").trim(), provider])
      .filter(([providerId]) => Boolean(providerId))
  );
  const fallbackCount = parseAmpWebSearchInteger(webSearch?.count, AMP_WEB_SEARCH_DEFAULT_COUNT, {
    min: AMP_WEB_SEARCH_MIN_COUNT,
    max: AMP_WEB_SEARCH_MAX_COUNT
  });

  return orderedProviders.map((provider) => {
    const normalizedId = normalizeWebSearchProviderKey(provider.id);
    const runtimeState = snapshotById.get(normalizedId) || null;
    const configuredIndex = configuredProviders.findIndex((entry) => normalizeWebSearchProviderKey(entry.id) === normalizedId);
    const displayIndex = orderedProviders.findIndex((entry) => normalizeWebSearchProviderKey(entry.id) === normalizedId);
    const isReady = provider.kind === "hosted"
      ? runtimeState?.ready !== false
      : Boolean(provider?.[AMP_WEB_SEARCH_PROVIDER_META[provider.id]?.credentialField || "apiKey"]);

    if (provider.kind === "hosted") {
      const sourceProvider = providerConfigById.get(provider.providerId) || null;
      return {
        id: provider.id,
        key: provider.id,
        kind: "hosted",
        label: String(sourceProvider?.name || provider.providerId).trim() || provider.providerId,
        providerId: provider.providerId,
        modelId: provider.model,
        routeId: provider.id,
        configured: true,
        configuredIndex,
        configuredCount: configuredProviders.length,
        displayIndex,
        displayCount: orderedProviders.length,
        active: isReady,
        runtimeState
      };
    }

    const providerMeta = AMP_WEB_SEARCH_PROVIDER_META[provider.id];
    const credentialField = providerMeta?.credentialField || "apiKey";
    const credentialValue = String(provider?.[credentialField] || "").trim();
    const hasExplicitCount = hasWebSearchDraftField(provider, ["count"]);
    const resultPerCall = parseAmpWebSearchInteger(provider?.count, fallbackCount, {
      min: AMP_WEB_SEARCH_MIN_COUNT,
      max: AMP_WEB_SEARCH_MAX_COUNT
    });
    return {
      id: provider.id,
      key: provider.id,
      kind: "builtin",
      label: providerMeta?.label || provider.id,
      credentialField,
      credentialLabel: providerMeta?.credentialLabel || "Credential",
      credentialPlaceholder: providerMeta?.credentialPlaceholder || "",
      credentialValue,
      resultPerCall,
      resultPerCallInput: hasExplicitCount
        ? String(resultPerCall)
        : (fallbackCount !== AMP_WEB_SEARCH_DEFAULT_COUNT ? String(fallbackCount) : ""),
      limit: parseAmpWebSearchInteger(provider?.limit, providerMeta?.defaultLimit || 0, { min: 0 }),
      remaining: parseAmpWebSearchInteger(provider?.remaining, providerMeta?.defaultLimit || 0, { min: 0 }),
      configured: Boolean(credentialValue),
      configuredIndex,
      configuredCount: configuredProviders.length,
      displayIndex,
      displayCount: orderedProviders.length,
      active: isReady,
      runtimeState
    };
  });
}

export function updateWebSearchConfig(config = {}, updates = {}) {
  const next = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(next);
  if (updates.strategy !== undefined) {
    webSearch.strategy = String(updates.strategy || "").trim() === "quota-balance" ? "quota-balance" : "ordered";
  }
  if (updates.count !== undefined) {
    webSearch.count = parseAmpWebSearchInteger(updates.count, webSearch.count, { min: 1, max: 20 });
  }
  return next;
}

export function updateWebSearchProviderConfig(config = {}, providerId, updates = {}) {
  const normalizedProviderId = String(providerId || "").trim().toLowerCase();
  if (!AMP_WEB_SEARCH_PROVIDER_META[normalizedProviderId]) return ensureAmpDraftConfigShape(config);

  const next = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(next);
  const existingProviders = Array.isArray(webSearch.providers) ? webSearch.providers.slice() : [];
  const existingIndex = existingProviders.findIndex((provider) => normalizeWebSearchProviderKey(provider?.id) === normalizedProviderId);
  const existingProvider = existingIndex >= 0 ? existingProviders[existingIndex] : null;
  const baseProvider = normalizeBuiltinWebSearchProviderDraft(
    existingProvider || { id: normalizedProviderId },
    normalizedProviderId
  ) || normalizeBuiltinWebSearchProviderDraft({ id: normalizedProviderId }, normalizedProviderId);
  const providerMeta = AMP_WEB_SEARCH_PROVIDER_META[normalizedProviderId];
  const credentialField = providerMeta.credentialField;
  const mergedProvider = normalizeBuiltinWebSearchProviderDraft({
    ...(existingProvider && typeof existingProvider === "object" && !Array.isArray(existingProvider) ? existingProvider : {}),
    ...baseProvider,
    ...updates,
    id: normalizedProviderId,
    [credentialField]: updates[credentialField] !== undefined ? String(updates[credentialField] || "").trim() : baseProvider?.[credentialField]
  }, normalizedProviderId);
  const hasCredential = Boolean(String(mergedProvider?.[credentialField] || "").trim());
  const shouldPersistCount = hasWebSearchDraftField(updates, ["count"])
    ? Boolean(String(updates?.count || "").trim()) && Number(mergedProvider?.count) !== AMP_WEB_SEARCH_DEFAULT_COUNT
    : hasWebSearchDraftField(existingProvider, ["count"]) && Number(mergedProvider?.count) !== AMP_WEB_SEARCH_DEFAULT_COUNT;
  const shouldPersistLimit = hasCredential
    || hasWebSearchDraftField(updates, ["limit"])
    || hasWebSearchDraftField(existingProvider, ["limit"]);
  const shouldPersistRemaining = hasCredential
    || hasWebSearchDraftField(updates, ["remaining"])
    || hasWebSearchDraftField(existingProvider, ["remaining"]);

  const persistedProvider = {
    id: normalizedProviderId,
    ...(hasCredential ? { [credentialField]: String(mergedProvider?.[credentialField] || "").trim() } : {}),
    ...(shouldPersistCount ? { count: Number(mergedProvider.count) } : {}),
    ...(shouldPersistLimit && Number(mergedProvider?.limit) > 0 ? { limit: Number(mergedProvider.limit) } : {}),
    ...(shouldPersistRemaining && (Number(mergedProvider?.limit) > 0 || Number(mergedProvider?.remaining) > 0)
      ? { remaining: Number(mergedProvider.remaining) }
      : {})
  };

  if (existingIndex >= 0) {
    existingProviders[existingIndex] = persistedProvider;
  } else {
    existingProviders.push(persistedProvider);
  }
  webSearch.providers = existingProviders;
  return next;
}

export function addHostedWebSearchProviderConfig(config = {}, providerId, modelId) {
  const routeId = buildHostedWebSearchProviderId(providerId, modelId);
  if (!routeId) return ensureAmpDraftConfigShape(config);

  const next = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(next);
  const providers = Array.isArray(webSearch.providers) ? webSearch.providers.slice() : [];
  const routeKey = normalizeWebSearchProviderKey(routeId);
  if (providers.some((provider) => normalizeWebSearchProviderKey(provider?.id) === routeKey)) {
    return next;
  }
  providers.push({
    id: routeId,
    providerId: String(providerId || "").trim(),
    model: String(modelId || "").trim()
  });
  webSearch.providers = providers;
  return next;
}

export function removeWebSearchProviderConfig(config = {}, providerId) {
  const normalizedProviderId = normalizeWebSearchProviderKey(providerId);
  const next = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(next);
  const providers = Array.isArray(webSearch.providers) ? webSearch.providers.slice() : [];
  const filteredProviders = providers.filter((provider) => normalizeWebSearchProviderKey(provider?.id) !== normalizedProviderId);
  if (filteredProviders.length === providers.length) return next;
  webSearch.providers = filteredProviders;
  return next;
}

export function moveWebSearchProviderConfig(config = {}, providerId, direction = "up") {
  const normalizedProviderId = normalizeWebSearchProviderKey(providerId);
  const next = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(next);
  const providers = Array.isArray(webSearch.providers) ? webSearch.providers.slice() : [];
  const providerById = new Map(
    providers.map((provider) => [normalizeWebSearchProviderKey(provider?.id), provider]).filter(([id]) => Boolean(id))
  );
  const currentIndex = providers.findIndex((provider) => normalizeWebSearchProviderKey(provider?.id) === normalizedProviderId);

  if (currentIndex !== -1) {
    const targetIndex = direction === "down" ? currentIndex + 1 : currentIndex - 1;
    if (targetIndex < 0 || targetIndex >= providers.length) return next;
    const [movedProvider] = providers.splice(currentIndex, 1);
    providers.splice(targetIndex, 0, movedProvider);
    webSearch.providers = providers;
    return next;
  }

  if (!AMP_WEB_SEARCH_PROVIDER_META[normalizedProviderId]) return next;

  const displayOrder = [
    ...providers.map((provider) => normalizeWebSearchProviderKey(provider?.id)).filter(Boolean),
    ...AMP_WEB_SEARCH_PROVIDER_OPTIONS
      .map((provider) => provider.id)
      .filter((id) => !providerById.has(id))
  ];
  const displayIndex = displayOrder.indexOf(normalizedProviderId);
  if (displayIndex === -1) return next;
  const targetIndex = direction === "down" ? displayIndex + 1 : displayIndex - 1;
  if (targetIndex < 0 || targetIndex >= displayOrder.length) return next;
  const reordered = displayOrder.slice();
  const [movedProviderId] = reordered.splice(displayIndex, 1);
  reordered.splice(targetIndex, 0, movedProviderId);

  const persistedIds = new Set(providerById.keys());
  persistedIds.add(normalizedProviderId);
  for (const id of reordered.slice(0, targetIndex + 1)) {
    if (AMP_WEB_SEARCH_PROVIDER_META[id]) persistedIds.add(id);
  }

  webSearch.providers = reordered
    .filter((id) => persistedIds.has(id))
    .map((id) => providerById.get(id) || { id });
  return next;
}

export function shouldImmediateAutosaveWebSearchProviderChange(providerId, field, value) {
  const normalizedProviderId = String(providerId || "").trim().toLowerCase();
  const providerMeta = AMP_WEB_SEARCH_PROVIDER_META[normalizedProviderId];
  if (!providerMeta) return false;
  if (String(field || "").trim() !== providerMeta.credentialField) return false;
  return !String(value || "").trim();
}

// ── Internal dependency note ──
// safeClone is used by ensureWebSearchConfigShape and resolves from app.jsx scope.
