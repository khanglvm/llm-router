import test from "node:test";
import assert from "node:assert/strict";
import {
  convertOpenAINonStreamToClaude,
  handleClaudeStreamToOpenAIResponses,
  handleOpenAIStreamToClaude,
  normalizeClaudePassthroughStream
} from "./handler/provider-translation.js";

function parseSseEvents(raw) {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event:")) || "";
      const dataLine = lines.find((line) => line.startsWith("data:")) || "";
      return {
        event: eventLine.slice(6).trim(),
        payload: JSON.parse(dataLine.slice(5).trim())
      };
    });
}

test("handleOpenAIStreamToClaude parses multi-line SSE data blocks and emits one message_stop", async () => {
  const openAIStream = [
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1730000010,',
    'data: "model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1730000010,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]'
  ].join("\n");

  const response = handleOpenAIStreamToClaude(new Response(openAIStream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }));

  const bodyText = await response.text();
  assert.match(bodyText, /event: message_start/);
  assert.match(bodyText, /event: content_block_start/);
  assert.match(bodyText, /"text":"hello"/);
  assert.match(bodyText, /event: message_delta/);
  assert.equal(bodyText.match(/event: message_stop/g)?.length || 0, 1);
});

test("handleOpenAIStreamToClaude keeps tool_use stop_reason when provider ends tool calls with stop", async () => {
  const openAIStream = [
    'data: {"id":"chatcmpl_tool_1","object":"chat.completion.chunk","created":1730000020,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_read_1","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_tool_1","object":"chat.completion.chunk","created":1730000020,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_tool_1","object":"chat.completion.chunk","created":1730000020,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]'
  ].join("\n");

  const response = handleOpenAIStreamToClaude(new Response(openAIStream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }));

  const events = parseSseEvents(await response.text());
  assert.deepEqual(events.map((entry) => entry.event), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop"
  ]);
  assert.equal(events[4]?.payload?.delta?.stop_reason, "tool_use");
});

test("handleOpenAIStreamToClaude synthesizes tool ids when streamed tool_calls omit them", async () => {
  const openAIStream = [
    'data: {"id":"chatcmpl_tool_legacy_id","object":"chat.completion.chunk","created":1730000025,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_tool_legacy_id","object":"chat.completion.chunk","created":1730000025,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_tool_legacy_id","object":"chat.completion.chunk","created":1730000025,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]'
  ].join("\n");

  const response = handleOpenAIStreamToClaude(new Response(openAIStream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }));

  const events = parseSseEvents(await response.text());
  assert.deepEqual(events.map((entry) => entry.event), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop"
  ]);
  assert.match(events[1]?.payload?.content_block?.id || "", /^tool_/);
  assert.equal(events[1]?.payload?.content_block?.name, "read");
  assert.equal(events[4]?.payload?.delta?.stop_reason, "tool_use");
});

test("handleOpenAIStreamToClaude supports legacy streamed function_call deltas", async () => {
  const openAIStream = [
    'data: {"id":"chatcmpl_function_call_1","object":"chat.completion.chunk","created":1730000026,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","function_call":{"name":"read","arguments":""}},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_function_call_1","object":"chat.completion.chunk","created":1730000026,"model":"gpt-4o","choices":[{"index":0,"delta":{"function_call":{"arguments":"{\\"path\\":\\"README.md\\"}"}},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_function_call_1","object":"chat.completion.chunk","created":1730000026,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"function_call"}]}',
    '',
    'data: [DONE]'
  ].join("\n");

  const response = handleOpenAIStreamToClaude(new Response(openAIStream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }));

  const events = parseSseEvents(await response.text());
  assert.deepEqual(events.map((entry) => entry.event), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop"
  ]);
  assert.equal(events[1]?.payload?.content_block?.name, "read");
  assert.equal(events[4]?.payload?.delta?.stop_reason, "tool_use");
});

test("handleOpenAIStreamToClaude falls back to terminal choice.message text", async () => {
  const openAIStream = [
    'data: {"id":"chatcmpl_message_fallback_1","object":"chat.completion.chunk","created":1730000027,"model":"gpt-4o","choices":[{"index":0,"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]'
  ].join("\n");

  const response = handleOpenAIStreamToClaude(new Response(openAIStream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }));

  const events = parseSseEvents(await response.text());
  assert.deepEqual(events.map((entry) => entry.event), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop"
  ]);
  assert.equal(events[2]?.payload?.delta?.text, "hello");
  assert.equal(events[4]?.payload?.delta?.stop_reason, "end_turn");
});

