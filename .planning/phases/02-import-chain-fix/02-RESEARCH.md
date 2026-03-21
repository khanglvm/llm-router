# Phase 2: Import Chain Fix - Research

**Researched:** 2026-03-21
**Domain:** JavaScript dynamic imports, Cloudflare Worker bundler boundaries, dual-runtime guards
**Confidence:** HIGH

## Summary

Phase 2 converts two static imports of `subscription-provider.js` in `provider-call.js` and `amp-web-search.js` to lazy `await import()` calls guarded by runtime checks, and hardens `state-store.js` with an explicit Worker guard. The existing codebase already has the exact pattern needed (`state-store.js:68`) and Phase 1 already configured `find_additional_modules` + `[[rules]]` in `wrangler.toml` to preserve dynamic import boundaries for `subscription-*.js` modules.

The code changes are minimal and well-defined: inline the one-liner `isSubscriptionProvider()` check, replace the static import with a conditional dynamic import, and add a `workerRuntime` guard returning 501 before the import. The main complexity is threading `runtimeFlags` into the functions -- `makeProviderCall` currently does NOT receive `runtimeFlags` and neither does `executeHostedSearchProviderRequest` in `amp-web-search.js`.

**Primary recommendation:** Follow the inline-check + lazy-import pattern from ARCHITECTURE.md research. Thread `runtimeFlags` through the existing parameter objects. Return 501 via the existing `jsonResponse` utility. All 27 existing tests must continue passing as the baseline.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
None -- all implementation choices at Claude's discretion.

### Claude's Discretion
All implementation choices are at Claude's discretion -- pure infrastructure phase. Key constraints from research and prior phases:

- Follow the existing `state-store.js:68` pattern: `const { fn } = await import("./module.js")` inside a conditional
- `isSubscriptionProvider()` is a one-liner (`provider?.type === 'subscription'`) -- can be inlined or extracted to a side-effect-free module
- Worker runtime detection via `runtimeFlags.workerRuntime` from `runtime-policy.js`
- Return 501 with descriptive error when subscription provider encountered in Worker mode
- `wrangler deploy --dry-run` must produce zero `node:*` warnings after changes
- All existing `node --test` tests must pass with zero regressions

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| IMPT-01 | `isSubscriptionProvider()` check inlined or extracted to side-effect-free module | Inline as `provider?.type === 'subscription'` in both files. One-liner does not justify a separate module (ARCHITECTURE.md Pattern 1). |
| IMPT-02 | `provider-call.js` uses lazy `await import()` for subscription-provider module | Replace static import at line 27 with `await import("../subscription-provider.js")` inside the `isSubscriptionProvider(provider)` block at line 626. |
| IMPT-03 | `amp-web-search.js` uses lazy `await import()` for subscription-provider module | Replace static import at line 12 with `await import("../subscription-provider.js")` inside `executeHostedSearchProviderRequest` at line 2093. |
| IMPT-04 | Worker returns clean 501 for subscription providers | Add `runtimeFlags.workerRuntime` guard before the dynamic import in both files. Return 501 with `not_supported_error` type via `jsonResponse()`. |
| IMPT-05 | Node.js local mode works identically -- all existing tests pass | All 27 tests in the 4 relevant test files pass as baseline. Dynamic import preserves identical behavior in Node.js. |
| HARD-01 | `state-store.js` has explicit Worker guard on its dynamic file-store import | Add guard in `createStateStore()` that rejects or falls back to memory when `backend === "file"` and Worker runtime detected. |
| HARD-02 | `wrangler deploy --dry-run` produces zero `node:*` warnings | Already clean as of Phase 1. Must remain so after Phase 2 changes. |
</phase_requirements>

## Standard Stack

No new libraries needed. This phase is pure refactoring of existing code.

### Core (Already in Project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js | 22.x | Test runner (`node --test`), local runtime | Project baseline |
| Wrangler | 4.70.0+ | Worker bundler, dry-run validation, dev server | Project baseline |

### Tools Used for Verification
| Tool | Command | Purpose |
|------|---------|---------|
| Node test runner | `node --test src/runtime/*.test.js` | Regression detection |
| Wrangler dry-run | `wrangler deploy --dry-run` | Bundle validation (zero warnings) |

**Installation:** None required. All tools already installed.

## Architecture Patterns

