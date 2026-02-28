export const DEFAULT_CANDIDATE_STATE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeTimestamp(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function shallowCloneObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function normalizeCandidateState(state, now = Date.now()) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const out = shallowCloneObject(state);

  out.cooldownUntil = normalizeTimestamp(state.cooldownUntil);
  out.openUntil = normalizeTimestamp(state.openUntil);
  out.expiresAt = normalizeTimestamp(state.expiresAt);
  out.consecutiveRetryableFailures = normalizeCount(
    state.consecutiveRetryableFailures ?? state.consecutiveFailures
  );
  out.updatedAt = normalizeTimestamp(state.updatedAt) || now;
  return out;
}

function resolveCandidateExpiry(state, now, ttlMs) {
  const explicitExpiry = normalizeTimestamp(state?.expiresAt);
  if (explicitExpiry > 0) return explicitExpiry;

  const cooldownUntil = Math.max(
    normalizeTimestamp(state?.cooldownUntil),
    normalizeTimestamp(state?.openUntil)
  );
  if (cooldownUntil > now) return cooldownUntil + ttlMs;

  const updatedAt = normalizeTimestamp(state?.updatedAt) || now;
  return updatedAt + ttlMs;
}

function shouldPruneCandidateState(state, now, ttlMs) {
  return resolveCandidateExpiry(state, now, ttlMs) <= now;
}

function normalizeEntryAmount(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeMapKey(value) {
  return String(value ?? "").trim();
}

export function createMemoryStateStore({ candidateStateTtlMs = DEFAULT_CANDIDATE_STATE_TTL_MS } = {}) {
  const routeCursors = new Map();
  const candidateStates = new Map();
  const bucketUsage = new Map();

  return {
    async getRouteCursor(routeKey) {
      const key = normalizeMapKey(routeKey);
      if (!key) return 0;
      return normalizeCount(routeCursors.get(key));
    },

    async setRouteCursor(routeKey, value) {
      const key = normalizeMapKey(routeKey);
      if (!key) return 0;
      const normalized = normalizeCount(value);
      routeCursors.set(key, normalized);
      return normalized;
    },

    async getCandidateState(candidateKey) {
      const key = normalizeMapKey(candidateKey);
      if (!key) return null;
      const state = candidateStates.get(key);
      return state ? { ...state } : null;
    },

    async setCandidateState(candidateKey, state) {
      const key = normalizeMapKey(candidateKey);
      if (!key) return null;
      if (state === null || state === undefined) {
        candidateStates.delete(key);
        return null;
      }

      const normalized = normalizeCandidateState(state);
      if (!normalized) {
        candidateStates.delete(key);
        return null;
      }

      candidateStates.set(key, normalized);
      return { ...normalized };
    },

    async readBucketUsage(bucketKey, windowKey) {
      const bucket = normalizeMapKey(bucketKey);
      const window = normalizeMapKey(windowKey);
      if (!bucket || !window) return 0;
      const windows = bucketUsage.get(bucket);
      if (!windows) return 0;
      const entry = windows.get(window);
      return normalizeCount(entry?.count);
    },

    async incrementBucketUsage(bucketKey, windowKey, amount = 1, options = {}) {
      const bucket = normalizeMapKey(bucketKey);
      const window = normalizeMapKey(windowKey);
      if (!bucket || !window) return 0;

      const incrementBy = normalizeEntryAmount(amount);
      if (incrementBy <= 0) {
        return this.readBucketUsage(bucket, window);
      }

      let windows = bucketUsage.get(bucket);
      if (!windows) {
        windows = new Map();
        bucketUsage.set(bucket, windows);
      }

      const now = normalizeTimestamp(options?.now) || Date.now();
      const existing = windows.get(window) || {};
      const nextCount = normalizeCount(existing.count) + incrementBy;
      windows.set(window, {
        count: nextCount,
        expiresAt: normalizeTimestamp(options?.expiresAt) || normalizeTimestamp(existing.expiresAt),
        updatedAt: now
      });
      return nextCount;
    },

    async pruneExpired(now = Date.now()) {
      const currentTime = normalizeTimestamp(now) || Date.now();
      let prunedBuckets = 0;
      let prunedCandidateStates = 0;

      for (const [bucketKey, windows] of bucketUsage.entries()) {
        for (const [windowKey, entry] of windows.entries()) {
          const expiresAt = normalizeTimestamp(entry?.expiresAt);
          if (expiresAt > 0 && expiresAt <= currentTime) {
            windows.delete(windowKey);
            prunedBuckets += 1;
          }
        }
        if (windows.size === 0) {
          bucketUsage.delete(bucketKey);
        }
      }

      for (const [candidateKey, state] of candidateStates.entries()) {
        if (shouldPruneCandidateState(state, currentTime, candidateStateTtlMs)) {
          candidateStates.delete(candidateKey);
          prunedCandidateStates += 1;
        }
      }

      return {
        prunedBuckets,
        prunedCandidateStates
      };
    },

    async close() {
      return undefined;
    }
  };
}

