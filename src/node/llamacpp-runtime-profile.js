function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toGiB(bytes) {
  return Math.round((Number(bytes || 0) / (1024 ** 3)) * 10) / 10;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const LLAMACPP_PRESET_TUNING = Object.freeze({
  balanced: Object.freeze({
    canonicalPreset: "balanced",
    batchSize: 64,
    ubatchSize: 16,
    gpuLayers: { darwin: 99, other: 0 },
    penaltyRatio: 0.10,
    noContBatching: false
  }),
  "long-context": Object.freeze({
    canonicalPreset: "long-context",
    batchSize: 32,
    ubatchSize: 8,
    gpuLayers: { darwin: 80, other: 0 },
    penaltyRatio: 0.16,
    noContBatching: false
  }),
  "low-memory": Object.freeze({
    canonicalPreset: "low-memory",
    batchSize: 32,
    ubatchSize: 8,
    gpuLayers: { darwin: 0, other: 0 },
    penaltyRatio: 0.04,
    noContBatching: true
  }),
  "fast-response": Object.freeze({
    canonicalPreset: "fast-response",
    batchSize: 16,
    ubatchSize: 8,
    gpuLayers: { darwin: 40, other: 0 },
    penaltyRatio: 0.07,
    noContBatching: false
  }),
  "cpu-safe": Object.freeze({
    canonicalPreset: "cpu-safe",
    batchSize: 32,
    ubatchSize: 8,
    gpuLayers: { darwin: 0, other: 0 },
    penaltyRatio: 0.04,
    noContBatching: true
  })
});

function resolveCanonicalPreset(requestedPreset) {
  const normalizedPreset = normalizeString(requestedPreset).toLowerCase();
  if (normalizedPreset === "throughput") return LLAMACPP_PRESET_TUNING["fast-response"];
  if (normalizedPreset === "memory-safe") return LLAMACPP_PRESET_TUNING["low-memory"];
  return LLAMACPP_PRESET_TUNING[normalizedPreset] || LLAMACPP_PRESET_TUNING.balanced;
}

export function estimateLlamacppRuntimeBytes({
  sizeBytes = 0,
  contextWindow = 0,
  preset = "balanced"
} = {}) {
  const base = Number(sizeBytes || 0);
  const contextBytes = Number(contextWindow || 0) * 163840;
  const tuning = resolveCanonicalPreset(preset);
  const presetPenalty = Math.floor(base * tuning.penaltyRatio);
  return base + contextBytes + presetPenalty;
}

export function deriveLlamacppLaunchProfile({
  variant,
  baseModel,
  system
} = {}) {
  const requestedPreset = normalizeString(variant?.preset)
    || normalizeString(variant?.runtimeProfile?.preset)
    || "balanced";
  const failureCategory = normalizeString(
    variant?.runtimeProfile?.lastFailure?.category || variant?.runtimeStatus?.lastFailure?.category
  );
  const tuning = resolveCanonicalPreset(failureCategory === "metal-oom" ? "cpu-safe" : requestedPreset);
  const preset = tuning.canonicalPreset;
  const contextWindow = normalizePositiveInteger(variant?.contextWindow, 2048);
  const overrides = isPlainObject(variant?.runtimeProfile?.overrides) ? variant.runtimeProfile.overrides : {};
  const extraArgs = Array.isArray(variant?.runtimeProfile?.extraArgs)
    ? variant.runtimeProfile.extraArgs.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  const gpuLayers = Number.isFinite(Number(overrides.gpuLayers))
    ? Math.floor(Number(overrides.gpuLayers))
    : (system?.platform === "darwin" ? tuning.gpuLayers.darwin : tuning.gpuLayers.other);
  const batchSize = Number.isFinite(Number(overrides.batchSize))
    ? Math.floor(Number(overrides.batchSize))
    : tuning.batchSize;
  const ubatchSize = Number.isFinite(Number(overrides.ubatchSize))
    ? Math.floor(Number(overrides.ubatchSize))
    : tuning.ubatchSize;
  const estimatedRuntimeBytes = estimateLlamacppRuntimeBytes({
    sizeBytes: baseModel?.metadata?.sizeBytes,
    contextWindow,
    preset
  });
  const args = [
    "-m", normalizeString(baseModel?.path),
    "-a", normalizeString(variant?.id),
    "-c", String(contextWindow),
    "-np", "1",
    "-b", String(batchSize),
    "-ub", String(ubatchSize),
    "--cache-ram", "0",
    "--no-warmup"
  ];

  if (tuning.noContBatching) args.push("--no-cont-batching");
  args.push("-ngl", String(gpuLayers), ...extraArgs);

  return {
    preset,
    args: args.filter(Boolean),
    estimatedRuntimeBytes,
    memoryLabel: `${toGiB(estimatedRuntimeBytes)} GB`
  };
}
