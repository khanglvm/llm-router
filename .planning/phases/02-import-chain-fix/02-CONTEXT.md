# Phase 2: Import Chain Fix - Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Convert the two tainted static imports of `subscription-provider.js` in `provider-call.js` and `amp-web-search.js` to lazy dynamic `await import()` calls guarded by runtime checks. Harden `state-store.js` with explicit Worker guard. Ensure Node.js local mode continues working identically. This is a code-only phase — no configuration changes.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Key constraints from research and prior phases:

- Follow the existing `state-store.js:68` pattern: `const { fn } = await import("./module.js")` inside a conditional
- `isSubscriptionProvider()` is a one-liner (`provider?.type === 'subscription'`) — can be inlined or extracted to a side-effect-free module
- Worker runtime detection via `runtimeFlags.workerRuntime` from `runtime-policy.js`
- Return 501 with descriptive error when subscription provider encountered in Worker mode
- `wrangler deploy --dry-run` must produce zero `node:*` warnings after changes
- All existing `node --test` tests must pass with zero regressions

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Import chain (files to modify)
- `src/runtime/handler/provider-call.js` — Static import at line 27, usage at lines 562, 626, 634
- `src/runtime/handler/amp-web-search.js` — Static import at line 12, usage at lines 2093, 2095
- `src/runtime/state-store.js` — Existing dynamic import pattern at line 68 (precedent)

### Runtime detection
- `src/runtime/handler/runtime-policy.js` — `workerRuntime` flag derivation at line 14

### Subscription module (do NOT modify)
- `src/runtime/subscription-provider.js` — `isSubscriptionProvider()` at line 35, `makeSubscriptionProviderCall()` at line 88

### Research and audit
- `.planning/research/ARCHITECTURE.md` — Import chain analysis and implementation order
- `.planning/research/PITFALLS.md` — Bundler inlining risk (Pitfall 1), polyfill stub behavior (Pitfall 2)
- `plans/reports/cloudflare-worker-compatibility-audit.md` — Original audit with Option B recommendation

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `state-store.js:68`: `const { createFileStateStore } = await import("./state-store.file.js")` — exact pattern to follow for lazy imports
- `runtime-policy.js:14-28`: `workerRuntime` flag already available in `runtimeFlags` object — no new detection needed

### Established Patterns
- `isSubscriptionProvider()` is used as a guard before `makeSubscriptionProviderCall()` in both files
- Subscription calls are always inside an `if (isSubscriptionProvider(provider))` block
- `runtimeFlags` is passed through the handler chain and available where imports are used

### Integration Points
- `provider-call.js:626`: subscription path entry point — guard here
- `amp-web-search.js:2093`: subscription path entry point — guard here
- `state-store.js:68`: existing dynamic import — add Worker guard wrapper

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase. Follow the existing `state-store.js` dynamic import pattern.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-import-chain-fix*
*Context gathered: 2026-03-21*
