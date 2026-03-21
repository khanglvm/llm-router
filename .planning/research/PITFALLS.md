# Domain Pitfalls: Node.js-to-Cloudflare Workers Migration

**Domain:** Cloudflare Worker compatibility fix for a dual-runtime LLM router
**Researched:** 2026-03-21
**Overall confidence:** HIGH (verified against official Cloudflare docs and codebase audit)

---

## Critical Pitfalls

Mistakes that cause the Worker to crash at startup or silently break core functionality.

### Pitfall 1: Wrangler Inlines Dynamic Imports, Defeating Lazy-Load Guards

**What goes wrong:** You convert `import { foo } from './node-only.js'` to `await import('./node-only.js')` expecting it to defer execution. Wrangler's esbuild bundler inlines the dynamically imported module back into the entrypoint bundle. The Node.js-only `import http from 'node:http'` inside that module now executes at module load time anyway, crashing the Worker before `fetch()` is ever called.

**Why it happens:** Wrangler uses esbuild for bundling, which by default resolves all `import()` expressions and bundles their targets into the output file. The dynamic import boundary is erased during bundling. This is the single most likely failure mode for the recommended "Option B: lazy-load" approach in this project.

**Consequences:** Worker crashes on deployment with the same `node:http` / `node:child_process` errors as before, despite the code refactor appearing correct when tested locally under Node.js.

**Warning signs:**
- `wrangler deploy --dry-run` still shows warnings for `node:http`, `node:child_process`
- The output bundle is a single file with no additional module files
- `wrangler dev` crashes on startup with the same import errors

**Prevention:**
1. Use `find_additional_modules: true` in `wrangler.toml` combined with `rules` to tell Wrangler to preserve lazy-loaded files as separate modules:
   ```toml
   find_additional_modules = true
   [[rules]]
   type = "EsModule"
   globs = ["src/runtime/subscription-provider.js", "src/runtime/subscription-auth.js", "src/runtime/subscription-tokens.js"]
   fallthrough = true
   ```
2. Alternatively, mark the Node-only modules as `external` in esbuild config so they are never bundled, then provide Worker stubs.
3. Verify after every build: check the output for multiple files, or grep the single output for `node:http` to confirm the problematic code is absent.

**Detection:** Run `wrangler deploy --dry-run` after every change to the import structure. If warnings for `node:http` or `node:child_process` persist, the lazy-load boundary was erased.

