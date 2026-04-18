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
  patchAmpClientConfigFiles,
  resolveCloudflareApiTokenFromEnv,
  setProviderRateLimitsInConfig,
  shouldConfirmLargeWorkerConfigDeploy,
  summarizeConfig,
  suggestZoneNameForHostname,
  validateCloudflareApiTokenInput
} from "./router-module.js";
import routerModule from "./router-module.js";
import { readConfigFile } from "../node/config-store.js";
import {
  CODEX_SUBSCRIPTION_MODELS,
  CLAUDE_CODE_SUBSCRIPTION_MODELS
} from "../runtime/subscription-constants.js";
import { LOCAL_ROUTER_ORIGIN } from "../shared/local-router-defaults.js";

// Test configuration from environment
const TEST_HOSTNAME = process.env.LLM_ROUTER_TEST_HOSTNAME || "router.example.com";
const TEST_ZONE_NAME = process.env.LLM_ROUTER_TEST_ZONE_NAME || "example.com";

function getConfigAction() {
  return routerModule.actions.find((entry) => entry.actionId === "config");
}

function getAiHelpAction() {
  return routerModule.actions.find((entry) => entry.actionId === "ai-help");
}

function getReclaimAction() {
  return routerModule.actions.find((entry) => entry.actionId === "reclaim");
}

function getSubscriptionAction() {
  return routerModule.actions.find((entry) => entry.actionId === "subscription");
}

function createConfigContext(args, overrides = {}) {
  return {
    args,
    mode: "commandline",
    terminal: {
      line() {},
      info() {},
      warn() {},
      error() {}
    },
    prompts: {},
    ...overrides
  };
}

function createQueuedPrompts(entries) {
  const queue = [...entries];
  const take = (type) => {
    assert.ok(queue.length > 0, `No queued answer left for ${type}`);
    const next = queue.shift();
    if (next && typeof next === "object" && next.type === "cancel") {
      throw new Error("Prompt cancelled");
    }
    if (next && typeof next === "object" && "type" in next) {
      assert.equal(next.type, type);
      return next.value;
    }
    if (next === "__cancel__") {
      throw new Error("Prompt cancelled");
    }
    return next;
  };

  return {
    select: async () => take("select"),
    text: async () => take("text"),
    confirm: async () => take("confirm"),
    password: async () => take("password"),
    multiselect: async () => take("multiselect"),
    remaining: () => [...queue]
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}

function installFetchMock(t, handler) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = String(init?.method || "GET").toUpperCase();
    let body = null;
    if (typeof init?.body === "string" && init.body.trim()) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    const call = { url, method, body };
    calls.push(call);
    return handler(call);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
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

test("subscription status subcommand runs without import errors", async () => {
  const subscriptionAction = getSubscriptionAction();
  const statusAction = subscriptionAction?.subcommands?.find((entry) => entry.actionId === "status");
  assert.ok(statusAction);

  const result = await statusAction.run(createConfigContext({}));
  assert.equal(result.exitCode, 0);
  assert.ok(String(result.data || "").includes("Subscription"));
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
    amp: {
      upstreamUrl: "https://ampcode.com/",
      upstreamApiKey: "amp_secret_123456",
      restrictManagementToLocalhost: true,
      forceModelMappings: true,
      modelMappings: [
        { from: "*", to: "openrouter/gpt-4o-mini" }
      ]
    },
    modelAliases: {
      "chat.default": {
        strategy: "round-robin",
        targets: [{ ref: "openrouter/gpt-4o-mini", weight: 2 }],
        fallbackTargets: [{ ref: "openrouter/gpt-4o" }]
      }
    }
  }, "/tmp/config.json");

  assert.match(summary, /Current Router Configuration/);
  assert.match(summary, /AMP \/ Amp CLI/);
  assert.match(summary, /amp_\.\.\.3456/);
  assert.match(summary, /openrouter\/gpt-4o-mini/);
  assert.match(summary, /Model Aliases/);
  assert.match(summary, /chat\.default/);
  assert.match(summary, /Round-robin/);
  assert.match(summary, /openrouter\/gpt-4o-mini@2/);
  assert.match(summary, /Rate-Limit Buckets/);
  assert.match(summary, /Monthly cap/);
  assert.match(summary, /20,000 requests/);
});

test("patchAmpClientConfigFiles preserves unrelated AMP client fields", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-amp-client-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const settingsFilePath = path.join(tempDir, "settings.json");
  const secretsFilePath = path.join(tempDir, "secrets.json");
  await fs.writeFile(settingsFilePath, `${JSON.stringify({ theme: "dark", "amp.url": "http://old.local:8787" }, null, 2)}
`, "utf8");
  await fs.writeFile(secretsFilePath, `${JSON.stringify({ otherSecret: "keep-me", "apiKey@http://old.local:8787": "old-key" }, null, 2)}
`, "utf8");

  const result = await patchAmpClientConfigFiles({
    settingsFilePath,
    secretsFilePath,
    endpointUrl: "http://127.0.0.1:9898/",
    apiKey: "gw_test_key"
  });

  assert.equal(result.endpointUrl, "http://127.0.0.1:9898");
  assert.equal(result.secretFieldName, "apiKey@http://127.0.0.1:9898");
  assert.equal(result.settingsCreated, false);
  assert.equal(result.secretsCreated, false);

  const nextSettings = JSON.parse(await fs.readFile(settingsFilePath, "utf8"));
  const nextSecrets = JSON.parse(await fs.readFile(secretsFilePath, "utf8"));
  assert.deepEqual(nextSettings, {
    theme: "dark",
    "amp.url": "http://127.0.0.1:9898"
  });
  assert.deepEqual(nextSecrets, {
    otherSecret: "keep-me",
    "apiKey@http://old.local:8787": "old-key",
    "apiKey@http://127.0.0.1:9898": "gw_test_key"
  });
});

