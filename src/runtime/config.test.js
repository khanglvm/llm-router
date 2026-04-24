import test from "node:test";
import assert from "node:assert/strict";
import { FORMATS } from "../translator/index.js";
import {
  CONFIG_VERSION,
  DEFAULT_AMP_ENTITY_DEFINITIONS,
  DEFAULT_AMP_SIGNATURE_DEFINITIONS,
  DEFAULT_AMP_SUBAGENT_DEFINITIONS,
  DEFAULT_MODEL_ALIAS_ID,
  assertSupportedRuntimeConfigVersion,
  listConfiguredModels,
  migrateRuntimeConfig,
  normalizeRuntimeConfig,
  resolveProviderUrl,
  resolveRequestModel,
  resolveRequestedRoute,
  resolveRouteReference,
  validateRuntimeConfig
} from "./config.js";
import {
  CODEX_SUBSCRIPTION_MODELS,
  CLAUDE_CODE_SUBSCRIPTION_MODELS
} from "./subscription-constants.js";

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

test("normalizeRuntimeConfig migrates legacy defaults into the fixed default alias", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig());

  assert.equal(normalized.version, 2);
  assert.equal(normalized.defaultModel, "openrouter/gpt-4o-mini");
  assert.deepEqual(Object.keys(normalized.modelAliases), [DEFAULT_MODEL_ALIAS_ID]);
  assert.deepEqual(normalized.modelAliases[DEFAULT_MODEL_ALIAS_ID].targets.map((target) => target.ref), ["openrouter/gpt-4o-mini"]);
  assert.deepEqual(normalized.providers[0].rateLimits, []);

  const roundTrip = normalizeRuntimeConfig(JSON.parse(JSON.stringify(normalized)));
  assert.equal(roundTrip.version, 2);
  assert.deepEqual(Object.keys(roundTrip.modelAliases), [DEFAULT_MODEL_ALIAS_ID]);
  assert.deepEqual(roundTrip.modelAliases[DEFAULT_MODEL_ALIAS_ID].targets.map((target) => target.ref), ["openrouter/gpt-4o-mini"]);
  assert.deepEqual(roundTrip.providers[0].rateLimits, []);
});

test("resolveProviderUrl appends OpenAI paths directly for versioned provider API roots", () => {
  const zaiProvider = {
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    format: FORMATS.OPENAI
  };
  const geminiOpenAIProvider = {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    format: FORMATS.OPENAI
  };

  assert.equal(
    resolveProviderUrl(zaiProvider, FORMATS.OPENAI, "chat-completions"),
    "https://api.z.ai/api/coding/paas/v4/chat/completions"
  );
  assert.equal(
    resolveProviderUrl(zaiProvider, FORMATS.OPENAI, "responses"),
    "https://api.z.ai/api/coding/paas/v4/responses"
  );
  assert.equal(
    resolveProviderUrl(geminiOpenAIProvider, FORMATS.OPENAI, "chat-completions"),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
  );
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


test("validateRuntimeConfig allows empty aliases including the fixed default alias", () => {
  const normalized = normalizeRuntimeConfig({
    version: CONFIG_VERSION,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [],
        fallbackTargets: []
      },
      coding: {
        id: "coding",
        strategy: "ordered",
        targets: [],
        fallbackTargets: []
      }
    },
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }]
      }
    ]
  });

  assert.deepEqual(validateRuntimeConfig(normalized), []);
});

test("resolveRequestedRoute returns 500 when the fixed default alias is empty", () => {
  const config = normalizeRuntimeConfig({
    version: CONFIG_VERSION,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [],
        fallbackTargets: []
      }
    },
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }]
      }
    ]
  });

  const defaultResolved = resolveRequestedRoute(config, DEFAULT_MODEL_ALIAS_ID, FORMATS.OPENAI);
  assert.equal(defaultResolved.primary, null);
  assert.equal(defaultResolved.statusCode, 500);
  assert.match(defaultResolved.error || "", /no target candidates configured/i);

  const smartResolved = resolveRequestModel(config, "smart", FORMATS.OPENAI);
  assert.equal(smartResolved.primary, null);
  assert.equal(smartResolved.statusCode, 500);
  assert.match(smartResolved.error || "", /no target candidates configured/i);
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

test("normalizeRuntimeConfig accepts quick-start rate-limit aliases", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }],
        rateLimits: [
          {
            id: "default",
            name: "Default",
            models: ["all"],
            limit: 60,
            window: { value: 1, unit: "minute" }
          }
        ]
      }
    ]
  }));

  assert.equal(normalized.providers[0].rateLimits[0].requests, 60);
  assert.deepEqual(normalized.providers[0].rateLimits[0].window, { unit: "minute", size: 1 });
  assert.equal(validateRuntimeConfig(normalized).length, 0);
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

