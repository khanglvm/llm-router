import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { createFetchHandler } from "./handler.js";
import { normalizeRuntimeConfig } from "./config.js";
import { inferAmpContextRequirement, isAmpManagementPath, resolveApiRoute } from "./handler/request.js";
import { maybeRewriteAmpClientResponse } from "./handler/amp-response.js";

function buildConfig(overrides = {}) {
  return normalizeRuntimeConfig({
    version: 2,
    masterKey: "gw_amp_key",
    defaultModel: "openrouter/gpt-4o-mini",
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }]
      }
    ],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key"
    },
    ...overrides
  });
}

function jsonResponse(payload, status = 200, headers = undefined) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers || {})
    }
  });
}

function sseResponse(events) {
  return new Response(events.join(""), {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  });
}

function getHeaderMap(headersLike) {
  const headers = new Headers(headersLike || {});
  return Object.fromEntries(headers.entries());
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

async function readInitJsonBody(init = {}) {
  if (init.body === undefined || init.body === null || init.body === "") {
    return {};
  }
  const raw = await new Response(init.body).text();
  return JSON.parse(raw || "{}");
}

function parseSsePayloads(raw) {
  return String(raw || "")
    .split(/\n\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^data:\s*/, ""))
    .filter((entry) => entry && entry !== "[DONE]")
    .map((entry) => JSON.parse(entry));
}

function parseSseEvents(raw) {
  return String(raw || "")
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event = "";
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      const payloadText = dataLines.join("\n").trim();
      return {
        event,
        payload: payloadText ? JSON.parse(payloadText) : null
      };
    });
}

test("resolveApiRoute recognizes AMP provider routes and management paths", () => {
  const openAIRoute = resolveApiRoute("/api/provider/openai/v1/chat/completions", "POST");
  const claudeRoute = resolveApiRoute("/api/provider/anthropic/v1/messages", "POST");
  const responsesRoute = resolveApiRoute("/api/provider/openai/v1/responses", "POST");
  const geminiRoute = resolveApiRoute("/api/provider/google/v1beta/models/gemini-2.5-pro:streamGenerateContent", "POST");
  const publishersRoute = resolveApiRoute("/publishers/google/models/gemini-2.5-pro:generateContent", "POST");

  assert.equal(openAIRoute?.clientType, "amp");
  assert.equal(openAIRoute?.requestKind, "chat-completions");
  assert.equal(claudeRoute?.sourceFormat, "claude");
  assert.equal(responsesRoute?.requestKind, "responses");
  assert.equal(geminiRoute?.type, "amp-gemini");
  assert.equal(geminiRoute?.streamHint, true);
  assert.equal(publishersRoute?.type, "amp-gemini");
  assert.equal(isAmpManagementPath("/api/auth/callback"), true);
  assert.equal(isAmpManagementPath("/threads"), true);
  assert.equal(isAmpManagementPath("/openai/v1/chat/completions"), false);
});

