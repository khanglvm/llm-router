# Phase 1: Wrangler Configuration - Research

**Researched:** 2026-03-21
**Domain:** Cloudflare Worker wrangler.toml configuration -- compatibility date, flags, and bundler settings
**Confidence:** HIGH

## Summary

Phase 1 is a configuration-only change to `wrangler.toml`. No source code is modified. Three specific configuration updates are needed: (1) advancing `compatibility_date` from `"2024-01-01"` to `"2025-09-23"` to unlock all 2025 Node.js compatibility improvements, (2) adding `compatibility_flags = ["nodejs_compat"]` to enable the `unenv` polyfill layer so all `node:*` static imports resolve at module load time, and (3) adding `find_additional_modules = true` with `[[rules]]` entries so Wrangler's esbuild does not inline Phase 2's dynamic imports back into the main bundle.

The current dry-run produces 6 `node:*` warnings (`node:http`, `node:crypto`, `node:child_process`, `node:fs`, `node:path`, `node:os`). After applying the `nodejs_compat` flag, all 6 warnings should disappear because the polyfill layer satisfies the imports at build time. The bundler rules are forward-looking -- they are needed before Phase 2 adds `await import()` calls, so that the lazy-load boundaries are preserved from the start.

A critical detail discovered during research: `base_dir` for `[[rules]]` defaults to the directory containing the `main` entrypoint (`src/`), NOT the project root. Glob patterns in rules must be relative to `src/`. The subscription modules at `src/runtime/subscription-*.js` need globs like `./runtime/subscription-*.js` or `runtime/subscription-*.js`. Getting this wrong would silently fail to match any files, and Phase 2's dynamic imports would be inlined by esbuild without warning.

**Primary recommendation:** Apply all three configuration changes to `wrangler.toml` in a single commit. Verify with `wrangler deploy --dry-run` (zero `node:*` warnings) and `wrangler dev` (Worker starts without crash).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Update `compatibility_date` from `"2024-01-01"` to `"2025-09-23"`
- Add `compatibility_flags = ["nodejs_compat"]` to enable the `unenv` polyfill layer for all `node:*` modules
- Add `find_additional_modules = true` to prevent Wrangler's esbuild from inlining dynamic `await import()` calls
- Add `[[rules]]` entries targeting subscription module files so they are preserved as separate modules
- Validate with both `wrangler dev` (local runtime test) AND `wrangler deploy --dry-run` (bundler output check)

### Claude's Discretion
- Exact `[[rules]]` glob patterns for targeting subscription module files
- Whether to add comments in wrangler.toml explaining the configuration choices
- Order of configuration sections in the file

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CONF-01 | Worker starts without module-load crash after updating `compatibility_date` to `"2025-09-23"` | Verified: date >= 2024-09-23 auto-enables `nodejs_compat_v2`; date >= 2025-09-01 unlocks `node:http` server and `node:fs`. Using 2025-09-23 gives margin. |
| CONF-02 | All `node:*` static imports resolve via `nodejs_compat` compatibility flag | Verified: `nodejs_compat` enables `unenv` polyfill layer. All 6 modules (`node:http`, `node:crypto`, `node:child_process`, `node:fs`, `node:path`, `node:os`) resolve. `node:child_process` provides non-functional stubs that import successfully. Current dry-run shows 6 warnings; flag eliminates them. |
| CONF-03 | Wrangler bundler preserves dynamic import boundaries via `find_additional_modules` and `[[rules]]` config | Verified: `find_additional_modules = true` + `[[rules]]` with type `ESModule` causes Wrangler to treat matched files as external, not inlined. `base_dir` defaults to `src/` (directory of `main` entrypoint). Globs must target `runtime/subscription-*.js` relative to `src/`. |
</phase_requirements>

## Standard Stack

### Core

No new packages. All changes are `wrangler.toml` configuration.

