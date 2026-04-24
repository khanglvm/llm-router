import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePath,
  coerceValue,
  interpolateShortcodes,
  extractMappedSnapshot
} from "./quota-probe-mapping.js";

// ── resolvePath ─────────────────────────────────────────────────────

test("resolvePath: dot-separated path", () => {
  const obj = { quota: { used_dollars: 42.5 } };
  assert.equal(resolvePath(obj, "$.quota.used_dollars"), 42.5);
});

test("resolvePath: array index", () => {
  const obj = { data: [{ amount: 100 }, { amount: 200 }] };
  assert.equal(resolvePath(obj, "$.data[0].amount"), 100);
  assert.equal(resolvePath(obj, "$.data[1].amount"), 200);
});

test("resolvePath: missing path returns undefined", () => {
  const obj = { a: { b: 1 } };
  assert.equal(resolvePath(obj, "$.a.c.d"), undefined);
});

test("resolvePath: null intermediate returns undefined", () => {
  const obj = { a: { b: null } };
  assert.equal(resolvePath(obj, "$.a.b.c"), undefined);
});

test("resolvePath: root-level value", () => {
  const obj = { value: 99 };
  assert.equal(resolvePath(obj, "$.value"), 99);
});

test("resolvePath: leading $ without dot", () => {
  const obj = { x: 1 };
  assert.equal(resolvePath(obj, "$x"), 1);
});

test("resolvePath: null obj returns undefined", () => {
  assert.equal(resolvePath(null, "$.a"), undefined);
});

test("resolvePath: nested array indices", () => {
  const obj = { matrix: [[10, 20], [30, 40]] };
  assert.equal(resolvePath(obj, "$.matrix[1][0]"), 30);
});

// ── coerceValue ─────────────────────────────────────────────────────

test("coerceValue number: numeric string", () => {
  assert.equal(coerceValue("97.99", "number"), 97.99);
});

test("coerceValue number: null returns undefined", () => {
  assert.equal(coerceValue(null, "number"), undefined);
});

test("coerceValue number: non-numeric string returns undefined", () => {
  assert.equal(coerceValue("abc", "number"), undefined);
});

test("coerceValue number: actual number passes through", () => {
  assert.equal(coerceValue(42, "number"), 42);
});

test("coerceValue dollars-from-cents: integer", () => {
  assert.equal(coerceValue(9799, "dollars-from-cents"), 97.99);
});

test("coerceValue dollars-from-cents: null returns undefined", () => {
  assert.equal(coerceValue(null, "dollars-from-cents"), undefined);
});

test("coerceValue dollars-from-cents: string number", () => {
  assert.equal(coerceValue("500", "dollars-from-cents"), 5);
});

test("coerceValue boolean: 'false' → false", () => {
  assert.equal(coerceValue("false", "boolean"), false);
});

test("coerceValue boolean: '0' → false", () => {
  assert.equal(coerceValue("0", "boolean"), false);
});

test("coerceValue boolean: 0 → false", () => {
  assert.equal(coerceValue(0, "boolean"), false);
});

test("coerceValue boolean: null → false", () => {
  assert.equal(coerceValue(null, "boolean"), false);
});

test("coerceValue boolean: undefined → false", () => {
  assert.equal(coerceValue(undefined, "boolean"), false);
});

test("coerceValue boolean: '' → false", () => {
  assert.equal(coerceValue("", "boolean"), false);
});

test("coerceValue boolean: 'no' → false", () => {
  assert.equal(coerceValue("no", "boolean"), false);
});

test("coerceValue boolean: 'yes' → true", () => {
  assert.equal(coerceValue("yes", "boolean"), true);
});

test("coerceValue boolean: 1 → true", () => {
  assert.equal(coerceValue(1, "boolean"), true);
});

test("coerceValue boolean: 'true' → true", () => {
  assert.equal(coerceValue("true", "boolean"), true);
});

test("coerceValue datetime: ISO-8601 string", () => {
  const iso = "2026-04-24T12:00:00Z";
  const expected = new Date(iso).getTime();
  assert.equal(coerceValue(iso, "datetime"), expected);
});

test("coerceValue datetime: epoch seconds (< 1e12)", () => {
  const epochSec = 1745496000;
  assert.equal(coerceValue(epochSec, "datetime"), epochSec * 1000);
});

test("coerceValue datetime: epoch milliseconds (>= 1e12)", () => {
  const epochMs = 1745496000000;
  assert.equal(coerceValue(epochMs, "datetime"), epochMs);
});

test("coerceValue datetime: duration '2h'", () => {
  const now = 1000000;
  const result = coerceValue("2h", "datetime", { now });
  assert.equal(result, now + 2 * 3600_000);
});

test("coerceValue datetime: duration '30m'", () => {
  const now = 1000000;
  const result = coerceValue("30m", "datetime", { now });
  assert.equal(result, now + 30 * 60_000);
});

test("coerceValue datetime: duration 'PT2H'", () => {
  const now = 1000000;
  const result = coerceValue("PT2H", "datetime", { now });
  assert.equal(result, now + 2 * 3600_000);
});

test("coerceValue datetime: duration 'PT30M'", () => {
  const now = 1000000;
  const result = coerceValue("PT30M", "datetime", { now });
  assert.equal(result, now + 30 * 60_000);
});

test("coerceValue datetime: invalid string returns undefined", () => {
  assert.equal(coerceValue("not-a-date", "datetime"), undefined);
});

test("coerceValue datetime: null returns undefined", () => {
  assert.equal(coerceValue(null, "datetime"), undefined);
});

