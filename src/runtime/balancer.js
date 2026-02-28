import { evaluateCandidatesRateLimits, consumeCandidateRateLimits } from "./rate-limits.js";
import { buildCandidateKey, buildRouteKey } from "./state-store.js";

const WEIGHT_SCALE = 100;
const MAX_WEIGHT_SLOTS = 512;

function normalizeStrategyName(strategy) {
  const normalized = String(strategy || "").trim().toLowerCase();
  if (normalized === "auto" || normalized === "automatic" || normalized === "smart") {
    return "quota-aware-weighted-rr";
  }
  if (normalized === "round-robin" || normalized === "rr") return "round-robin";
  if (normalized === "weighted-round-robin" || normalized === "weighted-rr" || normalized === "weighted_rr") {
    return "weighted-rr";
  }
  if (normalized === "quota-aware-weighted-rr" || normalized === "quota-aware-weighted-round-robin") {
    return "quota-aware-weighted-rr";
  }
  return "ordered";
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function gcdMany(values) {
  if (!Array.isArray(values) || values.length === 0) return 1;
  return values.reduce((acc, value) => gcd(acc, value), 0) || 1;
}

function resolveCandidateWeight(candidate) {
  const raw = candidate?.routeWeight ??
    candidate?.weight ??
    candidate?.targetWeight ??
    1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.floor(parsed);
}

function resolveHealthState(candidateState, now) {
  const openUntil = Math.max(
    normalizeNonNegativeInteger(candidateState?.openUntil),
    normalizeNonNegativeInteger(candidateState?.cooldownUntil)
  );
  const blocked = openUntil > now;
  const failures = normalizeNonNegativeInteger(
    candidateState?.consecutiveRetryableFailures ?? candidateState?.consecutiveFailures
  );
  const healthPenaltyFromFailures = 1 / (1 + (failures * 0.5));
  const healthScore = candidateState?.healthScore;
  const boundedHealthScore = Number.isFinite(healthScore)
    ? clamp(Number(healthScore), 0.05, 1)
    : 1;

  return {
    blocked,
    openUntil,
    failures,
    healthFactor: clamp(healthPenaltyFromFailures * boundedHealthScore, 0.05, 1)
  };
}

function rotateArray(values, startIndex) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const start = values.length > 0
    ? ((startIndex % values.length) + values.length) % values.length
    : 0;
  return [...values.slice(start), ...values.slice(0, start)];
}

function buildWeightedSlots(entries, { quotaAware = false } = {}) {
  const normalizedWeights = entries.map((entry) => {
    const ratioFactor = quotaAware
      ? clamp(entry.remainingCapacityRatio, 0, 1)
      : 1;
    const effectiveWeight = Math.max(
      0,
      entry.weight * ratioFactor * entry.healthFactor
    );
    return Math.max(1, Math.round(effectiveWeight * WEIGHT_SCALE));
  });

  const divisor = gcdMany(normalizedWeights);
  let slotWeights = normalizedWeights.map((value) => Math.max(1, Math.floor(value / divisor)));
  let totalSlots = slotWeights.reduce((sum, value) => sum + value, 0);

  if (totalSlots > MAX_WEIGHT_SLOTS) {
    const scaleDown = totalSlots / MAX_WEIGHT_SLOTS;
    slotWeights = slotWeights.map((value) => Math.max(1, Math.round(value / scaleDown)));
    totalSlots = slotWeights.reduce((sum, value) => sum + value, 0);
  }

  const slots = [];
  for (let index = 0; index < entries.length; index += 1) {
    const slotCount = slotWeights[index];
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      slots.push(entries[index]);
    }
  }

  return {
    slots,
    slotCount: totalSlots
  };
}

function sortEntriesByOriginalOrder(left, right) {
  return left.originalIndex - right.originalIndex;
}

async function buildCandidateEntries({
  candidates,
  stateStore,
  rateLimitEvaluations,
  now
}) {
  const entries = [];

  for (let index = 0; index < (candidates || []).length; index += 1) {
    const candidate = candidates[index];
    const candidateKey = buildCandidateKey(candidate);
    const candidateState = stateStore
      ? await stateStore.getCandidateState(candidateKey)
      : null;
    const rateLimitEvaluation = rateLimitEvaluations?.get(candidateKey) || null;
    const health = resolveHealthState(candidateState, now);
    const blockedByRateLimits = rateLimitEvaluation ? !rateLimitEvaluation.eligible : false;
    const skipReasons = [];
    if (health.blocked) skipReasons.push("cooldown");
    if (blockedByRateLimits) skipReasons.push("quota-exhausted");

    entries.push({
      candidate,
      candidateKey,
      candidateState,
      rateLimitEvaluation,
      originalIndex: index,
      weight: resolveCandidateWeight(candidate),
      remainingCapacityRatio: rateLimitEvaluation?.remainingCapacityRatio ?? 1,
      healthFactor: health.healthFactor,
      openUntil: health.openUntil,
      eligible: !health.blocked && !blockedByRateLimits,
      skipReasons
    });
  }

  return entries;
}

