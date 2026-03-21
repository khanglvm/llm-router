---
phase: 2
slug: import-chain-fix
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-21
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in test runner (node:test) v22.x |
| **Config file** | None (uses node:test defaults) |
| **Quick run command** | `node --test src/runtime/handler.provider-call.test.js src/runtime/handler.subscription.test.js src/runtime/handler.amp-web-search.test.js src/runtime/state-store.test.js` |
| **Full suite command** | `node --test src/runtime/*.test.js src/node/*.test.js src/translator/**/*.test.js src/cli*.test.js` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick run command (4 relevant test files)
- **After every plan wave:** Run full suite + `wrangler deploy --dry-run`
- **Before `/gsd:verify-work`:** Full suite must be green + zero dry-run warnings
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | IMPT-01 | unit | `node --test src/runtime/handler.subscription.test.js` | ✅ | ⬜ pending |
| 02-01-02 | 01 | 1 | IMPT-02 | unit | `node --test src/runtime/handler.provider-call.test.js` | ✅ | ⬜ pending |
| 02-01-03 | 01 | 1 | IMPT-03 | unit | `node --test src/runtime/handler.amp-web-search.test.js` | ✅ | ⬜ pending |
| 02-01-04 | 01 | 1 | IMPT-04 | unit | `node --test src/runtime/handler.provider-call.test.js` | ❌ W0 | ⬜ pending |
| 02-01-05 | 01 | 1 | IMPT-05 | unit | quick run command (all 4 files) | ✅ | ⬜ pending |
| 02-01-06 | 01 | 1 | HARD-01 | unit | `node --test src/runtime/state-store.test.js` | ❌ W0 | ⬜ pending |
| 02-01-07 | 01 | 1 | HARD-02 | smoke | `wrangler deploy --dry-run 2>&1 \| grep -c "node:"` | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Test case in `handler.provider-call.test.js` or `handler.subscription.test.js`: subscription provider + workerRuntime flag returns 501 (covers IMPT-04)
- [ ] Test case in `state-store.test.js`: createStateStore with `backend: "file"` + `workerRuntime: true` returns memory store (covers HARD-01)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Zero node:* warnings in dry-run | HARD-02 | CLI output check | Run `npx wrangler deploy --dry-run 2>&1 \| grep "node:"` — expect no matches |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
