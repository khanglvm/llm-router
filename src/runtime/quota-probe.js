/**
 * Pure logic for provider quota-probe snapshots, verdicts, and config normalization.
 * Zero IO — all functions are deterministic and side-effect free.
 */

const VALID_CAP_KINDS = new Set(["dollars", "tokens", "requests"]);
const VALID_COMBINATORS = new Set(["AND", "OR", "REPLACE"]);
const VALID_ENFORCE_MODES = new Set(["gate", "observe"]);
const VALID_PROBE_MODES = new Set(["http", "custom"]);
const VALID_HTTP_METHODS = new Set(["GET", "POST"]);

const HTTP_TIMEOUT_DEFAULT = 5000;
const HTTP_TIMEOUT_CAP = 15000;
const CUSTOM_TIMEOUT_DEFAULT = 2000;
const CUSTOM_TIMEOUT_CAP = 10000;

function isFiniteNonNeg(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export function validateSnapshot(raw) {
  if (!raw || typeof raw !== "object") {
    return { valid: false, error: "snapshot must be an object" };
  }
  if (!VALID_CAP_KINDS.has(raw.capKind)) {
    return { valid: false, error: `invalid capKind: ${raw.capKind}` };
  }
  for (const field of ["used", "limit", "remaining"]) {
    if (field in raw && raw[field] !== undefined && raw[field] !== null) {
      if (!isFiniteNonNeg(raw[field])) {
        return { valid: false, error: `${field} must be a non-negative finite number` };
      }
    }
  }
  if (!raw.isUnlimited) {
    const present = ["used", "limit", "remaining"].filter(
      (f) => f in raw && isFiniteNonNeg(raw[f])
    );
    if (present.length < 2) {
      return { valid: false, error: "at least two of {used, limit, remaining} required" };
    }
  }
  return { valid: true, error: null };
}

export function deriveSnapshot(raw) {
  const out = { ...raw };
  const hasUsed = isFiniteNonNeg(out.used);
  const hasLimit = isFiniteNonNeg(out.limit);
  const hasRemaining = isFiniteNonNeg(out.remaining);

  if (hasUsed && hasLimit && !hasRemaining) {
    out.remaining = out.limit - out.used;
  } else if (hasLimit && hasRemaining && !hasUsed) {
    out.used = out.limit - out.remaining;
  } else if (hasUsed && hasRemaining && !hasLimit) {
    out.limit = out.used + out.remaining;
  }
  return out;
}

export function isExhausted(snapshot, safetyMargin) {
  if (snapshot.isUnlimited) return false;
  if (!isFiniteNonNeg(snapshot.remaining)) return false;

  const dollarMargin = safetyMargin?.dollars ?? 0;
  const percentMargin = safetyMargin?.percent ?? 0;
  const limitBased = isFiniteNonNeg(snapshot.limit)
    ? (snapshot.limit * percentMargin) / 100
    : 0;
  const effectiveMargin = Math.max(dollarMargin, limitBased);
  return snapshot.remaining <= effectiveMargin;
}

export function resolveProbeVerdict(snapshot, probeConfig, _now) {
  if (!snapshot || !probeConfig?.enabled) return null;
  if (probeConfig.enforce !== "gate") return null;
  if (snapshot.state === "unknown" || snapshot.state === "errored") return null;
  if (snapshot.isUnlimited) return { available: true, reason: "unlimited" };

  const derived = deriveSnapshot(snapshot);
  const margin = probeConfig.safetyMargin ?? { dollars: 0, percent: 0 };
  if (isExhausted(derived, margin)) {
    return { available: false, reason: "quota exhausted" };
  }
  return { available: true, reason: "within budget" };
}

export function applyQuotaProbeGate({ combinator, probeAvailable, rateLimitEligible }) {
  const probeOk = probeAvailable === null || probeAvailable === undefined ? true : probeAvailable;
  const rlOk = !!rateLimitEligible;

  switch (combinator) {
    case "OR":
      return probeOk || rlOk
        ? { eligible: true, skipReason: null }
        : { eligible: false, skipReason: "probe and rate-limit both unavailable" };
    case "REPLACE":
      return probeOk
        ? { eligible: true, skipReason: null }
        : { eligible: false, skipReason: "probe unavailable" };
    case "AND":
    default:
      if (!probeOk && !rlOk) return { eligible: false, skipReason: "probe and rate-limit both unavailable" };
      if (!probeOk) return { eligible: false, skipReason: "probe unavailable" };
      if (!rlOk) return { eligible: false, skipReason: "rate-limit exceeded" };
      return { eligible: true, skipReason: null };
  }
}

function clampTimeout(value, defaultVal, cap) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return defaultVal;
  return Math.min(n, cap);
}

