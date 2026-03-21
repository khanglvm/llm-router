# Project Research Summary

**Project:** LLM Router — Cloudflare Worker Compatibility Fix
**Domain:** Node.js to Cloudflare Workers dual-runtime compatibility
**Researched:** 2026-03-21
**Confidence:** HIGH

## Executive Summary

The LLM Router project is a Node.js LLM proxy that already works as a Cloudflare Worker for its core routing, streaming, and format-translation functionality — but it currently crashes at Worker startup because two files in the shared `runtime/` layer statically import a subscription-provider module that chains into `node:http`, `node:child_process`, and `node:fs`. The fix is narrower than initially feared: two targeted code changes plus one configuration update are all that is required.

The recommended approach combines updating `wrangler.toml` with `compatibility_date = "2025-09-23"` and `compatibility_flags = ["nodejs_compat"]` (which makes all `node:*` static imports resolve without crashing via `unenv` polyfills), plus converting the two tainted static imports in `provider-call.js` and `amp-web-search.js` to lazy dynamic `await import()` calls guarded by a runtime check. This combination is belt-and-suspenders: the compat flag alone would likely work given that `workerSafeMode: true` prevents subscription code from ever executing, but the lazy-load adds defense-in-depth and keeps the Worker startup path clean. No new packages or build pipeline are needed.

The primary implementation risk is Wrangler's esbuild bundler silently inlining dynamic imports, which would collapse the lazy-load boundary and re-introduce the crash. This must be mitigated by configuring `find_additional_modules = true` with explicit `[[rules]]` in `wrangler.toml`, and verified with `wrangler deploy --dry-run` after every bundler-touching change. A secondary risk is over-relying on `nodejs_compat` polyfill stubs — they make imports succeed but throw at call time for unsupported methods, so explicit runtime guards (501 responses for subscription paths in Worker mode) are required in addition to the compat flag.

## Key Findings

### Recommended Stack

No new packages are required. The fix is entirely configuration and code changes to existing files. Wrangler 4.68.1 (already installed) handles everything. The critical configuration change is advancing `compatibility_date` from `"2024-01-01"` to `"2025-09-23"` — this unlocks `nodejs_compat_v2` auto-behavior, `node:http` server/client support, and `node:fs` virtual filesystem support, all gated behind `2025-09-01`. The `nodejs_compat` umbrella flag is Cloudflare's recommended single-flag approach and is preferable to configuring individual sub-flags.

**Core technologies:**
- `nodejs_compat` compatibility flag: Enables `unenv` polyfill layer for all `node:*` modules — without this, static imports crash at load time
- `compatibility_date = "2025-09-23"`: Unlocks all Node.js compat improvements from 2025; the current `"2024-01-01"` silently limits available APIs
- `find_additional_modules = true` + `[[rules]]`: Prevents Wrangler's esbuild from inlining dynamic imports back into the main bundle — required for lazy-load to actually work
- `wrangler dev` smoke test: Starts Worker runtime, sends `/health` request, asserts 200 — the only reliable way to catch compat flag omissions that unit tests miss

### Expected Features

The Worker mode already supports all core functionality. The fix enables one thing: Worker startup without crashing.

**Must have (table stakes):**
- Worker starts without module-load crash — currently broken; fix: `nodejs_compat` flag + compat date update
- Node.js local mode unbroken — the lazy-import refactor must be transparent to existing Node.js callers; all existing `node --test` tests must continue to pass

**Should have (low effort, high value):**
- `wrangler dev` CI smoke test — catches Worker-breaking regressions automatically; shell script, one-time setup
- Clean 501 error for subscription providers in Worker mode — better DX than a cryptic crash; requires runtime guard in `makeProviderCall`

**Defer (out of scope for this fix):**
- Durable Objects for cross-request state persistence — different architecture, different pricing tier
- Vitest Worker integration tests — overkill; `wrangler dev` smoke test is sufficient
- Build-time module exclusion pipeline — adds build step complexity; `nodejs_compat` + lazy imports solve the problem without it

### Architecture Approach

The fix requires surgical changes to two files only. The subscription modules themselves (`subscription-provider.js`, `subscription-auth.js`, `subscription-tokens.js`) are Node-only and stay unchanged. The only problem is that `provider-call.js` and `amp-web-search.js` sit in the universal `runtime/handler/` layer but statically import Node-only modules. Making those imports lazy, guarded by an inlined `isSubscriptionProvider()` check (a one-liner: `provider?.type === 'subscription'`), breaks the tainted import chain. The existing pattern in `state-store.js` using `await import('./state-store.file.js')` inside a conditional is the direct precedent to follow.