test("normalizeRuntimeConfig preserves explicit model list for subscription providers", () => {
  const normalized = normalizeRuntimeConfig({
    version: CONFIG_VERSION,
    defaultModel: "chatgpt/gpt-5.3-codex",
    providers: [
      {
        id: "chatgpt",
        name: "ChatGPT Subscription",
        type: "subscription",
        subscriptionType: "chatgpt-codex",
        subscriptionProfile: "personal",
        models: [
          { id: "gpt-5.3-codex", variant: "high" },
          { id: "not-allowed", variant: "low" }
        ]
      }
    ]
  });

  assert.equal(normalized.providers[0].format, FORMATS.OPENAI);
  assert.deepEqual(
    normalized.providers[0].models.map((model) => model.id),
    ["gpt-5.3-codex", "not-allowed"]
  );
  assert.equal(normalized.providers[0].models[0].variant, "high");
  assert.equal(validateRuntimeConfig(normalized).length, 0);
});

test("normalizeRuntimeConfig injects predefined Codex models when subscription models are omitted", () => {
  const normalized = normalizeRuntimeConfig({
    version: CONFIG_VERSION,
    defaultModel: "chatgpt/gpt-5.3-codex",
    providers: [
      {
        id: "chatgpt",
        name: "ChatGPT Subscription",
        type: "subscription",
        subscriptionType: "chatgpt-codex",
        subscriptionProfile: "personal"
      }
    ]
  });

  assert.deepEqual(
    normalized.providers[0].models.map((model) => model.id),
    CODEX_SUBSCRIPTION_MODELS
  );
  assert.equal(validateRuntimeConfig(normalized).length, 0);
});

test("normalizeRuntimeConfig injects predefined Claude models when subscription models are omitted", () => {
  const normalized = normalizeRuntimeConfig({
    version: CONFIG_VERSION,
    defaultModel: "claude-sub/claude-sonnet-4-6",
    providers: [
      {
        id: "claude-sub",
        name: "Claude Subscription",
        type: "subscription",
        subscriptionType: "claude-code",
        subscriptionProfile: "work"
      }
    ]
  });

  assert.equal(normalized.providers[0].format, FORMATS.CLAUDE);
  assert.deepEqual(
    normalized.providers[0].models.map((model) => model.id),
    CLAUDE_CODE_SUBSCRIPTION_MODELS
  );
  assert.equal(validateRuntimeConfig(normalized).length, 0);
});

test("validateRuntimeConfig requires subscriptionType for subscription providers", () => {
  const normalized = normalizeRuntimeConfig({
    version: CONFIG_VERSION,
    providers: [
      {
        id: "chatgpt",
        name: "ChatGPT Subscription",
        type: "subscription",
        models: [{ id: "gpt-5.3-codex" }]
      }
    ]
  });

  const errors = validateRuntimeConfig(normalized);
  assert.ok(errors.some((error) => error.includes("missing subscriptionType")));
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

test("resolveRequestModel prefers an explicit smart alias over the fixed default alias", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        strategy: "ordered",
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      },
      smart: {
        strategy: "ordered",
        targets: [{ ref: "anthropic/claude-3-5-haiku" }]
      }
    }
  }));

  const smartResolved = resolveRequestModel(config, "smart", FORMATS.CLAUDE);
  assert.equal(smartResolved.routeType, "alias");
  assert.equal(smartResolved.routeRef, "smart");
  assert.equal(smartResolved.primary.requestModelId, "anthropic/claude-3-5-haiku");

  const defaultResolved = resolveRequestModel(config, DEFAULT_MODEL_ALIAS_ID, FORMATS.CLAUDE);
  assert.equal(defaultResolved.routeRef, DEFAULT_MODEL_ALIAS_ID);
  assert.equal(defaultResolved.primary.requestModelId, "openrouter/gpt-4o-mini");
});

test("resolveRequestModel resolves bare model ids containing brackets (e.g. opus[1m])", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [
          { id: "opus[1m]" },
          { id: "sonnet[500k]", aliases: ["sonnet-half"] }
        ]
      }
    ]
  }));

  const resolved = resolveRequestModel(config, "opus[1m]", FORMATS.OPENAI);
  assert.equal(resolved.routeType, "bare-model");
  assert.equal(resolved.resolvedModel, "opus[1m]");
  assert.equal(resolved.primary.requestModelId, "openrouter/opus[1m]");

  const aliasResolved = resolveRequestModel(config, "sonnet-half", FORMATS.OPENAI);
  assert.equal(aliasResolved.routeType, "bare-model");
  assert.equal(aliasResolved.primary.requestModelId, "openrouter/sonnet[500k]");
});

