# Architecture Patterns: Cloudflare Worker Compatibility Fix

**Domain:** Dual-runtime compatibility (Node.js + Cloudflare Workers) for LLM Router
**Researched:** 2026-03-21

## Current Architecture

The codebase already has partial runtime separation. The problem is narrow: two files in the universal `runtime/` layer statically import Node-only modules, poisoning the entire Worker import chain.

### Existing Directory Layout

```
src/
  index.js              # Worker entrypoint (universal)
  cli-entry.js          # CLI entrypoint (Node-only)
  cli/                  # CLI commands (Node-only)
  node/                 # Node-only server, web console, config store
  runtime/              # SHOULD be universal, but has two tainted files
    handler.js          # Core request handler (universal)
    handler/            # Handler sub-modules (universal)
      provider-call.js  # TAINTED: statically imports subscription-provider.js
      amp-web-search.js # TAINTED: statically imports subscription-provider.js
    subscription-provider.js  # Node-only at load time (imports auth chain)
    subscription-auth.js      # Node-only: node:http, node:crypto, node:child_process
    subscription-tokens.js    # Node-only: node:fs, node:path, node:os
    subscription-constants.js # Universal: pure data, no Node imports
    state-store.js            # Universal (already uses dynamic import for file backend)
    state-store.memory.js     # Universal
    state-store.file.js       # Node-only: node:fs, node:path, node:os
    balancer.js               # Universal
    config.js                 # Universal
    rate-limits.js            # Universal
  shared/               # Universal utilities
  translator/           # Universal format translation
```

### The Tainted Import Chain

```
src/index.js (Worker entry)
  -> runtime/handler.js
       -> runtime/handler/provider-call.js
       |    -> runtime/subscription-provider.js          [PROBLEM]
       |         -> runtime/subscription-auth.js         [node:http, node:crypto, node:child_process]
       |         -> runtime/subscription-tokens.js       [node:fs, node:path, node:os]
       -> runtime/handler/amp-web-search.js
            -> runtime/subscription-provider.js          [SAME PROBLEM]
```

Both `provider-call.js` and `amp-web-search.js` statically import:
```javascript
import { isSubscriptionProvider, makeSubscriptionProviderCall } from "../subscription-provider.js";
```

This causes the full subscription auth chain to load at module evaluation time.

### Why the Fix is Simpler Than Expected

With `nodejs_compat` flag + `compatibility_date = "2025-09-23"`:
- `node:http`, `node:crypto`, `node:path`, `node:fs`, `node:os` -- all resolve and import successfully
- `node:child_process` -- imports successfully via `unenv` stubs (throws only if `spawn()` is called)

The static import chain no longer crashes. But lazy-loading remains valuable as defense-in-depth.

## Recommended Architecture: Inline Guard + Lazy Import

### Component Boundaries After Fix

| Component | Runtime | Changes | Rationale |
|-----------|---------|---------|-----------|
| `provider-call.js` | Universal | Inline `isSubscriptionProvider()`, lazy-import `subscription-provider.js` | Breaks the static import chain. Subscription module only loaded when actually needed. |
| `amp-web-search.js` | Universal | Same pattern as `provider-call.js` | Same rationale. Second import site for `subscription-provider.js`. |
| `subscription-provider.js` | Node-only | No changes | Heavy module stays as-is. Just not statically imported anymore. |
| `subscription-auth.js` | Node-only | No changes | `node:http`, `node:crypto`, `node:child_process` -- used for OAuth flows. |
| `subscription-tokens.js` | Node-only | No changes | `node:fs`, `node:path`, `node:os` -- used for token file storage. |
| `state-store.js` | Universal | No changes (already safe) | Dynamic import for file backend, memory default for Worker. |
| `wrangler.toml` | Config | Add `nodejs_compat`, update `compatibility_date` | Enables polyfills for all `node:*` modules. |

### Data Flow: Worker Request Path (After Fix)

```
Request arrives at Worker
  |
  v
src/index.js -- createFetchHandler({ runtime: "worker", workerSafeMode: true })
  |
  v
runtime/handler.js -- route selection, candidate ranking
  |
  v
runtime/handler/provider-call.js
  |
  +-- isSubscriptionProvider(provider)   <-- inlined check (no import)
  |     |
  |     +-- false (API-key provider) --> fetch() to provider URL --> adapt response
  |     |
  |     +-- true --> never happens in valid Worker config (no subscription providers)
  |                  if it did: return 501 error without loading subscription module
  |
  v
Response returned
```

### Data Flow: Node.js Request Path (After Fix)

```
Request arrives at Node local server
  |
  v
runtime/handler/provider-call.js
  |
  +-- isSubscriptionProvider(provider)   <-- inlined check
  |     |
  |     +-- false (API-key provider) --> fetch() to provider URL
  |     |
  |     +-- true (subscription) --> dynamic import("../subscription-provider.js")
  |                                 --> makeSubscriptionProviderCall()
  |                                     --> subscription-auth.js (OAuth flow)
  |                                     --> subscription-tokens.js (token storage)
  |
  v
Response returned
```

