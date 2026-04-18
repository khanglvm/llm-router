import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { startRouterSupervisor } from "./router-supervisor.js";

function createFakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function httpRequest({ port, path = "/", method = "GET", body = "", headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        connection: "close",
        ...headers
      },
      agent: false
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("startRouterSupervisor retries proxy requests while the backend is swapping", async (t) => {
  const originalFetch = globalThis.fetch;
  let backendRuntime = null;
  let fetchAttempts = 0;

  globalThis.fetch = async (url, init = {}) => {
    fetchAttempts += 1;
    if (fetchAttempts === 1) {
      const proxyError = new Error("backend unavailable");
      proxyError.code = "ECONNREFUSED";
      throw proxyError;
    }

    assert.match(String(url), /http:\/\/127\.0\.0\.1:19001\/openai/);
    assert.equal(String(init.method || ""), "POST");
    assert.equal(Buffer.from(init.body || "").toString("utf8"), "{\"hello\":\"world\"}");
    return new Response(JSON.stringify({ ok: true, attempt: fetchAttempts }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const server = await startRouterSupervisor({
    host: "127.0.0.1",
    port: 0,
    backendPort: 19001,
    backendStatePath: "/tmp/llm-router-backend-runtime.test.json",
    configPath: "/tmp/config.json",
    cliPath: "/tmp/llr.js",
    watchConfig: true,
    watchBinary: true,
    requireAuth: false
  }, {
    spawn: () => {
      const child = createFakeChild(5001);
      setTimeout(() => {
        backendRuntime = {
          pid: process.pid,
          host: "127.0.0.1",
          port: 19001,
          configPath: "/tmp/config.json",
          watchConfig: true,
          watchBinary: true,
          requireAuth: false,
          startedAt: new Date().toISOString()
        };
      }, 10);
      return child;
    },
    readRuntimeState: async () => backendRuntime,
    clearRuntimeState: async () => {
      backendRuntime = null;
      return true;
    },
    stopProcessByPid: async () => ({ ok: true, signal: "SIGTERM" }),
    proxyRetryTimeoutMs: 1000,
    proxyRetryIntervalMs: 20,
    backendReadyTimeoutMs: 1000,
    backendHealthPollMs: 1000
  });

  const address = server.address();
  const response = await httpRequest({
    port: Number(address.port),
    path: "/openai",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{\"hello\":\"world\"}"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, attempt: 2 });
  assert.equal(fetchAttempts, 2);

  await new Promise((resolve) => server.close(resolve));
});

test("startRouterSupervisor forwards upgrade signals and stops the active backend on close", async () => {
  let backendRuntime = null;
  const signalCalls = [];
  const stopCalls = [];

  const server = await startRouterSupervisor({
    host: "127.0.0.1",
    port: 0,
    backendPort: 19002,
    backendStatePath: "/tmp/llm-router-backend-runtime-signal.test.json",
    configPath: "/tmp/config.json",
    cliPath: "/tmp/llr.js",
    watchConfig: true,
    watchBinary: true,
    requireAuth: false
  }, {
    spawn: () => {
      const child = createFakeChild(6001);
      setTimeout(() => {
        backendRuntime = {
          pid: process.pid,
          host: "127.0.0.1",
          port: 19002,
          configPath: "/tmp/config.json",
          watchConfig: true,
          watchBinary: true,
          requireAuth: false,
          startedAt: new Date().toISOString()
        };
      }, 10);
      return child;
    },
    readRuntimeState: async () => backendRuntime,
    clearRuntimeState: async () => {
      backendRuntime = null;
      return true;
    },
    signalProcess: (pid, signal) => {
      signalCalls.push({ pid, signal });
    },
    stopProcessByPid: async (pid) => {
      stopCalls.push(pid);
      backendRuntime = null;
      return { ok: true, signal: "SIGTERM" };
    },
    backendReadyTimeoutMs: 1000,
    backendHealthPollMs: 1000
  });

  const signalResult = await server.requestBackendUpgrade("SIGUSR2");
  assert.equal(signalResult.ok, true);
  assert.deepEqual(signalCalls, [{ pid: process.pid, signal: "SIGUSR2" }]);

  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(stopCalls, [process.pid]);
});
