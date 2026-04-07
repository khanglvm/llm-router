import { CONTEXT_LOOKUP_SUGGESTION_LIMIT } from "./constants.js";

export function formatContextWindow(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return "Unknown";
  if (normalized >= 1000) {
    const roundedK = normalized / 1000;
    const rendered = Number.isInteger(roundedK) ? String(roundedK) : roundedK.toFixed(1).replace(/\.0$/, "");
    return `${rendered}K`;
  }
  return String(normalized);
}

export function formatCompactContextWindowInput(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return "";

  const units = [
    { suffix: "M", divisor: 1000 * 1000 },
    { suffix: "K", divisor: 1000 }
  ];

  for (const unit of units) {
    if (normalized < unit.divisor) continue;
    const scaledValue = normalized / unit.divisor;
    const renderedValue = scaledValue >= 10
      ? String(Math.round(scaledValue))
      : scaledValue.toFixed(1).replace(/\.0$/, "");
    return `${renderedValue}${unit.suffix}`;
  }

  return String(normalized);
}

export function formatEditableContextWindowInput(value) {
  const normalizedValue = normalizeContextWindowInput(value);
  const normalized = Number(normalizedValue);
  if (!Number.isFinite(normalized) || normalized <= 0) return String(value || "");
  return new Intl.NumberFormat().format(normalized);
}

export function buildProviderModelContextWindowMap(config = {}) {
  const map = new Map();
  for (const provider of (Array.isArray(config?.providers) ? config.providers : [])) {
    const providerId = String(provider?.id || "").trim();
    if (!providerId) continue;
    for (const model of (Array.isArray(provider?.models) ? provider.models : [])) {
      const modelId = String(model?.id || "").trim();
      if (!modelId) continue;
      map.set(`${providerId}/${modelId}`, {
        ref: `${providerId}/${modelId}`,
        providerId,
        providerName: String(provider?.name || providerId).trim() || providerId,
        modelId,
        contextWindow: Number.isFinite(model?.contextWindow) ? Number(model.contextWindow) : null
      });
    }
  }
  return map;
}

export function buildAliasContextWindowSummary(aliasId = "", config = {}) {
  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};
  const modelContextMap = buildProviderModelContextWindowMap(config);
  const seenAliases = new Set();
  const seenModelRefs = new Set();
  const models = [];
  const unknownRefs = [];

  function visitRouteRef(ref) {
    const normalizedRef = String(ref || "").trim();
    if (!normalizedRef) return;

    if (modelContextMap.has(normalizedRef)) {
      if (seenModelRefs.has(normalizedRef)) return;
      seenModelRefs.add(normalizedRef);
      models.push(modelContextMap.get(normalizedRef));
      return;
    }

    const normalizedAliasRef = normalizedRef.startsWith("alias:") ? normalizedRef.slice("alias:".length).trim() : normalizedRef;
    if (!normalizedAliasRef || !Object.prototype.hasOwnProperty.call(aliases, normalizedAliasRef)) {
      if (!unknownRefs.includes(normalizedRef)) unknownRefs.push(normalizedRef);
      return;
    }

    if (seenAliases.has(normalizedAliasRef)) return;
    seenAliases.add(normalizedAliasRef);
    const nestedAlias = aliases[normalizedAliasRef];
    for (const target of [...(nestedAlias?.targets || []), ...(nestedAlias?.fallbackTargets || [])]) {
      visitRouteRef(target?.ref);
    }
  }

  visitRouteRef(aliasId);

  const knownModels = models.filter((model) => Number.isFinite(model?.contextWindow));
  const uniqueWindows = [...new Set(knownModels.map((model) => model.contextWindow))].sort((left, right) => left - right);
  const smallestContextWindow = uniqueWindows[0] ?? null;
  const largestContextWindow = uniqueWindows[uniqueWindows.length - 1] ?? null;

  return {
    aliasId,
    models,
    unknownRefs,
    smallestContextWindow,
    largestContextWindow,
    hasMixedContextWindows: uniqueWindows.length > 1
  };
}

export function buildAliasGuideContextNotes(config = {}) {
  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};

  return Object.keys(aliases)
    .map((aliasId) => buildAliasContextWindowSummary(aliasId, config))
    .filter((summary) => summary.hasMixedContextWindows)
    .sort((left, right) => String(left.aliasId || "").localeCompare(String(right.aliasId || "")));
}

export function measureAliasSwitcherWidth(aliasLabel = "") {
  const label = String(aliasLabel || "Select alias").trim() || "Select alias";
  const fallbackWidth = Math.min(Math.max(Math.ceil(label.length * 8.5 + 62), 160), 520);

  if (typeof document === "undefined") return fallbackWidth;

  const canvas = measureAliasSwitcherWidth.canvas
    || (measureAliasSwitcherWidth.canvas = document.createElement("canvas"));
  const context = canvas.getContext("2d");
  if (!context) return fallbackWidth;

  context.font = '500 14px "Inter", "SF Pro Display", ui-sans-serif, system-ui, sans-serif';
  return Math.min(Math.max(Math.ceil(context.measureText(label).width + 62), 160), 520);
}

