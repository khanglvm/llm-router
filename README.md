# llm-router

`llm-router` exposes unified API endpoint for multiple AI providers and models.

## Main feature

1. Single endpoint, unified providers & models
2. Support grouping models with rate-limit and load balancing strategy
3. Configuration auto reload in real time, no interruption

## Install

```bash
npm i -g @khanglvm/llm-router@latest
```

## Usage

Copy/paste this short instruction to your AI agent:

```text
Run `llm-router ai-help` first, then set up and operate llm-router for me using CLI commands.
```

## Main Workflow

1. Add providers + models into llm-router (standard API-key providers or OAuth subscription providers)
2. Optionally, group models as alias with load balancing and auto fallback support
3. Start llm-router server, point your coding tool API and model to llm-router

## What Each Term Means

### Provider
The service endpoint you call (OpenRouter, Anthropic, etc.).

### Model
The actual model ID from that provider.

### Rate-Limit Bucket
A request cap for a time window.
Examples:
- `40 requests / minute`
- `20,000 requests / month`

### Model Load Balancer
Decides how traffic is distributed across models in an alias group.

Available strategies:
- `auto` (recommended)
- `ordered`
- `round-robin`
- `weighted-rr`
- `quota-aware-weighted-rr`

### Model Alias (Group models)
A single model name that auto route/rotate across multiple models.

Example:
- alias: `opus`
- targets:
  - `openrouter/claude-opus-4.6`
  - `anthropic/claude-opus-4.6`

Your app can use `opus` model and `llm-router` chooses target models based on your routing settings.

## Setup using Terminal User Interface (TUI)

Open the TUI:

```bash
llm-router
```

Then follow this order.

### 1) Add Provider
Flow:
1. `Config manager`
2. `Add/Edit provider`
3. Select provider auth mode:
   - `API Key` -> endpoint + API key + model list
   - `OAuth` -> browser OAuth + editable model list
4. For `OAuth`:
   - Choose subscription provider (`ChatGPT` or `Claude Code`)
   - Enter Friendly Name and Provider ID
   - Complete browser OAuth login inside this same flow
   - Edit model list (pre-filled defaults; you can add/remove)
   - llm-router live-tests every selected model before save
5. Save

### 1b) Add Subscription Provider (OAuth)
Commandline examples:

```bash
# ChatGPT Codex subscription
llm-router config \
  --operation=upsert-provider \
  --provider-id=chatgpt \
  --name="GPT Sub" \
  --type=subscription

# Claude Code subscription
llm-router config \
  --operation=upsert-provider \
  --provider-id=claude-sub \
  --name="Claude Sub" \
  --type=subscription \
  --subscription-type=claude-code
```

Notes:
- OAuth login is run during provider upsert (browser flow by default).
- Supported `subscription-type`: `chatgpt-codex` and `claude-code` (defaults to `chatgpt-codex`).
- Default model lists are prefilled by subscription type, then editable.
- Device-code login is available for `chatgpt-codex` only.
- No provider API key or endpoint probe input is required for subscription mode.

### 2) Configure Model Fallback (Optional)
Flow:
1. `Config manager`
2. `Set model silent-fallbacks`
3. Pick main model
4. Pick fallback models
5. Save

### 3) Configure Rate Limits (Optional)
Flow:
1. `Config manager`
2. `Manage provider rate-limit buckets`
3. `Create bucket(s)`
4. Set name, model scope, request cap, time window
5. Save

### 4) Group Models With Alias (Recommended)
Flow:
1. `Config manager`
2. `Add/Edit model alias`
3. Set alias ID (example: `chat.default`)
4. Select target models
5. Save

### 5) Configure Model Load Balancer
Flow:
1. `Config manager`
2. `Add/Edit model alias`
3. Open the alias you want to balance
4. Choose strategy (`auto` recommended)
5. Review alias targets
6. Save

### 6) Set Gateway Key
Flow:
1. `Config manager`
2. `Set worker master key`
3. Set or generate key
4. Save

## Start Local Server

```bash
llm-router start
```

Custom port (optional):

```bash
llm-router start --port=3001
# or
LLM_ROUTER_PORT=3001 llm-router start
```

Local endpoints:
- Unified: `http://127.0.0.1:<port>/route`
- Anthropic-style: `http://127.0.0.1:<port>/anthropic`
- OpenAI-style: `http://127.0.0.1:<port>/openai`
- OpenAI Responses-style: `http://127.0.0.1:<port>/openai/v1/responses` (Codex CLI-compatible)

## Connect your coding tool

After setting master key, point your app/agent to local endpoint and use that key as auth token.

Claude Code example (`~/.claude/settings.local.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "gw_your_gateway_key",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "provider_name/model_name_1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "provider_name/model_name_2",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "provider_name/model_name_3"
  }
}
```

## Real-Time Update Experience

When local server is running:
- open `llm-router`
- change provider/model/load-balancer/rate-limit/alias in TUI
- save
- the running proxy updates instantly

No stop/start cycle needed.

Config/status outputs are shown in structured table layouts for easier operator review.

## Cloudflare Worker (Hosted)

Use when you want a hosted endpoint instead of local server.

Guided deploy:

```bash
llm-router deploy
```

You will be guided in TUI to select account and deploy target.

Worker safety defaults:
- `LLM_ROUTER_STATE_BACKEND=file` is ignored on Worker (auto-fallback to in-memory state).
- Stateful timing-dependent routing features (cursor balancing, local quota counters, cooldown persistence) are auto-disabled by default to keep route flow safe across Worker isolates.
- To opt in to best-effort stateful behavior on Worker, set `LLM_ROUTER_WORKER_ALLOW_BEST_EFFORT_STATEFUL_ROUTING=true`.

## Config File Location

Local config file:

`~/.llm-router.json`

## Security

See [`SECURITY.md`](https://github.com/khanglvm/llm-router/blob/master/SECURITY.md).

## Versioning

- Semver: [Semantic Versioning](https://semver.org/)
- Release notes: [`CHANGELOG.md`](https://github.com/khanglvm/llm-router/blob/master/CHANGELOG.md)
