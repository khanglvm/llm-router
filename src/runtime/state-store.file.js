import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { DEFAULT_CANDIDATE_STATE_TTL_MS } from "./state-store.memory.js";

export const DEFAULT_STATE_FILENAME = ".llm-router.state.json";
const STATE_FILE_VERSION = 1;

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

function normalizeMapKey(value) {
  return String(value ?? "").trim();
}

function normalizeEntryAmount(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeCandidateState(state, now = Date.now()) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const out = { ...state };
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

function createEmptyState() {
  return {
    version: STATE_FILE_VERSION,
    routeCursors: {},
    candidateStates: {},
    bucketUsage: {}
  };
}

function normalizePersistedState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return createEmptyState();
  }

  const routeCursors = {};
  for (const [key, value] of Object.entries(parsed.routeCursors || {})) {
    const normalizedKey = normalizeMapKey(key);
    if (!normalizedKey) continue;
    routeCursors[normalizedKey] = normalizeCount(value);
  }

  const candidateStates = {};
  for (const [key, value] of Object.entries(parsed.candidateStates || {})) {
    const normalizedKey = normalizeMapKey(key);
    if (!normalizedKey) continue;
    const normalizedState = normalizeCandidateState(value);
    if (!normalizedState) continue;
    candidateStates[normalizedKey] = normalizedState;
  }

  const bucketUsage = {};
  for (const [bucketKeyRaw, windowsRaw] of Object.entries(parsed.bucketUsage || {})) {
    const bucketKey = normalizeMapKey(bucketKeyRaw);
    if (!bucketKey) continue;
    if (!windowsRaw || typeof windowsRaw !== "object" || Array.isArray(windowsRaw)) continue;

    const windows = {};
    for (const [windowKeyRaw, entryRaw] of Object.entries(windowsRaw)) {
      const windowKey = normalizeMapKey(windowKeyRaw);
      if (!windowKey) continue;
      windows[windowKey] = {
        count: normalizeCount(entryRaw?.count),
        expiresAt: normalizeTimestamp(entryRaw?.expiresAt),
        updatedAt: normalizeTimestamp(entryRaw?.updatedAt)
      };
    }

    if (Object.keys(windows).length > 0) {
      bucketUsage[bucketKey] = windows;
    }
  }

  return {
    version: STATE_FILE_VERSION,
    routeCursors,
    candidateStates,
    bucketUsage
  };
}

async function readStateFileSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizePersistedState(parsed);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return createEmptyState();
    }

    try {
      const corruptPath = `${filePath}.corrupt-${Date.now()}`;
      await fs.rename(filePath, corruptPath);
    } catch {
      // Best effort only. Continue with an empty state.
    }

    return createEmptyState();
  }
}

function cloneState(state) {
  return {
    version: STATE_FILE_VERSION,
    routeCursors: { ...(state?.routeCursors || {}) },
    candidateStates: Object.fromEntries(
      Object.entries(state?.candidateStates || {}).map(([key, value]) => [key, { ...value }])
    ),
    bucketUsage: Object.fromEntries(
      Object.entries(state?.bucketUsage || {}).map(([bucketKey, windows]) => [
        bucketKey,
        Object.fromEntries(
          Object.entries(windows || {}).map(([windowKey, entry]) => [windowKey, { ...entry }])
        )
      ])
    )
  };
}

async function writeStateFileAtomically(filePath, state) {
  const folder = path.dirname(filePath);
  await fs.mkdir(folder, { recursive: true });

  const payload = `${JSON.stringify({
    version: STATE_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    routeCursors: state.routeCursors,
    candidateStates: state.candidateStates,
    bucketUsage: state.bucketUsage
  }, null, 2)}\n`;

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Not fatal on platforms without chmod support.
  }
}

export function getDefaultStateStorePath() {
  return path.join(os.homedir(), DEFAULT_STATE_FILENAME);
}