test("resolveRequestModel resolves alias ids containing brackets (e.g. fast[1m])", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    modelAliases: {
      "fast[1m]": {
        strategy: "ordered",
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      }
    }
  }));

  const resolved = resolveRequestModel(config, "fast[1m]", FORMATS.OPENAI);
  assert.equal(resolved.routeType, "alias");
  assert.equal(resolved.routeRef, "fast[1m]");
  assert.equal(resolved.primary.requestModelId, "openrouter/gpt-4o-mini");
});

test("resolveRequestModel uses probed model formats when saved model formats are stale", () => {
  const config = normalizeRuntimeConfig({
    version: CONFIG_VERSION,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        strategy: "ordered",
        targets: [{ ref: "rc/claude-opus-4.6-CL" }]
      },
      smart: {
        strategy: "ordered",
        targets: [{ ref: "rc/claude-opus-4.6-CL" }]
      }
    },
    providers: [
      {
        id: "rc",
        name: "RamClouds",
        baseUrlByFormat: {
          openai: "https://ramclouds.me/v1",
          claude: "https://ramclouds.me/anthropic"
        },
        format: "claude",
        formats: ["claude", "openai"],
        models: [
          {
            id: "claude-opus-4.6-CL",
            formats: ["claude"]
          }
        ],
        lastProbe: {
          ok: true,
          formats: ["claude", "openai"],
          workingFormats: ["claude", "openai"],
          models: ["claude-opus-4.6-CL"],
          modelSupport: {
            "claude-opus-4.6-CL": ["openai"]
          },
          modelPreferredFormat: {
            "claude-opus-4.6-CL": "openai"
          }
        }
      }
    ]
  });

  const resolved = resolveRequestModel(config, "smart", FORMATS.CLAUDE);

  assert.equal(resolved.routeType, "alias");
  assert.equal(resolved.primary.requestModelId, "rc/claude-opus-4.6-CL");
  assert.equal(resolved.primary.targetFormat, FORMATS.OPENAI);
});

test("listConfiguredModels reports probed endpoint support when saved model formats are stale", () => {
  const config = normalizeRuntimeConfig({
    version: CONFIG_VERSION,
    providers: [
      {
        id: "rc",
        name: "RamClouds",
        baseUrlByFormat: {
          openai: "https://ramclouds.me/v1",
          claude: "https://ramclouds.me/anthropic"
        },
        format: "claude",
        formats: ["claude", "openai"],
        models: [
          {
            id: "claude-opus-4.6-CL",
            formats: ["claude"]
          }
        ],
        lastProbe: {
          ok: true,
          formats: ["claude", "openai"],
          workingFormats: ["claude", "openai"],
          models: ["claude-opus-4.6-CL"],
          modelSupport: {
            "claude-opus-4.6-CL": ["openai"]
          },
          modelPreferredFormat: {
            "claude-opus-4.6-CL": "openai"
          }
        }
      }
    ]
  });

  const [openaiRow] = listConfiguredModels(config, { endpointFormat: FORMATS.OPENAI });
  const [claudeRow] = listConfiguredModels(config, { endpointFormat: FORMATS.CLAUDE });

  assert.deepEqual(openaiRow.formats, [FORMATS.OPENAI]);
  assert.equal(openaiRow.endpoint_format_supported, true);
  assert.deepEqual(claudeRow.formats, [FORMATS.OPENAI]);
  assert.equal(claudeRow.endpoint_format_supported, false);
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

test("normalizeRuntimeConfig preserves AMP settings and aliases", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    ampcode: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_secret_123456",
      restrictManagementToLocalhost: true,
      proxyWebSearchToUpstream: true,
      modelMappings: [
        { from: "claude-opus-4.5", to: "anthropic/claude-3-5-haiku" }
      ]
    }
  }));

  assert.equal(normalized.amp.upstreamUrl, "https://ampcode.com/");
  assert.equal(normalized.amp.upstreamApiKey, "amp_secret_123456");
  assert.equal(normalized.amp.restrictManagementToLocalhost, true);
  assert.equal(normalized.amp.proxyWebSearchToUpstream, true);
  assert.deepEqual(normalized.amp.modelMappings, [
    { from: "claude-opus-4.5", to: "anthropic/claude-3-5-haiku" }
  ]);

  const sanitized = validateRuntimeConfig(normalized);
  assert.deepEqual(sanitized, []);
  const display = normalizeRuntimeConfig(normalized);
  assert.equal(display.amp.upstreamApiKey, "amp_secret_123456");
});

