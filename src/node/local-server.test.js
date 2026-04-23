import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { startLocalRouteServer } from "./local-server.js";

async function writeTempConfig(contents) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-local-server-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  return { dir, configPath };
}

test("startLocalRouteServer wires resolveLocalRuntimeBaseUrl into the fetch handler and stops managed runtimes on close", async (t) => {
  const fixture = await writeTempConfig({
    version: 2,
    providers: [],
    modelAliases: {},
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
            name: "Qwen Balanced",
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
  });
  t.after(async () => {
    await rm(fixture.dir, { recursive: true, force: true });
  });

  let capturedOptions = null;
  const startedConfigs = [];
  let fetchHandlerCloseCalls = 0;
  let stopManagedCalls = 0;

  const server = await startLocalRouteServer({
    port: 0,
    host: "127.0.0.1",
    configPath: fixture.configPath,
    watchConfig: false,
    createFetchHandlerImpl(options) {
      capturedOptions = options;
      const handler = async () => new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" }
      });
      handler.close = async () => {
        fetchHandlerCloseCalls += 1;
      };
      return handler;
    },
    startConfiguredLlamacppRuntimeImpl: async (config) => {
      startedConfigs.push(config);
      return {
        ok: true,
        runtime: {
          baseUrl: "http://127.0.0.1:40404/v1"
        }
      };
    },
    stopManagedLlamacppRuntimeImpl: async () => {
      stopManagedCalls += 1;
      return { ok: true };
    }
  });

  assert.equal(typeof capturedOptions?.resolveLocalRuntimeBaseUrl, "function");

  const resolvedBaseUrl = await capturedOptions.resolveLocalRuntimeBaseUrl({
    candidate: {
      model: {
        metadata: { localVariantKey: "qwen-balanced" }
      }
    }
  });

  assert.equal(resolvedBaseUrl, "http://127.0.0.1:40404/v1");
  assert.deepEqual(Object.keys(startedConfigs[0].metadata.localModels.variants), ["qwen-balanced"]);
  assert.deepEqual(Object.keys(startedConfigs[0].metadata.localModels.library), ["base-qwen"]);

  await new Promise((resolve) => server.close(resolve));
  assert.equal(fetchHandlerCloseCalls, 1);
  assert.equal(stopManagedCalls, 1);
});
