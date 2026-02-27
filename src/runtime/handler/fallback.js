import {
  parseJsonSafely,
  parseRetryAfterMs,
  toBoolean,
  toNonNegativeInteger
} from "./utils.js";

const DEFAULT_FALLBACK_CIRCUIT_FAILURES = 2;
const DEFAULT_FALLBACK_CIRCUIT_COOLDOWN_MS = 30_000;
const DEFAULT_ORIGIN_RETRY_ATTEMPTS = 3;
const DEFAULT_ORIGIN_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_ORIGIN_RETRY_MAX_DELAY_MS = 3_000;
const DEFAULT_ORIGIN_FALLBACK_COOLDOWN_MS = 45_000;
const DEFAULT_ORIGIN_RATE_LIMIT_COOLDOWN_MS = 30_000;
const DEFAULT_ORIGIN_BILLING_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_ORIGIN_AUTH_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_ORIGIN_POLICY_COOLDOWN_MS = 2 * 60_000;
const ERROR_TEXT_SCAN_LIMIT = 4_096;
const BILLING_HINTS = [
  "insufficient_quota",
  "insufficient quota",
  "insufficient balance",
  "insufficient credits",
  "not enough credits",
  "out of credits",
  "payment required",
  "billing hard limit",
  "quota exceeded"
];
const AUTH_HINTS = [
  "invalid api key",
  "incorrect api key",
  "api key not valid",
  "authentication",
  "unauthorized",
  "permission denied",
  "forbidden"
];
const POLICY_HINTS = [
  "moderation",
  "policy_violation",
  "content policy",
  "safety",
  "unsafe",
  "flagged"
];
const fallbackCircuitState = new Map();

export function shouldRetryStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function resolveRetryPolicy(env = {}) {
  const originRetryAttemptsRaw = toNonNegativeInteger(
    env?.LLM_ROUTER_ORIGIN_RETRY_ATTEMPTS,
    DEFAULT_ORIGIN_RETRY_ATTEMPTS
  );
  const originRetryAttempts = Math.min(Math.max(originRetryAttemptsRaw, 1), 10);

  const originRetryBaseDelayMs = Math.max(
    0,
    toNonNegativeInteger(
      env?.LLM_ROUTER_ORIGIN_RETRY_BASE_DELAY_MS,
      DEFAULT_ORIGIN_RETRY_BASE_DELAY_MS
    )
  );
  const originRetryMaxDelayMs = Math.max(
    originRetryBaseDelayMs,
    toNonNegativeInteger(
      env?.LLM_ROUTER_ORIGIN_RETRY_MAX_DELAY_MS,
      DEFAULT_ORIGIN_RETRY_MAX_DELAY_MS
    )
  );

  return {
    originRetryAttempts,
    originRetryBaseDelayMs,
    originRetryMaxDelayMs,
    originFallbackCooldownMs: toNonNegativeInteger(
      env?.LLM_ROUTER_ORIGIN_FALLBACK_COOLDOWN_MS,
      DEFAULT_ORIGIN_FALLBACK_COOLDOWN_MS
    ),
    originRateLimitCooldownMs: toNonNegativeInteger(
      env?.LLM_ROUTER_ORIGIN_RATE_LIMIT_COOLDOWN_MS,
      DEFAULT_ORIGIN_RATE_LIMIT_COOLDOWN_MS
    ),
    originBillingCooldownMs: toNonNegativeInteger(
      env?.LLM_ROUTER_ORIGIN_BILLING_COOLDOWN_MS,
      DEFAULT_ORIGIN_BILLING_COOLDOWN_MS
    ),
    originAuthCooldownMs: toNonNegativeInteger(
      env?.LLM_ROUTER_ORIGIN_AUTH_COOLDOWN_MS,
      DEFAULT_ORIGIN_AUTH_COOLDOWN_MS
    ),
    originPolicyCooldownMs: toNonNegativeInteger(
      env?.LLM_ROUTER_ORIGIN_POLICY_COOLDOWN_MS,
      DEFAULT_ORIGIN_POLICY_COOLDOWN_MS
    ),
    allowPolicyFallback: toBoolean(env?.LLM_ROUTER_ALLOW_POLICY_FALLBACK, false)
  };
}

export function computeRetryDelayMs(attemptNumber, policy) {
  const exponent = Math.max(0, attemptNumber - 1);
  const exponential = policy.originRetryBaseDelayMs * (2 ** exponent);
  const capped = Math.min(exponential, policy.originRetryMaxDelayMs);
  const jitterMultiplier = 0.5 + (Math.random() * 0.5);
  return Math.max(0, Math.round(capped * jitterMultiplier));
}

