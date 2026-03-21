# Phase 1: Wrangler Configuration - Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Update `wrangler.toml` so the Cloudflare Worker starts without module-load crashes. This phase is configuration-only — no source code changes. The Worker must resolve all `node:*` static imports via `nodejs_compat` polyfills, and the bundler must preserve dynamic import boundaries for Phase 2's lazy-load refactor.

</domain>

<decisions>
## Implementation Decisions

### Compatibility date
- Update `compatibility_date` from `"2024-01-01"` to `"2025-09-23"`
- This unlocks: `node:http` server/client support (>= 2025-09-01), `node:fs` virtual FS (>= 2025-09-01), `nodejs_compat_v2` auto-behavior (>= 2024-09-23)
- The current `"2024-01-01"` silently limits available Node.js APIs — this is the root enabler

### Compatibility flags
- Add `compatibility_flags = ["nodejs_compat"]` to enable the `unenv` polyfill layer for all `node:*` modules
- This is Cloudflare's recommended single-flag approach — preferable to configuring individual sub-flags
- With this flag + updated date, all 6 problematic modules (`node:http`, `node:crypto`, `node:child_process`, `node:fs`, `node:path`, `node:os`) will import successfully

### Bundler configuration
- Add `find_additional_modules = true` to prevent Wrangler's esbuild from inlining dynamic `await import()` calls back into the main bundle
- Add `[[rules]]` entries targeting subscription module files so they are preserved as separate modules
- This is required BEFORE Phase 2 — without it, the lazy-load refactor would be silently defeated by the bundler

### Verification approach
- Validate with both `wrangler dev` (local runtime test) AND `wrangler deploy --dry-run` (bundler output check)
- `wrangler dev` confirms Worker starts without module-resolution errors
- `--dry-run` confirms bundler respects dynamic import boundaries and subscription modules are listed as additional modules, not inlined
- Both must pass before Phase 1 is considered complete

### Claude's Discretion
- Exact `[[rules]]` glob patterns for targeting subscription module files
- Whether to add comments in wrangler.toml explaining the configuration choices
- Order of configuration sections in the file

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Wrangler configuration
- `wrangler.toml` — Current Worker configuration (compatibility_date, vars, secrets)
- `.planning/research/STACK.md` — Stack recommendations with specific config values and rationale
- `.planning/research/SUMMARY.md` — Executive summary of all research findings

### Cloudflare Worker compatibility
- `.planning/research/PITFALLS.md` — Critical pitfalls including bundler inlining (Pitfall 1), stale compat date (Pitfall 4)
- `.planning/research/ARCHITECTURE.md` — Import chain analysis showing which files need bundler rules

### Audit reference
- `plans/reports/cloudflare-worker-compatibility-audit.md` — Original audit identifying the tainted import chain and fix options

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `wrangler.toml` (21 lines): Simple, clean config file — straightforward to extend with new sections

### Established Patterns
- Config uses `[vars]` for non-secret environment variables
- Secrets documented in comments (`LLM_ROUTER_CONFIG_JSON`, `LLM_ROUTER_MASTER_KEY`)
- No existing `[build]` section or compatibility flags

### Integration Points
- `main = "src/index.js"` is the Worker entry point — the import chain starts here
- Subscription modules in `src/runtime/handler/` and `src/runtime/subscription-*.js` are the targets for `[[rules]]`

</code_context>

<specifics>
## Specific Ideas

No specific requirements — the research findings provide clear, prescriptive configuration values. Follow the research recommendations directly.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-wrangler-configuration*
*Context gathered: 2026-03-21*