test("createFetchHandler proxies AMP management routes with upstream credentials", { concurrency: false }, async () => {
  const config = buildConfig({
    providers: [],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_proxy_key",
      restrictManagementToLocalhost: true
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      method: init.method,
      headers: getHeaderMap(init.headers)
    };
    return jsonResponse({ ok: true });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/auth/session", {
      method: "GET",
      headers: {
        authorization: "Bearer gw_amp_key",
        "x-real-ip": "127.0.0.1"
      }
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://ampcode.com/api/auth/session");
    assert.equal(captured?.headers?.authorization, "Bearer amp_proxy_key");
    assert.equal(captured?.headers?.["x-api-key"], "amp_proxy_key");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler strips client auth query params and identity headers before AMP upstream proxying", { concurrency: false }, async () => {
  const config = buildConfig({
    providers: [],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_proxy_key",
      restrictManagementToLocalhost: true
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      headers: getHeaderMap(init.headers)
    };
    return jsonResponse({ ok: true });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/auth/session?key=gw_amp_key&auth_token=gw_amp_key&safe=1", {
      method: "GET",
      headers: {
        authorization: "Bearer gw_amp_key",
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
        "cf-connecting-ip": "127.0.0.1",
        "sec-ch-ua": "\"Chromium\";v=\"123\""
      }
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://ampcode.com/api/auth/session?safe=1");
    assert.equal(captured?.headers?.authorization, "Bearer amp_proxy_key");
    assert.equal(captured?.headers?.["x-api-key"], "amp_proxy_key");
    assert.equal(captured?.headers?.["x-forwarded-for"], undefined);
    assert.equal(captured?.headers?.["x-real-ip"], undefined);
    assert.equal(captured?.headers?.["cf-connecting-ip"], undefined);
    assert.equal(captured?.headers?.["sec-ch-ua"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler preserves gzipped AMP management request bodies when proxying upstream", { concurrency: false }, async () => {
  const config = buildConfig({
    providers: [],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_proxy_key",
      restrictManagementToLocalhost: true
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    const forwardedBody = init.body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(await new Response(init.body).arrayBuffer());
    captured = {
      url: String(url),
      headers: getHeaderMap(init.headers),
      body: forwardedBody
    };
    return jsonResponse({ ok: true });
  };

  try {
    const threadPayload = {
      threadID: "T-test-thread",
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          content: "tool output"
        }
      ]
    };
    const compressedPayload = gzipSync(Buffer.from(JSON.stringify(threadPayload), "utf8"));

    const response = await fetchHandler(new Request("http://router.local/api/internal?uploadThread", {
      method: "POST",
      headers: {
        authorization: "Bearer gw_amp_key",
        "content-type": "application/json",
        "content-encoding": "gzip",
        "x-real-ip": "127.0.0.1"
      },
      body: compressedPayload
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://ampcode.com/api/internal?uploadThread");
    assert.equal(captured?.headers?.["content-encoding"], "gzip");
    assert.deepEqual(
      JSON.parse(gunzipSync(captured?.body || Buffer.alloc(0)).toString("utf8")),
      threadPayload
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler decompresses AMP upstream gzip responses without content-encoding", { concurrency: false }, async () => {
  const config = buildConfig({
    providers: [],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_proxy_key",
      restrictManagementToLocalhost: true
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    gzipSync(Buffer.from(JSON.stringify({
      id: "user_123",
      freeTierEligibleIfWorkspaceAllows: null,
      dailyGrantEnabledIfWorkspaceAllows: null
    }))),
    {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    }
  );

  try {
    const response = await fetchHandler(new Request("http://router.local/api/user", {
      method: "GET",
      headers: {
        authorization: "Bearer gw_amp_key",
        "x-real-ip": "127.0.0.1"
      }
    }), {});

    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload?.id, "user_123");
    assert.equal(payload?.freeTierEligibleIfWorkspaceAllows, true);
    assert.equal(payload?.dailyGrantEnabledIfWorkspaceAllows, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler normalizes AMP free-tier status for management RPCs", { concurrency: false }, async () => {
  const config = buildConfig({
    providers: [],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_proxy_key",
      restrictManagementToLocalhost: true
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    ok: true,
    result: {
      canUseAmpFree: false,
      isDailyGrantEnabled: true,
      features: []
    }
  });

  try {
    const response = await fetchHandler(new Request("http://router.local/api/internal?getUserFreeTierStatus", {
      method: "POST",
      headers: {
        authorization: "Bearer gw_amp_key",
        "content-type": "application/json",
        "x-real-ip": "127.0.0.1"
      },
      body: JSON.stringify({
        method: "getUserFreeTierStatus",
        params: {}
      })
    }), {});

    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload?.result?.canUseAmpFree, true);
    assert.equal(payload?.result?.isDailyGrantEnabled, false);
    assert.deepEqual(payload?.result?.features, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler normalizes AMP user payload free-tier hints", { concurrency: false }, async () => {
  const config = buildConfig({
    providers: [],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_proxy_key",
      restrictManagementToLocalhost: true
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/internal" && parsed.searchParams.has("getUserInfo")) {
      return jsonResponse({
        ok: true,
        result: {
          id: "user_123",
          freeTierEligibleIfWorkspaceAllows: null,
          dailyGrantEnabledIfWorkspaceAllows: null
        }
      });
    }
    return jsonResponse({
      id: "user_123",
      freeTierEligibleIfWorkspaceAllows: null,
      dailyGrantEnabledIfWorkspaceAllows: null
    });
  };

  try {
    const userResponse = await fetchHandler(new Request("http://router.local/api/user", {
      method: "GET",
      headers: {
        authorization: "Bearer gw_amp_key",
        "x-real-ip": "127.0.0.1"
      }
    }), {});
    const userPayload = await readJson(userResponse);
    assert.equal(userPayload?.freeTierEligibleIfWorkspaceAllows, true);
    assert.equal(userPayload?.dailyGrantEnabledIfWorkspaceAllows, false);

    const infoResponse = await fetchHandler(new Request("http://router.local/api/internal?getUserInfo", {
      method: "POST",
      headers: {
        authorization: "Bearer gw_amp_key",
        "content-type": "application/json",
        "x-real-ip": "127.0.0.1"
      },
      body: JSON.stringify({
        method: "getUserInfo",
        params: {}
      })
    }), {});
    const infoPayload = await readJson(infoResponse);
    assert.equal(infoPayload?.result?.freeTierEligibleIfWorkspaceAllows, true);
    assert.equal(infoPayload?.result?.dailyGrantEnabledIfWorkspaceAllows, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler blocks AMP management routes from non-localhost when configured", { concurrency: false }, async () => {
  const config = buildConfig({
    providers: [],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_proxy_key",
      restrictManagementToLocalhost: true
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config
  });

  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return jsonResponse({ ok: true });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/auth/session", {
      method: "GET",
      headers: {
        authorization: "Bearer gw_amp_key",
        "x-real-ip": "192.168.1.55"
      }
    }), {});

    assert.equal(response.status, 403);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler accepts Google-style auth header for AMP Gemini routes", { concurrency: false }, async () => {
  const config = buildConfig();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config
  });

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/google/v1/models", {
      method: "GET",
      headers: {
        "x-goog-api-key": "gw_amp_key"
      }
    }), {});

    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.ok(Array.isArray(payload.models));
    assert.equal(payload.models[0]?.name, "models/gpt-4o-mini");
  } finally {
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler falls back to AMP upstream for unresolved AMP provider models", { concurrency: false }, async () => {
  const config = buildConfig({
    providers: []
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      headers: getHeaderMap(init.headers),
      body: await readInitJsonBody(init)
    };
    return jsonResponse({ ok: true });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer gw_amp_key",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5-amp-only",
        messages: [{ role: "user", content: "hello" }],
        stream: false
      })
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://ampcode.com/api/provider/openai/v1/chat/completions");
    assert.equal(captured?.body?.model, "gpt-5-amp-only");
    assert.equal(captured?.headers?.authorization, "Bearer amp_upstream_key");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler resolves AMP bare models locally before upstream fallback", { concurrency: false }, async () => {
  const config = buildConfig();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      body: await readInitJsonBody(init)
    };
    return jsonResponse({
      id: "chatcmpl_1",
      object: "chat.completion",
      created: 1730000000,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop"
        }
      ]
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
        stream: false
      })
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(captured?.body?.model, "gpt-4o-mini");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler serves AMP Gemini models locally", { concurrency: false }, async () => {
  const config = buildConfig();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/google/v1beta/models", {
      method: "GET"
    }), {});

    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.ok(Array.isArray(payload.models));
    assert.deepEqual(payload.models[0], {
      name: "models/gpt-4o-mini",
      baseModelId: "gpt-4o-mini",
      displayName: "gpt-4o-mini",
      description: "OpenRouter / gpt-4o-mini",
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"]
    });
  } finally {
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler falls back unknown AMP Anthropic subagent models to defaultModel locally", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "openrouter/gpt-4o-mini",
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key"
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      body: await readInitJsonBody(init)
    };
    return jsonResponse({
      id: "chatcmpl_amp_default_1",
      object: "chat.completion",
      created: 1730000000,
      model: "gpt-4o-mini",
      choices: [
        { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }
      ]
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }]
      })
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(captured?.body?.model, "gpt-4o-mini");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler routes current AMP Oracle profile through configured subagent mapping", { concurrency: false }, async () => {
  const config = buildConfig({
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key",
      subagentMappings: {
        oracle: "openrouter/gpt-4o-mini"
      }
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      body: await readInitJsonBody(init)
    };
    return jsonResponse({
      id: "chatcmpl_amp_oracle_1",
      object: "chat.completion",
      created: 1730000000,
      model: "gpt-4o-mini",
      choices: [
        { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }
      ]
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello oracle" }]
      })
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(captured?.body?.model, "gpt-4o-mini");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler routes AMP smart-style requests through new AMP entity routes", { concurrency: false }, async () => {
  const config = buildConfig({
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key",
      routes: {
        smart: "openrouter/gpt-4o-mini"
      }
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      body: await readInitJsonBody(init)
    };
    return jsonResponse({
      id: "chatcmpl_amp_smart_1",
      object: "chat.completion",
      created: 1730000000,
      model: "gpt-4o-mini",
      choices: [
        { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }
      ]
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "Claude Opus 4.6",
        max_tokens: 128,
        messages: [{ role: "user", content: "hello smart" }]
      })
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(captured?.body?.model, "gpt-4o-mini");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler can disable AMP upstream proxy when new AMP fallback policy says none", { concurrency: false }, async () => {
  const config = buildConfig({
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key",
      routes: {},
      fallback: {
        onUnknown: "none",
        proxyUpstream: false
      }
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return jsonResponse({ ok: true });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "unknown-amp-model",
        messages: [{ role: "user", content: "hello" }]
      })
    }), {});

    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler exposes AMP Gemini model metadata through local fallback", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "openrouter/gpt-4o-mini"
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/google/v1beta/models/gemini-2.5-flash", {
      method: "GET"
    }), {});

    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload.name, "models/gemini-2.5-flash");
    assert.equal(payload.baseModelId, "gemini-2.5-flash");
    assert.match(String(payload.description || ""), /fallback/i);
  } finally {
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler translates AMP Gemini generateContent locally", { concurrency: false }, async () => {
  const config = buildConfig({
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key",
      forceModelMappings: true,
      modelMappings: [
        { from: "*", to: "openrouter/gpt-4o-mini" }
      ]
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      headers: getHeaderMap(init.headers),
      body: await readInitJsonBody(init)
    };
    return jsonResponse({
      id: "chatcmpl_amp_1",
      object: "chat.completion",
      created: 1730000000,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok from bridge" },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16
      }
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/google/v1beta/models/gemini-2.5-pro:generateContent", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: "hello" }]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 128
        }
      })
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(captured?.body?.model, "gpt-4o-mini");
    assert.deepEqual(captured?.body?.messages, [
      { role: "user", content: "hello" }
    ]);
    assert.equal(captured?.body?.stream, false);
    assert.equal(captured?.body?.temperature, 0.2);
    assert.equal(captured?.body?.max_tokens, 128);

    const payload = await readJson(response);
    assert.equal(payload.model, "gemini-2.5-pro");
    assert.equal(payload.candidates[0]?.content?.role, "model");
    assert.equal(payload.candidates[0]?.content?.parts?.[0]?.text, "ok from bridge");
    assert.equal(payload.candidates[0]?.finishReason, "STOP");
    assert.equal(payload.usageMetadata?.totalTokenCount, 16);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler translates AMP Gemini streamGenerateContent locally", { concurrency: false }, async () => {
  const config = buildConfig({
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key",
      forceModelMappings: true,
      modelMappings: [
        { from: "*", to: "openrouter/gpt-4o-mini" }
      ]
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    'data: {"id":"chatcmpl_chunk_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
    'data: {"id":"chatcmpl_chunk_2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"}}]}\n\n',
    'data: {"id":"chatcmpl_chunk_3","object":"chat.completion.chunk","choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
    'data: [DONE]\n\n'
  ]);

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/google/v1beta/models/gemini-2.5-pro:streamGenerateContent", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: "hello" }]
          }
        ]
      })
    }), {});

    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type") || ""), /text\/event-stream/i);

    const raw = await response.text();
    const payloads = parseSsePayloads(raw);
    assert.equal(payloads[0]?.candidates?.[0]?.content?.parts?.[0]?.text, "Hello");
    assert.equal(payloads[1]?.candidates?.[0]?.content?.parts?.[0]?.text, " world");
    assert.equal(payloads[2]?.candidates?.[0]?.finishReason, "STOP");
    assert.equal(payloads[3]?.usageMetadata?.totalTokenCount, 12);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler routes OpenAI responses requests to provider /responses endpoint", { concurrency: false }, async () => {
  const config = buildConfig();
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return jsonResponse({
      id: "resp_1",
      object: "response",
      model: "gpt-4o-mini",
      output: []
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/openai/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "openrouter/gpt-4o-mini",
        input: "hello"
      })
    }), {});

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, "https://openrouter.ai/api/v1/responses");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler translates AMP OpenAI responses requests for Claude providers", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "zai/glm-5",
    providers: [
      {
        id: "zai",
        name: "Z.AI",
        baseUrl: "https://api.z.ai/api/anthropic/v1",
        format: "claude",
        models: [
          {
            id: "glm-5",
            aliases: ["gpt-5.3-codex"]
          }
        ]
      }
    ]
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      body: await readInitJsonBody(init)
    };
    return sseResponse([
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_router_1\",\"model\":\"glm-5\",\"usage\":{\"input_tokens\":2,\"output_tokens\":0}}}\n\n",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\n",
      "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
      "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
    ]);
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/openai/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        stream: true,
        instructions: "Answer directly.",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Reply with OK." }]
          }
        ]
      })
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://api.z.ai/api/anthropic/v1/messages");
    assert.equal(captured?.body?.model, "glm-5");
    assert.equal(captured?.body?.messages?.length, 1);
    assert.equal(captured?.body?.messages?.[0]?.role, "user");
    assert.equal(captured?.body?.messages?.[0]?.content?.[0]?.text, "Reply with OK.");
    assert.equal(captured?.body?.system, "Answer directly.");

    const raw = await response.text();
    const events = parseSseEvents(raw);
    const eventNames = events.map((entry) => entry.event);
    assert.deepEqual(eventNames, [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed"
    ]);
    assert.equal(events[4]?.payload?.delta, "OK");
    assert.equal(events[8]?.payload?.response?.object, "response");
    assert.equal(events[8]?.payload?.response?.model, "gpt-5.3-codex");
    assert.equal(events[8]?.payload?.response?.output?.[0]?.content?.[0]?.text, "OK");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler normalizes Claude passthrough streams for AMP free mode", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ]
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      body: await readInitJsonBody(init)
    };
    return sseResponse([
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_router_free\",\"model\":\"claude-3-5-haiku\",\"usage\":{\"input_tokens\":6,\"output_tokens\":0}}}\n\n",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"I can't discuss that.\"}}\n\n",
      "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
    ]);
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku",
        stream: true,
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Reply briefly." }]
          }
        ]
      })
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured?.body?.model, "claude-3-5-haiku");

    const raw = await response.text();
    const events = parseSseEvents(raw);
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
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler normalizes Claude passthrough tool_use streams for AMP free mode", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ]
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_router_free_tool\",\"model\":\"claude-3-5-haiku\",\"usage\":{\"input_tokens\":8,\"output_tokens\":0}}}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool_1\",\"name\":\"Read\",\"input\":{\"path\":\"/tmp/demo\"}}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
  ]);

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku",
        stream: true,
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Read a file." }]
          }
        ]
      })
    }), {});

    assert.equal(response.status, 200);
    const raw = await response.text();
    const events = parseSseEvents(raw);
    assert.deepEqual(events.map((entry) => entry.event), [
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
    assert.equal(events[3]?.payload?.delta?.stop_reason, "tool_use");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler normalizes Claude non-stream tool_use stop_reason for AMP", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ]
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    id: "msg_router_free_tool_json",
    type: "message",
    role: "assistant",
    model: "claude-3-5-haiku",
    content: [
      { type: "text", text: "I will read it." },
      { type: "tool_use", id: "tool_2", name: "Read", input: { path: "/tmp/demo" } }
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 1 }
  });

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku",
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Read a file." }]
          }
        ]
      })
    }), {});

    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload.stop_reason, "tool_use");
    assert.equal(payload.content?.[1]?.type, "tool_use");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler maps AMP Gemini googleSearch tools onto Claude web search", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key",
      forceModelMappings: true,
      modelMappings: [
        { from: "*", to: "anthropic/claude-3-5-haiku" }
      ]
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      body: await readInitJsonBody(init)
    };
    return jsonResponse({
      id: "msg_amp_search",
      type: "message",
      role: "assistant",
      model: "claude-3-5-haiku",
      content: [{ type: "text", text: "search-ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 }
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/google/v1beta/models/gemini-2.5-flash:generateContent", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: "Search online for llm-router release notes." }]
          }
        ],
        tools: [
          { googleSearch: {} }
        ]
      })
    }), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured?.body?.model, "claude-3-5-haiku");
    assert.deepEqual(captured?.body?.tools, [
      {
        type: "web_search_20250305",
        name: "web_search"
      }
    ]);
    assert.equal(response.headers.get("x-llm-router-tool-types"), "web_search");
    assert.match(String(response.headers.get("x-llm-router-tool-routing") || ""), /amp-web-search/);

    const payload = await readJson(response);
    assert.equal(payload.candidates[0]?.content?.parts?.[0]?.text, "search-ok");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler intercepts AMP web search locally when alternate search providers are configured", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key",
      proxyWebSearchToUpstream: true,
      webSearch: {
        strategy: "ordered",
        count: 3,
        providers: [
          { id: "brave", apiKey: "brave_search_key", limit: 1000, remaining: 5 }
        ]
      }
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    const body = init?.body ? await readInitJsonBody(init) : {};
    captured.push({
      url: normalizedUrl,
      headers: getHeaderMap(init.headers),
      body
    });

    if (normalizedUrl === "https://api.anthropic.com/v1/messages" && captured.filter((entry) => entry.url === normalizedUrl).length === 1) {
      return jsonResponse({
        id: "msg_amp_intercept_1",
        type: "message",
        role: "assistant",
        model: "claude-3-5-haiku",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "web_search",
            input: {
              query: "llm-router release notes"
            }
          }
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 6, output_tokens: 2 }
      });
    }

    if (normalizedUrl.startsWith("https://api.search.brave.com/")) {
      return jsonResponse({
        web: {
          results: [
            {
              title: "LLM Router release notes",
              url: "https://example.com/releases",
              description: "Release notes from the project website."
            }
          ]
        }
      });
    }

    if (normalizedUrl === "https://api.anthropic.com/v1/messages" && captured.filter((entry) => entry.url === normalizedUrl).length === 2) {
      return jsonResponse({
        id: "msg_amp_intercept_2",
        type: "message",
        role: "assistant",
        model: "claude-3-5-haiku",
        content: [
          { type: "text", text: "Here is the final answer after local search." }
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 14, output_tokens: 5 }
      });
    }

    throw new Error(`Unexpected fetch: ${normalizedUrl}`);
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/openai/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "anthropic/claude-3-5-haiku",
        input: "Search online for llm-router release notes.",
        tools: [
          { type: "web_search" }
        ],
        tool_choice: "required"
      })
    }), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });

    assert.equal(response.status, 200);
    assert.equal(captured[0]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured[1]?.url.startsWith("https://api.search.brave.com/"), true);
    assert.equal(captured[2]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured.some((entry) => entry.url.startsWith("https://ampcode.com/")), false);
    assert.equal(captured[0]?.body?.tools?.[0]?.name, "web_search");
    assert.equal(captured[2]?.body?.tools, undefined);
    assert.match(String(captured[2]?.body?.system || ""), /You just performed web searches/);
    assert.match(JSON.stringify(captured[2]?.body?.messages || []), /LLM Router release notes/);
    assert.notEqual(response.headers.get("x-llm-router-tool-routing"), "amp-web-search:proxy-upstream");

    const payload = await readJson(response);
    assert.match(JSON.stringify(payload), /Here is the final answer after local search/);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler intercepts AMP web search locally when only hosted routes are configured", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      },
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
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    const body = await readInitJsonBody(init);
    captured.push({
      url: normalizedUrl,
      body
    });

    if (normalizedUrl === "https://api.anthropic.com/v1/messages" && captured.filter((entry) => entry.url === normalizedUrl).length === 1) {
      return jsonResponse({
        id: "msg_amp_hosted_search_1",
        type: "message",
        role: "assistant",
        model: "claude-3-5-haiku",
        content: [
          {
            type: "tool_use",
            id: "tool_web_1",
            name: "web_search",
            input: {
              query: "latest llm-router release notes"
            }
          }
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 6, output_tokens: 2 }
      });
    }

    if (normalizedUrl === "https://ramclouds.me/v1/responses") {
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
                text: "The latest LLM Router release notes were published on example.com/releases."
              }
            ]
          }
        ]
      });
    }

    if (normalizedUrl === "https://api.anthropic.com/v1/messages" && captured.filter((entry) => entry.url === normalizedUrl).length === 2) {
      return jsonResponse({
        id: "msg_amp_hosted_search_2",
        type: "message",
        role: "assistant",
        model: "claude-3-5-haiku",
        content: [
          { type: "text", text: "Here is the final answer after hosted local search." }
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 18, output_tokens: 6 }
      });
    }

    throw new Error(`Unexpected fetch: ${normalizedUrl}`);
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "smart",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Search the web for llm-router release notes." }]
          }
        ],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search"
          }
        ]
      })
    }), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });

    assert.equal(response.status, 200);
    assert.equal(captured.length, 3);
    assert.equal(captured[0]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured[1]?.url, "https://ramclouds.me/v1/responses");
    assert.equal(captured[1]?.body?.model, "gpt-5.4");
    assert.equal(captured[1]?.body?.tools?.[0]?.type, "web_search");
    assert.equal(captured[2]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured[0]?.body?.tools?.[0]?.name, "web_search");
    assert.equal(captured[2]?.body?.tools, undefined);
    assert.match(JSON.stringify(captured[2]?.body?.messages || []), /example\.com\/releases/);
    assert.notEqual(response.headers.get("x-llm-router-tool-routing"), "amp-web-search:proxy-upstream");

    const payload = await readJson(response);
    assert.equal(payload.content?.[0]?.type, "text");
    assert.match(payload.content?.[0]?.text || "", /final answer after hosted local search/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler intercepts AMP read_web_page locally without AMP credits", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ]
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    const body = init?.body ? await readInitJsonBody(init) : {};
    captured.push({
      url: normalizedUrl,
      body
    });

    if (normalizedUrl === "https://api.anthropic.com/v1/messages" && captured.filter((entry) => entry.url === normalizedUrl).length === 1) {
      return jsonResponse({
        id: "msg_amp_read_1",
        type: "message",
        role: "assistant",
        model: "claude-3-5-haiku",
        content: [
          {
            type: "tool_use",
            id: "tool_read_1",
            name: "read_web_page",
            input: {
              url: "https://platform.claude.com/docs/en/about-claude/models/overview"
            }
          }
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 6, output_tokens: 2 }
      });
    }

    if (normalizedUrl === "https://platform.claude.com/docs/en/about-claude/models/overview") {
      return new Response(`<!doctype html>
        <html>
          <head><title>Claude Models Overview</title></head>
          <body>
            <main>
              <table>
                <caption>Latest models comparison</caption>
                <tr><th>Model</th><th>Context window</th></tr>
                <tr><td>Claude Sonnet 4</td><td>200K</td></tr>
                <tr><td>Claude Haiku 3.5</td><td>200K</td></tr>
              </table>
            </main>
          </body>
        </html>`, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8"
        }
      });
    }

    if (normalizedUrl === "https://api.anthropic.com/v1/messages" && captured.filter((entry) => entry.url === normalizedUrl).length === 2) {
      return jsonResponse({
        id: "msg_amp_read_2",
        type: "message",
        role: "assistant",
        model: "claude-3-5-haiku",
        content: [
          { type: "text", text: "Extracted the latest models comparison table locally." }
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 18, output_tokens: 6 }
      });
    }

    throw new Error(`Unexpected fetch: ${normalizedUrl}`);
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "smart",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Open the Claude models overview page and extract the latest models comparison table." }]
          }
        ],
        tools: [
          {
            name: "read_web_page",
            input_schema: {
              type: "object",
              properties: {
                url: { type: "string" }
              },
              required: ["url"]
            }
          }
        ]
      })
    }), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });

    assert.equal(response.status, 200);
    assert.equal(captured.length, 3);
    assert.equal(captured[0]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured[0]?.body?.tools?.[0]?.name, "read_web_page");
    assert.equal(captured[1]?.url, "https://platform.claude.com/docs/en/about-claude/models/overview");
    assert.equal(captured[2]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured[2]?.body?.tools, undefined);
    assert.match(JSON.stringify(captured[2]?.body?.messages || []), /Latest models comparison/);
    assert.match(JSON.stringify(captured[2]?.body?.messages || []), /Claude Sonnet 4/);
    assert.notEqual(response.headers.get("x-llm-router-tool-routing"), "amp-web-search:proxy-upstream");

    const payload = await readJson(response);
    assert.match(payload.content?.[0]?.text || "", /Extracted the latest models comparison table locally/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler can proxy AMP web search requests upstream when enabled", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key",
      proxyWebSearchToUpstream: true
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      headers: getHeaderMap(init.headers),
      body: await readInitJsonBody(init)
    };
    return jsonResponse({
      id: "resp_amp_upstream_search",
      object: "response",
      model: "smart",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "amp upstream search results" }]
        }
      ]
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/openai/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "smart",
        input: "Search online for llm-router release notes.",
        tools: [
          { type: "web_search" }
        ],
        tool_choice: "required"
      })
    }), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://ampcode.com/api/provider/openai/v1/responses");
    assert.equal(captured?.headers?.authorization, "Bearer amp_upstream_key");
    assert.equal(captured?.headers?.["x-api-key"], "amp_upstream_key");
    assert.deepEqual(captured?.body?.tools, [
      { type: "web_search" }
    ]);
    assert.equal(response.headers.get("x-llm-router-tool-types"), "web_search");
    assert.equal(response.headers.get("x-llm-router-tool-routing"), "amp-web-search:proxy-upstream");

    const payload = await readJson(response);
    assert.equal(payload.output?.[0]?.content?.[0]?.text, "amp upstream search results");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler can proxy AMP Gemini web search requests upstream when enabled", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key",
      proxyWebSearchToUpstream: true
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      headers: getHeaderMap(init.headers),
      body: await readInitJsonBody(init)
    };
    return jsonResponse({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "amp upstream gemini search results" }]
          },
          finishReason: "STOP"
        }
      ]
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/google/v1beta/models/gemini-2.5-flash:generateContent", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: "Search online for llm-router release notes." }]
          }
        ],
        tools: [
          { googleSearch: {} }
        ]
      })
    }), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://ampcode.com/api/provider/google/v1beta/models/gemini-2.5-flash:generateContent");
    assert.equal(captured?.headers?.authorization, "Bearer amp_upstream_key");
    assert.equal(captured?.headers?.["x-api-key"], "amp_upstream_key");
    assert.deepEqual(captured?.body?.tools, [
      { googleSearch: {} }
    ]);
    assert.equal(response.headers.get("x-llm-router-tool-types"), "web_search");
    assert.equal(response.headers.get("x-llm-router-tool-routing"), "amp-web-search:proxy-upstream");

    const payload = await readJson(response);
    assert.equal(payload.candidates?.[0]?.content?.parts?.[0]?.text, "amp upstream gemini search results");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler prefers non-Codex routes for AMP web search responses", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "chat.search",
    modelAliases: {
      "chat.search": {
        strategy: "ordered",
        targets: [
          { ref: "chatgpt/gpt-5.3-codex" },
          { ref: "anthropic/claude-3-5-haiku" }
        ]
      }
    },
    providers: [
      {
        id: "chatgpt",
        name: "ChatGPT Subscription",
        type: "subscription",
        subscriptionType: "chatgpt-codex",
        subscriptionProfile: "personal",
        format: "openai",
        models: [{ id: "gpt-5.3-codex" }]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ]
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      body: await readInitJsonBody(init)
    };
    return jsonResponse({
      id: "msg_amp_response_search",
      type: "message",
      role: "assistant",
      model: "claude-3-5-haiku",
      content: [{ type: "text", text: "response-search-ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 2 }
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/openai/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "chat.search",
        input: "Search online for llm-router release notes.",
        tools: [
          { type: "web_search" }
        ],
        tool_choice: "required"
      })
    }), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured?.body?.model, "claude-3-5-haiku");
    assert.deepEqual(captured?.body?.tools, [
      {
        type: "web_search_20250305",
        name: "web_search"
      }
    ]);
    assert.equal(response.headers.get("x-llm-router-selected-candidate"), "anthropic/claude-3-5-haiku");
    assert.equal(response.headers.get("x-llm-router-tool-types"), "web_search");
    assert.equal(response.headers.get("x-llm-router-tool-routing"), "amp-web-search:prefer-non-codex");

    const payload = await readJson(response);
    assert.equal(payload.object, "response");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler rewrites AMP Claude mapped responses back to the requested model", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key",
      forceModelMappings: true,
      modelMappings: [
        { from: "gpt-5.2", to: "anthropic/claude-3-5-haiku" }
      ]
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      body: await readInitJsonBody(init)
    };
    return jsonResponse({
      id: "msg_amp_mapped",
      type: "message",
      role: "assistant",
      model: "claude-3-5-haiku",
      content: [
        { type: "thinking", thinking: "Inspecting tools..." },
        { type: "tool_use", id: "tool_1", name: "web_search", input: {} },
        { type: "text", text: "done" }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 2 }
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        max_tokens: 128,
        messages: [{ role: "user", content: "Search for docs." }]
      })
    }), {});

    assert.equal(response.status, 200);
    assert.equal(captured?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured?.body?.model, "claude-3-5-haiku");

    const payload = await readJson(response);
    assert.equal(payload.model, "gpt-5.2");
    assert.deepEqual(payload.content, [
      { type: "tool_use", id: "tool_1", name: "web_search", input: {} },
      { type: "text", text: "done" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler can override the visible AMP response model for debugging", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ]
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    id: "msg_amp_debug_override",
    type: "message",
    role: "assistant",
    model: "claude-3-5-haiku",
    content: [{ type: "text", text: "OK" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 1 }
  });

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 128,
        messages: [{ role: "user", content: "Say OK." }]
      })
    }), {
      LLM_ROUTER_DEBUG_AMP_VISIBLE_MODEL_OVERRIDE: "gpt-5.3-codex"
    });

    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload.model, "gpt-5.3-codex");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("inferAmpContextRequirement maps current AMP modes and observed resolved model ids", () => {
  const baseRequest = new Request("http://router.local/api/provider/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01"
    }
  });

  assert.deepEqual(
    inferAmpContextRequirement(baseRequest, { model: "smart" }, { clientType: "amp", providerHint: "anthropic", requestKind: "messages" }),
    { minimumContextTokens: 168000, source: "amp:model:smart" }
  );
  assert.deepEqual(
    inferAmpContextRequirement(baseRequest, { model: "rush" }, { clientType: "amp", providerHint: "anthropic", requestKind: "messages" }),
    { minimumContextTokens: 136000, source: "amp:model:rush" }
  );
  assert.deepEqual(
    inferAmpContextRequirement(baseRequest, { model: "free" }, { clientType: "amp", providerHint: "anthropic", requestKind: "messages" }),
    { minimumContextTokens: 136000, source: "amp:model:free" }
  );
  assert.deepEqual(
    inferAmpContextRequirement(
      new Request("http://router.local/api/provider/openai/v1/responses", { method: "POST" }),
      { model: "deep" },
      { clientType: "amp", providerHint: "openai", requestKind: "responses" }
    ),
    { minimumContextTokens: 272000, source: "amp:model:deep" }
  );
  assert.deepEqual(
    inferAmpContextRequirement(baseRequest, { model: "large" }, { clientType: "amp", providerHint: "anthropic", requestKind: "messages" }),
    { minimumContextTokens: 936000, source: "amp:model:large" }
  );
  assert.deepEqual(
    inferAmpContextRequirement(
      new Request("http://router.local/api/provider/openai/v1/responses", { method: "POST" }),
      { model: "openai/gpt-5.3-codex" },
      { clientType: "amp", providerHint: "openai", requestKind: "responses" }
    ),
    { minimumContextTokens: 272000, source: "amp:model:openai/gpt-5.3-codex" }
  );
  assert.deepEqual(
    inferAmpContextRequirement(baseRequest, { model: "gpt-5.3-codex" }, { clientType: "amp", providerHint: "anthropic", requestKind: "messages" }),
    { minimumContextTokens: 968000, source: "amp:model:gpt-5.3-codex" }
  );
});

