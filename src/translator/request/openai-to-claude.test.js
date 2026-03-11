import test from "node:test";
import assert from "node:assert/strict";
import { openAIToClaudeRequest } from "./openai-to-claude.js";

test("openAIToClaudeRequest converts OpenAI responses payloads into Claude messages", () => {
  const translated = openAIToClaudeRequest("glm-5", {
    model: "gpt-5.3-codex",
    instructions: "Follow the repo conventions.",
    max_output_tokens: 512,
    input: [
      {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "System guidance." }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect AMP routing." }]
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Checking local files." }]
      },
      {
        type: "function_call",
        call_id: "call_repo_search",
        name: "search_repo",
        arguments: "{\"query\":\"AMP\"}"
      },
      {
        type: "function_call_output",
        call_id: "call_repo_search",
        output: "Found src/runtime/handler/request.js"
      }
    ],
    tools: [
      {
        type: "function",
        name: "search_repo",
        description: "Search files",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" }
          }
        }
      }
    ],
    tool_choice: "required"
  }, true);

  assert.equal(translated.model, "glm-5");
  assert.equal(translated.stream, true);
  assert.equal(translated.max_tokens, 512);
  assert.equal(translated.system, "Follow the repo conventions.\nSystem guidance.");
  assert.equal(translated.messages.length, 3);
  assert.equal(translated.messages[0].role, "user");
  assert.equal(translated.messages[0].content[0].text, "Inspect AMP routing.");
  assert.equal(translated.messages[1].role, "assistant");
  assert.equal(translated.messages[1].content[0].text, "Checking local files.");
  assert.equal(translated.messages[1].content[1].type, "tool_use");
  assert.equal(translated.messages[1].content[1].id, "call_repo_search");
  assert.equal(translated.messages[1].content[1].name, "search_repo");
  assert.deepEqual(translated.messages[1].content[1].input, { query: "AMP" });
  assert.equal(translated.messages[2].role, "user");
  assert.equal(translated.messages[2].content[0].type, "tool_result");
  assert.equal(translated.messages[2].content[0].tool_use_id, "call_repo_search");
  assert.equal(translated.messages[2].content[0].content, "Found src/runtime/handler/request.js");
  assert.equal(translated.tools?.[0]?.name, "search_repo");
  assert.deepEqual(translated.tools?.[0]?.input_schema, {
    type: "object",
    properties: {
      query: { type: "string" }
    }
  });
  assert.deepEqual(translated.tool_choice, { type: "any" });
});

test("openAIToClaudeRequest maps OpenAI web search tools onto Claude web search", () => {
  const translated = openAIToClaudeRequest("claude-sonnet-4-6", {
    model: "smart",
    input: "Search for current LLM router releases.",
    tools: [
      {
        type: "web_search_preview",
        name: "amp_web_search",
        max_uses: 4
      }
    ],
    tool_choice: "required"
  }, false);

  assert.deepEqual(translated.tools, [
    {
      type: "web_search_20250305",
      name: "amp_web_search",
      max_uses: 4
    }
  ]);
  assert.deepEqual(translated.tool_choice, { type: "any" });
});
