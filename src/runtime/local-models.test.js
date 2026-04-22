import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRuntimeConfig, validateRuntimeConfig } from "./config.js";
import {
  LOCAL_RUNTIME_PROVIDER_ID,
  LOCAL_RUNTIME_PROVIDER_TYPE
} from "./local-models.js";

test("normalizeRuntimeConfig preserves metadata.localModels and materializes enabled local variants", () => {
  const config = normalizeRuntimeConfig({
    version: 2,
    masterKey: "test-key",
    providers: [],
    metadata: {
      localModels: {
        library: {
          "base-qwen": {
            id: "base-qwen",
            source: "llamacpp-managed",
            displayName: "Qwen GGUF",
            path: "/Users/test/.llm-router/local-models/qwen.gguf",
            availability: "available"
          }
        },
        variants: {
          "qwen-balanced": {
            key: "qwen-balanced",
            baseModelId: "base-qwen",
            id: "local/qwen-balanced",
            name: "Qwen Balanced",
            runtime: "llamacpp",
            enabled: true,
            preload: false,
            contextWindow: 65536,
            capabilities: { chat: true, tools: true }
          }
        }
      }
    }
  });

  const localProvider = config.providers.find((provider) => provider.type === LOCAL_RUNTIME_PROVIDER_TYPE);
  assert.ok(localProvider);
  assert.equal(localProvider.id, LOCAL_RUNTIME_PROVIDER_ID);
  assert.deepEqual(localProvider.models.map((model) => model.id), ["local/qwen-balanced"]);
  assert.equal(config.metadata.localModels.variants["qwen-balanced"].name, "Qwen Balanced");
});

test("validateRuntimeConfig rejects duplicate local variant model ids", () => {
  const config = normalizeRuntimeConfig({
    providers: [],
    metadata: {
      localModels: {
        library: {},
        variants: {
          a: { key: "a", baseModelId: "base-a", id: "local/dup", name: "First", runtime: "llamacpp", enabled: true },
          b: { key: "b", baseModelId: "base-b", id: "local/dup", name: "Second", runtime: "llamacpp", enabled: true }
        }
      }
    }
  });

  const errors = validateRuntimeConfig(config, { requireMasterKey: false, requireProvider: false });
  assert.match(errors.join("\n"), /duplicate local variant model id/i);
});

test("normalizeRuntimeConfig materializes local variant capacity metadata", () => {
  const config = normalizeRuntimeConfig({
    providers: [],
    metadata: {
      localModels: {
        library: {
          "base-qwen": {
            id: "base-qwen",
            source: "llamacpp-managed",
            path: "/Users/test/.llm-router/local-models/qwen.gguf",
            availability: "available"
          }
        },
        variants: {
          "qwen-tight": {
            key: "qwen-tight",
            baseModelId: "base-qwen",
            id: "local/qwen-tight",
            name: "Qwen Tight",
            runtime: "llamacpp",
            enabled: true,
            preload: true,
            contextWindow: 131072,
            capacityState: "tight",
            estimatedBytes: 1234
          }
        }
      }
    }
  });

  const localProvider = config.providers.find((provider) => provider.type === LOCAL_RUNTIME_PROVIDER_TYPE);
  assert.equal(localProvider.models[0].metadata.capacityState, "tight");
  assert.equal(localProvider.models[0].metadata.estimatedBytes, 1234);
});
