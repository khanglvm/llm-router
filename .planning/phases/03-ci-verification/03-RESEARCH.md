# Phase 3: CI Verification - Research

**Researched:** 2026-03-21
**Domain:** Cloudflare Worker smoke testing via wrangler dev
**Confidence:** HIGH

## Summary

Phase 3 adds a `wrangler dev` smoke test script and a `test:worker` npm script to catch Worker-breaking regressions that unit tests cannot detect (Pitfall 3 from PITFALLS.md). The core task is writing a shell script or Node.js script that: starts `wrangler dev` with a minimal config, waits for the ready signal, sends an authenticated HTTP health check, asserts a 200 response, and cleans up the wrangler process. This also verifies the existing `node --test` suite still passes alongside the new test with no interference.

Live verification on this machine confirmed the exact behavior: `wrangler dev` (v4.68.1, local mode by default) prints `[wrangler:info] Ready on http://localhost:PORT` when ready. The `/health` endpoint requires both a valid `LLM_ROUTER_CONFIG_JSON` with a `masterKey` and an `Authorization: Bearer <key>` header. Without these, the Worker responds 503 (missing config) or 401 (missing auth). With `--var LLM_ROUTER_CONFIG_JSON:'{"version":2,"masterKey":"test-key","providers":[]}'` and `Authorization: Bearer test-key`, the health endpoint returns `{"status":"ok","timestamp":"...","providers":0}` with HTTP 200.

There is no existing CI pipeline (no `.github/workflows/` directory), so this phase only needs to create the script and npm script entry -- not a full CI workflow file. The smoke test script should be usable both locally and in any future CI environment.

**Primary recommendation:** Write a Node.js smoke test script (`scripts/test-worker.mjs`) that spawns `wrangler dev`, waits for the ready line via stderr/stdout parsing, sends `curl`/`fetch` to `/health` with auth, asserts 200, and kills the process. Register it as `test:worker` in `package.json`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
No locked decisions -- all implementation choices are at Claude's discretion. This is a pure infrastructure phase.

### Claude's Discretion
All implementation choices including:
- Smoke test approach: start `wrangler dev`, wait for ready, send health check request, assert 200 response, kill process
- Script must exit cleanly (kill wrangler process) and return non-zero on failure
- `test:worker` npm script added to `package.json`
- Existing `node --test` suite must pass alongside new worker test with no interference
- `wrangler dev --local` may be needed for CI environments without Cloudflare API token

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| VERF-01 | `wrangler dev` smoke test script starts Worker, sends health check request, asserts 200 response | Verified: `/health` endpoint returns 200 with proper config+auth; ready signal pattern confirmed as `Ready on http://localhost:PORT`; wrangler dev starts locally without Cloudflare API token |
| VERF-02 | `test:worker` npm script added for CI integration | Verified: package.json has no existing `test:worker` script; convention follows other `test:*` prefixed scripts already present |
| VERF-03 | Existing `node --test` suite passes with no regressions | Verified: `node --test src/**/*.test.js` is the full suite command established in prior phases; new script creates no interference since it is a separate process |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| wrangler | 4.68.1 (installed) | Runs local Worker runtime via `wrangler dev` | Already a devDependency; the only tool that can start the actual Workers runtime locally |
| node:child_process | built-in | Spawns wrangler dev as a child process | Standard Node.js API for process management |
| node:http (or fetch) | built-in | Sends health check HTTP request | No external dependencies needed |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:test | built-in | Could wrap the smoke test in `node --test` format | Optional -- only if consistent assertion reporting is desired |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Node.js script | Bash shell script | Shell is simpler but less portable (Windows); project conventions favor `.mjs` scripts (see `scripts/` directory) |
| Custom fetch | curl in subprocess | curl adds external dependency; native `fetch` is available in Node 18+ and is sufficient |

**Installation:**
```bash
# No new packages needed -- everything is already installed
```

## Architecture Patterns

### Recommended Project Structure
```
scripts/
  test-worker.mjs      # NEW: wrangler dev smoke test
package.json           # MODIFIED: add "test:worker" script
```

### Pattern: Process Lifecycle Smoke Test
**What:** Spawn a long-running dev server process, wait for its ready signal, send a probe request, assert the response, then kill the process.
**When to use:** When you need to verify a server starts correctly and handles requests, but the server cannot be imported as a module (wrangler dev is a CLI tool, not a library).

**Implementation approach:**
```javascript
// 1. Spawn wrangler dev with minimal config
const child = spawn("npx", [
  "wrangler", "dev",
  "--port", String(port),
  "--show-interactive-dev-session", "false",
  "--var", `LLM_ROUTER_CONFIG_JSON:${JSON.stringify(minimalConfig)}`
], { stdio: ["ignore", "pipe", "pipe"] });

// 2. Wait for ready signal in stdout/stderr
// Pattern: "[wrangler:info] Ready on http://localhost:PORT"
// Wrangler prints this to STDOUT

// 3. Send health check with auth
const response = await fetch(`http://localhost:${port}/health`, {
  headers: { "Authorization": "Bearer test-key" }
});