test("inferAmpContextRequirement lets the AMP 1M beta override mode-specific floors", () => {
  const request = new Request("http://router.local/api/provider/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "context-1m-2025-08-07"
    }
  });

  assert.deepEqual(
    inferAmpContextRequirement(request, { model: "large" }, { clientType: "amp", providerHint: "anthropic", requestKind: "messages" }),
    { minimumContextTokens: 1000000, source: "amp:anthropic-beta:context-1m-2025-08-07" }
  );
});

test("createFetchHandler rewrites AMP Claude stream model names back to the requested model", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "anthropic/claude-3-5-haiku",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      }
    ],
    amp: {
      upstreamUrl: "https://ampcode.com",
      upstreamApiKey: "amp_upstream_key",
      forceModelMappings: true,
      modelMappings: [
        { from: "gpt-5.2", to: "anthropic/claude-3-5-haiku" }
      ]
    }
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_router_stream","model":"claude-3-5-haiku","usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":2,"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ]);

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "Say OK." }]
      })
    }), {});

    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type") || ""), /text\/event-stream/i);

    const events = parseSseEvents(await response.text());
    assert.equal(events[0]?.payload?.message?.model, "gpt-5.2");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler strips streamed Claude thinking blocks before AMP tool_use blocks", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "openrouter/gpt-4o-mini",
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini", aliases: ["gpt-5.3-codex"] }]
      }
    ]
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    'data: {"id":"resp_tool_stream","object":"chat.completion.chunk","created":1730001111,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":"Plan the read","tool_calls":null},"finish_reason":null}]}\n\n',
    'data: {"id":"resp_tool_stream","object":"chat.completion.chunk","created":1730001111,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_read_1","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"resp_tool_stream","object":"chat.completion.chunk","created":1730001111,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"resp_tool_stream","object":"chat.completion.chunk","created":1730001111,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":4,"total_tokens":6}}\n\n',
    'data: [DONE]\n\n'
  ]);

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        max_tokens: 256,
        stream: true,
        messages: [{ role: "user", content: "Read README.md" }]
      })
    }), {});

    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    assert.deepEqual(events.map((entry) => entry.event), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
    assert.equal(events[0]?.payload?.message?.model, "gpt-5.3-codex");
    assert.equal(events[1]?.payload?.content_block?.type, "tool_use");
    assert.equal(events[1]?.payload?.index, 0);
    assert.equal(events[2]?.payload?.delta?.type, "input_json_delta");
    assert.equal(events[2]?.payload?.index, 0);
    assert.equal(events[4]?.payload?.delta?.stop_reason, "tool_use");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

test("createFetchHandler falls back when AMP web search returns semantic credits refusal", { concurrency: false }, async () => {
  const config = buildConfig({
    defaultModel: "chat.search",
    modelAliases: {
      "chat.search": {
        strategy: "ordered",
        targets: [
          { ref: "anthropic/claude-3-5-haiku" },
          { ref: "openrouter/gpt-4o-mini" }
        ]
      }
    },
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        format: "claude",
        models: [{ id: "claude-3-5-haiku" }]
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }]
      }
    ]
  });
  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: true
  });

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const payload = await readInitJsonBody(init);
    calls.push({
      url: String(url),
      body: payload
    });

    if (String(url).includes("/messages")) {
      return jsonResponse({
        id: "msg_search_refusal",
        type: "message",
        role: "assistant",
        model: "claude-3-5-haiku",
        content: [{ type: "text", text: "Web search credits are unavailable in this session" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 2 }
      });
    }

    return jsonResponse({
      id: "resp_search_success",
      object: "response",
      model: "gpt-4o-mini",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "final web results" }]
        }
      ]
    });
  };

  try {
    const response = await fetchHandler(new Request("http://router.local/api/provider/openai/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "chat.search",
        input: "Search online for llm-router release notes.",
        tools: [
          { type: "web_search" }
        ],
        tool_choice: "required"
      })
    }), {
      LLM_ROUTER_DEBUG_ROUTING: "true"
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[1]?.url, "https://openrouter.ai/api/v1/responses");
    assert.equal(response.headers.get("x-llm-router-selected-candidate"), "openrouter/gpt-4o-mini");
    assert.match(String(response.headers.get("x-llm-router-attempts") || ""), /search_unavailable/);

    const payload = await readJson(response);
    assert.equal(payload.output?.[0]?.content?.[0]?.text, "final web results");
  } finally {
    globalThis.fetch = originalFetch;
    if (typeof fetchHandler.close === "function") {
      await fetchHandler.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Amp thinking block suppression edge cases
// ---------------------------------------------------------------------------

function buildSseStream(eventStrings) {
  const encoder = new TextEncoder();
  const combined = eventStrings.join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(combined));
      controller.close();
    }
  });
}

