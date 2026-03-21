---
phase: 02-import-chain-fix
plan: 01
subsystem: runtime
tags: [cloudflare-workers, dynamic-import, subscription-provider, lazy-loading]

# Dependency graph
requires:
  - phase: 01-wrangler-configuration
    provides: Wrangler config with find_additional_modules and subscription module exclusion rules
provides:
  - Inline isSubscriptionProvider check in provider-call.js (no static import of subscription-provider.js)
  - Worker 501 guard for subscription providers with not_supported_error
  - Lazy dynamic import of makeSubscriptionProviderCall for Node.js mode
  - runtimeFlags threading from handler.js into makeProviderCall
affects: [02-import-chain-fix]

# Tech tracking
tech-stack:
  added: []
  patterns: [lazy-dynamic-import, worker-runtime-guard, inline-type-check]

key-files:
  created: []
  modified:
    - src/runtime/handler/provider-call.js
    - src/runtime/handler.js
    - src/runtime/handler.subscription.test.js

key-decisions:
  - "Inlined isSubscriptionProvider as a private function rather than re-exporting from subscription-provider.js to avoid any static import chain"
  - "Worker 501 guard placed before lazy import so subscription-provider.js is never loaded in Worker mode"

patterns-established:
  - "Worker runtime guard: check runtimeFlags.workerRuntime before loading Node.js-only modules"
  - "Lazy dynamic import: use await import() inside guarded blocks for heavy Node.js-only dependencies"

requirements-completed: [IMPT-01, IMPT-02, IMPT-04, IMPT-05]

# Metrics
duration: 2min
completed: 2026-03-21
---

# Phase 02 Plan 01: Import Chain Fix Summary

**Break static import chain from provider-call.js to subscription-provider.js with inline type check, Worker 501 guard, and lazy dynamic import**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-21T12:03:29Z
- **Completed:** 2026-03-21T12:05:51Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Eliminated the static import of subscription-provider.js from provider-call.js that caused Worker crashes at module load time
- Added Worker 501 guard returning clean not_supported_error before any subscription module is loaded
- Converted makeSubscriptionProviderCall to lazy dynamic import for Node.js mode
- Threaded runtimeFlags from handler.js into makeProviderCall for runtime mode detection
- Added test validating Worker 501 behavior with zero regressions across 28 tests

## Task Commits

Each task was committed atomically:

1. **Task 1: Refactor provider-call.js -- inline check, Worker guard, lazy import** - `11cb473` (feat)
2. **Task 2: Add Worker 501 guard test for subscription providers** - `d7ce44f` (test)

## Files Created/Modified
- `src/runtime/handler/provider-call.js` - Removed static import, added inline isSubscriptionProvider, Worker 501 guard, lazy dynamic import
- `src/runtime/handler.js` - Added runtimeFlags to makeProviderCall call site
- `src/runtime/handler.subscription.test.js` - Added Worker 501 guard test case

## Decisions Made
- Inlined isSubscriptionProvider as a private function rather than re-exporting -- avoids any static import chain whatsoever
- Worker 501 guard placed before the lazy import so subscription-provider.js is never loaded in Worker mode

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Static import chain is broken; provider-call.js no longer pulls in subscription-provider.js at module load
- Ready for 02-02 plan to handle remaining import chain issues (if any)
- All 28 tests pass across provider-call, subscription, amp-web-search, and state-store suites

## Self-Check: PASSED

All files exist. All commit hashes verified.

---
*Phase: 02-import-chain-fix*
*Completed: 2026-03-21*
