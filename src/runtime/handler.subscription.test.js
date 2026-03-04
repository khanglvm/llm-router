import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { FORMATS } from "../translator/index.js";
import { makeProviderCall } from "./handler/provider-call.js";
import { CODEX_ENDPOINT } from "./codex-request-transformer.js";
import { saveTokens } from "./subscription-tokens.js";

function restoreHomeValue(originalHomeValue) {
  if (originalHomeValue === undefined) {
    delete process.env.HOME;
    return;
  }
  process.env.HOME = originalHomeValue;
}

function buildSubscriptionCandidate() {
  return {
    provider: {
      id: "chatgpt",
      name: "ChatGPT Subscription",
      type: "subscription",
      subscriptionType: "chatgpt-codex",
      subscriptionProfile: "personal",
      models: [{ id: "gpt-5.3-codex" }]
    },
    targetFormat: FORMATS.OPENAI,
    backend: "gpt-5.3-codex"
  };
}

test("makeProviderCall translates Claude request for subscription Codex provider", { concurrency: false }, async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-subscription-test-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => restoreHomeValue(originalHome));
  t.after(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  await saveTokens("personal", {
    accessToken: "token-abc",
    refreshToken: "refresh-abc",
    expiresAt: Date.now() + 10 * 60 * 1000,
    tokenType: "Bearer",
    scope: "openid"
  });

  const originalFetch = globalThis.fetch;
  let capturedRequest = null;
  globalThis.fetch = async (url, init = {}) => {
    capturedRequest = {
      url: String(url),
      headers: init.headers || {},
      body: JSON.parse(String(init.body || "{}"))
    };
    return new Response(JSON.stringify({
      id: "resp_1",
      object: "response",
      created_at: 1730000000,
      model: "gpt-5.3-codex",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "subscription-ok"
            }
          ]
        }
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 2,
        total_tokens: 6
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await makeProviderCall({
    body: {
      model: "chatgpt/gpt-5.3-codex",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello from Claude" }]
        }
      ]
    },
    sourceFormat: FORMATS.CLAUDE,
    stream: false,
    candidate: buildSubscriptionCandidate(),
    requestHeaders: new Headers({ "anthropic-version": "2023-06-01" }),
    env: {}
  });

  assert.equal(result.ok, true);
  assert.equal(capturedRequest?.url, CODEX_ENDPOINT);
  assert.equal(capturedRequest?.headers?.Authorization, "Bearer token-abc");
  assert.equal(capturedRequest?.body?.model, "gpt-5.3-codex");
  assert.equal(capturedRequest?.body?.instructions, "You are a helpful assistant.");
  assert.equal(capturedRequest?.body?.store, false);
  assert.deepEqual(capturedRequest?.body?.include, []);
  assert.equal(capturedRequest?.body?.stream, true);
  assert.equal(capturedRequest?.body?.max_tokens, undefined);
  assert.equal(capturedRequest?.body?.messages, undefined);
  assert.equal(capturedRequest?.body?.input?.[0]?.type, "message");
  assert.equal(capturedRequest?.body?.input?.[0]?.role, "user");
  assert.equal(capturedRequest?.body?.input?.[0]?.content?.[0]?.type, "input_text");
  assert.equal(capturedRequest?.body?.input?.[0]?.content?.[0]?.text, "Hello from Claude");
  const claudeJson = await result.response.json();
  assert.equal(claudeJson.type, "message");
  assert.equal(claudeJson.role, "assistant");
  assert.equal(claudeJson.content?.[0]?.type, "text");
  assert.equal(claudeJson.content?.[0]?.text, "subscription-ok");
});