test("coerceValue raw: pass-through", () => {
  const obj = { a: 1 };
  assert.equal(coerceValue(obj, "raw"), obj);
  assert.equal(coerceValue("hello", "raw"), "hello");
  assert.equal(coerceValue(42, "raw"), 42);
});

// ── interpolateShortcodes ───────────────────────────────────────────

test("interpolateShortcodes: replaces providerApiKey", () => {
  const result = interpolateShortcodes(
    "Bearer {{providerApiKey}}",
    { providerApiKey: "sk-123" }
  );
  assert.equal(result, "Bearer sk-123");
});

test("interpolateShortcodes: replaces providerBaseUrl", () => {
  const result = interpolateShortcodes(
    "{{providerBaseUrl}}/usage",
    { providerBaseUrl: "https://api.example.com" }
  );
  assert.equal(result, "https://api.example.com/usage");
});

test("interpolateShortcodes: replaces providerId", () => {
  const result = interpolateShortcodes(
    "provider:{{providerId}}",
    { providerId: "openai-main" }
  );
  assert.equal(result, "provider:openai-main");
});

test("interpolateShortcodes: replaces env vars", () => {
  const result = interpolateShortcodes(
    "key={{env.MY_TOKEN}}",
    {},
    { MY_TOKEN: "tok-abc" }
  );
  assert.equal(result, "key=tok-abc");
});

test("interpolateShortcodes: missing env var → empty string", () => {
  const result = interpolateShortcodes(
    "key={{env.MISSING}}",
    {},
    {}
  );
  assert.equal(result, "key=");
});

test("interpolateShortcodes: unknown shortcode → empty string", () => {
  const result = interpolateShortcodes(
    "{{unknown}}",
    { providerApiKey: "sk-123" }
  );
  assert.equal(result, "");
});

test("interpolateShortcodes: non-string input → return as-is", () => {
  assert.equal(interpolateShortcodes(42, {}), 42);
  assert.equal(interpolateShortcodes(null, {}), null);
  const arr = [1, 2];
  assert.equal(interpolateShortcodes(arr, {}), arr);
});

test("interpolateShortcodes: multiple replacements in one string", () => {
  const result = interpolateShortcodes(
    "{{providerBaseUrl}}/v1?key={{providerApiKey}}",
    { providerBaseUrl: "https://api.test", providerApiKey: "sk-x" }
  );
  assert.equal(result, "https://api.test/v1?key=sk-x");
});

// ── extractMappedSnapshot ───────────────────────────────────────────

test("extractMappedSnapshot: primary path found", () => {
  const raw = { usage: { used: 50, limit: 100, remaining: 50 } };
  const mapping = {
    used: { path: "$.usage.used", as: "number" },
    limit: { path: "$.usage.limit", as: "number" },
    remaining: { path: "$.usage.remaining", as: "number" }
  };
  const result = extractMappedSnapshot(raw, mapping);
  assert.equal(result.used, 50);
  assert.equal(result.limit, 100);
  assert.equal(result.remaining, 50);
});

test("extractMappedSnapshot: path null → constant wins", () => {
  const raw = { usage: {} };
  const mapping = {
    limit: { path: "$.usage.limit", as: "number" },
    constants: { limit: 1000 }
  };
  const result = extractMappedSnapshot(raw, mapping);
  assert.equal(result.limit, 1000);
});

test("extractMappedSnapshot: limitFallbacks chain — first non-null wins", () => {
  const raw = {
    billing: { hard_limit: null, soft_limit: 200 }
  };
  const mapping = {
    limit: { path: "$.billing.limit", as: "number" },
    limitFallbacks: ["$.billing.hard_limit", "$.billing.soft_limit"]
  };
  const result = extractMappedSnapshot(raw, mapping);
  assert.equal(result.limit, 200);
});

test("extractMappedSnapshot: missing everything → field excluded", () => {
  const raw = {};
  const mapping = {
    used: { path: "$.usage.used", as: "number" },
    limit: { path: "$.usage.limit", as: "number" }
  };
  const result = extractMappedSnapshot(raw, mapping);
  assert.equal(result.used, undefined);
  assert.equal(result.limit, undefined);
  assert.equal(Object.keys(result).length, 0);
});

test("extractMappedSnapshot: resetAt with datetime coercion", () => {
  const raw = { meta: { reset: "2026-04-24T12:00:00Z" } };
  const mapping = {
    resetAt: { path: "$.meta.reset", as: "datetime" }
  };
  const result = extractMappedSnapshot(raw, mapping);
  assert.equal(result.resetAt, new Date("2026-04-24T12:00:00Z").getTime());
});

test("extractMappedSnapshot: isUnlimited boolean coercion", () => {
  const raw = { plan: { unlimited: true } };
  const mapping = {
    isUnlimited: { path: "$.plan.unlimited", as: "boolean" }
  };
  const result = extractMappedSnapshot(raw, mapping);
  assert.equal(result.isUnlimited, true);
});

test("extractMappedSnapshot: limitFallbacks skipped when primary path has value", () => {
  const raw = { usage: { limit: 500, alt_limit: 999 } };
  const mapping = {
    limit: { path: "$.usage.limit", as: "number" },
    limitFallbacks: ["$.usage.alt_limit"]
  };
  const result = extractMappedSnapshot(raw, mapping);
  assert.equal(result.limit, 500);
});

test("extractMappedSnapshot: constants used only as last resort", () => {
  const raw = { usage: { used: 10 } };
  const mapping = {
    used: { path: "$.usage.used", as: "number" },
    remaining: { path: "$.usage.remaining", as: "number" },
    constants: { used: 999, remaining: 888 }
  };
  const result = extractMappedSnapshot(raw, mapping);
  assert.equal(result.used, 10);
  assert.equal(result.remaining, 888);
});