### Pattern 1: Inline Lightweight Check + Lazy-Load Heavy Module

**What:** Inline the `isSubscriptionProvider()` one-liner check directly in each file. Only `await import()` the heavy `subscription-provider.js` module when the check passes and the runtime allows it.

**When to use:** A module exports both a trivial check function and a heavyweight implementation. The check runs on every request; the implementation runs rarely.

**Example (for `provider-call.js`):**

```javascript
// BEFORE (line 27):
// import { isSubscriptionProvider, makeSubscriptionProviderCall } from "../subscription-provider.js";

// AFTER: Inline the check (zero imports needed)
function isSubscriptionProvider(provider) {
  return provider?.type === 'subscription';
}

// At usage site (line 626), add runtime guard + lazy import:
if (isSubscriptionProvider(provider)) {
  if (runtimeFlags?.workerRuntime) {
    return {
      ok: false, status: 501, retryable: false,
      errorKind: "not_supported",
      response: jsonResponse({
        type: "error",
        error: {
          type: "not_supported_error",
          message: "Subscription providers are not available in Worker mode."
        }
      }, 501)
    };
  }
  const { makeSubscriptionProviderCall } = await import("../subscription-provider.js");
  // ... rest of subscription logic unchanged
}
```

**Source:** ARCHITECTURE.md Pattern 1 + Pattern 3, verified against `state-store.js:68` existing code.

### Pattern 2: Threading runtimeFlags Through Parameter Objects

**What:** Pass `runtimeFlags` through the existing destructured parameter objects of `makeProviderCall` and `executeHostedSearchProviderRequest`.

**Critical finding:** `makeProviderCall` currently does NOT receive `runtimeFlags`. The caller in `handler.js:668` passes `env`, `runtimeConfig`, `stateStore`, etc. but not `runtimeFlags`. This must be added to both the call site and the function signature.

For `amp-web-search.js`, `executeHostedSearchProviderRequest` is a private function called from `searchHostedProviderRoute` (line 1167) and `runHostedSearchProviderQuery` (line 2139). These callers do not have `runtimeFlags` in scope either. The threading path is:
- `handler.js` has `runtimeFlags` (line 508)
- It calls `makeProviderCall` (line 668) -- add `runtimeFlags` here
- `makeProviderCall` calls `maybeInterceptAmpWebSearch` -- already has access
- For the hosted search path: `executeAmpWebSearch` -> `searchHostedProviderRoute` -> `runHostedSearchProviderQuery` -> `executeHostedSearchProviderRequest` -- needs threading

**Decision point:** For `amp-web-search.js`, consider whether to thread `runtimeFlags` through 3 function levels or to detect worker runtime locally. Since `runtimeFlags` is the canonical source and avoids duplicating detection logic, thread it.

### Pattern 3: Worker Guard in state-store.js

**What:** Add an explicit guard in `createStateStore()` when `backend === "file"` to reject or fallback in Worker mode.

**Current state:** `resolveStateStoreOptions()` in `runtime-policy.js:143` already forces `backend: "memory"` when `workerRuntime` is true. But `createStateStore()` itself has NO such guard. If called directly with `{backend: "file"}` (e.g., from a test or future code path), the `await import("./state-store.file.js")` executes. The bundler inlines `state-store.file.js` into the main bundle (confirmed: it is NOT in the additional modules list), and `node:fs` writes would fail via unenv stubs.

**Implementation:** Accept an optional `runtimeFlags` or `workerRuntime` parameter in `createStateStore`, or simply check a global/passed flag. The simplest approach: add a `workerRuntime` option to the options object.

```javascript
export async function createStateStore(options = {}) {
  if (hasStateStoreShape(options)) {
    return options;
  }
  const backend = normalizeStateStoreBackend(options.backend || options.type);
  if (backend === "file") {
    if (options.workerRuntime) {
      // Defense-in-depth: file backend cannot persist in Workers.
      // resolveStateStoreOptions should prevent this, but guard here too.
      return createMemoryStateStore(options);
    }
    const { createFileStateStore } = await import("./state-store.file.js");
    return createFileStateStore(options);
  }
  return createMemoryStateStore(options);
}
```

### Anti-Patterns to Avoid

