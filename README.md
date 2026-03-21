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

1. Open the Web UI and add a provider (API key or OAuth login)
2. Create model aliases with routing strategy
3. Start the gateway and point your tools at the local endpoint

## What You Can Do

- **Add & manage providers** — connect any OpenAI/Anthropic-compatible API endpoint, test connectivity, auto-discover models
- **Unified endpoint** — one local gateway that accepts both OpenAI and Anthropic request formats
- **Model aliases with routing** — group models into stable alias names with weighted round-robin, quota-aware balancing, and automatic fallback
- **Rate limiting** — set request caps per model or across all models over configurable time windows
- **Coding tool routing** — one-click routing config for Codex CLI, Claude Code, and AMP
- **Web search** — built-in web search for AMP and other router-managed tools
- **Deployable** — run locally or deploy to Cloudflare Workers
- **AI-agent friendly** — full CLI parity with `llr config --operation=...` so agents can configure everything programmatically

## Web UI

![Alias & Fallback](./assets/screenshots/web-ui-aliases.png)
*Alias & Fallback — create stable route names across multiple providers with balancing and failover*

![AMP Configuration](./assets/screenshots/web-ui-amp.png)
*AMP (Beta) — route AMP-compatible requests through LLM Router with custom model mapping*

![Codex CLI Routing](./assets/screenshots/web-ui-codex-cli.png)
*Codex CLI — route Codex CLI requests through the gateway with model override and thinking level*

![Claude Code Routing](./assets/screenshots/web-ui-claude-code.png)
*Claude Code — route Claude Code through the gateway with per-tier model bindings*

![Web Search](./assets/screenshots/web-ui-web-search.png)
*Web Search — configure search providers for AMP and other router-managed tools*

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
- [AMP Routing Docs](./docs/amp-routing.md)