export async function createFileStateStore({
  filePath = getDefaultStateStorePath(),
  candidateStateTtlMs = DEFAULT_CANDIDATE_STATE_TTL_MS
} = {}) {
  const normalizedPath = String(filePath || "").trim() || getDefaultStateStorePath();
  let state = await readStateFileSafe(normalizedPath);
  let writeQueue = Promise.resolve();

  function enqueueWrite() {
    const runWrite = async () => {
      await writeStateFileAtomically(normalizedPath, state);
    };
    writeQueue = writeQueue.then(runWrite, runWrite);

    return writeQueue;
  }

  return {
    filePath: normalizedPath,

    async getRouteCursor(routeKey) {
      const key = normalizeMapKey(routeKey);
      if (!key) return 0;
      return normalizeCount(state.routeCursors[key]);
    },

    async setRouteCursor(routeKey, value) {
      const key = normalizeMapKey(routeKey);
      if (!key) return 0;
      const nextValue = normalizeCount(value);
      state.routeCursors[key] = nextValue;
      await enqueueWrite();
      return nextValue;
    },

    async getCandidateState(candidateKey) {
      const key = normalizeMapKey(candidateKey);
      if (!key) return null;
      const row = state.candidateStates[key];
      return row ? { ...row } : null;
    },

    async setCandidateState(candidateKey, candidateState) {
      const key = normalizeMapKey(candidateKey);
      if (!key) return null;
      if (candidateState === null || candidateState === undefined) {
        delete state.candidateStates[key];
        await enqueueWrite();
        return null;
      }

      const normalized = normalizeCandidateState(candidateState);
      if (!normalized) {
        delete state.candidateStates[key];
        await enqueueWrite();
        return null;
      }

      state.candidateStates[key] = normalized;
      await enqueueWrite();
      return { ...normalized };
    },

    async readBucketUsage(bucketKey, windowKey) {
      const normalizedBucketKey = normalizeMapKey(bucketKey);
      const normalizedWindowKey = normalizeMapKey(windowKey);
      if (!normalizedBucketKey || !normalizedWindowKey) return 0;

      const bucket = state.bucketUsage[normalizedBucketKey];
      if (!bucket) return 0;
      const entry = bucket[normalizedWindowKey];
      return normalizeCount(entry?.count);
    },

    async incrementBucketUsage(bucketKey, windowKey, amount = 1, options = {}) {
      const normalizedBucketKey = normalizeMapKey(bucketKey);
      const normalizedWindowKey = normalizeMapKey(windowKey);
      if (!normalizedBucketKey || !normalizedWindowKey) return 0;

      const incrementBy = normalizeEntryAmount(amount);
      if (incrementBy <= 0) {
        return this.readBucketUsage(normalizedBucketKey, normalizedWindowKey);
      }

      const now = normalizeTimestamp(options?.now) || Date.now();
      const bucket = state.bucketUsage[normalizedBucketKey] || {};
      const existing = bucket[normalizedWindowKey] || {};
      bucket[normalizedWindowKey] = {
        count: normalizeCount(existing.count) + incrementBy,
        expiresAt: normalizeTimestamp(options?.expiresAt) || normalizeTimestamp(existing.expiresAt),
        updatedAt: now
      };
      state.bucketUsage[normalizedBucketKey] = bucket;

      await enqueueWrite();
      return bucket[normalizedWindowKey].count;
    },

    async pruneExpired(now = Date.now()) {
      const currentTime = normalizeTimestamp(now) || Date.now();
      let prunedBuckets = 0;
      let prunedCandidateStates = 0;

      for (const [bucketKey, windows] of Object.entries(state.bucketUsage)) {
        for (const [windowKey, entry] of Object.entries(windows)) {
          const expiresAt = normalizeTimestamp(entry?.expiresAt);
          if (expiresAt > 0 && expiresAt <= currentTime) {
            delete windows[windowKey];
            prunedBuckets += 1;
          }
        }
        if (Object.keys(windows).length === 0) {
          delete state.bucketUsage[bucketKey];
        }
      }

      for (const [candidateKey, candidateState] of Object.entries(state.candidateStates)) {
        if (shouldPruneCandidateState(candidateState, currentTime, candidateStateTtlMs)) {
          delete state.candidateStates[candidateKey];
          prunedCandidateStates += 1;
        }
      }

      if (prunedBuckets > 0 || prunedCandidateStates > 0) {
        await enqueueWrite();
      }

      return {
        prunedBuckets,
        prunedCandidateStates
      };
    },

    async close() {
      await writeQueue;
    },

    async reloadFromDisk() {
      await writeQueue;
      state = await readStateFileSafe(normalizedPath);
      return cloneState(state);
    },

    async snapshot() {
      await writeQueue;
      return cloneState(state);
    }
  };
}
