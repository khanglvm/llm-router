import { buildBucketUsageKey, buildCandidateKey } from "./state-store.js";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const ISO_WEEK_ANCHOR_MS = Date.UTC(1970, 0, 5, 0, 0, 0, 0); // Monday

const FIXED_WINDOW_UNIT_MS = {
  second: SECOND_MS,
  minute: MINUTE_MS,
  hour: HOUR_MS,
  day: DAY_MS
};

function normalizePositiveInteger(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeEntryAmount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeTimestamp(value, fallback = Date.now()) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function normalizeWindowUnit(value) {
  const unit = String(value || "").trim().toLowerCase();
  if (unit === "second" || unit === "minute" || unit === "hour" || unit === "day" || unit === "week" || unit === "month") {
    return unit;
  }
  return "day";
}

function zeroPad(value, width = 2) {
  return String(value).padStart(width, "0");
}

function formatUtcDate(startMs) {
  const date = new Date(startMs);
  return `${date.getUTCFullYear()}-${zeroPad(date.getUTCMonth() + 1)}-${zeroPad(date.getUTCDate())}`;
}

function formatUtcMonth(startMs) {
  const date = new Date(startMs);
  return `${date.getUTCFullYear()}-${zeroPad(date.getUTCMonth() + 1)}`;
}

function formatUtcHour(startMs) {
  const date = new Date(startMs);
  return `${formatUtcDate(startMs)}T${zeroPad(date.getUTCHours())}:00Z`;
}

function formatUtcMinute(startMs) {
  const date = new Date(startMs);
  return `${formatUtcDate(startMs)}T${zeroPad(date.getUTCHours())}:${zeroPad(date.getUTCMinutes())}Z`;
}

function formatUtcSecond(startMs) {
  const date = new Date(startMs);
  return `${formatUtcDate(startMs)}T${zeroPad(date.getUTCHours())}:${zeroPad(date.getUTCMinutes())}:${zeroPad(date.getUTCSeconds())}Z`;
}

function startOfUtcIsoWeek(nowMs) {
  const date = new Date(nowMs);
  const day = date.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - diffToMonday);
  return date.getTime();
}

function resolveFixedWindowRange(unit, size, nowMs) {
  const unitMs = FIXED_WINDOW_UNIT_MS[unit] || DAY_MS;
  const spanMs = unitMs * size;
  const startsAt = Math.floor(nowMs / spanMs) * spanMs;
  const endsAt = startsAt + spanMs;

  const label = unit === "second"
    ? formatUtcSecond(startsAt)
    : unit === "minute"
      ? formatUtcMinute(startsAt)
      : unit === "hour"
        ? formatUtcHour(startsAt)
        : formatUtcDate(startsAt);

  return {
    unit,
    size,
    key: `${unit}:${size}:${label}`,
    startsAt,
    endsAt
  };
}

function resolveWeekWindowRange(size, nowMs) {
  const weekStart = startOfUtcIsoWeek(nowMs);
  const weeksFromAnchor = Math.floor((weekStart - ISO_WEEK_ANCHOR_MS) / WEEK_MS);
  const groupedWeekIndex = Math.floor(weeksFromAnchor / size) * size;
  const startsAt = ISO_WEEK_ANCHOR_MS + (groupedWeekIndex * WEEK_MS);
  const endsAt = startsAt + (size * WEEK_MS);
  return {
    unit: "week",
    size,
    key: `week:${size}:${formatUtcDate(startsAt)}`,
    startsAt,
    endsAt
  };
}

function resolveMonthWindowRange(size, nowMs) {
  const date = new Date(nowMs);
  const monthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth();
  const groupedMonthIndex = Math.floor(monthIndex / size) * size;
  const startYear = Math.floor(groupedMonthIndex / 12);
  const startMonth = groupedMonthIndex % 12;
  const endMonthIndex = groupedMonthIndex + size;
  const endYear = Math.floor(endMonthIndex / 12);
  const endMonth = endMonthIndex % 12;

  const startsAt = Date.UTC(startYear, startMonth, 1, 0, 0, 0, 0);
  const endsAt = Date.UTC(endYear, endMonth, 1, 0, 0, 0, 0);

  return {
    unit: "month",
    size,
    key: `month:${size}:${formatUtcMonth(startsAt)}`,
    startsAt,
    endsAt
  };
}

