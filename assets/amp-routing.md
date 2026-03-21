# AMP Routing and Mapping

This document explains the current AMP routing architecture in `llm-router` after the new AMP mapping schema was added.

See also:

- [AMP Context Window Findings](./amp-context-window.md)
- [AMP Context Routing in llm-router](./amp-context-routing.md)

## Goals

- Keep AMP support resilient to upstream model-name drift.
- Let users map friendly AMP concepts like `smart`, `rush`, `oracle`, or shared signatures like `@google-gemini-flash-shared` to local route refs.
- Preserve backward compatibility with legacy AMP fields:
  - `amp.modelMappings`
  - `amp.subagentMappings`
  - `amp.subagentDefinitions`
  - `amp.forceModelMappings`

## Current User-Facing Schema

The new schema is additive under `config.amp`:

```json
{
  "amp": {
    "preset": "builtin",
    "defaultRoute": "chat.default",
    "routes": {
      "smart": "chat.smart",
      "rush": "chat.fast",
      "deep": "chat.deep",
      "oracle": "chat.oracle",
      "librarian": "chat.research",
      "@google-gemini-flash-shared": "chat.tools"
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
      ],
      "signatures": [
        {
          "id": "@custom-signature",
          "match": ["opus*"]
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

## Mental Model

There are now two AMP routing layers:

1. `input -> AMP entity/signature`
   - Detect what AMP likely meant based on the observed inbound model string.
2. `AMP entity/signature -> llm-router route ref`
   - Route to an alias like `chat.smart` or a direct `provider/model` ref.

The new schema keeps those layers visible without forcing users to edit low-level pattern tables for every case.

## Built-In Catalog

Code hotspots:

- `src/runtime/config.js`
  - `DEFAULT_AMP_ENTITY_DEFINITIONS`
  - `DEFAULT_AMP_SIGNATURE_DEFINITIONS`

Built-in entities currently cover the known AMP snapshot:

- Modes: `smart`, `rush`, `deep`
- Feature: `review`
- Agents: `search`, `oracle`, `librarian`
- System helpers: `look-at`, `painter`, `handoff`, `title`

Built-in shared signatures currently include:

- `@anthropic-opus`
- `@anthropic-sonnet`
- `@anthropic-haiku-shared`
- `@openai-gpt-base`
- `@openai-gpt-codex`
- `@google-gemini-pro`
- `@google-gemini-pro-image`
- `@google-gemini-flash-shared`

Shared signatures exist because AMP sometimes uses the same observed model family for multiple features, so routing by entity alone can be ambiguous.

## Model Matching Strategy

Model detection is not raw string equality anymore.

Runtime now:

1. canonicalizes inbound model strings
2. parses vendor/family/version/variant hints where possible
3. matches either:
   - string patterns with exact / wildcard / regex support, or
   - structured selectors like `{ "vendor": "anthropic", "family": "haiku" }`

Examples that normalize well:

- `Claude Opus 4.6`
- `claude-opus-4-6`
- `GPT-5.3 Codex`
- `gemini-2.5-flash-live-preview`

Main matcher code lives in `src/runtime/config.js`:

- `canonicalizeAmpModelText(...)`
- `parseAmpModelDescriptor(...)`
- `matchAmpModelPattern(...)`
- `matchAmpModelSelector(...)`

## Resolution Order

When the new AMP schema is present, routing precedence is:

1. entity route from `amp.routes` or entity override `route`
2. shared signature route from `amp.routes` or signature override `route`
3. local direct/bare model route or `amp.rawModelRoutes`
   - order between local vs raw model route still respects legacy `amp.forceModelMappings`
4. `amp.defaultRoute`
5. global `defaultModel`
6. optional upstream AMP proxy

Fallback policy comes from `amp.fallback`:

- `onUnknown`: `default-route` | `default-model` | `upstream` | `none`
- `onAmbiguous`: `default-route` | `default-model` | `upstream` | `none`
- `proxyUpstream`: boolean

If the new AMP schema is absent, legacy AMP routing behavior remains in place.

## Backward Compatibility

Legacy fields still work as before.

- `amp.modelMappings`
- `amp.subagentMappings`
- `amp.subagentDefinitions`
- `amp.forceModelMappings`

Current implementation rule:

- if new AMP schema fields are present, the new resolver path is used
- otherwise the legacy AMP resolver path is used

That keeps existing users stable while allowing future AMP support to move onto the cleaner schema.

## Validation

New AMP refs are now validated through `validateRuntimeConfig(...)`.

Validated pieces:

- `amp.defaultRoute`
- `amp.routes[*]`
- `amp.rawModelRoutes[*].to`
- `amp.overrides.entities[*].route`
- `amp.overrides.signatures[*].route`

## Live Verification

Use `npm run test:amp-smoke` when you want to confirm what AMP is actually sending today, instead of relying only on documented assumptions.

The smoke suite now:

- runs live AMP execute-mode checks through your local router
- captures the raw inbound AMP `model` strings seen on `/api/provider/...` requests
- verifies every observed live model string still matches the current AMP resolver implementation
- writes `observed-models.json`, `router-log.jsonl`, and `summary.json` artifacts for future debugging sessions

This is the fastest way to catch upstream naming drift like dated suffixes or family-version changes before editing the built-in AMP catalog.

## Patch Flow Defaults

When `set-amp-config` is used with AMP client patching but without explicit AMP routing flags, `llm-router` now bootstraps a default AMP router config so AMP can work immediately after patching.

Bootstrap behavior:

- patches AMP client settings/secrets to point AMP at local `llm-router`
- sets `amp.preset` to `builtin` when not configured
- sets `amp.defaultRoute` to `defaultModel` (or the first provider/model)
- enables `amp.restrictManagementToLocalhost=true`
- attempts to auto-discover the upstream AMP API key for `https://ampcode.com` from AMP secrets

This keeps the first-run AMP setup simple: patch once, then refine routing later with `amp.routes`, `amp.rawModelRoutes`, `amp.overrides`, or legacy mappings if needed.

## CLI Support

`llm-router config --operation=set-amp-config` now accepts new flags:

- `--amp-preset`
- `--amp-default-route`
- `--amp-routes`
- `--amp-raw-model-routes`
- `--amp-overrides`
- `--clear-amp-default-route`
- `--clear-amp-routes`
- `--clear-amp-raw-model-routes`
- `--clear-amp-overrides`

The older AMP flags are still supported.

## Important Files

Runtime:

- `src/runtime/config.js`
- `src/runtime/handler.js`
- `src/runtime/handler.amp.test.js`
- `src/runtime/config.test.js`

CLI:

- `src/cli/router-module.js`
- `src/cli/router-module.test.js`

User docs:

- `README.md`
- `docs/amp-routing.md`
- `docs/amp-context-window.md`
- `docs/amp-context-routing.md`

## Known Follow-Ups

Good next steps after this implementation:

- refactor the interactive AMP wizard to edit `amp.routes` and shared signatures directly
- expose an `amp explain` / `amp test` CLI for debugging matches
- optionally surface entity/signature match reasons in route-debug output
- expand structured selectors if AMP starts using more vendor naming variants
