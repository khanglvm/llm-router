import test from "node:test";
import assert from "node:assert/strict";
import { claudeToOpenAIRequest } from "./claude-to-openai.js";

test("claudeToOpenAIRequest strips trailing empty assistant prefill", () => {
  const translated = claudeToOpenAIRequest("gpt-5.4", {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [] }
    ]
  }, true);

  assert.equal(translated.messages.length, 1);
  assert.equal(translated.messages[0].role, "user");
  assert.equal(translated.messages[0].content, "Hello");
});

test("claudeToOpenAIRequest strips trailing assistant with whitespace-only content", () => {
  const translated = claudeToOpenAIRequest("gpt-5.4", {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "  " }
    ]
  }, true);

  assert.equal(translated.messages.length, 1);
  assert.equal(translated.messages[0].role, "user");
});

test("claudeToOpenAIRequest preserves trailing assistant with real content", () => {
  const translated = claudeToOpenAIRequest("gpt-5.4", {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Here:" }] }
    ]
  }, true);

  assert.equal(translated.messages.length, 2);
  assert.equal(translated.messages[1].role, "assistant");
  assert.equal(translated.messages[1].content, "Here:");
});

test("claudeToOpenAIRequest preserves assistant with tool_calls (not stripped as empty prefill)", () => {
  const translated = claudeToOpenAIRequest("gpt-5.4", {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Search for X" },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "tool_1",
          name: "web_search",
          input: { query: "X" }
        }]
      }
    ]
  }, true);

  // fixMissingToolResponses adds a synthetic tool response, so we get 3 messages.
  // The key assertion: the assistant with tool_calls was NOT stripped.
  const assistantMsg = translated.messages.find(m => m.role === "assistant");
  assert.ok(assistantMsg, "assistant message should be preserved");
  assert.ok(assistantMsg.tool_calls.length > 0);
});

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