function rankEligibleEntries(strategy, eligibleEntries, routeCursor) {
  if (eligibleEntries.length <= 1) {
    return {
      orderedEligible: [...eligibleEntries],
      nextCursor: routeCursor,
      shouldAdvanceCursor: false
    };
  }

  if (strategy === "ordered") {
    return {
      orderedEligible: [...eligibleEntries],
      nextCursor: routeCursor,
      shouldAdvanceCursor: false
    };
  }

  if (strategy === "round-robin") {
    const orderedEligible = rotateArray(eligibleEntries, routeCursor);
    const nextCursor = (routeCursor + 1) % eligibleEntries.length;
    return {
      orderedEligible,
      nextCursor,
      shouldAdvanceCursor: true
    };
  }

  const weighted = buildWeightedSlots(eligibleEntries, {
    quotaAware: strategy === "quota-aware-weighted-rr"
  });
  if (weighted.slots.length === 0) {
    return {
      orderedEligible: [...eligibleEntries],
      nextCursor: routeCursor,
      shouldAdvanceCursor: false
    };
  }

  const slotCursor = ((routeCursor % weighted.slots.length) + weighted.slots.length) % weighted.slots.length;
  const orderedSlots = rotateArray(weighted.slots, slotCursor);
  const seen = new Set();
  const orderedEligible = [];
  for (const entry of orderedSlots) {
    if (seen.has(entry.candidateKey)) continue;
    seen.add(entry.candidateKey);
    orderedEligible.push(entry);
    if (orderedEligible.length === eligibleEntries.length) break;
  }

  return {
    orderedEligible,
    nextCursor: (slotCursor + 1) % weighted.slots.length,
    shouldAdvanceCursor: true
  };
}

export async function rankRouteCandidates({
  route,
  routeKey,
  strategy,
  candidates,
  stateStore,
  config,
  rateLimitEvaluations,
  now = Date.now()
}) {
  const normalizedStrategy = normalizeStrategyName(strategy || route?.routeStrategy || route?.strategy);
  const resolvedRouteKey = String(routeKey || buildRouteKey(route || "route")).trim();
  const currentTime = normalizeNonNegativeInteger(now) || Date.now();

  const evaluations = rateLimitEvaluations || await evaluateCandidatesRateLimits({
    config,
    candidates,
    stateStore,
    now: currentTime
  });

  const entries = await buildCandidateEntries({
    candidates,
    stateStore,
    rateLimitEvaluations: evaluations,
    now: currentTime
  });
  const eligibleEntries = entries
    .filter((entry) => entry.eligible)
    .sort(sortEntriesByOriginalOrder);
  const ineligibleEntries = entries
    .filter((entry) => !entry.eligible)
    .sort(sortEntriesByOriginalOrder);

  const routeCursor = stateStore
    ? await stateStore.getRouteCursor(resolvedRouteKey)
    : 0;
  const ranking = rankEligibleEntries(normalizedStrategy, eligibleEntries, routeCursor);

  const rankedEntries = [
    ...ranking.orderedEligible,
    ...ineligibleEntries
  ];

  return {
    routeKey: resolvedRouteKey,
    strategy: normalizedStrategy,
    now: currentTime,
    routeCursor,
    nextCursor: ranking.nextCursor,
    shouldAdvanceCursor: ranking.shouldAdvanceCursor,
    entries: rankedEntries,
    selectedEntry: ranking.orderedEligible[0] || null,
    skippedEntries: ineligibleEntries,
    rankedCandidates: rankedEntries.map((entry) => entry.candidate)
  };
}

export async function commitRouteSelection(stateStore, rankingResult, {
  amount = 1,
  now = Date.now()
} = {}) {
  if (!stateStore || !rankingResult) {
    return { committed: false, reason: "no-state-store-or-ranking" };
  }

  if (!rankingResult.selectedEntry) {
    return { committed: false, reason: "no-selected-candidate" };
  }

  if (rankingResult.shouldAdvanceCursor) {
    await stateStore.setRouteCursor(rankingResult.routeKey, rankingResult.nextCursor);
  }

  const rateLimitCommit = await consumeCandidateRateLimits(
    stateStore,
    rankingResult.selectedEntry.rateLimitEvaluation,
    { amount, now }
  );

  return {
    committed: true,
    selectedCandidateKey: rankingResult.selectedEntry.candidateKey,
    routeCursorCommitted: rankingResult.shouldAdvanceCursor,
    rateLimitCommit
  };
}