function hasAnyHint(text, hints) {
  if (!text) return false;
  for (const hint of hints) {
    if (text.includes(hint)) return true;
  }
  return false;
}

export function resolveFallbackCircuitPolicy(env = {}) {
  return {
    failureThreshold: toNonNegativeInteger(
      env?.LLM_ROUTER_FALLBACK_CIRCUIT_FAILURES,
      DEFAULT_FALLBACK_CIRCUIT_FAILURES
    ),
    cooldownMs: toNonNegativeInteger(
      env?.LLM_ROUTER_FALLBACK_CIRCUIT_COOLDOWN_MS,
      DEFAULT_FALLBACK_CIRCUIT_COOLDOWN_MS
    )
  };
}

function isFallbackCircuitEnabled(policy) {
  return Number.isFinite(policy?.failureThreshold) &&
    Number.isFinite(policy?.cooldownMs) &&
    policy.failureThreshold > 0 &&
    policy.cooldownMs > 0;
}

function candidateCircuitKey(candidate) {
  const model = candidate?.requestModelId || `${candidate?.providerId || "unknown"}/${candidate?.modelId || "unknown"}`;
  const format = candidate?.targetFormat || "unknown";
  return `${model}@${format}`;
}

function getCandidateCircuitSnapshot(candidate, now = Date.now()) {
  const key = candidateCircuitKey(candidate);
  const state = fallbackCircuitState.get(key);
  if (!state) {
    return { key, isOpen: false, openUntil: 0 };
  }
  const openUntil = Number.isFinite(state.openUntil) ? Number(state.openUntil) : 0;
  return {
    key,
    isOpen: openUntil > now,
    openUntil
  };
}

export function orderCandidatesByCircuit(candidates, policy, now = Date.now()) {
  const ranked = (candidates || []).map((candidate, originalIndex) => ({
    candidate,
    originalIndex,
    circuit: getCandidateCircuitSnapshot(candidate, now)
  }));

  if (!isFallbackCircuitEnabled(policy) || ranked.length <= 1) {
    return ranked;
  }

  ranked.sort((left, right) => {
    if (left.circuit.isOpen !== right.circuit.isOpen) {
      return left.circuit.isOpen ? 1 : -1;
    }
    if (left.circuit.isOpen && right.circuit.isOpen && left.circuit.openUntil !== right.circuit.openUntil) {
      return left.circuit.openUntil - right.circuit.openUntil;
    }
    return left.originalIndex - right.originalIndex;
  });
  return ranked;
}

export function markCandidateSuccess(candidate) {
  fallbackCircuitState.delete(candidateCircuitKey(candidate));
}

export function markCandidateFailure(candidate, result, policy, options = {}) {
  const now = options?.now ?? Date.now();
  const trackFailure = options?.trackFailure !== false;
  const key = candidateCircuitKey(candidate);
  if (!trackFailure) {
    fallbackCircuitState.delete(key);
    return;
  }

  if (!isFallbackCircuitEnabled(policy)) {
    fallbackCircuitState.delete(key);
    return;
  }

  if (!result?.retryable) {
    fallbackCircuitState.delete(key);
    return;
  }

  const prior = fallbackCircuitState.get(key);
  const resetAfterCooldown = prior && Number.isFinite(prior.openUntil) && prior.openUntil <= now;
  const previousFailures = resetAfterCooldown ? 0 : (prior?.consecutiveRetryableFailures || 0);
  const consecutiveRetryableFailures = previousFailures + 1;

  fallbackCircuitState.set(key, {
    consecutiveRetryableFailures,
    openUntil: consecutiveRetryableFailures >= policy.failureThreshold
      ? now + policy.cooldownMs
      : 0,
    lastFailureAt: now,
    lastFailureStatus: result.status
  });
}

export function setCandidateCooldown(candidate, cooldownMs, policy, status, now = Date.now()) {
  if (!isFallbackCircuitEnabled(policy)) return;
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return;

  const key = candidateCircuitKey(candidate);
  const prior = fallbackCircuitState.get(key) || {};
  const priorOpenUntil = Number.isFinite(prior.openUntil) ? Number(prior.openUntil) : 0;
  const openUntil = Math.max(priorOpenUntil, now + cooldownMs);

  fallbackCircuitState.set(key, {
    consecutiveRetryableFailures: prior?.consecutiveRetryableFailures || 0,
    openUntil,
    lastFailureAt: now,
    lastFailureStatus: status
  });
}

