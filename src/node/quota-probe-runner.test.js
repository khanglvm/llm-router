import test from "node:test";
import assert from "node:assert/strict";
import { createQuotaProbeRunner } from "./quota-probe-runner.js";

const BASE_CONFIG = {
  enabled: true,
  capKind: "dollars",
  mode: "http",
  http: {
    method: "GET",
    url: "https://api.example.com/usage",
    headers: [{ key: "Authorization", value: "Bearer {{providerApiKey}}" }],
    timeoutMs: 5000,
    mapping: {
      used: { path: "$.used", as: "number" },
      limit: { path: "$.limit", as: "number" },
      remaining: { path: "$.remaining", as: "number" },
    },
  },
};

const CTX = { providerApiKey: "sk-test", providerBaseUrl: "https://api.example.com", providerId: "test-provider" };
const NOW = Date.now();

function mockFetch(json, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  });
}

// ── HTTP success ────────────────────────────────────────────────────

test("HTTP success: returns fresh snapshot with correct values", async () => {
  const runner = createQuotaProbeRunner({
    fetchImpl: mockFetch({ used: 30, limit: 100, remaining: 70 }),
  });

  const snap = await runner.executeProbe({
    providerId: "p1",
    probeConfig: BASE_CONFIG,
    shortcodeCtx: CTX,
    env: {},
    now: NOW,
  });

  assert.equal(snap.state, "fresh");
  assert.equal(snap.capKind, "dollars");
  assert.equal(snap.used, 30);
  assert.equal(snap.limit, 100);
  assert.equal(snap.remaining, 70);
  assert.equal(snap.fetchedAt, NOW);
  assert.equal(snap.error, null);
  assert.equal(snap.lastKnownGood, null);

  // getSnapshot returns cached copy
  const cached = runner.getSnapshot("p1");
  assert.deepEqual(cached, snap);
});

// ── HTTP non-2xx ────────────────────────────────────────────────────

test("HTTP non-2xx: returns errored with lastKnownGood from prior success", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    if (callCount === 1) {
      return { ok: true, status: 200, json: async () => ({ used: 10, limit: 50, remaining: 40 }) };
    }
    return { ok: false, status: 429, json: async () => ({}) };
  };

  const runner = createQuotaProbeRunner({ fetchImpl });
  const args = { providerId: "p2", probeConfig: BASE_CONFIG, shortcodeCtx: CTX, env: {}, now: NOW };

  // First call succeeds
  const first = await runner.executeProbe(args);
  assert.equal(first.state, "fresh");

  // Second call fails
  const second = await runner.executeProbe({ ...args, now: NOW + 1000 });
  assert.equal(second.state, "errored");
  assert.ok(second.error.message.includes("429"));
  assert.equal(second.lastKnownGood.state, "fresh");
  assert.equal(second.lastKnownGood.used, 10);
});

// ── HTTP timeout ────────────────────────────────────────────────────

test("HTTP timeout: returns errored with timeout message", async () => {
  const slowFetch = async (_url, opts) => {
    return new Promise((resolve, reject) => {
      const id = setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({}) }), 10000);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(id);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };

  const config = {
    ...BASE_CONFIG,
    http: { ...BASE_CONFIG.http, timeoutMs: 100 },
  };

  const runner = createQuotaProbeRunner({ fetchImpl: slowFetch });
  const snap = await runner.executeProbe({
    providerId: "p3",
    probeConfig: config,
    shortcodeCtx: CTX,
    env: {},
    now: NOW,
  });

  assert.equal(snap.state, "errored");
  assert.ok(snap.error.message.includes("timeout"));
});

// ── Custom mode success ─────────────────────────────────────────────

test("Custom mode success: returns fresh snapshot", async () => {
  const source = `
    async function fetchUsage(ctx) {
      return { capKind: "dollars", used: 5, limit: 50, remaining: 45 };
    }
  `;

  const config = {
    enabled: true,
    capKind: "dollars",
    mode: "custom",
    custom: { source, timeoutMs: 2000 },
  };

  const runner = createQuotaProbeRunner({ fetchImpl: async () => {} });
  const snap = await runner.executeProbe({
    providerId: "p4",
    probeConfig: config,
    shortcodeCtx: CTX,
    env: {},
    now: NOW,
  });

  assert.equal(snap.state, "fresh");
  assert.equal(snap.used, 5);
  assert.equal(snap.limit, 50);
  assert.equal(snap.remaining, 45);
});