test("interactive set-amp-config patches AMP and edits default routing from the new AMP menu", async (t) => {
  const configAction = getConfigAction();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-amp-quick-"));
  const emptyDataHome = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-amp-xdg-"));
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master",
    defaultModel: "chat.default",
    modelAliases: {
      "chat.default": {
        strategy: "auto",
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      }
    }
  });
  const prompts = createQueuedPrompts([
    { type: "select", value: "patch-client" },
    { type: "select", value: "workspace" },
    { type: "confirm", value: true },
    { type: "confirm", value: true },
    { type: "select", value: "routing" },
    { type: "select", value: "default-route" },
    { type: "select", value: "chat.default" },
    { type: "cancel" },
    { type: "cancel" }
  ]);

  t.after(async () => {
    await fs.rm(emptyDataHome, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const result = await configAction.run(createConfigContext({
    operation: "set-amp-config",
    config: configPath
  }, {
    cwd: tempDir,
    env: {
      ...process.env,
      XDG_DATA_HOME: emptyDataHome
    },
    forcePrompt: true,
    prompts
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(prompts.remaining(), []);

  const next = await readConfigFile(configPath);
  assert.equal(next.amp.upstreamUrl, "https://ampcode.com/");
  assert.equal(next.amp.restrictManagementToLocalhost, true);
  assert.equal(next.amp.preset, "builtin");
  assert.equal(next.amp.defaultRoute, "chat.default");

  const settingsFilePath = path.join(tempDir, ".amp", "settings.json");
  const secretsFilePath = path.join(emptyDataHome, "amp", "secrets.json");
  const nextSettings = JSON.parse(await fs.readFile(settingsFilePath, "utf8"));
  const nextSecrets = JSON.parse(await fs.readFile(secretsFilePath, "utf8"));
  assert.deepEqual(nextSettings, {
    "amp.url": LOCAL_ROUTER_ORIGIN
  });
  assert.equal(nextSecrets[`apiKey@${LOCAL_ROUTER_ORIGIN}`], "gw_local_master");
});

test("interactive set-amp-config edits AMP upstream from the new root menu", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master"
  });
  const infoLogs = [];
  const prompts = createQueuedPrompts([
    { type: "select", value: "upstream" },
    { type: "text", value: "https://ampcode.com" },
    { type: "text", value: "amp_secret_123456" },
    { type: "confirm", value: true },
    { type: "confirm", value: true },
    { type: "cancel" }
  ]);

  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  const emptyDataHome = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-amp-xdg-"));
  process.env.XDG_DATA_HOME = emptyDataHome;
  t.after(async () => {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
    await fs.rm(emptyDataHome, { recursive: true, force: true });
  });

  const result = await configAction.run(createConfigContext({
    operation: "set-amp-config",
    config: configPath
  }, {
    forcePrompt: true,
    terminal: {
      line() {},
      info(message) { infoLogs.push(String(message)); },
      warn() {},
      error() {}
    },
    prompts
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(prompts.remaining(), []);
  assert.ok(infoLogs.some((message) => message.includes("https://ampcode.com/settings")));

  const next = await readConfigFile(configPath);
  assert.equal(next.amp.upstreamUrl, "https://ampcode.com/");
  assert.equal(next.amp.upstreamApiKey, "amp_secret_123456");
  assert.equal(next.amp.restrictManagementToLocalhost, true);
  assert.equal(next.amp.forceModelMappings, true);
});

test("interactive set-amp-config edits existing AMP routes with inbound and outbound fields", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master",
    defaultModel: "chat.default",
    modelAliases: {
      "chat.default": {
        strategy: "auto",
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      },
      "chat.deep": {
        strategy: "auto",
        targets: [{ ref: "anthropic/claude-3-5-haiku" }]
      }
    },
    amp: {
      routes: {}
    }
  });
  const lineLogs = [];
  const seenRoutingOptions = [];
  const seenRouteEditorMessages = [];
  const seenTextPrompts = [];
  const queue = ["routing", "route:smart", "outbound", "chat.deep", "inbound", "gpt-*-codex*", "__cancel__", "__cancel__", "__cancel__"];
  const take = (type) => {
    assert.ok(queue.length > 0, `No queued answer left for ${type}`);
    const next = queue.shift();
    if (next === "__cancel__") throw new Error("Prompt cancelled");
    return next;
  };
  const prompts = {
    select: async ({ message, options }) => {
      if (message === "AMP routing") {
        seenRoutingOptions.push((options || []).map((option) => ({
          value: option.value,
          label: option.label,
          hint: option.hint
        })));
      }
      if (String(message || "").startsWith("AMP route · ")) {
        seenRouteEditorMessages.push(String(message));
      }
      return take("select");
    },
    text: async (options) => {
      seenTextPrompts.push({
        message: options?.message,
        initialValue: options?.initialValue,
        placeholder: options?.placeholder
      });
      return take("text");
    },
    confirm: async () => take("confirm"),
    password: async () => take("password"),
    multiselect: async () => take("multiselect"),
    remaining: () => [...queue]
  };

  const result = await configAction.run(createConfigContext({
    operation: "set-amp-config",
    config: configPath
  }, {
    forcePrompt: true,
    terminal: {
      line(message) { lineLogs.push(String(message)); },
      info() {},
      warn() {},
      error() {}
    },
    prompts
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(prompts.remaining(), []);

  const next = await readConfigFile(configPath);
  assert.equal(next.amp.routes.smart, undefined);
  assert.deepEqual(next.amp.rawModelRoutes, [
    { from: "gpt-*-codex*", to: "chat.deep" }
  ]);
  const smartOption = seenRoutingOptions.flat().find((option) => option.value === "route:smart");
  assert.equal(smartOption?.label, "smart");
  assert.match(String(smartOption?.hint || ""), /smart/i);
  assert.ok(seenRouteEditorMessages.includes("AMP route · smart"));
  assert.ok(seenTextPrompts.some((prompt) => prompt.message === "Inbound AMP model / route key" && prompt.initialValue === "claude-opus-{number}"));
  assert.ok(lineLogs.some((message) => message.includes("Default built-in match for 'smart': claude-opus-{number}")));
  assert.ok(lineLogs.some((message) => message.includes("https://ampcode.com/models")));
});

test("non-interactive set-amp-config can patch AMP client files with local gateway key", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master"
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-amp-patch-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const settingsFilePath = path.join(tempDir, "settings.json");
  const secretsFilePath = path.join(tempDir, "secrets.json");
  await fs.writeFile(secretsFilePath, `${JSON.stringify({
    "apiKey@https://ampcode.com/": "amp_upstream_secret"
  }, null, 2)}
`, "utf8");

  const result = await configAction.run(createConfigContext({
    operation: "set-amp-config",
    config: configPath,
    "patch-amp-client-config": "true",
    "amp-client-settings-file": settingsFilePath,
    "amp-client-secrets-file": secretsFilePath,
    "amp-client-url": "http://127.0.0.1:9797"
  }));

  assert.equal(result.ok, true);
  assert.match(String(result.data || ""), /AMP Client Files/);
  assert.match(String(result.data || ""), /AMP Defaults Bootstrapped[\s|]+Yes/);
  assert.match(String(result.data || ""), /Bootstrap Default Route[\s|]+openrouter\/gpt-4o-mini/);

  const next = await readConfigFile(configPath);
  assert.equal(next.amp.upstreamUrl, "https://ampcode.com/");
  assert.equal(next.amp.upstreamApiKey, "amp_upstream_secret");
  assert.equal(next.amp.restrictManagementToLocalhost, true);
  assert.equal(next.amp.preset, "builtin");
  assert.equal(next.amp.defaultRoute, "openrouter/gpt-4o-mini");

  const nextSettings = JSON.parse(await fs.readFile(settingsFilePath, "utf8"));
  const nextSecrets = JSON.parse(await fs.readFile(secretsFilePath, "utf8"));
  assert.deepEqual(nextSettings, {
    "amp.url": "http://127.0.0.1:9797"
  });
  assert.deepEqual(nextSecrets, {
    "apiKey@https://ampcode.com/": "amp_upstream_secret",
    "apiKey@http://127.0.0.1:9797": "gw_local_master"
  });
});

test("non-interactive set-amp-config patch flow preserves explicit AMP routing config", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master"
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-amp-patch-explicit-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const settingsFilePath = path.join(tempDir, "settings.json");
  const secretsFilePath = path.join(tempDir, "secrets.json");
  await fs.writeFile(secretsFilePath, `${JSON.stringify({
    "apiKey@https://ampcode.com/": "amp_upstream_secret"
  }, null, 2)}
`, "utf8");

  const result = await configAction.run(createConfigContext({
    operation: "set-amp-config",
    config: configPath,
    "patch-amp-client-config": "true",
    "amp-client-settings-file": settingsFilePath,
    "amp-client-secrets-file": secretsFilePath,
    "amp-client-url": "http://127.0.0.1:9797",
    "amp-default-route": "anthropic/claude-3-5-haiku",
    "amp-routes": '{"smart":"openrouter/gpt-4o-mini"}'
  }));

  assert.equal(result.ok, true);
  const next = await readConfigFile(configPath);
  assert.equal(next.amp.defaultRoute, "anthropic/claude-3-5-haiku");
  assert.deepEqual(next.amp.routes, {
    smart: "openrouter/gpt-4o-mini"
  });
  assert.doesNotMatch(String(result.data || ""), /AMP Defaults Bootstrapped[\s|]+Yes/);
});

test("non-interactive set-amp-config writes expected config", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());

  const result = await configAction.run(createConfigContext({
    operation: "set-amp-config",
    config: configPath,
    "amp-upstream-url": "https://ampcode.com",
    "amp-upstream-api-key": "amp_secret_123456",
    "amp-restrict-management-to-localhost": "true",
    "amp-force-model-mappings": "true",
    "amp-model-mappings": '[{"from":"*","to":"rc/gpt-5.3-codex"}]',
    "amp-subagent-mappings": '{"oracle":"rc/gpt-5.3-codex","librarian":"rc/gpt-5.3-codex"}'
  }));

  assert.equal(result.ok, true);
  const next = await readConfigFile(configPath);
  assert.equal(next.amp.upstreamUrl, "https://ampcode.com/");
  assert.equal(next.amp.upstreamApiKey, "amp_secret_123456");
  assert.equal(next.amp.restrictManagementToLocalhost, true);
  assert.equal(next.amp.forceModelMappings, true);
  assert.deepEqual(next.amp.modelMappings, [
    { from: "*", to: "rc/gpt-5.3-codex" }
  ]);
  assert.deepEqual(next.amp.subagentMappings, {
    oracle: "rc/gpt-5.3-codex",
    librarian: "rc/gpt-5.3-codex"
  });
});

