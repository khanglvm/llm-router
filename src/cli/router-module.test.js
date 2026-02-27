import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWranglerDeployTargetToToml,
  buildDefaultWranglerTomlForDeploy,
  buildCloudflareApiTokenSetupGuide,
  CLOUDFLARE_FREE_SECRET_SIZE_LIMIT_BYTES,
  evaluateCloudflareMembershipsResult,
  evaluateCloudflareTokenVerifyResult,
  extractCloudflareMembershipAccounts,
  hasNoDeployTargets,
  hasWranglerDeployTargetConfigured,
  inferCloudflareTierFromWhoami,
  normalizeWranglerRoutePattern,
  resolveCloudflareApiTokenFromEnv,
  shouldConfirmLargeWorkerConfigDeploy,
  validateCloudflareApiTokenInput
} from "./router-module.js";

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

test("applyWranglerDeployTargetToToml replaces existing top-level routes when replaceExistingTarget=true", () => {
  const input = [
    "name = \"demo\"",
    "workers_dev = false",
    "routes = [",
    "  { pattern = \"old.example.com/*\", zone_name = \"example.com\" }",
    "]",
    ""
  ].join("\n");

  const next = applyWranglerDeployTargetToToml(input, {
    useWorkersDev: false,
    routePattern: "new.example.com/*",
    zoneName: "example.com",
    replaceExistingTarget: true
  });

  assert.match(next, /pattern = "new\.example\.com\/\*"/);
  assert.doesNotMatch(next, /pattern = "old\.example\.com\/\*"/);
});
