function countBy(entries, predicate) {
  return Object.values(entries || {}).filter((entry) => predicate(entry)).length;
}

export const LLAMACPP_VARIANT_PRESETS = {
  balanced: { label: "Balanced", contextWindow: 65536 },
  "long-context": { label: "Long Context", contextWindow: 200000 },
  "low-memory": { label: "Low Memory", contextWindow: 16384 },
  "fast-response": { label: "Fast Response", contextWindow: 8192 }
};

const DEFAULT_RUNTIME_PROFILE = {
  mode: "auto",
  preset: "balanced",
  overrides: {},
  extraArgs: [],
  lastKnownGood: null,
  lastFailure: null
};

function cloneRuntimeProfileValue(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneRuntimeProfileValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneRuntimeProfileValue(entry)])
    );
  }
  return value;
}

function normalizeRuntimeStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return "stopped";
  return normalized;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function makeUniqueId(candidate, existingIds = new Set()) {
  const base = String(candidate || "").trim() || "local/local-model";
  if (!existingIds.has(base)) return base;
  let index = 2;
  while (existingIds.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function buildExistingLocalModelIds(existingEntries = {}) {
  return new Set(
    Object.values(existingEntries || {})
      .map((entry) => String(entry?.id || "").trim())
      .filter(Boolean)
  );
}

function stripFileExtension(fileName) {
  return String(fileName || "").replace(/\.[^.]+$/u, "");
}

function pickLastPathSegment(filePath) {
  const normalized = String(filePath || "").trim().replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || "";
}

export function buildManagedLocalModelDraft(candidate = {}, existingEntries = {}) {
  const repo = String(candidate?.repo || "").trim();
  const file = String(candidate?.file || "").trim();
  const existingIds = buildExistingLocalModelIds(existingEntries);
  const idSeed = slugify(`${repo}-${stripFileExtension(file)}`) || "local-model";
  return {
    id: makeUniqueId(idSeed, existingIds),
    displayName: file || repo || "Managed GGUF",
    repo,
    file
  };
}

export function buildAttachedLocalModelDraft(filePath = "", existingEntries = {}) {
  const normalizedPath = String(filePath || "").trim();
  const fileName = pickLastPathSegment(normalizedPath);
  const existingIds = buildExistingLocalModelIds(existingEntries);
  const idSeed = slugify(stripFileExtension(fileName)) || "local-model";
  return {
    id: makeUniqueId(idSeed, existingIds),
    displayName: fileName || normalizedPath || "Attached GGUF",
    filePath: normalizedPath
  };
}

export function normalizeLocalVariantContextWindow(value) {
  const parsed = Number.parseInt(String(value ?? "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function buildLlamacppVariantDraft(baseModel, existingVariants = {}) {
  const baseLabel = String(baseModel?.displayName || baseModel?.id || "Local Model").trim() || "Local Model";
  const preset = "balanced";
  const presetConfig = LLAMACPP_VARIANT_PRESETS[preset];
  const existingIds = new Set(
    Object.values(existingVariants || {})
      .map((variant) => String(variant?.id || "").trim())
      .filter(Boolean)
  );
  const name = `${baseLabel} ${presetConfig.label}`;
  const id = makeUniqueId(`local/${slugify(name)}`, existingIds);
  return {
    key: slugify(id) || `local-${Date.now()}`,
    baseModelId: baseModel?.id,
    runtime: "llamacpp",
    name,
    id,
    preset,
    enabled: true,
    preload: false,
    contextWindow: presetConfig.contextWindow,
    capabilities: {}
  };
}

export function buildEditableLlamacppVariantDraft(variant) {
  return {
    ...variant,
    preset: String(variant?.preset || "balanced").trim() || "balanced",
    contextWindow: Number.isFinite(Number(variant?.contextWindow))
      ? Number(variant.contextWindow)
      : LLAMACPP_VARIANT_PRESETS.balanced.contextWindow,
    runtimeProfile: {
      ...DEFAULT_RUNTIME_PROFILE,
      ...(variant?.runtimeProfile || {}),
      overrides: variant?.runtimeProfile?.overrides && typeof variant.runtimeProfile.overrides === "object"
        ? cloneRuntimeProfileValue(variant.runtimeProfile.overrides)
        : {},
      extraArgs: Array.isArray(variant?.runtimeProfile?.extraArgs) ? [...variant.runtimeProfile.extraArgs] : [],
      lastKnownGood: variant?.runtimeProfile?.lastKnownGood && typeof variant.runtimeProfile.lastKnownGood === "object"
        ? cloneRuntimeProfileValue(variant.runtimeProfile.lastKnownGood)
        : null,
      lastFailure: variant?.runtimeProfile?.lastFailure && typeof variant.runtimeProfile.lastFailure === "object"
        ? cloneRuntimeProfileValue(variant.runtimeProfile.lastFailure)
        : null
    },
    capabilities: variant?.capabilities && typeof variant.capabilities === "object"
      ? { ...variant.capabilities }
      : {}
  };
}

export function resolveLocalVariantSaveDisabledReason(draft, duplicateIds = new Set()) {
  if (!String(draft?.name || "").trim()) return "Variant name is required.";
  if (!String(draft?.id || "").trim()) return "Model id is required.";
  if (duplicateIds.has(String(draft?.id || "").trim())) return "Model id already exists.";
  if (!normalizeLocalVariantContextWindow(draft?.contextWindow)) return "Context window must be a positive integer.";
  return "";
}

export function buildLocalModelsSummary(localModels = {}) {
  const runtime = localModels?.runtime || {};
  const library = localModels?.library || {};
  const variants = localModels?.variants || {};

  return {
    enabledVariants: countBy(variants, (variant) => variant?.enabled === true),
    preloadedVariants: countBy(variants, (variant) => variant?.preload === true),
    staleAssets: countBy(library, (entry) => String(entry?.availability || "").trim().toLowerCase() === "stale"),
    runningRuntimes: countBy(runtime, (entry) => normalizeRuntimeStatus(entry?.status) === "running")
  };
}
