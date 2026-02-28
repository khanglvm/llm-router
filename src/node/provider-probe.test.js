import test from "node:test";
import assert from "node:assert/strict";
import { probeProviderEndpointMatrix } from "./provider-probe.js";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}

function installFetchMock(t, handler) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = String(init?.method || "GET").toUpperCase();
    let body = null;
    if (typeof init?.body === "string" && init.body.trim()) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    const call = { url, method, body };
    calls.push(call);
    return handler(call);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

test("probeProviderEndpointMatrix ignores /models confirmation and uses real model probe API calls", async (t) => {
  const endpointA = "https://endpoint-a.example/v1";
  const endpointB = "https://endpoint-b.example/v1";
  const calls = installFetchMock(t, ({ url, method, body }) => {
    if (url === `${endpointA}/models` && method === "GET") {
      return jsonResponse({ object: "list", data: [{ id: "gpt-4o" }] });
    }
    if (url === `${endpointB}/models` && method === "GET") {
      return jsonResponse({ object: "list", data: [{ id: "gpt-4o" }] });
    }
    if ((url === `${endpointA}/chat/completions` || url === `${endpointB}/chat/completions`) && method === "POST") {
      if (body?.model === "__llm_router_probe__") {
        return jsonResponse({ error: { message: "model not found" } }, { status: 400 });
      }
      return jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] });
    }
    if ((url === `${endpointA}/messages` || url === `${endpointB}/messages`) && method === "POST") {
      return jsonResponse({ message: "not found" }, { status: 404 });
    }
    return jsonResponse({ error: { message: `unhandled ${method} ${url}` } }, { status: 500 });
  });

  const result = await probeProviderEndpointMatrix({
    endpoints: [endpointA, endpointB],
    models: ["gpt-4o"],
    apiKey: "sk-test"
  });

  assert.equal(result.ok, true);
  assert.equal(result.baseUrlByFormat.openai, endpointA);
  assert.deepEqual(result.models, ["gpt-4o"]);

  const realModelProbeCalls = calls.filter((entry) =>
    entry.method === "POST" &&
    entry.url.endsWith("/chat/completions") &&
    entry.body?.model === "gpt-4o"
  );
  assert.equal(realModelProbeCalls.length, 1);
  assert.equal(realModelProbeCalls[0].url, `${endpointA}/chat/completions`);
});

test("probeProviderEndpointMatrix prioritizes claude->anthropic and gpt->openai candidates", async (t) => {
  const openaiEndpoint = "https://router.example/openai/v1";
  const anthropicEndpoint = "https://router.example/anthropic";
  const calls = installFetchMock(t, ({ url, method, body }) => {
    if (method === "GET" && url.endsWith("/models")) {
      return jsonResponse({ object: "list", data: [] });
    }

    if (method === "POST" && body?.model === "__llm_router_probe__") {
      if (url.includes("/chat/completions")) {
        return jsonResponse({ error: { message: "model not found" } }, { status: 400 });
      }
      if (url.includes("/messages")) {
        return jsonResponse({ type: "error", error: { message: "model not found" } }, { status: 400 });
      }
    }

    if (method === "POST" && body?.model === "claude-3-5-sonnet-latest") {
      if (url === `${anthropicEndpoint}/v1/messages`) {
        return jsonResponse({ type: "message", content: [{ type: "text", text: "ok" }] });
      }
      return jsonResponse({ type: "error", error: { message: "model not found" } }, { status: 404 });
    }

    if (method === "POST" && body?.model === "gpt-4o-mini") {
      if (url === `${openaiEndpoint}/chat/completions`) {
        return jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] });
      }
      return jsonResponse({ error: { message: "model not found" } }, { status: 404 });
    }

    return jsonResponse({ error: { message: `unhandled ${method} ${url}` } }, { status: 500 });
  });

  const result = await probeProviderEndpointMatrix({
    endpoints: [openaiEndpoint, anthropicEndpoint],
    models: ["claude-3-5-sonnet-latest", "gpt-4o-mini"],
    apiKey: "sk-test"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models.sort(), ["claude-3-5-sonnet-latest", "gpt-4o-mini"].sort());

  const modelCalls = calls.filter((entry) => entry.method === "POST" && entry.body?.model && entry.body.model !== "__llm_router_probe__");
  const claudeCalls = modelCalls.filter((entry) => entry.body.model === "claude-3-5-sonnet-latest");
  const gptCalls = modelCalls.filter((entry) => entry.body.model === "gpt-4o-mini");
  assert.ok(claudeCalls.length >= 1);
  assert.ok(gptCalls.length >= 1);
  assert.equal(claudeCalls[0].url, `${anthropicEndpoint}/v1/messages`);
  assert.equal(gptCalls[0].url, `${openaiEndpoint}/chat/completions`);
});

