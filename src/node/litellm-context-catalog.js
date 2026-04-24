export const LITELLM_CONTEXT_CATALOG_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const LITELLM_CONTEXT_CACHE_TTL_MS = 10 * 60 * 1000;

function normalizeModelLookupName(value) {
  return String(value || "").trim().toLowerCase();
}

function tokenizeModelLookupName(value) {
  return normalizeModelLookupName(value)
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function buildCanonicalModelLookupVariants(value, provider = "") {
  const normalizedValue = normalizeModelLookupName(value);
  const normalizedProvider = normalizeModelLookupName(provider);
  const variants = new Set();

  if (!normalizedValue) return variants;
  variants.add(normalizedValue);

  if (!normalizedProvider) return variants;
  for (const separator of ["/", ":"]) {
    const prefix = `${normalizedProvider}${separator}`;
    if (!normalizedValue.startsWith(prefix)) continue;
    const strippedValue = normalizedValue.slice(prefix.length).trim();
    if (strippedValue) variants.add(strippedValue);
  }

  return variants;
}

function isCanonicalExactModelNameMatch(query, candidate, provider = "") {
  const queryVariants = buildCanonicalModelLookupVariants(query, provider);
  const candidateVariants = buildCanonicalModelLookupVariants(candidate, provider);

  if (queryVariants.size === 0 || candidateVariants.size === 0) return false;
  for (const variant of queryVariants) {
    if (candidateVariants.has(variant)) return true;
  }
  return false;
}

function scoreLooseModelNameMatch(query, candidate) {
  const normalizedQuery = normalizeModelLookupName(query);
  const normalizedCandidate = normalizeModelLookupName(candidate);
  if (!normalizedQuery || !normalizedCandidate) return 0;
  if (normalizedQuery === normalizedCandidate) return 1000;
  if (normalizedCandidate.includes(normalizedQuery)) return 600 - (normalizedCandidate.length - normalizedQuery.length);
  if (normalizedQuery.includes(normalizedCandidate)) return 500 - (normalizedQuery.length - normalizedCandidate.length);

  const queryTokens = tokenizeModelLookupName(normalizedQuery);
  const candidateTokens = tokenizeModelLookupName(normalizedCandidate);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  let score = 0;
  for (const token of queryTokens) {
    if (candidateTokens.includes(token)) {
      score += token.length * 10;
      continue;
    }
    const partialMatch = candidateTokens.find((candidateToken) => candidateToken.includes(token) || token.includes(candidateToken));
    if (partialMatch) score += Math.min(token.length, partialMatch.length) * 4;
  }
  return score;
}

function extractLiteLlmContextWindow(entry) {
  const maxInputTokens = Number(entry?.max_input_tokens);
  if (Number.isFinite(maxInputTokens) && maxInputTokens > 0) return Math.floor(maxInputTokens);
  const maxTokens = Number(entry?.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) return Math.floor(maxTokens);
  return null;
}

function extractLiteLlmCapabilities(entry = {}) {
  const capabilities = {};
  let hasAny = false;
  if (typeof entry.supports_response_schema === "boolean") {
    capabilities.supportsResponseFormat = entry.supports_response_schema;
    hasAny = true;
  }
  return hasAny ? capabilities : undefined;
}

function createLiteLlmLookupResult(modelName, entry = {}) {
  const capabilities = extractLiteLlmCapabilities(entry);
  return {
    model: String(modelName || "").trim(),
    contextWindow: extractLiteLlmContextWindow(entry),
    provider: String(entry?.litellm_provider || "").trim(),
    mode: String(entry?.mode || "").trim(),
    ...(capabilities ? { capabilities } : {})
  };
}

function extractMedianContextWindow(exactMatch, suggestions = []) {
  const exactContextWindow = Number(exactMatch?.contextWindow);
  if (Number.isFinite(exactContextWindow) && exactContextWindow > 0) {
    return Math.floor(exactContextWindow);
  }

  const contextWindows = (Array.isArray(suggestions) ? suggestions : [])
    .map((entry) => Number(entry?.contextWindow))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);

  if (contextWindows.length === 0) return null;
  return contextWindows[Math.floor((contextWindows.length - 1) / 2)];
}

export function createLiteLlmContextLookupHelper({
  fetchImpl = fetch,
  catalogUrl = LITELLM_CONTEXT_CATALOG_URL,
  cacheTtlMs = LITELLM_CONTEXT_CACHE_TTL_MS
} = {}) {
  let cachedCatalog = null;
  let cachedAt = 0;
  let inFlightPromise = null;

  async function loadCatalog() {
    const now = Date.now();
    if (cachedCatalog && (now - cachedAt) < cacheTtlMs) {
      return cachedCatalog;
    }
    if (inFlightPromise) return inFlightPromise;

    inFlightPromise = (async () => {
      const response = await fetchImpl(catalogUrl);
      if (!response.ok) {
        throw new Error(`LiteLLM context catalog request failed with status ${response.status}.`);
      }
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("LiteLLM context catalog returned an invalid payload.");
      }
      cachedCatalog = payload;
      cachedAt = Date.now();
      return cachedCatalog;
    })();

    try {
      return await inFlightPromise;
    } finally {
      inFlightPromise = null;
    }
  }

  return async function lookupLiteLlmContextWindow({ models = [], limit = 8 } = {}) {
    const catalog = await loadCatalog();
    const catalogEntries = Object.entries(catalog);
    const resolvedLimit = Math.max(1, Math.min(Number(limit) || 8, 20));

    return (Array.isArray(models) ? models : [])
      .map((model) => String(model || "").trim())
      .filter(Boolean)
      .map((modelName) => {
        const rankedMatches = catalogEntries
          .map(([candidateName, entry]) => ({
            result: createLiteLlmLookupResult(candidateName, entry),
            score: scoreLooseModelNameMatch(modelName, candidateName)
          }))
          .filter((entry) => entry.score > 0 && Number.isFinite(entry.result.contextWindow))
          .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            return left.result.model.localeCompare(right.result.model);
          });

        const exactMatch = rankedMatches.find((entry) => isCanonicalExactModelNameMatch(
          modelName,
          entry.result.model,
          entry.result.provider
        ))?.result || null;

        const suggestions = rankedMatches
          .filter((entry) => {
            if (!exactMatch) return true;
            return !(
              entry.result.model === exactMatch.model
              && entry.result.provider === exactMatch.provider
              && entry.result.mode === exactMatch.mode
              && entry.result.contextWindow === exactMatch.contextWindow
            );
          })
          .slice(0, resolvedLimit)
          .map((entry) => entry.result);

        return {
          query: modelName,
          exactMatch,
          suggestions,
          medianContextWindow: extractMedianContextWindow(exactMatch, suggestions)
        };
      });
  };
}
