import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLlamacppLaunchArgs,
  detectLlamacppCandidates,
  parseLlamacppValidationOutput,
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

test("startConfiguredLlamacppRuntime derives launch profile without referencing an undefined deps binding", async () => {
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
        unref() {}
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(spawnCalls.length, 1);
  assert.match(spawnCalls[0][1].join(" "), /-a local\/qwen-balanced/);
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
