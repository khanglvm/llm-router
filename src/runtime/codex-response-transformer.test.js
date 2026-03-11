import test from "node:test";
import assert from "node:assert/strict";
import {
  convertCodexResponseToOpenAIChatCompletion,
  extractCodexFinalResponse,
  extractCodexFinalResponseFromText,
  handleCodexStreamToOpenAI
} from "./codex-response-transformer.js";

function parseOpenAIStreamChunks(bodyText) {
  return String(bodyText || "")
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.replace(/^data:\s*/, ""))
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

test("convertCodexResponseToOpenAIChatCompletion maps assistant output text", () => {
  const converted = convertCodexResponseToOpenAIChatCompletion({
    id: "resp_1",
    object: "response",
    created_at: 1730000000,
    model: "gpt-5.3-codex",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "pong"
          }
        ]
      }
    ],
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      total_tokens: 3
    }
  });

  assert.equal(converted.id, "chatcmpl_resp_1");
  assert.equal(converted.object, "chat.completion");
  assert.equal(converted.model, "gpt-5.3-codex");
  assert.equal(converted.choices[0]?.message?.role, "assistant");
  assert.equal(converted.choices[0]?.message?.content, "pong");
  assert.equal(converted.choices[0]?.finish_reason, "stop");
  assert.equal(converted.usage?.prompt_tokens, 2);
  assert.equal(converted.usage?.completion_tokens, 1);
});

test("convertCodexResponseToOpenAIChatCompletion maps function_call output items", () => {
  const converted = convertCodexResponseToOpenAIChatCompletion({
    id: "resp_tool",
    object: "response",
    created_at: 1730000001,
    model: "gpt-5.3-codex",
    output: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: "{\"city\":\"hcm\"}"
      }
    ]
  });

  assert.equal(converted.choices[0]?.finish_reason, "tool_calls");
  assert.equal(converted.choices[0]?.message?.content, null);
  assert.equal(converted.choices[0]?.message?.tool_calls?.[0]?.id, "call_1");
  assert.equal(converted.choices[0]?.message?.tool_calls?.[0]?.function?.name, "get_weather");
});

test("handleCodexStreamToOpenAI converts responses SSE events into chat completion chunks", async () => {
  const ssePayload = [
    "event: response.created",
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream\",\"created_at\":1730000002,\"model\":\"gpt-5.3-codex\"}}",
    "",
    "event: response.output_text.delta",
    "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"output_index\":0,\"content_index\":0,\"delta\":\"po\"}",
    "",
    "event: response.output_text.delta",
    "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"output_index\":0,\"content_index\":0,\"delta\":\"ng\"}",
    "",
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stream\",\"created_at\":1730000002,\"model\":\"gpt-5.3-codex\",\"output\":[{\"type\":\"message\",\"id\":\"msg_1\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"pong\"}]}],\"usage\":{\"input_tokens\":2,\"output_tokens\":1,\"total_tokens\":3},\"incomplete_details\":null}}",
    "",
    ""
  ].join("\n");

  const convertedResponse = handleCodexStreamToOpenAI(new Response(ssePayload, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }));

  const bodyText = await convertedResponse.text();
  assert.match(bodyText, /"object":"chat\.completion\.chunk"/);
  assert.match(bodyText, /"role":"assistant"/);
  assert.match(bodyText, /"content":"po"/);
  assert.match(bodyText, /"content":"ng"/);
  assert.match(bodyText, /"finish_reason":"stop"/);
  assert.match(bodyText, /\[DONE\]/);
});

test("extractCodexFinalResponseFromText parses plain JSON response payload", () => {
  const parsed = extractCodexFinalResponseFromText(JSON.stringify({
    id: "resp_json",
    object: "response",
    model: "gpt-5.3-codex"
  }));
  assert.equal(parsed?.id, "resp_json");
  assert.equal(parsed?.object, "response");
});

test("extractCodexFinalResponse reads response.completed payload from SSE stream", async () => {
  const ssePayload = [
    "event: response.created",
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream\",\"created_at\":1730000002,\"model\":\"gpt-5.3-codex\"}}",
    "",
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stream\",\"object\":\"response\",\"created_at\":1730000002,\"model\":\"gpt-5.3-codex\"}}",
    "",
    ""
  ].join("\n");

  const parsed = await extractCodexFinalResponse(new Response(ssePayload, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }));
  assert.equal(parsed?.id, "resp_stream");
  assert.equal(parsed?.object, "response");
});

test("handleCodexStreamToOpenAI falls back to response.completed text when delta events are absent", async () => {
  const ssePayload = [
    "event: response.created",
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_completed_text\",\"created_at\":1730000003,\"model\":\"gpt-5.3-codex\"}}",
    "",
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_completed_text\",\"created_at\":1730000003,\"model\":\"gpt-5.3-codex\",\"output\":[{\"type\":\"message\",\"id\":\"msg_completed_text\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"{\\\"ok\\\":true,\\\"items\\\":[1,2,3]}\"}]}],\"usage\":{\"input_tokens\":2,\"output_tokens\":6,\"total_tokens\":8},\"incomplete_details\":null}}"
  ].join("\n");

  const convertedResponse = handleCodexStreamToOpenAI(new Response(ssePayload, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }));

  const bodyText = await convertedResponse.text();
  const chunks = parseOpenAIStreamChunks(bodyText);
  assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.delta?.content === '{"ok":true,"items":[1,2,3]}'));
  assert.ok(bodyText.includes("data: [DONE]"));
});

test("handleCodexStreamToOpenAI falls back to output_item.done for complete tool calls", async () => {
  const ssePayload = [
    "event: response.created",
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_completed_tool\",\"created_at\":1730000004,\"model\":\"gpt-5.3-codex\"}}",
    "",
    "event: response.output_item.done",
    "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc_item_1\",\"call_id\":\"call_1\",\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"hcm\\\"}\"}}",
    "",
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_completed_tool\",\"created_at\":1730000004,\"model\":\"gpt-5.3-codex\",\"output\":[{\"type\":\"function_call\",\"id\":\"fc_item_1\",\"call_id\":\"call_1\",\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"hcm\\\"}\"}],\"usage\":{\"input_tokens\":2,\"output_tokens\":4,\"total_tokens\":6},\"incomplete_details\":null}}",
    "",
    ""
  ].join("\n");

  const convertedResponse = handleCodexStreamToOpenAI(new Response(ssePayload, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }));

  const chunks = parseOpenAIStreamChunks(await convertedResponse.text());
  const toolNameChunk = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === "get_weather");
  const toolArgsChunk = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments === '{"city":"hcm"}');
  const finishChunk = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls");

  assert.ok(toolNameChunk);
  assert.ok(toolArgsChunk);
  assert.ok(finishChunk);
});
