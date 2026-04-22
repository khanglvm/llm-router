# Local Models Design

**Date:** 2026-04-22  
**Status:** Proposed  
**Scope:** Add first-class local model management to the LLM Router web console, with `llama.cpp` runtime support, managed Hugging Face GGUF downloads, attached external GGUFs, variant management, and Mac unified-memory guidance.

## Goal

Add a new `Local Models` area to the LLM Router web UI so users can manage local inference sources in one place, starting with existing Ollama support plus new native `llama.cpp` support. Local variants must behave like ordinary router models after creation: users can target them from aliases, assign capability toggles, set context windows, and use them in the same routing flows as hosted provider models.

The design must keep the router stable when local files move or disappear, support fire-and-forget usage, and fit the current `llr` dashboard workflow where users revisit the web console to adjust runtime and routing configuration.

## Product Decisions

### Top-level UI

Add a new top-level navbar/tab named `Local Models`.

This avoids creating a second source-specific top-level destination next to existing Ollama support. `Local Models` becomes the umbrella for local inference systems, while source-specific sections remain visible inside that tab.

Initial sections under `Local Models`:
- `Overview`
- `llama.cpp`
- `Ollama`

### Runtime ownership

Use a hybrid runtime model for `llama.cpp`.

The router should manage local `llama.cpp` runtime lifecycle, but not install or upgrade `llama.cpp` itself in v1.

Owned by router:
- detect available `llama-server` instances/commands
- validate the selected runtime target
- start/stop/restart the runtime
- optionally start runtime when router starts
- load/unload selected local variants when supported by the active source runtime
- preload selected variants when runtime starts

Not owned by router in v1:
- build or install `llama.cpp`
- auto-upgrade `llama.cpp`
- force one distribution method or fork

This supports stock `llama.cpp`, Homebrew installs, custom builds, and future specialized forks without locking the product into runtime installation logic.

### Model inventory structure

Separate base local models from router-facing variants.

Base model inventory is used to track downloaded or attached assets. Variants are the user-facing router models.

Base local models:
- represent downloaded or attached GGUFs, or source-local Ollama models
- carry file/source metadata and availability state
- are not directly used in aliases or routing

Variants:
- are created from base local models
- have editable name and model id
- become normal router models once saved
- can be enabled, preloaded, or marked stale independently through inherited base-model state

### Acquisition methods

Support both acquisition paths for `llama.cpp` base models:
- managed public Hugging Face GGUF downloads
- attached existing GGUF files or directories from disk

Managed downloads are stored under a router-owned directory.
Attached models retain their original path and are not copied.

### Failure tolerance

If a model path disappears, do not delete config automatically and do not crash the app.

Instead:
- mark the base model as `stale`
- mark its variants as `stale`
- keep aliases and other references intact
- offer recovery actions:
  - `Locate model`
  - `Remove model`

The same tolerance should apply to stale runtime targets. If the selected `llama-server` path disappears, keep the runtime config and show a clear recovery path.

### Scope of Hugging Face support

v1 supports only public Hugging Face repositories and files.
No gated or private token flow in this version.

### Platform scope

Mac with unified memory gets fit guidance and capacity enforcement in v1.

The UI can still render on other platforms, but “fits this system” recommendations and enforcement are scoped to macOS unified-memory systems in the first version.

## User Experience

## 1. Local Models Overview

The `Overview` section provides a concise operational summary.

It should show:
- runtime status summary for `llama.cpp` and `Ollama`
- enabled local variants count
- preloaded local variants count
- aggregate local-capacity status
- stale assets count
- quick links into `llama.cpp` and `Ollama`

This section is not the main editing surface. It is a dashboard summary that makes local-model health visible at a glance.

## 2. llama.cpp Section

The `llama.cpp` section is the main new UI surface.

It should contain four functional areas:
- runtime
- library
- variants
- capacity

### Runtime area

The runtime area configures and controls the selected `llama.cpp` backend. v1 should manage one selected `llama.cpp` runtime target per router config, not multiple concurrent `llama.cpp` runtimes.

Controls:
- discovered runtime dropdown
- `Manual path or command…` option
- browse/select fallback for local path
- validation result
- runtime host/port
- `Start with router`
- `Start`
- `Stop`
- `Restart`

The runtime selector should prefer auto-detected candidates. Manual entry is a fallback, not the default path.

Dropdown behavior:
- list discovered `llama-server` candidates first
- show descriptive labels such as source or path
- include a final manual option
- if current selection becomes invalid, keep it selected and mark it stale rather than silently clearing it

Runtime status values:
- `Running`
- `Stopped`
- `Invalid runtime`
- `Stale runtime`
- `Needs validation`

### Library area

The library area manages base `llama.cpp` models.

