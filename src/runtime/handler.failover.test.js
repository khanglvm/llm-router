import test from "node:test";
import assert from "node:assert/strict";
import { createFetchHandler } from "./handler.js";
import { normalizeRuntimeConfig, resolveRequestModel } from "./config.js";
import { buildCandidateKey } from "./state-store.js";
import { createMemoryStateStore } from "./state-store.memory.js";

function buildConfig(raw = {}) {
  return normalizeRuntimeConfig({
    version: 2,
    defaultModel: "chat.default",
    modelAliases: {
      "chat.default": {
        strategy: "ordered",
        targets: [
          { ref: "openrouter/gpt-4o-mini" },
          { ref: "anthropic/claude-3-5-haiku" }
        ]
      }
    },
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ],
    ...raw
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

function makeOpenAIRequest(model, {
  stream = false,
  headers = undefined,
  bodyOverrides = undefined
} = {}) {
  const payload = {
    model,
    messages: [{ role: "user", content: "Hello" }],
    stream,
    ...(bodyOverrides || {})
  };

  return new Request("http://router.local/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(headers || {})
    },
    body: JSON.stringify(payload)
  });
}

function makeClaudeRequest(model, {
  headers = undefined,
  bodyOverrides = undefined
} = {}) {
  const payload = {
    model,
    max_tokens: 128,
    messages: [{ role: "user", content: "Hello" }],
    ...(bodyOverrides || {})
  };

  return new Request("http://router.local/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(headers || {})
    },
    body: JSON.stringify(payload)
  });
}