async function readSseEvents(response) {
  const raw = await response.text();
  return parseSseEvents(raw);
}

test("Amp thinking block suppression: non-streaming with tool_use strips thinking block", async () => {
  const response = new Response(
    JSON.stringify({
      model: "claude-sonnet-4-6",
      content: [
        { type: "thinking", thinking: "internal chain of thought" },
        { type: "text", text: "hello" },
        { type: "tool_use", id: "t1", name: "bash", input: {} }
      ]
    }),
    { headers: { "content-type": "application/json" } }
  );

  const result = await maybeRewriteAmpClientResponse(response, {
    clientType: "amp",
    requestBody: { model: "claude-sonnet-4-6" },
    stream: false
  });

  const payload = await readJson(result);
  const types = payload.content.map((b) => b.type);
  assert.ok(!types.includes("thinking"), "thinking block should be stripped");
  assert.ok(types.includes("text"), "text block should remain");
  assert.ok(types.includes("tool_use"), "tool_use block should remain");
  assert.equal(payload.content.length, 2);
});

test("Amp thinking block suppression: non-streaming without tool_use preserves thinking block", async () => {
  const response = new Response(
    JSON.stringify({
      model: "claude-sonnet-4-6",
      content: [
        { type: "thinking", thinking: "internal chain of thought" },
        { type: "text", text: "hello" }
      ]
    }),
    { headers: { "content-type": "application/json" } }
  );

  const result = await maybeRewriteAmpClientResponse(response, {
    clientType: "amp",
    requestBody: { model: "claude-sonnet-4-6" },
    stream: false
  });

  const payload = await readJson(result);
  const types = payload.content.map((b) => b.type);
  assert.ok(types.includes("thinking"), "thinking block should be preserved when no tool_use");
  assert.equal(payload.content.length, 2);
});

