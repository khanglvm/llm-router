import test from "node:test";
import assert from "node:assert/strict";
import { FORMATS } from "../translator/index.js";
import {
  CONFIG_VERSION,
  assertSupportedRuntimeConfigVersion,
  migrateRuntimeConfig,
  normalizeRuntimeConfig,
  resolveRequestModel,
  resolveRequestedRoute,
  resolveRouteReference,
  validateRuntimeConfig
} from "./config.js";

function createBaseRawConfig(overrides = {}) {
  const base = {
    version: 1,
    defaultModel: "openrouter/gpt-4o-mini",
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [
          {
            id: "gpt-4o-mini",
            aliases: ["gpt4o-mini"],
            fallbackModels: ["anthropic/claude-3-5-haiku"]
          },
          {
            id: "gpt-4o"
          }
        ]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [
          {
            id: "claude-3-5-haiku"
          }
        ]
      }
    ]
  };

  return {
    ...base,
    ...overrides
  };
}

test("normalizeRuntimeConfig keeps v1 configs idempotent", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig());

  assert.equal(normalized.version, 1);
  assert.deepEqual(normalized.modelAliases, {});
  assert.deepEqual(normalized.providers[0].rateLimits, []);

  const roundTrip = normalizeRuntimeConfig(JSON.parse(JSON.stringify(normalized)));
  assert.equal(roundTrip.version, 1);
  assert.deepEqual(roundTrip.modelAliases, {});
  assert.deepEqual(roundTrip.providers[0].rateLimits, []);
});

test("normalizeRuntimeConfig upgrades explicit v1 to v2 when v2-only fields are present", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: 1,
    modelAliases: {
      "chat.default": {
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      }
    }
  }));

  assert.equal(normalized.version, 2);
});

test("assertSupportedRuntimeConfigVersion accepts future versions without version-diff failure", () => {
  const version = assertSupportedRuntimeConfigVersion({ version: CONFIG_VERSION + 1 });
  assert.equal(version, CONFIG_VERSION + 1);
});

test("migrateRuntimeConfig can upgrade v1 config to v2 schema", () => {
  const migrated = migrateRuntimeConfig(createBaseRawConfig({
    version: 1
  }), { targetVersion: 2 });

  assert.equal(migrated.version, 2);
  assert.ok(migrated.modelAliases && typeof migrated.modelAliases === "object");
  assert.ok(Array.isArray(migrated.providers[0].rateLimits));
});

test("normalizeRuntimeConfig supports v2 aliases and provider rate limits", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "chat.default",
    modelAliases: {
      "chat.default": {
        strategy: "quota-aware-weighted-rr",
        targets: [
          { ref: "openrouter/gpt-4o-mini", weight: 3, metadata: { lane: "primary" } },
          { ref: "anthropic/claude-3-5-haiku", weight: 2 }
        ],
        fallbackTargets: [
          { ref: "openrouter/gpt-4o" }
        ],
        metadata: { owner: "router-team" }
      }
    },
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [
          { id: "gpt-4o-mini" },
          { id: "gpt-4o" }
        ],
        rateLimits: [
          {
            id: "openrouter-all-month",
            name: "Monthly cap",
            models: ["all"],
            requests: "20000",
            window: { unit: "month", size: "1" },
            metadata: { scope: "global" }
          }
        ]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [
          { id: "claude-3-5-haiku" }
        ]
      }
    ]
  }));

  assert.equal(normalized.version, CONFIG_VERSION);
  assert.equal(normalized.defaultModel, "chat.default");
  assert.equal(normalized.modelAliases["chat.default"].strategy, "quota-aware-weighted-rr");
  assert.deepEqual(
    normalized.modelAliases["chat.default"].targets.map((target) => target.ref),
    ["openrouter/gpt-4o-mini", "anthropic/claude-3-5-haiku"]
  );
  assert.deepEqual(normalized.modelAliases["chat.default"].metadata, { owner: "router-team" });
  assert.equal(normalized.providers[0].rateLimits[0].name, "Monthly cap");
  assert.equal(normalized.providers[0].rateLimits[0].requests, 20000);
  assert.deepEqual(normalized.providers[0].rateLimits[0].window, { unit: "month", size: 1 });
  assert.deepEqual(normalized.providers[0].rateLimits[0].metadata, { scope: "global" });
});