// ── Custom mode process escape ──────────────────────────────────────

test("Custom mode: accessing process throws errored snapshot", async () => {
  const source = `
    async function fetchUsage(ctx) {
      return process.env;
    }
  `;

  const config = {
    enabled: true,
    capKind: "dollars",
    mode: "custom",
    custom: { source, timeoutMs: 2000 },
  };

  const runner = createQuotaProbeRunner({ fetchImpl: async () => {} });
  const snap = await runner.executeProbe({
    providerId: "p5",
    probeConfig: config,
    shortcodeCtx: CTX,
    env: {},
    now: NOW,
  });

  assert.equal(snap.state, "errored");
  assert.ok(snap.error.message.length > 0);
});

// ── Circuit breaker ─────────────────────────────────────────────────

test("Circuit breaker: 3 failures opens circuit", async () => {
  const runner = createQuotaProbeRunner({
    fetchImpl: mockFetch({}, 500),
  });
  const args = { providerId: "p6", probeConfig: BASE_CONFIG, shortcodeCtx: CTX, env: {} };

  for (let i = 0; i < 3; i++) {
    await runner.executeProbe({ ...args, now: NOW + i });
  }

  assert.equal(runner.isCircuitOpen("p6", NOW + 3), true);
  // After pause period, circuit closes
  assert.equal(runner.isCircuitOpen("p6", NOW + 5 * 60 * 1000 + 10), false);

  // resetCircuit clears it
  runner.resetCircuit("p6");
  assert.equal(runner.isCircuitOpen("p6", NOW + 3), false);
});

// ── Header shortcode interpolation ─────────────────────────────────

test("HTTP headers: interpolates {{providerApiKey}} shortcode in header values", async () => {
  let capturedHeaders;
  const fetchImpl = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => ({ used: 10, limit: 100, remaining: 90 }) };
  };

  const runner = createQuotaProbeRunner({ fetchImpl });
  await runner.executeProbe({
    providerId: "header-test",
    probeConfig: {
      ...BASE_CONFIG,
      http: {
        ...BASE_CONFIG.http,
        headers: [
          { key: "Authorization", value: "Bearer {{providerApiKey}}" },
          { key: "X-Provider", value: "{{providerId}}" }
        ]
      }
    },
    shortcodeCtx: { providerApiKey: "sk-my-secret-key", providerBaseUrl: "https://example.com", providerId: "openclaude" },
    env: {},
    now: NOW,
  });

  assert.equal(capturedHeaders["Authorization"], "Bearer sk-my-secret-key");
  assert.equal(capturedHeaders["X-Provider"], "openclaude");
});

// ── Validation failure preserves raw response ─────────────────────

test("HTTP validation failure: preserves raw response in errored snapshot", async () => {
  const rawBody = { total_spent: 42, budget: 100 };
  const runner = createQuotaProbeRunner({
    fetchImpl: mockFetch(rawBody),
  });

  const config = {
    ...BASE_CONFIG,
    http: { ...BASE_CONFIG.http, mapping: {} },
  };

  const snap = await runner.executeProbe({
    providerId: "val-fail",
    probeConfig: config,
    shortcodeCtx: CTX,
    env: {},
    now: NOW,
  });

  assert.equal(snap.state, "errored");
  assert.ok(snap.error.message.includes("at least two"));
  assert.deepEqual(snap.raw, rawBody, "raw response should be preserved for field mapping");
});

// ── enqueueRefresh deduplication ────────────────────────────────────

