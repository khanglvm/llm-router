import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAutoRateLimitBucketId,
  buildRateLimitBucketsFromDraftRows,
  formatRateLimitBucketCap,
  normalizeRateLimitModelSelectors,
  validateRateLimitDraftRows
} from "./rate-limit-utils.js";

test("buildAutoRateLimitBucketId derives ids from request and window values", () => {
  assert.equal(
    buildAutoRateLimitBucketId({ requests: "180", windowValue: "3", windowUnit: "week" }),
    "180-req-per-3-weeks"
  );
  assert.equal(
    buildAutoRateLimitBucketId({ requests: "60", windowValue: "1", windowUnit: "minute" }),
    "60-req-per-1-minute"
  );
});

test("normalizeRateLimitModelSelectors collapses all selectors", () => {
  assert.deepEqual(
    normalizeRateLimitModelSelectors(["gpt-4o-mini", "all", "gpt-4.1-mini"]),
    ["all"]
  );
  assert.deepEqual(
    normalizeRateLimitModelSelectors(["gpt-4o-mini", "gpt-4o-mini", "gpt-4.1-mini"]),
    ["gpt-4o-mini", "gpt-4.1-mini"]
  );
});

test("validateRateLimitDraftRows rejects duplicate generated ids", () => {
  const message = validateRateLimitDraftRows([
    { models: ["all"], requests: "180", windowValue: "3", windowUnit: "week" },
    { models: ["gpt-4o-mini"], requests: "180", windowValue: "3", windowUnit: "week" }
  ], {
    knownModelIds: ["gpt-4o-mini"]
  });

  assert.equal(message, "Duplicate rate-limit entities are not allowed.");
});

test("empty rate-limit model selection is treated as all models", () => {
  const message = validateRateLimitDraftRows([
    { models: [], requests: "120", windowValue: "2", windowUnit: "minute" }
  ], {
    knownModelIds: ["gpt-4o-mini"]
  });

  assert.equal(message, "");
  assert.deepEqual(
    buildRateLimitBucketsFromDraftRows([
      { models: [], requests: "120", windowValue: "2", windowUnit: "minute" }
    ]),
    [
      {
        id: "120-req-per-2-minutes",
        models: ["all"],
        requests: 120,
        window: { size: 2, unit: "minute" }
      }
    ]
  );
});

test("buildRateLimitBucketsFromDraftRows preserves metadata and drops legacy name fields", () => {
  const buckets = buildRateLimitBucketsFromDraftRows([
    { sourceId: "legacy-cap", models: ["all"], requests: "120", windowValue: "2", windowUnit: "minute" },
    { models: ["gpt-4o-mini"], requests: "30", windowValue: "1", windowUnit: "week" }
  ], {
    existingBucketsBySourceId: new Map([
      ["legacy-cap", {
        id: "legacy-cap",
        name: "Legacy cap",
        models: ["all"],
        requests: 60,
        window: { size: 1, unit: "minute", value: 1 },
        metadata: { origin: "existing" }
      }]
    ])
  });

  assert.deepEqual(buckets, [
    {
      id: "120-req-per-2-minutes",
      models: ["all"],
      requests: 120,
      window: { size: 2, unit: "minute" },
      metadata: { origin: "existing" }
    },
    {
      id: "30-req-per-1-week",
      models: ["gpt-4o-mini"],
      requests: 30,
      window: { size: 1, unit: "week" }
    }
  ]);
});

test("formatRateLimitBucketCap formats the visible cap summary", () => {
  assert.equal(
    formatRateLimitBucketCap({ requests: 45, window: { size: 2, unit: "hour" } }),
    "45/2 hours"
  );
});
