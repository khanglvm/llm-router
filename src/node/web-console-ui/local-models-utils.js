function countBy(entries, predicate) {
  return Object.values(entries || {}).filter((entry) => predicate(entry)).length;
}

function normalizeRuntimeStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return "stopped";
  return normalized;
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
