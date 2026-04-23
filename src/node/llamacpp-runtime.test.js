import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLlamacppLaunchArgs,
  detectLlamacppCandidates,
  parseLlamacppValidationOutput,
  spawnManagedLlamacppRuntime,
  stopManagedLlamacppRuntime,
  startConfiguredLlamacppRuntime
} from "./llamacpp-runtime.js";

test("detectLlamacppCandidates returns PATH and common Homebrew candidates without duplicates", () => {
  const candidates = detectLlamacppCandidates({
    envPathEntries: ["/opt/homebrew/bin", "/usr/local/bin"],
    existingPaths: new Set(["/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"])
  });

  assert.deepEqual(candidates.map((entry) => entry.path), [
    "/opt/homebrew/bin/llama-server",
    "/usr/local/bin/llama-server"
  ]);
});

test("detectLlamacppCandidates includes common source-build TurboQuant runtimes under the home directory", () => {
  const candidates = detectLlamacppCandidates({
    envPathEntries: [],
    homeDir: "/Users/tester",
    existingPaths: new Set(["/Users/tester/src/llama-cpp-turboquant/build/bin/llama-server"])
  });

  assert.deepEqual(candidates.map((entry) => entry.path), [
    "/Users/tester/src/llama-cpp-turboquant/build/bin/llama-server"
  ]);
  assert.equal(candidates[0].source, "source-build");
});

test("buildLlamacppLaunchArgs includes host/port and selected model preload settings", () => {
  const args = buildLlamacppLaunchArgs({
    command: "/opt/homebrew/bin/llama-server",
    host: "127.0.0.1",
    port: 39391,
    preloadModels: [
      { modelPath: "/tmp/qwen.gguf", contextWindow: 65536, variantId: "local/qwen-balanced" }
    ]
  });

  assert.equal(args[0], "/opt/homebrew/bin/llama-server");
  assert.match(args.join(" "), /--host 127\.0\.0\.1/);
  assert.match(args.join(" "), /--port 39391/);
  assert.match(args.join(" "), /qwen\.gguf/);
});

test("buildLlamacppLaunchArgs appends derived launch profile arguments", () => {
  const args = buildLlamacppLaunchArgs({
    command: "/opt/homebrew/bin/llama-server",
    host: "127.0.0.1",
    port: 39391,
    launchProfile: {
      args: ["-m", "/tmp/qwen.gguf", "-a", "local/qwen-balanced", "-c", "65536", "-ngl", "0"]
    }
  });

  assert.equal(args[0], "/opt/homebrew/bin/llama-server");
  assert.match(args.join(" "), /-a local\/qwen-balanced/);
  assert.match(args.join(" "), /-ngl 0/);
});

