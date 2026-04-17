# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.3.4] - 2026-04-17

### Fixed
- Updated the live provider suite to exercise RamCloud with `minimax-m2.7` only and switched the Claude Code live alias from `normal` to `default`, matching the generated router config so real-provider publish checks pass again.

## [2.3.3] - 2026-04-17

### Fixed
- Prevented repeated failed OpenAI `/v1/chat/completions` tool-routing attempts for Claude Code requests on dual-format Claude routes by respecting model format preferences and suppressing noisy re-tries after a successful Claude fallback.

## [2.3.2] - 2026-04-17

### Fixed
- Web UI provider presets now correctly populate the Endpoints field during add-provider setup when the current value is still empty or still on a prior preset default, while preserving any manually entered endpoint or API key values.

## [2.3.0] - 2026-03-24

### Added
- **Factory Droid routing** — one-click routing config for Factory Droid via Web UI, CLI (`set-factory-droid-routing`), and automatic sync. Injects a managed `customModels` entry into `~/.factory/settings.json` with backup/restore support, default model binding, and reasoning effort control (off, none, low, medium, high).

## [2.2.0] - 2026-03-21

### Added
- Standalone `set-claude-code-effort-level` CLI operation sets `CLAUDE_CODE_EFFORT_LEVEL` in Claude Code settings and shell profile without requiring a router connection.
- Web console effort level dropdown now works independently of routing — no need to connect Claude Code to LLM Router just to change thinking effort.

### Changed
- Claude Code live test uses process env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`) instead of patching settings.json, keeping the config file untouched during tests.

## [2.0.5] - 2026-03-15

### Fixed
- Relaxed the live coding-tool publish checks so known external Codex model-verbosity mismatches and Claude MCP schema-validation failures are treated as acceptable upstream tool failures instead of blocking npm publication.

## [2.0.4] - 2026-03-15

### Fixed
- Raised the default inbound JSON body limit for OpenAI `/responses` requests from `1 MiB` to `8 MiB` while keeping other JSON routes at `1 MiB`. This prevents local `413 Request body too large` failures for Codex CLI and other Responses API clients carrying larger conversation state.
- Updated the web console provider editor so API-based providers can rotate between env-backed and direct API key credentials in place without leaving the modal.
- Improved the web console model-save flow for API-based providers:
  - new-model tests now stream visible progress while save is in flight
  - successful new models stay marked as confirmed
  - only failed new models are marked as failed
  - the edit modal blocks backdrop/close dismissal while tests are running
  - closing after failed tests now offers removing failed rows while keeping successful new rows
- Improved dual-format Claude provider routing so Claude tool calls can prefer OpenAI-compatible tool execution paths when available, while falling back cleanly to native Claude routing if the OpenAI-compatible path fails.

## [2.0.1] - 2026-03-15

### Fixed
- Fixed alias-route failover after transient upstream failures. When every candidate on a route was only in cooldown, the balancer now retries the earliest-recovering candidate instead of returning `No eligible providers remain for route ...`.

## [2.0.0] - 2026-03-15

### Changed
- Promoted the 2.x operator surface to the official stable `2.0.0` release.
- Rebranded the user-facing CLI/docs name to `LLM Router` with `llr` as the primary command while keeping the published package scope as `@khanglvm/llm-router`.
- Updated README and CLI help/examples to use the new branding and command.
- Expanded the CLI management surface so agents can validate config state, inspect runtime/tool state (`validate`, `snapshot`, `tool-status`), reclaim the fixed local router port, run standalone provider diagnostics, and patch Codex CLI / Claude Code / AMP client routing without depending on the web console.
- Updated `llr ai-help` and local agent instructions to prefer first-party CLI commands for validation, router recovery, coding-tool routing, and router inspection.

### Removed
- Removed prerelease release notes from the main public docs surface for the stable `2.0.0` release.
- Removed the deprecated TUI entry flow from the supported operator surface and from the real-provider live suite coverage.

## [2.0.0-beta.2] - 2026-03-13

### Changed
- Rebranded the user-facing CLI/docs name to `LLM Router` with `llr` as the primary command while keeping the published package scope as `@khanglvm/llm-router`.
- Updated README and CLI help/examples to use the new branding and command.
- Expanded the CLI management surface so agents can validate config state, inspect runtime/tool state (`validate`, `snapshot`, `tool-status`), reclaim the fixed local router port, run standalone provider diagnostics, and patch Codex CLI / Claude Code / AMP client routing without depending on the web console.
- Updated `llr ai-help` and local agent instructions to prefer first-party CLI commands for validation, router recovery, coding-tool routing, and router inspection.

### Removed
- Removed the deprecated TUI entry flow from the supported operator surface and from the real-provider live suite coverage.

## [2.0.0-beta.1] - 2026-03-11

### Fixed
- Fixed global npm installs of the `2.0.0-beta` web console entrypoint. Bare `llm-router` / `llm-router config` no longer import the dev-only `esbuild` asset builder on normal runtime startup, so published installs work without devDependencies.

## [2.0.0-beta.0] - 2026-03-11

### Beta
- Published this release as `2.0.0-beta.0` because it introduces large routing and operator-surface changes. Expect regressions while it is validated before the stable `2.0.0` release.

### Added
- Added AMP CLI / AMP Code compatibility routes:
  - `/api/provider/openai/v1/chat/completions`
  - `/api/provider/openai/v1/completions`
  - `/api/provider/openai/v1/responses`
  - `/api/provider/anthropic/v1/messages`
- Added a local-only real-provider test suite for CLI, TUI, and web-console flows:
  - isolated temp HOME/config/runtime-state handling so live tests do not mutate the developer's normal `~/.llm-router*` files
  - real provider discovery/probe coverage through the web-console APIs
  - browser-bundle render coverage for the web console via jsdom
  - `npm run test:provider-live` (with `test:provider-smoke` kept as an alias)
- Added AMP-aware runtime config block with local bare-model matching and explicit model rewrites:
  - `amp.upstreamUrl`
  - `amp.upstreamApiKey`
  - `amp.restrictManagementToLocalhost`
  - `amp.forceModelMappings`
  - `amp.modelMappings`
- Added AMP upstream proxy handling for management/auth routes and unresolved AMP provider requests.
- Added AMP Gemini/Google compatibility bridging for local `models`, `generateContent`, and `streamGenerateContent` routes.
- Added `llm-router config --operation=set-amp-config` AMP wizard for upstream/proxy settings, mode/model mappings, editable subagent definitions/mappings, and AMP client file patching.
- Added AMP subagent mapping support with local default-model fallback for unmapped specialized/system agents.
- Added editable `amp.subagentDefinitions` support so AMP agent ids/model-pattern bindings can be renamed, added, removed, cleared, or reset to built-in defaults without breaking local fallback routing.
- Added focused runtime tests covering AMP route parsing, local resolution, upstream fallback, Gemini translation, and `/openai/v1/responses` provider dispatch.
- Added reusable `npm run test:amp-smoke` local AMP E2E smoke suite that clones local config, starts a local handler server, runs headless AMP modes, and records router/CLI logs.

### Changed
- Extended provider URL resolution so OpenAI-compatible providers can receive `/v1/completions` and `/v1/responses` requests instead of always forcing `/v1/chat/completions`.
- Updated README with AMP wizard flow, AMP client patching behavior/file locations, upstream key guidance via `https://ampcode.com/settings`, editable subagent definition flow, reset behavior, and local Gemini bridge behavior.

