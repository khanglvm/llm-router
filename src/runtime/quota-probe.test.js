import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSnapshot,
  deriveSnapshot,
  isExhausted,
  resolveProbeVerdict,
  applyQuotaProbeGate,
  normalizeQuotaProbeConfig
} from "./quota-probe.js";
import { normalizeRuntimeConfig } from "./config.js";
import { shouldEmitCapErrorTrigger } from "./handler/fallback.js";

// ---------------------------------------------------------------------------
// deriveSnapshot
// ---------------------------------------------------------------------------
test("deriveSnapshot", async (t) => {
  await t.test("used + limit → remaining", () => {
    const out = deriveSnapshot({ used: 30, limit: 100 });
    assert.equal(out.remaining, 70);
  });

  await t.test("limit + remaining → used", () => {
    const out = deriveSnapshot({ limit: 100, remaining: 25 });
    assert.equal(out.used, 75);
  });

  await t.test("used + remaining → limit", () => {
    const out = deriveSnapshot({ used: 40, remaining: 60 });
    assert.equal(out.limit, 100);
  });

  await t.test("all three present — no mutation", () => {
    const out = deriveSnapshot({ used: 10, limit: 100, remaining: 90 });
    assert.equal(out.used, 10);
    assert.equal(out.limit, 100);
    assert.equal(out.remaining, 90);
  });
});

// ---------------------------------------------------------------------------
// validateSnapshot
// ---------------------------------------------------------------------------
test("validateSnapshot", async (t) => {
  await t.test("rejects non-object", () => {
    assert.equal(validateSnapshot(null).valid, false);
    assert.equal(validateSnapshot("str").valid, false);
  });

  await t.test("rejects missing capKind", () => {
    const r = validateSnapshot({ used: 1, limit: 10 });
    assert.equal(r.valid, false);
    assert.match(r.error, /capKind/);
  });

  await t.test("rejects invalid capKind", () => {
    const r = validateSnapshot({ capKind: "bananas", used: 1, limit: 10 });
    assert.equal(r.valid, false);
  });

  await t.test("rejects NaN numeric field", () => {
    const r = validateSnapshot({ capKind: "dollars", used: NaN, limit: 10 });
    assert.equal(r.valid, false);
    assert.match(r.error, /used/);
  });

  await t.test("rejects negative numeric field", () => {
    const r = validateSnapshot({ capKind: "tokens", used: -5, limit: 10 });
    assert.equal(r.valid, false);
  });

  await t.test("rejects insufficient fields (only one present)", () => {
    const r = validateSnapshot({ capKind: "dollars", used: 10 });
    assert.equal(r.valid, false);
    assert.match(r.error, /at least two/);
  });

  await t.test("accepts two fields", () => {
    const r = validateSnapshot({ capKind: "dollars", used: 10, limit: 100 });
    assert.equal(r.valid, true);
    assert.equal(r.error, null);
  });

  await t.test("accepts one field when isUnlimited", () => {
    const r = validateSnapshot({ capKind: "dollars", used: 10, isUnlimited: true });
    assert.equal(r.valid, true);
  });
});

// ---------------------------------------------------------------------------
// isExhausted
// ---------------------------------------------------------------------------
test("isExhausted", async (t) => {
  await t.test("isUnlimited short-circuits to false", () => {
    assert.equal(isExhausted({ isUnlimited: true, remaining: 0 }, { dollars: 0, percent: 0 }), false);
  });

  await t.test("dollar margin wins when larger", () => {
    // limit=100, remaining=4, dollarMargin=5, percentMargin=1 → effective=5 → 4<=5 → true
    assert.equal(isExhausted({ remaining: 4, limit: 100 }, { dollars: 5, percent: 1 }), true);
  });

  await t.test("percent margin wins when larger", () => {
    // limit=1000, remaining=50, dollarMargin=1, percentMargin=10 → effective=100 → 50<=100 → true
    assert.equal(isExhausted({ remaining: 50, limit: 1000 }, { dollars: 1, percent: 10 }), true);
  });

  await t.test("not exhausted when remaining exceeds margin", () => {
    assert.equal(isExhausted({ remaining: 200, limit: 1000 }, { dollars: 5, percent: 10 }), false);
  });

  await t.test("missing remaining = fail-open (false)", () => {
    assert.equal(isExhausted({ limit: 100 }, { dollars: 0, percent: 0 }), false);
  });

  await t.test("remaining=0 with zero margin is exhausted", () => {
    assert.equal(isExhausted({ remaining: 0, limit: 100 }, { dollars: 0, percent: 0 }), true);
  });
});

