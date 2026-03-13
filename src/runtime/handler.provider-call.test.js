import test from "node:test";
import assert from "node:assert/strict";
import { FORMATS } from "../translator/index.js";
import { makeProviderCall } from "./handler/provider-call.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function buildOpenAICandidate(providerOverrides = {}) {
  return {
    provider: {
      id: "rc",
      name: "RamClouds",
      baseUrl: "https://ramclouds.me",
      format: FORMATS.OPENAI,
      formats: [FORMATS.OPENAI],
      models: [{ id: "gpt-5.4" }],
      ...providerOverrides
    },
    providerId: "rc",
    modelId: "gpt-5.4",
    requestModelId: "rc/gpt-5.4",
    targetFormat: FORMATS.OPENAI,
    backend: "gpt-5.4"
  };
}

test("makeProviderCall retries OpenAI responses hosted web search with web_search when preview tool names are rejected", { concurrency: false }, async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body || "{}"));
    calls.push({
      url: String(url),
      body
    });

    if (calls.length === 1) {
      return jsonResponse({
        error: {
          message: "Unsupported tool type: web_search_preview"
        }
      }, 400);
    }

    return jsonResponse({
      id: "resp_native_search_retry",
      object: "response",
      model: "gpt-5.4",
      output: [
        { id: "ws_1", type: "web_search_call", status: "completed" },
        {
          id: "msg_1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Sunrise in Paris today is 7:10 AM."
            }
          ]
        }
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 12,
        total_tokens: 22
      }
    });
  };

  try {
    const result = await makeProviderCall({
      body: {
        model: "rc/gpt-5.4",
        input: "Find the sunrise time in Paris today and cite the source.",
        tools: [{ type: "web_search_preview" }],
        tool_choice: {
          type: "web_search_preview"
        }
      },
      sourceFormat: FORMATS.OPENAI,
      stream: false,
      candidate: buildOpenAICandidate(),
      requestKind: "responses",
      requestHeaders: new Headers(),
      env: {}
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://ramclouds.me/v1/responses");
    assert.equal(calls[0]?.body?.tools?.[0]?.type, "web_search_preview");
    assert.deepEqual(calls[0]?.body?.tool_choice, {
      type: "web_search_preview"
    });
    assert.equal(calls[1]?.body?.tools?.[0]?.type, "web_search");
    assert.equal(calls[1]?.body?.tool_choice, "required");

    const payload = await result.response.json();
    assert.equal(payload.object, "response");
    assert.equal(payload.output?.[0]?.type, "web_search_call");
    assert.equal(payload.output?.[1]?.content?.[0]?.text, "Sunrise in Paris today is 7:10 AM.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("makeProviderCall applies configured OpenAI responses hosted web search tool types before the first request", { concurrency: false }, async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body || "{}"))
    });
    return jsonResponse({
      id: "resp_native_search_declared",
      object: "response",
      model: "gpt-5.4",
      output: [
        {
          id: "msg_1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "OK"
            }
          ]
        }
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2
      }
    });
  };

  try {
    const result = await makeProviderCall({
      body: {
        model: "rc/gpt-5.4",
        input: "Search for a quick fact.",
        tools: [{ type: "web_search_preview" }],
        tool_choice: {
          type: "web_search_preview"
        }
      },
      sourceFormat: FORMATS.OPENAI,
      stream: false,
      candidate: buildOpenAICandidate({
        metadata: {
          openaiResponses: {
            webSearchToolType: "web_search"
          }
        }
      }),
      requestKind: "responses",
      requestHeaders: new Headers(),
      env: {}
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.body?.tools?.[0]?.type, "web_search");
    assert.equal(calls[0]?.body?.tool_choice, "required");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