### Fixed
- Fixed Codex CLI global-route patching to generate `model_catalog_json` metadata for direct managed route refs like `provider/model`, and to keep that catalog synced when managed route refs are renamed. This avoids Codex fallback metadata warnings for direct route bindings such as `rc/gpt-5.4`.

## [1.3.1] - 2026-03-05

### Changed
- Upgraded `@levu/snap` dependency to `^0.3.13`:
  - TUI `Esc` now defaults to stepping back to previous workflow step.
  - On root step, `Esc` still exits.
- Added compliance warning in interactive provider setup: using provider resources through `llm-router` may violate provider terms; users are solely responsible for compliance.

## [1.3.0] - 2026-03-05

### Added
- Added Claude Code OAuth subscription provider support end-to-end:
  - new subscription type: `claude-code`
  - Claude OAuth constants and runtime request config (`anthropic-beta`, OAuth token endpoint, Claude messages endpoint)
  - default Claude subscription model seed list for new subscription providers
- Added CLI support for Claude subscription auth operations:
  - `llm-router subscription login --subscription-type=claude-code`
  - `llm-router subscription logout --subscription-type=claude-code`
  - `llm-router subscription status --subscription-type=claude-code`
- Added runtime and CLI test coverage for Claude subscription request translation/headers and setup flows.

### Changed
- Updated subscription probe and provider upsert flow to build type-specific probe payloads:
  - ChatGPT Codex keeps Responses/Codex probe shape
  - Claude Code uses Claude messages probe shape
