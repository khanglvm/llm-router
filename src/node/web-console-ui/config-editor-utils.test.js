import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_ALIAS_ID } from "../../runtime/config.js";
import {
  applyModelAliasEdits,
  applyProviderInlineEdits,
  applyProviderModelEdits,
  removeModelAlias
} from "./config-editor-utils.js";

function createBaseConfig(overrides = {}) {
  return {
    version: 2,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    amp: {
      defaultRoute: DEFAULT_MODEL_ALIAS_ID
    },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: [{ ref: "openai/gpt-4o" }]
      }
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        format: "openai",
        models: [
          {
            id: "gpt-4o-mini",
            fallbackModels: ["openai/gpt-4o", "anthropic/claude-3-5-haiku"]
          },
          {
            id: "gpt-4o"
          }
        ],
        rateLimits: [
          {
            id: "default",
            models: ["gpt-4o-mini"],
            requests: 60,
            window: { unit: "minute", size: 1 }
          }
        ]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        format: "claude",
        models: [
          {
            id: "claude-3-5-haiku"
          }
        ]
      }
    ],
    ...overrides
  };
}

test("applyProviderModelEdits rewrites provider refs while preserving fixed default route", () => {
  const config = createBaseConfig();

  const next = applyProviderModelEdits(config, "openai", [
    { sourceId: "gpt-4o", id: "gpt-4o" },
    { sourceId: "gpt-4o-mini", id: "gpt-4.1-mini" }
  ]);

  assert.deepEqual(
    next.providers[0].models.map((model) => model.id),
    ["gpt-4o", "gpt-4.1-mini"]
  );
  assert.equal(next.defaultModel, DEFAULT_MODEL_ALIAS_ID);
  assert.equal(next.amp.defaultRoute, DEFAULT_MODEL_ALIAS_ID);
  assert.deepEqual(
    next.modelAliases[DEFAULT_MODEL_ALIAS_ID].targets.map((target) => target.ref),
    ["openai/gpt-4.1-mini"]
  );
  assert.deepEqual(next.providers[0].rateLimits[0].models, ["gpt-4.1-mini"]);
});

test("applyProviderModelEdits preserves empty aliases when their targets disappear", () => {
  const config = createBaseConfig({
    providers: [
      {
        id: "openai",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }]
      }
    ],
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: []
      }
    }
  });

  const next = applyProviderModelEdits(config, "openai", [
    { sourceId: "gpt-4o", id: "gpt-4o" }
  ]);

  assert.deepEqual(next.modelAliases[DEFAULT_MODEL_ALIAS_ID], {
    id: DEFAULT_MODEL_ALIAS_ID,
    strategy: "ordered",
    targets: [],
    fallbackTargets: []
  });
  assert.equal(next.defaultModel, DEFAULT_MODEL_ALIAS_ID);
  assert.equal(next.amp.defaultRoute, DEFAULT_MODEL_ALIAS_ID);
});

test("applyModelAliasEdits renames non-default aliases and preserves target metadata", () => {
  const config = createBaseConfig({
    amp: { defaultRoute: "alias:coding" },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: []
      },
      coding: {
        id: "coding",
        strategy: "weighted-rr",
        targets: [{ ref: "openai/gpt-4o-mini", weight: 3 }],
        fallbackTargets: [{ ref: "anthropic/claude-3-5-haiku", weight: 1 }],
        metadata: { owner: "router" }
      },
      chained: {
        id: "chained",
        strategy: "ordered",
        targets: [{ ref: "coding" }],
        fallbackTargets: []
      }
    }
  });

  const next = applyModelAliasEdits(config, "coding", {
    id: "coding.primary",
    strategy: "weighted-rr",
    targets: [{ sourceRef: "openai/gpt-4o-mini", ref: "openai/gpt-4o-mini" }],
    fallbackTargets: [{ sourceRef: "anthropic/claude-3-5-haiku", ref: "anthropic/claude-3-5-haiku" }]
  });

  assert.equal(next.modelAliases.coding, undefined);
  assert.equal(next.modelAliases["coding.primary"].metadata.owner, "router");
  assert.equal(next.modelAliases["coding.primary"].targets[0].weight, 3);
  assert.equal(next.modelAliases["coding.primary"].fallbackTargets[0].weight, 1);
  assert.equal(next.modelAliases.chained.targets[0].ref, "coding.primary");
  assert.equal(next.defaultModel, DEFAULT_MODEL_ALIAS_ID);
  assert.equal(next.amp.defaultRoute, "alias:coding.primary");
});

test("removeModelAlias clears dependent refs and preserves empty aliases", () => {
  const config = createBaseConfig({
    amp: { defaultRoute: "alias:coding" },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: []
      },
      coding: {
        id: "coding",
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: []
      },
      chained: {
        id: "chained",
        strategy: "ordered",
        targets: [{ ref: "coding" }],
        fallbackTargets: []
      }
    }
  });

  const next = removeModelAlias(config, "coding");

  assert.equal(next.modelAliases.coding, undefined);
  assert.deepEqual(next.modelAliases.chained.targets, []);
  assert.deepEqual(next.modelAliases.chained.fallbackTargets, []);
  assert.equal(next.defaultModel, DEFAULT_MODEL_ALIAS_ID);
  assert.equal(next.amp.defaultRoute, DEFAULT_MODEL_ALIAS_ID);
});

