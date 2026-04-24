import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { EventEmitter } from "node:events";
import { startDetachedRouterService } from "./instance-state.js";
import { FIXED_LOCAL_ROUTER_HOST, FIXED_LOCAL_ROUTER_PORT } from "./local-server-settings.js";

function createFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {
    child.unrefCalled = true;
  };
  return child;
}

test("startDetachedRouterService includes child stderr when startup exits early", async () => {
  const child = createFakeChild();

  setTimeout(() => {
    child.stderr.write("Config file not found: /tmp/missing.json\n");
    child.emit("exit", 1, null);
  }, 10);

  const result = await startDetachedRouterService({
    cliPath: "src/cli-entry.js",
    configPath: "/tmp/missing.json",
    host: FIXED_LOCAL_ROUTER_HOST,
    port: FIXED_LOCAL_ROUTER_PORT,
    watchConfig: true,
    watchBinary: true,
    requireAuth: false
  }, {
    spawnStartProcess: () => child,
    getActiveRuntimeState: async () => null,
    timeoutMs: 500,
    pollIntervalMs: 25
  });

  assert.equal(result.ok, false);
  assert.match(result.errorMessage, /llm-router exited before becoming ready \(1\)/);
  assert.match(result.errorMessage, /Config file not found: \/tmp\/missing\.json/);
});

test("startDetachedRouterService uses the runtime start command so explicit ports are preserved", async () => {
  const child = createFakeChild();
  let capturedOptions = null;

  const result = await startDetachedRouterService({
    cliPath: "src/cli-entry.js",
    configPath: "/tmp/dev.json",
    host: FIXED_LOCAL_ROUTER_HOST,
    port: FIXED_LOCAL_ROUTER_PORT + 1,
    watchConfig: true,
    watchBinary: false,
    requireAuth: true
  }, {
    spawnStartProcess: (options) => {
      capturedOptions = options;
      return child;
    },
    getActiveRuntimeState: async () => ({
      pid: child.pid,
      host: FIXED_LOCAL_ROUTER_HOST,
      port: FIXED_LOCAL_ROUTER_PORT + 1,
      configPath: "/tmp/dev.json",
      watchConfig: true,
      watchBinary: false,
      requireAuth: true,
      managedByStartup: false
    }),
    timeoutMs: 500,
    pollIntervalMs: 25
  });

  assert.equal(result.ok, true);
  assert.equal(capturedOptions?.startCommand, "start-runtime");
  assert.equal(capturedOptions?.port, FIXED_LOCAL_ROUTER_PORT + 1);
});