test("enqueueRefresh: deduplicates concurrent calls for same provider", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    await new Promise(r => setTimeout(r, 50));
    return { ok: true, status: 200, json: async () => ({ used: 10, limit: 100, remaining: 90 }) };
  };

  const runner = createQuotaProbeRunner({ fetchImpl });
  const args = { providerId: "dedup-1", probeConfig: BASE_CONFIG, shortcodeCtx: CTX, env: {} };

  const [snap1, snap2] = await Promise.all([
    runner.enqueueRefresh(args),
    runner.enqueueRefresh(args),
  ]);

  assert.equal(callCount, 1, "fetchImpl should only be called once");
  assert.equal(snap1.state, "fresh");
  assert.deepEqual(snap1, snap2);
});

// ── resetAt scheduling ──────────────────────────────────────────────

test("enqueueRefresh: schedules resetAt refresh and fires onTriggerRefresh", async () => {
  const resetAtTime = Date.now() + 200;
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ used: 80, limit: 100, remaining: 20, resetAt: resetAtTime }),
    };
  };

  const config = {
    ...BASE_CONFIG,
    http: {
      ...BASE_CONFIG.http,
      mapping: {
        used: { path: "$.used", as: "number" },
        limit: { path: "$.limit", as: "number" },
        remaining: { path: "$.remaining", as: "number" },
        resetAt: { path: "$.resetAt", as: "number" },
      },
    },
    refreshTriggers: { onResetAt: true },
  };

  const runner = createQuotaProbeRunner({ fetchImpl });
  const triggered = [];
  runner.onTriggerRefresh = (evt) => triggered.push(evt);

  await runner.enqueueRefresh({ providerId: "resetat-1", probeConfig: config, shortcodeCtx: CTX, env: {} });
  assert.equal(callCount, 1);

  // Wait for the resetAt timer to fire
  await new Promise(r => setTimeout(r, 400));

  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].providerId, "resetat-1");
  assert.equal(triggered[0].trigger, "scheduler.resetAt");
  assert.ok(callCount >= 2, "fetchImpl should have been called again after resetAt");
});

// ── Circuit bypass ──────────────────────────────────────────────────

test("enqueueRefresh: respects circuit breaker unless bypassCircuit is true", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    return { ok: false, status: 500, json: async () => ({}) };
  };

  const runner = createQuotaProbeRunner({ fetchImpl });
  const args = { providerId: "cb-1", probeConfig: BASE_CONFIG, shortcodeCtx: CTX, env: {} };

  // Trip the circuit: 3 failures
  for (let i = 0; i < 3; i++) {
    await runner.executeProbe({ ...args, now: NOW + i });
  }
  assert.equal(callCount, 3);
  assert.equal(runner.isCircuitOpen("cb-1", Date.now()), true);

  // Without bypass: returns cached snapshot, no fetch
  const snap1 = await runner.enqueueRefresh({ ...args, bypassCircuit: false });
  assert.equal(callCount, 3, "should not fetch when circuit is open");
  assert.equal(snap1.state, "errored");

  // With bypass: fetches despite open circuit
  const snap2 = await runner.enqueueRefresh({ ...args, bypassCircuit: true });
  assert.equal(callCount, 4, "should fetch when bypassCircuit is true");
});

// ── dispose clears timers ───────────────────────────────────────────

test("dispose: prevents scheduled resetAt callback from firing", async () => {
  const resetAtTime = Date.now() + 200;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ used: 50, limit: 100, remaining: 50, resetAt: resetAtTime }),
  });

  const config = {
    ...BASE_CONFIG,
    http: {
      ...BASE_CONFIG.http,
      mapping: {
        used: { path: "$.used", as: "number" },
        limit: { path: "$.limit", as: "number" },
        remaining: { path: "$.remaining", as: "number" },
        resetAt: { path: "$.resetAt", as: "number" },
      },
    },
    refreshTriggers: { onResetAt: true },
  };

  const runner = createQuotaProbeRunner({ fetchImpl });
  const triggered = [];
  runner.onTriggerRefresh = (evt) => triggered.push(evt);

  await runner.enqueueRefresh({ providerId: "dispose-1", probeConfig: config, shortcodeCtx: CTX, env: {} });
  runner.dispose();

  await new Promise(r => setTimeout(r, 400));
  assert.equal(triggered.length, 0, "callback should not fire after dispose");
});
