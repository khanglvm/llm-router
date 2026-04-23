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

test("registry allocates a different port when preferred port is already used by another runtime", async () => {
  const spawnedPorts = [];
  const registry = createLlamacppManagedRuntimeRegistry({
    spawnRuntime: async ({ port }) => {
      spawnedPorts.push(port);
      return { pid: 5000 + spawnedPorts.length, host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}/v1` };
    },
    waitForHealthy: async (instance) => ({ ...instance, healthy: true }),
    listListeningPids: async () => [],
    stopProcessByPid: async () => {}
  });

  const first = await registry.ensureRuntimeForVariant({
    variantKey: "qwen-balanced",
    profileHash: "cpu-safe-qwen",
    launchArgs: ["-m", "/models/qwen-a.gguf", "-ngl", "0"],
    preferredPort: 39391
  });
  const second = await registry.ensureRuntimeForVariant({
    variantKey: "qwen-throughput",
    profileHash: "gpu-fast-qwen",
    launchArgs: ["-m", "/models/qwen-b.gguf", "-ngl", "99"],
    preferredPort: 39391
  });

  assert.equal(first.port, 39391);
  assert.equal(second.port, 39392);
  assert.deepEqual(spawnedPorts, [39391, 39392]);
});

test("registry deduplicates concurrent starts for the same variant/profile key", async () => {
  let spawnCount = 0;
  const registry = createLlamacppManagedRuntimeRegistry({
    spawnRuntime: async ({ port }) => {
      spawnCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { pid: 6000 + spawnCount, host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}/v1` };
    },
    waitForHealthy: async (instance) => ({ ...instance, healthy: true }),
    listListeningPids: async () => [],
    stopProcessByPid: async () => {}
  });

  const [first, second] = await Promise.all([
    registry.ensureRuntimeForVariant({
      variantKey: "qwen-balanced",
      profileHash: "cpu-safe-qwen",
      launchArgs: ["-m", "/models/qwen.gguf", "-ngl", "0"],
      preferredPort: 39391
    }),
    registry.ensureRuntimeForVariant({
      variantKey: "qwen-balanced",
      profileHash: "cpu-safe-qwen",
      launchArgs: ["-m", "/models/qwen.gguf", "-ngl", "0"],
      preferredPort: 39391
    })
  ]);

  assert.equal(spawnCount, 1);
  assert.equal(first.instanceId, second.instanceId);
});

test("registry does not keep dead immediate-exit runtime tracked or reserve its preferred port", async () => {
  const spawnedPorts = [];
  const registry = createLlamacppManagedRuntimeRegistry({
    spawnRuntime: async ({ variantKey, port }) => {
      spawnedPorts.push(port);
      if (variantKey === "dead-first") {
        return {
          pid: 7101,
          host: "127.0.0.1",
          port,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          child: { exitCode: 1, killed: false }
        };
      }
      return {
        pid: 7102,
        host: "127.0.0.1",
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        child: { exitCode: null, killed: false }
      };
    },
    waitForHealthy: async (instance) => ({ ...instance, healthy: true }),
    listListeningPids: async () => [],
    stopProcessByPid: async () => {}
  });

  await assert.rejects(
    registry.ensureRuntimeForVariant({
      variantKey: "dead-first",
      profileHash: "cpu-safe-qwen",
      launchArgs: ["-m", "/models/qwen-a.gguf", "-ngl", "0"],
      preferredPort: 39391
    }),
    /exited/
  );

  const recovered = await registry.ensureRuntimeForVariant({
    variantKey: "healthy-second",
    profileHash: "cpu-safe-qwen-2",
    launchArgs: ["-m", "/models/qwen-b.gguf", "-ngl", "0"],
    preferredPort: 39391
  });

  assert.equal(recovered.port, 39391);
  assert.deepEqual(spawnedPorts, [39391, 39391]);
});

test("registry wraps fallback allocation back into the valid managed port range", async () => {
  const registry = createLlamacppManagedRuntimeRegistry({
    spawnRuntime: async ({ port }) => ({
      pid: port,
      host: "127.0.0.1",
      port,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      child: { exitCode: null, killed: false }
    }),
    waitForHealthy: async (instance) => ({ ...instance, healthy: true })
  });

  const lastPort = await registry.ensureRuntimeForVariant({
    variantKey: "last-port",
    profileHash: "last-port",
    preferredPort: 65535
  });
  const wrapped = await registry.ensureRuntimeForVariant({
      variantKey: "wrapped-variant",
      profileHash: "wrapped-profile",
      preferredPort: 65535
    });

  assert.equal(lastPort.port, 65535);
  assert.equal(wrapped.port, 39391);
});