test("removeModelAlias clears the fixed default alias instead of deleting it", () => {
  const config = createBaseConfig();

  const next = removeModelAlias(config, DEFAULT_MODEL_ALIAS_ID);

  assert.deepEqual(next.modelAliases[DEFAULT_MODEL_ALIAS_ID], {
    id: DEFAULT_MODEL_ALIAS_ID,
    strategy: "ordered",
    targets: [],
    fallbackTargets: []
  });
  assert.equal(next.defaultModel, DEFAULT_MODEL_ALIAS_ID);
  assert.equal(next.amp.defaultRoute, DEFAULT_MODEL_ALIAS_ID);
});


test("applyProviderInlineEdits renames provider refs and updates api endpoint fields", () => {
  const config = createBaseConfig({
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        baseUrlByFormat: {
          openai: "https://api.openai.com/v1",
          claude: "https://api.openai.com/v1"
        },
        metadata: {
          endpointCandidates: ["https://api.openai.com/v1", "https://api.openai.com/v2"]
        },
        format: "openai",
        models: [
          {
            id: "gpt-4o-mini",
            fallbackModels: ["openai/gpt-4o", "anthropic/claude-3-5-haiku"]
          },
          {
            id: "gpt-4o",
            fallbackModels: ["openai/gpt-4o-mini"]
          }
        ]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        format: "claude",
        models: [
          {
            id: "claude-3-5-haiku",
            fallbackModels: ["openai/gpt-4o-mini"]
          }
        ]
      }
    ],
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: [{ ref: "openai/gpt-4o" }]
      }
    }
  });

  const next = applyProviderInlineEdits(config, "openai", {
    id: "openai-primary",
    name: "OpenAI Primary",
    endpoints: ["https://gateway.example.test/v1", "https://gateway.example.test/v2"],
    rateLimitRows: [
      {
        sourceId: "default",
        models: ["all"],
        requests: "120",
        windowValue: "2",
        windowUnit: "minute"
      }
    ]
  });

  assert.equal(next.providers[0].id, "openai-primary");
  assert.equal(next.providers[0].name, "OpenAI Primary");
  assert.equal(next.providers[0].baseUrl, "https://gateway.example.test/v1");
  assert.deepEqual(next.providers[0].baseUrlByFormat, {
    openai: "https://gateway.example.test/v1",
    claude: "https://gateway.example.test/v1"
  });
  assert.deepEqual(next.providers[0].metadata.endpointCandidates, [
    "https://gateway.example.test/v1",
    "https://gateway.example.test/v2"
  ]);
  assert.deepEqual(next.modelAliases[DEFAULT_MODEL_ALIAS_ID].targets.map((target) => target.ref), ["openai-primary/gpt-4o-mini"]);
  assert.deepEqual(next.modelAliases[DEFAULT_MODEL_ALIAS_ID].fallbackTargets.map((target) => target.ref), ["openai-primary/gpt-4o"]);
  assert.deepEqual(next.providers[0].models[1].fallbackModels, ["openai-primary/gpt-4o-mini"]);
  assert.deepEqual(next.providers[1].models[0].fallbackModels, ["openai-primary/gpt-4o-mini"]);
  assert.equal(next.providers[0].rateLimits[0].id, "120-req-per-2-minutes");
  assert.equal(next.providers[0].rateLimits[0].requests, 120);
  assert.equal(next.providers[0].rateLimits[0].window.size, 2);
  assert.equal(next.providers[0].rateLimits[0].window.unit, "minute");
  assert.equal(Object.prototype.hasOwnProperty.call(next.providers[0].rateLimits[0], "name"), false);
});

test("applyProviderInlineEdits rewrites all rate-limit entities and preserves bucket metadata", () => {
  const config = createBaseConfig({
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        format: "openai",
        models: [
          { id: "gpt-4o-mini" },
          { id: "gpt-4o" }
        ],
        rateLimits: [
          {
            id: "legacy-all",
            name: "Legacy all",
            models: ["all"],
            requests: 60,
            window: { unit: "minute", size: 1 },
            metadata: { source: "existing" }
          },
          {
            id: "legacy-model",
            models: ["gpt-4o-mini"],
            requests: 400,
            window: { unit: "day", size: 1 },
            metadata: { source: "existing" }
          }
        ]
      }
    ]
  });

  const next = applyProviderInlineEdits(config, "openai", {
    id: "openai",
    name: "OpenAI",
    endpoints: ["https://api.openai.com/v1"],
    rateLimitRows: [
      {
        sourceId: "legacy-model",
        models: ["gpt-4o-mini"],
        requests: "180",
        windowValue: "3",
        windowUnit: "week"
      },
      {
        models: ["gpt-4o"],
        requests: "30",
        windowValue: "1",
        windowUnit: "minute"
      }
    ]
  });

  assert.deepEqual(next.providers[0].rateLimits, [
    {
      id: "180-req-per-3-weeks",
      models: ["gpt-4o-mini"],
      requests: 180,
      window: { unit: "week", size: 3 },
      metadata: { source: "existing" }
    },
    {
      id: "30-req-per-1-minute",
      models: ["gpt-4o"],
      requests: 30,
      window: { size: 1, unit: "minute" }
    }
  ]);
});
