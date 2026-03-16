import test from "node:test";
import assert from "node:assert/strict";
import { transformRequestForCodex } from "./codex-request-transformer.js";

test("transformRequestForCodex injects default instructions when missing", () => {
  const transformed = transformRequestForCodex({
    model: "gpt-5.3-codex",
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }]
  });

  assert.equal(transformed.instructions, "You are a helpful assistant.");
  assert.equal(transformed.store, false);
  assert.equal(transformed.stream, true);
  assert.deepEqual(transformed.include, []);
  assert.equal(transformed.max_tokens, undefined);
  assert.equal(transformed.max_output_tokens, undefined);
  assert.equal(transformed.max_completion_tokens, undefined);
  assert.equal(transformed.messages, undefined);
  assert.deepEqual(transformed.tools, []);
  assert.equal(transformed.tool_choice, "auto");
  assert.equal(transformed.parallel_tool_calls, false);
  assert.equal(transformed.input?.[0]?.type, "message");
  assert.equal(transformed.input?.[0]?.role, "user");
  assert.equal(transformed.input?.[0]?.content?.[0]?.type, "input_text");
  assert.equal(transformed.input?.[0]?.content?.[0]?.text, "ping");
});

test("transformRequestForCodex keeps explicit instructions", () => {
  const transformed = transformRequestForCodex({
    model: "gpt-5.3-codex",
    instructions: "Return exactly pong",
    messages: [{ role: "user", content: "ping" }]
  });

  assert.equal(transformed.instructions, "Return exactly pong");
});

test("transformRequestForCodex keeps existing responses-style input untouched", () => {
  const transformed = transformRequestForCodex({
    model: "gpt-5.3-codex",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "ping" }]
      }
    ]
  });

  assert.equal(Array.isArray(transformed.input), true);
  assert.equal(transformed.input?.[0]?.content?.[0]?.text, "ping");
});

test("transformRequestForCodex promotes leading system messages into instructions", () => {
  const transformed = transformRequestForCodex({
    model: "gpt-5.3-codex",
    messages: [
      { role: "system", content: "You are Claude Code." },
      { role: "developer", content: "Be decisive with repo maintenance tasks." },
      { role: "user", content: "Fix the merge conflict." }
    ]
  });

  assert.equal(
    transformed.instructions,
    "You are Claude Code.\n\nBe decisive with repo maintenance tasks."
  );
  assert.equal(transformed.input?.length, 1);
  assert.equal(transformed.input?.[0]?.role, "user");
  assert.equal(transformed.input?.[0]?.content?.[0]?.text, "Fix the merge conflict.");
});

test("transformRequestForCodex preserves tool call history after lifting system instructions", () => {
  const transformed = transformRequestForCodex({
    model: "gpt-5.3-codex",
    messages: [
      { role: "system", content: "You are Claude Code." },
      { role: "user", content: "Fix the merge conflict." },
      {
        role: "assistant",
        content: "I'll check git status first.",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: {
              name: "Bash",
              arguments: "{\"command\":\"git status\"}"
            }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: "toolu_1",
        content: "interactive rebase in progress"
      }
    ]
  });

  assert.equal(transformed.instructions, "You are Claude Code.");
  assert.deepEqual(transformed.input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fix the merge conflict." }]
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I'll check git status first." }]
    },
    {
      type: "function_call",
      call_id: "toolu_1",
      name: "Bash",
      arguments: "{\"command\":\"git status\"}"
    },
    {
      type: "function_call_output",
      call_id: "toolu_1",
      output: "interactive rebase in progress"
    }
  ]);
});

test("transformRequestForCodex preserves image detail field in output", () => {
  const transformed = transformRequestForCodex({
    model: "gpt-5.3-codex",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image:" },
          {
            type: "image_url",
            image_url: {
              url: "https://example.com/image.jpg",
              detail: "high"
            }
          }
        ]
      }
    ]
  });

  const userMessage = transformed.input[0];
  assert.equal(userMessage.role, "user");
  const imageContent = userMessage.content.find((part) => part.type === "input_image");
  assert.ok(imageContent, "Image content should be present");
  assert.equal(imageContent.detail, "high", "Image detail should be preserved");
});

test("transformRequestForCodex omits image detail when not provided", () => {
  const transformed = transformRequestForCodex({
    model: "gpt-5.3-codex",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image:" },
          {
            type: "image_url",
            image_url: "https://example.com/image.jpg"
          }
        ]
      }
    ]
  });

  const userMessage = transformed.input[0];
  assert.equal(userMessage.role, "user");
  const imageContent = userMessage.content.find((part) => part.type === "input_image");
  assert.ok(imageContent, "Image content should be present");
  assert.equal(imageContent.detail, undefined, "Image detail should not be present when not provided");
});

test("transformRequestForCodex transforms tool_choice with function name", () => {
  const transformed = transformRequestForCodex({
    model: "gpt-5.3-codex",
    messages: [{ role: "user", content: "Use bash tool" }],
    tool_choice: {
      type: "function",
      function: {
        name: "bash"
      }
    }
  });

  assert.deepEqual(transformed.tool_choice, {
    type: "function",
    name: "bash"
  });
});

test("transformRequestForCodex normalizes tool_choice type from 'tool' to 'function'", () => {
  const transformed = transformRequestForCodex({
    model: "gpt-5.3-codex",
    messages: [{ role: "user", content: "Use bash tool" }],
    tool_choice: {
      type: "tool",
      function: {
        name: "bash"
      }
    }
  });

  assert.deepEqual(transformed.tool_choice, {
    type: "function",
    name: "bash"
  });
});

test("transformRequestForCodex preserves string tool_choice values", () => {
  const transformed = transformRequestForCodex({
    model: "gpt-5.3-codex",
    messages: [{ role: "user", content: "Use any tool" }],
    tool_choice: "required"
  });

  assert.equal(transformed.tool_choice, "required");
});