test("handleOpenAIStreamToClaude falls back to terminal choice.message tool calls", async () => {
  const openAIStream = [
    'data: {"id":"chatcmpl_message_fallback_2","object":"chat.completion.chunk","created":1730000028,"model":"gpt-4o","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_read_3","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]'
  ].join("\n");

  const response = handleOpenAIStreamToClaude(new Response(openAIStream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }));

  const events = parseSseEvents(await response.text());
  assert.deepEqual(events.map((entry) => entry.event), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop"
  ]);
  assert.equal(events[1]?.payload?.content_block?.id, "call_read_3");
  assert.equal(events[1]?.payload?.content_block?.name, "read");
  assert.equal(events[4]?.payload?.delta?.stop_reason, "tool_use");
});

test("convertOpenAINonStreamToClaude keeps tool_use stop_reason when tool calls finish with stop", () => {
  const translated = convertOpenAINonStreamToClaude({
    id: "chatcmpl_tool_2",
    model: "gpt-4o",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_read_2",
          type: "function",
          function: {
            name: "read",
            arguments: "{\"path\":\"README.md\"}"
          }
        }]
      }
    }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4
    }
  }, "gpt-4o");

  assert.equal(translated.stop_reason, "tool_use");
  assert.deepEqual(translated.content, [{
    type: "tool_use",
    id: "call_read_2",
    name: "read",
    input: { path: "README.md" }
  }]);
});

test("convertOpenAINonStreamToClaude maps legacy function_call payloads", () => {
  const translated = convertOpenAINonStreamToClaude({
    id: "chatcmpl_function_call_2",
    model: "gpt-4o",
    choices: [{
      index: 0,
      finish_reason: "function_call",
      message: {
        role: "assistant",
        content: null,
        function_call: {
          name: "read",
          arguments: "{\"path\":\"README.md\"}"
        }
      }
    }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4
    }
  }, "gpt-4o");

  assert.equal(translated.stop_reason, "tool_use");
  assert.deepEqual(translated.content, [{
    type: "tool_use",
    id: "tool_0",
    name: "read",
    input: { path: "README.md" }
  }]);
});

test("handleClaudeStreamToOpenAIResponses emits contiguous output indexes when thinking precedes tool calls", async () => {
  const claudeStream = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_router_2","model":"glm-5","usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Inspecting repo..."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_repo_search","name":"shell_command","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"rg -n AMP\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":2,"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ].join("");

  const response = handleClaudeStreamToOpenAIResponses(new Response(claudeStream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }), {
    model: "gpt-5.3-codex"
  }, "glm-5");

  const bodyText = await response.text();
  const events = parseSseEvents(bodyText);

  const outputItemsAdded = events.filter((entry) => entry.event === "response.output_item.added");
  assert.equal(outputItemsAdded.length, 2);
  assert.equal(outputItemsAdded[0].payload.output_index, 0);
  assert.equal(outputItemsAdded[0].payload.item.type, "reasoning");
  assert.equal(outputItemsAdded[1].payload.output_index, 1);
  assert.equal(outputItemsAdded[1].payload.item.type, "function_call");

  const toolDelta = events.find((entry) => entry.event === "response.function_call_arguments.delta");
  assert.equal(toolDelta?.payload?.output_index, 1);

  const completed = events.find((entry) => entry.event === "response.completed");
  assert.deepEqual(
    completed?.payload?.response?.output?.map((item) => item.type),
    ["reasoning", "function_call"]
  );
});

test("normalizeClaudePassthroughStream synthesizes terminal message_delta before message_stop", async () => {
  const claudeStream = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_router_3","model":"claude-haiku-4-5","usage":{"input_tokens":6,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I can\\u2019t discuss that."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ].join("");

  const response = normalizeClaudePassthroughStream(new Response(claudeStream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  }));

  const bodyText = await response.text();
  const events = parseSseEvents(bodyText);
  assert.deepEqual(events.map((entry) => entry.event), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop"
  ]);
  assert.equal(events[4]?.payload?.delta?.stop_reason, "end_turn");
  assert.equal(events[4]?.payload?.usage?.input_tokens, 6);
  assert.equal(events[4]?.payload?.usage?.output_tokens, 0);
});
