# llm-router

## Main Features

1. Single endpoint, unified providers & models
2. Support grouping models with rate-limit and load balancing strategy
3. Configuration auto reload in real time, no interruption

## Beta Notice

`2.0.0-beta.0` is the next public prerelease. It includes major AMP routing, web console, and local operator workflow changes, so treat it as beta and expect rough edges while validating it before a stable `2.0.0` release.

Short highlights in this beta:
- New localhost web console for config editing, provider testing, and router lifecycle control
- Quick patching for AMP Code, Codex CLI and Claude Code
- Expanded operator workflows across CLI, TUI, OAuth subscription setup, and live provider validation
- Fixed various format-transformation issues

## Install

Stable channel:

```bash
npm i -g @khanglvm/llm-router@latest
```

Beta preview:

```bash
npm i -g @khanglvm/llm-router@2.0.0-beta.0
```

## Usage

Copy/paste this short instruction to your AI agent:

```text
Run `llm-router ai-help` first, then set up and operate llm-router for me using CLI commands.
```

## Local Real-Provider Test Suite

The repo now includes a local-only live provider suite that covers all three operator surfaces:

- CLI config + `start`
- TUI config menus
- Web console provider discovery/test + browser bundle render

Setup:

```bash
cp .env.test-suite.example .env.test-suite
# fill your own provider keys/endpoints/models in .env.test-suite
```

Run it:

```bash
npm run test:provider-live
# legacy alias:
npm run test:provider-smoke
```

Notes:

- `.env.test-suite` is gitignored and is intended only for local runs.
- The live suite uses isolated temp HOME/config/runtime-state folders so it does not overwrite your normal `~/.llm-router.json` or `~/.llm-router.runtime.json`.
- Public contributors should keep using `.env.test-suite.example` as the template and fill their own providers locally.

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
llm-router --tui
# or
llm-router config --tui
```

Then follow this order.

### 1) Add Provider
Flow:
1. `Config manager`
2. `Providers`
3. `Add or edit`
4. Choose auth method:
   - `API key` -> endpoint + API key + model list
   - `OAuth` -> browser OAuth + editable model list
5. For `OAuth`:
   - Choose subscription provider (`ChatGPT` or `Claude Code`)
   - Enter provider name and provider ID
   - Complete browser OAuth login inside this same flow
   - Edit model list (pre-filled defaults; you can add/remove)
   - llm-router live-tests every selected model before save
6. Save

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
- Compliance notice: provider account/resource usage via `llm-router` may violate a provider's terms. You are solely responsible for compliance; `llm-router` maintainers take no responsibility for misuse.

### 2) Configure Model Fallback (Optional)
Flow:
1. `Config manager`
2. `Routing`
3. `Fallbacks`
4. Pick main model
5. Pick fallback models
6. Save

### 3) Configure Rate Limits (Optional)
Flow:
1. `Config manager`
2. `Routing`
3. `Rate limits`
4. `Create`
5. Set name, model scope, request cap, time window
6. Save

### 4) Group Models With Alias (Recommended)
Flow:
1. `Config manager`
2. `Routing`
3. `Aliases`
4. Set alias ID (example: `chat.default`)
5. Select target models
6. Save

### 5) Configure Model Load Balancer
Flow:
1. `Config manager`
2. `Routing`
3. `Aliases`
4. Open the alias you want to balance
5. Choose strategy (`auto` recommended)
6. Review alias targets
7. Save

### 6) Set Gateway Key
Flow:
1. `Config manager`
2. `Security`
3. `Master key`
4. Set or generate key
5. Save

## Setup using Web Console

Open the browser-based console:

```bash
llm-router
# or
llm-router config
# explicit alias
llm-router web
```

Local contributor development workflow:

```bash
yarn dev
```

What you get:
- Compact Claude-light localhost UI built with React, shadcn-style primitives, and Tailwind
- JSON-first config editor with live validation, external file sync, and a first-run quick-start wizard when no providers are configured
- Quick status cards for config health, managed router state, startup status, and recent activity
- Sections for:
  - raw config editing with validate / prettify / save / open-in-editor actions
  - provider inventory with per-provider probe actions
  - OS startup enable / disable
- Start / restart / stop controls for the local router
- `Open Config File` buttons for detected editors like VS Code, Sublime, Cursor, TextEdit/default app, and other common local editors

Useful flags:

```bash
llm-router web --port=9090
llm-router web --open=false
```

Notes:
- The web console is localhost-only by default because it exposes live config editing, including secrets.
- The web console runs as a separate service from the local router. Closing the UI does not stop the router service.
- `yarn dev` hot-reloads the browser UI and restarts the local router service when router source files change.
- If the config file contains invalid JSON, validation surfaces the parse error and save/probe/start actions stay guarded until the JSON is repaired.
- When the web console patches Codex CLI, it writes a generated `model_catalog_json` for both alias bindings and direct managed route refs like `provider/model`, which avoids Codex fallback metadata warnings for managed routes.

## Start Local Server

```bash
llm-router start
```

The local router endpoint is fixed to `http://127.0.0.1:8376`.