test("non-interactive set-amp-config writes new AMP schema fields", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());

  const result = await configAction.run(createConfigContext({
    operation: "set-amp-config",
    config: configPath,
    "amp-preset": "builtin",
    "amp-default-route": "openrouter/gpt-4o-mini",
    "amp-routes": '{"smart":"anthropic/claude-3-5-haiku","@google-gemini-flash-shared":"openrouter/gpt-4o-mini"}',
    "amp-raw-model-routes": '[{"from":"gpt-*-codex*","to":"anthropic/claude-3-5-haiku"}]',
    "amp-overrides": '{"entities":[{"id":"reviewer","type":"feature","match":["gemini-4-pro*"],"route":"anthropic/claude-3-5-haiku"}]}'
  }));

  assert.equal(result.ok, true);
  const next = await readConfigFile(configPath);
  assert.equal(next.amp.preset, "builtin");
  assert.equal(next.amp.defaultRoute, "openrouter/gpt-4o-mini");
  assert.deepEqual(next.amp.routes, {
    smart: "anthropic/claude-3-5-haiku",
    "@google-gemini-flash-shared": "openrouter/gpt-4o-mini"
  });
  assert.deepEqual(next.amp.rawModelRoutes, [
    { from: "gpt-*-codex*", to: "anthropic/claude-3-5-haiku" }
  ]);
  assert.deepEqual(next.amp.overrides, {
    entities: [
      {
        id: "reviewer",
        type: "feature",
        match: ["gemini-4-pro*"],
        route: "anthropic/claude-3-5-haiku"
      }
    ]
  });
});


test("non-interactive set-amp-config writes custom AMP subagent definitions", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());

  const result = await configAction.run(createConfigContext({
    operation: "set-amp-config",
    config: configPath,
    "amp-subagent-definitions": '[{"id":"planner","patterns":["gpt-5.4","gpt-5.4*"]},{"id":"searcher","patterns":["gemini-3-flash"]}]',
    "amp-subagent-mappings": '{"planner":"rc/gpt-5.3-codex"}'
  }));

  assert.equal(result.ok, true);
  const next = await readConfigFile(configPath);
  assert.deepEqual(next.amp.subagentDefinitions, [
    { id: "planner", patterns: ["gpt-5.4", "gpt-5.4*"] },
    { id: "searcher", patterns: ["gemini-3-flash"] }
  ]);
  assert.deepEqual(next.amp.subagentMappings, {
    planner: "rc/gpt-5.3-codex"
  });
});

test("non-interactive set-amp-config normalizes documented AMP subagent aliases", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());

  const result = await configAction.run(createConfigContext({
    operation: "set-amp-config",
    config: configPath,
    "amp-subagent-definitions": '[{"id":"Title","patterns":["claude-haiku-4.5"]},{"id":"Look At","patterns":["gemini-2.5-flash"]}]',
    "amp-subagent-mappings": '{"titling":"rc/gpt-5.3-codex","look at":"rc/gpt-5.3-codex"}'
  }));

  assert.equal(result.ok, true);
  const next = await readConfigFile(configPath);
  assert.deepEqual(next.amp.subagentDefinitions, [
    { id: "title", patterns: ["claude-haiku-4.5"] },
    { id: "look-at", patterns: ["gemini-2.5-flash"] }
  ]);
  assert.deepEqual(next.amp.subagentMappings, {
    title: "rc/gpt-5.3-codex",
    "look-at": "rc/gpt-5.3-codex"
  });
});

