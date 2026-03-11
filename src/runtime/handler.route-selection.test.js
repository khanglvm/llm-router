import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
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

function buildTempPath(name) {
  const unique = `llm-router-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `${name}-${unique}.json`);
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

    const response = await fetchHandler(makeOpenAIRequest("chat.default"), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });
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

    const response = await fetchHandler(makeOpenAIRequest("chat.default"), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });
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

test("smart and default requests return 500 when the fixed default alias is empty", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "default",
    modelAliases: {
      default: {
        id: "default",
        strategy: "ordered",
        targets: [],
        fallbackTargets: []
      }
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  try {
    const defaultResponse = await fetchHandler(makeOpenAIRequest("default"), {});
    assert.equal(defaultResponse.status, 500);
    const defaultPayload = await defaultResponse.json();
    assert.match(defaultPayload?.error?.message || "", /no target candidates configured/i);

    const smartResponse = await fetchHandler(makeOpenAIRequest("smart"), {});
    assert.equal(smartResponse.status, 500);
    const smartPayload = await smartResponse.json();
    assert.match(smartPayload?.error?.message || "", /no target candidates configured/i);
  } finally {
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("smart requests honor the explicit smart alias before the fixed default alias", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "default",
    modelAliases: {
      default: {
        id: "default",
        strategy: "ordered",
        targets: [{ ref: "openrouter/gpt-4o-mini" }],
        fallbackTargets: []
      },
      smart: {
        id: "smart",
        strategy: "ordered",
        targets: [{ ref: "anthropic/claude-3-5-haiku" }],
        fallbackTargets: []
      }
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null
    });
    return claudeSuccess("claude-3-5-haiku");
  };

  try {
    const smartResponse = await fetchHandler(makeOpenAIRequest("smart"), {});
    assert.equal(smartResponse.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.anthropic\.com/);
    assert.equal(calls[0].body?.model, "claude-3-5-haiku");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("worker safe mode auto-disables stateful round-robin progression", { concurrency: false }, async () => {
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

  const fetchHandler = createFetchHandler({
    runtime: "worker",
    workerSafeMode: true,
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: createMemoryStateStore()
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
    assert.deepEqual(upstreamModels, [
      "gpt-4o-mini",
      "gpt-4o-mini"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("worker safe mode bypasses local quota blocking and keeps main route flow", { concurrency: false }, async () => {
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
    runtime: "worker",
    workerSafeMode: true,
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
      calledUrls.push(`${String(url)}:${payload.model}`);
      return openAISuccess(payload.model);
    };

    const response = await fetchHandler(makeOpenAIRequest("chat.default"), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });
    assert.equal(response.status, 200);
    assert.equal(calledUrls.length, 1);
    assert.ok(calledUrls[0].includes("gpt-4o-mini"));
    assert.equal(
      String(response.headers.get("x-llm-router-skipped-candidates") || "").includes("quota-exhausted"),
      false
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("worker runtime coerces file state backend to memory", { concurrency: false }, async () => {
  const stateFilePath = buildTempPath("worker-state-backend");
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
  const fetchHandler = createFetchHandler({
    runtime: "worker",
    workerSafeMode: true,
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      if (String(url).includes("/messages")) {
        return claudeSuccess(payload.model);
      }
      return openAISuccess(payload.model);
    };

    const response = await fetchHandler(makeOpenAIRequest("chat.default"), {
      LLM_ROUTER_WORKER_ALLOW_BEST_EFFORT_STATEFUL_ROUTING: "true",
      LLM_ROUTER_STATE_BACKEND: "file",
      LLM_ROUTER_STATE_FILE_PATH: stateFilePath
    });
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }

  let fileCreated = true;
  try {
    await fs.access(stateFilePath);
  } catch {
    fileCreated = false;
  }
  assert.equal(fileCreated, false);
  await fs.unlink(stateFilePath).catch(() => {});
});


test("live handler returns 500 when the fixed default alias is empty", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "default",
    modelAliases: {
      default: {
        strategy: "ordered",
        targets: [],
        fallbackTargets: []
      }
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  try {
    const smartResponse = await fetchHandler(makeOpenAIRequest("smart"), {});
    assert.equal(smartResponse.status, 500);
    const smartPayload = await smartResponse.json();
    assert.match(smartPayload?.error?.message || "", /no target candidates configured/i);

    const defaultResponse = await fetchHandler(makeOpenAIRequest("default"), {});
    assert.equal(defaultResponse.status, 500);
    const defaultPayload = await defaultResponse.json();
    assert.match(defaultPayload?.error?.message || "", /no target candidates configured/i);
  } finally {
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});