- **Try-catch around static imports:** Static `import` statements execute at module load time before any user code. Cannot be caught. Use dynamic `import()` instead.
- **Separate worker entry point:** Creates code duplication. Single entry point with lazy loading is simpler.
- **Relying solely on nodejs_compat:** Import succeeds but `spawn()`, `fs.writeFile()` throw at runtime. Must combine with guards.
- **Top-level dynamic import (not inside guard):** `const mod = await import(...)` at module scope defeats the purpose. Must be inside `isSubscriptionProvider()` conditional.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Runtime detection | Custom `typeof process` checks | `runtimeFlags.workerRuntime` from `runtime-policy.js` | Already centralized, tested, handles edge cases |
| Subscription type checking | Complex provider type inspection | `provider?.type === 'subscription'` inline | One-liner, same as existing `isSubscriptionProvider()` |
| JSON error responses | Manual `new Response(JSON.stringify(...))` | `jsonResponse()` from `handler/http.js` | Already used everywhere, handles headers correctly |

## Common Pitfalls

### Pitfall 1: Forgetting to Thread runtimeFlags

**What goes wrong:** The Worker guard checks `runtimeFlags?.workerRuntime` but `runtimeFlags` is undefined because it was not passed to the function.
**Why it happens:** `makeProviderCall` currently has no `runtimeFlags` parameter. Easy to add the guard code but forget the plumbing.
**How to avoid:** Trace the full call chain: `handler.js:508` (creates runtimeFlags) -> `handler.js:668` (calls makeProviderCall) -> add to parameter destructuring -> use in guard.
**Warning signs:** Guard evaluates as falsy, subscription import still fires in Worker mode.

### Pitfall 2: Breaking the isSubscriptionProvider Check at Line 562

**What goes wrong:** `provider-call.js:562` uses `isSubscriptionProvider(provider)` BEFORE the main subscription block at line 626. This is used in `shouldPreferOpenAIForClaudeToolCalls` logic. If the inlined function has a different name or scope, this breaks.
**Why it happens:** There are TWO usage sites of `isSubscriptionProvider` in `provider-call.js` -- line 562 and line 626. Both need the inlined function.
**How to avoid:** Define the inlined function at file scope (not inside `makeProviderCall`), so both line 562 and 626 can use it.

### Pitfall 3: amp-web-search.js Has a Deeper Call Chain

**What goes wrong:** In `amp-web-search.js`, `isSubscriptionProvider` and `makeSubscriptionProviderCall` are used inside `executeHostedSearchProviderRequest` (line 2087), which is a private function called from multiple paths. The runtimeFlags threading requires changes to several intermediate functions.
**Why it happens:** The call chain is: `executeAmpWebSearch` -> `searchHostedProviderRoute` -> `runHostedSearchProviderQuery` -> `executeHostedSearchProviderRequest`. None of these currently pass runtimeFlags.
**How to avoid:** Thread runtimeFlags through the options/env parameter objects. Or accept that hosted search with subscription providers in Worker mode is not a valid configuration and add the guard only at the point where the subscription check happens.

### Pitfall 4: state-store.js Guard Must Not Break Existing Callers

**What goes wrong:** Adding a `workerRuntime` parameter to `createStateStore` options but forgetting that `handler.js:820` already passes `resolveStateStoreOptions(options, env, runtimeFlags)` which does NOT include `workerRuntime` in its output.
**Why it happens:** `resolveStateStoreOptions` already handles the fallback but doesn't pass through `workerRuntime`.
**How to avoid:** Either add `workerRuntime` to the returned options from `resolveStateStoreOptions`, or check the `backend` value in `createStateStore` (if `resolveStateStoreOptions` already forced it to "memory", the guard is never hit). The guard is defense-in-depth for direct callers.

### Pitfall 5: Subscription Test File Imports subscription-provider.js Statically

**What goes wrong:** `handler.subscription.test.js` at line 9 does `import { saveTokens } from "./subscription-tokens.js"` -- this is fine because tests run under Node.js. But the test also imports `makeProviderCall` which previously statically imported `subscription-provider.js`. After the refactor, the test must still work because `makeProviderCall` now uses dynamic import internally.
**Why it happens:** Tests run under Node.js where all imports work. The refactor should be transparent to tests.
**How to avoid:** Run all tests after every change. The refactor is internal to `makeProviderCall` and `executeHostedSearchProviderRequest`.

## Code Examples

### Example 1: provider-call.js Refactored Import Section