test("makeProviderCall returns auth error when subscription profile is not logged in", { concurrency: false }, async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-subscription-test-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => restoreHomeValue(originalHome));
  t.after(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  const result = await makeProviderCall({
    body: {
      model: "chatgpt/gpt-5.3-codex",
      messages: [{ role: "user", content: "hello" }]
    },
    sourceFormat: FORMATS.OPENAI,
    stream: false,
    candidate: buildSubscriptionCandidate(),
    requestHeaders: new Headers(),
    env: {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  const payload = await result.response.json();
  assert.match(String(payload?.error?.message || ""), /Not authenticated/);
});

test("makeProviderCall retries subscription request after unsupported max_tokens errors", { concurrency: false }, async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-subscription-test-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => restoreHomeValue(originalHome));
  t.after(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  await saveTokens("personal", {
    accessToken: "token-abc",
    refreshToken: "refresh-abc",
    expiresAt: Date.now() + 10 * 60 * 1000,
    tokenType: "Bearer",
    scope: "openid"
  });

  const originalFetch = globalThis.fetch;
  const capturedBodies = [];
  let callCount = 0;
  globalThis.fetch = async (_url, init = {}) => {
    callCount += 1;
    capturedBodies.push(JSON.parse(String(init.body || "{}")));
    if (callCount === 1) {
      return new Response(JSON.stringify({
        detail: "Unsupported parameter: max_tokens"
      }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      id: "resp_retry",
      object: "response",
      created_at: 1730003333,
      model: "gpt-5.3-codex",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "retry-ok" }]
        }
      ],
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await makeProviderCall({
    body: {
      model: "chatgpt/gpt-5.3-codex",
      text: {
        max_tokens: 8
      },
      messages: [{ role: "user", content: "Hello retry path" }]
    },
    sourceFormat: FORMATS.OPENAI,
    stream: false,
    candidate: buildSubscriptionCandidate(),
    requestHeaders: new Headers(),
    env: {}
  });

  assert.equal(result.ok, true);
  assert.equal(callCount, 2);
  assert.equal(capturedBodies[0]?.text?.max_tokens, 8);
  assert.equal(capturedBodies[1]?.text?.max_tokens, undefined);
  const openaiJson = await result.response.json();
  assert.equal(openaiJson.object, "chat.completion");
  assert.equal(openaiJson.choices?.[0]?.message?.content, "retry-ok");
});

test("makeProviderCall converts non-stream subscription response to OpenAI chat completion for OpenAI source", { concurrency: false }, async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-subscription-test-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => restoreHomeValue(originalHome));
  t.after(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  await saveTokens("personal", {
    accessToken: "token-abc",
    refreshToken: "refresh-abc",
    expiresAt: Date.now() + 10 * 60 * 1000,
    tokenType: "Bearer",
    scope: "openid"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "resp_openai",
    object: "response",
    created_at: 1730001111,
    model: "gpt-5.3-codex",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello-openai" }]
      }
    ],
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5
    }
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await makeProviderCall({
    body: {
      model: "chatgpt/gpt-5.3-codex",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello OpenAI" }]
    },
    sourceFormat: FORMATS.OPENAI,
    stream: false,
    candidate: buildSubscriptionCandidate(),
    requestHeaders: new Headers(),
    env: {}
  });

  assert.equal(result.ok, true);
  const openaiJson = await result.response.json();
  assert.equal(openaiJson.object, "chat.completion");
  assert.equal(openaiJson.model, "gpt-5.3-codex");
  assert.equal(openaiJson.choices?.[0]?.message?.role, "assistant");
  assert.equal(openaiJson.choices?.[0]?.message?.content, "hello-openai");
  assert.equal(openaiJson.choices?.[0]?.finish_reason, "stop");
});

test("makeProviderCall converts streaming subscription response to Claude SSE events", { concurrency: false }, async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-subscription-test-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => restoreHomeValue(originalHome));
  t.after(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  await saveTokens("personal", {
    accessToken: "token-abc",
    refreshToken: "refresh-abc",
    expiresAt: Date.now() + 10 * 60 * 1000,
    tokenType: "Bearer",
    scope: "openid"
  });

  const responseSse = [
    "event: response.created",
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream\",\"created_at\":1730000002,\"model\":\"gpt-5.3-codex\"}}",
    "",
    "event: response.output_text.delta",
    "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"output_index\":0,\"content_index\":0,\"delta\":\"pong\"}",
    "",
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stream\",\"created_at\":1730000002,\"model\":\"gpt-5.3-codex\",\"output\":[{\"type\":\"message\",\"id\":\"msg_1\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"pong\"}]}],\"usage\":{\"input_tokens\":2,\"output_tokens\":1,\"total_tokens\":3},\"incomplete_details\":null}}",
    "",
    ""
  ].join("\n");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(responseSse, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await makeProviderCall({
    body: {
      model: "chatgpt/gpt-5.3-codex",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello from Claude" }]
        }
      ]
    },
    sourceFormat: FORMATS.CLAUDE,
    stream: true,
    candidate: buildSubscriptionCandidate(),
    requestHeaders: new Headers({ "anthropic-version": "2023-06-01" }),
    env: {}
  });

  assert.equal(result.ok, true);
  const streamPayload = await result.response.text();
  assert.match(streamPayload, /event: message_start/);
  assert.match(streamPayload, /event: content_block_delta/);
  assert.match(streamPayload, /pong/);
  assert.match(streamPayload, /event: message_stop/);
});
