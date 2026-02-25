# llm-router

`llm-router` routes OpenAI-format and Anthropic-format requests across your configured providers.

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