function dedupeStrings(values) {
  const output = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function findProvider(config, providerId) {
  return (config?.providers || []).find((provider) => provider?.id === providerId) || null;
}

function getModelId(candidate) {
  return String(
    candidate?.modelId ||
    candidate?.model?.id ||
    candidate?.backend ||
    ""
  ).trim();
}

export function resolveWindowRange(window, now = Date.now()) {
  const nowMs = normalizeTimestamp(now, Date.now());
  const unit = normalizeWindowUnit(window?.unit);
  const size = normalizePositiveInteger(window?.size, 1);

  if (unit === "week") {
    return resolveWeekWindowRange(size, nowMs);
  }
  if (unit === "month") {
    return resolveMonthWindowRange(size, nowMs);
  }
  return resolveFixedWindowRange(unit, size, nowMs);
}

export function resolveWindowKey(window, now = Date.now()) {
  return resolveWindowRange(window, now).key;
}

export function getApplicableRateLimitBuckets(config, candidate, now = Date.now()) {
  const provider = candidate?.provider || findProvider(config, candidate?.providerId);
  if (!provider) return [];

  const modelId = getModelId(candidate);
  if (!modelId) return [];

  const buckets = [];
  for (let index = 0; index < (provider.rateLimits || []).length; index += 1) {
    const bucket = provider.rateLimits[index];
    const bucketId = String(bucket?.id || `bucket-${index + 1}`).trim() || `bucket-${index + 1}`;
    const models = dedupeStrings(bucket?.models || []);
    const requests = normalizePositiveInteger(bucket?.requests, 0);
    if (requests <= 0 || models.length === 0) continue;

    const matchesModel = models.includes("all") || models.includes(modelId);
    if (!matchesModel) continue;

    const window = resolveWindowRange(bucket?.window, now);
    buckets.push({
      providerId: provider.id,
      modelId,
      bucketId,
      bucketKey: buildBucketUsageKey(provider.id, bucketId),
      window,
      windowKey: window.key,
      requests,
      models,
      metadata: bucket?.metadata
    });
  }

  return buckets;
}

export async function evaluateCandidateRateLimits({
  config,
  candidate,
  stateStore,
  now = Date.now()
}) {
  const buckets = getApplicableRateLimitBuckets(config, candidate, now);
  const bucketSnapshots = [];

  for (const bucket of buckets) {
    const used = stateStore
      ? normalizePositiveInteger(
          await stateStore.readBucketUsage(bucket.bucketKey, bucket.windowKey),
          0
        )
      : 0;
    const remaining = Math.max(0, bucket.requests - used);
    const remainingRatio = bucket.requests > 0 ? (remaining / bucket.requests) : 0;
    const exhausted = remaining <= 0;

    bucketSnapshots.push({
      ...bucket,
      used,
      remaining,
      remainingRatio,
      exhausted
    });
  }

  const exhaustedBuckets = bucketSnapshots.filter((snapshot) => snapshot.exhausted);
  const eligible = exhaustedBuckets.length === 0;
  const remainingCapacityRatio = bucketSnapshots.length > 0
    ? Math.min(...bucketSnapshots.map((snapshot) => snapshot.remainingRatio))
    : 1;

  return {
    candidate,
    candidateKey: buildCandidateKey(candidate),
    eligible,
    remainingCapacityRatio,
    buckets: bucketSnapshots,
    exhaustedBuckets
  };
}

export async function evaluateCandidatesRateLimits({
  config,
  candidates,
  stateStore,
  now = Date.now()
}) {
  const out = new Map();
  for (const candidate of (candidates || [])) {
    const evaluation = await evaluateCandidateRateLimits({
      config,
      candidate,
      stateStore,
      now
    });
    out.set(evaluation.candidateKey, evaluation);
  }
  return out;
}

export async function consumeCandidateRateLimits(stateStore, evaluation, {
  amount = 1,
  now = Date.now()
} = {}) {
  if (!stateStore || !evaluation) {
    return { consumed: false, reason: "no-state-store-or-evaluation" };
  }

  const incrementBy = normalizeEntryAmount(amount);
  if (incrementBy <= 0) {
    return { consumed: false, reason: "non-positive-amount" };
  }

  if (evaluation.eligible === false) {
    return { consumed: false, reason: "candidate-not-eligible" };
  }

  for (const bucket of (evaluation.buckets || [])) {
    await stateStore.incrementBucketUsage(
      bucket.bucketKey,
      bucket.windowKey,
      incrementBy,
      {
        expiresAt: bucket.window?.endsAt,
        now
      }
    );
  }

  return {
    consumed: true,
    amount: incrementBy,
    bucketCount: (evaluation.buckets || []).length
  };
}