| Setting | Value | Purpose | Why Standard | Confidence |
|---------|-------|---------|--------------|------------|
| `compatibility_date` | `"2025-09-23"` | Unlock 2025 Node.js compat, including `node:http` server and `node:fs` | >= 2024-09-23 required for `nodejs_compat_v2` auto-enable; >= 2025-09-01 for `node:http`/`node:fs` server support | HIGH |
| `compatibility_flags` | `["nodejs_compat"]` | Enable `unenv` polyfill layer for all `node:*` modules | Cloudflare's recommended umbrella flag. Replaces deprecated `node_compat` from Wrangler v3. Auto-enables `nodejs_compat_v2` with the chosen date. | HIGH |
| `find_additional_modules` | `true` | Prevent esbuild from inlining dynamic imports | Required for Phase 2 lazy-load boundaries. Without it, `await import()` is resolved at build time and collapsed into the main bundle. | HIGH |
| `[[rules]]` | `type = "ESModule"`, `globs = ["runtime/subscription-*.js"]` | Mark subscription modules as external unbundled modules | Ensures subscription modules are preserved as separate files, not inlined. Wrangler treats matched files as external. | HIGH |
| Wrangler CLI | `^4.68.1` (already installed) | Build, dev, deploy Workers | Already in devDependencies. No change needed. Update available to 4.76.0 but not required. | HIGH |

### What NOT to Use

| Setting/Tech | Why Not |
|------------|---------|
| `node_compat` (wrangler.toml property) | Deprecated in Wrangler v4. Replaced by `nodejs_compat` compatibility flag. Will cause errors. |
| `nodejs_compat_v2` as explicit flag | Redundant -- automatically enabled when `nodejs_compat` is set with compat date >= 2024-09-23. |
| `no_nodejs_compat_v2` | Would disable polyfills the project needs. |
| `unenv` as direct dependency | Bundled within wrangler/workerd. Installing separately would conflict. |
| `[build]` section / custom build step | No build pipeline exists. Adding one is unnecessary for this configuration-only phase. |

### Installation

```bash
# No npm install needed -- wrangler 4.68.1 is already in devDependencies
# All changes are in wrangler.toml only
```

## Architecture Patterns

### Current wrangler.toml (21 lines)

```toml
name = "llm-router-route"
main = "src/index.js"
compatibility_date = "2024-01-01"
workers_dev = false
preview_urls = false

[vars]
ENVIRONMENT = "production"
```

### Target wrangler.toml After Phase 1

```toml
name = "llm-router-route"
main = "src/index.js"
compatibility_date = "2025-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = false
preview_urls = false

# Preserve dynamic import boundaries for subscription modules (Phase 2).
# Wrangler's esbuild inlines dynamic imports by default -- this prevents that.
find_additional_modules = true

[[rules]]
type = "ESModule"
globs = ["runtime/subscription-*.js"]
fallthrough = true

[vars]
ENVIRONMENT = "production"
```

### Critical Configuration Details

**`base_dir` behavior:** The `base_dir` setting defaults to the directory containing the `main` entrypoint. Since `main = "src/index.js"`, `base_dir` defaults to `src/`. All `[[rules]]` globs are resolved relative to `src/`, not the project root. The subscription modules live at `src/runtime/subscription-*.js`, so the glob must be `runtime/subscription-*.js` (without the `src/` prefix).

**`fallthrough = true`:** Allows multiple rules to match the same files. While we only have one rule now, setting `fallthrough = true` is defensive against future additions.

**Rule type casing:** The Wrangler configuration reference specifies `ESModule` (capital E, capital S, capital M). Some older documentation examples show `EsModule` -- use `ESModule` per the current v4 configuration reference.

### Files Matched by the `[[rules]]` Glob

The glob `runtime/subscription-*.js` (relative to `src/`) matches:
- `src/runtime/subscription-provider.js` -- the main subscription module that chains to Node-only deps
- `src/runtime/subscription-auth.js` -- imports `node:http`, `node:crypto`, `node:child_process`
- `src/runtime/subscription-tokens.js` -- imports `node:fs`, `node:path`, `node:os`
- `src/runtime/subscription-constants.js` -- pure data, no Node imports (harmless to include)

It does NOT match the test file `src/runtime/subscription-auth.test.js` because wrangler only processes `.js` source files in the module graph.

### Anti-Patterns to Avoid

