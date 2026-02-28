import test from "node:test";
import assert from "node:assert/strict";
import {
  applyConfigChanges,
  buildWorkerConfigPayload
} from "./config-workflows.js";

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
