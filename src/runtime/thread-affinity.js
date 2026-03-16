const DEFAULT_AFFINITY_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_BINDINGS = 10_000;

export function createThreadAffinityStore(options = {}) {
  const ttlMs = options.ttlMs || DEFAULT_AFFINITY_TTL_MS;
  const bindings = new Map();

  function pruneExpired(now = Date.now()) {
    for (const [key, binding] of bindings) {
      if (binding.expiresAt <= now) bindings.delete(key);
    }
  }

  function getAffinity(threadId) {
    if (!threadId) return null;
    const binding = bindings.get(threadId);
    if (!binding) return null;
    if (binding.expiresAt <= Date.now()) {
      bindings.delete(threadId);
      return null;
    }
    return binding.candidateKey;
  }

  function setAffinity(threadId, candidateKey) {
    if (!threadId || !candidateKey) return;
    const now = Date.now();
    bindings.set(threadId, {
      candidateKey,
      lastSeen: now,
      expiresAt: now + ttlMs
    });
    if (bindings.size > MAX_BINDINGS) pruneExpired(now);
  }

  function clearAffinity(threadId) {
    if (threadId) bindings.delete(threadId);
  }

  return { getAffinity, setAffinity, clearAffinity, pruneExpired, _bindings: bindings };
}