test("spawnManagedLlamacppRuntime returns process metadata and expanded args", async () => {
  const spawnCalls = [];
  const runtime = await spawnManagedLlamacppRuntime({
    command: "/opt/homebrew/bin/llama-server",
    host: "127.0.0.1",
    port: 39391,
    launchProfile: {
      args: ["-m", "/tmp/qwen.gguf", "-a", "local/qwen-balanced", "-c", "65536", "-ngl", "0"]
    }
  }, {
    spawnImpl(command, args) {
      spawnCalls.push({ command, args });
      return { pid: 3210 };
    }
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "/opt/homebrew/bin/llama-server");
  assert.equal(spawnCalls[0].args[0], "--host");
  assert.match(spawnCalls[0].args.join(" "), /-a local\/qwen-balanced/);
  assert.equal(runtime.pid, 3210);
  assert.equal(runtime.baseUrl, "http://127.0.0.1:39391/v1");
});

test("startConfiguredLlamacppRuntime derives launch profile without referencing an undefined deps binding", async () => {
  await stopManagedLlamacppRuntime();
  const spawnCalls = [];
  const result = await startConfiguredLlamacppRuntime({
    metadata: {
      localModels: {
        runtime: {
          llamacpp: {
            startWithRouter: true,
            command: "/opt/homebrew/bin/llama-server",
            host: "127.0.0.1",
            port: 39391
          }
        },
        library: {
          "base-qwen": {
            id: "base-qwen",
            path: "/tmp/qwen.gguf",
            metadata: { sizeBytes: 24 * 1024 ** 3 }
          }
        },
        variants: {
          "qwen-balanced": {
            id: "local/qwen-balanced",
            key: "qwen-balanced",
            baseModelId: "base-qwen",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 2048,
            runtimeProfile: {
              mode: "auto",
              preset: "balanced",
              overrides: {},
              extraArgs: [],
              lastKnownGood: null,
              lastFailure: null
            }
          }
        }
      }
    }
  }, {}, {
    spawnSyncImpl() {
      return {
        stdout: `
llama-server build 9999
  --host HOST
  --port PORT
-m,    --model FNAME
`,
        stderr: ""
      };
    },
    spawnImpl(command, args) {
      spawnCalls.push([command, args]);
      return {
        exitCode: null,
        killed: false,
        once(event, handler) {
          if (event === "spawn") queueMicrotask(handler);
        },
        unref() {},
        kill() {
          this.killed = true;
          this.exitCode = 0;
          return true;
        }
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(spawnCalls.length, 1);
  assert.match(spawnCalls[0][1].join(" "), /-a local\/qwen-balanced/);
  await stopManagedLlamacppRuntime();
});

test("startConfiguredLlamacppRuntime tracks registry instances and marks compatible launches as already running", async () => {
  await stopManagedLlamacppRuntime();
  const spawnCalls = [];
  const activePids = new Set();
  const config = {
    metadata: {
      localModels: {
        runtime: {
          llamacpp: {
            startWithRouter: true,
            command: "/opt/homebrew/bin/llama-server",
            host: "127.0.0.1",
            port: 39391
          }
        },
        library: {
          "base-qwen": {
            id: "base-qwen",
            path: "/tmp/qwen.gguf",
            metadata: { sizeBytes: 24 * 1024 ** 3 }
          }
        },
        variants: {
          "qwen-balanced": {
            id: "local/qwen-balanced",
            key: "qwen-balanced",
            baseModelId: "base-qwen",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 4096,
            runtimeProfile: {
              mode: "auto",
              preset: "balanced",
              overrides: {},
              extraArgs: [],
              lastKnownGood: null,
              lastFailure: null
            }
          }
        }
      }
    }
  };

  const deps = {
    spawnSyncImpl() {
      return {
        stdout: `
llama-server build 9999
  --host HOST
  --port PORT
-m,    --model FNAME
`,
        stderr: ""
      };
    },
    spawnImpl(command, args) {
      spawnCalls.push([command, args]);
      const pid = 5100 + spawnCalls.length;
      activePids.add(pid);
      return {
        pid,
        exitCode: null,
        killed: false,
        once(event, handler) {
          if (event === "spawn") queueMicrotask(handler);
        },
        unref() {},
        kill() {
          this.killed = true;
          this.exitCode = 0;
          activePids.delete(pid);
          return true;
        }
      };
    },
    listListeningPids() {
      return [...activePids];
    }
  };

  const first = await startConfiguredLlamacppRuntime(config, {}, deps);
  const second = await startConfiguredLlamacppRuntime(config, {}, deps);

  assert.equal(first.ok, true);
  assert.equal(first.runtime?.owner, "llm-router");
  assert.match(String(first.runtime?.instanceId || ""), /qwen-balanced/);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyRunning, true);
  assert.equal(spawnCalls.length, 1);

  await stopManagedLlamacppRuntime();
});

test("startConfiguredLlamacppRuntime reconciles stale router-owned tracked runtime before reuse", async () => {
  await stopManagedLlamacppRuntime();
  const spawnCalls = [];
  const stoppedPids = [];
  let spawnedPid = 5300;
  const config = {
    metadata: {
      localModels: {
        runtime: {
          llamacpp: {
            startWithRouter: true,
            command: "/opt/homebrew/bin/llama-server",
            host: "127.0.0.1",
            port: 39391
          }
        },
        library: {
          "base-qwen": {
            id: "base-qwen",
            path: "/tmp/qwen.gguf"
          }
        },
        variants: {
          "qwen-balanced": {
            id: "local/qwen-balanced",
            key: "qwen-balanced",
            baseModelId: "base-qwen",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 4096,
            runtimeProfile: {
              mode: "auto",
              preset: "balanced",
              overrides: {},
              extraArgs: [],
              lastKnownGood: null,
              lastFailure: null
            }
          }
        }
      }
    }
  };

  const deps = {
    spawnSyncImpl() {
      return {
        stdout: `
llama-server build 9999
  --host HOST
  --port PORT
-m,    --model FNAME
`,
        stderr: ""
      };
    },
    spawnImpl(command, args) {
      spawnCalls.push([command, args]);
      spawnedPid += 1;
      return {
        pid: spawnedPid,
        exitCode: null,
        killed: false,
        once(event, handler) {
          if (event === "spawn") queueMicrotask(handler);
        },
        unref() {},
        kill() {
          this.killed = true;
          this.exitCode = 0;
          return true;
        }
      };
    },
    listListeningPids() {
      return [];
    },
    stopProcessByPid(pid) {
      stoppedPids.push(pid);
      return { ok: true };
    }
  };

  const first = await startConfiguredLlamacppRuntime(config, {}, deps);
  const second = await startConfiguredLlamacppRuntime(config, {}, deps);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyRunning, undefined);
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(stoppedPids, [first.runtime?.pid]);
  await stopManagedLlamacppRuntime();
});

test("startConfiguredLlamacppRuntime preserves healthy tracked runtime when probe result is unknown", async () => {
  await stopManagedLlamacppRuntime();
  const spawnCalls = [];
  const stopCalls = [];
  const config = {
    metadata: {
      localModels: {
        runtime: {
          llamacpp: {
            startWithRouter: true,
            command: "/opt/homebrew/bin/llama-server",
            host: "127.0.0.1",
            port: 39391
          }
        },
        library: {
          "base-qwen": {
            id: "base-qwen",
            path: "/tmp/qwen.gguf"
          }
        },
        variants: {
          "qwen-balanced": {
            id: "local/qwen-balanced",
            key: "qwen-balanced",
            baseModelId: "base-qwen",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 4096,
            runtimeProfile: {
              mode: "auto",
              preset: "balanced",
              overrides: {},
              extraArgs: [],
              lastKnownGood: null,
              lastFailure: null
            }
          }
        }
      }
    }
  };

  const deps = {
    spawnSyncImpl() {
      return {
        stdout: `
llama-server build 9999
  --host HOST
  --port PORT
-m,    --model FNAME
`,
        stderr: ""
      };
    },
    spawnImpl(command, args) {
      spawnCalls.push([command, args]);
      return {
        pid: 9501,
        exitCode: null,
        killed: false,
        once(event, handler) {
          if (event === "spawn") queueMicrotask(handler);
        },
        unref() {},
        kill() {
          this.killed = true;
          this.exitCode = 0;
          return true;
        }
      };
    },
    listListeningPids() {
      return { ok: false, pids: [] };
    },
    stopProcessByPid(pid) {
      stopCalls.push(pid);
      return { ok: true };
    }
  };

  const first = await startConfiguredLlamacppRuntime(config, {}, deps);
  const second = await startConfiguredLlamacppRuntime(config, {}, deps);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyRunning, true);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(stopCalls, []);
  await stopManagedLlamacppRuntime();
});

test("stopManagedLlamacppRuntime stops all registry-tracked managed runtimes", async () => {
  await stopManagedLlamacppRuntime();
  const killed = [];
  const activePids = new Set();
  const validationDeps = {
    spawnSyncImpl() {
      return {
        stdout: `
llama-server build 9999
  --host HOST
  --port PORT
-m,    --model FNAME
`,
        stderr: ""
      };
    }
  };

  function makeDeps(pid) {
    return {
      ...validationDeps,
      spawnImpl() {
        activePids.add(pid);
        return {
          pid,
          exitCode: null,
          killed: false,
          once(event, handler) {
            if (event === "spawn") queueMicrotask(handler);
          },
          unref() {},
          kill() {
            this.killed = true;
            this.exitCode = 0;
            activePids.delete(pid);
            killed.push(pid);
            return true;
          }
        };
      },
      listListeningPids() {
        return [...activePids];
      }
    };
  }

  const baseRuntime = {
    startWithRouter: true,
    command: "/opt/homebrew/bin/llama-server",
    host: "127.0.0.1",
    port: 39391
  };

  const firstStart = await startConfiguredLlamacppRuntime({
    metadata: {
      localModels: {
        runtime: { llamacpp: baseRuntime },
        library: {
          "base-qwen-a": { id: "base-qwen-a", path: "/tmp/qwen-a.gguf" }
        },
        variants: {
          "qwen-balanced": {
            id: "local/qwen-balanced",
            key: "qwen-balanced",
            baseModelId: "base-qwen-a",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 4096,
            runtimeProfile: { mode: "auto", preset: "balanced", overrides: {}, extraArgs: [], lastKnownGood: null, lastFailure: null }
          }
        }
      }
    }
  }, {}, makeDeps(7001));

  const secondStart = await startConfiguredLlamacppRuntime({
    metadata: {
      localModels: {
        runtime: { llamacpp: baseRuntime },
        library: {
          "base-qwen-b": { id: "base-qwen-b", path: "/tmp/qwen-b.gguf" }
        },
        variants: {
          "qwen-throughput": {
            id: "local/qwen-throughput",
            key: "qwen-throughput",
            baseModelId: "base-qwen-b",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 16384,
            runtimeProfile: { mode: "auto", preset: "throughput", overrides: {}, extraArgs: [], lastKnownGood: null, lastFailure: null }
          }
        }
      }
    }
  }, {}, makeDeps(7002));

  const stopped = await stopManagedLlamacppRuntime();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stoppedCount, 2);
  assert.deepEqual(killed.sort(), [7001, 7002]);
});

test("startConfiguredLlamacppRuntime spawns incompatible runtimes with allocated fallback port args", async () => {
  await stopManagedLlamacppRuntime();
  const spawnCalls = [];
  const activePids = new Set();
  const baseDeps = {
    spawnSyncImpl() {
      return {
        stdout: `
llama-server build 9999
  --host HOST
  --port PORT
-m,    --model FNAME
`,
        stderr: ""
      };
    },
    spawnImpl(command, args) {
      spawnCalls.push([command, args]);
      const pid = 8100 + spawnCalls.length;
      activePids.add(pid);
      return {
        pid,
        exitCode: null,
        killed: false,
        once(event, handler) {
          if (event === "spawn") queueMicrotask(handler);
        },
        unref() {},
        kill() {
          this.killed = true;
          this.exitCode = 0;
          activePids.delete(pid);
          return true;
        }
      };
    },
    listListeningPids() {
      return [...activePids];
    }
  };

  const baseRuntime = {
    startWithRouter: true,
    command: "/opt/homebrew/bin/llama-server",
    host: "127.0.0.1",
    port: 39391
  };

  const firstStart = await startConfiguredLlamacppRuntime({
    metadata: {
      localModels: {
        runtime: { llamacpp: baseRuntime },
        library: {
          "base-qwen-a": { id: "base-qwen-a", path: "/tmp/qwen-a.gguf" }
        },
        variants: {
          "qwen-balanced": {
            id: "local/qwen-balanced",
            key: "qwen-balanced",
            baseModelId: "base-qwen-a",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 4096,
            runtimeProfile: { mode: "auto", preset: "balanced", overrides: {}, extraArgs: [], lastKnownGood: null, lastFailure: null }
          }
        }
      }
    }
  }, {}, baseDeps);

  const secondStart = await startConfiguredLlamacppRuntime({
    metadata: {
      localModels: {
        runtime: { llamacpp: baseRuntime },
        library: {
          "base-qwen-b": { id: "base-qwen-b", path: "/tmp/qwen-b.gguf" }
        },
        variants: {
          "qwen-throughput": {
            id: "local/qwen-throughput",
            key: "qwen-throughput",
            baseModelId: "base-qwen-b",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 16384,
            runtimeProfile: { mode: "auto", preset: "throughput", overrides: {}, extraArgs: [], lastKnownGood: null, lastFailure: null }
          }
        }
      }
    }
  }, {}, baseDeps);

  const allocatedSecondPort = Number(secondStart?.runtime?.port);
  const allocatedFirstPort = Number(firstStart?.runtime?.port);
  assert.equal(spawnCalls.length, 2);
  assert.match(spawnCalls[0][1].join(" "), new RegExp(`--port ${allocatedFirstPort}`));
  assert.equal(firstStart.ok, true);
  assert.equal(secondStart.ok, true);
  assert.notEqual(allocatedSecondPort, allocatedFirstPort);
  assert.match(spawnCalls[1][1].join(" "), new RegExp(`--port ${allocatedSecondPort}`));

  await stopManagedLlamacppRuntime();
});

test("stopManagedLlamacppRuntime drains in-flight startup before returning", async () => {
  await stopManagedLlamacppRuntime();
  const killed = [];
  const activePids = new Set();
  let releaseSpawn;
  const spawnGate = new Promise((resolve) => {
    releaseSpawn = resolve;
  });

  const config = {
    metadata: {
      localModels: {
        runtime: {
          llamacpp: {
            startWithRouter: true,
            command: "/opt/homebrew/bin/llama-server",
            host: "127.0.0.1",
            port: 39391
          }
        },
        library: {
          "base-qwen": { id: "base-qwen", path: "/tmp/qwen.gguf" }
        },
        variants: {
          "qwen-balanced": {
            id: "local/qwen-balanced",
            key: "qwen-balanced",
            baseModelId: "base-qwen",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 4096,
            runtimeProfile: { mode: "auto", preset: "balanced", overrides: {}, extraArgs: [], lastKnownGood: null, lastFailure: null }
          }
        }
      }
    }
  };

  const deps = {
    spawnSyncImpl() {
      return {
        stdout: `
llama-server build 9999
  --host HOST
  --port PORT
-m,    --model FNAME
`,
        stderr: ""
      };
    },
    spawnImpl() {
      const handlers = new Map();
      const child = {
        pid: 9101,
        exitCode: null,
        killed: false,
        once(event, handler) {
          handlers.set(event, handler);
          if (event === "spawn") {
            spawnGate.then(() => {
              activePids.add(this.pid);
              const onSpawn = handlers.get("spawn");
              if (typeof onSpawn === "function") onSpawn();
            });
          }
        },
        unref() {},
        kill() {
          killed.push(this.pid);
          this.killed = true;
          this.exitCode = 0;
          activePids.delete(this.pid);
          const onExit = handlers.get("exit");
          if (typeof onExit === "function") onExit(0);
          return true;
        }
      };
      return child;
    },
    listListeningPids() {
      return [...activePids];
    }
  };

  const startPromise = startConfiguredLlamacppRuntime(config, {}, deps);
  const stopPromise = stopManagedLlamacppRuntime();
  releaseSpawn();
  const [started, stopped] = await Promise.all([startPromise, stopPromise]);

  assert.equal(started.ok, true);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stoppedCount, 1);
  assert.deepEqual(killed, [9101]);
  const secondStop = await stopManagedLlamacppRuntime();
  assert.equal(secondStop.skipped, true);
});

