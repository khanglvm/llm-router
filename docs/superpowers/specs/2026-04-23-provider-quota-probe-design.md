# Provider Quota Probe — Design

**Date:** 2026-04-23
**Status:** Draft, pending implementation plan
**Scope:** A new per-provider feature that fetches upstream budget/usage info via a user-configurable HTTP request (or custom JS escape hatch), normalizes it to a shared schema, and uses it to gate candidate selection alongside the existing local `rateLimits` buckets. Fail-safe, non-blocking, event-driven.

## 1. Problem

Some upstream providers expose a usage endpoint that reflects the **actual** budget state of the API key — e.g. openclaude caps keys at `$100 / 2h` and exposes `GET /v1/usage` returning `used_dollars`, `limit_dollars`, `remaining_dollars`, `reset_at`. The router today only enforces **local** request-count rate limits per provider (`src/runtime/rate-limits.js`). That's useful, but it can't reflect a dollars-based cap or learn from the provider's own accounting, and it has no way to auto-resume the moment a cap resets.

We need a provider-agnostic, user-configurable mechanism for:
1. Describing how to fetch the provider's current budget snapshot.
2. Mapping arbitrary response shapes to a normalized schema.
3. Using that snapshot to influence routing (gate or observe) with user-chosen semantics versus existing local rate limits.
4. Never putting the snapshot — or the code that produces it — on the hot path.

