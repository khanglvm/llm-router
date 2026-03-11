export const RATE_LIMIT_ALL_MODELS_SELECTOR = "all";
export const RATE_LIMIT_WINDOW_OPTIONS = ["second", "minute", "hour", "day", "week", "month"];

function normalizePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeRateLimitWindowUnit(value, fallback = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (RATE_LIMIT_WINDOW_OPTIONS.includes(normalized)) return normalized;
  return fallback;
}

export function pluralizeRateLimitWindowUnit(unit, windowValue = 1) {
  const normalized = String(unit || "").trim().toLowerCase().replace(/s$/, "");
  if (!normalized) return "windows";
  return Number(windowValue) === 1 ? normalized : `${normalized}s`;
}

export function normalizeRateLimitModelSelectors(values = []) {
  const normalized = [];
  const seen = new Set();

  for (const value of (Array.isArray(values) ? values : [values])) {
    const trimmed = String(value || "").trim();
    if (!trimmed) continue;
    if (trimmed.toLowerCase() === RATE_LIMIT_ALL_MODELS_SELECTOR) {
      return [RATE_LIMIT_ALL_MODELS_SELECTOR];
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

export function buildAutoRateLimitBucketId({ requests, windowValue, windowUnit }) {
  const normalizedRequests = normalizePositiveInteger(requests, 0);
  const normalizedWindowValue = normalizePositiveInteger(windowValue, 0);
  const normalizedWindowUnit = normalizeRateLimitWindowUnit(windowUnit, "");
  if (!normalizedRequests || !normalizedWindowValue || !normalizedWindowUnit) return "";
  return `${normalizedRequests}-req-per-${normalizedWindowValue}-${pluralizeRateLimitWindowUnit(normalizedWindowUnit, normalizedWindowValue)}`;
}

export function formatRateLimitBucketCap(bucket = {}) {
  const requests = normalizePositiveInteger(bucket?.requests ?? bucket?.limit, 0);
  const windowValue = normalizePositiveInteger(bucket?.window?.size ?? bucket?.window?.value ?? bucket?.windowValue, 0);
  const windowUnit = normalizeRateLimitWindowUnit(bucket?.window?.unit ?? bucket?.windowUnit, "");
  if (!requests || !windowValue || !windowUnit) return "Unconfigured";
  return `${requests}/${windowValue} ${pluralizeRateLimitWindowUnit(windowUnit, windowValue)}`;
}

export function validateRateLimitDraftRows(rows = [], {
  knownModelIds = [],
  requireAtLeastOne = true
} = {}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (requireAtLeastOne && normalizedRows.length === 0) {
    return "Add at least one rate-limit entity.";
  }

  const knownModels = new Set((knownModelIds || []).map((modelId) => String(modelId || "").trim()).filter(Boolean));
  const seenBucketIds = new Set();

  for (const row of normalizedRows) {
    const models = normalizeRateLimitModelSelectors(row?.models || []);
    if (knownModels.size > 0 && models.some((modelId) => modelId !== RATE_LIMIT_ALL_MODELS_SELECTOR && !knownModels.has(modelId))) {
      return "Rate-limit model selectors must match the provider model ids.";
    }

    const requests = normalizePositiveInteger(row?.requests, 0);
    if (!requests) {
      return "Rate-limit requests must be a positive integer.";
    }

    const windowValue = normalizePositiveInteger(row?.windowValue, 0);
    if (!windowValue) {
      return "Rate-limit window size must be a positive integer.";
    }

    const windowUnit = normalizeRateLimitWindowUnit(row?.windowUnit, "");
    if (!windowUnit) {
      return "Rate-limit window unit is invalid.";
    }

    const bucketId = buildAutoRateLimitBucketId({ requests, windowValue, windowUnit });
    if (seenBucketIds.has(bucketId)) {
      return "Duplicate rate-limit entities are not allowed.";
    }
    seenBucketIds.add(bucketId);
  }

  return "";
}

export function buildRateLimitBucketsFromDraftRows(rows = [], {
  existingBucketsBySourceId = new Map(),
  fallbackRequests = 60,
  fallbackWindowValue = 1,
  fallbackWindowUnit = "minute"
} = {}) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const sourceId = String(row?.sourceId || "").trim();
    const existingBucket = sourceId && existingBucketsBySourceId instanceof Map && existingBucketsBySourceId.has(sourceId)
      ? structuredClone(existingBucketsBySourceId.get(sourceId))
      : {};
    const requests = normalizePositiveInteger(
      row?.requests,
      normalizePositiveInteger(existingBucket?.requests ?? existingBucket?.limit, fallbackRequests)
    );
    const windowValue = normalizePositiveInteger(
      row?.windowValue,
      normalizePositiveInteger(existingBucket?.window?.size ?? existingBucket?.window?.value, fallbackWindowValue)
    );
    const windowUnit = normalizeRateLimitWindowUnit(
      row?.windowUnit,
      normalizeRateLimitWindowUnit(existingBucket?.window?.unit, fallbackWindowUnit) || fallbackWindowUnit
    );
    const models = normalizeRateLimitModelSelectors(row?.models || []);
    const effectiveModels = models.length > 0 ? models : [RATE_LIMIT_ALL_MODELS_SELECTOR];

    const bucket = {
      ...existingBucket,
      id: buildAutoRateLimitBucketId({ requests, windowValue, windowUnit }) || `rate-limit-${index + 1}`,
      models: effectiveModels,
      requests,
      window: {
        ...(existingBucket?.window && typeof existingBucket.window === "object" && !Array.isArray(existingBucket.window) ? existingBucket.window : {}),
        size: windowValue,
        unit: windowUnit
      }
    };

    delete bucket.name;
    delete bucket.limit;
    if (bucket.window && typeof bucket.window === "object") {
      delete bucket.window.value;
    }

    return bucket;
  });
}