test("stopManagedLlamacppRuntime yields event loop while waiting for configured starts", async () => {
  await stopManagedLlamacppRuntime();
  const spawnCalls = [];
  const config = {
    metadata: {
      localModels: {
        runtime: {
          llamacpp: {
            startWithRouter: true,
            command: "/opt/homebrew/bin/llama-server",
            host: "127.0.0.1",
            port: 39391
          }
        },
        library: {
          "base-qwen": { id: "base-qwen", path: "/tmp/qwen.gguf" }
        },
        variants: {
          "qwen-balanced": {
            id: "local/qwen-balanced",
            key: "qwen-balanced",
            baseModelId: "base-qwen",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 4096,
            runtimeProfile: { mode: "auto", preset: "balanced", overrides: {}, extraArgs: [], lastKnownGood: null, lastFailure: null }
          }
        }
      }
    }
  };

  const deps = {
    spawnSyncImpl() {
      return {
        stdout: `
llama-server build 9999
  --host HOST
  --port PORT
-m,    --model FNAME
`,
        stderr: ""
      };
    },
    spawnImpl(command, args) {
      spawnCalls.push([command, args]);
      const handlers = new Map();
      return {
        pid: 9701,
        exitCode: null,
        killed: false,
        once(event, handler) {
          handlers.set(event, handler);
          if (event === "spawn") {
            setTimeout(() => {
              const onSpawn = handlers.get("spawn");
              if (typeof onSpawn === "function") onSpawn();
            }, 0);
          }
        },
        unref() {},
        kill() {
          this.killed = true;
          this.exitCode = 0;
          const onExit = handlers.get("exit");
          if (typeof onExit === "function") onExit(0);
          return true;
        }
      };
    }
  };

  const startPromise = startConfiguredLlamacppRuntime(config, {}, deps);
  const stopPromise = stopManagedLlamacppRuntime();
  const [started, stopped] = await Promise.all([startPromise, stopPromise]);

  assert.equal(started.ok, true);
  assert.equal(stopped.stoppedCount, 1);
  assert.equal(spawnCalls.length, 1);
  await stopManagedLlamacppRuntime();
});