test("normalizeRuntimeConfig preserves new AMP schema fields", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    amp: {
      preset: "builtin",
      defaultRoute: "openrouter/gpt-4o-mini",
      routes: {
        Smart: "anthropic/claude-3-5-haiku",
        "@Google Gemini Flash Shared": "openrouter/gpt-4o-mini"
      },
      rawModelRoutes: [
        { from: "gpt-*-codex*", to: "anthropic/claude-3-5-haiku" }
      ],
      overrides: {
        entities: [
          {
            id: "Reviewer",
            type: "feature",
            match: ["Gemini 4 Pro"],
            route: "anthropic/claude-3-5-haiku"
          }
        ],
        signatures: [
          {
            id: "@Custom Signature",
            match: ["opus*"]
          }
        ]
      },
      fallback: {
        onUnknown: "default-route",
        onAmbiguous: "none",
        proxyUpstream: false
      }
    }
  }));

  assert.equal(normalized.amp.preset, "builtin");
  assert.equal(normalized.amp.defaultRoute, "openrouter/gpt-4o-mini");
  assert.deepEqual(normalized.amp.routes, {
    smart: "anthropic/claude-3-5-haiku",
    "@google-gemini-flash-shared": "openrouter/gpt-4o-mini"
  });
  assert.deepEqual(normalized.amp.rawModelRoutes, [
    { from: "gpt-*-codex*", to: "anthropic/claude-3-5-haiku" }
  ]);
  assert.deepEqual(normalized.amp.overrides, {
    entities: [
      {
        id: "reviewer",
        type: "feature",
        match: ["Gemini 4 Pro"],
        route: "anthropic/claude-3-5-haiku"
      }
    ],
    signatures: [
      {
        id: "@custom-signature",
        match: ["opus*"]
      }
    ]
  });
  assert.deepEqual(normalized.amp.fallback, {
    onUnknown: "default-route",
    onAmbiguous: "none",
    proxyUpstream: false
  });
});

test("normalizeRuntimeConfig preserves anchored AMP raw model routes without explicit targets", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    amp: {
      defaultRoute: "openrouter/gpt-4o-mini",
      rawModelRoutes: [
        { from: "gpt-*-codex*", sourceRouteKey: "Smart" }
      ]
    }
  }));

  assert.deepEqual(normalized.amp.rawModelRoutes, [
    { from: "gpt-*-codex*", sourceRouteKey: "smart" }
  ]);
});

test("normalizeRuntimeConfig normalizes shared web search providers and strategy", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    webSearch: {
      strategy: "quota-aware-weighted-rr",
      count: 30,
      providers: {
        tavily: {
          apiKey: "tavily_test_key",
          limit: 1000,
          remaining: 875
        },
        brave: {
          apiKey: "brave_test_key"
        }
      }
    }
  }));

  const expected = {
    strategy: "quota-balance",
    count: 20,
    providers: [
      {
        id: "tavily",
        apiKey: "tavily_test_key",
        count: 20,
        limit: 1000,
        remaining: 875
      },
      {
        id: "brave",
        apiKey: "brave_test_key",
        count: 20,
        limit: 1000,
        remaining: 1000
      }
    ],
    interceptInternalSearch: false
  };

  assert.deepEqual(normalized.webSearch, expected);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.amp || {}, "webSearch"), false);
});

test("normalizeRuntimeConfig preserves hosted GPT web search routes", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    providers: [
      {
        id: "rc",
        name: "RamClouds",
        baseUrl: "https://ramclouds.me",
        format: "openai",
        formats: ["openai"],
        models: [{ id: "gpt-5.4", formats: ["openai"] }]
      }
    ],
    webSearch: {
      strategy: "ordered",
      count: 5,
      providers: [
        {
          id: "rc/gpt-5.4",
          providerId: "rc",
          model: "gpt-5.4"
        }
      ]
    }
  }));

  assert.deepEqual(normalized.webSearch, {
    strategy: "ordered",
    count: 5,
    providers: [
      {
        id: "rc/gpt-5.4",
        providerId: "rc",
        model: "gpt-5.4"
      }
    ],
    interceptInternalSearch: false
  });
});

