import { normalizeStateStoreBackend } from "../state-store.js";
import { toBoolean, toNonNegativeInteger } from "./utils.js";

function normalizeRuntimeName(value) {
  const runtime = String(value || "").trim().toLowerCase();
  if (runtime === "worker" || runtime === "cloudflare-worker" || runtime === "cloudflare") {
    return "worker";
  }
  return "node";
}

export function resolveRuntimeFlags(options = {}, env = {}) {
  const runtime = normalizeRuntimeName(options.runtime);
  const workerRuntime = runtime === "worker";
  const workerSafeMode = workerRuntime
    ? toBoolean(env?.LLM_ROUTER_WORKER_SAFE_MODE, toBoolean(options.workerSafeMode, true))
    : false;
  const allowBestEffortStatefulRouting = workerRuntime
    ? toBoolean(
        env?.LLM_ROUTER_WORKER_ALLOW_BEST_EFFORT_STATEFUL_ROUTING,
        toBoolean(options.allowWorkerBestEffortStatefulRouting, false)
      )
    : false;

  return {
    runtime,
    workerRuntime,
    workerSafeMode,
    allowBestEffortStatefulRouting,
    statefulRoutingEnabled: !workerSafeMode || allowBestEffortStatefulRouting,
    ...(typeof options.resolveLocalRuntimeBaseUrl === "function"
      ? { resolveLocalRuntimeBaseUrl: options.resolveLocalRuntimeBaseUrl }
      : {})
  };
}

export function applyRuntimeRetryPolicyGuards(retryPolicy, runtimeFlags) {
  if (!runtimeFlags?.workerSafeMode || runtimeFlags.statefulRoutingEnabled) {
    return retryPolicy;
  }

  return {
    ...retryPolicy,
    originRetryAttempts: 1,
    originRetryBaseDelayMs: 0,
    originRetryMaxDelayMs: 0
  };
}

function normalizeTimestamp(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function normalizeCount(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function isFallbackCircuitTrackingEnabled(policy) {
  return Number.isFinite(policy?.failureThreshold) &&
    Number.isFinite(policy?.cooldownMs) &&
    policy.failureThreshold > 0 &&
    policy.cooldownMs > 0;
}

function shouldTrackCandidateFailure(classification) {
  if (!classification) return false;
  if (classification.category === "invalid_request" || classification.category === "client_error") {
    return false;
  }
  if (classification.category === "not_supported_error") {
    return false;
  }
  return Boolean(classification.retryable || normalizeTimestamp(classification.originCooldownMs) > 0);
}

export async function clearCandidateRoutingState(stateStore, candidateKey) {
  if (!stateStore || !candidateKey) return;
  await stateStore.setCandidateState(candidateKey, null);
}

export async function applyCandidateFailureState(
  stateStore,
  candidateKey,
  classification,
  fallbackCircuitPolicy,
  status,
  now = Date.now()
) {
  if (!stateStore || !candidateKey || !shouldTrackCandidateFailure(classification)) {
    return;
  }

  const prior = await stateStore.getCandidateState(candidateKey) || {};
  const priorCooldownUntil = normalizeTimestamp(prior.cooldownUntil);
  const priorOpenUntil = normalizeTimestamp(prior.openUntil);
  const priorFailures = normalizeCount(
    prior.consecutiveRetryableFailures ?? prior.consecutiveFailures
  );

  const consecutiveRetryableFailures = classification.retryable
    ? priorFailures + 1
    : 0;

  let openUntil = priorOpenUntil > now ? priorOpenUntil : 0;
  if (
    classification.retryable &&
    isFallbackCircuitTrackingEnabled(fallbackCircuitPolicy) &&
    consecutiveRetryableFailures >= fallbackCircuitPolicy.failureThreshold
  ) {
    openUntil = Math.max(openUntil, now + fallbackCircuitPolicy.cooldownMs);
  }

  const cooldownMs = normalizeTimestamp(classification.originCooldownMs);
  const cooldownUntil = cooldownMs > 0
    ? Math.max(priorCooldownUntil, now + cooldownMs)
    : (priorCooldownUntil > now ? priorCooldownUntil : 0);

  await stateStore.setCandidateState(candidateKey, {
    ...prior,
    cooldownUntil,
    openUntil,
    consecutiveRetryableFailures,
    lastFailureAt: now,
    lastFailureStatus: Number.isFinite(status) ? Number(status) : 0,
    lastFailureCategory: classification.category,
    updatedAt: now
  });
}

export function resolveStateStoreOptions(options = {}, env = {}, runtimeFlags = {}) {
  const baseOptions = options.stateStoreOptions && typeof options.stateStoreOptions === "object"
    ? { ...options.stateStoreOptions }
    : {};
  const defaultBackend = normalizeStateStoreBackend(
    options.defaultStateStoreBackend || baseOptions.backend,
    "memory"
  );
  const backend = normalizeStateStoreBackend(
    options.stateStoreBackend || env?.LLM_ROUTER_STATE_BACKEND || baseOptions.backend,
    defaultBackend
  );
  const effectiveBackend = runtimeFlags?.workerRuntime && backend === "file"
    ? "memory"
    : backend;
  const candidateStateTtlMs = toNonNegativeInteger(
    env?.LLM_ROUTER_CANDIDATE_STATE_TTL_MS,
    toNonNegativeInteger(options.stateStoreCandidateStateTtlMs, baseOptions.candidateStateTtlMs)
  );
  const rawFilePath = options.stateStoreFilePath || env?.LLM_ROUTER_STATE_FILE_PATH || baseOptions.filePath;
  const filePath = typeof rawFilePath === "string" && rawFilePath.trim()
    ? rawFilePath.trim()
    : undefined;

  return {
    ...baseOptions,
    backend: effectiveBackend,
    ...(candidateStateTtlMs !== undefined ? { candidateStateTtlMs } : {}),
    ...(effectiveBackend === "file" && filePath ? { filePath } : {}),
    ...(runtimeFlags?.workerRuntime ? { workerRuntime: true } : {})
  };
}