test("stopManagedLlamacppRuntime keeps alive instances reserved to avoid immediate port reuse", async () => {
  await stopManagedLlamacppRuntime();
  const spawnCalls = [];
  let spawnIndex = 0;
  const stubbornKillCountByPid = new Map();
  const activePids = new Set();

  const deps = {
    spawnSyncImpl() {
      return {
        stdout: `
llama-server build 9999
  --host HOST
  --port PORT
-m,    --model FNAME
`,
        stderr: ""
      };
    },
    spawnImpl(command, args) {
      spawnCalls.push([command, args]);
      spawnIndex += 1;
      const pid = 9200 + spawnIndex;
      const handlers = new Map();
      return {
        pid,
        exitCode: null,
        killed: false,
        once(event, handler) {
          handlers.set(event, handler);
          if (event === "spawn") queueMicrotask(() => {
            activePids.add(pid);
            handler();
          });
        },
        unref() {},
        kill() {
          const prior = stubbornKillCountByPid.get(pid) || 0;
          stubbornKillCountByPid.set(pid, prior + 1);
          if (pid === 9201 && prior === 0) {
            // First runtime ignores first SIGTERM and remains alive.
            return true;
          }
          this.killed = true;
          this.exitCode = 0;
          activePids.delete(pid);
          const onExit = handlers.get("exit");
          if (typeof onExit === "function") onExit(0);
          return true;
        }
      };
    },
    listListeningPids() {
      return [...activePids];
    }
  };

  const baseRuntime = {
    startWithRouter: true,
    command: "/opt/homebrew/bin/llama-server",
    host: "127.0.0.1",
    port: 39391
  };

  await startConfiguredLlamacppRuntime({
    metadata: {
      localModels: {
        runtime: { llamacpp: baseRuntime },
        library: { "base-qwen-a": { id: "base-qwen-a", path: "/tmp/qwen-a.gguf" } },
        variants: {
          "qwen-balanced": {
            id: "local/qwen-balanced",
            key: "qwen-balanced",
            baseModelId: "base-qwen-a",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 4096,
            runtimeProfile: { mode: "auto", preset: "balanced", overrides: {}, extraArgs: [], lastKnownGood: null, lastFailure: null }
          }
        }
      }
    }
  }, {}, deps);

  const firstStop = await stopManagedLlamacppRuntime();
  assert.equal(firstStop.ok, false);
  assert.equal(firstStop.stoppedCount, 1);
  assert.equal(firstStop.pendingExitCount, 1);

  const secondStart = await startConfiguredLlamacppRuntime({
    metadata: {
      localModels: {
        runtime: { llamacpp: baseRuntime },
        library: { "base-qwen-b": { id: "base-qwen-b", path: "/tmp/qwen-b.gguf" } },
        variants: {
          "qwen-throughput": {
            id: "local/qwen-throughput",
            key: "qwen-throughput",
            baseModelId: "base-qwen-b",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 16384,
            runtimeProfile: { mode: "auto", preset: "throughput", overrides: {}, extraArgs: [], lastKnownGood: null, lastFailure: null }
          }
        }
      }
    }
  }, {}, deps);

  assert.equal(secondStart.ok, true);
  const secondStartPort = Number(secondStart.runtime?.port);
  assert.notEqual(secondStartPort, 39391);
  assert.match(spawnCalls[1][1].join(" "), new RegExp(`--port ${secondStartPort}`));

  await stopManagedLlamacppRuntime();
  await stopManagedLlamacppRuntime();
});

