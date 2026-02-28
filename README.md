# llm-router

`llm-router` is a gateway api proxy for accessing multiple models across any provider that supports OpenAI or Anthropic formats.

It supports:
- local route server `llm-router start`
- Cloudflare Worker route runtime deployment `llm-router deploy`
- CLI + TUI management `config`, `start`, `deploy`, `worker-key`
- Seamless model fallback

## Install

```bash
npm i -g @khanglvm/llm-router
```

## Versioning

- Follows [Semantic Versioning](https://semver.org/).
- Release notes live in [`CHANGELOG.md`](./CHANGELOG.md).
- npm publishes are configured for the public registry package.

Release checklist:
- Update `README.md` if user-facing behavior changed.
- Add a dated entry in `CHANGELOG.md`.
- Bump the package version before publish.
- Publish with `npm publish`.

## Quick Start

```bash
# 1) Open config TUI (default behavior) to manage providers, models, fallbacks, and auth
llm-router

# 2) Start local route server
llm-router start
```

Local endpoints:
- Unified (Auto transform): `http://127.0.0.1:8787/route` (or `/` and `/v1`)
- Anthropic: `http://127.0.0.1:8787/anthropic`
- OpenAI: `http://127.0.0.1:8787/openai`

## Usage Example

```bash
# Your AI Agent can help! Ask them to manage api router via this tool for you.

# 1) Add provider + models + provider API key. You can ask your AI agent to do it for you, or manually via TUI or command line:
llm-router config \
  --operation=upsert-provider \
  --provider-id=openrouter \
  --name="OpenRouter" \
  --base-url=https://openrouter.ai/api/v1 \
  --api-key=sk-or-v1-... \
  --models=claude-3-7-sonnet,gpt-4o \
  --format=openai \
  --skip-probe=true

# 2) (Optional) Configure model fallback order for direct provider/model requests
llm-router config \
  --operation=set-model-fallbacks \
  --provider-id=openrouter \
  --model=claude-3-7-sonnet \
  --fallback-models=openrouter/gpt-4o

# 3) (Optional) Create a model alias with a routing strategy and weighted targets
llm-router config \
  --operation=upsert-model-alias \
  --alias-id=chat.default \
  --strategy=auto \
  --targets=openrouter/claude-3-7-sonnet@2,openrouter/gpt-4o@1 \
  --fallback-targets=openrouter/gpt-4o-mini

# 4) (Optional) Add provider request-cap bucket (models: all)
llm-router config \
  --operation=set-provider-rate-limits \
  --provider-id=openrouter \
  --bucket-name="Monthly cap" \
  --bucket-models=all \
  --bucket-requests=20000 \
  --bucket-window=month:1

# 5) Set master key (this is your gateway key for client apps)
llm-router config --operation=set-master-key --master-key=gw_your_gateway_key

# 6) Start gateway with auth required
llm-router start --require-auth=true
```

Claude Code example (`~/.claude/settings.local.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "gw_your_gateway_key"
  }
}
```

## Smart Fallback Behavior

`llm-router` can fail over from a primary model to configured fallback models with status-aware logic:
- `429` (rate-limited): immediate fallback (no origin retry), with `Retry-After` respected when present.
- Temporary failures (`408`, `409`, `5xx`, network errors): origin-only bounded retries with jittered backoff, then fallback.
- Billing/quota exhaustion (`402`, or provider-specific billing signals): immediate fallback with longer origin cooldown memory.
- Auth and permission failures (`401` and relevant `403` cases): no retry; fallback to other providers/models when possible.
- Policy/moderation blocks: no retry; cross-provider fallback is disabled by default (`LLM_ROUTER_ALLOW_POLICY_FALLBACK=false`).
- Invalid client requests (`400`, `413`, `422`): no retry and no fallback short-circuit.

## Model Alias Routing Strategies

A model alias groups multiple models from different providers under one model name.

Use `--strategy` when creating or updating a model alias:

- `auto`: Recommended set-and-forget mode. Automatically routes using quota, cooldown, and health signals to reduce rate-limit failures.
- `ordered`: Tries targets in list order.
- `round-robin`: Rotates evenly across eligible targets.
- `weighted-rr`: Rotates like round-robin, but favors higher weights.
- `quota-aware-weighted-rr`: Weighted routing plus remaining-capacity awareness.

Example:

```bash
llm-router config \
  --operation=upsert-model-alias \
  --alias-id=coding \
  --strategy=auto \
  --targets=rc/gpt-5.3-codex,zai/glm-5
```

Concrete model alias example with provider-specific caps:

```bash
llm-router config \
  --operation=upsert-model-alias \
  --alias-id=coding \
  --strategy=auto \
  --targets=rc/gpt-5.3-codex,zai/glm-5

llm-router config \
  --operation=set-provider-rate-limits \
  --provider-id=rc \
  --bucket-name="Minute cap" \
  --bucket-models=gpt-5.3-codex \
  --bucket-requests=60 \
  --bucket-window=minute:1

llm-router config \
  --operation=set-provider-rate-limits \
  --provider-id=zai \
  --bucket-name="5-hours cap" \
  --bucket-models=glm-5 \
  --bucket-requests=600 \
  --bucket-window=hour:5
```

## What Is A Bucket?

A rate-limit bucket is a request cap for a time window.

Examples:
- `40 req / 1 minute`
- `600 req / 6 hours`

Multiple buckets can apply to the same model scope at the same time. A candidate is treated as exhausted if any matching bucket is exhausted.

## TUI Bucket Walkthrough

Use the config manager and select:
- `Manage provider rate-limit buckets`
- `Create bucket(s)`

The TUI now guides you through:
- Bucket name (friendly label)
- Model scope (`all` or selected models with multiselect checkboxes)
- Request cap
- Window unit (`minute`, `hour(s)`, `week`, `month`)
- Window size (hours support `N`, other preset units lock to `1`)
- Review + optional add-another loop for combined policies

Internal bucket ids are generated automatically from the name when omitted and shown as advanced detail in review.

## Combined-Cap Recipe (`40/min` + `600/6h`)

```bash
llm-router config \
  --operation=set-provider-rate-limits \
  --provider-id=openrouter \
  --bucket-name="Minute cap" \
  --bucket-models=all \
  --bucket-requests=40 \
  --bucket-window=minute:1

llm-router config \
  --operation=set-provider-rate-limits \
  --provider-id=openrouter \
  --bucket-name="6-hours cap" \
  --bucket-models=all \
  --bucket-requests=600 \
  --bucket-window=hour:6
```

This keeps both limits active together for the same model scope.

## Rate-Limit Troubleshooting

- Check routing decisions with `LLM_ROUTER_DEBUG_ROUTING=true` and inspect `x-llm-router-skipped-candidates`.
- `quota-exhausted` means proactive pre-routing skip happened before an upstream call.
- For provider `429`, cooldown is tracked from `Retry-After` when present, or from `LLM_ROUTER_ORIGIN_RATE_LIMIT_COOLDOWN_MS`.
- Local mode persists state by default (file backend), while Worker defaults to in-memory state.

## Main Commands

```bash
llm-router config
llm-router start
llm-router stop
llm-router reload
llm-router update
llm-router deploy
llm-router worker-key
```

## Non-Interactive Config (Agent/CI Friendly)

```bash
llm-router config \
  --operation=upsert-provider \
  --provider-id=openrouter \
  --name="OpenRouter" \
  --base-url=https://openrouter.ai/api/v1 \
  --api-key=sk-or-v1-... \
  --models=gpt-4o,claude-3-7-sonnet \
  --format=openai \
  --skip-probe=true

llm-router config \
  --operation=upsert-model-alias \
  --alias-id=chat.default \
  --strategy=auto \
  --targets=openrouter/gpt-4o-mini@3,anthropic/claude-3-5-haiku@2 \
  --fallback-targets=openrouter/gpt-4o

llm-router config \
  --operation=set-provider-rate-limits \
  --provider-id=openrouter \
  --bucket-name="Monthly cap" \
  --bucket-models=all \
  --bucket-requests=20000 \
  --bucket-window=month:1
```

Alias target syntax:
- `--targets` / `--fallback-targets`: `<routeRef>@<weight>` or `<routeRef>:<weight>`
- route refs: direct `provider/model` or alias id

Routing strategy values:
- `auto` (recommended)
- `ordered`
- `round-robin`
- `weighted-rr`
- `quota-aware-weighted-rr`

Rate-limit bucket window syntax:
- `--bucket-window=month:1`
- `--bucket-window=1w`
- `--bucket-window=7day`

Routing summary:

```bash
llm-router config --operation=list-routing
```

Explicit schema migration with backup:

```bash
llm-router config --operation=migrate-config --target-version=2 --create-backup=true
```

Automatic version handling:
- Local config loads with silent forward-migration to latest supported schema.
- Migration is persisted automatically on read when possible (best-effort, no interactive prompt).
- Future/newer version numbers do not fail only because of version mismatch; known fields are normalized best-effort.

Set local auth key:

```bash
llm-router config --operation=set-master-key --master-key=your_local_key
# or generate a strong key automatically
llm-router config --operation=set-master-key --generate-master-key=true
```

Start with auth required:

```bash
llm-router start --require-auth=true
```

## Cloudflare Worker Deploy

Worker project name in `wrangler.toml`: `llm-router-route`.

### Option A: Guided deploy

```bash
llm-router deploy
```

If `LLM_ROUTER_CONFIG_JSON` exceeds Cloudflare Free-tier secret size (`5 KB`), deploy now warns and requires explicit confirmation (default is `No`). In non-interactive environments, pass `--allow-large-config=true` to proceed intentionally.

`deploy` requires `CLOUDFLARE_API_TOKEN` for Cloudflare API access. Create a **User Profile API token** at <https://dash.cloudflare.com/profile/api-tokens> (do not use Account API Tokens), then choose preset/template `Edit Cloudflare Workers`. If the env var is missing in interactive mode, the CLI will show the guide and prompt for token input securely.

For multi-account tokens, set account explicitly in non-interactive runs:
- `CLOUDFLARE_ACCOUNT_ID=<id>` or
- `llm-router deploy --account-id=<id>`

`llm-router deploy` resolves deploy target from CLI/TUI input (workers.dev or custom route), generates a temporary Wrangler config at runtime, deploys with `--config`, then removes that temporary file. Personal route/account details are not persisted back into repo `wrangler.toml`.

For custom domains, the deploy helper now prints a DNS checklist and connectivity commands. Common setup for `llm.example.com`:
- Create a DNS record in Cloudflare for `llm` (usually `CNAME llm -> @`)
- Set **Proxy status = Proxied** (orange cloud)
- Use route target `--route-pattern=llm.example.com/* --zone-name=example.com`
- Claude Code base URL should be `https://llm.example.com/anthropic` (**no `:8787`**; that port is local-only)

```bash
llm-router deploy --export-only=true --out=.llm-router.worker.json
wrangler secret put LLM_ROUTER_CONFIG_JSON < .llm-router.worker.json
wrangler deploy
```

Rotate worker auth key quickly:

```bash
llm-router worker-key --master-key=new_key
# or generate and rotate immediately
llm-router worker-key --env=production --generate-master-key=true
```

If you intentionally need to bypass weak-key checks (not recommended), add `--allow-weak-master-key=true` to `deploy` or `worker-key`.

Cloudflare hardening and incident-response checklist: see [`SECURITY.md`](./SECURITY.md).

## Runtime Secrets / Env

Primary:
- `LLM_ROUTER_CONFIG_JSON`
- `LLM_ROUTER_MASTER_KEY` (optional override)

Also supported:
- `ROUTE_CONFIG_JSON`
- `LLM_ROUTER_JSON`

Optional resilience tuning:
- `LLM_ROUTER_ORIGIN_RETRY_ATTEMPTS` (default `3`)
- `LLM_ROUTER_ORIGIN_RETRY_BASE_DELAY_MS` (default `250`)
- `LLM_ROUTER_ORIGIN_RETRY_MAX_DELAY_MS` (default `3000`)
- `LLM_ROUTER_ORIGIN_FALLBACK_COOLDOWN_MS` (default `45000`)
- `LLM_ROUTER_ORIGIN_RATE_LIMIT_COOLDOWN_MS` (default `30000`)
- `LLM_ROUTER_ORIGIN_BILLING_COOLDOWN_MS` (default `900000`)
- `LLM_ROUTER_ORIGIN_AUTH_COOLDOWN_MS` (default `600000`)
- `LLM_ROUTER_ORIGIN_POLICY_COOLDOWN_MS` (default `120000`)
- `LLM_ROUTER_ALLOW_POLICY_FALLBACK` (default `false`)
- `LLM_ROUTER_FALLBACK_CIRCUIT_FAILURES` (default `2`)
- `LLM_ROUTER_FALLBACK_CIRCUIT_COOLDOWN_MS` (default `30000`)
- `LLM_ROUTER_MAX_REQUEST_BODY_BYTES` (default `1048576`, min `4096`, max `20971520`)
- `LLM_ROUTER_UPSTREAM_TIMEOUT_MS` (default `60000`, min `1000`, max `300000`)

Optional browser access (CORS):
- By default, cross-origin browser reads are denied unless explicitly allow-listed.
- `LLM_ROUTER_CORS_ALLOWED_ORIGINS` (comma-separated exact origins, e.g. `https://app.example.com`)
- `LLM_ROUTER_CORS_ALLOW_ALL=true` (allows any origin; not recommended for production)

Optional source IP allowlist (recommended for Worker deployments):
- `LLM_ROUTER_ALLOWED_IPS` (comma-separated client IPs; denies requests from all other IPs)
- `LLM_ROUTER_IP_ALLOWLIST` (alias of `LLM_ROUTER_ALLOWED_IPS`)

## Default Config Path

`~/.llm-router.json`

Minimal shape:

```json
{
  "version": 2,
  "masterKey": "local_or_worker_key",
  "defaultModel": "chat.default",
  "modelAliases": {
    "chat.default": {
      "strategy": "auto",
      "targets": [
        { "ref": "openrouter/gpt-4o" },
        { "ref": "anthropic/claude-3-5-haiku" }
      ],
      "fallbackTargets": [
        { "ref": "openrouter/gpt-4o-mini" }
      ]
    }
  },
  "providers": [
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-v1-...",
      "formats": ["openai"],
      "models": [{ "id": "gpt-4o" }],
      "rateLimits": [
        {
          "id": "openrouter-all-month",
          "name": "Monthly cap",
          "models": ["all"],
          "requests": 20000,
          "window": { "unit": "month", "size": 1 }
        }
      ]
    }
  ]
}
```

Direct vs model alias routing:
- Direct route: request `model=provider/model` and optional model-level `fallbackModels` applies.
- Model alias route: request `model=alias.id` (or set as `defaultModel`) and the model alias `targets` + `strategy` drive balancing. `auto` is the recommended default for new model aliases.

State durability caveats:
- Local Node (`llm-router start`): routing state defaults to file-backed local persistence, so cooldowns/caps survive restarts.
- Cloudflare Worker: default state is in-memory per isolate for now; long-window counters are best-effort until a durable Worker backend is configured.

## Smoke Test

```bash
npm run test:provider-smoke
```

Use `.env.test-suite.example` as template for provider-based smoke tests.