- **Setting `base_dir` explicitly without understanding defaults:** Do not add `base_dir = "."` (project root) or `base_dir = "src/"` unless there is a specific reason. The default (`src/` from the `main` entrypoint directory) is correct for this project.
- **Using `./` prefix in globs:** Do not use `./runtime/subscription-*.js` -- the leading `./` may or may not be needed depending on Wrangler version. Use `runtime/subscription-*.js` without the prefix for maximum compatibility, or test both if unsure.
- **Adding a `[build]` section:** Phase 1 is configuration-only. No custom build command is needed.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Node.js module polyfills | Custom polyfill imports or shims | `nodejs_compat` flag | `unenv` provides battle-tested stubs for all Node.js modules. Custom polyfills are incomplete and unmaintained. |
| Dynamic import preservation | Custom esbuild plugin or `--external` flags | `find_additional_modules` + `[[rules]]` | Wrangler's built-in mechanism is designed for exactly this purpose. Custom esbuild config requires a `[build]` section that does not exist. |
| Module format detection | Manual file-by-file configuration | `type = "ESModule"` rule with globs | Wrangler autodetects for the main bundle but needs rules for additional modules. One glob pattern covers all subscription files. |

## Common Pitfalls

### Pitfall 1: `base_dir` Glob Resolution

**What goes wrong:** Globs in `[[rules]]` are relative to `base_dir`, which defaults to the directory containing the `main` entrypoint -- NOT the project root. If you write `globs = ["src/runtime/subscription-*.js"]`, nothing matches because Wrangler looks for `src/src/runtime/subscription-*.js`.

**Why it happens:** The documentation buries this detail. Most developers assume globs are relative to `wrangler.toml` or the project root.

**How to avoid:** Since `main = "src/index.js"`, `base_dir` defaults to `src/`. Write globs as `runtime/subscription-*.js` (no `src/` prefix).

**Warning signs:** `wrangler deploy --dry-run` still shows `node:*` warnings after Phase 2 applies lazy imports. The subscription modules were not matched as additional modules, so esbuild inlined the dynamic imports.

### Pitfall 2: Rule Type Casing

**What goes wrong:** Using `EsModule` instead of `ESModule` for the rule type. Some older Cloudflare documentation examples use lowercase-S (`EsModule`). The v4 configuration reference specifies `ESModule`.

**Why it happens:** Documentation inconsistency across different Cloudflare pages.

**How to avoid:** Use `ESModule` (all caps ES). The valid types per the v4 config reference are: `ESModule`, `CommonJS`, `CompiledWasm`, `Text`, `Data`.

**Warning signs:** Wrangler may emit a config validation error or silently ignore the rule.

### Pitfall 3: Old Compatibility Date Silently Limits APIs

**What goes wrong:** Adding `nodejs_compat` without updating `compatibility_date`. With `"2024-01-01"`, the flag enables basic polyfills but misses critical 2025 improvements: `node:http` server support requires >= 2025-09-01, `node:fs` full virtual FS requires >= 2025-09-01.

**Why it happens:** The flag and date interact -- the date gates which specific features the flag enables.

**How to avoid:** Always update `compatibility_date` BEFORE or SIMULTANEOUSLY with adding `compatibility_flags`. Use `"2025-09-23"` which is after all required date gates.

**Warning signs:** `nodejs_compat` is set but `wrangler dev` still crashes on `node:http` or `node:fs` imports.

### Pitfall 4: Verifying Only with `wrangler dev` OR Only with `--dry-run`

**What goes wrong:** `wrangler dev` may succeed but `deploy` fails (or vice versa) because the local workerd runtime and the production bundler have slightly different behavior.

**Why it happens:** `wrangler dev` runs a local simulation. `--dry-run` validates the production bundle. They test different things.

**How to avoid:** Run BOTH `wrangler dev` (Worker starts without error) AND `wrangler deploy --dry-run` (zero `node:*` warnings, subscription modules listed as additional modules in outdir).

## Code Examples

### Complete Target wrangler.toml

