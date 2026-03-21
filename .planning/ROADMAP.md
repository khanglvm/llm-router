# Roadmap: LLM Router — Cloudflare Worker Compatibility Fix

## Overview

Fix the Cloudflare Worker runtime crash caused by static imports of Node.js-only modules in the shared runtime layer. Three sequential phases: configure the Workers runtime to resolve `node:*` imports, restructure the two tainted import chains to use lazy dynamic imports with runtime guards, then add CI smoke tests to prevent regression. Each phase touches distinct files with zero overlap.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Wrangler Configuration** - Update compatibility date, flags, and bundler settings so Worker starts without module-load crash
- [ ] **Phase 2: Import Chain Fix** - Convert tainted static imports to lazy dynamic imports with runtime guards and harden remaining edge cases
- [ ] **Phase 3: CI Verification** - Add wrangler dev smoke test and npm script to catch Worker-breaking regressions in CI

## Phase Details

### Phase 1: Wrangler Configuration
**Goal**: Worker process starts and responds to requests without crashing at module load time
**Depends on**: Nothing (first phase)
**Requirements**: CONF-01, CONF-02, CONF-03
**Success Criteria** (what must be TRUE):
  1. Running `wrangler dev` starts the Worker without any module-resolution errors in the console
  2. All `node:*` static imports (including `node:http`, `node:crypto`, `node:path`, `node:os`) resolve without crash via `nodejs_compat` polyfills
  3. `wrangler deploy --dry-run` completes without bundler errors and respects dynamic import boundaries (subscription modules listed as additional modules, not inlined)
**Plans**: TBD

Plans:
- [ ] 01-01: TBD

### Phase 2: Import Chain Fix
**Goal**: Subscription-provider code never loads in Worker mode; Node.js local mode continues working identically
**Depends on**: Phase 1
**Requirements**: IMPT-01, IMPT-02, IMPT-03, IMPT-04, IMPT-05, HARD-01, HARD-02
**Success Criteria** (what must be TRUE):
  1. `provider-call.js` and `amp-web-search.js` use `await import()` for subscription-provider module -- the module is never loaded unless a subscription provider is actually encountered
  2. When a subscription provider is encountered in Worker mode, the Worker returns a clean 501 response with a descriptive error message instead of crashing
  3. `state-store.js` has an explicit Worker guard that prevents its file-store dynamic import from executing in Worker context
  4. All existing `node --test` tests pass with zero regressions after the import restructuring
  5. `wrangler deploy --dry-run` produces zero `node:*` warnings
**Plans**: TBD

Plans:
- [ ] 02-01: TBD

### Phase 3: CI Verification
**Goal**: Worker compatibility is continuously validated -- regressions are caught automatically before merge
**Depends on**: Phase 2
**Requirements**: VERF-01, VERF-02, VERF-03
**Success Criteria** (what must be TRUE):
  1. Running `npm run test:worker` starts a Worker via `wrangler dev`, sends a health check request, and asserts a 200 response
  2. The smoke test script exits cleanly (kills the wrangler process) and returns a non-zero exit code on failure
  3. Existing `node --test` suite passes alongside the new worker test with no interference between the two
**Plans**: TBD

Plans:
- [ ] 03-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Wrangler Configuration | 0/0 | Not started | - |
| 2. Import Chain Fix | 0/0 | Not started | - |
| 3. CI Verification | 0/0 | Not started | - |