test("non-interactive set-amp-config can reset custom AMP subagent definitions to defaults", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    amp: {
      subagentDefinitions: [
        { id: "planner", patterns: ["gpt-5.4"] }
      ],
      subagentMappings: {
        planner: "openrouter/gpt-4o-mini"
      }
    }
  });

  const result = await configAction.run(createConfigContext({
    operation: "set-amp-config",
    config: configPath,
    "reset-amp-subagent-definitions": "true"
  }));

  assert.equal(result.ok, true);
  const next = await readConfigFile(configPath);
  assert.equal(next.amp.subagentDefinitions, undefined);
  assert.deepEqual(next.amp.subagentMappings, {
    planner: "openrouter/gpt-4o-mini"
  });
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
    { ref: "openrouter/gpt-4o-mini", weight: 3 },
    { ref: "anthropic/claude-3-5-haiku", weight: 2 }
  ]);
  assert.deepEqual(next.modelAliases["chat.default"].fallbackTargets, [
    { ref: "openrouter/gpt-4o" }
  ]);
});

test("non-interactive upsert-provider subscription runs oauth login and probes selected models", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());
  const loginProfiles = [];
  const probedRequests = [];

  const result = await configAction.run(createConfigContext({
    operation: "upsert-provider",
    config: configPath,
    "provider-id": "chatgpt",
    name: "ChatGPT Subscription",
    type: "subscription"
  }, {
    subscriptionAuth: {
      getAuthStatus: async () => ({ authenticated: true }),
      loginWithBrowser: async (profile, options = {}) => {
        loginProfiles.push(profile);
        options.onUrl?.("https://auth.example.com", { openedBrowser: true });
        return true;
      },
      loginWithDeviceCode: async () => true
    },
    subscriptionProvider: {
      makeSubscriptionProviderCall: async ({ body }) => {
        probedRequests.push(body);
        return {
          ok: true,
          status: 200,
          response: new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        };
      }
    }
  }));

  assert.equal(result.ok, true);
  assert.match(String(result.data || ""), /Provider Saved/);
  assert.match(String(result.data || ""), /Subscription \(OAuth\)/);
  assert.deepEqual(loginProfiles, ["chatgpt"]);
  assert.deepEqual(probedRequests.map((body) => body.model), CODEX_SUBSCRIPTION_MODELS);
  assert.ok(probedRequests.every((body) => typeof body.instructions === "string" && body.instructions.length > 0));
  assert.ok(probedRequests.every((body) => body.stream === true));
  assert.ok(probedRequests.every((body) => body.max_tokens === undefined));
  assert.ok(probedRequests.every((body) => body.tool_choice === "auto"));
  assert.ok(probedRequests.every((body) => body.parallel_tool_calls === false));
  assert.ok(probedRequests.every((body) => body.messages === undefined));
  assert.ok(probedRequests.every((body) => Array.isArray(body.input) && body.input[0]?.role === "user"));

  const next = await readConfigFile(configPath);
  const provider = next.providers.find((entry) => entry.id === "chatgpt");
  assert.ok(provider);
  assert.equal(provider.type, "subscription");
  assert.equal(provider.subscriptionType, "chatgpt-codex");
  assert.equal(provider.subscriptionProfile, "chatgpt");
  assert.deepEqual(provider.models.map((model) => model.id), CODEX_SUBSCRIPTION_MODELS);
});

test("non-interactive upsert-provider subscription keeps custom model list and probes all entries", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());
  const probedRequests = [];

  const result = await configAction.run(createConfigContext({
    operation: "upsert-provider",
    config: configPath,
    "provider-id": "chatgpt-custom",
    name: "ChatGPT Custom",
    type: "subscription",
    models: "gpt-5.3-codex\ngpt-5-codex-custom"
  }, {
    subscriptionAuth: {
      getAuthStatus: async () => ({ authenticated: true }),
      loginWithBrowser: async () => true,
      loginWithDeviceCode: async () => true
    },
    subscriptionProvider: {
      makeSubscriptionProviderCall: async ({ body }) => {
        probedRequests.push(body);
        return {
          ok: true,
          status: 200,
          response: new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        };
      }
    }
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(probedRequests.map((body) => body.model), ["gpt-5.3-codex", "gpt-5-codex-custom"]);
  assert.ok(probedRequests.every((body) => typeof body.instructions === "string" && body.instructions.length > 0));
  assert.ok(probedRequests.every((body) => body.stream === true));
  assert.ok(probedRequests.every((body) => body.max_tokens === undefined));
  assert.ok(probedRequests.every((body) => body.tool_choice === "auto"));
  assert.ok(probedRequests.every((body) => body.parallel_tool_calls === false));
  assert.ok(probedRequests.every((body) => body.messages === undefined));
  assert.ok(probedRequests.every((body) => Array.isArray(body.input) && body.input[0]?.role === "user"));

  const next = await readConfigFile(configPath);
  const provider = next.providers.find((entry) => entry.id === "chatgpt-custom");
  assert.ok(provider);
  assert.deepEqual(provider.models.map((model) => model.id), ["gpt-5.3-codex", "gpt-5-codex-custom"]);
});

test("non-interactive upsert-provider Claude subscription probes Claude-formatted payload", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());
  const probedRequests = [];
  const authStatusCalls = [];

  const result = await configAction.run(createConfigContext({
    operation: "upsert-provider",
    config: configPath,
    "provider-id": "claude-sub",
    name: "Claude Subscription",
    type: "subscription",
    "subscription-type": "claude-code"
  }, {
    subscriptionAuth: {
      getAuthStatus: async (_profile, options = {}) => {
        authStatusCalls.push(options.subscriptionType);
        return { authenticated: true };
      },
      loginWithBrowser: async () => true,
      loginWithDeviceCode: async () => true
    },
    subscriptionProvider: {
      makeSubscriptionProviderCall: async ({ body }) => {
        probedRequests.push(body);
        return {
          ok: true,
          status: 200,
          response: new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        };
      }
    }
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(authStatusCalls, ["claude-code"]);
  assert.deepEqual(probedRequests.map((body) => body.model), CLAUDE_CODE_SUBSCRIPTION_MODELS);
  assert.ok(probedRequests.every((body) => body.stream === true));
  assert.ok(probedRequests.every((body) => Array.isArray(body.messages) && body.messages[0]?.role === "user"));
  assert.ok(probedRequests.every((body) => body.messages?.[0]?.content?.[0]?.type === "text"));
  assert.ok(probedRequests.every((body) => body.input === undefined));
  assert.ok(probedRequests.every((body) => body.instructions === undefined));

  const next = await readConfigFile(configPath);
  const provider = next.providers.find((entry) => entry.id === "claude-sub");
  assert.ok(provider);
  assert.equal(provider.type, "subscription");
  assert.equal(provider.subscriptionType, "claude-code");
  assert.equal(provider.subscriptionProfile, "claude-sub");
  assert.equal(provider.format, "claude");
  assert.deepEqual(provider.models.map((model) => model.id), CLAUDE_CODE_SUBSCRIPTION_MODELS);
});

test("non-interactive upsert-provider validates unsupported subscription-type", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());

  const result = await configAction.run(createConfigContext({
    operation: "upsert-provider",
    config: configPath,
    "provider-id": "chatgpt",
    name: "ChatGPT Subscription",
    type: "subscription",
    "subscription-type": "unknown-subscription-type"
  }, {
    subscriptionAuth: {
      getAuthStatus: async () => ({ authenticated: true }),
      loginWithBrowser: async () => true,
      loginWithDeviceCode: async () => true
    }
  }));

  assert.equal(result.ok, false);
  assert.match(String(result.errorMessage || ""), /Unsupported subscription-type/);
});

