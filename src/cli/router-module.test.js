import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import {
  applyWranglerDeployTargetToToml,
  buildCloudflareApiTokenSetupGuide,
  buildCloudflareDnsManualGuide,
  buildDefaultWranglerTomlForDeploy,
  CLOUDFLARE_FREE_SECRET_SIZE_LIMIT_BYTES,
  evaluateCloudflareMembershipsResult,
  evaluateCloudflareTokenVerifyResult,
  extractCloudflareMembershipAccounts,
  extractHostnameFromRoutePattern,
  hasNoDeployTargets,
  hasWranglerDeployTargetConfigured,
  inferCloudflareTierFromWhoami,
  inferZoneNameFromHostname,
  isHostnameUnderZone,
  normalizeWranglerRoutePattern,
  parseAliasTargetListInput,
  parseEndpointListInput,
  parseRateLimitWindowInput,
  resolveCloudflareApiTokenFromEnv,
  setProviderRateLimitsInConfig,
  shouldConfirmLargeWorkerConfigDeploy,
  summarizeConfig,
  suggestZoneNameForHostname,
  validateCloudflareApiTokenInput
} from "./router-module.js";
import routerModule from "./router-module.js";
import { readConfigFile } from "../node/config-store.js";

// Test configuration from environment
const TEST_HOSTNAME = process.env.LLM_ROUTER_TEST_HOSTNAME || "router.example.com";
const TEST_ZONE_NAME = process.env.LLM_ROUTER_TEST_ZONE_NAME || "example.com";

function getConfigAction() {
  return routerModule.actions.find((entry) => entry.actionId === "config");
}

function getAiHelpAction() {
  return routerModule.actions.find((entry) => entry.actionId === "ai-help");
}

function createConfigContext(args) {
  return {
    args,
    mode: "commandline",
    terminal: {
      line() {},
      info() {},
      warn() {},
      error() {}
    },
    prompts: {}
  };
}

async function createTempConfigFile(t, config) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-cli-test-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const filePath = path.join(tempDir, "config.json");
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

function baseConfigFixture() {
  return {
    version: 2,
    defaultModel: "openrouter/gpt-4o-mini",
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        formats: ["openai"],
        apiKey: "sk-or-test",
        models: [
          { id: "gpt-4o-mini" },
          { id: "gpt-4o" }
        ]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        formats: ["claude"],
        apiKey: "sk-ant-test",
        models: [
          { id: "claude-3-5-haiku" }
        ]
      }
    ],
    modelAliases: {}
  };
}


test("inferCloudflareTierFromWhoami returns unknown when whoami reports logged out", () => {
  const result = inferCloudflareTierFromWhoami({ loggedIn: false });
  assert.equal(result.tier, "unknown");
  assert.equal(result.reason, "not-logged-in");
});

test("inferCloudflareTierFromWhoami detects free tier from subscription metadata", () => {
  const result = inferCloudflareTierFromWhoami({
    loggedIn: true,
    user: {
      subscription: {
        type: "free"
      }
    }
  });

  assert.equal(result.tier, "free");
  assert.equal(result.reason, "detected-free");
});

test("inferCloudflareTierFromWhoami detects paid tier from account metadata", () => {
  const result = inferCloudflareTierFromWhoami({
    loggedIn: true,
    accounts: [
      { name: "Acme", plan: "business" }
    ]
  });

  assert.equal(result.tier, "paid");
  assert.equal(result.reason, "detected-paid");
});

test("inferCloudflareTierFromWhoami returns unknown when both free and paid markers are present", () => {
  const result = inferCloudflareTierFromWhoami({
    loggedIn: true,
    accounts: [
      { name: "One", plan: "free" },
      { name: "Two", plan: "enterprise" }
    ]
  });

  assert.equal(result.tier, "unknown");
  assert.equal(result.reason, "ambiguous-tier");
});