**Major components:**
1. `wrangler.toml` — configuration fix; `compatibility_date` and `nodejs_compat` flag; `find_additional_modules` + rules for subscription modules
2. `src/runtime/handler/provider-call.js` — inline `isSubscriptionProvider()`, convert to lazy `await import()` for `makeSubscriptionProviderCall`, add Worker runtime guard returning 501
3. `src/runtime/handler/amp-web-search.js` — same pattern as `provider-call.js` for its subscription import
4. CI smoke test script — `wrangler dev` start, health check, assert 200, kill; separate `test:worker` npm script

### Critical Pitfalls

1. **Wrangler inlines dynamic imports, defeating lazy-load** — Wrangler's esbuild resolves `await import()` at build time and collapses it into the main bundle, re-introducing Node.js modules at load time. Mitigation: add `find_additional_modules = true` and explicit `[[rules]]` for the subscription module files in `wrangler.toml`. Verify with `wrangler deploy --dry-run` — if output still warns about `node:http` or `node:child_process`, the boundary was erased.

2. **`nodejs_compat` polyfill stubs give false confidence** — `node:child_process` and parts of `node:fs` import successfully via `unenv` stubs but throw at runtime when their methods are called. Import success does not mean the code is safe. Mitigation: add explicit runtime guards (`if (runtimeFlags.workerRuntime) return 501`) before any code path reaching stubbed methods; test those paths in smoke tests, not just module loading.

3. **Test runner hides missing compat flags** — The existing `node --test` suite runs under Node.js and cannot catch Worker compat flag omissions. Mitigation: add a separate `test:worker` npm script using `wrangler dev` that actually starts the Workers runtime and sends a real request.

4. **Old compatibility date silently limits Node.js API support** — The current `"2024-01-01"` predates all 2025 Node.js compat improvements. `node:http` and `node:fs` require `>= 2025-09-01`. Mitigation: update to `"2025-09-23"` first — everything else depends on this.

5. **Breaking Node.js mode while fixing Worker mode** — Changes to shared `src/runtime/` code affect both runtime paths. Making `import` async changes call-site semantics. Mitigation: run `node --test` after every change before testing Worker mode; keep subscription modules themselves untouched; only modify the import statements in the two tainted files.

## Implications for Roadmap

Based on research, the fix maps cleanly to three sequential phases with no file conflicts between phases.

### Phase 1: Wrangler Configuration Update
**Rationale:** All other changes depend on the compat flag and date being correct. This is the unblocking change that makes `node:*` static imports resolve and that configures the bundler to preserve dynamic import boundaries. Nothing else can be tested until the Worker starts.
**Delivers:** Updated `wrangler.toml` with `compatibility_date = "2025-09-23"`, `compatibility_flags = ["nodejs_compat"]`, `find_additional_modules = true`, and `[[rules]]` for subscription module files.
**Addresses:** Table-stakes "Worker starts without crash" feature.
**Avoids:** Pitfall 4 (stale date silently limits APIs); Pitfall 1 (bundler inlining — `find_additional_modules` is configured here so Phase 2 lazy-loads bundle correctly from the start).

### Phase 2: Import Restructuring (Defense-in-Depth)
**Rationale:** With Phase 1 in place, the Worker technically starts. Phase 2 adds defense-in-depth by converting the two tainted static imports to lazy dynamic imports with runtime guards. This prevents subscription code from ever loading in Worker mode, reduces effective bundle complexity, and provides clean 501 errors if a subscription provider is misconfigured.
**Delivers:** Modified `provider-call.js` and `amp-web-search.js` with inlined `isSubscriptionProvider()`, lazy `await import()` for `makeSubscriptionProviderCall`, and Worker runtime 501 guard.
**Uses:** Pattern already present in `state-store.js` (conditional dynamic import factory).
**Avoids:** Pitfall 2 (polyfill stubs give false confidence), Pitfall 6 (breaking Node.js mode — `node --test` must pass), Pitfall 7 (dynamic import in hot path — guard ensures module never loads for non-subscription requests).

### Phase 3: CI Smoke Test and Verification
**Rationale:** Unit tests cannot catch compat flag issues. A `wrangler dev` smoke test is the only reliable regression gate. This phase adds the test and validates the complete fix end-to-end including `--dry-run` deployment check.
**Delivers:** `test:worker` npm script; `wrangler deploy --dry-run` step; smoke test that starts Worker, hits `/health`, asserts 200; confirmation that existing `node --test` suite still passes.
**Avoids:** Pitfall 3 (test runner hides compat issues), Pitfall 10 (`wrangler dev` vs production divergence — `--dry-run` closes this gap).