function normalizeHttpBlock(raw) {
  if (!raw || typeof raw !== "object") return null;
  const method = VALID_HTTP_METHODS.has(raw.method) ? raw.method : "GET";
  const url = typeof raw.url === "string" ? raw.url : "";
  const headers = Array.isArray(raw.headers) ? raw.headers : [];
  const body = raw.body !== undefined ? raw.body : undefined;
  const timeoutMs = clampTimeout(raw.timeoutMs, HTTP_TIMEOUT_DEFAULT, HTTP_TIMEOUT_CAP);
  const mapping = raw.mapping && typeof raw.mapping === "object" ? raw.mapping : {};
  return { method, url, headers, body, timeoutMs, mapping };
}

function normalizeCustomBlock(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = typeof raw.source === "string" ? raw.source : "";
  const timeoutMs = clampTimeout(raw.timeoutMs, CUSTOM_TIMEOUT_DEFAULT, CUSTOM_TIMEOUT_CAP);
  return { source, timeoutMs };
}

function normalizeMargin(raw) {
  if (!raw || typeof raw !== "object") return { dollars: 0, percent: 0 };
  const dollars = isFiniteNonNeg(raw.dollars) ? raw.dollars : 0;
  const percent = isFiniteNonNeg(raw.percent) ? raw.percent : 0;
  return { dollars, percent };
}

function normalizeRefreshTriggers(raw) {
  const defaults = { onUiOpen: false, onManual: true, onResetAt: false, onUpstreamError: null };
  if (!raw || typeof raw !== "object") return defaults;
  const out = {
    onUiOpen: !!raw.onUiOpen,
    onManual: true,
    onResetAt: !!raw.onResetAt,
    onUpstreamError: null
  };
  if (raw.onUpstreamError && typeof raw.onUpstreamError === "object") {
    out.onUpstreamError = {
      statusCodes: Array.isArray(raw.onUpstreamError.statusCodes)
        ? raw.onUpstreamError.statusCodes.filter((c) => Number.isFinite(c))
        : [],
      bodyRegex: typeof raw.onUpstreamError.bodyRegex === "string"
        ? raw.onUpstreamError.bodyRegex
        : null
    };
  }
  return out;
}

export function normalizeQuotaProbeConfig(raw) {
  if (!raw || typeof raw !== "object" || raw.enabled !== true) return null;

  const capKind = VALID_CAP_KINDS.has(raw.capKind) ? raw.capKind : null;
  if (!capKind) return null;

  const combinator = VALID_COMBINATORS.has(raw.combinator) ? raw.combinator : "AND";
  const enforce = VALID_ENFORCE_MODES.has(raw.enforce) ? raw.enforce : "gate";
  const mode = VALID_PROBE_MODES.has(raw.mode) ? raw.mode : "http";
  const safetyMargin = normalizeMargin(raw.safetyMargin);
  const http = normalizeHttpBlock(raw.http);
  const custom = normalizeCustomBlock(raw.custom);
  const refreshTriggers = normalizeRefreshTriggers(raw.refreshTriggers);

  return { enabled: true, capKind, combinator, enforce, mode, safetyMargin, http, custom, refreshTriggers };
}