test("Amp thinking block suppression: streaming [thinking, text, tool_use] suppresses thinking and remaps indexes", async () => {
  const stream = buildSseStream([
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"reasoning...\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"bash\",\"input\":{}}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":2}\n\n"
  ]);

  const upstreamResponse = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });

  const result = await maybeRewriteAmpClientResponse(upstreamResponse, {
    clientType: "amp",
    requestBody: { model: "claude-sonnet-4-6" },
    stream: true
  });

  const events = await readSseEvents(result);
  const blockStarts = events.filter((e) => e.payload?.type === "content_block_start");
  const blockDeltas = events.filter((e) => e.payload?.type === "content_block_delta");
  const blockStops = events.filter((e) => e.payload?.type === "content_block_stop");

  // Thinking block (original index 0) should be suppressed entirely
  const thinkingStart = blockStarts.find((e) => e.payload?.content_block?.type === "thinking");
  assert.equal(thinkingStart, undefined, "thinking content_block_start should be suppressed");

  // Text block should appear with remapped index 0
  const textStart = blockStarts.find((e) => e.payload?.content_block?.type === "text");
  assert.ok(textStart, "text block start should be present");
  assert.equal(textStart.payload.index, 0, "text block should be remapped to index 0");

  // tool_use block should appear with remapped index 1
  const toolStart = blockStarts.find((e) => e.payload?.content_block?.type === "tool_use");
  assert.ok(toolStart, "tool_use block start should be present");
  assert.equal(toolStart.payload.index, 1, "tool_use block should be remapped to index 1");

  // Deltas for text (originally 1) should be at index 0
  const textDelta = blockDeltas.find((e) => e.payload?.delta?.type === "text_delta");
  assert.ok(textDelta, "text delta should be present");
  assert.equal(textDelta.payload.index, 0, "text delta index should be remapped to 0");

  // Stop events should only contain indexes 0 and 1
  const stopIndexes = blockStops.map((e) => e.payload?.index);
  assert.ok(!stopIndexes.includes(2), "original index 2 should be remapped");
  assert.ok(stopIndexes.includes(0), "remapped index 0 stop should be present");
  assert.ok(stopIndexes.includes(1), "remapped index 1 stop should be present");
});

