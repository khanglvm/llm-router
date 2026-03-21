---
phase: 3
slug: ci-verification
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-21
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in test runner + custom smoke script |
| **Config file** | None |
| **Quick run command** | `node scripts/test-worker.mjs` |
| **Full suite command** | `node scripts/test-worker.mjs && node --test src/runtime/*.test.js` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** `node scripts/test-worker.mjs`
- **After every plan wave:** `node scripts/test-worker.mjs && node --test src/runtime/*.test.js`
- **Before `/gsd:verify-work`:** Full suite green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | VERF-01 | smoke | `node scripts/test-worker.mjs` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | VERF-02 | smoke | `npm run test:worker` | ❌ W0 | ⬜ pending |
| 03-01-03 | 01 | 1 | VERF-03 | unit | `node --test src/runtime/*.test.js` | ✅ | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `scripts/test-worker.mjs` — wrangler dev smoke test script (covers VERF-01)
- [ ] `package.json` `test:worker` script entry (covers VERF-02)

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