test("shouldConfirmLargeWorkerConfigDeploy only triggers for payloads above free limit when tier is unknown/free", () => {
  assert.equal(
    shouldConfirmLargeWorkerConfigDeploy({
      payloadBytes: CLOUDFLARE_FREE_SECRET_SIZE_LIMIT_BYTES,
      tier: "unknown"
    }),
    false
  );

  assert.equal(
    shouldConfirmLargeWorkerConfigDeploy({
      payloadBytes: CLOUDFLARE_FREE_SECRET_SIZE_LIMIT_BYTES + 1,
      tier: "unknown"
    }),
    true
  );

  assert.equal(
    shouldConfirmLargeWorkerConfigDeploy({
      payloadBytes: CLOUDFLARE_FREE_SECRET_SIZE_LIMIT_BYTES + 1,
      tier: "free"
    }),
    true
  );

  assert.equal(
    shouldConfirmLargeWorkerConfigDeploy({
      payloadBytes: CLOUDFLARE_FREE_SECRET_SIZE_LIMIT_BYTES + 1,
      tier: "paid"
    }),
    false
  );
});

test("resolveCloudflareApiTokenFromEnv prefers CLOUDFLARE_API_TOKEN", () => {
  const result = resolveCloudflareApiTokenFromEnv({
    CLOUDFLARE_API_TOKEN: "token-primary",
    CF_API_TOKEN: "token-fallback"
  });

  assert.equal(result.token, "token-primary");
  assert.equal(result.source, "CLOUDFLARE_API_TOKEN");
});

test("resolveCloudflareApiTokenFromEnv falls back to CF_API_TOKEN", () => {
  const result = resolveCloudflareApiTokenFromEnv({
    CLOUDFLARE_API_TOKEN: "",
    CF_API_TOKEN: "token-fallback"
  });

  assert.equal(result.token, "token-fallback");
  assert.equal(result.source, "CF_API_TOKEN");
});

test("resolveCloudflareApiTokenFromEnv returns missing when no token in env", () => {
  const result = resolveCloudflareApiTokenFromEnv({
    CLOUDFLARE_API_TOKEN: " ",
    CF_API_TOKEN: "\n"
  });

  assert.equal(result.token, "");
  assert.equal(result.source, "none");
});