// ---------------------------------------------------------------------------
// applyQuotaProbeGate
// ---------------------------------------------------------------------------
test("applyQuotaProbeGate", async (t) => {
  await t.test("AND: both true → eligible", () => {
    const r = applyQuotaProbeGate({ combinator: "AND", probeAvailable: true, rateLimitEligible: true });
    assert.equal(r.eligible, true);
    assert.equal(r.skipReason, null);
  });

  await t.test("AND: probe false → not eligible", () => {
    const r = applyQuotaProbeGate({ combinator: "AND", probeAvailable: false, rateLimitEligible: true });
    assert.equal(r.eligible, false);
    assert.match(r.skipReason, /probe/);
  });

  await t.test("AND: rateLimit false → not eligible", () => {
    const r = applyQuotaProbeGate({ combinator: "AND", probeAvailable: true, rateLimitEligible: false });
    assert.equal(r.eligible, false);
    assert.match(r.skipReason, /rate-limit/);
  });

  await t.test("AND: both false → not eligible", () => {
    const r = applyQuotaProbeGate({ combinator: "AND", probeAvailable: false, rateLimitEligible: false });
    assert.equal(r.eligible, false);
  });

  await t.test("OR: either true → eligible", () => {
    assert.equal(applyQuotaProbeGate({ combinator: "OR", probeAvailable: true, rateLimitEligible: false }).eligible, true);
    assert.equal(applyQuotaProbeGate({ combinator: "OR", probeAvailable: false, rateLimitEligible: true }).eligible, true);
  });

  await t.test("OR: both false → not eligible", () => {
    assert.equal(applyQuotaProbeGate({ combinator: "OR", probeAvailable: false, rateLimitEligible: false }).eligible, false);
  });

  await t.test("REPLACE: probe true → eligible regardless of rateLimit", () => {
    assert.equal(applyQuotaProbeGate({ combinator: "REPLACE", probeAvailable: true, rateLimitEligible: false }).eligible, true);
  });

  await t.test("REPLACE: probe false → not eligible regardless of rateLimit", () => {
    assert.equal(applyQuotaProbeGate({ combinator: "REPLACE", probeAvailable: false, rateLimitEligible: true }).eligible, false);
  });

  await t.test("null probe = fail-open (treated as available)", () => {
    const r = applyQuotaProbeGate({ combinator: "AND", probeAvailable: null, rateLimitEligible: true });
    assert.equal(r.eligible, true);
  });

  await t.test("undefined probe = fail-open (treated as available)", () => {
    const r = applyQuotaProbeGate({ combinator: "AND", probeAvailable: undefined, rateLimitEligible: true });
    assert.equal(r.eligible, true);
  });
});

// ---------------------------------------------------------------------------
// resolveProbeVerdict
// ---------------------------------------------------------------------------
test("resolveProbeVerdict", async (t) => {
  const baseConfig = { enabled: true, enforce: "gate", safetyMargin: { dollars: 0, percent: 0 } };

  await t.test("disabled probe → null", () => {
    assert.equal(resolveProbeVerdict({}, { enabled: false, enforce: "gate" }), null);
  });

  await t.test("no snapshot → null", () => {
    assert.equal(resolveProbeVerdict(null, baseConfig), null);
  });

  await t.test("observe mode → null", () => {
    assert.equal(resolveProbeVerdict({ used: 10, limit: 100, capKind: "dollars" }, { enabled: true, enforce: "observe" }), null);
  });

  await t.test("errored state → null (fail-open)", () => {
    assert.equal(resolveProbeVerdict({ state: "errored" }, baseConfig), null);
  });

  await t.test("unknown state → null (fail-open)", () => {
    assert.equal(resolveProbeVerdict({ state: "unknown" }, baseConfig), null);
  });

  await t.test("unlimited → available", () => {
    const v = resolveProbeVerdict({ isUnlimited: true }, baseConfig);
    assert.deepEqual(v, { available: true, reason: "unlimited" });
  });

  await t.test("fresh + exhausted → unavailable", () => {
    const snap = { used: 100, limit: 100, capKind: "dollars", state: "fresh" };
    const v = resolveProbeVerdict(snap, baseConfig);
    assert.equal(v.available, false);
    assert.match(v.reason, /exhausted/);
  });

  await t.test("fresh + available → available", () => {
    const snap = { used: 10, limit: 100, capKind: "dollars", state: "fresh" };
    const v = resolveProbeVerdict(snap, baseConfig);
    assert.equal(v.available, true);
    assert.match(v.reason, /within budget/);
  });
});