test("validateRuntimeConfig accepts auto model routing strategy", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    modelAliases: {
      coding: {
        strategy: "auto",
        targets: [
          { ref: "openrouter/gpt-4o-mini" },
          { ref: "anthropic/claude-3-5-haiku" }
        ]
      }
    }
  }));

  const errors = validateRuntimeConfig(normalized);
  assert.deepEqual(errors, []);
  const resolved = resolveRequestedRoute(normalized, "coding", FORMATS.OPENAI);
  assert.equal(resolved.routeStrategy, "auto");
});

test("normalizeRuntimeConfig generates stable unique ids for name-only buckets", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }],
        rateLimits: [
          {
            name: "Monthly cap",
            models: ["all"],
            requests: 20000,
            window: { unit: "month", size: 1 }
          },
          {
            name: "Monthly cap",
            models: ["all"],
            requests: 1000,
            window: { unit: "week", size: 1 }
          }
        ]
      }
    ]
  }));

  assert.deepEqual(
    normalized.providers[0].rateLimits.map((bucket) => bucket.id),
    ["monthly-cap", "monthly-cap-2"]
  );
  assert.deepEqual(
    normalized.providers[0].rateLimits.map((bucket) => bucket.name),
    ["Monthly cap", "Monthly cap"]
  );
});

test("validateRuntimeConfig rejects malformed alias target refs", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    modelAliases: {
      "chat.default": {
        targets: [
          { ref: "openrouter/" }
        ]
      }
    }
  }));

  const errors = validateRuntimeConfig(normalized);
  assert.ok(errors.some((error) => error.includes("invalid ref 'openrouter/'")));
});

test("validateRuntimeConfig rejects invalid bucket windows", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [
          { id: "gpt-4o-mini" }
        ],
        rateLimits: [
          {
            id: "bad-window",
            models: ["all"],
            requests: 100,
            window: { unit: "year", size: 0 }
          }
        ]
      }
    ]
  }));

  const errors = validateRuntimeConfig(normalized);
  assert.ok(errors.some((error) => error.includes("invalid window unit 'year'")));
  assert.ok(errors.some((error) => error.includes("window.size as a positive integer")));
});

test("validateRuntimeConfig rejects unknown alias target refs", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    modelAliases: {
      "chat.default": {
        targets: [
          { ref: "openrouter/gpt-4.1-mini" }
        ]
      }
    }
  }));

  const errors = validateRuntimeConfig(normalized);
  assert.ok(errors.some((error) => error.includes("references unknown model 'openrouter/gpt-4.1-mini'")));
});

test("validateRuntimeConfig rejects duplicate alias ids after normalization", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    modelAliases: {
      "chat.default": {
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      },
      " chat.default ": {
        targets: [{ ref: "anthropic/claude-3-5-haiku" }]
      }
    }
  }));

  const errors = validateRuntimeConfig(normalized);
  assert.ok(errors.some((error) => error.includes("Duplicate alias id 'chat.default'")));
});

test("validateRuntimeConfig rejects duplicate provider bucket ids", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [
          { id: "gpt-4o-mini" }
        ],
        rateLimits: [
          {
            id: "dup-bucket",
            models: ["all"],
            requests: 100,
            window: { unit: "month", size: 1 }
          },
          {
            id: "dup-bucket",
            models: ["gpt-4o-mini"],
            requests: 50,
            window: { unit: "week", size: 1 }
          }
        ]
      }
    ]
  }));

  const errors = validateRuntimeConfig(normalized);
  assert.ok(errors.some((error) => error.includes("duplicate rate-limit bucket id 'dup-bucket'")));
});

test("validateRuntimeConfig rejects alias cycles", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    modelAliases: {
      "chat.default": {
        targets: [{ ref: "chat.fast" }]
      },
      "chat.fast": {
        targets: [{ ref: "chat.default" }]
      }
    }
  }));

  const errors = validateRuntimeConfig(normalized);
  assert.ok(errors.some((error) => error.includes("Alias cycle detected")));
});

test("resolveRequestModel preserves direct routing and fallback behavior", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig());
  const resolved = resolveRequestModel(config, "openrouter/gpt-4o-mini", FORMATS.CLAUDE);

  assert.equal(resolved.routeType, "direct");
  assert.equal(resolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.deepEqual(
    resolved.fallbacks.map((candidate) => candidate.requestModelId),
    ["anthropic/claude-3-5-haiku"]
  );
});