**Confidence:** HIGH -- confirmed via [Wrangler bundling docs](https://developers.cloudflare.com/workers/wrangler/bundling/) and [Issue #2672](https://github.com/cloudflare/workers-sdk/issues/2672).

**Phase:** Must be addressed in Phase 1 (import restructuring). This is the foundational correctness gate.

---

### Pitfall 2: The `nodejs_compat` Polyfill Trap -- Import Succeeds but Methods Throw at Runtime

**What goes wrong:** With `nodejs_compat` (v2) enabled, modules like `node:child_process` and `node:fs` can be imported without error because `unenv` provides stub/mock implementations. The import succeeds, giving false confidence. Then at runtime, calling `spawn()` or `fs.readFile()` throws a cryptic "not yet supported" error. This is worse than a crash-at-startup because it is a silent bomb: the Worker starts, handles some requests fine, but explodes on the specific code path that calls the stubbed method.

**Why it happens:** Cloudflare uses `unenv` to polyfill Node.js APIs. For modules that cannot meaningfully run in Workers (child_process, parts of fs), `unenv` provides non-functional stubs that import successfully but throw when called. This design lets NPM packages that merely reference these modules still load, but it creates a false-positive when you test "does the import work?"

**Consequences:** The Worker deploys and appears healthy. Requests that trigger subscription provider paths (if somehow reached despite guards) fail with an opaque runtime error instead of a clear "not supported" message.

**Warning signs:**
- `wrangler dev` starts without errors after adding `nodejs_compat`
- Tests pass because the import-level check succeeds
- No guards exist to prevent the stubbed method from being called

**Prevention:**
1. Never rely solely on `nodejs_compat` to "fix" imports of fundamentally unsupported modules. The lazy-load/exclusion approach (Pitfall 1) must still be applied.
2. Add explicit runtime guards before any subscription provider call:
   ```javascript
   if (runtimeFlags.workerRuntime) {
     return { ok: false, status: 501, errorKind: 'not_supported', ... };
   }
   ```
3. Test the actual code paths, not just module loading. A smoke test must call the subscription endpoint and verify it returns 501, not a crash.

**Detection:** Grep for any call to `spawn`, `fs.readFile`, `fs.writeFile`, `http.createServer` etc. that could be reached in Worker mode. Every such call needs a runtime guard or must be behind a lazy-load boundary that is never triggered.

**Confidence:** HIGH -- confirmed via [Cloudflare Node.js compat docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) and [unenv polyfill behavior blog post](https://blog.cloudflare.com/more-npm-packages-on-cloudflare-workers-combining-polyfills-and-native-code/).

**Phase:** Phase 1 (compat flag setup) and Phase 2 (runtime guards). Must be validated in Phase 3 (smoke tests).

---

### Pitfall 3: Vitest/Test Runner Hides Missing Compat Flags

**What goes wrong:** You write unit tests or integration tests for the Worker using the Cloudflare Vitest pool or Node.js test runner. Tests pass because the test environment automatically injects `nodejs_compat` or has full Node.js APIs available. You deploy, and the Worker crashes because `wrangler.toml` never had the `nodejs_compat` flag.

**Why it happens:** The Vitest pool for Cloudflare Workers automatically injects `nodejs_compat`, regardless of your `wrangler.toml` configuration. Node.js native test runner (which this project uses -- `node --test`) has full Node.js API access by definition. Neither testing approach catches missing compat flags.

**Consequences:** False green CI. The Worker fails on first request in production.

**Warning signs:**
- Tests pass but `wrangler dev` fails
- `wrangler.toml` has no `compatibility_flags` section
- Tests never actually run inside the Workers runtime

**Prevention:**
1. Always include a `wrangler dev` smoke test in CI that actually starts the Worker runtime and sends a real HTTP request.
2. Treat `wrangler deploy --dry-run` as a required CI step separate from unit tests.
3. For this project specifically: the existing `node --test` tests are Node.js-only by design. Add a separate `test:worker` script that verifies Worker startup via `wrangler dev`.

**Detection:** If you can remove `compatibility_flags` from `wrangler.toml` and all tests still pass, your tests are not catching compat issues.

**Confidence:** HIGH -- explicitly documented as a [known issue in Cloudflare Vitest docs](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/).

**Phase:** Phase 3 (CI/smoke testing). This is the verification phase that prevents all the above pitfalls from shipping.

---

### Pitfall 4: Compatibility Date Too Old -- Missing APIs and Flag Interactions

**What goes wrong:** The current `wrangler.toml` has `compatibility_date = "2024-01-01"`. This date is over 2 years old. Several Worker runtime features and Node.js compat improvements require newer dates. Worse, flag interactions change: `nodejs_compat_v2` requires `compatibility_date >= 2024-09-23` to auto-enable. Setting `nodejs_compat` without updating the date may silently use v1 behavior, which has fewer polyfills.

**Why it happens:** The original Worker deployment was set up early and never updated. Compatibility dates are intentionally sticky (Workers never break running code), so there is no built-in pressure to update.

**Consequences:**
- `node:http` client APIs require `compatibility_date >= 2025-08-15` to auto-enable via `enable_nodejs_http_modules`
- `node:http` server APIs (createServer) require `>= 2025-09-01`
- Some `node:child_process` non-functional stubs require `>= 2026-03-17`
- Older dates may lack `DecompressionStream` improvements and URL spec fixes
- The `nodejs_compat` flag without `v2` gives fewer polyfills

**Warning signs:**
- `compatibility_date` is more than 6 months behind
- Adding `nodejs_compat` but not getting expected module support
- `wrangler dev` works but deployed Worker does not (date affects runtime behavior)

**Prevention:**
1. Update `compatibility_date` to a recent date (e.g., `"2025-09-23"` or later) to get `nodejs_compat_v2` auto-behavior, `enable_nodejs_http_modules`, and all recent fixes.
2. Do NOT jump straight to today's date without testing -- each date boundary can introduce behavioral changes (URLSearchParams, context object handling). Update incrementally or review the [changelog](https://developers.cloudflare.com/workers/platform/changelog/).
3. Test with `wrangler dev` after updating the date before deploying.

**Detection:** Compare your `compatibility_date` against the [compatibility flags reference](https://developers.cloudflare.com/workers/configuration/compatibility-flags/). If any flag you need has a "default date" after your compatibility_date, you must either update the date or explicitly add the flag.

**Confidence:** HIGH -- directly from [Cloudflare compatibility dates docs](https://developers.cloudflare.com/workers/configuration/compatibility-dates/) and [compatibility flags docs](https://developers.cloudflare.com/workers/configuration/compatibility-flags/).

**Phase:** Phase 1 (wrangler.toml configuration). Must be decided before any other compat flags are added.

---

## Moderate Pitfalls

### Pitfall 5: Global Map/Object State Silently Becomes Per-Request

**What goes wrong:** The codebase uses global `Map` objects in `fallback.js`, `amp-web-search.js`, and `network-guards.js` for caching and state tracking. In Workers, these appear to work in `wrangler dev` (single isolate) but become effectively stateless in production because each request may run in a different isolate or the isolate may be evicted between requests.

**Why it happens:** Workers reuse isolates as a performance optimization, but there is no guarantee of persistence. Global state may or may not survive between requests. In production with traffic spread across edge locations, state rarely persists.

**Prevention:**
1. The existing `workerSafeMode: true` flag already disables stateful features (round-robin, rate limits) -- verify every global Map is covered by this mode.
2. Accept that in-memory caches in Workers are "best effort" and code defensively (treat every request as cold).
3. Do NOT attempt to add Durable Objects just for this -- the existing `workerSafeMode` tradeoff is correct for the proxy use case.

**Detection:** Grep for module-level `new Map()`, `new Set()`, or `let`/`var` declarations in `src/runtime/` that accumulate state. Each one should either be guarded by `workerSafeMode` or be acceptable as best-effort cache.

**Confidence:** HIGH -- confirmed via [Workers best practices docs](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) and audit findings.

**Phase:** Phase 2 (runtime guard verification). Low priority -- already handled by `workerSafeMode`.

---

### Pitfall 6: Breaking Node.js Mode While Fixing Worker Mode

**What goes wrong:** While refactoring imports for Worker compatibility, you accidentally change behavior in Node.js mode. Common mistakes: making a synchronous import path async (breaking call sites), removing a re-export that Node.js consumers depend on, or introducing a runtime check that evaluates differently in Node.js.

**Why it happens:** The codebase runs both as a Cloudflare Worker (`src/index.js`) and as a Node.js CLI/server (`src/cli-entry.js` -> `src/node/`). Changes to shared `src/runtime/` code affect both paths. The import chain from `handler.js` is shared.

**Consequences:** Worker deploys correctly but `npm start` / `llr start` breaks for local users. Or worse: subscription provider auth flow breaks because the lazy-load refactor changed timing.

**Warning signs:**
- Only testing with `wrangler dev`, never running `node src/cli-entry.js start`
- Changing `import` to `await import()` without verifying all callers handle the Promise
- Removing exports from `subscription-provider.js` that `src/node/` code imports

**Prevention:**
1. Run the existing Node.js test suite (`node --test`) after every change, before testing Worker mode.
2. Keep the change surface minimal: only modify the import statements in `provider-call.js` and `amp-web-search.js`, not the subscription modules themselves.
3. The `isSubscriptionProvider()` function must remain a synchronous, statically-importable function (it is pure logic, no Node deps). Only `makeSubscriptionProviderCall()` needs lazy-loading.

**Detection:** Run `node --test` against all existing tests. Any test failure means Node.js mode is broken.

**Confidence:** HIGH -- derived from codebase analysis showing shared runtime code.

**Phase:** Every phase. This is a continuous verification requirement, not a one-time fix.

---

### Pitfall 7: Dynamic Import Adds Latency to Every Request (Not Just Lazy Paths)

**What goes wrong:** Converting `import { makeSubscriptionProviderCall } from '../subscription-provider.js'` to a dynamic `await import()` means every request that reaches the provider-call code path pays the cost of checking whether the module is loaded and potentially loading it. If Wrangler preserves the dynamic import as a separate module (the correct behavior per Pitfall 1), the Worker runtime must parse and execute that module on first use, adding cold-start latency.

**Why it happens:** The Workers runtime loads additional modules on-demand. The first request through a lazy-loaded path pays the parse+execute cost. Subsequent requests in the same isolate reuse the cached module, but isolate reuse is not guaranteed.

**Consequences:** Increased TTFB for the first request that hits a subscription provider path (which is moot in Worker mode since subscription providers are disabled). More critically, if the lazy-load is structured poorly, even non-subscription requests may trigger the module load.

**Warning signs:**
- `wrangler dev` shows slow first response
- The dynamic import is placed in a code path that runs for every request (e.g., at the top of `makeProviderCall()` unconditionally)

**Prevention:**
1. Guard the dynamic import behind `isSubscriptionProvider(provider)` check, which is a synchronous pure-logic function that does not require the lazy module. Only load the module if a subscription provider is actually being called.
2. In Worker mode, subscription providers should never be configured, so the dynamic import should never trigger. The guard is: `if (runtimeFlags.workerRuntime) return null;` before the import.
3. Cache the module reference in a module-level variable so the dynamic import only runs once per isolate lifetime:
   ```javascript
   let _subscriptionMod;
   async function getSubscriptionModule() {
     if (!_subscriptionMod) {
       _subscriptionMod = await import('../subscription-provider.js');
     }
     return _subscriptionMod;
   }
   ```

**Detection:** Measure TTFB with `wrangler dev` for non-subscription requests. If it exceeds baseline by more than 5ms, the lazy module may be loading unnecessarily.

**Confidence:** MEDIUM -- the [workerd issue #2372](https://github.com/cloudflare/workerd/issues/2372) confirms TTFB impact from additional modules, but the magnitude depends on module size.

**Phase:** Phase 1 (import restructuring). The guard placement is a correctness concern, not just performance.

---

## Minor Pitfalls

### Pitfall 8: Config Secret Size Limit (32 KB) Silently Truncates

**What goes wrong:** The `LLM_ROUTER_CONFIG_JSON` Worker secret exceeds 32 KB for users with many providers, long model lists, or detailed per-model configuration. Wrangler may silently truncate or reject the secret upload.

**Prevention:** The deploy CLI already checks config size. Ensure the warning is prominent. Consider recommending config minimization (removing comments, whitespace) for large configurations.

**Detection:** `wrangler secret put` fails or the Worker starts with partial/corrupt config. Add a config-size validation step to the deploy command.

**Confidence:** HIGH -- documented in the audit, limit confirmed in Cloudflare docs.

**Phase:** Phase 2 (deployment hardening). Not blocking for the import fix.

---

### Pitfall 9: `DecompressionStream` Availability With Old Compat Date

**What goes wrong:** The project uses `DecompressionStream` (Web API) for gzip decompression. While available since `compatibility_date = 2023-08-01`, behavior or performance may differ at very old compatibility dates.

**Prevention:** Updating the compatibility_date to 2025+ (Pitfall 4) resolves this automatically.

**Detection:** Test gzip-compressed responses through `wrangler dev`.

**Confidence:** MEDIUM -- `DecompressionStream` is standard Web API and should work, but edge cases with old dates are unverified.

**Phase:** Phase 1 (compat date update resolves this).

---

### Pitfall 10: `wrangler dev` Works but `wrangler deploy` Fails (or Vice Versa)

**What goes wrong:** `wrangler dev` runs a local `workerd` runtime that may behave slightly differently from the production Workers runtime. Differences include: local bindings simulation, DNS handling, and subtle polyfill behavior differences.

**Prevention:**
1. Use `wrangler deploy --dry-run` as the definitive compatibility check (validates the bundle against production rules).
2. After a successful `wrangler dev` smoke test, always run `--dry-run` before actual deployment.
3. In CI, run both: `wrangler dev` for functional smoke test, `--dry-run` for deployment validation.

**Detection:** Worker starts locally but returns errors when deployed (or deploy fails outright).

**Confidence:** MEDIUM -- based on [Cloudflare development & testing docs](https://developers.cloudflare.com/workers/development-testing/). The gap between local and production has narrowed significantly but is not zero.

**Phase:** Phase 3 (CI/smoke testing).

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| wrangler.toml configuration | Pitfall 4: Old compat date silently limits features | Update to `>= 2025-09-23`, test incrementally |
| Import restructuring (lazy-load) | Pitfall 1: Wrangler re-inlines dynamic imports | Use `find_additional_modules` + `rules` or esbuild `external` |
| Import restructuring (lazy-load) | Pitfall 7: Dynamic import in hot path | Guard behind `isSubscriptionProvider()` + runtime flag |
| Adding nodejs_compat flag | Pitfall 2: Polyfill stubs give false confidence | Never rely on compat flag alone for excluded modules |
| Runtime guards | Pitfall 6: Breaking Node.js mode | Run `node --test` after every change |
| CI/smoke testing | Pitfall 3: Test runner hides compat issues | Add `wrangler dev` smoke test as separate CI step |
| CI/smoke testing | Pitfall 10: Local/prod divergence | Include `wrangler deploy --dry-run` in CI |
| Deployment | Pitfall 8: Config secret size limit | Validate config size before upload |

---

## Decision Point: Option B (Lazy-Load) vs Option C (Build-Time Exclusion)

The audit recommends Option B (lazy-load with `await import()`). The pitfall research reveals that Option B has a significant hidden complexity: Wrangler's bundling behavior (Pitfall 1) may erase the lazy-load boundary unless explicitly configured via `find_additional_modules`.

**If `find_additional_modules` + `rules` works cleanly** for this project's file structure, Option B remains the least-invasive choice.

**If it proves problematic** (e.g., rules don't match correctly, or the separate module files cause other issues), fall back to Option C (build-time exclusion via esbuild `--external` and stub files). Option C is more work upfront but produces a cleaner Worker bundle with zero Node.js module references.

Either way, **both options require Pitfall 1 mitigation** -- you cannot simply change `import` to `await import()` and expect it to work without configuring the bundler.

---

## Sources

- [Cloudflare Workers Node.js Compatibility Docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Cloudflare Workers Bundling Docs (find_additional_modules)](https://developers.cloudflare.com/workers/wrangler/bundling/)
- [Cloudflare Workers Compatibility Flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
- [Cloudflare Workers Compatibility Dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
- [Cloudflare Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Workers HTTP Module Docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)
- [Cloudflare Vitest Known Issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)
- [Cloudflare Development & Testing Docs](https://developers.cloudflare.com/workers/development-testing/)
- [Wrangler Issue #2672: Preserve Dynamic Imports](https://github.com/cloudflare/workers-sdk/issues/2672)
- [Workerd Issue #2372: TTFB Impact from Additional Modules](https://github.com/cloudflare/workerd/issues/2372)
- [Cloudflare Blog: More NPM Packages on Workers (unenv polyfills)](https://blog.cloudflare.com/more-npm-packages-on-cloudflare-workers-combining-polyfills-and-native-code/)
- [Cloudflare Blog: A Year of Node.js Compat Improvements](https://blog.cloudflare.com/nodejs-workers-2025/)