### Phase Ordering Rationale

- Configuration must precede code changes because `find_additional_modules` in Phase 1 is what makes the Phase 2 lazy-load refactor bundle correctly; configuring it afterward would require re-verifying the bundler behavior.
- Import restructuring should precede CI setup so that smoke tests validate the final defended architecture, not a transitional `nodejs_compat`-only state.
- All three phases touch distinct files: Phase 1 is `wrangler.toml` only; Phase 2 is two `src/runtime/handler/` files only; Phase 3 adds a new test script. Zero file conflicts.

### Research Flags

Phases with standard patterns (no additional research needed):
- **Phase 1:** Well-documented configuration change; all values confirmed in research with HIGH confidence from official Cloudflare docs.
- **Phase 2:** Lazy dynamic import is standard ES module behavior; existing precedent in `state-store.js` in this codebase; no unknowns.
- **Phase 3:** `wrangler dev` smoke test is a documented Cloudflare pattern; straightforward shell script implementation.

No phases require deeper research. All technical questions were resolved during this research cycle.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All changes to existing tools already in the project; Cloudflare docs are definitive; no new dependencies needed |
| Features | HIGH | Feature scope is minimal and well-defined; anti-features clearly documented; nothing ambiguous |
| Architecture | HIGH | Change surface is 3 files; existing pattern in `state-store.js` is direct precedent; both Worker and Node.js data flow paths fully analyzed |
| Pitfalls | HIGH | All pitfalls verified against official Cloudflare docs and GitHub issues; Wrangler bundling behavior (Pitfall 1) confirmed via bundling docs and issue tracker |

**Overall confidence:** HIGH

### Gaps to Address

- **Bundler behavior verification in practice:** `find_additional_modules` + `[[rules]]` is documented but not yet tested against this specific project structure. After Phase 1 configuration, run `wrangler deploy --dry-run` to confirm rules match the correct files. If rules do not match, fall back to esbuild `external` + stub files approach (Option C from audit).
- **`node:child_process` stub behavior at target compat date:** Research confirms stubs are available at `2025-09-23`, but the exact stub API surface for this date should be verified with `wrangler dev`. Low risk since `workerSafeMode` prevents invocation.
- **Config secret size limit (32 KB):** The current `LLM_ROUTER_CONFIG_JSON` secret size should be validated during any deployment test. Not blocking for the import fix but worth checking during Phase 3 verification.
- **`wrangler dev` in CI without Cloudflare API token:** The smoke test runs `wrangler dev --local`; verify it does not require a Cloudflare API token in the GitHub Actions runner environment.

## Sources

### Primary (HIGH confidence)
- [Cloudflare Workers Node.js Compatibility Docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) — Module support matrix, `node:child_process` stub behavior
- [Cloudflare Workers Compatibility Flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) — `nodejs_compat`, `nodejs_compat_v2`, date-gated flag behavior
- [Cloudflare Workers node:http Docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/) — `createServer` support, `>= 2025-09-01` requirement
- [Cloudflare Workers node:fs Docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/) — Virtual FS, `/tmp`, `>= 2025-09-01` requirement
- [Cloudflare Workers Bundling Docs](https://developers.cloudflare.com/workers/wrangler/bundling/) — `find_additional_modules`, dynamic import preservation
- [Cloudflare Workers Compatibility Dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/) — Date-gated behavior, upgrade path
- [Wrangler v4 Migration Docs](https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/) — `node_compat` deprecation, `nodejs_compat` replacement
- [Cloudflare Vitest Known Issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/) — Test runner auto-injects compat flags (Pitfall 3)

### Secondary (MEDIUM confidence)
- [Cloudflare Blog: A Year of Node.js Compatibility in Workers (2025)](https://blog.cloudflare.com/nodejs-workers-2025/) — 2025 compat improvements overview
- [Cloudflare Blog: More NPM Packages on Workers (unenv polyfills)](https://blog.cloudflare.com/more-npm-packages-on-cloudflare-workers-combining-polyfills-and-native-code/) — `unenv` stub behavior and limitations
- [Wrangler Issue #2672](https://github.com/cloudflare/workers-sdk/issues/2672) — Dynamic import preservation behavior in bundler
- [Workerd Issue #2372](https://github.com/cloudflare/workerd/issues/2372) — TTFB impact from additional modules

### Project Sources
- `plans/reports/cloudflare-worker-compatibility-audit.md` — Original audit that identified the tainted import chain
- `src/runtime/state-store.js` — Direct precedent for conditional dynamic import pattern

---
*Research completed: 2026-03-21*
*Ready for roadmap: yes*
