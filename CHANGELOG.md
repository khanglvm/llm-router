# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.9] - 2026-03-03

### Added
- Added dedicated modules for Cloudflare API preflight checks and Wrangler TOML target handling.
- Added runtime policy and route-debug helpers so stateful routing can be safely disabled by default on Cloudflare Worker.
- Added reusable timeout-signal utility and start-command port reclaim utilities with test coverage.

### Changed
- Refactored CLI deploy/runtime handler code into focused modules with cleaner boundaries.
- Updated provider-call timeout handling to support both `AbortSignal.timeout` and `AbortController` fallback.
- Documented Worker safety defaults and switched README release/security links to canonical GitHub URLs.

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
