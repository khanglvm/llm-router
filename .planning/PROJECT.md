# LLM Router — Cloudflare Worker Compatibility Fix

## What This Is

A fix initiative for LLM Router's Cloudflare Worker deployment. The Worker bundles successfully (556 KiB / 108 KiB gzip) but crashes at runtime because subscription provider code statically imports Node.js-only modules (`node:http`, `node:crypto`, `node:child_process`, `node:fs`, `node:path`, `node:os`) through the handler chain — even though those modules are never called in Worker mode.

## Core Value

The Cloudflare Worker deployment must start and handle requests without runtime errors, using only Web-standard APIs and polyfilled Node.js modules available via `nodejs_compat_v2`.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- ✓ Core request routing — uses Web Fetch API — existing
- ✓ Provider fallback — stateless mode — existing
- ✓ Model alias resolution — pure logic — existing
- ✓ OpenAI/Claude format translation — Web Streams API — existing
- ✓ Streaming responses — TransformStream/ReadableStream — existing
- ✓ Master key auth — string comparison — existing
- ✓ CORS handling — pure headers — existing
- ✓ AMP proxy routing — uses fetch() — existing
- ✓ AMP Gemini web search — uses fetch() — existing
- ✓ Gzip decompression — DecompressionStream (Web API) — existing
- ✓ Wrangler config enables Worker startup — `nodejs_compat` + compat date 2025-09-23 — Phase 1
- ✓ Bundler preserves dynamic import boundaries — `find_additional_modules` + `[[rules]]` — Phase 1
- ✓ Static import chain broken — lazy `await import()` in provider-call.js and amp-web-search.js — Phase 2
- ✓ Worker 501 guard for subscription providers — clean error instead of crash — Phase 2
- ✓ State-store Worker guard — file backend never loaded in Worker context — Phase 2

### Active

- [ ] Add `wrangler dev` smoke test to CI
- [ ] Ensure Worker bundle stays under free tier limits after changes

### Out of Scope

- Subscription provider OAuth in Workers — fundamentally requires `node:http` and `node:child_process`, Node-only by design
- File-based state store in Workers — requires `node:fs`, no filesystem available
- Activity log (file) in Workers — Node-only, already properly isolated in `src/node/`
- Web Console UI in Workers — Node-only, already properly isolated in `src/node/`
- Stateful round-robin/rate-limit persistence in Workers — disabled by `workerSafeMode`, acceptable tradeoff

## Context

The audit (`plans/reports/cloudflare-worker-compatibility-audit.md`) identified the root cause: ES module `import` statements execute at module load time. The import chain flows from `src/index.js` → `runtime/handler.js` → `runtime/handler/provider-call.js` → `runtime/subscription-provider.js` → Node.js modules. Even though subscription code is never invoked in Worker mode, the top-level imports fail immediately.

Three fix options were identified:
- **Option A:** `nodejs_compat` flag alone — insufficient (doesn't cover `node:http`, `node:child_process`, `node:fs`)
- **Option B:** Lazy-load subscription modules (recommended) — convert static imports to dynamic `await import()` guarded by runtime checks
- **Option C:** Build-time exclusion — cleanest but requires build pipeline changes

The audit recommends Option B combined with `nodejs_compat_v2` for modules that can be polyfilled.

## Constraints

- **Runtime**: Cloudflare Workers free tier — 10ms CPU/request, 128MB memory, 100K requests/day
- **Bundle**: Must stay under 3MB gzip (currently 108 KiB — plenty of headroom)
- **Compatibility**: Changes must not break Node.js local mode — both runtimes must work from same codebase
- **Config size**: Worker secrets limited to 32 KB — large configs with many providers may hit this

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Lazy-load subscription modules (Option B) | Least invasive, no build pipeline changes, subscription features are Node-only by design | ✓ Good — Phase 2 |
| Add `nodejs_compat` flag + compat date 2025-09-23 | Polyfills all `node:*` modules, enables v2 auto-behavior | ✓ Good — Phase 1 |
| Keep subscription features Node-only | Fundamentally require `node:http`/`node:child_process` which Workers cannot provide | — Pending |

---
*Last updated: 2026-03-21 after Phase 2 completion*
