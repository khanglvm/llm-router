import test from "node:test";
import assert from "node:assert/strict";
import {
  applyConfigChanges,
  buildProviderFromConfigInput,
  buildWorkerConfigPayload
} from "./config-workflows.js";
import {
  CODEX_SUBSCRIPTION_MODELS,
  CLAUDE_CODE_SUBSCRIPTION_MODELS
} from "../runtime/subscription-constants.js";

function baseConfig() {
  return {
    version: 2,
    masterKey: "gw_test_master_key",
    defaultModel: "chat.default",
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
        ],
        rateLimits: [
          {
            id: "openrouter-all-month",
            models: ["all"],
            requests: 20000,
            window: { unit: "month", size: 1 }
          }
        ]
      }
    ],
    modelAliases: {
      "chat.default": {
        strategy: "quota-aware-weighted-rr",
        targets: [
          { ref: "openrouter/gpt-4o-mini", weight: 3 }
        ],
        fallbackTargets: [
          { ref: "openrouter/gpt-4o" }
        ]
      }
    }
  };
}

test("applyConfigChanges preserves provider rate-limit buckets when provider is updated", () => {
  const existing = baseConfig();
  const updatedProvider = {
    id: "openrouter",
    name: "OpenRouter Updated",
    baseUrl: "https://openrouter.ai/api/v1",
    format: "openai",
    formats: ["openai"],
    apiKey: "sk-or-updated",
    models: [
      { id: "gpt-4o-mini" }
    ]
  };

  const next = applyConfigChanges(existing, {
    provider: updatedProvider,
    setDefaultModel: false
  });
  const provider = next.providers.find((entry) => entry.id === "openrouter");
  assert.equal(provider.name, "OpenRouter Updated");
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

test("applyConfigChanges preserves modelAliases on unrelated provider edits", () => {
  const existing = baseConfig();
  existing.providers.push({
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    format: "claude",
    formats: ["claude"],
    apiKey: "sk-ant-test",
    models: [{ id: "claude-3-5-haiku" }]
  });

  const next = applyConfigChanges(existing, {
    provider: {
      id: "anthropic",
      name: "Anthropic Updated",
      baseUrl: "https://api.anthropic.com",
      format: "claude",
      formats: ["claude"],
      apiKey: "sk-ant-new",
      models: [{ id: "claude-3-5-haiku" }]
    },
    setDefaultModel: false
  });

  assert.equal(next.providers.find((entry) => entry.id === "anthropic").name, "Anthropic Updated");
  assert.deepEqual(next.modelAliases["chat.default"].targets.map((target) => target.ref), [
    "openrouter/gpt-4o-mini"
  ]);
});

test("buildWorkerConfigPayload accepts v2 config with aliases and rate limits", () => {
  const payload = buildWorkerConfigPayload(baseConfig(), {
    masterKey: "gw_override_master_key"
  });

  assert.equal(payload.version, 2);
  assert.equal(payload.masterKey, "gw_override_master_key");
  assert.equal(payload.modelAliases["chat.default"].strategy, "quota-aware-weighted-rr");
  assert.equal(payload.providers[0].rateLimits[0].id, "openrouter-all-month");
});

test("buildProviderFromConfigInput keeps subscription provider fields and predefined models", () => {
  const provider = buildProviderFromConfigInput({
    providerId: "chatgpt",
    name: "ChatGPT Subscription",
    type: "subscription",
    subscriptionType: "chatgpt-codex",
    subscriptionProfile: "personal"
  });

  assert.equal(provider.type, "subscription");
  assert.equal(provider.subscriptionType, "chatgpt-codex");
  assert.equal(provider.subscriptionProfile, "personal");
  assert.equal(provider.format, "openai");
  assert.deepEqual(provider.models.map((model) => model.id), CODEX_SUBSCRIPTION_MODELS);
});

test("buildProviderFromConfigInput applies Claude subscription defaults", () => {
  const provider = buildProviderFromConfigInput({
    providerId: "claude-sub",
    name: "Claude Subscription",
    type: "subscription",
    subscriptionType: "claude-code",
    subscriptionProfile: "work"
  });

  assert.equal(provider.type, "subscription");
  assert.equal(provider.subscriptionType, "claude-code");
  assert.equal(provider.subscriptionProfile, "work");
  assert.equal(provider.format, "claude");
  assert.deepEqual(provider.models.map((model) => model.id), CLAUDE_CODE_SUBSCRIPTION_MODELS);
});

test("buildProviderFromConfigInput applies model context windows when provided", () => {
  const provider = buildProviderFromConfigInput({
    providerId: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    format: "openai",
    models: "gpt-4o-mini,gpt-4o",
    modelContextWindows: {
      "gpt-4o-mini": 128000,
      "gpt-4o": "256000"
    }
  });

  assert.deepEqual(provider.models.map((model) => ({
    id: model.id,
    contextWindow: model.contextWindow
  })), [
    { id: "gpt-4o-mini", contextWindow: 128000 },
    { id: "gpt-4o", contextWindow: 256000 }
  ]);
});

test("applyConfigChanges preserves existing context windows when upsert omits them", () => {
  const existing = baseConfig();
  existing.providers[0].models = [
    { id: "gpt-4o-mini", contextWindow: 128000 },
    { id: "gpt-4o", contextWindow: 256000 }
  ];

  const next = applyConfigChanges(existing, {
    provider: {
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
    setDefaultModel: false
  });

  assert.deepEqual(next.providers[0].models.map((model) => ({
    id: model.id,
    contextWindow: model.contextWindow
  })), [
    { id: "gpt-4o-mini", contextWindow: 128000 },
    { id: "gpt-4o", contextWindow: 256000 }
  ]);
});
