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

1. Add Providers + models into llm-router
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
3. Enter provider name, endpoint, API key
4. Enter model list
5. Save

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

Local endpoints:
- Unified: `http://127.0.0.1:8787/route`
- Anthropic-style: `http://127.0.0.1:8787/anthropic`
- OpenAI-style: `http://127.0.0.1:8787/openai`

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

## Amp CLI Routing

`llm-router` now recognizes Amp endpoint patterns:
- `/api/internal`
- `/api/provider/{provider}/...`

Amp requests can be mapped in router config with `ampRouting`.

Example:

```json
{
  "defaultModel": "chat.default",
  "ampRouting": {
    "enabled": true,
    "fallbackRoute": "chat.default",
    "modeMap": {
      "smart": "chat.default",
      "deep": "chat.deep"
    },
    "agentMap": {
      "review": "chat.review"
    },
    "agentModeMap": {
      "review": {
        "deep": "chat.review.deep"
      }
    },
    "applicationMap": {
      "cli execute mode": "chat.default"
    },
    "modelMap": {
      "claude-haiku-4-5-20251001": "chat.default",
      "google/gemini-3-pro-preview": "chat.default"
    }
  }
}
```

Routing precedence for Amp requests:
1. `agentModeMap`
2. `modeMap`
3. `agentMap`
4. `applicationMap`
5. `modelMap`
6. `fallbackRoute`

If no mapping is found, Amp traffic falls back to `smart` (which resolves to `defaultModel`).

Set `"ampRouting": { "enabled": false }` to disable Amp overrides.

Debugging Amp requests:
- Set `LLM_ROUTER_DEBUG_AMP_CAPTURE=true` to emit redacted request-signature capture logs for Amp request families.
- Set `LLM_ROUTER_DEBUG_ROUTING=true` to add route-debug headers to responses, including:
  - `x-llm-router-amp-detected`
  - `x-llm-router-amp-mode`
  - `x-llm-router-amp-agent`
  - `x-llm-router-amp-application`
  - `x-llm-router-amp-requested-model`
  - `x-llm-router-amp-matched-by`
  - `x-llm-router-amp-matched-ref`

Troubleshooting:
- Amp request is not detected:
  - Confirm the client is hitting `/api/internal` or `/api/provider/{provider}/...`.
  - Confirm Amp headers such as `x-amp-client-application` are reaching `llm-router`.
- Expected mode/agent mapping is not used:
  - Current live Amp traffic may not send explicit mode/agent fields on every request.
  - When mode/agent is absent, matching falls through to `applicationMap`, `modelMap`, then `fallbackRoute`.
- Config fails validation:
  - Every `ampRouting` target must resolve to an existing alias or valid `provider/model` ref.
  - Unknown alias refs are rejected during config validation before runtime.

## Real-Time Update Experience

When local server is running:
- open `llm-router`
- change provider/model/load-balancer/rate-limit/alias in TUI
- save
- the running proxy updates instantly

No stop/start cycle needed.

## Cloudflare Worker (Hosted)

Use when you want a hosted endpoint instead of local server.

Guided deploy:

```bash
llm-router deploy
```

You will be guided in TUI to select account and deploy target.

## Config File Location

Local config file:

`~/.llm-router.json`

## Security

See [`SECURITY.md`](./SECURITY.md).

## Versioning

- Semver: [Semantic Versioning](https://semver.org/)
- Release notes: [`CHANGELOG.md`](./CHANGELOG.md)