test("subscription login rejects device-code for claude subscription type", async () => {
  const subscriptionAction = getSubscriptionAction();
  const loginAction = subscriptionAction?.subcommands?.find((entry) => entry.actionId === "login");
  assert.ok(loginAction);

  const result = await loginAction.run(createConfigContext({
    "subscription-type": "claude-code",
    "device-code": true
  }));

  assert.equal(result.exitCode, 2);
  assert.match(String(result.data || ""), /Device code flow is not supported/);
});

test("non-interactive upsert-provider subscription auto-generates unique gpt-sub id with suffix", async (t) => {
  const configAction = getConfigAction();
  const fixture = baseConfigFixture();
  fixture.providers.push({
    id: "gpt-sub",
    name: "Existing Sub Provider",
    baseUrl: "https://example.com/v1",
    format: "openai",
    formats: ["openai"],
    apiKey: "sk-existing",
    models: [{ id: "gpt-4o-mini" }]
  });
  const configPath = await createTempConfigFile(t, fixture);
  const probedRequests = [];

  const result = await configAction.run(createConfigContext({
    operation: "upsert-provider",
    config: configPath,
    type: "subscription"
  }, {
    subscriptionAuth: {
      getAuthStatus: async () => ({ authenticated: true }),
      loginWithBrowser: async () => true,
      loginWithDeviceCode: async () => true
    },
    subscriptionProvider: {
      makeSubscriptionProviderCall: async ({ body }) => {
        probedRequests.push(body);
        return {
          ok: true,
          status: 200,
          response: new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        };
      }
    }
  }));

  assert.equal(result.ok, true);
  const next = await readConfigFile(configPath);
  const provider = next.providers.find((entry) => entry.id === "gpt-sub-2");
  assert.ok(provider);
  assert.equal(provider.name, "GPT Sub");
  assert.equal(provider.subscriptionProfile, "gpt-sub-2");
  assert.deepEqual(probedRequests.map((body) => body.model), CODEX_SUBSCRIPTION_MODELS);
});

test("non-interactive upsert-provider can fill model context windows from LiteLLM", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, baseConfigFixture());
  const lookupCalls = [];
  const terminalLines = [];

  const result = await configAction.run(createConfigContext({
    operation: "upsert-provider",
    config: configPath,
    "provider-id": "demo",
    name: "Demo",
    "base-url": "https://example.com/v1",
    "api-key": "sk-demo",
    models: "gpt-4o-mini,gpt-4o",
    "skip-probe": "true",
    "fill-model-context-windows": "true"
  }, {
    terminal: {
      line(message) {
        terminalLines.push(message);
      },
      info() {},
      warn() {},
      error() {}
    },
    lookupLiteLlmContextWindow: async ({ models }) => {
      lookupCalls.push(models);
      return [
        {
          query: "gpt-4o-mini",
          exactMatch: {
            model: "gpt-4o-mini",
            contextWindow: 128000
          },
          suggestions: []
        },
        {
          query: "gpt-4o",
          exactMatch: {
            model: "gpt-4o",
            contextWindow: 128000
          },
          suggestions: []
        }
      ];
    }
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(lookupCalls, [["gpt-4o-mini", "gpt-4o"]]);
  const next = await readConfigFile(configPath);
  const provider = next.providers.find((entry) => entry.id === "demo");
  assert.ok(provider);
  assert.deepEqual(provider.models.map((model) => ({
    id: model.id,
    contextWindow: model.contextWindow
  })), [
    { id: "gpt-4o-mini", contextWindow: 128000 },
    { id: "gpt-4o", contextWindow: 128000 }
  ]);
  assert.match(terminalLines.join("\n"), /LiteLLM filled 2 model context windows/i);
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
  assert.match(String(result.data || ""), /Model Alias Saved/);
  assert.match(String(result.data || ""), /Routing Strategy/);
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
  assert.match(String(result.data || ""), /Rate-Limit Buckets Updated/);
  assert.match(String(result.data || ""), /Provider ID/);
  const next = await readConfigFile(configPath);
  const provider = next.providers.find((entry) => entry.id === "openrouter");
  assert.deepEqual(provider.rateLimits, [
    {
      id: "openrouter-all-month",
      models: ["all"],
      requests: 20000,
      window: { unit: "month", size: 1 }
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
      window: { unit: "month", size: 1 }
    }
  ]);
});

test("non-interactive set-provider-rate-limits ignores pre-existing stale alias refs", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    modelAliases: {
      "chat.default": {
        strategy: "auto",
        targets: [{ ref: "rc/claude-opus-4-6" }]
      }
    }
  });

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
  assert.equal(next.providers.find((entry) => entry.id === "openrouter")?.rateLimits?.[0]?.id, "openrouter-all-month");
  assert.equal(next.modelAliases["chat.default"].targets[0].ref, "rc/claude-opus-4-6");
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
  assert.match(String(list.data || ""), /Model Aliases/);
  assert.match(String(list.data || ""), /Rate-Limit Buckets/);

  const normalized = await readConfigFile(configPath);
  assert.equal(normalized.version, 2);
  assert.equal(normalized.modelAliases["chat.default"].targets.length, 2);
});

test("set-codex-cli-routing patches Codex CLI config and tool-status reports it", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master"
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-codex-tool-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const codexConfigPath = path.join(tempDir, "config.toml");

  const patchResult = await configAction.run(createConfigContext({
    operation: "set-codex-cli-routing",
    config: configPath,
    "codex-config-file": codexConfigPath,
    "default-model": "openrouter/gpt-4o-mini",
    "thinking-level": "high"
  }));

  assert.equal(patchResult.ok, true);
  const codexConfigText = await fs.readFile(codexConfigPath, "utf8");
  assert.match(codexConfigText, /model_provider = "llm-router"/);
  assert.match(codexConfigText, /model = "openrouter\/gpt-4o-mini"/);

  const statusResult = await configAction.run(createConfigContext({
    operation: "tool-status",
    config: configPath,
    "codex-config-file": codexConfigPath
  }));

  assert.equal(statusResult.ok, true);
  assert.match(String(statusResult.data || ""), /Codex CLI/);
  assert.match(String(statusResult.data || ""), /Routed Via Router\s+\|\s+Yes/);
  assert.match(String(statusResult.data || ""), /openrouter\/gpt-4o-mini/);
});