test("provider 429 applies cooldown and next request de-prioritizes that candidate", { concurrency: false }, async () => {
  const config = buildConfig();
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const route = resolveRequestModel(config, "chat.default", "openai");
  const openrouterCandidateKey = buildCandidateKey(route.primary);

  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    let openrouterFailures = 0;
    globalThis.fetch = async (url, init) => {
      const target = String(url).includes("openrouter")
        ? "openrouter"
        : "anthropic";
      const payload = JSON.parse(String(init?.body || "{}"));
      calls.push(`${target}:${payload.model}`);

      if (target === "openrouter" && openrouterFailures === 0) {
        openrouterFailures += 1;
        return jsonPayloadResponse({
          error: { message: "rate limit" }
        }, 429, {
          "retry-after": "60"
        });
      }

      if (target === "anthropic") {
        return claudeSuccess(payload.model);
      }
      return openAISuccess(payload.model);
    };

    const first = await fetchHandler(makeOpenAIRequest("chat.default"), {});
    const second = await fetchHandler(makeOpenAIRequest("chat.default"), {});
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    assert.deepEqual(calls, [
      "openrouter:gpt-4o-mini",
      "anthropic:claude-3-5-haiku",
      "anthropic:claude-3-5-haiku"
    ]);

    const candidateState = await store.getCandidateState(openrouterCandidateKey);
    assert.ok(candidateState?.cooldownUntil > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("auth failure can fall through to next provider", { concurrency: false }, async () => {
  const config = buildConfig();
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      calls.push(payload.model);
      if (calls.length === 1) {
        return jsonPayloadResponse({
          error: { message: "invalid api key" }
        }, 401);
      }
      return claudeSuccess(payload.model);
    };

    const response = await fetchHandler(makeOpenAIRequest("chat.default"), {
      LLM_ROUTER_ORIGIN_RETRY_ATTEMPTS: "1"
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
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

test("invalid request short-circuits without fallback fan-out", { concurrency: false }, async () => {
  const config = buildConfig();
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  let callCount = 0;
  try {
    globalThis.fetch = async () => {
      callCount += 1;
      return jsonPayloadResponse({
        error: { message: "bad request" }
      }, 400);
    };

    const response = await fetchHandler(makeOpenAIRequest("chat.default"), {
      LLM_ROUTER_ORIGIN_RETRY_ATTEMPTS: "1"
    });
    assert.equal(response.status, 400);
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("alias fallback targets are used when alias primaries fail", { concurrency: false }, async () => {
  const config = buildConfig({
    modelAliases: {
      "chat.default": {
        strategy: "ordered",
        targets: [{ ref: "openrouter/gpt-4o-mini" }],
        fallbackTargets: [{ ref: "anthropic/claude-3-5-haiku" }]
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
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      calls.push(payload.model);
      if (calls.length === 1) {
        return jsonPayloadResponse({
          error: { message: "temporary failure" }
        }, 500);
      }
      return claudeSuccess(payload.model);
    };

    const response = await fetchHandler(makeOpenAIRequest("chat.default"), {
      LLM_ROUTER_ORIGIN_RETRY_ATTEMPTS: "1"
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
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

test("streaming request through alias route works", { concurrency: false }, async () => {
  const config = buildConfig({
    modelAliases: {
      "chat.default": {
        strategy: "ordered",
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
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
  try {
    globalThis.fetch = async () => new Response("data: {\"id\":\"1\"}\n\ndata: [DONE]\n\n", {
      status: 200,
      headers: {
        "content-type": "text/event-stream"
      }
    });

    const response = await fetchHandler(makeOpenAIRequest("chat.default", { stream: true }), {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const payload = await response.text();
    assert.ok(payload.includes("[DONE]"));
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("format translation works through alias routes (OpenAI<->Claude)", { concurrency: false }, async () => {
  const openAItoClaudeConfig = buildConfig({
    modelAliases: {
      "chat.default": {
        strategy: "ordered",
        targets: [{ ref: "anthropic/claude-3-5-haiku" }]
      }
    }
  });
  const claudeToOpenAIConfig = buildConfig({
    modelAliases: {
      "chat.default": {
        strategy: "ordered",
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      }
    }
  });

  const openAItoClaudeStore = createMemoryStateStore();
  const claudeToOpenAIStore = createMemoryStateStore();
  const openAItoClaudeHandler = createFetchHandler({
    getConfig: async () => openAItoClaudeConfig,
    ignoreAuth: true,
    stateStore: openAItoClaudeStore
  });
  const claudeToOpenAIHandler = createFetchHandler({
    getConfig: async () => claudeToOpenAIConfig,
    ignoreAuth: true,
    stateStore: claudeToOpenAIStore
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      if (String(url).includes("/messages")) {
        assert.equal(payload.model, "claude-3-5-haiku");
        return claudeSuccess(payload.model);
      }

      assert.equal(payload.model, "gpt-4o-mini");
      return openAISuccess(payload.model);
    };

    const openAIResponse = await openAItoClaudeHandler(makeOpenAIRequest("chat.default"), {});
    assert.equal(openAIResponse.status, 200);
    const openAIJson = await openAIResponse.json();
    assert.equal(openAIJson.object, "chat.completion");

    const claudeResponse = await claudeToOpenAIHandler(makeClaudeRequest("chat.default"), {});
    assert.equal(claudeResponse.status, 200);
    const claudeJson = await claudeResponse.json();
    assert.equal(claudeJson.type, "message");
    assert.equal(claudeJson.role, "assistant");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof openAItoClaudeHandler.close === "function") {
      await openAItoClaudeHandler.close();
    }
    if (typeof claudeToOpenAIHandler.close === "function") {
      await claudeToOpenAIHandler.close();
    }
  }
});

test("openai->claude translation preserves cache directives and forwards caching beta header", { concurrency: false }, async () => {
  const config = buildConfig({
    modelAliases: {
      "chat.default": {
        strategy: "ordered",
        targets: [{ ref: "anthropic/claude-3-5-haiku" }]
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
  const upstreamCalls = [];
  try {
    globalThis.fetch = async (url, init) => {
      upstreamCalls.push({
        url: String(url),
        headers: init?.headers || {},
        payload: JSON.parse(String(init?.body || "{}"))
      });
      return claudeSuccess("claude-3-5-haiku");
    };

    const response = await fetchHandler(makeOpenAIRequest("chat.default", {
      headers: {
        "anthropic-beta": "prompt-caching-2024-07-31"
      },
      bodyOverrides: {
        prompt_cache_key: "session-123",
        prompt_cache_retention: "24h",
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Lookup tool",
              parameters: { type: "object", properties: {} }
            },
            cache_control: { type: "ephemeral" }
          }
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Hello",
                cache_control: { type: "ephemeral" }
              }
            ]
          }
        ]
      }
    }), {});
    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.ok(upstreamCalls[0].url.includes("/messages"));
    assert.deepEqual(upstreamCalls[0].payload.cache_control, {
      type: "ephemeral",
      ttl: "1h"
    });
    assert.deepEqual(upstreamCalls[0].payload.messages[0].content[0].cache_control, {
      type: "ephemeral"
    });
    assert.deepEqual(upstreamCalls[0].payload.tools[0].cache_control, {
      type: "ephemeral"
    });
    assert.ok(String(upstreamCalls[0].headers["anthropic-beta"] || "").includes("prompt-caching-2024-07-31"));
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("claude->openai translation maps cache control to openai prompt caching fields", { concurrency: false }, async () => {
  const config = buildConfig({
    modelAliases: {},
    defaultModel: "openrouter/gpt-5-codex",
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-5-codex" }]
      }
    ]
  });
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  try {
    globalThis.fetch = async (url, init) => {
      upstreamBodies.push({
        url: String(url),
        payload: JSON.parse(String(init?.body || "{}"))
      });
      return openAISuccess("gpt-5-codex");
    };

    const response = await fetchHandler(makeClaudeRequest("openrouter/gpt-5-codex", {
      bodyOverrides: {
        cache_control: { type: "ephemeral", ttl: "1h" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Hello",
                cache_control: { type: "ephemeral" }
              }
            ]
          }
        ]
      }
    }), {});
    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.ok(upstreamBodies[0].url.includes("/chat/completions"));
    assert.equal(upstreamBodies[0].payload.prompt_cache_retention, "in_memory");
    assert.ok(String(upstreamBodies[0].payload.prompt_cache_key || "").startsWith("llm-router:"));
    assert.deepEqual(upstreamBodies[0].payload.messages[0].content[0].cache_control, {
      type: "ephemeral"
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("direct openai requests preserve native prompt caching fields", { concurrency: false }, async () => {
  const config = buildConfig({
    modelAliases: {},
    defaultModel: "openrouter/gpt-4o-mini",
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }]
      }
    ]
  });
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  try {
    globalThis.fetch = async (url, init) => {
      upstreamBodies.push({
        url: String(url),
        payload: JSON.parse(String(init?.body || "{}"))
      });
      return openAISuccess("gpt-4o-mini");
    };

    const response = await fetchHandler(makeOpenAIRequest("openrouter/gpt-4o-mini", {
      bodyOverrides: {
        prompt_cache_key: "user-supplied-cache-key",
        prompt_cache_retention: "24h"
      }
    }), {});
    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0].payload.prompt_cache_key, "user-supplied-cache-key");
    assert.equal(upstreamBodies[0].payload.prompt_cache_retention, "24h");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("direct claude->openai routing maps Claude Code reasoning headers to target-model effort shape", { concurrency: false }, async () => {
  const config = buildConfig({
    modelAliases: {},
    defaultModel: "openrouter/gpt-5-codex",
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-5-codex" }]
      }
    ]
  });
  const store = createMemoryStateStore();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true,
    stateStore: store
  });

  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      upstreamBodies.push({
        url: String(url),
        payload
      });
      return openAISuccess(payload.model);
    };

    const response = await fetchHandler(makeClaudeRequest("openrouter/gpt-5-codex", {
      headers: {
        "x-claude-code-thinking-mode": "ultrathink"
      }
    }), {});
    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.ok(upstreamBodies[0].url.includes("/chat/completions"));
    assert.equal(upstreamBodies[0].payload.model, "gpt-5-codex");
    assert.deepEqual(upstreamBodies[0].payload.reasoning, { effort: "high" });
    assert.equal(upstreamBodies[0].payload.reasoning_effort, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

for (const modelId of ["gpt-5.2-codex", "gpt-5.3-codex"]) {
  test(`direct claude->openai preserves xhigh effort for ${modelId}`, { concurrency: false }, async () => {
    const config = buildConfig({
      modelAliases: {},
      defaultModel: `openrouter/${modelId}`,
      providers: [
        {
          id: "openrouter",
          name: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          format: "openai",
          models: [{ id: modelId }]
        }
      ]
    });
    const store = createMemoryStateStore();
    const fetchHandler = createFetchHandler({
      getConfig: async () => config,
      ignoreAuth: true,
      stateStore: store
    });

    const originalFetch = globalThis.fetch;
    const upstreamBodies = [];
    try {
      globalThis.fetch = async (url, init) => {
        const payload = JSON.parse(String(init?.body || "{}"));
        upstreamBodies.push({
          url: String(url),
          payload
        });
        return openAISuccess(payload.model);
      };

      const response = await fetchHandler(makeClaudeRequest(`openrouter/${modelId}`, {
        headers: {
          "x-claude-code-thinking-mode": "extra high"
        }
      }), {});
      assert.equal(response.status, 200);
      assert.equal(upstreamBodies.length, 1);
      assert.ok(upstreamBodies[0].url.includes("/chat/completions"));
      assert.equal(upstreamBodies[0].payload.model, modelId);
      assert.deepEqual(upstreamBodies[0].payload.reasoning, { effort: "xhigh" });
      assert.equal(upstreamBodies[0].payload.reasoning_effort, undefined);
    } finally {
      globalThis.fetch = originalFetch;
      if (typeof fetchHandler.close === "function") {
        await fetchHandler.close();
      }
    }
  });
}

test("alias round-robin remaps effort to each final routed model format", { concurrency: false }, async () => {
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
  const upstreamBodies = [];
  try {
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      upstreamBodies.push({
        url: String(url),
        payload
      });
      if (String(url).includes("/messages")) {
        return claudeSuccess(payload.model);
      }
      return openAISuccess(payload.model);
    };

    const first = await fetchHandler(makeOpenAIRequest("chat.default", {
      bodyOverrides: {
        reasoning_effort: "high",
        max_tokens: 4096
      }
    }), {});
    const second = await fetchHandler(makeOpenAIRequest("chat.default", {
      bodyOverrides: {
        reasoning_effort: "high",
        max_tokens: 4096
      }
    }), {});

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(upstreamBodies.length, 2);

    assert.ok(upstreamBodies[0].url.includes("/chat/completions"));
    assert.equal(upstreamBodies[0].payload.reasoning_effort, "high");

    assert.ok(upstreamBodies[1].url.includes("/messages"));
    assert.equal(upstreamBodies[1].payload.model, "claude-3-5-haiku");
    assert.deepEqual(upstreamBodies[1].payload.thinking, {
      type: "enabled",
      budget_tokens: 3072
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});