```javascript
// REMOVE this line:
// import { isSubscriptionProvider, makeSubscriptionProviderCall } from "../subscription-provider.js";

// ADD this inline function (file-scope, before makeProviderCall):
function isSubscriptionProvider(provider) {
  return provider?.type === 'subscription';
}
```

### Example 2: provider-call.js makeProviderCall Signature Change

```javascript
// BEFORE:
export async function makeProviderCall({
  body, sourceFormat, stream, candidate, requestKind,
  requestHeaders, env, clientType, runtimeConfig, stateStore, ampContext
}) {

// AFTER (add runtimeFlags):
export async function makeProviderCall({
  body, sourceFormat, stream, candidate, requestKind,
  requestHeaders, env, clientType, runtimeConfig, stateStore, ampContext,
  runtimeFlags
}) {
```

### Example 3: provider-call.js Guard + Lazy Import at Line 626

```javascript
if (isSubscriptionProvider(provider)) {
  // Guard: subscription providers cannot function in Worker mode
  if (runtimeFlags?.workerRuntime) {
    return {
      ok: false,
      status: 501,
      retryable: false,
      errorKind: "not_supported",
      response: jsonResponse({
        type: "error",
        error: {
          type: "not_supported_error",
          message: "Subscription providers are not available in Worker mode."
        }
      }, 501)
    };
  }
  const { makeSubscriptionProviderCall } = await import("../subscription-provider.js");
  // ... rest unchanged from line 627 onward
}
```

### Example 4: handler.js Call Site Change

```javascript
// handler.js:668 -- add runtimeFlags to the call
result = await makeProviderCall({
  body,
  sourceFormat,
  stream,
  requestKind: options.requestKind,
  candidate,
  requestHeaders: request.headers,
  env,
  clientType: options.clientType,
  runtimeConfig: config,
  stateStore,
  ampContext,
  runtimeFlags   // NEW
});
```

### Example 5: amp-web-search.js Guard in executeHostedSearchProviderRequest

```javascript
async function executeHostedSearchProviderRequest(resolvedRoute, body, env = {}, runtimeFlags) {
  const provider = resolvedRoute?.provider;
  if (!provider || typeof provider !== "object") {
    throw new Error("Hosted web search provider is not configured.");
  }
  if (isSubscriptionProvider(provider)) {
    if (runtimeFlags?.workerRuntime) {
      throw new Error("Subscription-based hosted web search providers are not available in Worker mode.");
    }
    const { makeSubscriptionProviderCall } = await import("../subscription-provider.js");
    // ... rest unchanged
  }
  // ... API-key path unchanged
}
```

### Example 6: state-store.js Defense-in-Depth Guard