test("normalizeRuntimeConfig preserves Claude Code web search provider selection", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    webSearch: {
      providers: [
        {
          id: "openrouter/gpt-4o-mini",
          providerId: "openrouter",
          model: "gpt-4o-mini"
        },
        {
          id: "brave",
          apiKey: "brave_test_key"
        }
      ]
    },
    claudeCode: {
      webSearchProvider: "openrouter/gpt-4o-mini"
    }
  }));

  assert.deepEqual(normalized.claudeCode, {
    webSearchProvider: "openrouter/gpt-4o-mini"
  });
});

test("validateRuntimeConfig requires Claude Code web search provider selection to reference a configured webSearch provider", () => {
  const valid = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    webSearch: {
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key"
        }
      ]
    },
    claudeCode: {
      webSearchProvider: "brave"
    }
  }));
  assert.deepEqual(validateRuntimeConfig(valid), []);

  const invalid = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    webSearch: {
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key"
        }
      ]
    },
    claudeCode: {
      webSearchProvider: "openrouter/gpt-4o-mini"
    }
  }));
  assert.deepEqual(validateRuntimeConfig(invalid), [
    "claudeCode.webSearchProvider 'openrouter/gpt-4o-mini' must reference a configured webSearch provider."
  ]);
});

test("normalizeRuntimeConfig lets top-level webSearch override legacy amp.webSearch", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    webSearch: {
      strategy: "ordered",
      count: 4,
      providers: [
        {
          id: "brave",
          apiKey: "brave_root_key",
          limit: 1000,
          remaining: 700
        }
      ]
    },
    amp: {
      webSearch: {
        strategy: "quota-balance",
        count: 9,
        providers: [
          {
            id: "tavily",
            apiKey: "tavily_legacy_key",
            limit: 1000,
            remaining: 100
          }
        ]
      }
    }
  }));

  assert.deepEqual(normalized.webSearch, {
    strategy: "ordered",
    count: 4,
    providers: [
      {
        id: "brave",
        apiKey: "brave_root_key",
        count: 4,
        limit: 1000,
        remaining: 700
      }
    ],
    interceptInternalSearch: false
  });
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.amp || {}, "webSearch"), false);
});

test("validateRuntimeConfig rejects invalid per-provider web search counts", () => {
  const config = createBaseRawConfig({
    version: CONFIG_VERSION,
    amp: {},
    webSearch: {
      strategy: "ordered",
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key",
          count: 21
        }
      ]
    }
  });

  const errors = validateRuntimeConfig(config);
  assert.deepEqual(errors, [
    "webSearch provider 'brave' has invalid count '21'."
  ]);
});

test("validateRuntimeConfig rejects web search remaining values above the configured limit", () => {
  const config = createBaseRawConfig({
    version: CONFIG_VERSION,
    amp: {},
    webSearch: {
      strategy: "ordered",
      count: 5,
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key",
          limit: 100,
          remaining: 101
        }
      ]
    }
  });

  const errors = validateRuntimeConfig(config);
  assert.deepEqual(errors, [
    "webSearch provider 'brave' remaining cannot exceed limit."
  ]);
});

test("validateRuntimeConfig rejects hosted GPT web search routes that are not OpenAI-compatible", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "anthropic/gpt-5.4" }],
        fallbackTargets: []
      }
    },
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        formats: ["claude"],
        models: [{ id: "gpt-5.4", formats: ["claude"] }]
      }
    ],
    webSearch: {
      strategy: "ordered",
      count: 5,
      providers: [
        {
          id: "anthropic/gpt-5.4",
          providerId: "anthropic",
          model: "gpt-5.4"
        }
      ]
    }
  }));

  const errors = validateRuntimeConfig(config);
  assert.deepEqual(errors, [
    "webSearch provider 'anthropic/gpt-5.4' must reference an OpenAI-compatible provider/model route."
  ]);
});

test("DEFAULT_AMP_ENTITY_DEFINITIONS and DEFAULT_AMP_SIGNATURE_DEFINITIONS preserve builtin AMP catalog", () => {
  assert.ok(DEFAULT_AMP_ENTITY_DEFINITIONS.some((entry) => entry.id === "smart"));
  assert.ok(DEFAULT_AMP_ENTITY_DEFINITIONS.some((entry) => entry.id === "title"));
  assert.ok(DEFAULT_AMP_SIGNATURE_DEFINITIONS.some((entry) => entry.id === "@anthropic-haiku-shared"));
  assert.ok(DEFAULT_AMP_SIGNATURE_DEFINITIONS.some((entry) => entry.id === "@google-gemini-flash-shared"));
});