test("buildCloudflareApiTokenSetupGuide includes preset and token env instructions", () => {
  const guide = buildCloudflareApiTokenSetupGuide();
  assert.match(guide, /Edit Cloudflare Workers/);
  assert.match(guide, /CLOUDFLARE_API_TOKEN/);
  assert.match(guide, /dash\.cloudflare\.com\/profile\/api-tokens/);
  assert.match(guide, /User Profile API token/);
  assert.match(guide, /Do not use Account API Tokens/);
  assert.match(guide, /https:\/\/developers\.cloudflare\.com\/fundamentals\/api\/get-started\/create-token\//);
});

test("validateCloudflareApiTokenInput returns error for empty input and undefined for valid token", () => {
  assert.match(
    String(validateCloudflareApiTokenInput("")),
    /CLOUDFLARE_API_TOKEN is required/
  );
  assert.equal(validateCloudflareApiTokenInput("abc123"), undefined);
});

test("evaluateCloudflareTokenVerifyResult accepts active tokens", () => {
  const result = evaluateCloudflareTokenVerifyResult({
    success: true,
    result: { status: "active" }
  });

  assert.equal(result.ok, true);
});

test("evaluateCloudflareTokenVerifyResult surfaces Cloudflare API errors", () => {
  const result = evaluateCloudflareTokenVerifyResult({
    success: false,
    errors: [{ code: 10001, message: "Unable to authenticate request" }]
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /Unable to authenticate request/);
});

test("evaluateCloudflareMembershipsResult requires at least one membership", () => {
  const result = evaluateCloudflareMembershipsResult({
    success: true,
    result: []
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /no accessible memberships/i);
});

test("evaluateCloudflareMembershipsResult accepts valid membership response", () => {
  const result = evaluateCloudflareMembershipsResult({
    success: true,
    result: [
      { account: { id: "abc", name: "Alpha" } },
      { account: { id: "def", name: "Delta" } }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts[0].accountId, "abc");
});

test("extractCloudflareMembershipAccounts normalizes account id/name from memberships payload", () => {
  const accounts = extractCloudflareMembershipAccounts({
    result: [
      { account: { id: "aaa", name: "A Team" } },
      { account_id: "bbb", account_name: "B Team" },
      { accountId: "ccc", accountName: "C Team" },
      { id: "aaa", name: "Duplicate A" }
    ]
  });

  assert.equal(accounts.length, 3);
  assert.deepEqual(accounts.map((entry) => entry.accountId), ["aaa", "bbb", "ccc"]);
});

test("hasNoDeployTargets detects no-target deploy output", () => {
  assert.equal(
    hasNoDeployTargets("Uploaded foo\nNo deploy targets for foo\nCurrent Version ID: abc"),
    true
  );
  assert.equal(hasNoDeployTargets("Cloudflare deployment completed"), false);
});

test("normalizeWranglerRoutePattern normalizes domain and url inputs", () => {
  assert.equal(normalizeWranglerRoutePattern("router.example.com"), "router.example.com/*");
  assert.equal(normalizeWranglerRoutePattern("https://router.example.com/v1"), "router.example.com/v1");
  assert.equal(normalizeWranglerRoutePattern("router.example.com/*"), "router.example.com/*");
});

test("hasWranglerDeployTargetConfigured recognizes workers_dev and routes", () => {
  assert.equal(hasWranglerDeployTargetConfigured("workers_dev = true"), true);
  assert.equal(hasWranglerDeployTargetConfigured("routes = [\n  { pattern = \"router.example.com/*\", zone_name = \"example.com\" }\n]"), true);
  assert.equal(hasWranglerDeployTargetConfigured("workers_dev = false"), false);
  assert.equal(
    hasWranglerDeployTargetConfigured("[vars]\nroutes = [{ pattern = \"router.example.com/*\", zone_name = \"example.com\" }]"),
    false
  );
});

test("buildDefaultWranglerTomlForDeploy builds custom route config", () => {
  const text = buildDefaultWranglerTomlForDeploy({
    name: "demo",
    main: "src/index.js",
    compatibilityDate: "2024-01-01",
    useWorkersDev: false,
    routePattern: "router.example.com/*",
    zoneName: "example.com"
  });

  assert.match(text, /name = "demo"/);
  assert.match(text, /workers_dev = false/);
  assert.match(text, /routes = \[/);
  assert.match(text, /zone_name = "example\.com"/);
});

test("applyWranglerDeployTargetToToml can enable workers.dev", () => {
  const next = applyWranglerDeployTargetToToml(
    "name = \"demo\"\nworkers_dev = false\n",
    { useWorkersDev: true }
  );

  assert.match(next, /workers_dev = true/);
});

test("applyWranglerDeployTargetToToml inserts routes at top-level before [vars] and removes misplaced vars routes", () => {
  const input = [
    "name = \"demo\"",
    "main = \"src/index.js\"",
    "workers_dev = false",
    "[vars]",
    "ENVIRONMENT = \"production\"",
    "routes = [",
    "  { pattern = \"old.example.com/*\", zone_name = \"example.com\" }",
    "]",
    ""
  ].join("\n");

  const next = applyWranglerDeployTargetToToml(input, {
    useWorkersDev: false,
    routePattern: "router.example.com/*",
    zoneName: "example.com"
  });

  assert.match(next, /routes = \[\n  \{ pattern = "router\.example\.com\/\*", zone_name = "example\.com" \}\n\]\n\n\[vars\]/);
  assert.doesNotMatch(next, /\[vars\][\s\S]*routes\s*=\s*\[/);
});

test("extractHostnameFromRoutePattern extracts hostname from route and URL values", () => {
  assert.equal(extractHostnameFromRoutePattern(`${TEST_HOSTNAME}/*`), TEST_HOSTNAME);
  assert.equal(extractHostnameFromRoutePattern(`https://${TEST_HOSTNAME}/anthropic`), TEST_HOSTNAME);
  assert.equal(extractHostnameFromRoutePattern(""), "");
});

test("inferZoneNameFromHostname and isHostnameUnderZone validate zone relationships", () => {
  assert.equal(inferZoneNameFromHostname(TEST_HOSTNAME), TEST_ZONE_NAME);
  assert.equal(inferZoneNameFromHostname(TEST_ZONE_NAME), TEST_ZONE_NAME);
  assert.equal(inferZoneNameFromHostname("localhost"), "");

  assert.equal(isHostnameUnderZone(TEST_HOSTNAME, TEST_ZONE_NAME), true);
  assert.equal(isHostnameUnderZone(TEST_ZONE_NAME, TEST_ZONE_NAME), true);
  assert.equal(isHostnameUnderZone("api.example.org", "example.com"), false);
});

test("suggestZoneNameForHostname picks longest matching zone suffix", () => {
  const zones = [
    { id: "1", name: "dev" },
    { id: "2", name: TEST_ZONE_NAME },
    { id: "3", name: "example.com" }
  ];

  assert.equal(suggestZoneNameForHostname(TEST_HOSTNAME, zones), TEST_ZONE_NAME);
  assert.equal(suggestZoneNameForHostname("x.dev", zones), "dev");
  assert.equal(suggestZoneNameForHostname("no-match.tld", zones), "");
});

test("buildCloudflareDnsManualGuide includes actionable DNS/proxy guidance", () => {
  const guide = buildCloudflareDnsManualGuide({
    hostname: TEST_HOSTNAME,
    zoneName: TEST_ZONE_NAME,
    routePattern: `${TEST_HOSTNAME}/*`
  });

  assert.match(guide, /CNAME/i);
  assert.match(guide, /@/);
  assert.match(guide, /proxied/i);
  assert.match(guide, new RegExp(`dig \\+short ${TEST_HOSTNAME.replace(/\./g, "\\.")} @1\\.1\\.1\\.1`));
  assert.match(guide, new RegExp(`https://${TEST_HOSTNAME.replace(/\./g, "\\.")}/anthropic`));
  assert.doesNotMatch(guide, /https:\/\/[^\s]+:8787/i);
});

test("parseAliasTargetListInput parses weighted and unweighted refs", () => {
  const parsed = parseAliasTargetListInput("openrouter/gpt-4o-mini@3,anthropic/claude-3-5-haiku:2,openrouter/gpt-4o");
  assert.deepEqual(parsed, [
    { ref: "openrouter/gpt-4o-mini", weight: 3 },
    { ref: "anthropic/claude-3-5-haiku", weight: 2 },
    { ref: "openrouter/gpt-4o" }
  ]);
});

test("parseEndpointListInput splits concatenated scheme endpoints into separate values", () => {
  const parsed = parseEndpointListInput("https://ai.megallm.iohttps://ai.megallm.io/v1");
  assert.deepEqual(parsed, [
    "https://ai.megallm.io",
    "https://ai.megallm.io/v1"
  ]);
});

test("parseEndpointListInput keeps multiline pasted endpoints", () => {
  const parsed = parseEndpointListInput("https://ai.megallm.io\nhttps://ai.megallm.io/v1");
  assert.deepEqual(parsed, [
    "https://ai.megallm.io",
    "https://ai.megallm.io/v1"
  ]);
});

test("parseRateLimitWindowInput parses common syntaxes", () => {
  assert.deepEqual(parseRateLimitWindowInput("month:1"), { unit: "month", size: 1 });
  assert.deepEqual(parseRateLimitWindowInput("hour:6"), { unit: "hour", size: 6 });
  assert.deepEqual(parseRateLimitWindowInput("2w"), { unit: "week", size: 2 });
  assert.deepEqual(parseRateLimitWindowInput({ unit: "day", size: 7 }), { unit: "day", size: 7 });
  assert.equal(parseRateLimitWindowInput("invalid"), null);
});

test("summarizeConfig includes aliases and provider rate-limit buckets", () => {
  const summary = summarizeConfig({
    version: 2,
    defaultModel: "chat.default",
    masterKey: "gw_secret_value",
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        formats: ["openai"],
        apiKey: "sk-or-test",
        models: [{ id: "gpt-4o-mini" }],
        rateLimits: [
          {
            id: "or-month",
            name: "Monthly cap",
            models: ["all"],
            requests: 20000,
            window: { unit: "month", size: 1 }
          }
        ]
      }
    ],
    modelAliases: {
      "chat.default": {
        strategy: "round-robin",
        targets: [{ ref: "openrouter/gpt-4o-mini", weight: 2 }],
        fallbackTargets: [{ ref: "openrouter/gpt-4o" }]
      }
    }
  }, "/tmp/config.json");

  assert.match(summary, /Model aliases:/);
  assert.match(summary, /chat\.default strategy=round-robin/);
  assert.match(summary, /targets=openrouter\/gpt-4o-mini@2/);
  assert.match(summary, /rateLimits:/);
  assert.match(summary, /Monthly cap \(or-month\): models=all models cap=20000 req \/ 1 month window=1\/month/);
});

test("non-interactive upsert-model-alias writes expected config", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());

  const result = await configAction.run(createConfigContext({
    operation: "upsert-model-alias",
    config: configPath,
    "alias-id": "chat.default",
    strategy: "quota-aware-weighted-rr",
    targets: "openrouter/gpt-4o-mini@3,anthropic/claude-3-5-haiku@2",
    "fallback-targets": "openrouter/gpt-4o"
  }));

  assert.equal(result.ok, true);
  const next = await readConfigFile(configPath);
  assert.equal(next.modelAliases["chat.default"].strategy, "quota-aware-weighted-rr");
  assert.deepEqual(next.modelAliases["chat.default"].targets, [
    { ref: "openrouter/gpt-4o-mini", weight: 3, metadata: undefined },
    { ref: "anthropic/claude-3-5-haiku", weight: 2, metadata: undefined }
  ]);
  assert.deepEqual(next.modelAliases["chat.default"].fallbackTargets, [
    { ref: "openrouter/gpt-4o", weight: undefined, metadata: undefined }
  ]);
});

test("non-interactive upsert-model-alias accepts auto model routing strategy", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());

  const result = await configAction.run(createConfigContext({
    operation: "upsert-model-alias",
    config: configPath,
    "alias-id": "coding",
    strategy: "auto",
    targets: "openrouter/gpt-4o-mini,anthropic/claude-3-5-haiku"
  }));

  assert.equal(result.ok, true);
  const next = await readConfigFile(configPath);
  assert.equal(next.modelAliases.coding.strategy, "auto");
});

test("non-interactive set-provider-rate-limits writes expected config", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());

  const result = await configAction.run(createConfigContext({
    operation: "set-provider-rate-limits",
    config: configPath,
    "provider-id": "openrouter",
    "bucket-id": "openrouter-all-month",
    "bucket-models": "all",
    "bucket-requests": "20000",
    "bucket-window": "month:1"
  }));

  assert.equal(result.ok, true);
  const next = await readConfigFile(configPath);
  const provider = next.providers.find((entry) => entry.id === "openrouter");
  assert.deepEqual(provider.rateLimits, [
    {
      id: "openrouter-all-month",
      models: ["all"],
      requests: 20000,
      window: { unit: "month", size: 1 },
      metadata: undefined
    }
  ]);
});

