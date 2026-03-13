import test from "node:test";
import assert from "node:assert/strict";
import { createFetchHandler } from "./handler.js";
import { normalizeRuntimeConfig } from "./config.js";
import { resolveMaxRequestBodyBytes } from "./handler/request.js";

function buildConfig() {
  return normalizeRuntimeConfig({
    version: 2,
    defaultModel: "chat.default",
    modelAliases: {
      "chat.default": {
        strategy: "ordered",
        targets: [
          { ref: "openrouter/gpt-4o-mini" }
        ]
      }
    },
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [
          { id: "gpt-4o-mini" }
        ]
      }
    ]
  });
}

function makeResponsesRequest(bodyOverrides = {}) {
  return new Request("http://router.local/openai/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "chat.default",
      input: "Hello",
      max_output_tokens: 128,
      ...bodyOverrides
    })
  });
}

function makeChatCompletionsRequest(bodyOverrides = {}) {
  return new Request("http://router.local/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "chat.default",
      messages: [
        { role: "user", content: "Hello" }
      ],
      stream: false,
      ...bodyOverrides
    })
  });
}

test("resolveMaxRequestBodyBytes uses a larger default for responses requests", () => {
  assert.equal(resolveMaxRequestBodyBytes({}, { requestKind: "responses" }), 8 * 1024 * 1024);
  assert.equal(resolveMaxRequestBodyBytes({}, { requestKind: "chat-completions" }), 1 * 1024 * 1024);
  assert.equal(
    resolveMaxRequestBodyBytes({ LLM_ROUTER_MAX_REQUEST_BODY_BYTES: String(2 * 1024 * 1024) }, { requestKind: "responses" }),
    2 * 1024 * 1024
  );
});

test("createFetchHandler accepts multi-megabyte OpenAI responses requests by default", { concurrency: false }, async () => {
  const fetchHandler = createFetchHandler({
    getConfig: async () => buildConfig(),
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  const largeInput = "x".repeat(2 * 1024 * 1024);
  let upstreamCalls = 0;

  try {
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({
        id: "resp_1",
        object: "response",
        model: "gpt-4o-mini",
        output: []
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const response = await fetchHandler(makeResponsesRequest({ input: largeInput }), {});
    assert.equal(response.status, 200);
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler still rejects oversized chat completions requests with the standard default limit", { concurrency: false }, async () => {
  const fetchHandler = createFetchHandler({
    getConfig: async () => buildConfig(),
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  const largeContent = "x".repeat(2 * 1024 * 1024);
  let upstreamCalls = 0;

  try {
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const response = await fetchHandler(makeChatCompletionsRequest({
      messages: [
        { role: "user", content: largeContent }
      ]
    }), {});
    assert.equal(response.status, 413);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});