test("resolveRequestModel applies new AMP entity routes using canonicalized model names", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    amp: {
      routes: {
        smart: "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const resolved = resolveRequestModel(config, "Claude Opus 4.6", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });

  assert.equal(resolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(resolved.routeType, "amp-entity");
  assert.deepEqual(resolved.routeMetadata?.amp?.entities, ["smart"]);
  assert.deepEqual(resolved.routeMetadata?.amp?.signatures, ["@anthropic-opus"]);
});

test("resolveRequestModel applies new AMP shared signature routes when multiple entities share one model family", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    amp: {
      routes: {
        "@anthropic-haiku-shared": "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const resolved = resolveRequestModel(config, "Claude Haiku 4.5", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });

  assert.equal(resolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(resolved.routeType, "amp-signature");
  assert.deepEqual(resolved.routeMetadata?.amp?.entities, ["rush", "title"]);
  assert.deepEqual(resolved.routeMetadata?.amp?.signatures, ["@anthropic-haiku-shared"]);
});


test("resolveRequestModel matches future AMP base-family versions without suffixed variants", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      routes: {
        oracle: "anthropic/claude-3-5-haiku",
        smart: "anthropic/claude-3-5-haiku",
        librarian: "anthropic/claude-3-5-haiku",
        "@anthropic-haiku-shared": "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const oracleResolved = resolveRequestModel(config, "gpt-6", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });
  assert.equal(oracleResolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(oracleResolved.routeType, "amp-entity");
  assert.deepEqual(oracleResolved.routeMetadata?.amp?.entities, ["oracle"]);

  const smartResolved = resolveRequestModel(config, "claude-opus-5", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });
  assert.equal(smartResolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(smartResolved.routeType, "amp-entity");
  assert.deepEqual(smartResolved.routeMetadata?.amp?.entities, ["smart"]);

  const librarianResolved = resolveRequestModel(config, "claude-sonnet-5", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });
  assert.equal(librarianResolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(librarianResolved.routeType, "amp-entity");
  assert.deepEqual(librarianResolved.routeMetadata?.amp?.entities, ["librarian"]);

  const haikuResolved = resolveRequestModel(config, "claude-haiku-5", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });
  assert.equal(haikuResolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(haikuResolved.routeType, "amp-signature");
  assert.deepEqual(haikuResolved.routeMetadata?.amp?.signatures, ["@anthropic-haiku-shared"]);
});

test("resolveRequestModel excludes suffixed AMP base-family variants from built-in family matches", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      routes: {
        oracle: "anthropic/claude-3-5-haiku",
        smart: "anthropic/claude-3-5-haiku",
        librarian: "anthropic/claude-3-5-haiku",
        "@anthropic-haiku-shared": "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const oracleResolved = resolveRequestModel(config, "gpt-6-codex", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });
  assert.equal(oracleResolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.equal(oracleResolved.routeType, "amp-default-model");

  const smartResolved = resolveRequestModel(config, "claude-opus-5-thinking", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });
  assert.equal(smartResolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.equal(smartResolved.routeType, "amp-default-model");

  const librarianResolved = resolveRequestModel(config, "claude-sonnet-5-thinking", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });
  assert.equal(librarianResolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.equal(librarianResolved.routeType, "amp-default-model");

  const haikuResolved = resolveRequestModel(config, "claude-haiku-5-fast", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });
  assert.equal(haikuResolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.equal(haikuResolved.routeType, "amp-default-model");
});

test("resolveRequestModel prefers amp.defaultRoute over global defaultModel for new AMP schema", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "anthropic/claude-3-5-haiku",
    amp: {
      defaultRoute: "openrouter/gpt-4o-mini",
      routes: {}
    }
  }));

  const resolved = resolveRequestModel(config, "unknown-amp-model", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });

  assert.equal(resolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.equal(resolved.routeType, "amp-default-route");
});

test("resolveRequestModel uses anchored AMP raw model routes with the AMP default route", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "anthropic/claude-3-5-haiku",
    amp: {
      defaultRoute: "openrouter/gpt-4o-mini",
      rawModelRoutes: [
        { from: "gpt-*-codex*", sourceRouteKey: "smart" }
      ]
    }
  }));

  const resolved = resolveRequestModel(config, "gpt-5.3-codex", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });

  assert.equal(resolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.equal(resolved.routeType, "amp-raw-model-route");
});

test("validateRuntimeConfig rejects invalid refs in new AMP schema routes", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    amp: {
      routes: {
        smart: "missing.alias"
      }
    }
  }));

  const errors = validateRuntimeConfig(normalized);
  assert.ok(errors.some((entry) => entry.includes("AMP route 'smart' references unknown alias 'missing.alias'")));
});