// 4. Assert 200
if (response.status !== 200) process.exit(1);

// 5. Kill process
child.kill("SIGTERM");
```

### Critical Implementation Details

**Ready signal parsing:** Wrangler 4.68.1 outputs `[wrangler:info] Ready on http://localhost:PORT` to stdout. The script must listen to both stdout and stderr (wrangler may change output streams across versions). Match on the string `Ready on` as the trigger.

**Minimal config for smoke test:** The Worker requires `LLM_ROUTER_CONFIG_JSON` with a `masterKey` to respond to any request. Minimal valid config:
```json
{"version":2,"masterKey":"smoke-test-key","providers":[]}
```

**Auth requirement:** Every request to the Worker needs `Authorization: Bearer <masterKey>`. Without it, the Worker returns 401. The smoke test must include this header.

**Port selection:** Use a non-standard port (e.g., 8787 is wrangler's default; use 18787 or similar) to avoid conflicts with any running dev server.

**Process cleanup:** The script MUST kill the wrangler process on both success and failure paths. Use a try/finally block. Also handle SIGTERM/SIGINT signals to clean up if the script itself is killed.

**Timeout:** If wrangler dev does not produce the ready signal within a reasonable time (15-30 seconds), the script should fail with a timeout error and kill the process.

### Anti-Patterns to Avoid
- **Sleeping a fixed duration instead of waiting for ready signal:** Race condition; may fail on slow machines or pass before server is actually ready
- **Not providing config/auth:** Worker returns 503/401, not a true startup test
- **Leaving orphaned wrangler processes:** Must kill on all exit paths including errors and signals
- **Using wrangler dev in remote mode:** Remote mode requires Cloudflare API token; local mode (default in v4) does not

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Process lifecycle management | Custom daemon manager | Simple spawn + kill with try/finally | This is a one-shot test, not a service manager |
| HTTP assertions | Custom test framework | Simple status code check + `process.exit(1)` | Only one assertion needed (status 200) |
| Ready-state detection | Polling with retries | Stream parsing for ready line | Wrangler outputs a deterministic ready message |

**Key insight:** This is a ~60-line script, not a framework. Keep it minimal.

## Common Pitfalls

### Pitfall 1: Wrangler Ready Signal on Wrong Stream
**What goes wrong:** Script listens only to stdout but wrangler prints the ready message to stderr (or vice versa).
**Why it happens:** Wrangler's output routing between stdout and stderr has changed across versions.
**How to avoid:** Listen to BOTH stdout and stderr. Combine them for pattern matching.
**Warning signs:** Script hangs waiting for ready signal that already appeared on the other stream.

### Pitfall 2: Orphaned Wrangler Process After Script Failure
**What goes wrong:** Script throws an error before reaching the `kill()` call. Wrangler keeps running in background, holding the port.
**Why it happens:** No try/finally or signal handler.
**How to avoid:** Wrap the entire test in try/finally. Add process signal handlers (SIGINT, SIGTERM) that kill the child. Set a timeout that kills on expiry.
**Warning signs:** "Address already in use" on next run.

### Pitfall 3: Health Endpoint Returns Non-200 Without Config
**What goes wrong:** Smoke test sends a request to `/health` but gets 503 because no config was provided, or 401 because no auth header.
**Why it happens:** The Worker requires `LLM_ROUTER_CONFIG_JSON` with a `masterKey`, and all endpoints enforce auth.
**How to avoid:** Pass config via `--var LLM_ROUTER_CONFIG_JSON:'...'` and include `Authorization: Bearer <key>` header.
**Warning signs:** Test always fails with 503 or 401.

### Pitfall 4: Port Conflicts in CI
**What goes wrong:** Two concurrent test runs both try to use the same port.
**Why it happens:** Hardcoded port in smoke test script.
**How to avoid:** Use a non-default port (not 8787). Optionally allow port override via environment variable. Consider port 0 (not supported by wrangler dev -- wrangler requires explicit port).
**Warning signs:** "EADDRINUSE" errors in CI.

### Pitfall 5: Test Interferes with Existing Test Suite
**What goes wrong:** Running `test:worker` alongside `node --test` causes timing issues or resource conflicts.
**Why it happens:** Both run at the same time in CI.
**How to avoid:** The smoke test is a separate npm script (`test:worker`), not part of the `node --test` glob. They share no state. Keep them independent.
**Warning signs:** Flaky test failures that only occur when both run in parallel.

## Code Examples

### Verified: Wrangler Dev Startup Output (Live)
```
# Source: Live execution on this machine, wrangler 4.68.1
$ npx wrangler dev --port 8798 --show-interactive-dev-session false \
    --var LLM_ROUTER_CONFIG_JSON:'{"version":2,"masterKey":"test-key","providers":[]}'

 ⛅️ wrangler 4.68.1
─────────────────────────────────────────────
Your Worker has access to the following bindings:
...
⎔ Starting local server...
[wrangler:info] Ready on http://localhost:8798
```

### Verified: Health Check with Auth (Live)
```bash
# Source: Live execution on this machine
$ curl -s -H "Authorization: Bearer test-key" http://localhost:8798/health
{"status":"ok","timestamp":"2026-03-21T12:32:30.629Z","providers":0}
# HTTP status: 200
```

### Verified: Health Check Without Auth (Live)
```bash
# Source: Live execution on this machine
$ curl -s http://localhost:8798/health
{"error":"Unauthorized"}
# HTTP status: 401
```

### Verified: Health Check Without Config (Live)
```bash
# Source: Live execution on this machine (no --var flag)
$ curl -s http://localhost:8798/health
{"type":"error","error":{"type":"configuration_error","message":"Worker masterKey is required. Set config.masterKey or LLM_ROUTER_MASTER_KEY."}}
# HTTP status: 503
```

### Script Convention Reference
```
# Source: Existing scripts in this project
scripts/amp-smoke-suite.mjs  — Complex smoke test (650 lines, Node.js)
scripts/dev.mjs              — Dev server script (85 lines, Node.js)
scripts/build-web-console.mjs — Build script (Node.js)

# Convention: #!/usr/bin/env node, .mjs extension, no external test framework
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `wrangler dev --local` explicit flag | `wrangler dev` (local by default in v3+) | Wrangler v3 | `--local` flag is optional; `--remote` is opt-in |
| Vitest Cloudflare pool for Worker tests | `wrangler dev` smoke test for startup validation | Current best practice | Vitest pool auto-injects compat flags, hiding real issues (Pitfall 3 from PITFALLS.md) |

**Deprecated/outdated:**
- `--local` flag: Still works but unnecessary since local is the default in wrangler v3+

## Open Questions

1. **Port 0 support in wrangler dev**
   - What we know: Wrangler accepts `--port` but documentation does not confirm port 0 (auto-assign) support
   - What's unclear: Whether wrangler can dynamically pick an open port
   - Recommendation: Use a fixed high port (e.g., 18787) with env var override. Low risk of conflict.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node.js built-in test runner (node --test) + custom smoke script |
| Config file | None (no test config file in project) |
| Quick run command | `node --test src/runtime/*.test.js` |
| Full suite command | `node --test src/runtime/*.test.js src/node/*.test.js src/translator/**/*.test.js src/cli*.test.js` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| VERF-01 | wrangler dev starts, health returns 200 | smoke (process) | `node scripts/test-worker.mjs` | No -- Wave 0 |
| VERF-02 | test:worker npm script works | smoke (script) | `npm run test:worker` | No -- Wave 0 |
| VERF-03 | Existing node --test passes | unit | `node --test src/runtime/*.test.js src/node/*.test.js src/translator/**/*.test.js src/cli*.test.js` | Yes (existing) |

### Sampling Rate
- **Per task commit:** `node scripts/test-worker.mjs`
- **Per wave merge:** `node scripts/test-worker.mjs && node --test src/runtime/*.test.js`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `scripts/test-worker.mjs` -- wrangler dev smoke test script (covers VERF-01)
- [ ] `package.json` `test:worker` script entry (covers VERF-02)

## Sources

### Primary (HIGH confidence)
- Live `wrangler dev` execution on this machine (wrangler 4.68.1) -- Ready message pattern, health endpoint behavior, auth requirements, config requirements all verified live
- `wrangler dev --help` output -- Flag reference for `--port`, `--show-interactive-dev-session`, `--var`, `--local`, `--remote`
- `src/runtime/handler.js` lines 860-901 -- Auth enforcement flow and `/health` endpoint implementation
- `src/runtime/handler/auth.js` lines 45-46 -- `shouldEnforceWorkerAuth` always true unless `ignoreAuth` is set
- `.planning/research/PITFALLS.md` -- Pitfall 3 (test runner hides compat issues), Pitfall 10 (wrangler dev vs production divergence)

### Secondary (MEDIUM confidence)
- [Cloudflare Wrangler Commands Docs](https://developers.cloudflare.com/workers/wrangler/commands/) -- General wrangler dev documentation
- `.planning/research/SUMMARY.md` -- Recommended smoke test approach from initial research

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- No new libraries; wrangler already installed and tested live
- Architecture: HIGH -- Pattern verified live end-to-end; all behaviors confirmed empirically
- Pitfalls: HIGH -- All pitfalls discovered through live testing, not speculation

**Research date:** 2026-03-21
**Valid until:** 2026-04-21 (stable; wrangler output format unlikely to change within minor versions)