test("set-claude-code-routing patches Claude Code settings and tool-status reports it", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master"
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-claude-tool-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const claudeSettingsPath = path.join(tempDir, "settings.json");

  const patchResult = await configAction.run(createConfigContext({
    operation: "set-claude-code-routing",
    config: configPath,
    "claude-code-settings-file": claudeSettingsPath,
    "primary-model": "openrouter/gpt-4o-mini",
    "default-haiku-model": "anthropic/claude-3-5-haiku",
    "thinking-level": "high"
  }));

  assert.equal(patchResult.ok, true);
  const claudeSettings = JSON.parse(await fs.readFile(claudeSettingsPath, "utf8"));
  assert.equal(claudeSettings.env.ANTHROPIC_MODEL, "openrouter/gpt-4o-mini");
  assert.equal(claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "anthropic/claude-3-5-haiku");

  const statusResult = await configAction.run(createConfigContext({
    operation: "tool-status",
    config: configPath,
    "claude-code-settings-file": claudeSettingsPath
  }));

  assert.equal(statusResult.ok, true);
  assert.match(String(statusResult.data || ""), /Claude Code/);
  assert.match(String(statusResult.data || ""), /Routed Via Router\s+\|\s+Yes/);
  assert.match(String(statusResult.data || ""), /anthropic\/claude-3-5-haiku/);
});

test("set-factory-droid-routing patches Factory Droid settings and tool-status reports it", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master"
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-factory-droid-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const factoryDroidSettingsPath = path.join(tempDir, "settings.json");
  const existingUserCustomModel = {
    id: "user-managed-model",
    model: "user/provider-model",
    displayName: "User Managed Model",
    provider: "openai",
    baseUrl: "https://example.com/v1",
    apiKey: "sk-user"
  };
  await fs.writeFile(factoryDroidSettingsPath, `${JSON.stringify({
    customModels: [existingUserCustomModel]
  }, null, 2)}\n`, "utf8");

  const patchResult = await configAction.run(createConfigContext({
    operation: "set-factory-droid-routing",
    config: configPath,
    "factory-droid-settings-file": factoryDroidSettingsPath,
    "default-model": "openrouter/gpt-4o-mini",
    "mission-orchestrator-model": "anthropic/claude-3-5-haiku",
    "mission-worker-model": "openrouter/gpt-4o",
    "mission-validator-model": "anthropic/claude-3-5-haiku",
    "reasoning-effort": "medium"
  }));

  assert.equal(patchResult.ok, true);
  const factoryDroidSettings = JSON.parse(await fs.readFile(factoryDroidSettingsPath, "utf8"));
  assert.equal(factoryDroidSettings.reasoningEffort, "medium");
  assert.ok(Array.isArray(factoryDroidSettings.customModels), "customModels should be an array");
  const managedCustomModels = factoryDroidSettings.customModels.filter((entry) => entry._llmRouterManaged === true);
  const unmanagedCustomModels = factoryDroidSettings.customModels.filter((entry) => entry._llmRouterManaged !== true);
  assert.deepEqual(
    managedCustomModels.map((entry) => entry.displayName).sort(),
    [
      "Claude 3.5 haiku - LLM Router (Anthropic)",
      "GPT 4o - LLM Router (OpenRouter)",
      "GPT 4o mini - LLM Router (OpenRouter)",
      "default - LLM Router (Alias)"
    ]
  );
  assert.deepEqual(unmanagedCustomModels, [existingUserCustomModel]);
  const customModelIdsByModelRef = new Map(factoryDroidSettings.customModels.map((entry) => [entry.model, entry.id]));
  const customModelsByModelRef = new Map(factoryDroidSettings.customModels.map((entry) => [entry.model, entry]));
  for (const entry of managedCustomModels) {
    assert.equal(entry._llmRouterManaged, true);
    assert.match(String(entry.id || ""), /^custom:llm-/);
    assert.equal(Number.isInteger(entry.index), true);
  }
  assert.equal(customModelsByModelRef.get("default")?.provider, "openai");
  assert.match(customModelsByModelRef.get("default")?.baseUrl || "", /\/openai\/v1$/);
  assert.equal(customModelsByModelRef.get("openrouter/gpt-4o-mini")?.provider, "openai");
  assert.match(customModelsByModelRef.get("openrouter/gpt-4o-mini")?.baseUrl || "", /\/openai\/v1$/);
  assert.equal(customModelsByModelRef.get("openrouter/gpt-4o")?.provider, "openai");
  assert.match(customModelsByModelRef.get("openrouter/gpt-4o")?.baseUrl || "", /\/openai\/v1$/);
  assert.equal(customModelsByModelRef.get("anthropic/claude-3-5-haiku")?.provider, "anthropic");
  assert.match(customModelsByModelRef.get("anthropic/claude-3-5-haiku")?.baseUrl || "", /\/anthropic$/);
  assert.equal(factoryDroidSettings.model, customModelIdsByModelRef.get("openrouter/gpt-4o-mini"));
  assert.equal(factoryDroidSettings.sessionDefaultSettings?.model, customModelIdsByModelRef.get("openrouter/gpt-4o-mini"));
  assert.equal(factoryDroidSettings.missionOrchestratorModel, customModelIdsByModelRef.get("anthropic/claude-3-5-haiku"));
  assert.equal(factoryDroidSettings.missionModelSettings?.workerModel, customModelIdsByModelRef.get("openrouter/gpt-4o"));
  assert.equal(factoryDroidSettings.missionModelSettings?.validationWorkerModel, customModelIdsByModelRef.get("anthropic/claude-3-5-haiku"));

  const statusResult = await configAction.run(createConfigContext({
    operation: "tool-status",
    config: configPath,
    "factory-droid-settings-file": factoryDroidSettingsPath
  }));

  assert.equal(statusResult.ok, true);
  assert.match(String(statusResult.data || ""), /Factory Droid/);
  assert.match(String(statusResult.data || ""), /Routed Via Router\s+\|\s+Yes/);
  assert.match(String(statusResult.data || ""), /Provider\s+\|\s+openai/);
  assert.match(String(statusResult.data || ""), /openrouter\/gpt-4o-mini/);
  assert.match(String(statusResult.data || ""), /openrouter\/gpt-4o/);
  assert.match(String(statusResult.data || ""), /anthropic\/claude-3-5-haiku/);

  const disableResult = await configAction.run(createConfigContext({
    operation: "set-factory-droid-routing",
    config: configPath,
    "factory-droid-settings-file": factoryDroidSettingsPath,
    enabled: "false"
  }));
  assert.equal(disableResult.ok, true);
  const restored = JSON.parse(await fs.readFile(factoryDroidSettingsPath, "utf8"));
  assert.deepEqual(restored.customModels, [existingUserCustomModel], "router disable should restore unmanaged customModels");
  assert.equal("sessionDefaultSettings" in restored, false);
  assert.equal("missionOrchestratorModel" in restored, false);
  assert.equal("missionModelSettings" in restored, false);
});