Acquisition actions:
- `Download from Hugging Face`
- `Attach from disk`

Library rows show:
- base model name
- source (`Managed` or `Attached`)
- quant / file summary
- capability snapshot if available
- context metadata if available
- availability badge (`Available`, `Stale`, `Invalid`, `Missing`)
- actions:
  - `Create variant`
  - `Locate model` when stale
  - `Remove`

Managed and attached models share one inventory table. The distinction is represented by badges and available actions.

### Hugging Face download modal

The download experience should search public GGUF artifacts and present actual downloadable model files, not just repository names.

Each result row should show:
- model/repo label
- GGUF filename
- quantization identifier where available
- file size
- compatibility badges such as `GGUF`, `Mac OK`, `llama.cpp OK`
- fit state for the current Mac

Rows that are known not to fit or not to be supported should remain visible but disabled with an explicit reason.

Examples:
- `Too large for this Mac`
- `Not a GGUF file`
- `Unsupported file layout for v1`

This approach improves user guidance without hiding useful discovery context.

### Attach flow

The attach flow should support:
- selecting a GGUF file directly
- selecting a folder to scan for GGUF files

Attached models are indexed in place. The app stores their path and metadata snapshot, but does not copy or move the file.

If the file later disappears:
- keep the record
- mark it stale
- surface recovery and removal actions

### Variants area

Variants are the router-facing local models.

Each variant belongs to one base local model and contains user-editable identity and runtime config.

Variant rows show:
- name
- model id
- base model link
- source runtime (`llama.cpp` or `Ollama`)
- enabled state
- preload state
- runtime state (`Loaded`, `Unloaded`, `Stopped`, `Stale`, `Over capacity`)
- actions such as `Edit`, `Load`, `Unload`, `Duplicate`, `Remove`

### Create/Edit variant modal

This modal should be guided and user-friendly, not raw JSON.

Fields:
- base model
- source runtime
- variant name
- model id
- preset
- context length
- capability toggles
- enabled in router
- preload on runtime/router start
- source-specific advanced settings

Default values should be pre-computed from the base model and chosen preset, but the user can edit both name and model id.

Duplicate handling:
- validate model id uniqueness the same way current router model-id editing works
- validate variant naming conflicts for local-model clarity
- never silently rewrite user edits

Preset options for `llama.cpp`:
- `Balanced`
- `Long Context`
- `Low Memory`
- `Fast Response`

Preset application should seed bounded control values, not lock them permanently.

### Runtime load/unload behavior

Variants should expose runtime actions when the active source runtime supports them. For `llama.cpp`, the product should present model-level load, unload, and preload controls in the UI even if the backend implementation is mediated through server-side model management rather than direct file ownership by the router.

User-visible actions:
- `Load`
- `Unload`
- `Preload on startup`

If the runtime is stopped, variants remain configured but display a stopped/unavailable runtime state.

## 3. Ollama Section

Move existing Ollama controls under `Local Models` without fundamentally changing Ollama behavior in the first pass.

The goal is not to rewrite Ollama support immediately, but to align language and shared concepts so users see a unified local-model product surface.

Shared concepts to align when practical:
- enabled local model/variant state
- preload/autoload language
- availability badges
- stale/unavailable treatment where relevant

Source-specific workflows remain separate:
- Ollama install/pull stays Ollama-specific
- Hugging Face GGUF search/download stays `llama.cpp`-specific in v1

## Routing and Alias Integration

Once a local variant is saved, it must behave like a normal router model everywhere else.

That means:
- it is selectable in model aliases
- it can carry context window information
- it can use existing capability toggles
- it can participate in fallback chains
- it can appear in route-target selectors and other model-picking surfaces

The rest of the router should not require users to understand a separate “local variant” model class.
Instead, the local-model system should materialize variants into the same model-selection universe as existing provider models.

## Capacity and Mac Fit Guidance

Capacity handling should be conservative and explicit.

### System fit guidance

For macOS unified-memory systems, the app should estimate whether a base model or variant is:
- `Safe`
- `Tight`
- `Over budget`

Base model fit should inform download/attach guidance.
Variant fit should inform enable/preload decisions.

### Enforcement policy

Creation should stay permissive.
Enabling and preloading should be capacity-limited.

Behavior:
- users may create any variant, even if it would exceed local capacity
- users may not enable or preload variants that push the system beyond the configured safe budget
- existing enabled variants that become oversized after edits remain in config but are flagged `Over capacity`

This avoids blocking experimentation while preventing the router from promising an impossible local runtime configuration.

### Budget inputs

Capacity estimates should use available signals such as:
- total unified memory
- base model file size
- quantization metadata when available
- context length
- preset/runtime options that materially affect memory use

v1 should prefer understandable rules over false precision.
The UI should communicate guidance clearly and avoid implying exact memory guarantees.

