# LLM Router

A unified LLM gateway that routes requests across multiple providers through a single endpoint. Supports both OpenAI and Anthropic-compatible formats. Manage everything via Web UI or CLI — optimized for AI agents.

![LLM Router Web Console](./assets/screenshots/web-ui-dashboard.png)

## Install

```bash
npm i -g @khanglvm/llm-router@latest
```

## Quick Start

```bash
llr          # open Web UI
llr start    # start the local gateway
llr ai-help  # agent-oriented setup brief
```

1. Open the Web UI and add a provider (API key or OAuth login). Built-in provider presets prefill the usual endpoint and starter models.
2. Create model aliases with routing strategy
3. Start the gateway and point your tools at the local endpoint

## What You Can Do

- **Add & manage providers** — connect any OpenAI/Anthropic-compatible API endpoint, start from built-in provider presets, test connectivity, auto-discover models
- **Unified endpoint** — one local gateway that accepts both OpenAI and Anthropic request formats
- **Model aliases with routing** — group models into stable alias names with weighted round-robin, quota-aware balancing, and automatic fallback
- **Rate limiting** — set request caps per model or across all models over configurable time windows
- **Coding tool routing** — one-click routing config for Codex CLI, Claude Code, Factory Droid, and AMP
- **Dev sandbox** — `yarn dev` runs the console against a dedicated dev config/router port, highlights dev mode in terminal + UI, can clone the production config into the sandbox for quick iteration, and automatically reclaims stale dev listeners before the next session starts
- **Claude native web tools** — local handling for Claude web search and page fetch requests, with selectable Claude Code web-search providers from the shared Web Search config
- **Seamless local updates** — `llr update` keeps the fixed local router endpoint online, drains in-flight requests, and automatically retries through backend restart windows
- **Web search** — built-in web search for AMP and other router-managed tools
- **Deployable** — run locally or deploy to Cloudflare Workers
- **AI-agent friendly** — full CLI parity with `llr config --operation=...` so agents can configure everything programmatically

## Local Models

Open `llr` and use the **Local Models** tab to manage local inference sources alongside hosted providers.

- **`llama.cpp` runtime** — detect or point at a local `llama-server`, attach GGUF files in place, or download public GGUF artifacts into the router-managed library under `~/.llm-router/local-models`
- **Native macOS browsing** — use the built-in file picker to choose a single GGUF file, scan a folder recursively for GGUF models, or browse directly to a local `llama-server` binary
- **Managed + attached model library** — stale or moved files stay visible instead of crashing the app, and can be repaired by locating the file again or removed cleanly
- **Router-visible local variants** — create friendly model variants with bounded presets, context-window metadata, preload toggles, and Mac unified-memory fit guidance with clearer safe/tight recommendations
- **Alias-ready local routing** — once saved, local variants behave like normal router models and can be used in aliases, capability flags, and fallback chains

For v1, the managed download flow only searches public Hugging Face GGUF files and the fit guidance is tuned for Macs with unified memory.

## Local Runtime Reliability

`llr start` keeps a small supervisor bound to the fixed local router port and runs the real router backend behind it on an internal loopback port.

That means `llr update` can install a new package version and gracefully swap the backend without breaking active CLI or tool requests. Requests that arrive during the short backend handoff are deferred and retried automatically instead of failing immediately. The Web UI may reconnect during that window, but router-managed API traffic keeps the same public local endpoint.

## Development Sandbox

```bash
yarn dev
```

Development mode uses the dedicated `~/.llm-router-dev.json` config and its own local router port so it can run alongside a startup-managed or manually started production router. The terminal and Web UI both show a dev-mode indicator, the dev Web UI includes a one-click sync action to copy the current production config into the sandbox without changing the dev router binding, and each new `yarn dev` run automatically takes over any stale dev web-console/router listeners from a prior session.

## Web UI

### Alias & Fallback

Create stable route names across multiple providers with balancing and failover.

![Alias & Fallback](./assets/screenshots/web-ui-aliases.png)

### AMP (Beta)

Route AMP-compatible requests through LLM Router with custom model mapping.

![AMP Configuration](./assets/screenshots/web-ui-amp.png)

### Codex CLI

Route Codex CLI requests through the gateway with model override and thinking level.

![Codex CLI Routing](./assets/screenshots/web-ui-codex-cli.png)

### Claude Code

Route Claude Code through the gateway with per-tier model bindings.

![Claude Code Routing](./assets/screenshots/web-ui-claude-code.png)

Claude Code can also select a shared Web Search provider or hosted search route from the router config. When Claude-compatible traffic uses native web-search or page-fetch tools, LLM Router can satisfy those calls through the selected shared web-search provider instead of relying on upstream-native web tooling.

### Factory Droid

Route Factory Droid through the gateway via a managed custom model entry with reasoning effort control.
LLM Router injects router-managed `customModels` entries for aliases and provider/model routes, then writes Factory defaults as `custom:llm-*` IDs so Droid selects the custom provider entry instead of a native built-in model with the same name.

### Web Search

Configure search providers for AMP and other router-managed tools.

![Web Search](./assets/screenshots/web-ui-web-search.png)

## AMP (Beta)

> AMP support is in beta. Features and API surface may change.

LLM Router can front AMP-compatible routes locally and proxy unresolved traffic upstream. Configure via the Web UI or CLI:

```bash
llr config --operation=set-amp-client-routing --enabled=true --amp-client-settings-scope=workspace
```

## Subscription Providers

OAuth-backed subscription login is supported for ChatGPT.

> **Note:** ChatGPT subscriptions are separate from the OpenAI API and intended for use within OpenAI's own apps. Using them here may violate OpenAI's terms of service.

## Links

- [Changelog](https://github.com/khanglvm/llm-router/blob/master/CHANGELOG.md)
- [Security](https://github.com/khanglvm/llm-router/blob/master/SECURITY.md)
- [AMP Routing Docs](https://github.com/khanglvm/llm-router/blob/master/assets/amp-routing.md)
