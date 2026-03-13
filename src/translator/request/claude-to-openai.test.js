import test from "node:test";
import assert from "node:assert/strict";
import { claudeToOpenAIRequest } from "./claude-to-openai.js";

test("claudeToOpenAIRequest maps Claude native web search tools onto a routable OpenAI web_search function", () => {
  const translated = claudeToOpenAIRequest("gpt-5.4", {
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Search the web for llm-router release notes." }]
      }
    ],
    tools: [
      {
        type: "web_search_20250305",
        name: "native_web_search",
        max_uses: 3
      }
    ],
    tool_choice: {
      type: "tool",
      name: "web_search"
    }
  }, false);

  assert.equal(translated.model, "gpt-5.4");
  assert.equal(translated.stream, false);
  assert.equal(translated.tools?.length, 1);
  assert.equal(translated.tools?.[0]?.type, "function");
  assert.equal(translated.tools?.[0]?.function?.name, "web_search");
  assert.equal(
    translated.tools?.[0]?.function?.parameters?.properties?.query?.type,
    "string"
  );
  assert.deepEqual(translated.tool_choice, {
    type: "function",
    function: {
      name: "web_search"
    }
  });
});
