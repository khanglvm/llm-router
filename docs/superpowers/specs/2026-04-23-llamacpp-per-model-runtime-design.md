# llama.cpp Per-Model Runtime Design

**Date:** 2026-04-23  
**Status:** Proposed  
**Scope:** Improve local `llama.cpp` support so each router-visible local variant can run with an optimized launch profile, while the router hides `llama-server` lifecycle details from users and cleans up stale managed processes automatically.

## Goal

Local `llama.cpp` variants should behave like first-class router models without forcing users to reason about CPU vs GPU launches, batch-size flags, or whether one or many `llama-server` processes exist behind the scenes.

The product should let users say, in effect, “this is the local model I want to use,” while the router selects or derives the best launch configuration for that model, starts the right managed runtime when needed, and stops stale router-owned processes safely.

This design is explicitly scoped to the existing local `llama.cpp` path. It must not change routing semantics for Ollama, hosted providers, or coding-tool integrations outside the existing `local-runtime` flow.

## Product Decisions

### User-facing primitive

The user-facing primitive is a per-variant runtime profile, not a server instance.

Users configure performance behavior on the local variant itself:
- `Auto (recommended)`
- `Custom`

The router owns all server lifecycle details:
- whether an existing managed runtime can be reused
- whether a new runtime should be started
- which port the runtime should use
- when old managed runtimes should be stopped

Users should never need to choose “single server” vs “multiple servers.” That remains an implementation detail.

### Runtime optimization model

Each `llamacpp` variant gets its own runtime profile and recommendation state.

The profile stores:
- mode: `auto` or `custom`
- preset id when in auto mode
- explicit launch overrides when in custom mode
- optional extra args for advanced users
- effective context window for runtime startup
- last known good launch plan
- last failure summary when the most recent launch failed

Auto mode should generate an effective launch plan from:
- model file size and quantization
- variant context window
- machine memory characteristics
- known macOS unified-memory constraints
- previous launch failures for that variant

The router should prefer a known-good launch plan over retrying a plan that recently failed with a clear capacity error such as Metal OOM.

### Logical provider model

Keep one logical router provider for local `llama.cpp` variants.

The existing `local-models` provider remains the public routing surface for:
- aliases
- coding-tool bindings
- user-facing route selection

The router resolves the actual upstream `llama-server` endpoint dynamically per request based on the target local variant and its effective runtime profile.

This avoids breaking the current mental model where local variants live under one local provider while still allowing the backend to run different managed runtimes for different variants when necessary.

### Process ownership and cleanup

The router must track and clean up only router-managed `llama-server` processes.

Each managed runtime instance should carry an ownership record containing:
- pid
- host
- port
- selected `llama-server` binary
- variant key or active model identity
- launch profile hash
- start timestamp
- health state

Cleanup rules:
- on router startup, reconcile tracked managed instances against live processes and ports
- on runtime switch, stop incompatible stale managed instances that are no longer needed
- on explicit stop, stop the targeted managed instance and reconcile port state
- on router shutdown, terminate router-owned managed instances started for the current config when safe to do so

The router must not kill arbitrary user-run `llama-server` processes that it does not own.

## User Experience

## 1. Runtime settings

Global `llama.cpp` runtime settings remain focused on the shared runtime environment, not on model tuning.

These settings should continue to include:
- selected `llama-server` binary
- default host binding
- managed port policy or port range
- start with router

The runtime panel should describe this clearly: the global runtime selects the executable and router ownership rules, while each variant controls the performance profile used to launch that model.

The status area should summarize:
- whether the selected runtime binary validates
- whether any managed runtime is currently healthy
- how many managed local `llama-server` processes are active
- whether any stale router-owned processes were found and reclaimed

### 2. Variant editor

The variant editor becomes the main performance-tuning surface for `llama.cpp`.

Add a `Runtime profile` section with:
- mode toggle: `Auto (recommended)` or `Custom`
- preset summary in auto mode
- recommended fit label such as `Balanced`, `Memory-safe`, `CPU-safe`, or `High-throughput`
- editable flag fields in custom mode
- raw extra-args field for advanced overrides
- effective command preview
- last known good status
- last failure summary when applicable

Auto mode is the default for non-expert users. Custom mode exists for users who know they need to override flags for a specific model or machine.

### 3. Runtime behavior during use

When a request targets a `llama.cpp` variant, the router should ensure the correct runtime plan is active before proxying traffic upstream.

User-visible behavior:
- no manual port juggling
- no need to pre-start a server for each model
- no need to understand whether the router reused a compatible process or launched a separate one

Operational details remain visible in status and logs, but they are not required for normal use.

### 4. Hugging Face download modal

The `Download GGUF from Hugging Face` modal should show size and memory-fit guidance before download.

Each result row should show:
- GGUF file size when known
- estimated runtime memory footprint for the current machine
- fit badge such as `Safe`, `Tight`, `Over budget`, or `Review`
- quantization badge
- recommendation text such as `Best fit` or `Memory will be tight at long context`

