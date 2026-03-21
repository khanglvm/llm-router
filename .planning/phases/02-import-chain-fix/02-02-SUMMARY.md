---
phase: 02-import-chain-fix
plan: 02
subsystem: runtime
tags: [cloudflare-worker, lazy-import, subscription-provider, state-store, defense-in-depth]

# Dependency graph
requires:
  - phase: 01-wrangler-configuration
    provides: "wrangler.toml with find_additional_modules and exclude rules for subscription modules"
provides:
  - "amp-web-search.js free of static subscription-provider.js import"
  - "runtimeFlags threading through hosted search call chain"
  - "Worker guard in executeHostedSearchProviderRequest with descriptive error"
  - "Defense-in-depth Worker guard in createStateStore for file backend"
  - "workerRuntime pass-through in resolveStateStoreOptions"
affects: [03-integration-verification]

# Tech tracking
tech-stack:
  added: []
  patterns: [lazy-import-with-guard, defense-in-depth-fallback, runtimeFlags-threading]

key-files:
  created: []
  modified:
    - src/runtime/handler/amp-web-search.js
    - src/runtime/state-store.js
    - src/runtime/handler/runtime-policy.js
    - src/runtime/state-store.test.js

key-decisions:
  - "Thread runtimeFlags as explicit parameter through 4 function levels rather than piggybacking on env object"
  - "Defense-in-depth guard in createStateStore returns memory store silently rather than throwing"

patterns-established:
  - "Lazy import pattern: guard with runtimeFlags check before dynamic import to prevent Worker crashes"
  - "Defense-in-depth fallback: createStateStore independently guards file backend for direct callers"

requirements-completed: [IMPT-03, HARD-01, HARD-02, IMPT-05]

# Metrics
duration: 13min
completed: 2026-03-21
---

# Phase 02 Plan 02: Import Chain Fix Summary

**Broke static import chain from amp-web-search.js to subscription-provider.js via inline check, lazy import with Worker guard, and hardened state-store.js file backend fallback**

## Performance

- **Duration:** 13 min
- **Started:** 2026-03-21T12:03:36Z
- **Completed:** 2026-03-21T12:17:11Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Eliminated static import of subscription-provider.js from amp-web-search.js, breaking the second tainted import chain that caused Worker crashes
- Threaded runtimeFlags through the full hosted search call chain (executeAmpWebSearch -> searchHostedProviderRoute -> runHostedSearchProviderQuery -> executeHostedSearchProviderRequest) so Worker mode throws a descriptive error before any lazy import executes
- Added defense-in-depth Worker guard in createStateStore that silently falls back to memory store when file backend is requested in Worker mode
- Added workerRuntime pass-through in resolveStateStoreOptions so createStateStore receives the runtime context
- Added 2 new tests validating the state-store Worker guard behavior

## Task Commits

Each task was committed atomically:

1. **Task 1: Refactor amp-web-search.js** - `8d27b82` (feat)
2. **Task 2: Harden state-store.js with Worker guard and tests** - `52b2dcc` (feat)

## Files Created/Modified
- `src/runtime/handler/amp-web-search.js` - Removed static subscription-provider import, inlined isSubscriptionProvider, threaded runtimeFlags, added Worker guard with lazy import
- `src/runtime/state-store.js` - Added workerRuntime guard returning memory store when file backend requested in Worker mode
- `src/runtime/handler/runtime-policy.js` - Added workerRuntime to resolveStateStoreOptions return value
- `src/runtime/state-store.test.js` - Added 2 new tests for createStateStore Worker guard behavior

## Decisions Made
- Threaded runtimeFlags as an explicit parameter through 4 private functions rather than piggybacking on the env object. This keeps env clean and makes the Worker context explicit at each call site.
- Defense-in-depth guard in createStateStore silently returns a memory store rather than throwing. This ensures graceful degradation for any direct caller that passes {backend: "file", workerRuntime: true}.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Both import chain fixes complete (02-01 for handler.js, 02-02 for amp-web-search.js)
- wrangler deploy --dry-run produces zero node:* warnings
- Ready for Phase 03 integration verification

## Self-Check: PASSED

- All 4 modified files exist on disk
- Commit 8d27b82 (Task 1) verified in git log
- Commit 52b2dcc (Task 2) verified in git log

---
*Phase: 02-import-chain-fix*
*Completed: 2026-03-21*
