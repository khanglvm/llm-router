import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRuntimeConfig } from "./config.js";
import { createMemoryStateStore } from "./state-store.memory.js";
import {
  consumeCandidateRateLimits,
  evaluateCandidateRateLimits,
  getApplicableRateLimitBuckets,
  resolveWindowRange
} from "./rate-limits.js";

function createConfigWithRateLimits() {
  return normalizeRuntimeConfig({
    version: 2,
    defaultModel: "openrouter/gpt-4o-mini",
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [
          { id: "gpt-4o-mini" },
          { id: "gpt-4o" }
        ],
        rateLimits: [
          {
            id: "all-month",
            models: ["all"],
            requests: 100,
            window: { unit: "month", size: 1 }
          },
          {
            id: "gpt4o-week",
            models: ["gpt-4o"],
            requests: 20,
            window: { unit: "week", size: 1 }
          }
        ]
      }
    ]
  });
}

test("window key generation supports hour/day/week/month using UTC boundaries", () => {
  const now = Date.UTC(2026, 1, 28, 15, 42, 30); // 2026-02-28T15:42:30Z
  const hour = resolveWindowRange({ unit: "hour", size: 1 }, now);
  const sixHours = resolveWindowRange({ unit: "hour", size: 6 }, now);
  const day = resolveWindowRange({ unit: "day", size: 1 }, now);
  const week = resolveWindowRange({ unit: "week", size: 1 }, now);
  const month = resolveWindowRange({ unit: "month", size: 1 }, now);

  assert.equal(hour.key, "hour:1:2026-02-28T15:00Z");
  assert.equal(sixHours.key, "hour:6:2026-02-28T12:00Z");
  assert.equal(day.key, "day:1:2026-02-28");
  assert.equal(week.key, "week:1:2026-02-23");
  assert.equal(month.key, "month:1:2026-02");
});

test("bucket matching includes provider-wide models: all buckets", () => {
  const config = createConfigWithRateLimits();
  const candidate = {
    providerId: "openrouter",
    modelId: "gpt-4o-mini",
    requestModelId: "openrouter/gpt-4o-mini",
    targetFormat: "openai"
  };

  const buckets = getApplicableRateLimitBuckets(config, candidate, Date.UTC(2026, 1, 28));
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].bucketId, "all-month");
});

test("bucket matching supports explicit model ids", () => {
  const config = createConfigWithRateLimits();

  const gpt4oCandidate = {
    providerId: "openrouter",
    modelId: "gpt-4o",
    requestModelId: "openrouter/gpt-4o",
    targetFormat: "openai"
  };
  const gpt4oBuckets = getApplicableRateLimitBuckets(config, gpt4oCandidate, Date.UTC(2026, 1, 28));
  assert.equal(gpt4oBuckets.length, 2);
  assert.deepEqual(
    gpt4oBuckets.map((bucket) => bucket.bucketId).sort(),
    ["all-month", "gpt4o-week"]
  );

  const miniCandidate = {
    providerId: "openrouter",
    modelId: "gpt-4o-mini",
    requestModelId: "openrouter/gpt-4o-mini",
    targetFormat: "openai"
  };
  const miniBuckets = getApplicableRateLimitBuckets(config, miniCandidate, Date.UTC(2026, 1, 28));
  assert.equal(miniBuckets.length, 1);
  assert.equal(miniBuckets[0].bucketId, "all-month");
});

test("candidate is ineligible when any applicable bucket is exhausted", async () => {
  const now = Date.UTC(2026, 1, 28, 15, 0, 0);
  const config = normalizeRuntimeConfig({
    version: 2,
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o" }],
        rateLimits: [
          {
            id: "all-month",
            models: ["all"],
            requests: 5,
            window: { unit: "month", size: 1 }
          },
          {
            id: "gpt4o-day",
            models: ["gpt-4o"],
            requests: 2,
            window: { unit: "day", size: 1 }
          }
        ]
      }
    ]
  });
  const candidate = {
    providerId: "openrouter",
    modelId: "gpt-4o",
    requestModelId: "openrouter/gpt-4o",
    targetFormat: "openai"
  };
  const store = createMemoryStateStore();
  const buckets = getApplicableRateLimitBuckets(config, candidate, now);
  const daily = buckets.find((bucket) => bucket.bucketId === "gpt4o-day");
  assert.ok(daily);
  await store.incrementBucketUsage(daily.bucketKey, daily.windowKey, 2, {
    expiresAt: daily.window.endsAt
  });

  const evaluation = await evaluateCandidateRateLimits({
    config,
    candidate,
    stateStore: store,
    now
  });
  assert.equal(evaluation.eligible, false);
  assert.equal(evaluation.exhaustedBuckets.length, 1);
  assert.equal(evaluation.exhaustedBuckets[0].bucketId, "gpt4o-day");
});

test("candidate remains eligible when multiple buckets have remaining capacity", async () => {
  const now = Date.UTC(2026, 1, 28, 15, 0, 0);
  const config = createConfigWithRateLimits();
  const candidate = {
    providerId: "openrouter",
    modelId: "gpt-4o",
    requestModelId: "openrouter/gpt-4o",
    targetFormat: "openai"
  };
  const store = createMemoryStateStore();

  let evaluation = await evaluateCandidateRateLimits({
    config,
    candidate,
    stateStore: store,
    now
  });
  assert.equal(evaluation.eligible, true);
  assert.equal(evaluation.buckets.length, 2);

  await consumeCandidateRateLimits(store, evaluation, { amount: 3, now });
  evaluation = await evaluateCandidateRateLimits({
    config,
    candidate,
    stateStore: store,
    now
  });
  assert.equal(evaluation.eligible, true);
  assert.ok(evaluation.remainingCapacityRatio > 0);
});