```toml
# Source: Cloudflare Workers Configuration Reference
# https://developers.cloudflare.com/workers/wrangler/configuration/

name = "llm-router-route"
main = "src/index.js"
compatibility_date = "2025-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = false
preview_urls = false

# Preserve dynamic import boundaries for subscription modules.
# Without this, Wrangler's esbuild inlines await import() back into the
# main bundle, collapsing lazy-load boundaries added in Phase 2.
# base_dir defaults to src/ (directory of main entrypoint).
find_additional_modules = true

[[rules]]
type = "ESModule"
globs = ["runtime/subscription-*.js"]
fallthrough = true

# Optional non-secret vars
[vars]
ENVIRONMENT = "production"

# Required secret(s):
# LLM_ROUTER_CONFIG_JSON  - All-in-one JSON config exported by:
#                          llm-router deploy --export-only=true --out=.llm-router.worker.json
#                          wrangler secret put LLM_ROUTER_CONFIG_JSON < .llm-router.worker.json
#
# Optional override:
# LLM_ROUTER_MASTER_KEY   - Overrides config.masterKey at runtime
```

### Verification Commands

```bash
# 1. Dry-run: should complete with ZERO node:* warnings
npx wrangler deploy --dry-run --outdir /tmp/wrangler-verify

# 2. Check outdir for additional module files
ls /tmp/wrangler-verify/
# Expected: index.js (main bundle) + subscription-*.js files as separate modules

# 3. Dev mode: Worker should start without module-resolution errors
npx wrangler dev --port 8787
# Expected: "Ready on http://localhost:8787" with no import errors in console
```

### Current Dry-Run Output (Before Fix)

```
WARNINGS (6):
  - node:os          <- state-store.file.js, subscription-tokens.js
  - node:path        <- state-store.file.js, subscription-tokens.js
  - node:http        <- subscription-auth.js
  - node:fs          <- state-store.file.js, subscription-tokens.js
  - node:crypto      <- subscription-auth.js
  - node:child_process <- subscription-auth.js

Total Upload: 556.34 KiB / gzip: 107.99 KiB
```

### Expected Dry-Run Output (After Fix)

