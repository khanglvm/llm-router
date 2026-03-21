# Requirements: LLM Router — Cloudflare Worker Compatibility Fix

**Defined:** 2026-03-21
**Core Value:** Cloudflare Worker deployment must start and handle requests without runtime errors

## v1 Requirements

Requirements for this fix initiative. Each maps to roadmap phases.

### Configuration

- [x] **CONF-01**: Worker starts without module-load crash after updating `compatibility_date` to `"2025-09-23"`
- [x] **CONF-02**: All `node:*` static imports resolve via `nodejs_compat` compatibility flag
- [x] **CONF-03**: Wrangler bundler preserves dynamic import boundaries via `find_additional_modules` and `[[rules]]` config

### Import Restructuring

- [x] **IMPT-01**: `isSubscriptionProvider()` check is inlined or extracted to a side-effect-free module with zero Node.js imports
- [x] **IMPT-02**: `provider-call.js` uses lazy `await import()` for subscription-provider module instead of static import
- [ ] **IMPT-03**: `amp-web-search.js` uses lazy `await import()` for subscription-provider module instead of static import
- [x] **IMPT-04**: Worker returns clean 501 error when a subscription provider is encountered in Worker mode
- [x] **IMPT-05**: Node.js local mode continues to work identically — all existing tests pass

### Hardening

- [ ] **HARD-01**: `state-store.js` has explicit Worker guard on its dynamic file-store import
- [ ] **HARD-02**: `wrangler deploy --dry-run` produces zero `node:*` warnings after all fixes applied

### Verification

- [ ] **VERF-01**: `wrangler dev` smoke test script starts Worker, sends health check request, asserts 200 response
- [ ] **VERF-02**: `test:worker` npm script added for CI integration
- [ ] **VERF-03**: Existing `node --test` suite passes with no regressions

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### State Persistence

- **STAT-01**: Worker mode uses Durable Objects or KV for cross-request state persistence (round-robin, rate limits)

### Testing

- **TEST-01**: Vitest Cloudflare pool integration tests for Worker-specific code paths
- **TEST-02**: Automated config secret size (32 KB) validation during deploy

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Subscription provider OAuth in Workers | Requires `node:child_process` `spawn()` which is non-functional stub in Workers |
| File-based state store in Workers | `node:fs` virtual FS has no cross-request persistence |
| File-based activity log in Workers | Node-only, already properly isolated in `src/node/` |
| Web Console UI in Workers | Node-only, already properly isolated in `src/node/` |
| Stateful round-robin in Workers | Global `Map` doesn't persist across Worker requests; `workerSafeMode` disables correctly |
| Build-time module exclusion pipeline | `nodejs_compat` + lazy imports solve the problem without build changes |
| Custom worker-stub module | Dynamic `await import()` is simpler and zero-maintenance |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CONF-01 | Phase 1 | Complete |
| CONF-02 | Phase 1 | Complete |
| CONF-03 | Phase 1 | Complete |
| IMPT-01 | Phase 2 | Complete |
| IMPT-02 | Phase 2 | Complete |
| IMPT-03 | Phase 2 | Pending |
| IMPT-04 | Phase 2 | Complete |
| IMPT-05 | Phase 2 | Complete |
| HARD-01 | Phase 2 | Pending |
| HARD-02 | Phase 2 | Pending |
| VERF-01 | Phase 3 | Pending |
| VERF-02 | Phase 3 | Pending |
| VERF-03 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 13 total
- Mapped to phases: 13
- Unmapped: 0

---
*Requirements defined: 2026-03-21*
*Last updated: 2026-03-21 after roadmap creation*
