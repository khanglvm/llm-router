import test from "node:test";
import assert from "node:assert/strict";
import { FORMATS } from "../translator/index.js";
import { createFetchHandler } from "./handler.js";
import { normalizeRuntimeConfig, resolveRequestModel } from "./config.js";
import { getApplicableRateLimitBuckets } from "./rate-limits.js";
import { createMemoryStateStore } from "./state-store.memory.js";

function buildConfig(raw = {}) {
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
          {
            id: "gpt-4o-mini",
            fallbackModels: ["anthropic/claude-3-5-haiku"]
          }
        ]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [
          { id: "claude-3-5-haiku" }
        ]
      }
    ],
    ...raw
  });
}

function makeOpenAIRequest(model) {
  return new Request("http://router.local/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "user", content: "Hello" }
      ],
      stream: false
    })
  });
}

function makeAmpAnthropicRequest(model, options = {}) {
  const body = {
    model,
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" }
        ]
      }
    ],
    stream: false
  };
  if (typeof options.mode === "string" && options.mode.trim()) {
    body.mode = options.mode.trim();
  }
  if (typeof options.agent === "string" && options.agent.trim()) {
    body.agent = options.agent.trim();
  }
  return new Request("http://router.local/api/provider/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-amp-client-application": options.application || "CLI",
      ...(options.headers || {})
    },
    body: JSON.stringify(body)
  });
}

