# Phase 3: CI Verification - Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Add a `wrangler dev` smoke test script and `test:worker` npm script that validates the Worker starts and handles requests. Verify existing `node --test` suite passes alongside the new test. This is a testing/CI phase — no production code changes.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Key constraints:

- Smoke test should: start `wrangler dev`, wait for ready, send health check request, assert 200 response, kill process
- Script must exit cleanly (kill wrangler process) and return non-zero on failure
- `test:worker` npm script added to `package.json`
- Existing `node --test` suite must pass alongside new worker test with no interference
- `wrangler dev --local` may be needed for CI environments without Cloudflare API token

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Package configuration
- `package.json` — Current scripts section, add `test:worker`

### Verification from prior phases
- `.planning/phases/01-wrangler-configuration/01-VERIFICATION.md` — Phase 1 verification showing dry-run works
- `.planning/phases/02-import-chain-fix/02-VERIFICATION.md` — Phase 2 verification showing zero warnings

### Research
- `.planning/research/SUMMARY.md` — Recommended smoke test approach
- `.planning/research/PITFALLS.md` — Pitfall 3 (test runner hides compat issues), Pitfall 10 (wrangler dev vs production divergence)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `package.json` has existing test scripts that can be referenced for conventions

### Established Patterns
- Project uses `node --test` for unit tests (no jest/vitest)
- Shell scripts likely preferred for smoke tests (simple start/check/kill pattern)

### Integration Points
- `package.json` scripts section — add `test:worker` alongside existing scripts
- CI pipeline (if exists) — new script should be runnable in CI

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase. Follow standard smoke test patterns.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-ci-verification*
*Context gathered: 2026-03-21*