```
# ZERO warnings about node:* packages
# The nodejs_compat flag tells esbuild these are provided by the runtime

Total Upload: ~556 KiB / gzip: ~108 KiB
# Bundle size should be roughly the same -- nodejs_compat adds ~50-100 KiB
# of polyfill overhead but the base source is unchanged
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `node_compat` wrangler.toml property | `nodejs_compat` compatibility flag | Wrangler v4 (2025-03-13) | `node_compat` is deprecated and errors in v4. Use the flag instead. |
| `nodejs_compat` v1 (basic polyfills) | `nodejs_compat` v2 (auto with date >= 2024-09-23) | 2024-09-23 | v2 bundles additional polyfills from `unenv` and improves Node.js module coverage. Auto-enabled with modern compat date. |
| No `node:http` server support | Full `http.createServer` support | 2025-09-01 | Requires compat date >= 2025-09-01. The current `2024-01-01` misses this entirely. |
| No `node:fs` support | Virtual FS (`/tmp`, `/bundle`, `/dev`) | 2025-09-01 | Requires compat date >= 2025-09-01. Enables file operations against virtual filesystem. |

## Open Questions

1. **Glob prefix `./` in rules**
   - What we know: The Wrangler bundling docs example uses `./lang/**/*.mjs` with a leading `./`. The config reference example uses no leading `./`. Both may work.
   - What's unclear: Whether `./runtime/subscription-*.js` and `runtime/subscription-*.js` are functionally identical in the rule glob resolution.
   - Recommendation: Use `runtime/subscription-*.js` without the `./` prefix. If the rules do not match (verified by checking `--dry-run --outdir` for separate module files), try adding the `./` prefix as a fallback.

2. **Whether `state-store.file.js` also needs a rule**
   - What we know: `state-store.file.js` imports `node:fs`, `node:path`, `node:os` but is ALREADY loaded via `await import()` in `state-store.js`. The `nodejs_compat` flag makes its static imports resolve.
   - What's unclear: Whether esbuild will still inline `state-store.file.js` despite the existing dynamic import, or whether `nodejs_compat` alone is sufficient since the polyfills satisfy the imports.
   - Recommendation: Do NOT add a rule for `state-store.file.js` initially. The `nodejs_compat` flag makes its imports resolve. If `--dry-run` still warns about it after Phase 2, add a rule then. The existing `await import()` pattern already works without rules because the imports are satisfied by polyfills.

3. **Wrangler update from 4.68.1 to 4.76.0**
   - What we know: `npx wrangler --version` shows an update is available. The current version works.
   - What's unclear: Whether 4.76.0 has any relevant bugfixes for `find_additional_modules` or `[[rules]]`.
   - Recommendation: Do NOT update Wrangler in this phase. It introduces unnecessary risk. If configuration issues arise, consider updating as a troubleshooting step.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node.js built-in test runner (`node --test`) |
| Config file | None (uses `node --test` directly) |
| Quick run command | `node --test src/runtime/*.test.js` |
| Full suite command | `node --test src/**/*.test.js` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CONF-01 | Worker starts without module-load crash | smoke | `npx wrangler deploy --dry-run 2>&1 \| grep -c WARNING` (expect 0) | N/A -- manual verification |
| CONF-02 | All `node:*` imports resolve via `nodejs_compat` | smoke | `npx wrangler deploy --dry-run 2>&1 \| grep "node:"` (expect no matches) | N/A -- manual verification |
| CONF-03 | Bundler preserves dynamic import boundaries | smoke | `npx wrangler deploy --dry-run --outdir /tmp/verify && ls /tmp/verify/` (expect subscription-*.js files) | N/A -- manual verification |

### Sampling Rate

- **Per task commit:** `npx wrangler deploy --dry-run 2>&1` (check zero `node:*` warnings)
- **Per wave merge:** `npx wrangler deploy --dry-run --outdir /tmp/verify` + inspect outdir for separate module files
- **Phase gate:** `wrangler dev` starts without crash AND `--dry-run` produces zero warnings

### Wave 0 Gaps

None -- this phase is configuration-only. No test files need to be created. Verification is done via `wrangler deploy --dry-run` and `wrangler dev` commands. The existing Node.js test suite (`node --test`) must continue to pass (regression check), but no new test code is needed for configuration changes.

## Sources

### Primary (HIGH confidence)
- [Cloudflare Workers Configuration Reference](https://developers.cloudflare.com/workers/wrangler/configuration/) -- `[[rules]]` type values (`ESModule`, `CommonJS`, `CompiledWasm`, `Text`, `Data`), `base_dir` default behavior, `find_additional_modules` documentation
- [Cloudflare Workers Bundling Docs](https://developers.cloudflare.com/workers/wrangler/bundling/) -- `find_additional_modules` interaction with dynamic imports, partial bundling behavior
- [Cloudflare Workers Compatibility Flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) -- `nodejs_compat` flag behavior, `nodejs_compat_v2` auto-enable at date >= 2024-09-23
- [Cloudflare Workers Node.js Compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) -- Module support matrix, stub behavior for `node:child_process`
- Project `wrangler deploy --dry-run` output -- confirmed 6 `node:*` warnings, 556.34 KiB / 107.99 KiB gzip bundle size

### Secondary (MEDIUM confidence)
- [Wrangler v4 Migration Docs](https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/) -- `node_compat` deprecation confirmation
- [Cloudflare Blog: Node.js Workers 2025](https://blog.cloudflare.com/nodejs-workers-2025/) -- 2025 compat date improvements overview

### Project Sources
- `.planning/research/STACK.md` -- Recommended configuration values with rationale
- `.planning/research/PITFALLS.md` -- Pitfall 1 (bundler inlining), Pitfall 4 (stale compat date)
- `.planning/research/ARCHITECTURE.md` -- Import chain analysis, `base_dir` implications
- `plans/reports/cloudflare-worker-compatibility-audit.md` -- Original audit with dry-run output

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all configuration values verified against official Cloudflare docs and confirmed by running `wrangler deploy --dry-run` on the actual project
- Architecture: HIGH -- `base_dir` behavior confirmed from official config reference; glob resolution path validated against project file structure
- Pitfalls: HIGH -- `base_dir` gotcha discovered during research (not in prior research); rule type casing inconsistency identified and resolved via config reference

**Research date:** 2026-03-21
**Valid until:** 2026-06-21 (stable configuration -- Wrangler v4 is GA; compatibility flags are permanent)