Openclaude is a single example. The design must accommodate providers whose responses look wildly different (cents instead of dollars, nested under `data`, `spent` vs `used`, duration strings instead of timestamps, fixed plan limits that aren't in the response, etc.).

## 2. Non-Goals

- Multi-call / auth-refresh probes — the custom-JS escape hatch covers those.
- Persisting snapshots across router restarts — cold boots re-fetch via triggers.
- Per-model budget caps — most upstream usage endpoints are API-key-scoped, not model-scoped. Out for v1.
- Background polling timers — explicit non-goal. All refreshes are event-driven.
- Cost estimation / pre-deduction of the next request's cost.
- Probe history charts or time-series in the UI — just the current snapshot + freshness.

## 3. Terminology

| Term | Meaning |
|---|---|
| **Quota Probe** | The per-provider configuration that describes how to fetch a budget snapshot. |
| **Snapshot** | The normalized result of one probe call. Single source of truth consumed by routing. |
| **HTTP mode** | No-code path: user configures method/URL/headers/body + field mapping, tests, saves. |
| **Custom mode** | Escape hatch: user pastes an async JS function that returns the snapshot shape. |
| **Combinator** | How the probe's exhaustion verdict combines with local `rateLimits` buckets: AND / OR / REPLACE. |
| **Fail-open** | On any probe failure or unknown state, the provider is treated as available. Never blocks routing on bad probe state. |

## 4. Normalized Snapshot Schema

The runner produces this exact shape and writes it to an in-memory cache. It's the only contract the router reads.

```js
{
  capKind:          "dollars" | "tokens" | "requests",  // required

  used:             number,   // required if !remaining
  limit:            number,   // required if !isUnlimited
  remaining:        number,   // required if !used

  isUnlimited:      boolean,  // short-circuits exhaustion
  resetAt:          number,   // epoch ms, router-normalized

  state:            "fresh" | "stale" | "errored" | "unknown",
  fetchedAt:        number,   // epoch ms, set by runner
  error:            { message: string, code?: string } | null,
  raw:              any,      // preserved verbatim for UI display
  lastKnownGood:    Snapshot | null
}
```

### 4.1 Derivation & Normalization Rules

- Exactly two of `{used, limit, remaining}` present → third is derived.
- `isUnlimited=true` → never exhausted, regardless of numbers.
- Missing `capKind` → reject as invalid (user must choose in UI).
- `resetAt` accepted as ISO-8601, epoch seconds, epoch ms, duration string (`"2h"`, `"PT30M"`), or relative seconds. Normalized to epoch ms; unparseable values are dropped silently.
- `NaN`, negative values, or non-finite numbers → snapshot marked invalid; `lastKnownGood` retained.

## 5. Configuration Schema

Added as an optional `quotaProbe` object on each provider in `src/runtime/config.js`:

```js
provider.quotaProbe = {
  enabled: true,
  capKind: "dollars",                 // "dollars" | "tokens" | "requests"
  combinator: "AND",                  // "AND" | "OR" | "REPLACE"
  enforce: "gate",                    // "gate" (default) | "observe"
  safetyMargin: { dollars: 1, percent: 2 },  // max(dollars, limit*percent/100)

  mode: "http",                       // "http" | "custom"

  // mode = "http"
  http: {
    method: "GET",
    url: "https://open-claude.com/v1/usage",
    headers: [
      { key: "Authorization", value: "Bearer {{providerApiKey}}" }
    ],
    body: null,                       // string, supports shortcodes
    timeoutMs: 5000,                  // default 5s, hard cap 15s
    mapping: {
      used:        { path: "$.quota.used_dollars",      as: "number" },
      limit:       { path: "$.quota.limit_dollars",     as: "number" },
      remaining:   { path: "$.quota.remaining_dollars", as: "number" },
      resetAt:     { path: "$.quota.reset_at",          as: "datetime" },
      isUnlimited: { path: "$.quota.is_unlimited",      as: "boolean" },
      limitFallbacks:  ["$.subscription.budget", "$.plan.cap_dollars"],
      constants:   { limit: null, capKind: null }
    }
  },

  // mode = "custom"
  custom: {
    source: "/* user async JS string, see Section 7 */",
    timeoutMs: 2000                   // default 2s, hard cap 10s
  },

  refreshTriggers: {
    onUiOpen:        true,
    onManual:        true,            // always true, kept for shape stability
    onResetAt:       true,
    onUpstreamError: { statusCodes: [429, 402], bodyRegex: null }
  }
}
```

### 5.1 Shortcodes

Available wherever a string is accepted in HTTP mode (URL, header values, body) and as fields on `ctx` in custom mode:

- `{{providerApiKey}}`
- `{{providerBaseUrl}}`
- `{{providerId}}`
- `{{env.VAR_NAME}}`

Interpolation runs server-side inside the runner. Secrets never cross the UI boundary.

### 5.2 Mapping Expressiveness

Path syntax is a narrow subset: dot-paths and array indices (`$.usage[0].spent`). No wildcards, no filters. Exotic shapes escalate to custom mode.

Type coercion `as`:

| `as` value | Behavior |
|---|---|
| `number` | Parses numeric strings; `null`/missing → undefined |
| `datetime` | Auto-detects ISO / epoch-s / epoch-ms / duration / relative seconds |
| `boolean` | Truthy-coerces with explicit false-set (`0`, `"0"`, `"false"`, `"no"`, `null`) |
| `dollars-from-cents` | Divides by 100 |
| `raw` | Pass-through |

`limitFallbacks` chain: tried in order after primary `path` returns null/undefined; first non-null wins. Same for any field that might have provider-specific aliases.

`constants`: set a field to a fixed value (e.g. plan limit that isn't in the response). Constants win over paths only when paths return null/undefined.

### 5.3 Safe Defaults

- `enforce: "gate"` requires at least one successful `[ Test ]` in the UI before the config can be saved. Until then, `enforce` is server-side clamped to `"observe"`.
- HTTP timeout default 5s, hard cap 15s.
- Custom JS timeout default 2s, hard cap 10s.
- Max 1 in-flight probe per provider; max 4 concurrent probes router-wide; rest queue.

## 6. UX: Default Mode (No-Code HTTP + Mapping)

Lives in a new **Quota Probe** card in each provider's settings panel. Uses existing shadcn/Radix components (`<Input>`, `<Select>`, `<Switch>`, `<Tabs>`, `<Badge>`, `<Modal>`) per project convention.

**Step A — Request builder**
- Method: `<Select>` GET / POST
- URL: `<Input>` with shortcode placeholder hint
- Headers: dynamic key/value rows
- Body (POST only): `<Textarea>` JSON
- **[ Test ]** button — runs the request **server-side** (so CORS and secrets never leave Node), returns:
  - HTTP status, latency
  - Pretty-printed JSON viewer with clickable paths (hover → shows `$.quota.used_dollars`; click → copies into mapping)

**Step B — Field mapping** (enabled only after a successful test)
Two-column table: left = normalized field (`used`, `limit`, `remaining`, `resetAt`, `isUnlimited`), right = path + `as` dropdown, auto-filled by clicking in the response viewer. A preview panel beneath shows the extracted values from the last test response with ✓/✗ per field. Save disabled until required fields are ✓.

**Step C — Cap configuration**
- `capKind`: radio (Dollars / Tokens / Requests)
- `enforce`: radio (Gate routing / Observability only)
- `combinator`: radio (AND / OR / REPLACE) with tooltip explaining versus local `rateLimits`
- `safetyMargin`: two `<Input>` fields (dollars, percent)
- `refreshTriggers`: row of `<Switch>` toggles; `onUpstreamError` expands to a status-codes chip input + optional regex field

**Step D — Escape hatch**
Top-of-card `<Tabs>`: **Simple mapping** | **Custom function**. Custom tab shows a single code textarea; the same **[ Test ]** button runs it sandboxed and shows the returned snapshot + validation banner if shape is invalid.

**Live snapshot sub-panel** (always visible):
`$2.01 / $100.00 used · resets in 1h 23m · last refreshed 12s ago · [ Refresh ]`
With `<Badge>` state chip: `Available` green / `Exhausted` red / `Unknown` gray / `Probe unhealthy` amber.

## 7. Custom-Mode Contract

```js
// ctx is frozen. No process, no require, no import, no global fetch beyond ctx.fetch.
export default async function fetchUsage(ctx) {
  const res = await ctx.fetch("https://open-claude.com/v1/usage", {
    headers: { Authorization: `Bearer ${ctx.providerApiKey}` }
  });
  const json = await res.json();
  return {
    capKind: "dollars",
    used: json.quota.used_dollars,
    limit: json.quota.limit_dollars,
    remaining: json.quota.remaining_dollars,
    resetAt: json.quota.reset_at,
    isUnlimited: json.quota.is_unlimited,
    raw: json
  };
}
```

`ctx` fields: `{ fetch, providerApiKey, providerBaseUrl, providerId, log, now, timeoutMs }`.

The runner wraps the call with: `AbortController` timeout, try/catch, shape validation, and normalization (§4.1).

## 8. Architecture

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ Web Console UI (React)       │        │ Web Console Server (Node)    │
│  - QuotaProbeCard.jsx        │──HTTP─▶│  POST /api/providers/:id/    │
│  - FieldMappingEditor.jsx    │        │       quota-probe/test       │
│  - LiveSnapshotPanel.jsx     │        │  POST .../refresh            │
│                              │◀──────│  GET  .../snapshot           │
└──────────────────────────────┘        │                              │
                                         │  quota-probe-runner.js (IO) │
                                         │   - Trigger bus             │
                                         │   - Refresh queue (dedupe)  │
                                         │   - HTTP executor           │
                                         │   - vm Custom executor      │
                                         │   - Snapshot cache (Map)    │
                                         │   - Circuit breaker         │
                                         └──────────────┬───────────────┘
                                                        │ reads snapshots
                                                        ▼
                                         ┌──────────────────────────────┐
                                         │ Routing hot path (pure)      │
                                         │  src/runtime/quota-probe.js  │
                                         │   - applyQuotaProbeGate()    │
                                         │   - safety margin math       │
                                         │   - combinator logic         │
                                         └──────────────────────────────┘
```

### 8.1 Module Layout

| File | LOC target | Purpose |
|---|---|---|
| `src/runtime/quota-probe.js` | ≤200 | Pure: snapshot validation, derivation, safety margin, combinator with `evaluateCandidateRateLimits` output. Zero IO. |
| `src/runtime/quota-probe.test.js` | — | Unit tests for math, combinator truth tables, mapping coercion, shortcode interpolation, resetAt parsing. |
| `src/node/quota-probe-runner.js` | ≤200 | IO layer: HTTP executor, `vm` custom executor, cache, trigger bus, circuit breaker. |
| `src/node/quota-probe-runner.test.js` | — | Tests with mock `fetch`, fixture responses (openclaude + 2-3 divergent shapes), vm-sandbox escape attempts. |
| `src/node/quota-probe-mapping.js` | ≤200 | Pure helpers: path resolution, type coercion, shortcode interpolation (shared between runner and UI test endpoint). |
| `src/node/quota-probe-mapping.test.js` | — | Coercion edge cases, fallback chain, constants-vs-paths precedence. |
| `src/node/web-console-ui/components/QuotaProbeCard.jsx` | ≤200 | Top-level card; hosts tabs, test button, snapshot panel. |
| `src/node/web-console-ui/components/FieldMappingEditor.jsx` | ≤200 | Mapping table + clickable JSON viewer. |
| `src/node/web-console-ui/components/LiveSnapshotPanel.jsx` | ≤200 | Status badge, usage bar, refresh button. |

Web Console Server additions (inside `web-console-server.js`, kept minimal — delegate to runner):
- `POST /api/providers/:id/quota-probe/test` → returns `{ snapshot, raw, latencyMs, error? }` without writing cache.
- `POST /api/providers/:id/quota-probe/refresh` → fires a refresh, returns updated cached snapshot.
- `GET  /api/providers/:id/quota-probe/snapshot` → returns cached snapshot only (no network).

### 8.2 Wiring Into Existing Flow

- `src/runtime/handler/fallback.js` adds a `cap_exhausted` classification when an upstream 4xx matches `refreshTriggers.onUpstreamError`. On that classification, emit an `upstream.capError` trigger event to the runner (fire-and-forget).
- Candidate selection (currently calls `evaluateCandidatesRateLimits`) gets a sibling `applyQuotaProbeGate(candidates, snapshotsByProvider, now)` pass. Combinator merges its verdict with the rate-limit verdict per candidate.
- `onResetAt` trigger: when a successful snapshot has `resetAt`, runner schedules a `setTimeout` to fire a refresh at that instant (bounded, max 24h).

### 8.3 Isolation & Hot-Path Guarantees

- `src/runtime/` never calls `fetch`, never runs user code, never `await`s the runner.
- Routing reads a `Map<providerId, Snapshot>` — O(1) synchronous lookup.
- If the runner module fails to load or is flag-disabled, `applyQuotaProbeGate` becomes a no-op.
- Custom JS runs in `node:vm` `Script.runInContext()` with a frozen `ctx`. No `process`, no `require`, no `globalThis.fetch`. Hard `AbortController` timeout.

## 9. Failure Model (fail-safe everything)

| Failure mode | Runner behavior | What routing sees |
|---|---|---|
| HTTP timeout (default 5s) | Aborts; snapshot `state="errored"`, `error` populated | Fail-open (treated as available) |
| HTTP non-2xx | Logs; `state="errored"`; retains `lastKnownGood` | Fail-open |
| Mapping path misses or coerces to `NaN` | Snapshot invalid; `lastKnownGood` retained | Uses `lastKnownGood` if fresh, else fail-open |
| Custom JS throws | Caught; truncated stack logged; `state="errored"` | Fail-open |
| Custom JS exceeds timeout | `vm` aborted | Fail-open |
| Custom JS attempts `process.exit`, `require`, network bypass | Frozen ctx throws `ReferenceError` | Fail-open |
| Custom JS returns invalid shape | Validator rejects; `state="errored"` | Fail-open |
| Runner itself throws | Top-level try/catch at every entry point | Fail-open |
| 3 consecutive failures for a provider | Circuit breaker pauses auto-refresh 5m | Fail-open; UI shows `Probe unhealthy` |
| Snapshot past `resetAt` with refresh failing | Marked `state="stale"` | Fail-open |
| Router restart | Cache empty until first trigger fires | Fail-open |

**Fail-open** is the universal rule. A broken probe must never reduce the router's availability.

## 10. Refresh Triggers

| Trigger | Source | Dedupe window |
|---|---|---|
| `boot.coldCache` | First candidate selection after process start for a provider with no snapshot | Once per provider per boot |
| `ui.opened` | React `QuotaProbeCard` mount / Web Console tab focus | 10s |
| `ui.manualRefresh` | `[ Refresh ]` button; bypasses circuit breaker | No dedupe |
| `upstream.capError` | `handler/fallback.js` classifies 429/402/custom-regex | 30s |
| `scheduler.resetAt` | Runner schedules on successful snapshot with `resetAt` | One-shot per snapshot |

All triggers enqueue; runner deduplicates by `providerId` with at most one in-flight probe per provider.

## 11. Routing Semantics

`applyQuotaProbeGate(candidates, snapshotsByProvider, now)`:

For each candidate whose provider has `quotaProbe.enabled=true` and `enforce="gate"`:

1. Look up `snapshot = snapshotsByProvider.get(providerId)`.
2. If snapshot missing / `state ∈ {unknown, errored}` / `isUnlimited=true` → **probe verdict = available**.
3. Else compute `margin = max(safetyMargin.dollars, limit * safetyMargin.percent / 100)`.
4. If `remaining <= margin` → **probe verdict = exhausted**; else available.

Combine with local rate-limit verdict using the configured combinator:

| combinator | Both say | Rate-limit only | Probe only | Result |
|---|---|---|---|---|
| AND | Both must say available | — | — | `ratelimitAvailable && probeAvailable` |
| OR | Either saying available is enough | — | — | `ratelimitAvailable || probeAvailable` |
| REPLACE | Probe wins entirely | ignored | used | `probeAvailable` (if no snapshot → fail-open = available) |

`enforce="observe"` → verdict never consulted for routing; snapshot shown in UI only.

## 12. Testing Strategy

- **`quota-probe.test.js`** (pure): safety-margin math (dollars vs percent, whichever is larger), combinator truth tables across AND/OR/REPLACE × (available/exhausted/unknown/errored), `resetAt` parsing across 5 input forms, derivation (2-of-3 → 3), `isUnlimited` short-circuit.
- **`quota-probe-mapping.test.js`** (pure): path resolution (dot, array index, root), type coercion edge cases (`"97.99"`, cents-to-dollars, duration strings), fallback chain precedence, constants overriding nulls, shortcode interpolation including missing env vars.
- **`quota-probe-runner.test.js`**: mock `fetch`, fixture responses for openclaude + at least 3 divergent shapes (cents, nested under `data`, duration-only `reset`, unlimited key). `vm` sandbox: reject code that reads `process`, reject infinite loops via timeout, verify frozen ctx. Circuit breaker after 3 failures. Dedupe within 10s window. `AbortController` on HTTP timeout.
- **`handler.failover.test.js`** extension: snapshot = exhausted → candidate skipped; snapshot = available but upstream returns 429 → `upstream.capError` fires, next request sees updated snapshot. Combinator AND/OR/REPLACE all exercised.
- **Integration test** against the real openclaude endpoint lives in `tests/integration/quota-probe-openclaude.test.js`, gated by `RUN_INTEGRATION_QUOTA_PROBE=1` env var. Per project rules — no mocking of provider integrations in these tests.

## 13. Observability

- `activity-log.js` gains a `scope: "quota-probe"` tag. Every probe execution (success or failure) logged with `{providerId, durationMs, state, errorMessage?}`.
- `LiveSnapshotPanel`: state badge, usage bar, last-refreshed timestamp, "View raw response" expander, "Probe health" micro-metric (success rate over last 20 calls).
- Errors surfaced inline with user-friendly messages + collapsed stack for Custom-mode failures.

## 14. Migration & Rollout

- Feature is opt-in per provider. Absent `quotaProbe` → zero behavioral change.
- No migration needed for existing configs.
- Rollout: land runner + routing behind an internal flag (`LLM_ROUTER_ENABLE_QUOTA_PROBE`), default off. Flip to default-on once tests pass on at least openclaude + one other divergent-shape provider.

## 15. Open Questions

- Should snapshots be serialized to the existing `state-store` for survival across restarts? Current design says no (YAGNI, `boot.coldCache` trigger handles it), but if users frequently restart with long reset windows (`reset_at` weeks away on unlimited plans), persistence becomes valuable. Defer to v2 unless feedback says otherwise.
- Should `enforce` have a third mode `"advisory"` that logs what *would* have been gated without actually gating? Useful for safely validating a new probe config. Candidate for v1.1.
