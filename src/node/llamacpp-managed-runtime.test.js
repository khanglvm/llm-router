import test from "node:test";
import assert from "node:assert/strict";
import { createLlamacppManagedRuntimeRegistry } from "./llamacpp-managed-runtime.js";

test("registry reuses a compatible managed runtime for the same variant plan", async () => {
  let spawnCount = 0;
  const registry = createLlamacppManagedRuntimeRegistry({
    spawnRuntime: async () => ({
      pid: ++spawnCount,
      host: "127.0.0.1",
      port: 39391,
      baseUrl: "http://127.0.0.1:39391/v1"
    }),
    waitForHealthy: async (instance) => ({ ...instance, healthy: true }),
    listListeningPids: async () => [],
    stopProcessByPid: async () => {}
  });

  const first = await registry.ensureRuntimeForVariant({
    variantKey: "qwen-balanced",
    profileHash: "cpu-safe-qwen",
    launchArgs: ["-m", "/models/qwen.gguf", "-ngl", "0"]
  });
  const second = await registry.ensureRuntimeForVariant({
    variantKey: "qwen-balanced",
    profileHash: "cpu-safe-qwen",
    launchArgs: ["-m", "/models/qwen.gguf", "-ngl", "0"]
  });

  assert.equal(first.instanceId, second.instanceId);
  assert.equal(spawnCount, 1);
});

test("registry reconcile removes dead router-owned runtimes without touching foreign listeners", async () => {
  const stopped = [];
  const registry = createLlamacppManagedRuntimeRegistry({
    spawnRuntime: async () => ({
      pid: 4001,
      host: "127.0.0.1",
      port: 39391,
      baseUrl: "http://127.0.0.1:39391/v1"
    }),
    waitForHealthy: async (instance) => ({ ...instance, healthy: true }),
    listListeningPids: async () => [7777],
    stopProcessByPid: async (pid) => { stopped.push(pid); }
  });

  await registry.trackInstance({
    instanceId: "managed-qwen",
    pid: 4001,
    port: 39391,
    baseUrl: "http://127.0.0.1:39391/v1",
    owner: "llm-router",
    profileHash: "cpu-safe-qwen"
  });

  await registry.reconcile();
  assert.deepEqual(stopped, [4001]);
});
