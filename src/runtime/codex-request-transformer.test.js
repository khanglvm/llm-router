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