## Patterns to Follow

### Pattern 1: Inline Lightweight Check, Lazy-Load Heavy Module

**What:** Inline the lightweight check function (`isSubscriptionProvider`), lazy-load the heavy implementation (`makeSubscriptionProviderCall`).

**When:** A module exports both a cheap check and an expensive implementation. The check is needed frequently, the implementation rarely.

**Example:**

```javascript
// Inline the check (it's just: provider?.type === 'subscription')
function isSubscriptionProvider(provider) {
  return provider?.type === 'subscription';
}

// Lazy-load only when the check passes
if (isSubscriptionProvider(provider)) {
  const { makeSubscriptionProviderCall } = await import("../subscription-provider.js");
  return makeSubscriptionProviderCall({ provider, body, stream, env });
}
```

**Why this over a separate `subscription-check.js` module:** The check is a single line. Creating a module for it is over-engineering. If the check logic ever becomes complex, extract then.

### Pattern 2: Conditional Backend Factory (Already Implemented)

**What:** Use dynamic import inside a factory function to select runtime-appropriate backends.

**Example (already in `state-store.js`):**

```javascript
export async function createStateStore(options = {}) {
  if (backend === "file") {
    const { createFileStateStore } = await import("./state-store.file.js");
    return createFileStateStore(options);
  }
  return createMemoryStateStore(options);
}
```

The fix for `provider-call.js` follows this exact pattern. The codebase already has the right precedent.

### Pattern 3: Worker Runtime Guard Before Dynamic Import

**What:** Check `workerSafeMode` or `runtime === "worker"` before attempting the dynamic import. Return a clear error instead of loading code that can't function.

**Example:**

```javascript
if (isSubscriptionProvider(provider)) {
  // Guard: subscription providers cannot function in Worker mode
  // (requires node:child_process.spawn for OAuth browser flow)
  if (runtimeFlags?.workerRuntime) {
    return {
      ok: false, status: 501, retryable: false,
      response: jsonResponse({
        type: 'error',
        error: { type: 'not_supported_error',
                 message: 'Subscription providers are not available in Worker mode.' }
      }, 501)
    };
  }
  const { makeSubscriptionProviderCall } = await import("../subscription-provider.js");
  // ...
}
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Build-Time Module Aliasing

**What:** Using wrangler `[build]` or esbuild aliases to swap `subscription-provider.js` with a stub at build time.

**Why bad:** No build pipeline exists today. Adding one creates maintenance burden for a problem solvable with 20 lines of code changes.

**Instead:** Runtime lazy imports.

### Anti-Pattern 2: Relying Solely on `nodejs_compat` Without Code Changes

**What:** Just adding the flag and assuming everything works.

**Why bad:** While imports succeed with `nodejs_compat`, `subscription-tokens.js` will attempt to write to virtual FS and `subscription-auth.js` will fail if `spawn()` is called. These are hidden time bombs if someone misconfigures a Worker with a subscription provider.

**Instead:** Combine `nodejs_compat` (makes imports work) with lazy loading (prevents the code from running) and runtime guards (clear error messages).

### Anti-Pattern 3: Try-Catch Around Static Imports

**What:** Wrapping imports in try-catch to handle unavailable modules.

**Why bad:** Static `import` statements cannot be wrapped in try-catch -- they execute at module load before any user code runs. Dynamic `import()` can be try-caught but is unnecessary here since we use a guard-before-import pattern.

### Anti-Pattern 4: Creating a Worker-Specific Entry Point

**What:** `src/index.worker.js` that duplicates the module graph without subscription imports.

**Why bad:** Duplicates code. Every new feature must be added to both entry points. The graphs diverge over time.

**Instead:** Single entry point with lazy loading for environment-specific modules.

## Implementation Order

```
Step 1: Update wrangler.toml (independent)
  |
  v
Step 2: Modify provider-call.js (inline check + lazy import)
  |
  v
Step 3: Modify amp-web-search.js (same pattern)
  |
  v
Step 4: Smoke test with wrangler dev
  |
  v
Step 5: Validate Node.js mode (existing test suite)
```

Steps 1-3 can be done in any order. Step 4 requires all three. Step 5 should run after every change.

## Sources

- [Cloudflare Workers Node.js Compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Cloudflare Workers Compatibility Flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
- [Cloudflare Workers Bundling](https://developers.cloudflare.com/workers/wrangler/bundling/) -- dynamic import handling
- [Workers SDK Issue #2672](https://github.com/cloudflare/workers-sdk/issues/2672) -- dynamic import preservation
- Codebase: `src/index.js`, `src/runtime/handler.js`, `src/runtime/handler/provider-call.js`, `src/runtime/handler/amp-web-search.js`, `src/runtime/state-store.js`
