import test from "node:test";
import assert from "node:assert/strict";

import {
  applyQuickStartConnectionPreset,
  createQuickStartState
} from "./quick-start-utils.js";

test("applyQuickStartConnectionPreset fills preset endpoints when the current endpoint field is still empty", () => {
  const current = createQuickStartState({}, { seedMode: "blank" });

  const next = applyQuickStartConnectionPreset(current, {
    baseConfig: {},
    nextCategory: "api",
    nextPresetKey: "openrouter"
  });

  assert.equal(next.selectedConnection, "openrouter");
  assert.deepEqual(next.endpoints, ["https://openrouter.ai/api/v1"]);
  assert.equal(next.endpointDraft, "");
});

test("applyQuickStartConnectionPreset preserves manually entered endpoint and api key values", () => {
  const current = {
    ...createQuickStartState({}, { seedMode: "blank" }),
    endpoints: ["https://gateway.example.test/v1"],
    endpointDraft: "",
    apiKeyEnv: "MY_PROVIDER_API_KEY"
  };

  const next = applyQuickStartConnectionPreset(current, {
    baseConfig: {},
    nextCategory: "api",
    nextPresetKey: "groq"
  });

  assert.deepEqual(next.endpoints, ["https://gateway.example.test/v1"]);
  assert.equal(next.apiKeyEnv, "MY_PROVIDER_API_KEY");
});

test("applyQuickStartConnectionPreset replaces endpoints when they still match the previous preset default", () => {
  const current = {
    ...createQuickStartState({}, { seedMode: "blank" }),
    selectedConnection: "groq",
    providerName: "Groq",
    providerId: "groq",
    endpoints: ["https://api.groq.com/openai/v1"],
    endpointDraft: ""
  };

  const next = applyQuickStartConnectionPreset(current, {
    baseConfig: {},
    nextCategory: "api",
    nextPresetKey: "openrouter"
  });

  assert.deepEqual(next.endpoints, ["https://openrouter.ai/api/v1"]);
  assert.equal(next.endpointDraft, "");
});
