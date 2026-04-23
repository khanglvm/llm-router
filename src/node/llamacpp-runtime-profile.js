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

export function estimateLlamacppRuntimeBytes({
  sizeBytes = 0,
  contextWindow = 0,
  preset = "balanced"
} = {}) {
  const base = Number(sizeBytes || 0);
  const contextBytes = Number(contextWindow || 0) * 163840;
  const normalizedPreset = normalizeString(preset) || "balanced";
  const presetPenalty = normalizedPreset === "throughput"
    ? Math.floor(base * 0.18)
    : normalizedPreset === "cpu-safe"
      ? Math.floor(base * 0.04)
      : Math.floor(base * 0.1);
  return base + contextBytes + presetPenalty;
}

export function deriveLlamacppLaunchProfile({
  variant,
  baseModel,
  system
} = {}) {
  const requestedPreset = normalizeString(variant?.runtimeProfile?.preset) || "balanced";
  const failureCategory = normalizeString(
    variant?.runtimeProfile?.lastFailure?.category || variant?.runtimeStatus?.lastFailure?.category
  );
  const preset = failureCategory === "metal-oom" ? "cpu-safe" : requestedPreset;
  const contextWindow = normalizePositiveInteger(variant?.contextWindow, 2048);
  const overrides = isPlainObject(variant?.runtimeProfile?.overrides) ? variant.runtimeProfile.overrides : {};
  const extraArgs = Array.isArray(variant?.runtimeProfile?.extraArgs)
    ? variant.runtimeProfile.extraArgs.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  const gpuLayers = Number.isFinite(Number(overrides.gpuLayers))
    ? Math.floor(Number(overrides.gpuLayers))
    : (preset === "cpu-safe" ? 0 : (system?.platform === "darwin" ? 99 : 0));
  const batchSize = Number.isFinite(Number(overrides.batchSize))
    ? Math.floor(Number(overrides.batchSize))
    : (preset === "throughput" ? 256 : 64);
  const ubatchSize = Number.isFinite(Number(overrides.ubatchSize))
    ? Math.floor(Number(overrides.ubatchSize))
    : (preset === "throughput" ? 128 : 16);
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

  if (preset === "cpu-safe") args.push("--no-cont-batching");
  args.push("-ngl", String(gpuLayers), ...extraArgs);

  return {
    preset,
    args: args.filter(Boolean),
    estimatedRuntimeBytes,
    memoryLabel: `${toGiB(estimatedRuntimeBytes)} GB`
  };
}
