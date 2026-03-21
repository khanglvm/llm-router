# Technology Stack: Cloudflare Worker Compatibility Fix

**Project:** LLM Router -- Cloudflare Worker Compatibility
**Researched:** 2026-03-21
**Overall confidence:** HIGH

---

## Recommended Stack

### Wrangler Configuration (The Core Fix)

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `nodejs_compat` flag | N/A (runtime flag) | Enable Node.js API polyfills in Workers runtime | Umbrella flag that gates ALL Node.js module support. Without it, `node:*` imports fail at load time. With it + compat date 2025-09-01, `node:http`, `node:fs`, `node:crypto`, `node:path`, `node:os` all become importable. | HIGH |
| `compatibility_date` | `"2025-09-23"` | Unlock latest Worker features including `node:fs` and `node:http` server support | Date >= `2025-09-01` auto-enables `enable_nodejs_http_server_modules` and `enable_nodejs_fs_module`. Using `2025-09-23` gives margin. The current `2024-01-01` is too old -- misses all Node.js compat improvements from 2025. | HIGH |
| Wrangler CLI | `^4.68.1` (already installed) | Build, dev, deploy Workers | Already in devDependencies. v4 removes legacy `node_compat` config property in favor of `nodejs_compat` runtime flag. No version change needed. | HIGH |

**Resulting `wrangler.toml` config:**

```toml
name = "llm-router-route"
main = "src/index.js"
compatibility_date = "2025-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = false
preview_urls = false
```

### What `nodejs_compat` + `compatibility_date = "2025-09-23"` Provides

This is the critical decision point. The combination unlocks:

| Node Module | Status | What Works | What Does NOT Work | Confidence |
|-------------|--------|------------|-------------------|------------|
| `node:crypto` | Fully supported | `randomBytes`, `createHash`, `createHmac` -- everything `subscription-auth.js` uses | Nothing relevant blocked | HIGH |
| `node:path` | Fully supported | `join`, `resolve`, `dirname` -- everything in the codebase | Nothing relevant blocked | HIGH |
| `node:os` | Partially supported | Basic APIs available | `homedir()` may return fallback value, not a real home dir (no filesystem concept) | HIGH |
| `node:http` | Fully supported | `createServer`, `http.request`, `http.get` | Connection headers, trailer headers, HTTP upgrade, socket pooling | HIGH |
| `node:fs` | Fully supported (virtual FS) | `readFile`, `writeFile`, `mkdir`, `readdir` against virtual `/tmp`, `/bundle`, `/dev` | `watch`, `watchFile`, permissions/ownership, files don't persist across requests | HIGH |
| `node:child_process` | **Partially supported (non-functional stubs)** | **Import succeeds without error** -- module resolves | `spawn()`, `exec()`, `fork()` throw `"not implemented"` at call time | HIGH |

### The Key Insight: `node:child_process` Imports Without Crashing

With `nodejs_compat` enabled, the `unenv` polyfill layer provides stub exports for `node:child_process`. The module **resolves and imports successfully** -- the stub just throws if you actually call `spawn()` or `exec()`. Since the Worker never invokes subscription auth code (those paths are guarded by `workerSafeMode` and subscription provider type checks), the stubs are never called.

**This changes the fix strategy significantly.** The original audit assumed `node:child_process` import would crash the Worker at load time. With `nodejs_compat` + modern compat date, it does not crash -- it just provides non-functional stubs.

---

## Fix Strategy Decision

### Option A: `nodejs_compat` flag alone -- NOW VIABLE (Recommended)

With `compatibility_date = "2025-09-23"` and `compatibility_flags = ["nodejs_compat"]`:

- `node:http` -- fully supported, `createServer` works (though never called in Worker mode)
- `node:crypto` -- fully supported
- `node:child_process` -- import succeeds (stub), `spawn()` never called in Worker mode
- `node:fs` -- virtual FS available, `subscription-tokens.js` writes won't persist but won't crash
- `node:path` -- fully supported
- `node:os` -- partially supported, `homedir()` returns a value (may not be meaningful but won't throw)

**The static import chain no longer crashes.** Every `node:*` module in the chain resolves.

**BUT there is still a runtime issue:** `subscription-tokens.js` calls `os.homedir()` and `fs.mkdir()`/`fs.writeFile()` at the top of token loading functions. These will execute against the virtual FS `/tmp` (not persisting) or throw if `os.homedir()` returns something unexpected that breaks `path.join`. This is only triggered if a subscription provider is actually configured and a request hits that code path -- which `workerSafeMode: true` already guards against.

**Risk assessment:** LOW risk. The Worker sets `workerSafeMode: true` and subscription providers require Node-only OAuth login (which can't happen in Workers). No valid Worker config will have active subscription providers.

### Option B: Lazy-load subscription modules -- BELT AND SUSPENDERS (Recommended as hardening)

Convert static imports to dynamic `await import()` in the two files that import from `subscription-provider.js`:

1. `src/runtime/handler/provider-call.js` (line 27)
2. `src/runtime/handler/amp-web-search.js` (line 12)

This is still valuable as defense-in-depth even though Option A makes it technically unnecessary:

- Reduces bundle size by not loading subscription code in Worker context
- Prevents any future accidental invocation of subscription code
- Makes the Worker startup path cleaner

### Option C: Build-time exclusion -- NOT RECOMMENDED for this project

Would require adding a custom build step. The project currently has no build pipeline for the Worker (wrangler bundles directly from `src/index.js`). Adding one is unnecessary complexity given Options A+B solve the problem completely.

---

## Recommended Approach: A + B Combined

1. **Phase 1 (unblocks deployment):** Update `wrangler.toml` with `nodejs_compat` flag and modern `compatibility_date`
2. **Phase 2 (hardening):** Convert subscription-provider imports to lazy dynamic imports in `provider-call.js` and `amp-web-search.js`
3. **Phase 3 (verification):** Add `wrangler dev` smoke test

### Specific Code Changes Required

**`wrangler.toml` changes:**

```toml
compatibility_date = "2025-09-23"
compatibility_flags = ["nodejs_compat"]
```

**`provider-call.js` lazy-load pattern:**

```javascript
// Before (static, loads entire subscription chain at module load):
import { isSubscriptionProvider, makeSubscriptionProviderCall } from "../subscription-provider.js";

// After (lazy, only loaded when subscription provider is actually needed):
function isSubscriptionProvider(provider) {
  return provider?.type === 'subscription';
}

let _subscriptionModule;
async function getSubscriptionModule() {
  if (!_subscriptionModule) {
    _subscriptionModule = await import("../subscription-provider.js");
  }
  return _subscriptionModule;
}
```

Note: `isSubscriptionProvider` is a trivial check (`provider?.type === 'subscription'`) that can be inlined to avoid the import entirely for non-subscription paths. Only `makeSubscriptionProviderCall` needs the lazy import.

**`amp-web-search.js` same pattern** -- identical change for its import on line 12.

**`state-store.js`** -- already uses dynamic import correctly:
```javascript
if (backend === "file") {
  const { createFileStateStore } = await import("./state-store.file.js");
  return createFileStateStore(options);
}
```
This is already Worker-safe since the Worker entry passes `defaultStateStoreBackend: "memory"`.

---

## Supporting Libraries

| Library | Version | Purpose | When to Use | Confidence |
|---------|---------|---------|-------------|------------|
| `esbuild` | `^0.27.3` (already installed) | Bundling (used by wrangler internally) | No additional config needed -- wrangler handles this | HIGH |
| `@cloudflare/vitest-pool-workers` | Latest | Worker integration testing in CI | Optional -- for testing Worker-specific behavior in the workerd runtime. Only needed if `wrangler dev` smoke test is insufficient. | MEDIUM |
| `miniflare` | Bundled with wrangler | Local Worker simulation | Used automatically by `wrangler dev`. No separate install needed. | HIGH |

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Compat strategy | `nodejs_compat` flag + lazy imports | Build-time module exclusion (Option C) | Adds build pipeline complexity. No build step exists today. The two simpler options together fully solve the problem. |
| Compat strategy | Lazy `await import()` | Worker-stub module (`subscription-provider.worker-stub.js`) | Stubs require maintaining parallel exports. Dynamic import is standard ES, zero maintenance, and wrangler handles it natively. |
| Compat date | `2025-09-23` | `2024-09-23` (minimal for nodejs_compat_v2) | Would miss `node:http` server support (needs 2025-09-01+) and `node:fs` support (needs 2025-09-01+). The modern date costs nothing and provides maximum compat. |
| Compat date | `2025-09-23` | `2026-03-21` (today) | Using today's date is fine too but provides no additional benefit over 2025-09-23 for this use case. Either works. |
| Testing | `wrangler dev` smoke test | Vitest pool workers | Vitest pool is overkill for validating "Worker starts and handles a request". A simple script that boots `wrangler dev`, sends a health-check request, and exits is sufficient. |
| Node.js compat | `nodejs_compat` umbrella flag | Individual flags (`enable_nodejs_http_modules`, etc.) | Umbrella flag is Cloudflare's recommended approach. Auto-enables all sub-flags for the given compat date. Less config to maintain. |

---

## CI Smoke Test Tooling

**Pattern for `wrangler dev` smoke test:**

```bash
# Start wrangler dev in background, wait for ready, send request, check response
npx wrangler dev --port 8787 &
WRANGLER_PID=$!
sleep 3  # Wait for startup
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/health 2>/dev/null || echo "000")
kill $WRANGLER_PID 2>/dev/null
[ "$STATUS" = "200" ] && echo "PASS" || (echo "FAIL: got $STATUS" && exit 1)
```

This validates the critical path: Worker loads all modules, starts, and handles a request without crashing.

---

## What NOT to Use

| Technology | Why Not |
|------------|---------|
| `node_compat` (legacy wrangler config property) | Deprecated in Wrangler v4. Replaced by `nodejs_compat` compatibility flag. Will cause errors in wrangler 4.x. |
| `nodejs_compat_v2` as explicit flag | Not needed -- automatically enabled when `nodejs_compat` is set with compat date >= `2024-09-23`. Adding it explicitly is redundant. |
| `no_nodejs_compat_v2` | Would disable Node.js polyfills that this project needs. Never use this. |
| Custom esbuild `--external` flags | Wrangler manages its own esbuild. Custom external flags require a custom build step. Unnecessary here. |
| `unenv` as direct dependency | Already bundled within wrangler/workerd. Do not install separately -- it would conflict. |
| Hono/Express/framework | The project uses raw `fetch()` handler. Adding a framework is out of scope and unnecessary. |
| Polyfill packages (e.g., `cross-fetch`, `node-fetch`) | Workers have native `fetch()`, `Request`, `Response`, `ReadableStream`, etc. No polyfills needed for Web APIs. |

---

## Bundle Size Impact

| Change | Size Impact | Notes |
|--------|-------------|-------|
| Adding `nodejs_compat` flag | ~50-100 KiB increase in polyfill overhead | `unenv` stubs are lightweight. Total bundle well under 3MB gzip limit. |
| Lazy-loading subscription modules | Slight decrease (if module is excluded from main bundle) | Wrangler may still include the module in the bundle but not execute it at startup. Net effect is minimal. |
| Current bundle | 556 KiB / 108 KiB gzip | Free tier limit is 3 MB gzip. Over 25x headroom. |

---

## Installation / Configuration

No new packages to install. All changes are configuration:

```bash
# No npm install needed -- wrangler 4.68.1 is already in devDependencies

# The fix is purely configuration + code changes:
# 1. Update wrangler.toml (compatibility_date + compatibility_flags)
# 2. Modify two .js files (lazy-load subscription imports)
# 3. Add CI smoke test script
```

---

## Sources

- [Cloudflare Workers Node.js Compatibility Docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) -- Module support matrix, compatibility requirements
- [Cloudflare Workers Compatibility Flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) -- `nodejs_compat`, `nodejs_compat_v2`, date-gated flags
- [Cloudflare Workers node:http Docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/) -- `createServer` support, limitations, compat date `2025-09-01`
- [Cloudflare Workers node:fs Docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/) -- Virtual FS, `/tmp` writable, compat date `2025-09-01`
- [A Year of Improving Node.js Compatibility in Workers (Blog)](https://blog.cloudflare.com/nodejs-workers-2025/) -- 2025 improvements overview
- [Wrangler Bundling Docs](https://developers.cloudflare.com/workers/wrangler/bundling/) -- `find_additional_modules`, external modules, dynamic imports
- [Wrangler Custom Builds Docs](https://developers.cloudflare.com/workers/wrangler/custom-builds/) -- `[build]` section configuration
- [Wrangler v4 Migration](https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/) -- Legacy `node_compat` removal
- [unenv (GitHub)](https://github.com/unjs/unenv) -- Node.js polyfill/stub library used by workerd
- [Wrangler v4 Changelog](https://developers.cloudflare.com/changelog/post/2025-03-13-wrangler-v4/) -- v4 GA announcement