// ---------------------------------------------------------------------------
// normalizeQuotaProbeConfig
// ---------------------------------------------------------------------------
test("normalizeQuotaProbeConfig", async (t) => {
  await t.test("disabled returns null", () => {
    assert.equal(normalizeQuotaProbeConfig({ enabled: false }), null);
    assert.equal(normalizeQuotaProbeConfig(null), null);
    assert.equal(normalizeQuotaProbeConfig(undefined), null);
    assert.equal(normalizeQuotaProbeConfig("string"), null);
  });

  await t.test("missing capKind returns null", () => {
    assert.equal(normalizeQuotaProbeConfig({ enabled: true }), null);
  });

  await t.test("full config normalizes correctly", () => {
    const cfg = normalizeQuotaProbeConfig({
      enabled: true,
      capKind: "dollars",
      combinator: "OR",
      enforce: "observe",
      mode: "http",
      safetyMargin: { dollars: 5, percent: 10 },
      http: { method: "POST", url: "https://example.com/quota", headers: [{ name: "x-key", value: "123" }], timeoutMs: 3000, mapping: { remaining: "$.left" } },
      custom: { source: "my-plugin", timeoutMs: 1500 },
      refreshTriggers: { onUiOpen: true, onResetAt: true, onUpstreamError: { statusCodes: [429, 503], bodyRegex: "rate" } }
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.capKind, "dollars");
    assert.equal(cfg.combinator, "OR");
    assert.equal(cfg.enforce, "observe");
    assert.equal(cfg.mode, "http");
    assert.deepEqual(cfg.safetyMargin, { dollars: 5, percent: 10 });
    assert.equal(cfg.http.method, "POST");
    assert.equal(cfg.http.url, "https://example.com/quota");
    assert.equal(cfg.http.timeoutMs, 3000);
    assert.equal(cfg.custom.source, "my-plugin");
    assert.equal(cfg.custom.timeoutMs, 1500);
    assert.equal(cfg.refreshTriggers.onUiOpen, true);
    assert.equal(cfg.refreshTriggers.onManual, true);
    assert.deepEqual(cfg.refreshTriggers.onUpstreamError.statusCodes, [429, 503]);
  });

  await t.test("defaults are applied correctly", () => {
    const cfg = normalizeQuotaProbeConfig({ enabled: true, capKind: "tokens" });
    assert.equal(cfg.combinator, "AND");
    assert.equal(cfg.enforce, "gate");
    assert.equal(cfg.mode, "http");
    assert.deepEqual(cfg.safetyMargin, { dollars: 0, percent: 0 });
    assert.equal(cfg.refreshTriggers.onManual, true);
    assert.equal(cfg.refreshTriggers.onUiOpen, false);
  });

  await t.test("http timeoutMs hard cap at 15000", () => {
    const cfg = normalizeQuotaProbeConfig({
      enabled: true,
      capKind: "requests",
      http: { url: "https://x.com", timeoutMs: 30000 }
    });
    assert.equal(cfg.http.timeoutMs, 15000);
  });

  await t.test("http timeoutMs defaults to 5000", () => {
    const cfg = normalizeQuotaProbeConfig({
      enabled: true,
      capKind: "requests",
      http: { url: "https://x.com" }
    });
    assert.equal(cfg.http.timeoutMs, 5000);
  });

  await t.test("custom timeoutMs hard cap at 10000", () => {
    const cfg = normalizeQuotaProbeConfig({
      enabled: true,
      capKind: "dollars",
      custom: { source: "s", timeoutMs: 20000 }
    });
    assert.equal(cfg.custom.timeoutMs, 10000);
  });

  await t.test("custom timeoutMs defaults to 2000", () => {
    const cfg = normalizeQuotaProbeConfig({
      enabled: true,
      capKind: "dollars",
      custom: { source: "s" }
    });
    assert.equal(cfg.custom.timeoutMs, 2000);
  });
});

// ---------------------------------------------------------------------------
// quotaProbe round-trip through normalizeRuntimeConfig
// ---------------------------------------------------------------------------
test("quotaProbe wired into normalizeRuntimeConfig", async (t) => {
  function makeConfig(providerOverrides = {}) {
    return {
      version: 2,
      providers: [
        {
          id: "test-provider",
          baseUrl: "https://api.example.com",
          models: [{ id: "gpt-4" }],
          ...providerOverrides
        }
      ]
    };
  }

  await t.test("provider with quotaProbe.enabled: true has normalized quotaProbe", () => {
    const raw = makeConfig({
      quotaProbe: {
        enabled: true,
        capKind: "dollars",
        combinator: "OR",
        enforce: "observe",
        mode: "http",
        safetyMargin: { dollars: 5, percent: 10 },
        http: { url: "https://example.com/quota", timeoutMs: 3000 }
      }
    });
    const config = normalizeRuntimeConfig(raw);
    const provider = config.providers[0];
    assert.ok(provider.quotaProbe, "quotaProbe should not be null");
    assert.equal(provider.quotaProbe.enabled, true);
    assert.equal(provider.quotaProbe.capKind, "dollars");
    assert.equal(provider.quotaProbe.combinator, "OR");
    assert.equal(provider.quotaProbe.enforce, "observe");
    assert.equal(provider.quotaProbe.mode, "http");
    assert.deepEqual(provider.quotaProbe.safetyMargin, { dollars: 5, percent: 10 });
    assert.equal(provider.quotaProbe.http.timeoutMs, 3000);
  });

  await t.test("provider without quotaProbe has quotaProbe: null", () => {
    const config = normalizeRuntimeConfig(makeConfig());
    const provider = config.providers[0];
    assert.equal(provider.quotaProbe, null);
  });

  await t.test("HTTP timeout capped at 15000ms through normalizeRuntimeConfig", () => {
    const raw = makeConfig({
      quotaProbe: {
        enabled: true,
        capKind: "requests",
        http: { url: "https://example.com/quota", timeoutMs: 99999 }
      }
    });
    const config = normalizeRuntimeConfig(raw);
    assert.equal(config.providers[0].quotaProbe.http.timeoutMs, 15000);
  });

  await t.test("custom timeout capped at 10000ms through normalizeRuntimeConfig", () => {
    const raw = makeConfig({
      quotaProbe: {
        enabled: true,
        capKind: "dollars",
        custom: { source: "my-plugin", timeoutMs: 50000 }
      }
    });
    const config = normalizeRuntimeConfig(raw);
    assert.equal(config.providers[0].quotaProbe.custom.timeoutMs, 10000);
  });
});

// ---------------------------------------------------------------------------
// shouldEmitCapErrorTrigger
// ---------------------------------------------------------------------------
test("shouldEmitCapErrorTrigger", async (t) => {
  await t.test("returns true for matching status code", () => {
    const probeConfig = {
      enabled: true,
      refreshTriggers: {
        onUpstreamError: { statusCodes: [429, 402] }
      }
    };
    assert.equal(shouldEmitCapErrorTrigger(429, probeConfig), true);
    assert.equal(shouldEmitCapErrorTrigger(402, probeConfig), true);
  });

  await t.test("returns false for non-matching status code", () => {
    const probeConfig = {
      enabled: true,
      refreshTriggers: {
        onUpstreamError: { statusCodes: [429, 402] }
      }
    };
    assert.equal(shouldEmitCapErrorTrigger(500, probeConfig), false);
  });

  await t.test("returns false when probeConfig is null", () => {
    assert.equal(shouldEmitCapErrorTrigger(429, null), false);
  });

  await t.test("returns false when probeConfig is not enabled", () => {
    const probeConfig = {
      enabled: false,
      refreshTriggers: {
        onUpstreamError: { statusCodes: [429] }
      }
    };
    assert.equal(shouldEmitCapErrorTrigger(429, probeConfig), false);
  });

  await t.test("returns false when onUpstreamError is null", () => {
    const probeConfig = {
      enabled: true,
      refreshTriggers: { onUpstreamError: null }
    };
    assert.equal(shouldEmitCapErrorTrigger(429, probeConfig), false);
  });

  await t.test("returns false when refreshTriggers is missing", () => {
    const probeConfig = { enabled: true };
    assert.equal(shouldEmitCapErrorTrigger(429, probeConfig), false);
  });

  await t.test("coerces string status to number", () => {
    const probeConfig = {
      enabled: true,
      refreshTriggers: {
        onUpstreamError: { statusCodes: [429] }
      }
    };
    assert.equal(shouldEmitCapErrorTrigger("429", probeConfig), true);
  });
});
