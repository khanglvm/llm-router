# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
