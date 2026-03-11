import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { loginWithBrowser, getAuthStatus } from "./subscription-auth.js";
import { CODEX_OAUTH_CONFIG } from "./subscription-constants.js";

function restoreHomeValue(originalHomeValue) {
  if (originalHomeValue === undefined) {
    delete process.env.HOME;
    return;
  }
  process.env.HOME = originalHomeValue;
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function requestText(url) {
  return await new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          body
        });
      });
    });
    req.once("error", reject);
  });
}

test("loginWithBrowser does not send OAuth state to token exchange", { concurrency: false }, async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-subscription-auth-test-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => restoreHomeValue(originalHome));
  t.after(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  const port = await getAvailablePort();
  const originalFetch = globalThis.fetch;
  let capturedRequest = null;
  globalThis.fetch = async (url, init = {}) => {
    capturedRequest = {
      url: String(url),
      method: init.method,
      headers: init.headers || {},
      body: JSON.parse(String(init.body || "{}"))
    };
    return new Response(JSON.stringify({
      access_token: "token-abc",
      refresh_token: "refresh-abc",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "openid profile email offline_access"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let resolveAuthUrl;
  const authUrlReady = new Promise((resolve) => {
    resolveAuthUrl = resolve;
  });

  const loginPromise = loginWithBrowser("personal", {
    subscriptionType: "chatgpt-codex",
    port,
    autoOpen: false,
    onUrl(url) {
      resolveAuthUrl(url);
    }
  });

  const authUrl = await authUrlReady;
  const parsedAuthUrl = new URL(authUrl);
  const state = parsedAuthUrl.searchParams.get("state");
  assert.ok(state);

  const callbackUrl = new URL(`http://127.0.0.1:${port}${CODEX_OAUTH_CONFIG.callbackPath}`);
  callbackUrl.searchParams.set("code", "auth-code-123");
  callbackUrl.searchParams.set("state", state);

  const callbackResponse = await requestText(callbackUrl.toString());
  assert.equal(callbackResponse.statusCode, 200);
  assert.match(callbackResponse.body, /Success!/);

  assert.equal(await loginPromise, true);
  assert.equal(capturedRequest?.url, CODEX_OAUTH_CONFIG.tokenUrl);
  assert.equal(capturedRequest?.method, "POST");
  assert.equal(capturedRequest?.body?.grant_type, "authorization_code");
  assert.equal(capturedRequest?.body?.code, "auth-code-123");
  assert.equal(capturedRequest?.body?.state, undefined);

  const authStatus = await getAuthStatus("personal", {
    subscriptionType: "chatgpt-codex"
  });
  assert.equal(authStatus.authenticated, true);
});
