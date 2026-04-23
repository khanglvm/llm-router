export const LOCAL_RUNTIME_PROVIDER_TYPE = "local-runtime";
export const LOCAL_RUNTIME_PROVIDER_ID = "local-models";
export const LOCAL_RUNTIME_BASE_URL = "http://127.0.0.1:39391/v1";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clonePlainObject(value) {
  return isPlainObject(value) ? { ...value } : {};
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function normalizeRuntimeProfile(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const overrides = isPlainObject(source.overrides) ? { ...source.overrides } : {};
  const extraArgs = Array.isArray(source.extraArgs)
    ? source.extraArgs.map((value) => normalizeString(value)).filter(Boolean)
    : [];

  return {
    mode: normalizeString(source.mode) === "custom" ? "custom" : "auto",
    preset: normalizeString(source.preset) || "balanced",
    overrides,
    extraArgs,
    lastKnownGood: isPlainObject(source.lastKnownGood) ? { ...source.lastKnownGood } : null,
    lastFailure: isPlainObject(source.lastFailure) ? { ...source.lastFailure } : null
  };
}

function normalizeRuntimeStatus(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};

  return {
    activeInstanceId: normalizeString(source.activeInstanceId),
    lastFailure: isPlainObject(source.lastFailure) ? { ...source.lastFailure } : null,
    lastStartedAt: normalizeString(source.lastStartedAt),
    lastHealthyAt: normalizeString(source.lastHealthyAt)
  };
}

function normalizeLocalModelLibraryEntry(key, entry) {
  if (!isPlainObject(entry)) return null;

  const normalized = {
    ...entry,
    id: normalizeString(entry.id) || key
  };

  for (const field of ["source", "displayName", "path", "availability"]) {
    if (field in normalized) {
      const value = normalizeString(normalized[field]);
      if (value) normalized[field] = value;
      else delete normalized[field];
    }
  }

  return normalized;
}

function normalizeLocalModelVariantEntry(key, entry) {
  if (!isPlainObject(entry)) return null;

  const normalized = {
    ...entry,
    key: normalizeString(entry.key) || key,
    baseModelId: normalizeString(entry.baseModelId),
    id: normalizeString(entry.id),
    name: normalizeString(entry.name),
    runtime: normalizeString(entry.runtime),
    enabled: entry.enabled === true,
    preload: entry.preload === true
  };

  if ("preset" in normalized) {
    const preset = normalizeString(normalized.preset);
    if (preset) normalized.preset = preset;
    else delete normalized.preset;
  }

  const contextWindow = normalizePositiveNumber(entry.contextWindow);
  if (contextWindow !== undefined) normalized.contextWindow = contextWindow;
  else delete normalized.contextWindow;

  const estimatedBytes = normalizePositiveNumber(entry.estimatedBytes);
  if (estimatedBytes !== undefined) normalized.estimatedBytes = estimatedBytes;
  else delete normalized.estimatedBytes;

  if (isPlainObject(entry.capabilities)) normalized.capabilities = { ...entry.capabilities };
  else delete normalized.capabilities;

  if ("availability" in normalized) {
    const availability = normalizeString(normalized.availability);
    if (availability) normalized.availability = availability;
    else delete normalized.availability;
  }

  if (normalized.runtime === "llamacpp") {
    normalized.runtimeProfile = normalizeRuntimeProfile(entry.runtimeProfile);
    normalized.runtimeStatus = normalizeRuntimeStatus(entry.runtimeStatus);
  } else {
    delete normalized.runtimeProfile;
    delete normalized.runtimeStatus;
  }

  return normalized;
}

export function normalizeLocalModelsMetadata(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const runtime = clonePlainObject(source.runtime);
  const capacity = clonePlainObject(source.capacity);
  const library = {};
  const variants = {};

  for (const [key, value] of Object.entries(clonePlainObject(source.library))) {
    const normalizedEntry = normalizeLocalModelLibraryEntry(normalizeString(key), value);
    if (!normalizedEntry) continue;
    library[normalizedEntry.id || key] = normalizedEntry;
  }

  for (const [key, value] of Object.entries(clonePlainObject(source.variants))) {
    const normalizedEntry = normalizeLocalModelVariantEntry(normalizeString(key), value);
    if (!normalizedEntry?.key) continue;
    variants[normalizedEntry.key] = normalizedEntry;
  }

  return {
    runtime,
    library,
    variants,
    capacity
  };
}

export function collectDuplicateLocalVariantModelIds(localModelsMetadata) {
  const metadata = normalizeLocalModelsMetadata(localModelsMetadata);
  const seen = new Set();
  const duplicates = new Set();

  for (const variant of Object.values(metadata.variants)) {
    const modelId = normalizeString(variant?.id);
    if (!modelId) continue;
    if (seen.has(modelId)) duplicates.add(modelId);
    else seen.add(modelId);
  }

  return [...duplicates];
}

export function materializeLocalVariantProvider(config = {}) {
  const metadata = normalizeLocalModelsMetadata(config?.metadata?.localModels);
  const models = [];

  for (const variant of Object.values(metadata.variants)) {
    if (!variant || variant.enabled !== true) continue;
    if (!variant.id) continue;

    const baseModel = metadata.library[variant.baseModelId] || null;
    const materialized = {
      id: variant.id,
      enabled: true,
      metadata: {
        localVariantKey: variant.key,
        baseModelId: variant.baseModelId,
        runtime: variant.runtime,
        preload: variant.preload === true,
        availability: variant.availability || baseModel?.availability || "available",
        capacityState: variant.capacityState,
        estimatedBytes: variant.estimatedBytes
      }
    };

    if (variant.name) materialized.name = variant.name;
    if (variant.contextWindow !== undefined) materialized.contextWindow = variant.contextWindow;
    if (isPlainObject(variant.capabilities)) materialized.capabilities = { ...variant.capabilities };

    models.push(materialized);
  }

  if (models.length === 0) return [];

  return [{
    id: LOCAL_RUNTIME_PROVIDER_ID,
    name: "Local Models",
    type: LOCAL_RUNTIME_PROVIDER_TYPE,
    baseUrl: LOCAL_RUNTIME_BASE_URL,
    format: "openai",
    formats: ["openai"],
    apiKey: "local-runtime",
    enabled: true,
    models,
    rateLimits: []
  }];
}