export function buildLiteLlmContextSuggestionKey(result = {}) {
  return `${String(result?.model || "").trim()}::${String(result?.contextWindow || "").trim()}`;
}

export function stripContextWindowFormatting(value) {
  return String(value || "").trim().replace(/[.,\s_'`]/g, "");
}

export function normalizeContextWindowInput(value) {
  const text = stripContextWindowFormatting(value);
  if (!text) return "";
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : text;
}

export function normalizeLiteLlmContextCandidate(candidate = {}) {
  const model = String(candidate?.model || "").trim();
  const provider = String(candidate?.provider || "").trim();
  const mode = String(candidate?.mode || "").trim();
  const contextWindow = Number(candidate?.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return {
    model,
    provider,
    mode,
    contextWindow: Math.floor(contextWindow),
    ...(candidate?.capabilities ? { capabilities: candidate.capabilities } : {})
  };
}

export function simplifyLiteLlmContextLabel(model = "", provider = "") {
  const normalizedModel = String(model || "").trim();
  const normalizedProvider = String(provider || "").trim();
  if (!normalizedModel || !normalizedProvider) return normalizedModel;

  const lowercaseModel = normalizedModel.toLowerCase();
  const lowercaseProvider = normalizedProvider.toLowerCase();
  const knownPrefixes = [`${lowercaseProvider}/`, `${lowercaseProvider}:`];

  for (const prefix of knownPrefixes) {
    if (!lowercaseModel.startsWith(prefix)) continue;
    const simplifiedLabel = normalizedModel.slice(prefix.length).trim();
    return simplifiedLabel || normalizedModel;
  }

  return normalizedModel;
}

export function buildLiteLlmContextLookupState(result = {}, { fallbackQuery = "" } = {}) {
  const query = String(result?.query || fallbackQuery || "").trim();
  const exactMatch = normalizeLiteLlmContextCandidate(result?.exactMatch);
  const suggestions = (Array.isArray(result?.suggestions) ? result.suggestions : [])
    .map((candidate) => normalizeLiteLlmContextCandidate(candidate))
    .filter(Boolean);
  const medianContextWindow = Number(result?.medianContextWindow);
  const normalizedMedianContextWindow = Number.isFinite(medianContextWindow) && medianContextWindow > 0
    ? Math.floor(medianContextWindow)
    : (exactMatch?.contextWindow || null);

  const options = [];
  const seenKeys = new Set();

  function addOption(option) {
    if (!option?.key || seenKeys.has(option.key)) return;
    seenKeys.add(option.key);
    options.push(option);
  }

  if (exactMatch) {
    addOption({
      key: `exact::${buildLiteLlmContextSuggestionKey(exactMatch)}`,
      label: simplifyLiteLlmContextLabel(exactMatch.model, exactMatch.provider) || "Exact match",
      detail: exactMatch.provider ? `Exact · ${exactMatch.provider}` : "Exact",
      contextWindow: exactMatch.contextWindow
    });
  }

  for (const suggestion of suggestions) {
    addOption({
      key: buildLiteLlmContextSuggestionKey(suggestion),
      label: simplifyLiteLlmContextLabel(suggestion.model, suggestion.provider) || "Suggestion",
      detail: suggestion.provider || "Known model",
      contextWindow: suggestion.contextWindow
    });
  }

  return {
    query,
    exactMatch,
    suggestions,
    medianContextWindow: normalizedMedianContextWindow,
    options,
    status: options.length > 0 ? "ready" : "miss"
  };
}

export function resolveLiteLlmPrefillContextWindow(result = {}) {
  const state = buildLiteLlmContextLookupState(result);
  if (state.exactMatch?.contextWindow) return String(state.exactMatch.contextWindow);
  if (state.medianContextWindow) return String(state.medianContextWindow);
  return "";
}

export function buildLiteLlmContextLookupMap(results = []) {
  const lookupMap = new Map();
  for (const result of (Array.isArray(results) ? results : [])) {
    const state = buildLiteLlmContextLookupState(result);
    if (!state.query) continue;
    lookupMap.set(state.query, state);
  }
  return lookupMap;
}

export function buildLiteLlmModelContextWindowMap(results = []) {
  const next = {};
  for (const result of (Array.isArray(results) ? results : [])) {
    const query = String(result?.query || "").trim();
    const prefill = resolveLiteLlmPrefillContextWindow(result);
    if (!query || !prefill) continue;
    next[query] = Number(prefill);
  }
  return next;
}