async function readProviderErrorHint(result) {
  if (!(result?.upstreamResponse instanceof Response)) return "";
  try {
    const raw = await result.upstreamResponse.clone().text();
    if (!raw) return "";
    const limitedRaw = raw.slice(0, ERROR_TEXT_SCAN_LIMIT);
    const parsed = parseJsonSafely(limitedRaw);
    const fragments = [
      parsed?.error?.code,
      parsed?.error?.type,
      parsed?.error?.message,
      parsed?.error,
      parsed?.code,
      parsed?.type,
      parsed?.message,
      limitedRaw
    ];
    return fragments
      .filter((entry) => entry !== undefined && entry !== null)
      .map((entry) => String(entry).toLowerCase())
      .join(" ");
  } catch {
    return "";
  }
}

export async function classifyFailureResult(result, retryPolicy) {
  const status = Number.isFinite(result?.status) ? Number(result.status) : 0;
  const retryAfterMs = parseRetryAfterMs(result?.upstreamResponse?.headers?.get("retry-after"));

  if (result?.errorKind === "configuration_error") {
    return {
      category: "configuration_error",
      retryable: false,
      retryOrigin: false,
      allowFallback: true,
      originCooldownMs: retryPolicy.originFallbackCooldownMs
    };
  }

  if (result?.errorKind === "not_supported_error") {
    return {
      category: "not_supported_error",
      retryable: false,
      retryOrigin: false,
      allowFallback: true,
      originCooldownMs: 0
    };
  }

  if (result?.errorKind === "network_error") {
    return {
      category: "network_error",
      retryable: true,
      retryOrigin: true,
      allowFallback: true,
      originCooldownMs: 0
    };
  }

  if (status === 429) {
    const rateLimitCooldown = retryAfterMs > 0 ? retryAfterMs : retryPolicy.originRateLimitCooldownMs;
    return {
      category: "rate_limited",
      retryable: true,
      retryOrigin: false,
      allowFallback: true,
      originCooldownMs: rateLimitCooldown
    };
  }

  if (status === 402) {
    return {
      category: "billing_exhausted",
      retryable: false,
      retryOrigin: false,
      allowFallback: true,
      originCooldownMs: retryPolicy.originBillingCooldownMs
    };
  }

  if (status === 401) {
    return {
      category: "auth_failed",
      retryable: false,
      retryOrigin: false,
      allowFallback: true,
      originCooldownMs: retryPolicy.originAuthCooldownMs
    };
  }

  if (status === 403) {
    const hintText = await readProviderErrorHint(result);
    if (hasAnyHint(hintText, BILLING_HINTS)) {
      return {
        category: "billing_exhausted",
        retryable: false,
        retryOrigin: false,
        allowFallback: true,
        originCooldownMs: retryPolicy.originBillingCooldownMs
      };
    }

    if (hasAnyHint(hintText, POLICY_HINTS)) {
      return {
        category: "policy_blocked",
        retryable: false,
        retryOrigin: false,
        allowFallback: retryPolicy.allowPolicyFallback,
        originCooldownMs: retryPolicy.originPolicyCooldownMs
      };
    }

    if (hasAnyHint(hintText, AUTH_HINTS)) {
      return {
        category: "auth_failed",
        retryable: false,
        retryOrigin: false,
        allowFallback: true,
        originCooldownMs: retryPolicy.originAuthCooldownMs
      };
    }

    return {
      category: "forbidden",
      retryable: false,
      retryOrigin: false,
      allowFallback: true,
      originCooldownMs: retryPolicy.originAuthCooldownMs
    };
  }

  if (status === 404 || status === 410) {
    return {
      category: "not_found",
      retryable: false,
      retryOrigin: false,
      allowFallback: true,
      originCooldownMs: retryPolicy.originFallbackCooldownMs
    };
  }

  if (status === 408 || status === 409 || status >= 500) {
    return {
      category: "temporary_error",
      retryable: true,
      retryOrigin: true,
      allowFallback: true,
      originCooldownMs: retryAfterMs
    };
  }

  if ([400, 413, 422].includes(status)) {
    return {
      category: "invalid_request",
      retryable: false,
      retryOrigin: false,
      allowFallback: false,
      originCooldownMs: 0
    };
  }

  if (status >= 400 && status < 500) {
    return {
      category: "client_error",
      retryable: false,
      retryOrigin: false,
      allowFallback: false,
      originCooldownMs: 0
    };
  }

  return {
    category: "unknown_error",
    retryable: false,
    retryOrigin: false,
    allowFallback: true,
    originCooldownMs: 0
  };
}

export function enrichErrorMessage(error, candidate, isFallback) {
  const prefix = `${candidate.providerId}/${candidate.modelId}`;
  if (isFallback) {
    return `[fallback ${prefix}] ${error}`;
  }
  return `[${prefix}] ${error}`;
}
