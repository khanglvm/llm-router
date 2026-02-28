# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