test("probeProviderEndpointMatrix retries 429 responses with wait before succeeding", async (t) => {
  const endpoint = "https://rate-limit.example/v1";
  let modelAttempts = 0;
  const waits = [];
  const progress = [];
  let nowMs = 0;

  installFetchMock(t, ({ url, method, body }) => {
    if (url === `${endpoint}/models` && method === "GET") {
      return jsonResponse({ object: "list", data: [] });
    }
    if (url === `${endpoint}/chat/completions` && method === "POST") {
      if (body?.model === "__llm_router_probe__") {
        return jsonResponse({ error: { message: "model not found" } }, { status: 400 });
      }
      if (body?.model === "gpt-4o") {
        modelAttempts += 1;
        if (modelAttempts === 1) {
          return jsonResponse({ error: { message: "rate limit reached" } }, {
            status: 429,
            headers: { "retry-after": "1" }
          });
        }
        return jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] });
      }
    }
    if (url === `${endpoint}/messages` && method === "POST") {
      return jsonResponse({ message: "not found" }, { status: 404 });
    }
    return jsonResponse({ error: { message: `unhandled ${method} ${url}` } }, { status: 500 });
  });

  const result = await probeProviderEndpointMatrix({
    endpoints: [endpoint],
    models: ["gpt-4o"],
    apiKey: "sk-test",
    requestsPerMinute: 120,
    maxRateLimitRetries: 3,
    now: () => nowMs,
    sleep: async (ms) => {
      waits.push(ms);
      nowMs += ms;
    },
    onProgress: (event) => progress.push(event)
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ["gpt-4o"]);
  assert.equal(result.rateLimitFailures.length, 0);
  assert.equal(modelAttempts, 2);
  assert.ok(waits.some((ms) => ms >= 1000));
  assert.ok(progress.some((event) => event.phase === "rate-limit-wait" && event.reason === "rate-limit"));
});

test("probeProviderEndpointMatrix reports partial failure when rate-limit retries are exhausted", async (t) => {
  const endpoint = "https://rate-limit-hard.example/v1";
  let modelAttempts = 0;

  installFetchMock(t, ({ url, method, body }) => {
    if (url === `${endpoint}/models` && method === "GET") {
      return jsonResponse({ object: "list", data: [] });
    }
    if (url === `${endpoint}/chat/completions` && method === "POST") {
      if (body?.model === "__llm_router_probe__") {
        return jsonResponse({ error: { message: "model not found" } }, { status: 400 });
      }
      if (body?.model === "gpt-4o") {
        modelAttempts += 1;
        return jsonResponse({ error: { message: "too many requests" } }, {
          status: 429,
          headers: { "retry-after": "1" }
        });
      }
    }
    if (url === `${endpoint}/messages` && method === "POST") {
      return jsonResponse({ message: "not found" }, { status: 404 });
    }
    return jsonResponse({ error: { message: `unhandled ${method} ${url}` } }, { status: 500 });
  });

  let nowMs = 0;
  const result = await probeProviderEndpointMatrix({
    endpoints: [endpoint],
    models: ["gpt-4o"],
    apiKey: "sk-test",
    requestsPerMinute: 120,
    maxRateLimitRetries: 2,
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureScope, "partial");
  assert.equal(result.manualFallbackRecommended, true);
  assert.deepEqual(result.unresolvedModels, ["gpt-4o"]);
  assert.equal(result.rateLimitFailures.length, 1);
  assert.ok((result.workingFormats || []).includes("openai"));
  assert.equal(modelAttempts, 3);
});