test("resolveRequestModel resolves AMP bare models and explicit mappings", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    amp: {
      modelMappings: [
        { from: "claude-opus-*", to: "anthropic/claude-3-5-haiku" }
      ]
    }
  }));

  const bareResolved = resolveRequestModel(config, "gpt-4o-mini", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });
  assert.equal(bareResolved.routeType, "amp-bare-model");
  assert.equal(bareResolved.primary.requestModelId, "openrouter/gpt-4o-mini");

  const mappedResolved = resolveRequestModel(config, "claude-opus-4.5", FORMATS.CLAUDE, {
    clientType: "amp",
    providerHint: "anthropic"
  });
  assert.equal(mappedResolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(mappedResolved.routeMetadata?.amp?.mappedFrom, "claude-opus-4.5");
});

test("resolveRequestModel honors AMP forceModelMappings before local bare-model lookup", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    amp: {
      forceModelMappings: true,
      modelMappings: [
        { from: "gpt-4o-mini", to: "anthropic/claude-3-5-haiku" }
      ]
    }
  }));

  const resolved = resolveRequestModel(config, "gpt-4o-mini", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });

  assert.equal(resolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(resolved.routeMetadata?.amp?.mappedFrom, "gpt-4o-mini");
});

test("resolveRequestModel applies AMP subagent mappings before generic model mappings", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      subagentMappings: {
        oracle: "anthropic/claude-3-5-haiku"
      },
      modelMappings: [
        { from: "gpt-*", to: "openrouter/gpt-4o-mini" }
      ]
    }
  }));

  const resolved = resolveRequestModel(config, "gpt-5.4", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });

  assert.equal(resolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(resolved.routeType, "amp-subagent");
  assert.deepEqual(resolved.routeMetadata?.amp?.subagents, ["oracle"]);
});


test("resolveRequestModel applies AMP subagent mappings to future bare model families only", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      subagentMappings: {
        oracle: "anthropic/claude-3-5-haiku",
        librarian: "anthropic/claude-3-5-haiku",
        title: "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const oracleResolved = resolveRequestModel(config, "gpt-5.5", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });
  assert.equal(oracleResolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(oracleResolved.routeType, "amp-subagent");
  assert.deepEqual(oracleResolved.routeMetadata?.amp?.subagents, ["oracle"]);

  const librarianResolved = resolveRequestModel(config, "claude-sonnet-5", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });
  assert.equal(librarianResolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(librarianResolved.routeType, "amp-subagent");
  assert.deepEqual(librarianResolved.routeMetadata?.amp?.subagents, ["librarian"]);

  const titleResolved = resolveRequestModel(config, "claude-haiku-5", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });
  assert.equal(titleResolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(titleResolved.routeType, "amp-subagent");
  assert.deepEqual(titleResolved.routeMetadata?.amp?.subagents, ["title"]);

  const excludedResolved = resolveRequestModel(config, "gpt-5.5-codex", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });
  assert.equal(excludedResolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.equal(excludedResolved.routeType, "amp-default-model");
});

test("resolveRequestModel applies AMP subagent mappings for current shared Gemini 2.5 Flash agents", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      subagentMappings: {
        search: "anthropic/claude-3-5-haiku",
        "look at": "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const resolved = resolveRequestModel(config, "gemini-2.5-flash", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "google"
  });

  assert.equal(resolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(resolved.routeType, "amp-subagent");
  assert.deepEqual(resolved.routeMetadata?.amp?.subagents, ["search", "look-at"]);
});

test("resolveRequestModel falls back unknown AMP subagent models to defaultModel", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {}
  }));

  const resolved = resolveRequestModel(config, "gpt-5.4", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });

  assert.equal(resolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.equal(resolved.routeType, "amp-default-model");
  assert.equal(resolved.routeMetadata?.amp?.mappedFrom, "gpt-5.4");
});

test("resolveRequestModel falls back when shared AMP subagent model mappings are partial", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      subagentMappings: {
        search: "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const resolved = resolveRequestModel(config, "gemini-2.5-flash", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "google"
  });

  assert.equal(resolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.equal(resolved.routeType, "amp-default-model");
});