## Data Model

Add a new local-model metadata subtree to persisted config.

High-level shape:
- `metadata.localModels.runtime`
- `metadata.localModels.library`
- `metadata.localModels.variants`
- `metadata.localModels.capacity`

### runtime

Stores source runtime state and preferences.

Fields should include:
- selected local-model source section state
- detected `llama.cpp` candidates
- selected runtime command/path
- manual runtime command/path if set
- runtime host/port
- autostart-with-router flag
- last validation result and timestamps

### library

Stores base local models keyed by a stable local id.

Each library entry should include:
- local base-model id
- source type (`llamacpp-managed`, `llamacpp-attached`, or `ollama`)
- display label
- on-disk path or source reference
- metadata snapshot
- availability state
- last verified timestamp

### variants


Stores router-facing local variants keyed by stable variant id.

Each variant should include:
- stable internal variant key
- base-model reference
- user-visible name
- router model id
- runtime source
- preset
- runtime settings
- capability settings
- context length
- enabled flag
- preload flag
- last computed capacity state

### materialized router models

Enabled variants should be projected into the existing router model/provider configuration so the rest of the system can treat them like normal models.

This can be implemented via a synthetic local provider concept internally, but the user should not need to reason about that abstraction in the UI.

## Stale Asset and Removal Behavior

### Missing model file

If a base `llama.cpp` model file disappears:
- mark the base model stale
- mark all descendant variants stale
- preserve aliases and other references
- show usage summary for references when relevant

Recovery actions:
- `Locate model`
- `Remove model`

### Missing runtime

If the selected runtime target disappears:
- mark runtime stale or invalid
- do not remove runtime config automatically
- preserve local library and variants
- prompt user to pick another detected runtime or enter a new manual path/command

### Removal

Removing a base local model should remove all of its variants.

Removal should follow current router removal patterns, including warning when the model is still referenced.

For managed models, provide an extra option:
- `Also delete managed files from disk`

For attached models:
- never delete user-owned source files

## Backend and API Needs

### Runtime detection and validation

Add backend support to:
- discover `llama-server` candidates from common macOS locations and `PATH`
- validate a runtime path or command
- report candidate metadata suitable for a dropdown UI

### Runtime lifecycle

Add backend support to:
- start/stop/restart the selected local runtime
- report runtime state
- optionally coordinate preload behavior when router starts

### Hugging Face public search/download

Add backend support to:
- search public GGUF candidates
- inspect candidate metadata for compatibility and fit guidance
- download selected models into the managed local-model directory
- stream progress updates to the web UI

### Attach/import

Add backend support to:
- validate selected file/folder paths
- scan GGUF metadata
- register attached models in the local library

### Variant lifecycle

Add backend support to:
- create/update/remove variants
- validate duplicate ids and conflicting names
- compute capacity state
- materialize enabled variants into router-facing model config

### Reconciliation

Add backend support to:
- recheck runtime and model path validity on demand and/or periodically
- update stale availability state without destructive config changes

## Error Handling

The local-model system must fail visibly but safely.

Rules:
- no crash when paths disappear
- no silent deletion of config
- keep stale state visible until user resolves it
- disable impossible actions with clear reasons instead of allowing broken transitions
- preserve user references and settings even when assets are temporarily unavailable

## Testing Requirements

The implementation should be verified with tests covering:
- runtime detection result normalization
- runtime selection persistence
- stale runtime handling
- stale file handling for attached and managed models
- duplicate variant id validation
- variant materialization into router-facing model config
- capacity-state transitions
- removal behavior for referenced local variants
- UI state rendering for `Available`, `Stale`, `Invalid`, `Over capacity`, `Running`, and `Stopped`

## Scope Boundaries

Included in this design:
- `Local Models` umbrella tab
- `llama.cpp` runtime detection and lifecycle
- public Hugging Face GGUF search/download
- attached GGUF import
- variant management
- Mac unified-memory fit guidance and activation enforcement
- router integration for local variants
- moving Ollama under the new local-model umbrella

Explicitly excluded from v1:
- gated/private Hugging Face auth flow
- router-managed `llama.cpp` installation or upgrades
- multi-runtime orchestration for multiple concurrent `llama.cpp` backends
- cross-platform fit heuristics beyond initial Mac unified-memory focus

## Recommended Implementation Order

1. Add `Local Models` tab and persisted schema scaffolding
2. Add `llama.cpp` runtime discovery, validation, and lifecycle controls
3. Add attached GGUF library support and stale-path handling
4. Add public Hugging Face managed downloads with fit guidance
5. Add variant manager and router-model materialization
6. Add capacity enforcement for enable/preload operations
7. Move existing Ollama UI under the new umbrella and align terminology