test("resolveRequestedRoute expands alias requests into deterministic candidate order", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "chat.default",
    modelAliases: {
      "chat.fast": {
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      },
      "chat.default": {
        strategy: "ordered",
        targets: [
          { ref: "chat.fast" },
          { ref: "anthropic/claude-3-5-haiku" }
        ],
        fallbackTargets: [
          { ref: "openrouter/gpt-4o" }
        ]
      }
    }
  }));

  const resolved = resolveRequestedRoute(config, "chat.default", FORMATS.CLAUDE);
  assert.equal(resolved.routeType, "alias");
  assert.equal(resolved.routeRef, "chat.default");
  assert.equal(resolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.deepEqual(
    resolved.fallbacks.map((candidate) => candidate.requestModelId),
    ["anthropic/claude-3-5-haiku", "openrouter/gpt-4o"]
  );

  const smartResolved = resolveRequestModel(config, "smart", FORMATS.CLAUDE);
  assert.equal(smartResolved.routeType, "alias");
  assert.equal(smartResolved.primary.requestModelId, "openrouter/gpt-4o-mini");
});

test("resolveRouteReference looks up direct refs and alias refs", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    modelAliases: {
      "chat.default": {
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      }
    }
  }));

  const direct = resolveRouteReference(config, "openrouter/gpt4o-mini");
  const alias = resolveRouteReference(config, "chat.default");

  assert.equal(direct?.provider?.id, "openrouter");
  assert.equal(direct?.model?.id, "gpt-4o-mini");
  assert.equal(alias?.aliasId, "chat.default");
  assert.equal(alias?.alias?.targets?.[0]?.ref, "openrouter/gpt-4o-mini");
});

test("normalizeRuntimeConfig supports ampRouting maps", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    ampRouting: {
      enabled: true,
      fallbackRoute: "openrouter/gpt-4o-mini",
      modeMap: {
        SMART: "openrouter/gpt-4o-mini"
      },
      agentMap: {
        Review: "anthropic/claude-3-5-haiku"
      },
      agentModeMap: {
        Review: {
          Deep: "anthropic/claude-3-5-haiku"
        }
      },
      applicationMap: {
        "CLI Execute Mode": "openrouter/gpt-4o-mini"
      },
      modelMap: {
        "claude-haiku-4-5-20251001": "openrouter/gpt-4o-mini"
      }
    }
  }));

  assert.equal(normalized.version, CONFIG_VERSION);
  assert.equal(normalized.ampRouting.enabled, true);
  assert.equal(normalized.ampRouting.fallbackRoute, "openrouter/gpt-4o-mini");
  assert.equal(normalized.ampRouting.modeMap.smart, "openrouter/gpt-4o-mini");
  assert.equal(normalized.ampRouting.agentMap.review, "anthropic/claude-3-5-haiku");
  assert.equal(normalized.ampRouting.agentModeMap.review.deep, "anthropic/claude-3-5-haiku");
  assert.equal(normalized.ampRouting.applicationMap["cli execute mode"], "openrouter/gpt-4o-mini");
  assert.equal(normalized.ampRouting.modelMap["claude-haiku-4-5-20251001"], "openrouter/gpt-4o-mini");
});

test("validateRuntimeConfig rejects unknown ampRouting refs", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    ampRouting: {
      modeMap: {
        smart: "missing.alias"
      }
    }
  }));

  const errors = validateRuntimeConfig(normalized);
  assert.ok(errors.some((error) => error.includes("ampRouting.modeMap.smart references unknown alias 'missing.alias'")));
});

test("normalizeRuntimeConfig preserves ampRouting enabled=false state", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    ampRouting: {
      enabled: false,
      fallbackRoute: "openrouter/gpt-4o-mini",
      modeMap: {
        SMART: "openrouter/gpt-4o-mini"
      }
    }
  }));

  assert.equal(normalized.ampRouting.enabled, false);
  assert.equal(normalized.ampRouting.fallbackRoute, "openrouter/gpt-4o-mini");
  assert.equal(normalized.ampRouting.modeMap.smart, "openrouter/gpt-4o-mini");
  assert.deepEqual(validateRuntimeConfig(normalized), []);
});
