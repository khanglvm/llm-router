import assert from "node:assert/strict";
import test from "node:test";
import { startManagedDevWebConsole } from "./dev-command.js";

test("startManagedDevWebConsole reclaims the existing web console port and retries startup", async () => {
  const reclaimCalls = [];
  const startCalls = [];
  const lineMessages = [];
  const errorMessages = [];
  let attempt = 0;

  const server = await startManagedDevWebConsole({
    host: "127.0.0.1",
    port: 8789,
    configPath: "/tmp/dev-config.json",
    routerPort: 8377,
    devMode: true
  }, {
    startWebConsoleServer: async (options) => {
      startCalls.push(options);
      attempt += 1;
      if (attempt === 1) {
        const error = new Error("listen EADDRINUSE: address already in use 127.0.0.1:8789");
        error.code = "EADDRINUSE";
        throw error;
      }
      return {
        url: "http://127.0.0.1:8789",
        done: Promise.resolve({ reason: "test-finished" }),
        close: async () => ({ ok: true }),
        stopRouter: async () => true
      };
    },
    reclaimPort: async ({ port, line, error }) => {
      reclaimCalls.push(port);
      line("reclaimed existing listener");
      error("no-op");
      return { ok: true };
    },
    line: (message) => lineMessages.push(message),
    error: (message) => errorMessages.push(message)
  });

  assert.equal(server.url, "http://127.0.0.1:8789");
  assert.equal(startCalls.length, 2);
  assert.equal(reclaimCalls.length, 1);
  assert.equal(reclaimCalls[0], 8789);
  assert.match(lineMessages.join("\n"), /Port 8789 reclaimed successfully\./);
  assert.match(errorMessages.join("\n"), /no-op/);
});

test("startManagedDevWebConsole stops and reclaims the managed dev router after the web console exits", async () => {
  const stopCalls = [];

  const server = await startManagedDevWebConsole({
    host: "127.0.0.1",
    port: 8789,
    configPath: "/tmp/dev-config.json",
    routerPort: 8377,
    devMode: true
  }, {
    startWebConsoleServer: async () => ({
      url: "http://127.0.0.1:8789",
      done: Promise.resolve({ reason: "user-exit" }),
      close: async () => ({ ok: true }),
      stopRouter: async (options) => {
        stopCalls.push(options);
        return true;
      }
    })
  });

  const result = await server.done;
  assert.deepEqual(result, { reason: "user-exit" });
  assert.deepEqual(stopCalls, [{
    reason: "Stopping the dev router because the dev web console exited.",
    reclaimPortIfStopped: true
  }]);
});

test("startManagedDevWebConsole shutdown stops the router before closing the web console", async () => {
  const calls = [];
  let resolveDone;

  const server = await startManagedDevWebConsole({
    host: "127.0.0.1",
    port: 8789,
    configPath: "/tmp/dev-config.json",
    routerPort: 8377,
    devMode: true
  }, {
    startWebConsoleServer: async () => ({
      url: "http://127.0.0.1:8789",
      done: new Promise((resolve) => {
        resolveDone = resolve;
      }),
      close: async (reason) => {
        calls.push(`close:${reason}`);
        resolveDone({ reason });
        return { ok: true, reason };
      },
      stopRouter: async (options) => {
        calls.push(`stop:${options.reason}`);
        return true;
      }
    })
  });

  const donePromise = server.done;
  await server.shutdown("sigint");
  const result = await donePromise;

  assert.deepEqual(result, { reason: "sigint" });
  assert.deepEqual(calls, [
    "stop:Stopping the dev router because the dev web console exited.",
    "close:sigint"
  ]);
});

test("startManagedDevWebConsole restarts a matching stale dev router so the new session takes ownership", async () => {
  const restartCalls = [];
  const runtime = {
    pid: 43210,
    host: "127.0.0.1",
    port: 8377,
    configPath: "/tmp/dev-config.json",
    watchConfig: true,
    watchBinary: true,
    requireAuth: false,
    managedByStartup: false
  };
  let runtimeReads = 0;

  await startManagedDevWebConsole({
    host: "127.0.0.1",
    port: 8789,
    configPath: "/tmp/dev-config.json",
    routerHost: "127.0.0.1",
    routerPort: 8377,
    devMode: true
  }, {
    getActiveRuntimeState: async () => {
      runtimeReads += 1;
      return runtime;
    },
    startWebConsoleServer: async () => ({
      url: "http://127.0.0.1:8789",
      done: Promise.resolve({ reason: "test-finished" }),
      close: async () => ({ ok: true }),
      stopRouter: async () => true,
      getSnapshot: async () => ({
        router: {
          running: true
        },
        config: {
          parseError: "",
          providerCount: 1,
          localServer: {
            host: "127.0.0.1",
            port: 8377,
            watchConfig: true,
            watchBinary: true,
            requireAuth: false
          }
        }
      }),
      restartRouter: async (options) => {
        restartCalls.push(options);
        return { message: "Router restarted." };
      }
    })
  });

  assert.equal(runtimeReads >= 2, true);
  assert.deepEqual(restartCalls, [{
    host: "127.0.0.1",
    port: 8377,
    watchConfig: true,
    watchBinary: true,
    requireAuth: false
  }]);
});