test("non-interactive set-provider-rate-limits can auto-generate bucket id from bucket name", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());

  const result = await configAction.run(createConfigContext({
    operation: "set-provider-rate-limits",
    config: configPath,
    "provider-id": "openrouter",
    "bucket-name": "Monthly cap",
    "bucket-models": "all",
    "bucket-requests": "20000",
    "bucket-window": "month:1"
  }));

  assert.equal(result.ok, true);
  const next = await readConfigFile(configPath);
  const provider = next.providers.find((entry) => entry.id === "openrouter");
  assert.deepEqual(provider.rateLimits, [
    {
      id: "monthly-cap",
      name: "Monthly cap",
      models: ["all"],
      requests: 20000,
      window: { unit: "month", size: 1 },
      metadata: undefined
    }
  ]);
});

test("setProviderRateLimitsInConfig resolves generated bucket id collisions deterministically", () => {
  const existing = baseConfigFixture();
  existing.providers[0].rateLimits = [
    {
      id: "minute-cap",
      name: "Minute cap",
      models: ["all"],
      requests: 40,
      window: { unit: "minute", size: 1 }
    }
  ];

  const updated = setProviderRateLimitsInConfig(existing, {
    providerId: "openrouter",
    buckets: [
      {
        name: "Minute cap",
        models: ["all"],
        requests: 600,
        window: { unit: "hour", size: 6 }
      }
    ]
  });

  assert.equal(updated.changed, true);
  assert.deepEqual(updated.rateLimits.map((bucket) => bucket.id), [
    "minute-cap",
    "minute-cap-2"
  ]);
});

