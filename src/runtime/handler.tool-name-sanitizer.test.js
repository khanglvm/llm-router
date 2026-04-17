import test from "node:test";
import assert from "node:assert/strict";
import {
  buildToolNameMap,
  sanitizeBodyToolNames,
  reverseToolNamesInResponse
} from "./handler/tool-name-sanitizer.js";

// ---------------------------------------------------------------------------
// buildToolNameMap
// ---------------------------------------------------------------------------

test("buildToolNameMap returns null when no tools", () => {
  assert.equal(buildToolNameMap({}), null);
  assert.equal(buildToolNameMap({ tools: [] }), null);
  assert.equal(buildToolNameMap(null), null);
});

test("buildToolNameMap returns null when all names valid", () => {
  const body = {
    tools: [
      { type: "function", function: { name: "read_file" } },
      { type: "function", function: { name: "web-search" } }
    ]
  };
  assert.equal(buildToolNameMap(body), null);
});

test("buildToolNameMap detects dot in tool name", () => {
  const body = {
    tools: [
      { type: "function", function: { name: "mcp.server.tool" } },
      { type: "function", function: { name: "read_file" } }
    ]
  };
  const map = buildToolNameMap(body);
  assert.ok(map);
  assert.equal(map.size, 1);
  assert.equal(map.get("mcp_server_tool"), "mcp.server.tool");
});

test("buildToolNameMap detects colon in Responses API format", () => {
  const body = {
    tools: [
      { type: "function", name: "ns:tool" }
    ]
  };
  const map = buildToolNameMap(body);
  assert.ok(map);
  assert.equal(map.get("ns_tool"), "ns:tool");
});

test("buildToolNameMap handles multiple invalid names", () => {
  const body = {
    tools: [
      { type: "function", function: { name: "a.b" } },
      { type: "function", function: { name: "c:d" } },
      { type: "function", function: { name: "valid_name" } }
    ]
  };
  const map = buildToolNameMap(body);
  assert.ok(map);
  assert.equal(map.size, 2);
  assert.equal(map.get("a_b"), "a.b");
  assert.equal(map.get("c_d"), "c:d");
});

// ---------------------------------------------------------------------------
// sanitizeBodyToolNames
// ---------------------------------------------------------------------------

test("sanitizeBodyToolNames is no-op when nameMap is null", () => {
  const body = { tools: [{ type: "function", function: { name: "ok" } }] };
  assert.equal(sanitizeBodyToolNames(body, null), body);
});

test("sanitizeBodyToolNames replaces function.name in Chat Completions format", () => {
  const nameMap = new Map([["mcp_server_tool", "mcp.server.tool"]]);
  const body = {
    tools: [
      { type: "function", function: { name: "mcp.server.tool", parameters: {} } },
      { type: "function", function: { name: "valid_tool", parameters: {} } }
    ]
  };
  const result = sanitizeBodyToolNames(body, nameMap);
  assert.equal(result.tools[0].function.name, "mcp_server_tool");
  assert.equal(result.tools[1].function.name, "valid_tool");
});

test("sanitizeBodyToolNames replaces name in Responses API format", () => {
  const nameMap = new Map([["ns_tool", "ns:tool"]]);
  const body = {
    tools: [{ type: "function", name: "ns:tool", parameters: {} }]
  };
  const result = sanitizeBodyToolNames(body, nameMap);
  assert.equal(result.tools[0].name, "ns_tool");
});

test("sanitizeBodyToolNames sanitizes tool_choice", () => {
  const nameMap = new Map([["a_b", "a.b"]]);
  const body = {
    tools: [{ type: "function", function: { name: "a.b" } }],
    tool_choice: { type: "function", function: { name: "a.b" } }
  };
  const result = sanitizeBodyToolNames(body, nameMap);
  assert.equal(result.tool_choice.function.name, "a_b");
});

test("sanitizeBodyToolNames sanitizes function_call items in input", () => {
  const nameMap = new Map([["a_b", "a.b"]]);
  const body = {
    tools: [{ type: "function", name: "a.b" }],
    input: [
      { type: "function_call", name: "a.b", call_id: "c1", arguments: "{}" },
      { type: "message", role: "user", content: "hello" }
    ]
  };
  const result = sanitizeBodyToolNames(body, nameMap);
  assert.equal(result.input[0].name, "a_b");
  assert.equal(result.input[1].role, "user");
});

test("sanitizeBodyToolNames sanitizes assistant tool_calls in messages", () => {
  const nameMap = new Map([["a_b", "a.b"]]);
  const body = {
    tools: [{ type: "function", function: { name: "a.b" } }],
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [{ id: "t1", function: { name: "a.b", arguments: "{}" } }]
      }
    ]
  };
  const result = sanitizeBodyToolNames(body, nameMap);
  assert.equal(result.messages[1].tool_calls[0].function.name, "a_b");
});

// ---------------------------------------------------------------------------
// reverseToolNamesInResponse — non-streaming
// ---------------------------------------------------------------------------