```javascript
export async function createStateStore(options = {}) {
  if (hasStateStoreShape(options)) {
    return options;
  }
  const backend = normalizeStateStoreBackend(options.backend || options.type);
  if (backend === "file") {
    if (options.workerRuntime) {
      return createMemoryStateStore(options);
    }
    const { createFileStateStore } = await import("./state-store.file.js");
    return createFileStateStore(options);
  }
  return createMemoryStateStore(options);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Static import of subscription-provider.js | Lazy `await import()` behind guard | Phase 2 (this phase) | Breaks tainted import chain |
| No Worker runtime guard | `runtimeFlags.workerRuntime` guard with 501 | Phase 2 (this phase) | Clean error instead of crash |
| Implicit state-store backend fallback | Explicit guard in `createStateStore` | Phase 2 (this phase) | Defense-in-depth |

**Already resolved in Phase 1:**
- `wrangler.toml` `compatibility_date` updated to `2025-09-23`
- `nodejs_compat` flag added
- `find_additional_modules` + `[[rules]]` configured for subscription modules
- `wrangler deploy --dry-run` already produces zero warnings

## Open Questions

1. **runtimeFlags threading depth in amp-web-search.js**
   - What we know: `executeHostedSearchProviderRequest` is called from `runHostedSearchProviderQuery` (line 2139) which is called from `searchHostedProviderRoute` (line 1167) which is called from `executeAmpWebSearch` (line 1211). None pass runtimeFlags.
   - What's unclear: How many intermediate functions need signature changes vs. passing runtimeFlags via the existing `options` or `env` parameters.
   - Recommendation: Thread via the `options` parameter where it exists, or add to `env` as a sentinel. The planner should trace the exact call chain and decide the minimal threading approach.

2. **state-store.js workerRuntime detection mechanism**
   - What we know: `resolveStateStoreOptions` outputs `{backend: "memory"}` when `workerRuntime` is true, so the guard in `createStateStore` is defense-in-depth only.
   - What's unclear: Whether to add `workerRuntime` to the options output from `resolveStateStoreOptions` or detect it separately in `createStateStore`.
   - Recommendation: Add `workerRuntime: runtimeFlags?.workerRuntime` to `resolveStateStoreOptions` return value and read it in `createStateStore`. Minimal change, clean threading.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node.js built-in test runner (node:test) v22.x |
| Config file | None (uses node:test defaults) |
| Quick run command | `node --test src/runtime/handler.provider-call.test.js src/runtime/handler.subscription.test.js src/runtime/handler.amp-web-search.test.js src/runtime/state-store.test.js` |
| Full suite command | `node --test src/runtime/*.test.js src/node/*.test.js src/translator/**/*.test.js src/cli*.test.js` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IMPT-01 | isSubscriptionProvider inlined | unit | `node --test src/runtime/handler.subscription.test.js` | Yes (existing tests exercise subscription paths) |
| IMPT-02 | provider-call.js lazy import | unit | `node --test src/runtime/handler.provider-call.test.js src/runtime/handler.subscription.test.js` | Yes |
| IMPT-03 | amp-web-search.js lazy import | unit | `node --test src/runtime/handler.amp-web-search.test.js` | Yes |
| IMPT-04 | Worker 501 for subscription providers | unit | `node --test src/runtime/handler.provider-call.test.js` | No -- Wave 0 (new test needed) |
| IMPT-05 | Node.js mode no regressions | unit | `node --test src/runtime/handler.provider-call.test.js src/runtime/handler.subscription.test.js src/runtime/handler.amp-web-search.test.js src/runtime/state-store.test.js` | Yes (all 27 tests) |
| HARD-01 | state-store.js Worker guard | unit | `node --test src/runtime/state-store.test.js` | No -- Wave 0 (new test needed) |
| HARD-02 | Zero node:* warnings | smoke | `wrangler deploy --dry-run 2>&1 \| grep -c "node:"` | Manual command, no test file |

### Sampling Rate
- **Per task commit:** `node --test src/runtime/handler.provider-call.test.js src/runtime/handler.subscription.test.js src/runtime/handler.amp-web-search.test.js src/runtime/state-store.test.js`
- **Per wave merge:** Full test suite + `wrangler deploy --dry-run`
- **Phase gate:** Full suite green + zero dry-run warnings before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] Test case in `handler.provider-call.test.js` or `handler.subscription.test.js`: subscription provider + workerRuntime flag returns 501 (covers IMPT-04)
- [ ] Test case in `state-store.test.js`: createStateStore with `backend: "file"` + `workerRuntime: true` returns memory store (covers HARD-01)

## Sources

### Primary (HIGH confidence)
- Codebase audit: `src/runtime/handler/provider-call.js` lines 27, 540-552, 562, 626-640
- Codebase audit: `src/runtime/handler/amp-web-search.js` lines 12, 2087-2105
- Codebase audit: `src/runtime/state-store.js` lines 61-73
- Codebase audit: `src/runtime/handler/runtime-policy.js` lines 12-32, 131-160
- Codebase audit: `src/runtime/handler.js` lines 508, 668-680, 817-831
- Codebase audit: `src/runtime/subscription-provider.js` lines 35-37
- `.planning/research/ARCHITECTURE.md` -- Import chain analysis, recommended patterns
- `.planning/research/PITFALLS.md` -- Bundler inlining risk, polyfill trap, test runner blindness

### Secondary (MEDIUM confidence)
- `wrangler deploy --dry-run` output -- verified zero warnings, 5 additional modules attached
- `node --test` baseline -- verified 27 tests pass across 4 relevant test files

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, pure refactoring
- Architecture: HIGH -- patterns verified against existing codebase precedent (`state-store.js:68`)
- Pitfalls: HIGH -- runtimeFlags threading gap confirmed by code inspection, call chains traced
- Test coverage: HIGH -- baseline established (27 tests), Wave 0 gaps identified (2 new tests)

**Research date:** 2026-03-21
**Valid until:** 2026-04-21 (stable -- no external dependency changes expected)