test("setProviderRateLimitsInConfig keeps bucket id stable when only the name changes", () => {
  const existing = baseConfigFixture();
  existing.providers[0].rateLimits = [
    {
      id: "monthly-cap",
      name: "Monthly cap",
      models: ["all"],
      requests: 20000,
      window: { unit: "month", size: 1 }
    }
  ];

  const updated = setProviderRateLimitsInConfig(existing, {
    providerId: "openrouter",
    buckets: [
      {
        id: "monthly-cap",
        name: "Monthly cap renamed",
        models: ["all"],
        requests: 20000,
        window: { unit: "month", size: 1 }
      }
    ]
  });

  assert.equal(updated.changed, true);
  assert.equal(updated.rateLimits[0].id, "monthly-cap");
  assert.equal(updated.rateLimits[0].name, "Monthly cap renamed");
});

test("invalid alias and rate-limit inputs return precise validation errors", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());

  const badAlias = await configAction.run(createConfigContext({
    operation: "upsert-model-alias",
    config: configPath,
    "alias-id": "chat.default",
    targets: "openrouter/unknown-model"
  }));
  assert.equal(badAlias.ok, false);
  assert.match(String(badAlias.errorMessage || ""), /references unknown model 'openrouter\/unknown-model'/);

  const badWindow = await configAction.run(createConfigContext({
    operation: "set-provider-rate-limits",
    config: configPath,
    "provider-id": "openrouter",
    "bucket-id": "bad-window",
    "bucket-models": "all",
    "bucket-requests": "10",
    "bucket-window": "fortnightly"
  }));
  assert.equal(badWindow.ok, false);
  assert.match(String(badWindow.errorMessage || ""), /bucket-id or bucket-name, models, requests, and valid window are required/);
});