test("Amp thinking block suppression: streaming [thinking, tool_use, thinking, tool_use] suppresses both thinking blocks", async () => {
  const stream = buildSseStream([
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"bash\",\"input\":{}}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"read\",\"input\":{}}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":3}\n\n"
  ]);

  const upstreamResponse = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });

  const result = await maybeRewriteAmpClientResponse(upstreamResponse, {
    clientType: "amp",
    requestBody: { model: "claude-sonnet-4-6" },
    stream: true
  });

  const events = await readSseEvents(result);
  const blockStarts = events.filter((e) => e.payload?.type === "content_block_start");
  const blockTypes = blockStarts.map((e) => e.payload?.content_block?.type);

  assert.ok(!blockTypes.includes("thinking"), "no thinking blocks should appear");
  assert.equal(blockTypes.filter((t) => t === "tool_use").length, 2, "both tool_use blocks should be present");

  const toolStartIndexes = blockStarts.map((e) => e.payload?.index);
  assert.deepEqual(toolStartIndexes, [0, 1], "tool_use blocks should be remapped to indexes 0 and 1");
});

test("Amp thinking block suppression: streaming [text, thinking] with no tool_use still suppresses thinking", async () => {
  const stream = buildSseStream([
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"visible\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hidden reasoning\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n"
  ]);

  const upstreamResponse = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });

  const result = await maybeRewriteAmpClientResponse(upstreamResponse, {
    clientType: "amp",
    requestBody: { model: "claude-sonnet-4-6" },
    stream: true
  });

  const events = await readSseEvents(result);
  const blockStarts = events.filter((e) => e.payload?.type === "content_block_start");
  const blockTypes = blockStarts.map((e) => e.payload?.content_block?.type);

  assert.ok(!blockTypes.includes("thinking"), "streaming always suppresses thinking even without tool_use");
  assert.ok(blockTypes.includes("text"), "text block should remain");
  assert.equal(blockStarts[0]?.payload?.index, 0, "text block keeps index 0");
});