- Updated subscription config normalization/workflows so default format and model seed list are selected by `subscriptionType`.
- Updated README and CLI help text/examples to document both supported OAuth subscription types (`chatgpt-codex`, `claude-code`).

### Fixed
- Fixed new Claude subscription provider creation default model seeding to correctly use Claude defaults instead of ChatGPT defaults.

## [1.2.0] - 2026-03-04

### Added
- Added Codex Responses API compatibility layer:
  - request transformation into Codex Responses payload shape
  - response transformation from Codex responses/SSE events to OpenAI Chat Completions-compatible output
  - dedicated runtime tests for request + response transformation coverage
- Added explicit project-level ignore for local `AGENTS.md`.

### Changed
- Improved TUI/CLI operation reports to user-friendly structured layouts and tables across provider/model-alias/rate-limit/config flows and operational actions.
- Improved startup/deploy/worker-key/status outputs to avoid raw config variable style and show friendly fields.
- Updated subscription auth/provider flow behavior and tests for more robust OAuth/Codex subscription handling.

### Fixed
- Fixed migration/reporting test expectations and summary rendering stability after report format refactor.

## [1.1.1] - 2026-03-04

### Fixed
- Upgraded `@levu/snap` to `^0.3.12`, which declares the missing runtime dependency `picocolors`.
- Fixes global-install runtime error:
  - `Cannot find package 'picocolors' imported from .../@levu/snap/dist/...`

## [1.1.0] - 2026-03-04

### Added
- Added full `config --operation=upsert-provider` UX support for subscription providers:
  - `--type=subscription`
  - `--subscription-type=chatgpt-codex`
  - `--subscription-profile=<name>`
- Added subscription provider coverage tests for config workflows and runtime provider-call behavior.
- Added `.gitignore` rules for local IDE and deploy temp artifacts (`.idea/`, `.llm-router.deploy.*.wrangler.toml`).

### Changed
- Updated config summaries and AI-help guidance to include subscription provider details and setup commands.
- Updated README setup guide with explicit ChatGPT Codex subscription onboarding flow.

### Fixed
- Fixed subscription status command import path so `llm-router subscription status` works reliably.
- Fixed subscription provider request path to run standard request translation/mapping before OAuth-backed provider call.
- Fixed subscription provider config validation and normalization:
  - subscription providers no longer require `baseUrl`
  - predefined ChatGPT Codex model list is enforced during normalization.

## [1.0.9] - 2026-03-03

### Added
- Added dedicated modules for Cloudflare API preflight checks and Wrangler TOML target handling.
- Added runtime policy and route-debug helpers so stateful routing can be safely disabled by default on Cloudflare Worker.
- Added reusable timeout-signal utility and start-command port reclaim utilities with test coverage.

### Changed
- Refactored CLI deploy/runtime handler code into focused modules with cleaner boundaries.
- Updated provider-call timeout handling to support both `AbortSignal.timeout` and `AbortController` fallback.
- Documented Worker safety defaults and switched README release/security links to canonical GitHub URLs.
- Added local start port resolution via `--port`, `LLM_ROUTER_PORT`, or generic `PORT` env variables.

## [1.0.8] - 2026-02-28

### Changed
- Added focused npm `keywords` metadata in `package.json` to improve package discoverability.

## [1.0.7] - 2026-02-28

### Added
- Added `llm-router ai-help` to generate an agent-oriented operating guide with live gateway checks and coding-tool patch instructions.
- Added tests covering `ai-help` discovery output and first-run setup guidance.

### Changed
- Rewrote `README.md` into a shorter setup and operations guide focused on providers, aliases, rate limits, and local/hosted usage.

## [1.0.6] - 2026-02-28

### Added
- Added a formal changelog for tracked, versioned releases.
- Added npm package publish metadata to keep public publish defaults explicit.

### Changed
- Added an explicit package `files` whitelist so npm publishes are predictable.
- Updated release workflow docs in `README.md` to require changelog + version updates before publish.

## [1.0.5] - 2026-02-27

### Fixed
- Hardened release surface and added `.npmignore` coverage for safer package publishes.

## [1.0.4] - 2026-02-26

### Changed
- Refined README guidance for routing and deployment usage.

## [1.0.3] - 2026-02-26

### Changed
- Simplified project positioning and gateway copy in docs.

## [1.0.2] - 2026-02-26

### Changed
- Documented smart fallback behavior and operational expectations.

## [1.0.1] - 2026-02-25

### Changed
- Improved fallback strategy behavior and released patch update.

## [1.0.0] - 2026-02-25

### Added
- Initial `llm-router` route release with local + Cloudflare Worker gateway flows.
