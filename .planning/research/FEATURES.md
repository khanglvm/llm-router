# Feature Landscape: Cloudflare Worker Compatibility Fix

**Domain:** Node.js to Cloudflare Worker runtime compatibility
**Researched:** 2026-03-21

## Table Stakes

Features that must work for the Worker deployment to be viable.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Worker starts without module load crash | Fundamental -- a Worker that crashes at load time is useless. Currently fails because static imports pull `node:http`, `node:child_process`, `node:fs` which crash without `nodejs_compat`. | Low | Fix: add `nodejs_compat` flag + update `compatibility_date` to `2025-09-23` |
| Core request routing works | Primary function of the product | Already works | Uses Web Fetch API, no Node.js deps |
| Provider fallback works | Core reliability feature | Already works | Stateless mode, no Node.js deps |
| Streaming responses work | Expected by all LLM API consumers | Already works | TransformStream/ReadableStream (Web APIs) |
| CORS handling works | Required for browser-based clients | Already works | Pure header manipulation |
| Master key auth works | Security requirement | Already works | String comparison |
| Format translation works | Core value proposition | Already works | Pure logic + Web Streams |
| Bundle stays under free-tier limits | Must deploy to free tier | Already met | 108 KiB gzip vs 3 MB limit |
| Node.js local mode unbroken | Existing users must not be impacted | Med | Lazy import must be transparent to Node callers. Validate with existing test suite. |

## Differentiators

Features that improve the Worker deployment quality beyond "it starts." Not required for first fix.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| `wrangler dev` CI smoke test | Catches Worker-breaking regressions automatically | Low | Shell script: start, health check, assert 200, kill |
| Clean 501 error for subscription providers in Worker mode | Better DX -- tells users subscription providers are Node-only instead of cryptic crash | Low | Guard in `makeProviderCall` before dynamic import |
| AMP proxy routing in Workers | Extends Worker usefulness beyond basic routing | Already works | Uses `fetch()` |
| AMP Gemini web search in Workers | Full AMP feature parity in Worker mode | Already works | Uses `fetch()` |
| Gzip decompression in Workers | Handles compressed upstream responses | Already works | `DecompressionStream` (Web API, available since compat date 2023-08-01) |

## Anti-Features

Features to explicitly NOT build as part of this fix.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Subscription provider OAuth in Workers | Requires `node:child_process` `spawn()` for browser opening. Even with `nodejs_compat`, `spawn()` is a non-functional stub that throws at call time. `http.createServer` in Workers is a shim, not a real TCP listener for OAuth callbacks. | Keep subscription providers Node-only. Return 501 in Worker mode. |
| File-based state store in Workers | `node:fs` in Workers is a virtual, per-request, memory-backed filesystem. No cross-request persistence. | Memory state store (already default in Worker mode). |
| File-based activity log in Workers | No persistent filesystem. Already isolated in `src/node/`. | Skip in Worker mode. Already out of scope. |
| Web Console UI in Workers | Already isolated in `src/node/`. | Keep Node-only. |
| Stateful round-robin/rate-limit persistence | Worker requests run in isolated V8 contexts. Global `Map` objects don't persist. | `workerSafeMode: true` already disables this. |
| Build-time module exclusion pipeline | Adds a build step that doesn't exist. `nodejs_compat` + lazy imports solve the problem without build changes. | Use runtime lazy imports instead. |
| Custom `subscription-provider.worker-stub.js` | Requires maintaining parallel exports that mirror the real module. | Dynamic `await import()` is simpler and zero-maintenance. |

## Feature Dependencies

```
Update wrangler.toml (compatibility_date + nodejs_compat)
  --> All node:* modules resolve at import time
    --> Convert subscription-provider imports to lazy dynamic import()
      --> Inline isSubscriptionProvider() check (no import needed for sync check)
      --> Guard subscription path with Worker runtime check
        --> wrangler dev smoke test validates full chain
          --> Node.js test suite validates no regressions
```

## MVP Recommendation

Prioritize:
1. `wrangler.toml` config update -- unblocks everything (Low effort)
2. Lazy import conversion in `provider-call.js` and `amp-web-search.js` -- defense-in-depth (Med effort)
3. CI smoke test -- regression prevention (Low effort)

Defer:
- **Vitest Worker integration tests:** Overkill for validating "Worker starts and handles a request"
- **Durable Objects for state persistence:** Different architecture, different pricing tier, future milestone
- **Build-time exclusion (Option C from audit):** Only warranted if many more Node-only modules are added

## Sources

- [Cloudflare Workers Node.js Compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) -- HIGH confidence
- [Cloudflare Workers Compatibility Flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) -- HIGH confidence
- [Cloudflare Workers node:http Docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/) -- HIGH confidence
- [Cloudflare Workers node:fs Docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/) -- HIGH confidence
- [A Year of Improving Node.js Compatibility in Workers](https://blog.cloudflare.com/nodejs-workers-2025/) -- HIGH confidence
- Project audit: `plans/reports/cloudflare-worker-compatibility-audit.md`