test("Amp thinking block suppression: streaming [redacted_thinking, text] suppresses redacted_thinking", async () => {
  const stream = buildSseStream([
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"encrypted\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"answer\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n"
  ]);

  const upstreamResponse = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });

  const result = await maybeRewriteAmpClientResponse(upstreamResponse, {
    clientType: "amp",
    requestBody: { model: "claude-sonnet-4-6" },
    stream: true
  });

  const events = await readSseEvents(result);
  const blockStarts = events.filter((e) => e.payload?.type === "content_block_start");
  const blockTypes = blockStarts.map((e) => e.payload?.content_block?.type);

  assert.ok(!blockTypes.includes("redacted_thinking"), "redacted_thinking should be suppressed");
  assert.ok(blockTypes.includes("text"), "text block should remain");
  assert.equal(blockStarts[0]?.payload?.index, 0, "text block remapped to index 0");
});

test("Amp thinking block suppression: streaming message_delta usage stats pass through with suppressed blocks", async () => {
  const stream = buildSseStream([
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
  ]);

  const upstreamResponse = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });

  const result = await maybeRewriteAmpClientResponse(upstreamResponse, {
    clientType: "amp",
    requestBody: { model: "claude-sonnet-4-6" },
    stream: true
  });

  const events = await readSseEvents(result);
  const messageDelta = events.find((e) => e.payload?.type === "message_delta");
  assert.ok(messageDelta, "message_delta should not be suppressed");
  assert.equal(messageDelta.payload.usage?.input_tokens, 10, "input_tokens should pass through");
  assert.equal(messageDelta.payload.usage?.output_tokens, 5, "output_tokens should pass through");
  assert.equal(messageDelta.payload.delta?.stop_reason, "end_turn", "stop_reason should pass through");

  const messageStop = events.find((e) => e.payload?.type === "message_stop");
  assert.ok(messageStop, "message_stop should not be suppressed");
});