If Hugging Face provides no file size, keep the row visible and show that the memory estimate needs manual review instead of hiding the model.

This is more useful than raw file size alone because users care about “will this run well here?” rather than just download size.

## Architecture

### Config model

Extend local-model metadata so `llamacpp` variant config can persist runtime intent separately from model identity.

Add a new per-variant shape under local variants for `runtimeProfile`, with fields similar to:
- `mode`
- `preset`
- `overrides`
- `extraArgs`
- `lastKnownGood`
- `lastFailure`

Extend global `metadata.localModels.runtime.llamacpp` with router-level runtime management fields such as:
- validated runtime command
- default host
- managed port range or allocator seed
- managed instance records
- stale-reconcile status

The existing global runtime config should not become a dumping ground for model-specific flags. Model-specific tuning belongs on the variant.

### Runtime manager

Replace the current single-process launcher with a managed runtime registry for `llama.cpp`.

Responsibilities:
- derive the effective launch plan for a target variant
- find a compatible running managed instance, if one exists
- allocate a port for a new managed instance when needed
- spawn the process
- wait for readiness
- update ownership records
- stop obsolete router-owned instances

Compatibility should be strict enough to protect performance and correctness. Two variants should reuse one runtime only when the active binary, model path, and effective launch profile are compatible enough that reuse will not degrade or misconfigure the target model.

### Request routing

Keep the external provider shape unchanged, but route local-runtime requests through a dynamic local endpoint resolver.

For `local-runtime` requests, the router should:
1. identify the target variant
2. resolve its effective runtime plan
3. ensure a matching managed runtime is healthy
4. proxy the request to that runtime’s `/v1` endpoint

This is the main architectural change required to support per-model optimization without exposing separate providers or endpoints to users.

### Health and failure handling

Managed runtimes need active health checks and structured failure handling.

Health flow:
- validate binary before launch
- spawn with the effective plan
- poll readiness via the local HTTP surface
- mark healthy only after the runtime responds correctly

Failure flow:
- record the launch plan and error summary on the variant
- if the error indicates capacity or GPU failure, mark that plan as bad for auto mode
- select the next safer fallback preset
- avoid retry loops on clearly failing plans

The current observed case, where a large Qwen variant fails under GPU offload but succeeds with `-ngl 0`, should become a normal auto-fallback path rather than a manual debugging exercise.

## Auto-Tuning Heuristics

Auto mode should start with deterministic presets rather than trying to “learn” everything from scratch.

Initial preset families:
- `balanced`
- `memory-safe`
- `cpu-safe`
- `throughput`

Preset selection should consider:
- GGUF size
- quantization tier
- requested context window
- whether the machine is macOS with unified memory
- whether prior launches failed with GPU-memory or compute errors

Examples:
- large models with long context on unified memory should bias toward smaller batch sizes and reduced offload
- variants that previously failed with Metal memory errors should fall back to `memory-safe` or `cpu-safe`
- smaller models can bias toward more aggressive GPU offload and throughput settings

The exact flag tables can evolve later, but the product contract should be stable: auto mode always chooses a documented preset family and records the resulting effective plan.

## Safety and Scope Boundaries

This work is limited to local `llama.cpp` support.

Do not change:
- Ollama startup or routing behavior
- hosted-provider routing logic
- provider format handling for non-local providers
- coding-tool routing semantics outside whatever they already inherit from the `local-models` provider

Safety requirements:
- never kill non-managed `llama-server` processes
- never leave stale router-owned processes running silently after failed launches or model switches
- never mark a runtime healthy before it passes readiness checks
- keep failures recoverable from the UI

## Testing

The design should be covered with focused automated tests at the runtime-manager and config layers, plus targeted UI tests for the new variant editor and download modal indicators.

Coverage should include:
- config normalization for per-variant runtime profiles
- auto-plan derivation from variant and system metadata
- local-runtime request resolution to the correct managed endpoint
- fallback from a failing GPU-oriented profile to a safer plan
- stale managed-process reconciliation
- guardrails that prevent killing non-router-owned processes
- Hugging Face result shaping for file size, estimated memory, and fit badges

A smoke path should verify the motivating scenario:
- a large local Qwen variant receives a memory-safe launch plan
- the router starts the correct managed runtime
- chat/completions and responses requests succeed through the local-runtime path

## Out of Scope

This design does not include:
- installing or upgrading `llama.cpp`
- private or gated Hugging Face download flows
- changing Ollama model management
- exposing server-count controls to end users
- speculative support for non-`llama.cpp` local runtimes

## Summary

The core shift is from “one generic `llama-server` config for all local variants” to “one local provider with per-variant optimized runtime plans managed invisibly by the router.”

That gives non-expert users a stable default path, gives advanced users precise override controls when needed, fixes the current Qwen-style failure mode by making safer launch plans first-class, and keeps operational complexity inside the router where it belongs.