test("set-factory-droid-routing legacy mission-model applies to all mission roles", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master"
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-factory-droid-legacy-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const factoryDroidSettingsPath = path.join(tempDir, "settings.json");

  const patchResult = await configAction.run(createConfigContext({
    operation: "set-factory-droid-routing",
    config: configPath,
    "factory-droid-settings-file": factoryDroidSettingsPath,
    "default-model": "openrouter/gpt-4o-mini",
    "mission-model": "anthropic/claude-3-5-haiku"
  }));

  assert.equal(patchResult.ok, true);
  const factoryDroidSettings = JSON.parse(await fs.readFile(factoryDroidSettingsPath, "utf8"));
  const customModelIdsByModelRef = new Map(factoryDroidSettings.customModels.map((entry) => [entry.model, entry.id]));
  assert.equal(factoryDroidSettings.missionOrchestratorModel, customModelIdsByModelRef.get("anthropic/claude-3-5-haiku"));
  assert.equal(factoryDroidSettings.missionModelSettings?.workerModel, customModelIdsByModelRef.get("anthropic/claude-3-5-haiku"));
  assert.equal(factoryDroidSettings.missionModelSettings?.validationWorkerModel, customModelIdsByModelRef.get("anthropic/claude-3-5-haiku"));
});

test("set-factory-droid-routing injects every router alias into Factory Droid custom model list", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    defaultModel: "chat.default",
    masterKey: "gw_local_master",
    modelAliases: {
      "chat.default": {
        id: "chat.default",
        strategy: "ordered",
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      },
      "chat.plan": {
        id: "chat.plan",
        strategy: "ordered",
        targets: [{ ref: "anthropic/claude-3-5-haiku" }]
      },
      "chat.build": {
        id: "chat.build",
        strategy: "ordered",
        targets: [{ ref: "openrouter/gpt-4o" }]
      }
    }
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-factory-droid-aliases-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const factoryDroidSettingsPath = path.join(tempDir, "settings.json");

  const patchResult = await configAction.run(createConfigContext({
    operation: "set-factory-droid-routing",
    config: configPath,
    "factory-droid-settings-file": factoryDroidSettingsPath,
    "default-model": "chat.default",
    "mission-orchestrator-model": "chat.plan",
    "mission-worker-model": "chat.build",
    "mission-validator-model": "chat.plan"
  }));

  assert.equal(patchResult.ok, true);
  const factoryDroidSettings = JSON.parse(await fs.readFile(factoryDroidSettingsPath, "utf8"));
  assert.deepEqual(
    factoryDroidSettings.customModels.map((entry) => entry.displayName).sort(),
    [
      "Claude 3.5 haiku - LLM Router (Anthropic)",
      "GPT 4o - LLM Router (OpenRouter)",
      "GPT 4o mini - LLM Router (OpenRouter)",
      "chat.build - LLM Router (Alias)",
      "chat.default - LLM Router (Alias)",
      "chat.plan - LLM Router (Alias)",
      "default - LLM Router (Alias)"
    ]
  );
  const customModelIdsByModelRef = new Map(factoryDroidSettings.customModels.map((entry) => [entry.model, entry.id]));
  const customModelsByModelRef = new Map(factoryDroidSettings.customModels.map((entry) => [entry.model, entry]));
  assert.equal(customModelsByModelRef.get("chat.default")?.provider, "openai");
  assert.match(customModelsByModelRef.get("chat.default")?.baseUrl || "", /\/openai\/v1$/);
  assert.equal(customModelsByModelRef.get("chat.plan")?.provider, "anthropic");
  assert.match(customModelsByModelRef.get("chat.plan")?.baseUrl || "", /\/anthropic$/);
  assert.equal(customModelsByModelRef.get("chat.build")?.provider, "openai");
  assert.match(customModelsByModelRef.get("chat.build")?.baseUrl || "", /\/openai\/v1$/);
  assert.equal(factoryDroidSettings.model, customModelIdsByModelRef.get("chat.default"));
  assert.equal(factoryDroidSettings.sessionDefaultSettings?.model, customModelIdsByModelRef.get("chat.default"));
  assert.equal(factoryDroidSettings.missionOrchestratorModel, customModelIdsByModelRef.get("chat.plan"));
  assert.equal(factoryDroidSettings.missionModelSettings?.workerModel, customModelIdsByModelRef.get("chat.build"));
  assert.equal(factoryDroidSettings.missionModelSettings?.validationWorkerModel, customModelIdsByModelRef.get("chat.plan"));
});

test("set-factory-droid-routing accepts stable llm model ids for Factory bindings", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    defaultModel: "chat.default",
    masterKey: "gw_local_master",
    modelAliases: {
      "chat.default": {
        id: "chat.default",
        strategy: "ordered",
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      }
    }
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-factory-droid-ids-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const factoryDroidSettingsPath = path.join(tempDir, "settings.json");

  const patchResult = await configAction.run(createConfigContext({
    operation: "set-factory-droid-routing",
    config: configPath,
    "factory-droid-settings-file": factoryDroidSettingsPath,
    "default-model": "custom:llm-alias-chat.default",
    "mission-orchestrator-model": "custom:llm-anthropic-claude-3-5-haiku",
    "mission-worker-model": "custom:llm-openrouter-gpt-4o",
    "mission-validator-model": "custom:llm-anthropic-claude-3-5-haiku"
  }));

  assert.equal(patchResult.ok, true);
  const factoryDroidSettings = JSON.parse(await fs.readFile(factoryDroidSettingsPath, "utf8"));
  assert.equal(factoryDroidSettings.model, "custom:llm-alias-chat.default");
  assert.equal(factoryDroidSettings.sessionDefaultSettings?.model, "custom:llm-alias-chat.default");
  assert.equal(factoryDroidSettings.missionOrchestratorModel, "custom:llm-anthropic-claude-3-5-haiku");
  assert.equal(factoryDroidSettings.missionModelSettings?.workerModel, "custom:llm-openrouter-gpt-4o");
  assert.equal(factoryDroidSettings.missionModelSettings?.validationWorkerModel, "custom:llm-anthropic-claude-3-5-haiku");
});