test("list-routing stays stable after mixed edits", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());

  const aliasResult = await configAction.run(createConfigContext({
    operation: "upsert-model-alias",
    config: configPath,
    "alias-id": "chat.default",
    targets: "openrouter/gpt-4o-mini,anthropic/claude-3-5-haiku"
  }));
  assert.equal(aliasResult.ok, true);

  const bucketResult = await configAction.run(createConfigContext({
    operation: "set-provider-rate-limits",
    config: configPath,
    "provider-id": "openrouter",
    "bucket-id": "or-month",
    "bucket-models": "all",
    "bucket-requests": "100",
    "bucket-window": "month:1"
  }));
  assert.equal(bucketResult.ok, true);

  const list = await configAction.run(createConfigContext({
    operation: "list-routing",
    config: configPath
  }));
  assert.equal(list.ok, true);
  assert.match(String(list.data || ""), /Model aliases:/);
  assert.match(String(list.data || ""), /rateLimits:/);

  const normalized = await readConfigFile(configPath);
  assert.equal(normalized.version, 2);
  assert.equal(normalized.modelAliases["chat.default"].targets.length, 2);
});

test("migrate-config creates backup and upgrades legacy config version", async (t) => {
  const configAction = getConfigAction();
  const legacy = baseConfigFixture();
  legacy.version = 1;
  const configPath = await createTempConfigFile(t, legacy);

  const result = await configAction.run(createConfigContext({
    operation: "migrate-config",
    config: configPath,
    "target-version": "2",
    "create-backup": "true"
  }));

  assert.equal(result.ok, true);
  assert.match(String(result.data || ""), /Migrated config 1 -> 2|already at target schema/);

  const next = await readConfigFile(configPath);
  assert.equal(next.version, 2);

  const entries = await fs.readdir(path.dirname(configPath));
  assert.ok(entries.some((name) => name.startsWith("config.json.bak.")));
});

test("ai-help action exists and includes discovery commands", async (t) => {
  const aiHelpAction = getAiHelpAction();
  assert.ok(aiHelpAction);

  const configPath = await createTempConfigFile(t, baseConfigFixture());
  const result = await aiHelpAction.run(createConfigContext({
    config: configPath,
    "skip-live-test": true
  }));

  assert.equal(result.ok, true);
  assert.match(String(result.data || ""), /# AI-HELP/);
  assert.match(String(result.data || ""), /llm-router -h/);
  assert.match(String(result.data || ""), /llm-router config -h/);
  assert.match(String(result.data || ""), /## PRE-PATCH API GATE/);
  assert.match(String(result.data || ""), /## CODING TOOL PATCH PLAYBOOK/);
  assert.match(String(result.data || ""), /patch_gate_codex_cli=/);
});

test("ai-help suggests first provider when config has none", async (t) => {
  const aiHelpAction = getAiHelpAction();
  assert.ok(aiHelpAction);

  const configPath = await createTempConfigFile(t, {
    version: 2,
    providers: [],
    modelAliases: {}
  });

  const result = await aiHelpAction.run(createConfigContext({
    config: configPath,
    "skip-live-test": true
  }));

  assert.equal(result.ok, true);
  assert.match(String(result.data || ""), /Add first provider with at least one model/);
});
