import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStateStore } from "./state-store.memory.js";
import {
  buildAmpWebSearchSnapshot,
  executeAmpWebSearch
} from "./handler/amp-web-search.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

test("executeAmpWebSearch consumes remaining quota and falls back to the next configured provider", async () => {
  const stateStore = createMemoryStateStore();
  const runtimeConfig = {
    amp: {
      webSearch: {
        strategy: "ordered",
        providers: [
          { id: "brave", apiKey: "brave_test_key", count: 2, limit: 1, remaining: 1 },
          { id: "tavily", apiKey: "tavily_test_key", count: 4, limit: 10, remaining: 10 }
        ]
      }
    }
  };

  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    fetchCalls.push({
      url: normalizedUrl,
      body: init.body ? JSON.parse(String(init.body)) : null
    });
    if (normalizedUrl.startsWith("https://api.search.brave.com/")) {
      return jsonResponse({
        web: {
          results: [
            {
              title: "Brave Result",
              url: "https://example.com/brave",
              description: "Brave search result"
            }
          ]
        }
      });
    }
    if (normalizedUrl === "https://api.tavily.com/search") {
      return jsonResponse({
        results: [
          {
            title: "Tavily Result",
            url: "https://example.com/tavily",
            content: "Tavily search result"
          }
        ]
      });
    }
    throw new Error(`Unexpected fetch: ${normalizedUrl}`);
  };

  try {
    const first = await executeAmpWebSearch("first query", runtimeConfig, {}, { stateStore });
    const second = await executeAmpWebSearch("second query", runtimeConfig, {}, { stateStore });
    const snapshot = await buildAmpWebSearchSnapshot(runtimeConfig, { stateStore });
    const brave = snapshot.providers.find((provider) => provider.id === "brave");
    const tavily = snapshot.providers.find((provider) => provider.id === "tavily");

    assert.equal(first.providerId, "brave");
    assert.equal(second.providerId, "tavily");
    assert.equal(brave?.currentRemaining, 0);
    assert.equal(tavily?.currentRemaining, 9);
    assert.equal(fetchCalls.filter((entry) => entry.url.startsWith("https://api.search.brave.com/")).length, 1);
    assert.equal(fetchCalls.filter((entry) => entry.url === "https://api.tavily.com/search").length, 1);
    assert.match(fetchCalls[0]?.url || "", /count=2/);
    assert.equal(fetchCalls[1]?.body?.max_results, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("executeAmpWebSearch quota-balance routing honors the persisted route cursor", async () => {
  const stateStore = createMemoryStateStore();
  await stateStore.setRouteCursor("route:amp-web-search", 1);
  const runtimeConfig = {
    amp: {
      webSearch: {
        strategy: "quota-balance",
        count: 3,
        providers: [
          { id: "brave", apiKey: "brave_test_key", limit: 1, remaining: 1 },
          { id: "tavily", apiKey: "tavily_test_key", limit: 9, remaining: 9 }
        ]
      }
    }
  };

  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    fetchCalls.push(normalizedUrl);
    if (normalizedUrl === "https://api.tavily.com/search") {
      return jsonResponse({
        results: [
          {
            title: "Tavily Result",
            url: "https://example.com/tavily",
            content: "Tavily search result"
          }
        ]
      });
    }
    if (normalizedUrl.startsWith("https://api.search.brave.com/")) {
      return jsonResponse({
        web: {
          results: [
            {
              title: "Brave Result",
              url: "https://example.com/brave",
              description: "Brave search result"
            }
          ]
        }
      });
    }
    throw new Error(`Unexpected fetch: ${normalizedUrl}`);
  };

  try {
    const result = await executeAmpWebSearch("quota balance query", runtimeConfig, {}, { stateStore });

    assert.equal(result.providerId, "tavily");
    assert.equal(fetchCalls[0], "https://api.tavily.com/search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("executeAmpWebSearch can use hosted GPT provider routes", async () => {
  const stateStore = createMemoryStateStore();
  const runtimeConfig = {
    providers: [
      {
        id: "rc",
        name: "RamClouds",
        baseUrl: "https://ramclouds.me",
        format: "openai",
        formats: ["openai"],
        apiKey: "rc_test_key",
        models: [{ id: "gpt-5.4", formats: ["openai"] }]
      }
    ],
    webSearch: {
      strategy: "ordered",
      count: 5,
      providers: [
        {
          id: "rc/gpt-5.4",
          providerId: "rc",
          model: "gpt-5.4"
        }
      ]
    }
  };

  const originalFetch = globalThis.fetch;
  let capturedRequest = null;
  globalThis.fetch = async (url, init = {}) => {
    capturedRequest = {
      url: String(url),
      body: JSON.parse(String(init.body || "{}"))
    };
    return jsonResponse({
      id: "resp_hosted_search",
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
              text: "Sunrise in Paris today is 7:10 AM according to Time and Date."
            }
          ]
        }
      ]
    });
  };

  try {
    const result = await executeAmpWebSearch("Find the sunrise time in Paris today.", runtimeConfig, {}, { stateStore });
    const snapshot = await buildAmpWebSearchSnapshot(runtimeConfig, { stateStore });
    const hostedProvider = snapshot.providers.find((provider) => provider.id === "rc/gpt-5.4");

    assert.equal(capturedRequest?.url, "https://ramclouds.me/v1/responses");
    assert.equal(capturedRequest?.body?.model, "gpt-5.4");
    assert.equal(capturedRequest?.body?.tools?.[0]?.type, "web_search");
    assert.equal(result.providerId, "rc/gpt-5.4");
    assert.match(result.text, /Sunrise in Paris today/i);
    assert.equal(hostedProvider?.label, "RamClouds · gpt-5.4");
    assert.equal(hostedProvider?.ready, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
