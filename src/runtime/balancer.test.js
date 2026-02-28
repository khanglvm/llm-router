import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidateKey } from "./state-store.js";
import { createMemoryStateStore } from "./state-store.memory.js";
import { commitRouteSelection, rankRouteCandidates } from "./balancer.js";
import { normalizeRuntimeConfig, resolveRequestedRoute } from "./config.js";
import { getApplicableRateLimitBuckets } from "./rate-limits.js";

function candidate(modelId, weight = 1) {
  return {
    providerId: "openrouter",
    modelId,
    requestModelId: `openrouter/${modelId}`,
    targetFormat: "openai",
    routeWeight: weight
  };
}

test("ordered strategy preserves input order", async () => {
  const store = createMemoryStateStore();
  const candidates = [candidate("a"), candidate("b"), candidate("c")];

  const ranked = await rankRouteCandidates({
    routeKey: "route:ordered",
    strategy: "ordered",
    candidates,
    stateStore: store
  });

  assert.deepEqual(
    ranked.rankedCandidates.map((row) => row.requestModelId),
    ["openrouter/a", "openrouter/b", "openrouter/c"]
  );
  assert.equal(ranked.selectedEntry?.candidate.requestModelId, "openrouter/a");
});

test("round-robin rotates deterministically across commits", async () => {
  const store = createMemoryStateStore();
  const candidates = [candidate("a"), candidate("b"), candidate("c")];
  const picks = [];

  for (let step = 0; step < 5; step += 1) {
    const ranked = await rankRouteCandidates({
      routeKey: "route:rr",
      strategy: "round-robin",
      candidates,
      stateStore: store
    });
    picks.push(ranked.selectedEntry?.candidate.requestModelId);
    await commitRouteSelection(store, ranked);
  }

  assert.deepEqual(picks, [
    "openrouter/a",
    "openrouter/b",
    "openrouter/c",
    "openrouter/a",
    "openrouter/b"
  ]);
});

test("weighted round-robin approximates configured weights", async () => {
  const store = createMemoryStateStore();
  const candidates = [candidate("small", 1), candidate("large", 3)];
  const counts = new Map([
    ["openrouter/small", 0],
    ["openrouter/large", 0]
  ]);

  for (let step = 0; step < 120; step += 1) {
    const ranked = await rankRouteCandidates({
      routeKey: "route:weighted",
      strategy: "weighted-rr",
      candidates,
      stateStore: store
    });
    const selected = ranked.selectedEntry?.candidate.requestModelId;
    counts.set(selected, (counts.get(selected) || 0) + 1);
    await commitRouteSelection(store, ranked);
  }

  const small = counts.get("openrouter/small");
  const large = counts.get("openrouter/large");
  assert.ok(small >= 20 && small <= 40);
  assert.ok(large >= 80 && large <= 100);
});

test("quota-aware weighted rr de-prioritizes low remaining-capacity candidates", async () => {
  const store = createMemoryStateStore();
  const candidates = [candidate("high"), candidate("low")];
  const counts = new Map([
    ["openrouter/high", 0],
    ["openrouter/low", 0]
  ]);

  const evaluations = new Map();
  evaluations.set(buildCandidateKey(candidates[0]), {
    candidate: candidates[0],
    candidateKey: buildCandidateKey(candidates[0]),
    eligible: true,
    remainingCapacityRatio: 1,
    buckets: [],
    exhaustedBuckets: []
  });
  evaluations.set(buildCandidateKey(candidates[1]), {
    candidate: candidates[1],
    candidateKey: buildCandidateKey(candidates[1]),
    eligible: true,
    remainingCapacityRatio: 0.1,
    buckets: [],
    exhaustedBuckets: []
  });

  for (let step = 0; step < 100; step += 1) {
    const ranked = await rankRouteCandidates({
      routeKey: "route:quota-aware",
      strategy: "quota-aware-weighted-rr",
      candidates,
      stateStore: store,
      rateLimitEvaluations: evaluations
    });
    const selected = ranked.selectedEntry?.candidate.requestModelId;
    counts.set(selected, (counts.get(selected) || 0) + 1);
    await commitRouteSelection(store, ranked);
  }

  const high = counts.get("openrouter/high");
  const low = counts.get("openrouter/low");
  assert.ok(high > low);
  assert.ok(high >= 75);
  assert.ok(low <= 25);
});

test("auto strategy de-prioritizes low remaining-capacity candidates", async () => {
  const store = createMemoryStateStore();
  const candidates = [candidate("high"), candidate("low")];
  const counts = new Map([
    ["openrouter/high", 0],
    ["openrouter/low", 0]
  ]);

  const evaluations = new Map();
  evaluations.set(buildCandidateKey(candidates[0]), {
    candidate: candidates[0],
    candidateKey: buildCandidateKey(candidates[0]),
    eligible: true,
    remainingCapacityRatio: 1,
    buckets: [],
    exhaustedBuckets: []
  });
  evaluations.set(buildCandidateKey(candidates[1]), {
    candidate: candidates[1],
    candidateKey: buildCandidateKey(candidates[1]),
    eligible: true,
    remainingCapacityRatio: 0.1,
    buckets: [],
    exhaustedBuckets: []
  });

  for (let step = 0; step < 100; step += 1) {
    const ranked = await rankRouteCandidates({
      routeKey: "route:auto",
      strategy: "auto",
      candidates,
      stateStore: store,
      rateLimitEvaluations: evaluations
    });
    const selected = ranked.selectedEntry?.candidate.requestModelId;
    counts.set(selected, (counts.get(selected) || 0) + 1);
    await commitRouteSelection(store, ranked);
  }

  const high = counts.get("openrouter/high");
  const low = counts.get("openrouter/low");
  assert.ok(high > low);
  assert.ok(high >= 75);
  assert.ok(low <= 25);
});