test("tool-status resolves Factory Droid internal llm ids back to managed route refs", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    defaultModel: "chat.default",
    modelAliases: {
      "chat.default": {
        id: "chat.default",
        strategy: "ordered",
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      }
    }
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-factory-droid-status-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const factoryDroidSettingsPath = path.join(tempDir, "settings.json");
  await fs.writeFile(factoryDroidSettingsPath, JSON.stringify({
    model: "custom:llm-alias-chat.default",
    sessionDefaultSettings: {
      model: "custom:llm-alias-chat.default"
    },
    missionOrchestratorModel: "custom:llm-openrouter-gpt-4o-mini",
    missionModelSettings: {
      workerModel: "custom:llm-openrouter-gpt-4o",
      validationWorkerModel: "custom:llm-anthropic-claude-3-5-haiku"
    }
  }, null, 2));

  const statusResult = await configAction.run(createConfigContext({
    operation: "tool-status",
    config: configPath,
    "factory-droid-settings-file": factoryDroidSettingsPath
  }));

  assert.equal(statusResult.ok, true);
  assert.match(String(statusResult.data || ""), /Factory Droid/);
  assert.match(String(statusResult.data || ""), /Default Model\s+\|\s+chat\.default/);
  assert.match(String(statusResult.data || ""), /Mission Orchestrator\s+\|\s+openrouter\/gpt-4o-mini/);
  assert.match(String(statusResult.data || ""), /Mission Worker\s+\|\s+openrouter\/gpt-4o/);
  assert.match(String(statusResult.data || ""), /Mission Validator\s+\|\s+anthropic\/claude-3-5-haiku/);
  assert.doesNotMatch(String(statusResult.data || ""), /custom:llm-/);
});

test("set-amp-client-routing bootstraps config and can unpatch AMP client files", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master"
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-amp-tool-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const settingsFilePath = path.join(tempDir, "settings.json");
  const secretsFilePath = path.join(tempDir, "secrets.json");

  const patchResult = await configAction.run(createConfigContext({
    operation: "set-amp-client-routing",
    config: configPath,
    "amp-client-settings-scope": "global",
    "amp-client-settings-file": settingsFilePath,
    "amp-client-secrets-file": secretsFilePath
  }));

  assert.equal(patchResult.ok, true);
  const updatedConfig = await readConfigFile(configPath);
  assert.equal(updatedConfig.amp.defaultRoute, "openrouter/gpt-4o-mini");

  const settingsAfterPatch = JSON.parse(await fs.readFile(settingsFilePath, "utf8"));
  assert.equal(settingsAfterPatch["amp.url"], LOCAL_ROUTER_ORIGIN);

  const unpatchResult = await configAction.run(createConfigContext({
    operation: "set-amp-client-routing",
    config: configPath,
    enabled: "false",
    "amp-client-settings-scope": "global",
    "amp-client-settings-file": settingsFilePath,
    "amp-client-secrets-file": secretsFilePath
  }));

  assert.equal(unpatchResult.ok, true);
  const settingsAfterUnpatch = JSON.parse(await fs.readFile(settingsFilePath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(settingsAfterUnpatch, "amp.url"), false);
});

test("snapshot includes runtime and coding tool sections", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master"
  });

  const result = await configAction.run(createConfigContext({
    operation: "snapshot",
    config: configPath
  }));

  assert.equal(result.ok, true);
  assert.match(String(result.data || ""), /Router Snapshot/);
  assert.match(String(result.data || ""), /Runtime/);
  assert.match(String(result.data || ""), /Codex CLI/);
  assert.match(String(result.data || ""), /Claude Code/);
  assert.match(String(result.data || ""), /AMP Client/);
});

test("validate reports success for a valid config", async (t) => {
  const configAction = getConfigAction();
  const configPath = await createTempConfigFile(t, {
    ...baseConfigFixture(),
    masterKey: "gw_local_master"
  });

  const result = await configAction.run(createConfigContext({
    operation: "validate",
    config: configPath
  }));

  assert.equal(result.ok, true);
  assert.match(String(result.data || ""), /Config Validation/);
  assert.match(String(result.data || ""), /JSON Parse\s+\|\s+Passed/);
  assert.match(String(result.data || ""), /Validation\s+\|\s+Passed/);
});

test("validate reports parse errors for invalid JSON", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-validate-bad-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const configPath = path.join(tempDir, "config.json");
  await fs.writeFile(configPath, "{ invalid json\n", "utf8");
  const configAction = getConfigAction();

  const result = await configAction.run(createConfigContext({
    operation: "validate",
    config: configPath
  }));

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.match(String(result.errorMessage || ""), /Config Validation/);
  assert.match(String(result.errorMessage || ""), /JSON parse error/i);
});

test("reclaim action reports when the fixed port is already free", async () => {
  const reclaimAction = getReclaimAction();
  assert.ok(reclaimAction);
  let reclaimCalls = 0;

  const result = await reclaimAction.run({
    args: {},
    mode: "commandline",
    terminal: {
      line() {},
      error() {}
    },
    listListeningPids: () => ({ ok: true, pids: [] }),
    reclaimPort: async () => {
      reclaimCalls += 1;
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(reclaimCalls, 0);
  assert.match(String(result.data || ""), /Router Port Reclaim/);
  assert.match(String(result.data || ""), /Busy Before\s+\|\s+No/);
  assert.match(String(result.data || ""), /Reclaimed\s+\|\s+No/);
});

test("reclaim action frees a busy fixed port", async () => {
  const reclaimAction = getReclaimAction();
  assert.ok(reclaimAction);
  const probes = [
    { ok: true, pids: [43210] },
    { ok: true, pids: [] }
  ];
  let probeIndex = 0;
  let reclaimCalls = 0;

  const result = await reclaimAction.run({
    args: {},
    mode: "commandline",
    terminal: {
      line() {},
      error() {}
    },
    listListeningPids: () => probes[Math.min(probeIndex++, probes.length - 1)],
    reclaimPort: async () => {
      reclaimCalls += 1;
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(reclaimCalls, 1);
  assert.match(String(result.data || ""), /Router Port Reclaim/);
  assert.match(String(result.data || ""), /Reclaimed\s+\|\s+Yes/);
  assert.match(String(result.data || ""), /43210/);
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
  assert.match(String(result.data || ""), /Config Migration Completed|Config Already Up To Date/);
  assert.match(String(result.data || ""), /Current Version\s+\|\s+2/);

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
  assert.match(String(result.data || ""), /llr -h/);
  assert.match(String(result.data || ""), /llr config -h/);
  assert.match(String(result.data || ""), /llr reclaim/);
  assert.match(String(result.data || ""), /llr config --operation=validate/);
  assert.match(String(result.data || ""), /llr config --operation=snapshot/);
  assert.match(String(result.data || ""), /set-codex-cli-routing/);
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