test("stopManagedLlamacppRuntime reports non-success when exits are still pending", async () => {
  await stopManagedLlamacppRuntime();
  const deps = {
    spawnSyncImpl() {
      return {
        stdout: `
llama-server build 9999
  --host HOST
  --port PORT
-m,    --model FNAME
`,
        stderr: ""
      };
    },
    spawnImpl() {
      return {
        pid: 9601,
        exitCode: null,
        killed: false,
        once(event, handler) {
          if (event === "spawn") queueMicrotask(handler);
        },
        unref() {},
        kill() {
          // ignore SIGTERM and remain alive
          return true;
        }
      };
    },
    listListeningPids() {
      return [9601];
    }
  };

  const started = await startConfiguredLlamacppRuntime({
    metadata: {
      localModels: {
        runtime: {
          llamacpp: {
            startWithRouter: true,
            command: "/opt/homebrew/bin/llama-server",
            host: "127.0.0.1",
            port: 39391
          }
        },
        library: { "base-qwen": { id: "base-qwen", path: "/tmp/qwen.gguf" } },
        variants: {
          "qwen-balanced": {
            id: "local/qwen-balanced",
            key: "qwen-balanced",
            baseModelId: "base-qwen",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 4096,
            runtimeProfile: { mode: "auto", preset: "balanced", overrides: {}, extraArgs: [], lastKnownGood: null, lastFailure: null }
          }
        }
      }
    }
  }, {}, deps);
  assert.equal(started.ok, true);

  const messages = [];
  const stopped = await stopManagedLlamacppRuntime({
    line(message) {
      messages.push(message);
    }
  });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.pendingExitCount, 1);
  assert.equal(stopped.stoppedCount, 1);
  assert.equal(messages.includes("Stopped managed llama.cpp runtime."), false);
});