// Helper for testing extractAmpContext
function mockRequest(headerMap = {}) {
  const headers = new Map(Object.entries(headerMap));
  return {
    headers: {
      get: (key) => headers.get(key) || null
    }
  };
}

test("Amp header extraction and mode presets", async (t) => {
  const { extractAmpContext } = await import("./handler/request.js");

  await t.test("Returns all header values when all present", () => {
    const request = mockRequest({
      "x-amp-thread-id": "thread-123",
      "x-amp-mode": "deep",
      "x-amp-override-provider": "openai",
      "x-amp-feature": "web-search",
      "x-amp-message-id": "msg-456"
    });

    const context = extractAmpContext(request);
    assert.equal(context.threadId, "thread-123");
    assert.equal(context.mode, "deep");
    assert.equal(context.overrideProvider, "openai");
    assert.equal(context.feature, "web-search");
    assert.equal(context.messageId, "msg-456");
  });

  await t.test("Returns empty strings for missing headers", () => {
    const request = mockRequest({});

    const context = extractAmpContext(request);
    assert.equal(context.threadId, "");
    assert.equal(context.mode, "");
    assert.equal(context.overrideProvider, "");
    assert.equal(context.feature, "");
    assert.equal(context.messageId, "");
  });

  await t.test("Mode 'deep' → presets.reasoningEffort = 'high'", () => {
    const request = mockRequest({ "x-amp-mode": "deep" });
    const context = extractAmpContext(request);

    assert.deepEqual(context.presets, { reasoningEffort: "high", toolChoice: "" });
  });

  await t.test("Mode 'rush' → presets.reasoningEffort = 'low'", () => {
    const request = mockRequest({ "x-amp-mode": "rush" });
    const context = extractAmpContext(request);

    assert.deepEqual(context.presets, { reasoningEffort: "low", toolChoice: "" });
  });

  await t.test("Mode 'smart' → presets.reasoningEffort = ''", () => {
    const request = mockRequest({ "x-amp-mode": "smart" });
    const context = extractAmpContext(request);

    assert.deepEqual(context.presets, { reasoningEffort: "", toolChoice: "" });
  });

  await t.test("Unknown mode → presets = null", () => {
    const request = mockRequest({ "x-amp-mode": "unknown-mode" });
    const context = extractAmpContext(request);

    assert.strictEqual(context.presets, null);
  });

  await t.test("Mode is case-insensitive", () => {
    const request = mockRequest({ "x-amp-mode": "DEEP" });
    const context = extractAmpContext(request);

    assert.deepEqual(context.presets, { reasoningEffort: "high", toolChoice: "" });
  });
});
