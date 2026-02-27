# Security Guide

This guide focuses on preventing unauthorized access to costly LLM resources, especially in Cloudflare Worker deployments.

## Quick Hardened Setup

1. Generate and set a strong gateway key locally:

```bash
llm-router config --operation=set-master-key --generate-master-key=true
```

2. Deploy with worker defaults already set in this repo:
- `workers_dev = false`
- `preview_urls = false`

3. Deploy config + secrets:

```bash
llm-router deploy --env=production
```

4. Restrict who can call the router:
- Set `LLM_ROUTER_ALLOWED_IPS` (or `LLM_ROUTER_IP_ALLOWLIST`) to trusted source IPs.
- Set `LLM_ROUTER_CORS_ALLOWED_ORIGINS` to explicit browser origins.
- Keep `LLM_ROUTER_CORS_ALLOW_ALL` disabled in production.

5. Expose only a custom domain route (not `workers.dev`):

```toml
[env.production]
routes = [{ pattern = "api.example.com/*", zone_name = "example.com" }]
```

## Quick Master Key Generation

Use generated keys instead of hand-written keys:

```bash
# Local config master key
llm-router config --operation=set-master-key --generate-master-key=true

# Rotate Cloudflare worker key directly
llm-router worker-key --env=production --generate-master-key=true
```

Optional tuning:

```bash
llm-router worker-key \
  --env=production \
  --generate-master-key=true \
  --master-key-length=64 \
  --master-key-prefix=gw_
```

## Cloudflare Access (Recommended)

Protect the worker behind Cloudflare Access so clients must present a service token before hitting the router.

Suggested setup:
1. Zero Trust -> Access -> Applications -> Add application.
2. Type: Self-hosted.
3. Domain: your API hostname (for example `api.example.com`).
4. Policy: allow only a Service Token for machine-to-machine traffic.

Client calls should include:
- `CF-Access-Client-Id`
- `CF-Access-Client-Secret`

Reference:
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)

## WAF and Rate Limiting

Use WAF custom rules and rate limiting to reduce abuse blast radius.

Suggested custom rule expressions (adapt host/path to your deployment):

1. Block non-allowlisted source IPs to route endpoint:

```txt
http.host eq "api.example.com" and starts_with(http.request.uri.path, "/route") and not ip.src in $llm_router_allowed_ips
```

2. Block unexpected methods on route endpoint:

```txt
http.host eq "api.example.com" and starts_with(http.request.uri.path, "/route") and not http.request.method in {"POST" "OPTIONS"}
```

Suggested rate limit rule:
- Match expression:

```txt
http.host eq "api.example.com" and starts_with(http.request.uri.path, "/route")
```

- Threshold example:
  - 60 requests / 1 minute per source IP (tighten or loosen by workload).
  - Action: Block or Managed Challenge.

References:
- [Cloudflare WAF custom rules](https://developers.cloudflare.com/waf/custom-rules/)
- [Cloudflare WAF rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)

## Incident Response: Master Key Leak

1. Rotate worker key immediately:

```bash
llm-router worker-key --env=production --generate-master-key=true
```

2. Rotate local config key (if reused anywhere):

```bash
llm-router config --operation=set-master-key --generate-master-key=true
```

3. Revoke exposed credentials and rotate provider API keys.
4. Review Cloudflare logs/WAF events for abuse window.
5. Tighten Access policy, IP allowlist, and rate limits before reopening traffic.

## Router Runtime Hardening Knobs

- `LLM_ROUTER_MAX_REQUEST_BODY_BYTES`
- `LLM_ROUTER_UPSTREAM_TIMEOUT_MS`
- `LLM_ROUTER_ALLOWED_IPS` / `LLM_ROUTER_IP_ALLOWLIST`
- `LLM_ROUTER_CORS_ALLOWED_ORIGINS`
- `LLM_ROUTER_CORS_ALLOW_ALL` (keep `false` in production)

## Official References

- [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [workers.dev routing controls](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Preview URLs](https://developers.cloudflare.com/changelog/2024-03-14-preview-urls/)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)
- [WAF custom rules](https://developers.cloudflare.com/waf/custom-rules/)
- [WAF rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [API Shield sequence mitigation](https://developers.cloudflare.com/api-shield/security/sequence-mitigation/)