Local endpoints:
- Unified: `http://127.0.0.1:8376/route`
- Anthropic-style: `http://127.0.0.1:8376/anthropic`
- OpenAI-style: `http://127.0.0.1:8376/openai`
- OpenAI legacy completions: `http://127.0.0.1:8376/openai/v1/completions`
- OpenAI Responses-style: `http://127.0.0.1:8376/openai/v1/responses` (Codex CLI-compatible)
- AMP OpenAI-style: `http://127.0.0.1:8376/api/provider/openai/v1/chat/completions`
- AMP Anthropic-style: `http://127.0.0.1:8376/api/provider/anthropic/v1/messages`
- AMP OpenAI Responses-style: `http://127.0.0.1:8376/api/provider/openai/v1/responses`

## Connect your coding tool

After setting master key, point your app/agent to local endpoint and use that key as auth token.

Claude Code example (`~/.claude/settings.local.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8376",
    "ANTHROPIC_AUTH_TOKEN": "gw_your_gateway_key",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "provider_name/model_name_1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "provider_name/model_name_2",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "provider_name/model_name_3"
  }
}
```

## AMP CLI / AMP Code

`llm-router` can now accept AMP provider-path requests and route them into your configured local models.

### Quick AMP setup in the TUI

Recommended flow for non-expert users:

1. Run `llm-router`
2. Open `AMP`
3. Choose `Quick setup`
4. Pick where AMP should be patched:
   - `This workspace` for only the current repo
   - `All projects` for your global AMP config
5. Confirm the local `llm-router` URL and API key
6. Pick one default route such as `chat.default` or `provider/model`
7. `Save and exit`

That is enough to make AMP send requests to `llm-router`.

After that, if you want AMP modes like `smart`, `rush`, `deep`, or `oracle` to use different llm-router aliases/models:

1. Open `AMP`
2. Choose `Common AMP routes`
3. Pick the AMP route you want to customize
4. Pick the llm-router alias/model to use
5. Save

The `Advanced` menu is where the older, more detailed AMP controls now live:

- upstream / proxy settings
- legacy model-pattern mappings
- legacy subagent definitions and mappings

Recommended config snippet in `~/.llm-router.json`:

```json
{
  "masterKey": "gw_your_gateway_key",
  "defaultModel": "chat.default",
  "amp": {
    "upstreamUrl": "https://ampcode.com",
    "upstreamApiKey": "amp_upstream_api_key",
    "restrictManagementToLocalhost": true,
    "preset": "builtin",
    "defaultRoute": "chat.default",
    "routes": {
      "smart": "chat.smart",
      "rush": "chat.fast",
      "deep": "chat.deep",
      "oracle": "chat.oracle",
      "librarian": "chat.research",
      "review": "chat.review",
      "@google-gemini-flash-shared": "chat.tools",
      "painter": "image.default"
    },
    "rawModelRoutes": [
      { "from": "gpt-*-codex*", "to": "chat.deep" }
    ],
    "overrides": {
      "entities": [
        {
          "id": "reviewer",
          "type": "feature",
          "match": ["gemini-4-pro*"],
          "route": "chat.review"
        }
      ]
    },
    "fallback": {
      "onUnknown": "default-route",
      "onAmbiguous": "default-route",
      "proxyUpstream": true
    }
  }
}
```

Notes:
- `amp` is the normalized config key. Input aliases `ampcode` and `amp-code` are also accepted.
- `amp.routes` is the new main user-facing mapping surface. Keys can be friendly AMP entities like `smart`, `rush`, `oracle`, `review`, `title`, or shared signatures like `@google-gemini-flash-shared`.
- `amp.defaultRoute` is AMP-specific fallback and is checked before the global `defaultModel`.
- `amp.rawModelRoutes` is the new-schema escape hatch for raw model-name matching when entity/signature routing is not enough.
- `amp.overrides` lets users add or update entity/signature detection without editing the built-in preset in code.
- `amp.preset=builtin` enables the shipped AMP catalog. Set `amp.preset=none` to disable built-in entity/signature detection entirely.
- Shared signatures exist because some AMP helpers currently share the same observed model family, such as `rush` + `title` on Haiku and `search` + `look-at` + `handoff` on Gemini Flash.
- AMP model matching now canonicalizes display-style names like `Claude Opus 4.6`, `GPT-5.3 Codex`, and `Gemini 3 Flash` before matching.
- Legacy AMP fields are still supported for backward compatibility: `amp.modelMappings`, `amp.subagentMappings`, `amp.subagentDefinitions`, and `amp.forceModelMappings`.
- When any new AMP schema fields are present (`preset`, `defaultRoute`, `routes`, `rawModelRoutes`, `overrides`, `fallback`), the new AMP resolver path is used. Otherwise legacy AMP routing behavior is preserved.
- Bare AMP model names like `gpt-4o-mini` are matched against configured local `model.id` and `model.aliases` automatically.
- If no local match is found and `amp.upstreamUrl` is set, `llm-router` proxies the request upstream to AMP.
- AMP management/auth routes (`/api/auth`, `/threads`, `/docs`, `/settings`, etc.) proxy through the configured AMP upstream and reuse your `masterKey` as the local gateway auth token.
- AMP Google `/api/provider/google/v1beta/...` requests are translated locally into OpenAI-compatible chat requests, including Gemini model listing, `generateContent`, and `streamGenerateContent`.
- `llm-router config --operation=set-amp-config` supports both the new AMP schema flags and the legacy AMP flags. The interactive wizard now leads with `Quick setup`, `Default AMP route`, and `Common AMP routes`, while the older mapping controls live under `Advanced`.
- If the AMP upstream API key is not found in local AMP config/secrets, the wizard tells you to open `https://ampcode.com/settings` and paste the key into `llm-router`.
- Developer notes and architecture details live in `docs/amp-routing.md`.

You can also configure the AMP block non-interactively:

```bash
llm-router config --operation=set-amp-config \
  --amp-upstream-url=https://ampcode.com \
  --amp-upstream-api-key=amp_... \
  --amp-default-route=chat.default \
  --amp-routes="smart => chat.smart, rush => chat.fast, @google-gemini-flash-shared => chat.tools" \
  --amp-raw-model-routes="gpt-*-codex* => chat.deep"
```

Legacy-compatible CLI example:

```bash
llm-router config --operation=set-amp-config \
  --amp-force-model-mappings=true \
  --amp-subagent-definitions="oracle => /^gpt-\d+(?:\.\d+)?$/, planner => gpt-6*" \
  --amp-model-mappings="* => rc/gpt-5.3-codex" \
  --amp-subagent-mappings="oracle => rc/gpt-5.3-codex, planner => rc/gpt-5.3-codex"
```

To reset custom AMP subagent names/patterns back to the built-in defaults:

```bash
llm-router config --operation=set-amp-config --reset-amp-subagent-definitions=true
```

To patch AMP so it points at your local `llm-router` without editing AMP files manually:

```bash
llm-router config --operation=set-amp-config \
  --patch-amp-client-config=true \
  --amp-client-settings-scope=workspace \
  --amp-client-url=http://127.0.0.1:8376
```

When you run the patch flow on a config that does not already have AMP routing configured, `llm-router` now bootstraps a safe default AMP setup automatically:

- patches AMP client `amp.url` + the local gateway API key entry
- sets `amp.preset=builtin`
- sets `amp.defaultRoute` to your current `defaultModel` (or the first configured provider/model)
- enables `amp.restrictManagementToLocalhost=true`
- auto-discovers `amp.upstreamApiKey` for `https://ampcode.com` from AMP secrets when available

That means a normal existing config with `defaultModel`, providers, and `masterKey` can usually patch AMP and start using a single default local model immediately.

Then customize AMP behavior later without re-patching the AMP client:

```bash
llm-router config --operation=set-amp-config \
  --amp-default-route=chat.default \
  --amp-routes="smart => chat.smart, rush => chat.fast, deep => chat.deep, oracle => chat.oracle"
```

AMP client file locations used by the wizard/patch flow:
- global settings: `~/.config/amp/settings.json`
- workspace settings: `.amp/settings.json`
- secrets: `~/.local/share/amp/secrets.json`

When patching AMP client files, `llm-router` only updates or adds:
- `amp.url` in `settings.json`
- `apiKey@<endpoint-url>` in `secrets.json`

All other existing AMP settings/secrets fields are preserved. Missing files/directories are created automatically.

Reusable local smoke test:

```bash
npm run test:amp-smoke
```

The smoke suite clones your current `~/.llm-router.json`, auto-discovers your AMP upstream key from local AMP secrets, forces all AMP traffic to `rc/gpt-5.3-codex`, runs headless AMP execute-mode checks (`smart`, `rush`, `deep`, plus an Oracle-style prompt), captures the raw inbound AMP `model` labels seen by `llm-router`, verifies each observed label still resolves through the current AMP matcher, and writes reusable logs/artifacts to a temp directory.

Key artifacts in the output directory:

- `router-log.jsonl`: full inbound + upstream request log
- `observed-models.json`: unique live AMP model labels grouped by case with resolver checks
- `summary.json`: top-level smoke results plus observed-model summary

Suggested AMP client setup:

`~/.config/amp/settings.json`

```json
{
  "amp.url": "http://127.0.0.1:8376"
}
```

`~/.local/share/amp/secrets.json`

```json
{
  "apiKey@http://127.0.0.1:8376": "gw_your_gateway_key"
}
```

Or use environment variables:

```bash
export AMP_URL=http://127.0.0.1:8376
export AMP_API_KEY=gw_your_gateway_key
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
- Prereleases are published with explicit beta versions such as `2.0.0-beta.0`; pin them intentionally instead of treating them as stable upgrades.
