import test from "node:test";
import assert from "node:assert/strict";
import { createLiteLlmContextLookupHelper } from "./litellm-context-catalog.js";

test("LiteLLM lookup returns exact-match median context windows", async () => {
  const lookupLiteLlmContextWindow = createLiteLlmContextLookupHelper({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          "gpt-4o-mini": {
            max_input_tokens: 128000,
            litellm_provider: "openai"
          }
        };
      }
    })
  });

  const [result] = await lookupLiteLlmContextWindow({ models: ["gpt-4o-mini"] });
  assert.equal(result.query, "gpt-4o-mini");
  assert.equal(result.exactMatch?.contextWindow, 128000);
  assert.equal(result.medianContextWindow, 128000);
  assert.deepEqual(result.suggestions, []);
});

test("LiteLLM lookup derives a median context window from suggestions", async () => {
  const lookupLiteLlmContextWindow = createLiteLlmContextLookupHelper({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          "gpt-4.1-mini": {
            max_input_tokens: 128000,
            litellm_provider: "openai"
          },
          "gpt-4.1-nano": {
            max_input_tokens: 32000,
            litellm_provider: "openai"
          },
          "gpt-4.1": {
            max_input_tokens: 1048576,
            litellm_provider: "openai"
          }
        };
      }
    })
  });

  const [result] = await lookupLiteLlmContextWindow({ models: ["gpt-4.1-preview"] });
  assert.equal(result.query, "gpt-4.1-preview");
  assert.equal(result.exactMatch, null);
  assert.equal(result.medianContextWindow, 128000);
  assert.deepEqual(
    result.suggestions.map((entry) => entry.contextWindow).sort((left, right) => left - right),
    [128000, 32000, 1048576]
      .sort((left, right) => left - right)
  );
});

test("LiteLLM lookup treats provider-prefixed model ids as exact matches for autofill", async () => {
  const lookupLiteLlmContextWindow = createLiteLlmContextLookupHelper({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          "openrouter/zai/glm-5": {
            max_input_tokens: 262144,
            litellm_provider: "openrouter"
          },
          "zai/glm-5-thinking": {
            max_input_tokens: 128000,
            litellm_provider: "openrouter"
          },
          "zai/glm-5-mini": {
            max_input_tokens: 64000,
            litellm_provider: "openrouter"
          }
        };
      }
    })
  });

  const [result] = await lookupLiteLlmContextWindow({ models: ["zai/glm-5"] });
  assert.equal(result.query, "zai/glm-5");
  assert.equal(result.exactMatch?.model, "openrouter/zai/glm-5");
  assert.equal(result.exactMatch?.contextWindow, 262144);
  assert.equal(result.medianContextWindow, 262144);
  assert.deepEqual(
    result.suggestions.map((entry) => entry.model).sort(),
    ["zai/glm-5-mini", "zai/glm-5-thinking"].sort()
  );
});
