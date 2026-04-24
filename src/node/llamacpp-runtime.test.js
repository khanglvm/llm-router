import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLlamacppLaunchArgs,
  detectLlamacppCandidates,
  parseLlamacppValidationOutput
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