test("DEFAULT_AMP_SUBAGENT_DEFINITIONS preserve current AMP profiles and compatibility aliases", () => {
  assert.deepEqual(DEFAULT_AMP_SUBAGENT_DEFINITIONS, [
    { id: "oracle", patterns: ["/^gpt-\\d+(?:\\.\\d+)?$/"] },
    { id: "librarian", patterns: ["/^(?:claude-)?sonnet-\\d+(?:\\.\\d+)?$/"] },
    { id: "title", patterns: ["/^(?:claude-)?haiku-\\d+(?:\\.\\d+)?$/"] },
    { id: "painter", patterns: ["gemini-3-pro-image", "gemini-3-pro-image*"] },
    { id: "search", patterns: ["gemini-2.5-flash", "gemini-2.5-flash*", "gemini-3-flash", "gemini-3-flash*"] },
    { id: "look-at", patterns: ["gemini-2.5-flash", "gemini-2.5-flash*", "gemini-3-flash", "gemini-3-flash*"] },
    { id: "handoff", patterns: ["gemini-3-flash", "gemini-3-flash*"] }
  ]);
});

test("resolveRequestModel applies AMP subagent mappings for current shared Gemini 3 Flash agents", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      subagentMappings: {
        search: "anthropic/claude-3-5-haiku",
        "look-at": "anthropic/claude-3-5-haiku",
        handoff: "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const resolved = resolveRequestModel(config, "gemini-3-flash", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "google"
  });

  assert.equal(resolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(resolved.routeType, "amp-subagent");
  assert.deepEqual(resolved.routeMetadata?.amp?.subagents, ["search", "look-at", "handoff"]);
});

test("resolveRequestModel accepts AMP titling subagent mappings via current documented name", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      subagentMappings: {
        titling: "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const resolved = resolveRequestModel(config, "claude-haiku-4.5", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });

  assert.equal(resolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(resolved.routeType, "amp-subagent");
  assert.deepEqual(resolved.routeMetadata?.amp?.subagents, ["title"]);
});

test("resolveRequestModel accepts AMP title subagent mappings via documented name", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      subagentMappings: {
        title: "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const resolved = resolveRequestModel(config, "claude-haiku-4.5", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "anthropic"
  });

  assert.equal(resolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(resolved.routeType, "amp-subagent");
  assert.deepEqual(resolved.routeMetadata?.amp?.subagents, ["title"]);
});


test("normalizeRuntimeConfig preserves custom AMP subagent definitions", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    amp: {
      subagentDefinitions: [
        { id: "planner", patterns: ["gpt-5.4", "gpt-5.4*"] },
        { id: "planner", patterns: ["ignored*"] },
        { id: "look_at", patterns: ["gemini-2.5-flash"] }
      ]
    }
  }));

  assert.deepEqual(normalized.amp.subagentDefinitions, [
    { id: "planner", patterns: ["gpt-5.4", "gpt-5.4*"] },
    { id: "look-at", patterns: ["gemini-2.5-flash"] }
  ]);
});

test("normalizeRuntimeConfig canonicalizes AMP documented built-in aliases", () => {
  const normalized = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    amp: {
      subagentDefinitions: [
        { id: "Title", patterns: ["claude-haiku-4.5"] },
        { id: "Look At", patterns: ["gemini-2.5-flash"] }
      ],
      subagentMappings: {
        titling: "anthropic/claude-3-5-haiku",
        "look at": "openrouter/gpt-4o-mini"
      }
    }
  }));

  assert.deepEqual(normalized.amp.subagentDefinitions, [
    { id: "title", patterns: ["claude-haiku-4.5"] },
    { id: "look-at", patterns: ["gemini-2.5-flash"] }
  ]);
  assert.deepEqual(normalized.amp.subagentMappings, {
    title: "anthropic/claude-3-5-haiku",
    "look-at": "openrouter/gpt-4o-mini"
  });
});

test("resolveRequestModel uses custom AMP subagent definitions and names", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      subagentDefinitions: [
        { id: "planner", patterns: ["gpt-5.4", "gpt-5.4*"] }
      ],
      subagentMappings: {
        planner: "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const resolved = resolveRequestModel(config, "gpt-5.4", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });

  assert.equal(resolved.primary.requestModelId, "anthropic/claude-3-5-haiku");
  assert.equal(resolved.routeType, "amp-subagent");
  assert.deepEqual(resolved.routeMetadata?.amp?.subagents, ["planner"]);
});

test("resolveRequestModel falls back when custom AMP subagent definitions do not match", () => {
  const config = normalizeRuntimeConfig(createBaseRawConfig({
    version: CONFIG_VERSION,
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      subagentDefinitions: [
        { id: "planner", patterns: ["gpt-6*"] }
      ],
      subagentMappings: {
        planner: "anthropic/claude-3-5-haiku"
      }
    }
  }));

  const resolved = resolveRequestModel(config, "gpt-5.4", FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "openai"
  });

  assert.equal(resolved.primary.requestModelId, "openrouter/gpt-4o-mini");
  assert.equal(resolved.routeType, "amp-default-model");
});