test("stopManagedLlamacppRuntime does not increment stoppedCount when kill returns false", async () => {
  await stopManagedLlamacppRuntime();
  const deps = {
    spawnSyncImpl() {
      return {
        stdout: `
llama-server build 9999
  --host HOST
  --port PORT
-m,    --model FNAME
`,
        stderr: ""
      };
    },
    spawnImpl() {
      return {
        pid: 9401,
        exitCode: null,
        killed: false,
        once(event, handler) {
          if (event === "spawn") queueMicrotask(handler);
        },
        unref() {},
        kill() {
          return false;
        }
      };
    }
  };

  const started = await startConfiguredLlamacppRuntime({
    metadata: {
      localModels: {
        runtime: {
          llamacpp: {
            startWithRouter: true,
            command: "/opt/homebrew/bin/llama-server",
            host: "127.0.0.1",
            port: 39391
          }
        },
        library: { "base-qwen": { id: "base-qwen", path: "/tmp/qwen.gguf" } },
        variants: {
          "qwen-balanced": {
            id: "local/qwen-balanced",
            key: "qwen-balanced",
            baseModelId: "base-qwen",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 4096,
            runtimeProfile: { mode: "auto", preset: "balanced", overrides: {}, extraArgs: [], lastKnownGood: null, lastFailure: null }
          }
        }
      }
    }
  }, {}, deps);
  assert.equal(started.ok, true);

  const stopped = await stopManagedLlamacppRuntime();
  assert.equal(stopped.ok, false);
  assert.equal(stopped.stoppedCount, 0);
  assert.equal(stopped.pendingExitCount, 1);
});

test("parseLlamacppValidationOutput detects llama-server support and TurboQuant builds", () => {
  const validation = parseLlamacppValidationOutput(`
llama-server build 9999
TurboQuant enabled
  --host HOST
  --port PORT
`);

  assert.equal(validation.ok, true);
  assert.equal(validation.kind, "server");
  assert.equal(validation.isTurboQuant, true);
});

test("parseLlamacppValidationOutput accepts TurboQuant help output even when llama-server banner is absent", () => {
  const validation = parseLlamacppValidationOutput(`
ggml_metal_library_init: turbo3 using 4-mag LUT (pre-M5 hardware)
-m,    --model FNAME                    model path to load
--host HOST                             ip address to listen
--port PORT                             port to listen (default: 8080)
`);

  assert.equal(validation.ok, true);
  assert.equal(validation.kind, "server");
  assert.equal(validation.isTurboQuant, true);
});
