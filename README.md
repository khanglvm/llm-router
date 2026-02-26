# llm-router

`llm-router` is an API proxy for AI providers, with OpenAI-format and Anthropic-format compatibility.

It supports:
- local route server (`~/.llm-router.json`)
- Cloudflare Worker route runtime (`LLM_ROUTER_CONFIG_JSON` secret)
- CLI + TUI management (`config`, `start`, `deploy`, `worker-key`)

## Install

```bash
npm i -g @khanglvm/llm-router
```

## Quick Start

```bash
# 1) Open config TUI (default behavior)
llm-router

# 2) Start local route server
llm-router start
```

Local endpoints:
- Anthropic: `http://127.0.0.1:8787/anthropic`
- OpenAI: `http://127.0.0.1:8787/openai`
- Unified: `http://127.0.0.1:8787/route` (or `/` and `/v1`)

## Smart Fallback Behavior

`llm-router` can fail over from a primary model to configured fallback models with status-aware logic:
- `429` (rate-limited): immediate fallback (no origin retry), with `Retry-After` respected when present.
- Temporary failures (`408`, `409`, `5xx`, network errors): origin-only bounded retries with jittered backoff, then fallback.
- Billing/quota exhaustion (`402`, or provider-specific billing signals): immediate fallback with longer origin cooldown memory.
- Auth and permission failures (`401` and relevant `403` cases): no retry; fallback to other providers/models when possible.
- Policy/moderation blocks: no retry; cross-provider fallback is disabled by default (`LLM_ROUTER_ALLOW_POLICY_FALLBACK=false`).
- Invalid client requests (`400`, `413`, `422`): no retry and no fallback short-circuit.

## Main Commands

```bash
llm-router config
llm-router start
llm-router stop
llm-router reload
llm-router update
llm-router deploy
llm-router worker-key
```

## Non-Interactive Config (Agent/CI Friendly)

```bash
llm-router config \
  --operation=upsert-provider \
  --provider-id=openrouter \
  --name="OpenRouter" \
  --base-url=https://openrouter.ai/api/v1 \
  --api-key=sk-or-v1-... \
  --models=gpt-4o,claude-3-7-sonnet \
  --format=openai \
  --skip-probe=true
```

Set local auth key:

```bash
llm-router config --operation=set-master-key --master-key=your_local_key
```

Start with auth required:

```bash
llm-router start --require-auth=true
```

## Cloudflare Worker Deploy

Worker project name in `wrangler.toml`: `llm-router-route`.

### Option A: Guided deploy

```bash
llm-router deploy
```

### Option B: Explicit steps

```bash
llm-router deploy --export-only=true --out=.llm-router.worker.json
wrangler secret put LLM_ROUTER_CONFIG_JSON < .llm-router.worker.json
wrangler deploy
```

Rotate worker auth key quickly:

```bash
llm-router worker-key --master-key=new_key
```

## Runtime Secrets / Env

Primary:
- `LLM_ROUTER_CONFIG_JSON`
- `LLM_ROUTER_MASTER_KEY` (optional override)

Also supported:
- `ROUTE_CONFIG_JSON`
- `LLM_ROUTER_JSON`

Optional resilience tuning:
- `LLM_ROUTER_ORIGIN_RETRY_ATTEMPTS` (default `3`)
- `LLM_ROUTER_ORIGIN_RETRY_BASE_DELAY_MS` (default `250`)
- `LLM_ROUTER_ORIGIN_RETRY_MAX_DELAY_MS` (default `3000`)
- `LLM_ROUTER_ORIGIN_FALLBACK_COOLDOWN_MS` (default `45000`)
- `LLM_ROUTER_ORIGIN_RATE_LIMIT_COOLDOWN_MS` (default `30000`)
- `LLM_ROUTER_ORIGIN_BILLING_COOLDOWN_MS` (default `900000`)
- `LLM_ROUTER_ORIGIN_AUTH_COOLDOWN_MS` (default `600000`)
- `LLM_ROUTER_ORIGIN_POLICY_COOLDOWN_MS` (default `120000`)
- `LLM_ROUTER_ALLOW_POLICY_FALLBACK` (default `false`)
- `LLM_ROUTER_FALLBACK_CIRCUIT_FAILURES` (default `2`)
- `LLM_ROUTER_FALLBACK_CIRCUIT_COOLDOWN_MS` (default `30000`)

## Default Config Path

`~/.llm-router.json`

Minimal shape:

```json
{
  "masterKey": "local_or_worker_key",
  "defaultModel": "openrouter/gpt-4o",
  "providers": [
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-v1-...",
      "formats": ["openai"],
      "models": [{ "id": "gpt-4o" }]
    }
  ]
}
```

## Smoke Test

```bash
npm run test:provider-smoke
```

Use `.env.test-suite.example` as template for provider-based smoke tests.