test("integration: alias route rotates targets with round-robin strategy", async () => {
  const store = createMemoryStateStore();
  const config = normalizeRuntimeConfig({
    version: 2,
    defaultModel: "chat.default",
    modelAliases: {
      "chat.default": {
        strategy: "round-robin",
        targets: [
          { ref: "openrouter/gpt-4o-mini" },
          { ref: "anthropic/claude-3-5-haiku" }
        ]
      }
    },
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ]
  });

  const route = resolveRequestedRoute(config, "chat.default", "openai");
  const candidates = [route.primary, ...route.fallbacks];
  const picks = [];
  for (let step = 0; step < 4; step += 1) {
    const ranked = await rankRouteCandidates({
      route,
      strategy: route.routeStrategy,
      candidates,
      stateStore: store,
      config
    });
    picks.push(ranked.selectedEntry?.candidate.requestModelId);
    await commitRouteSelection(store, ranked);
  }

  assert.deepEqual(picks, [
    "openrouter/gpt-4o-mini",
    "anthropic/claude-3-5-haiku",
    "openrouter/gpt-4o-mini",
    "anthropic/claude-3-5-haiku"
  ]);
});

test("integration: exhausted provider-wide bucket reroutes to another provider", async () => {
  const now = Date.UTC(2026, 1, 28, 15, 0, 0);
  const store = createMemoryStateStore();
  const config = normalizeRuntimeConfig({
    version: 2,
    defaultModel: "chat.default",
    modelAliases: {
      "chat.default": {
        strategy: "ordered",
        targets: [
          { ref: "openrouter/gpt-4o-mini" },
          { ref: "anthropic/claude-3-5-haiku" }
        ]
      }
    },
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }],
        rateLimits: [
          {
            id: "openrouter-all-day",
            models: ["all"],
            requests: 1,
            window: { unit: "day", size: 1 }
          }
        ]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ]
  });

  const route = resolveRequestedRoute(config, "chat.default", "openai");
  const openRouterCandidate = route.primary;
  const openRouterBuckets = getApplicableRateLimitBuckets(config, openRouterCandidate, now);
  assert.equal(openRouterBuckets.length, 1);
  await store.incrementBucketUsage(
    openRouterBuckets[0].bucketKey,
    openRouterBuckets[0].windowKey,
    1,
    { expiresAt: openRouterBuckets[0].window.endsAt }
  );

  const ranked = await rankRouteCandidates({
    route,
    strategy: route.routeStrategy,
    candidates: [route.primary, ...route.fallbacks],
    stateStore: store,
    config,
    now
  });

  assert.equal(ranked.selectedEntry?.candidate.requestModelId, "anthropic/claude-3-5-haiku");
  assert.ok(
    ranked.skippedEntries.some((entry) =>
      entry.candidate.requestModelId === "openrouter/gpt-4o-mini" &&
      entry.skipReasons.includes("quota-exhausted")
    )
  );
});

test("integration: model-specific bucket exhaustion blocks only that model", async () => {
  const now = Date.UTC(2026, 1, 28, 15, 0, 0);
  const store = createMemoryStateStore();
  const config = normalizeRuntimeConfig({
    version: 2,
    defaultModel: "chat.default",
    modelAliases: {
      "chat.default": {
        strategy: "ordered",
        targets: [
          { ref: "openrouter/gpt-4o-mini" },
          { ref: "openrouter/gpt-4o" }
        ]
      }
    },
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
        rateLimits: [
          {
            id: "gpt4o-mini-day",
            models: ["gpt-4o-mini"],
            requests: 1,
            window: { unit: "day", size: 1 }
          }
        ]
      }
    ]
  });

  const route = resolveRequestedRoute(config, "chat.default", "openai");
  const buckets = getApplicableRateLimitBuckets(config, route.primary, now);
  assert.equal(buckets.length, 1);
  await store.incrementBucketUsage(
    buckets[0].bucketKey,
    buckets[0].windowKey,
    1,
    { expiresAt: buckets[0].window.endsAt }
  );

  const ranked = await rankRouteCandidates({
    route,
    strategy: route.routeStrategy,
    candidates: [route.primary, ...route.fallbacks],
    stateStore: store,
    config,
    now
  });

  assert.equal(ranked.selectedEntry?.candidate.requestModelId, "openrouter/gpt-4o");
  const exhaustedPrimary = ranked.skippedEntries.find((entry) => entry.candidate.requestModelId === "openrouter/gpt-4o-mini");
  assert.ok(exhaustedPrimary);
  assert.ok(exhaustedPrimary.skipReasons.includes("quota-exhausted"));
});