function makeAmpGoogleGenerateContentRequest(model = "gemini-3-pro-preview") {
  return new Request(`http://router.local/api/provider/google/v1beta1/publishers/google/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-amp-client-application": "CLI"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: "Hello from gemini payload" }]
        }
      ],
      systemInstruction: {
        parts: [{ text: "Be concise." }]
      },
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 128
      }
    })
  });
}

function makeAmpOpenAIResponsesRequest(model, options = {}) {
  return new Request("http://router.local/api/provider/openai/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-amp-client-application": options.application || "CLI Execute Mode",
      ...(options.headers || {})
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Hello" }
          ]
        }
      ],
      stream: false
    })
  });
}

function jsonPayloadResponse(payload, status = 200, headers = undefined) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers || {})
    }
  });
}

function claudeSuccess(model = "claude-3-5-haiku") {
  return jsonPayloadResponse({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1
    }
  });
}

function openAISuccess(model = "gpt-4o-mini") {
  return jsonPayloadResponse({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2
    }
  });
}

async function withMockedNow(now, fn) {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}

test("alias route executes via live handler and round-robins targets", { concurrency: false }, async () => {
  const config = buildConfig({
    modelAliases: {
      "chat.default": {
        strategy: "round-robin",
        targets: [
          { ref: "openrouter/gpt-4o-mini" },
          { ref: "anthropic/claude-3-5-haiku" }
        ]
      }
    }
  });
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const upstreamModels = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      upstreamModels.push(payload.model);
      if (String(url).includes("/messages")) {
        return claudeSuccess(payload.model);
      }
      return openAISuccess(payload.model);
    };

    const first = await fetchHandler(makeOpenAIRequest("chat.default"), {});
    const second = await fetchHandler(makeOpenAIRequest("chat.default"), {});
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers.get("x-llm-router-route-type"), null);
    assert.deepEqual(upstreamModels, [
      "gpt-4o-mini",
      "claude-3-5-haiku"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("amp anthropic provider path routes through amp model mapping", { concurrency: false }, async () => {
  const config = buildConfig({
    ampRouting: {
      enabled: true,
      modelMap: {
        "claude-haiku-4-5-20251001": "openrouter/gpt-4o-mini"
      }
    }
  });
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const called = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      called.push({ url: String(url), payload });
      return openAISuccess(payload.model);
    };

    const response = await fetchHandler(makeAmpAnthropicRequest("claude-haiku-4-5-20251001"), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(called.length, 1);
    assert.ok(called[0].url.includes("/chat/completions"));
    assert.equal(called[0].payload.model, "gpt-4o-mini");
    assert.equal(response.headers.get("x-llm-router-amp-detected"), "true");
    assert.equal(response.headers.get("x-llm-router-amp-matched-by"), "model");
    assert.equal(payload.type, "message");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("amp anthropic provider path falls back to router default route when unmapped", { concurrency: false }, async () => {
  const config = buildConfig();
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const called = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      called.push({ url: String(url), payload });
      return openAISuccess(payload.model);
    };

    const response = await fetchHandler(makeAmpAnthropicRequest("claude-haiku-4-5-20251001"), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });

    assert.equal(response.status, 200);
    assert.equal(called.length, 1);
    assert.ok(called[0].url.includes("/chat/completions"));
    assert.equal(called[0].payload.model, "gpt-4o-mini");
    assert.equal(response.headers.get("x-llm-router-amp-detected"), "true");
    assert.equal(response.headers.get("x-llm-router-amp-matched-by"), "fallback");
    assert.equal(response.headers.get("x-llm-router-amp-matched-ref"), "smart");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("amp internal getUserInfo returns json-rpc envelope", { concurrency: false }, async () => {
  const config = buildConfig();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: createMemoryStateStore()
  });

  try {
    const response = await fetchHandler(new Request("http://router.local/api/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amp-client-application": "CLI"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getUserInfo",
        params: {}
      })
    }), {});

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.jsonrpc, "2.0");
    assert.equal(payload.id, 1);
    assert.equal(payload.result?.name, "llm-router");
    assert.deepEqual(payload.result?.features, []);
  } finally {
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("amp internal getUserInfo returns result envelope for plain rpc", { concurrency: false }, async () => {
  const config = buildConfig();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: createMemoryStateStore()
  });

  try {
    const response = await fetchHandler(new Request("http://router.local/api/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amp-client-application": "CLI Execute Mode"
      },
      body: JSON.stringify({
        method: "getUserInfo",
        params: {}
      })
    }), {});

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload?.ok, true);
    assert.equal(payload?.result?.name, "llm-router");
    assert.equal(payload?.result?.authenticated, true);
    assert.deepEqual(payload?.result?.features, []);
    assert.equal(payload?.jsonrpc, undefined);
    assert.equal(payload?.id, undefined);
  } finally {
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("amp internal getUserFreeTierStatus returns stable boolean shape", { concurrency: false }, async () => {
  const config = buildConfig();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: createMemoryStateStore()
  });

  try {
    const response = await fetchHandler(new Request("http://router.local/api/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amp-client-application": "CLI Execute Mode"
      },
      body: JSON.stringify({
        method: "getUserFreeTierStatus",
        params: {}
      })
    }), {});

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload?.ok, true);
    assert.equal(payload?.result?.canUseAmpFree, false);
    assert.equal(payload?.result?.isDailyGrantEnabled, false);
    assert.deepEqual(payload?.result?.features, []);
  } finally {
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("amp internal uploadThread/setThreadMeta return ack payloads", { concurrency: false }, async () => {
  const config = buildConfig();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: createMemoryStateStore()
  });

  try {
    const uploadResponse = await fetchHandler(new Request("http://router.local/api/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amp-client-application": "CLI Execute Mode"
      },
      body: JSON.stringify({
        method: "uploadThread",
        params: {
          thread: {
            id: "T-test",
            v: 7
          },
          createdOnServer: false
        }
      })
    }), {});
    const uploadPayload = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200);
    assert.equal(uploadPayload?.ok, true);
    assert.equal(uploadPayload?.result?.uploaded, true);
    assert.equal(uploadPayload?.result?.threadId, "T-test");
    assert.equal(uploadPayload?.result?.version, 7);

    const metaResponse = await fetchHandler(new Request("http://router.local/api/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amp-client-application": "CLI Execute Mode"
      },
      body: JSON.stringify({
        method: "setThreadMeta",
        params: {
          thread: "T-test",
          meta: {
            visibility: "private"
          }
        }
      })
    }), {});
    const metaPayload = await metaResponse.json();
    assert.equal(metaResponse.status, 200);
    assert.equal(metaPayload?.ok, true);
    assert.equal(metaPayload?.result?.updated, true);
    assert.equal(metaPayload?.result?.threadId, "T-test");
  } finally {
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("amp google generateContent request is bridged through routing and returned as gemini shape", { concurrency: false }, async () => {
  const config = buildConfig();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: createMemoryStateStore()
  });

  const originalFetch = globalThis.fetch;
  const called = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      called.push({ url: String(url), payload });
      return openAISuccess(payload.model);
    };

    const response = await fetchHandler(makeAmpGoogleGenerateContentRequest(), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(called.length, 1);
    assert.ok(called[0].url.includes("/chat/completions"));
    assert.equal(called[0].payload.model, "gpt-4o-mini");
    assert.ok(Array.isArray(payload.candidates));
    assert.equal(payload.candidates[0]?.content?.parts?.[0]?.text, "ok");
    assert.equal(response.headers.get("x-llm-router-amp-detected"), "true");
    assert.equal(response.headers.get("x-llm-router-amp-matched-by"), "fallback");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("amp openai responses path preserves responses upstream endpoint", { concurrency: false }, async () => {
  const config = buildConfig({
    ampRouting: {
      enabled: true,
      modeMap: {
        deep: "openrouter/gpt-4o-mini"
      }
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: createMemoryStateStore()
  });

  const originalFetch = globalThis.fetch;
  const called = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      called.push({ url: String(url), payload });
      return openAISuccess(payload.model);
    };

    const response = await fetchHandler(makeAmpOpenAIResponsesRequest("gpt-5.3-codex", {
      headers: {
        "x-amp-mode": "deep"
      }
    }), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });

    assert.equal(response.status, 200);
    assert.equal(called.length, 1);
    assert.ok(called[0].url.endsWith("/responses"));
    assert.equal(called[0].payload.model, "gpt-4o-mini");
    assert.equal(response.headers.get("x-llm-router-amp-matched-by"), "mode");
    assert.equal(response.headers.get("x-llm-router-amp-matched-ref"), "openrouter/gpt-4o-mini");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("amp provider path supports mode-based mapping", { concurrency: false }, async () => {
  const config = buildConfig({
    ampRouting: {
      enabled: true,
      modeMap: {
        smart: "anthropic/claude-3-5-haiku"
      }
    }
  });
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const called = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      called.push({ url: String(url), payload });
      if (String(url).includes("/messages")) {
        return claudeSuccess(payload.model);
      }
      return openAISuccess(payload.model);
    };

    const response = await fetchHandler(makeAmpAnthropicRequest("claude-haiku-4-5-20251001", {
      mode: "smart"
    }), { LLM_ROUTER_DEBUG_ROUTING: "true" });

    assert.equal(response.status, 200);
    assert.equal(called.length, 1);
    assert.ok(called[0].url.includes("/messages"));
    assert.equal(called[0].payload.model, "claude-3-5-haiku");
    assert.equal(response.headers.get("x-llm-router-amp-mode"), "smart");
    assert.equal(response.headers.get("x-llm-router-amp-matched-by"), "mode");
    assert.equal(response.headers.get("x-llm-router-amp-matched-ref"), "anthropic/claude-3-5-haiku");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("amp provider path supports agent-based mapping", { concurrency: false }, async () => {
  const config = buildConfig({
    ampRouting: {
      enabled: true,
      agentMap: {
        review: "anthropic/claude-3-5-haiku"
      }
    }
  });
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const called = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      called.push({ url: String(url), payload });
      if (String(url).includes("/messages")) {
        return claudeSuccess(payload.model);
      }
      return openAISuccess(payload.model);
    };

    const response = await fetchHandler(makeAmpAnthropicRequest("claude-haiku-4-5-20251001", {
      agent: "review"
    }), { LLM_ROUTER_DEBUG_ROUTING: "true" });

    assert.equal(response.status, 200);
    assert.equal(called.length, 1);
    assert.ok(called[0].url.includes("/messages"));
    assert.equal(called[0].payload.model, "claude-3-5-haiku");
    assert.equal(response.headers.get("x-llm-router-amp-agent"), "review");
    assert.equal(response.headers.get("x-llm-router-amp-matched-by"), "agent");
    assert.equal(response.headers.get("x-llm-router-amp-matched-ref"), "anthropic/claude-3-5-haiku");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("amp agent-mode map has precedence over mode and agent maps", { concurrency: false }, async () => {
  const config = buildConfig({
    ampRouting: {
      enabled: true,
      modeMap: {
        smart: "openrouter/gpt-4o-mini"
      },
      agentMap: {
        review: "openrouter/gpt-4o-mini"
      },
      agentModeMap: {
        review: {
          smart: "anthropic/claude-3-5-haiku"
        }
      }
    }
  });
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const called = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      called.push({ url: String(url), payload });
      if (String(url).includes("/messages")) {
        return claudeSuccess(payload.model);
      }
      return openAISuccess(payload.model);
    };

    const response = await fetchHandler(makeAmpAnthropicRequest("claude-haiku-4-5-20251001", {
      mode: "smart",
      agent: "review"
    }), { LLM_ROUTER_DEBUG_ROUTING: "true" });

    assert.equal(response.status, 200);
    assert.equal(called.length, 1);
    assert.ok(called[0].url.includes("/messages"));
    assert.equal(called[0].payload.model, "claude-3-5-haiku");
    assert.equal(response.headers.get("x-llm-router-amp-matched-by"), "agent-mode");
    assert.equal(response.headers.get("x-llm-router-amp-matched-ref"), "anthropic/claude-3-5-haiku");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("preflight exhausted bucket skips candidate before provider call", { concurrency: false }, async () => {
  const now = Date.UTC(2026, 1, 28, 16, 0, 0);
  const config = buildConfig({
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }],
        rateLimits: [
          {
            id: "openrouter-day",
            models: ["all"],
            requests: 1,
            window: { unit: "day", size: 1 }
          }
        ]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ],
    modelAliases: {
      "chat.default": {
        strategy: "ordered",
        targets: [
          { ref: "openrouter/gpt-4o-mini" },
          { ref: "anthropic/claude-3-5-haiku" }
        ]
      }
    }
  });
  const store = createMemoryStateStore();
  const route = resolveRequestModel(config, "chat.default", FORMATS.OPENAI);
  const buckets = getApplicableRateLimitBuckets(config, route.primary, now);
  await store.incrementBucketUsage(
    buckets[0].bucketKey,
    buckets[0].windowKey,
    1,
    { now, expiresAt: buckets[0].window.endsAt }
  );

  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const calledUrls = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      calledUrls.push(String(url));
      if (String(url).includes("/messages")) {
        return claudeSuccess(payload.model);
      }
      return openAISuccess(payload.model);
    };

    const response = await withMockedNow(now, () => fetchHandler(makeOpenAIRequest("chat.default"), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    }));
    assert.equal(response.status, 200);
    assert.equal(calledUrls.length, 1);
    assert.ok(calledUrls[0].includes("/messages"));
    assert.ok(
      String(response.headers.get("x-llm-router-skipped-candidates") || "")
        .includes("quota-exhausted")
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("combined buckets apply with AND logic in live handler routing", { concurrency: false }, async () => {
  const now = Date.UTC(2026, 1, 28, 16, 0, 0);
  const config = buildConfig({
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }],
        rateLimits: [
          {
            id: "openrouter-minute",
            name: "Minute cap",
            models: ["all"],
            requests: 40,
            window: { unit: "minute", size: 1 }
          },
          {
            id: "openrouter-6-hours",
            name: "6-hours cap",
            models: ["all"],
            requests: 600,
            window: { unit: "hour", size: 6 }
          }
        ]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ],
    modelAliases: {
      "chat.default": {
        strategy: "ordered",
        targets: [
          { ref: "openrouter/gpt-4o-mini" },
          { ref: "anthropic/claude-3-5-haiku" }
        ]
      }
    }
  });
  const store = createMemoryStateStore();
  const route = resolveRequestModel(config, "chat.default", FORMATS.OPENAI);
  const buckets = getApplicableRateLimitBuckets(config, route.primary, now);
  const minuteBucket = buckets.find((bucket) => bucket.bucketId === "openrouter-minute");
  const sixHourBucket = buckets.find((bucket) => bucket.bucketId === "openrouter-6-hours");
  assert.ok(minuteBucket);
  assert.ok(sixHourBucket);

  await store.incrementBucketUsage(
    minuteBucket.bucketKey,
    minuteBucket.windowKey,
    40,
    { now, expiresAt: minuteBucket.window.endsAt }
  );
  await store.incrementBucketUsage(
    sixHourBucket.bucketKey,
    sixHourBucket.windowKey,
    200,
    { now, expiresAt: sixHourBucket.window.endsAt }
  );

  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const calledUrls = [];
  try {
    Date.now = () => now;
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      calledUrls.push(String(url));
      if (String(url).includes("/messages")) {
        return claudeSuccess(payload.model);
      }
      return openAISuccess(payload.model);
    };

    const response = await withMockedNow(now, () => fetchHandler(makeOpenAIRequest("chat.default"), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    }));
    assert.equal(response.status, 200);
    assert.equal(calledUrls.length, 1);
    assert.ok(calledUrls[0].includes("/messages"));
    assert.ok(
      String(response.headers.get("x-llm-router-skipped-candidates") || "")
        .includes("quota-exhausted")
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("direct provider/model requests keep fallbackModels order", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "openrouter/gpt-4o-mini"
  });
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const upstreamModels = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      upstreamModels.push(payload.model);
      if (upstreamModels.length === 1) {
        return jsonPayloadResponse({
          error: {
            message: "upstream temporary failure"
          }
        }, 500);
      }
      return claudeSuccess(payload.model);
    };

    const response = await fetchHandler(makeOpenAIRequest("openrouter/gpt-4o-mini"), {
      LLM_ROUTER_ORIGIN_RETRY_ATTEMPTS: "1"
    });
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamModels, [
      "gpt-4o-mini",
      "claude-3-5-haiku"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});
