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
    return new Response(JSON.stringify({ id: "resp_1", object: "response", model: "gpt-5.3-codex" }), {
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
  assert.equal(capturedRequest?.body?.store, false);
  assert.deepEqual(capturedRequest?.body?.include, ["reasoning.encrypted_content"]);
  assert.equal(capturedRequest?.body?.messages?.[0]?.role, "user");
  assert.equal(capturedRequest?.body?.messages?.[0]?.content, "Hello from Claude");
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