test("reverseToolNamesInResponse is no-op when no map", () => {
  const r = new Response("test");
  assert.equal(reverseToolNamesInResponse(r, null, false), r);
});

test("reverseToolNamesInResponse reverses Chat Completions non-stream", async () => {
  const nameMap = new Map([["mcp_tool", "mcp.tool"]]);
  const payload = {
    choices: [{
      message: {
        tool_calls: [{ id: "t1", function: { name: "mcp_tool", arguments: "{}" } }]
      }
    }]
  };
  const response = new Response(JSON.stringify(payload));
  const reversed = reverseToolNamesInResponse(response, nameMap, false);
  const json = await reversed.json();
  assert.equal(json.choices[0].message.tool_calls[0].function.name, "mcp.tool");
});

test("reverseToolNamesInResponse reverses Responses API non-stream", async () => {
  const nameMap = new Map([["ns_tool", "ns:tool"]]);
  const payload = {
    output: [
      { type: "function_call", name: "ns_tool", call_id: "c1", arguments: "{}" }
    ]
  };
  const response = new Response(JSON.stringify(payload));
  const reversed = reverseToolNamesInResponse(response, nameMap, false);
  const json = await reversed.json();
  assert.equal(json.output[0].name, "ns:tool");
});

test("reverseToolNamesInResponse reverses Claude non-stream", async () => {
  const nameMap = new Map([["a_b", "a.b"]]);
  const payload = {
    content: [
      { type: "tool_use", id: "t1", name: "a_b", input: {} }
    ]
  };
  const response = new Response(JSON.stringify(payload));
  const reversed = reverseToolNamesInResponse(response, nameMap, false);
  const json = await reversed.json();
  assert.equal(json.content[0].name, "a.b");
});

// ---------------------------------------------------------------------------
// reverseToolNamesInResponse — streaming
// ---------------------------------------------------------------------------

test("reverseToolNamesInResponse reverses Chat Completions stream", async () => {
  const nameMap = new Map([["mcp_tool", "mcp.tool"]]);
  const chunk = JSON.stringify({
    choices: [{ delta: { tool_calls: [{ function: { name: "mcp_tool" } }] } }]
  });
  const sseData = `data: ${chunk}\n\ndata: [DONE]\n\n`;
  const response = new Response(sseData, {
    headers: { "content-type": "text/event-stream" }
  });
  const reversed = reverseToolNamesInResponse(response, nameMap, true);
  const text = await reversed.text();
  assert.ok(text.includes('"mcp.tool"'));
  assert.ok(!text.includes('"mcp_tool"'));
});

test("reverseToolNamesInResponse reverses Responses API stream events", async () => {
  const nameMap = new Map([["ns_tool", "ns:tool"]]);
  const event1 = JSON.stringify({
    type: "response.output_item.added",
    item: { type: "function_call", name: "ns_tool" }
  });
  const event2 = JSON.stringify({
    type: "response.function_call_arguments.done",
    name: "ns_tool",
    call_id: "c1",
    arguments: "{}"
  });
  const event3 = JSON.stringify({
    type: "response.completed",
    response: {
      output: [{ type: "function_call", name: "ns_tool", call_id: "c1", arguments: "{}" }]
    }
  });
  const sseData = `data: ${event1}\n\ndata: ${event2}\n\ndata: ${event3}\n\n`;
  const response = new Response(sseData, {
    headers: { "content-type": "text/event-stream" }
  });
  const reversed = reverseToolNamesInResponse(response, nameMap, true);
  const text = await reversed.text();
  assert.ok(text.includes('"ns:tool"'), "should reverse ns_tool to ns:tool");
  assert.ok(!text.includes('"ns_tool"'), "should not contain sanitized name");
});

test("reverseToolNamesInResponse passes through lines without matches", async () => {
  const nameMap = new Map([["a_b", "a.b"]]);
  const chunk = JSON.stringify({ choices: [{ delta: { content: "hello" } }] });
  const sseData = `data: ${chunk}\n\ndata: [DONE]\n\n`;
  const response = new Response(sseData, {
    headers: { "content-type": "text/event-stream" }
  });
  const reversed = reverseToolNamesInResponse(response, nameMap, true);
  const text = await reversed.text();
  assert.ok(text.includes("hello"));
});

test("reverseToolNamesInResponse reverses Claude streaming content_block_start", async () => {
  const nameMap = new Map([["a_b", "a.b"]]);
  const event = JSON.stringify({
    type: "content_block_start",
    content_block: { type: "tool_use", id: "t1", name: "a_b", input: {} }
  });
  const sseData = `event: content_block_start\ndata: ${event}\n\n`;
  const response = new Response(sseData, {
    headers: { "content-type": "text/event-stream" }
  });
  const reversed = reverseToolNamesInResponse(response, nameMap, true);
  const text = await reversed.text();
  assert.ok(text.includes('"a.b"'));
});
