function normalizePositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

function calculateEstimatedBytes(variant = {}) {
  const sizeBytes = normalizePositiveNumber(variant.sizeBytes);
  const contextWindow = normalizePositiveNumber(variant.contextWindow);
  const contextBytes = contextWindow * 163840;
  const preloadPenalty = variant.preload === true ? Math.floor(sizeBytes * 0.15) : 0;
  return sizeBytes + contextBytes + preloadPenalty;
}

export function classifyVariantCapacity(variant, system = {}) {
  const estimatedBytes = calculateEstimatedBytes(variant);
  const totalMemoryBytes = normalizePositiveNumber(system.totalMemoryBytes);
  const safeBudget = Math.floor(totalMemoryBytes * 0.72);
  const tightBudget = Math.floor(totalMemoryBytes * 0.82);

  if (system.platform === "darwin" && system.unifiedMemory === true && estimatedBytes > tightBudget) {
    return { fit: "over-budget", estimatedBytes };
  }
  if (system.platform === "darwin" && system.unifiedMemory === true && estimatedBytes > safeBudget) {
    return { fit: "tight", estimatedBytes };
  }
  return { fit: "safe", estimatedBytes };
}

export function canActivateVariant({ candidate, activeVariants, totalMemoryBytes }) {
  const safeBudget = Math.floor(normalizePositiveNumber(totalMemoryBytes) * 0.72);
  const activeBytes = (Array.isArray(activeVariants) ? activeVariants : [])
    .reduce((sum, variant) => sum + normalizePositiveNumber(variant?.estimatedBytes), 0);
  const nextBytes = activeBytes + normalizePositiveNumber(candidate?.estimatedBytes);

  return nextBytes <= safeBudget
    ? { allowed: true, reason: "" }
    : { allowed: false, reason: "Enabling this variant would exceed the local capacity budget." };
}
