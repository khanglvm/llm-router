import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  reconcileLocalModelPaths,
  registerAttachedLlamacppModel,
  registerManagedLlamacppModel,
  updateLocalBaseModelPath,
  saveLocalModelVariant,
  removeLocalBaseModel
} from "./local-models-service.js";

test("registerAttachedLlamacppModel stores an attached base model without copying the file", async () => {
  const next = await registerAttachedLlamacppModel({ metadata: { localModels: {} } }, {
    id: "base-qwen",
    displayName: "Qwen External",
    filePath: "/Volumes/models/qwen.gguf"
  });

  assert.equal(next.metadata.localModels.library["base-qwen"].source, "llamacpp-attached");
  assert.equal(next.metadata.localModels.library["base-qwen"].path, "/Volumes/models/qwen.gguf");
});

test("reconcileLocalModelPaths marks missing base models and variants as stale", async () => {
  const next = await reconcileLocalModelPaths({
    metadata: {
      localModels: {
        library: {
          "base-qwen": { id: "base-qwen", path: "/missing/qwen.gguf", availability: "available" }
        },
        variants: {
          "variant-qwen": { key: "variant-qwen", baseModelId: "base-qwen", availability: "available" }
        }
      }
    }
  }, {
    pathExists: async () => false
  });

  assert.equal(next.metadata.localModels.library["base-qwen"].availability, "stale");
  assert.equal(next.metadata.localModels.variants["variant-qwen"].availability, "stale");
});

test("removeLocalBaseModel removes the base model and descendant variants", async () => {
  const next = await removeLocalBaseModel({
    metadata: {
      localModels: {
        library: {
          "base-qwen": { id: "base-qwen", path: "/models/qwen.gguf" }
        },
        variants: {
          "variant-qwen": { key: "variant-qwen", baseModelId: "base-qwen" },
          "variant-other": { key: "variant-other", baseModelId: "base-other" }
        }
      }
    }
  }, "base-qwen");

  assert.equal(next.metadata.localModels.library["base-qwen"], undefined);
  assert.equal(next.metadata.localModels.variants["variant-qwen"], undefined);
  assert.ok(next.metadata.localModels.variants["variant-other"]);
});

test("updateLocalBaseModelPath repairs a stale base model and descendant variants", async () => {
  const next = await updateLocalBaseModelPath({
    metadata: {
      localModels: {
        library: {
          "base-qwen": {
            id: "base-qwen",
            path: "/missing/qwen.gguf",
            availability: "stale"
          }
        },
        variants: {
          "variant-qwen": {
            key: "variant-qwen",
            baseModelId: "base-qwen",
            availability: "stale"
          }
        }
      }
    }
  }, "base-qwen", "/Volumes/models/qwen.gguf");

  assert.equal(next.metadata.localModels.library["base-qwen"].path, "/Volumes/models/qwen.gguf");
  assert.equal(next.metadata.localModels.library["base-qwen"].availability, "available");
  assert.equal(next.metadata.localModels.variants["variant-qwen"].availability, "available");
});

test("registerManagedLlamacppModel stores a managed base model in the router-owned location", async () => {
  const next = await registerManagedLlamacppModel({ metadata: { localModels: {} } }, {
    id: "base-qwen-managed",
    displayName: "Qwen Managed",
    filePath: path.join(os.homedir(), ".llm-router", "local-models", "Qwen", "qwen.Q5.gguf"),
    repo: "Qwen/Qwen",
    file: "qwen.Q5.gguf",
    sizeBytes: 24 * 1024 ** 3
  });

  assert.equal(next.metadata.localModels.library["base-qwen-managed"].source, "llamacpp-managed");
  assert.equal(next.metadata.localModels.library["base-qwen-managed"].managed, true);
  assert.equal(next.metadata.localModels.library["base-qwen-managed"].metadata.repo, "Qwen/Qwen");
});

test("saveLocalModelVariant blocks enabling a variant that exceeds the Mac unified-memory budget", async () => {
  await assert.rejects(
    saveLocalModelVariant({
      metadata: {
        localModels: {
          library: {
            "base-qwen": {
              id: "base-qwen",
              metadata: { sizeBytes: 24 * 1024 ** 3 }
            }
          },
          variants: {
            active: {
              key: "active",
              baseModelId: "base-qwen",
              id: "local/active",
              name: "Active",
              runtime: "llamacpp",
              enabled: true,
              preload: true,
              estimatedBytes: 28 * 1024 ** 3
            }
          }
        }
      }
    }, {
      key: "candidate",
      baseModelId: "base-qwen",
      id: "local/candidate",
      name: "Candidate",
      runtime: "llamacpp",
      enabled: true,
      preload: true,
      contextWindow: 200000
    }, {
      system: {
        platform: "darwin",
        totalMemoryBytes: 64 * 1024 ** 3,
        unifiedMemory: true
      }
    }),
    /capacity/i
  );
});

test("saveLocalModelVariant persists runtimeProfile and runtimeStatus fields", async () => {
  const next = await saveLocalModelVariant({
    metadata: {
      localModels: {
        library: {
          "base-qwen": {
            id: "base-qwen",
            metadata: { sizeBytes: 24 * 1024 ** 3 }
          }
        },
        variants: {}
      }
    }
  }, {
    key: "qwen-balanced",
    baseModelId: "base-qwen",
    id: "local/qwen-balanced",
    name: "Qwen Balanced",
    runtime: "llamacpp",
    enabled: true,
    contextWindow: 65536,
    runtimeProfile: {
      mode: "custom",
      preset: "memory-safe",
      overrides: { gpuLayers: 0, batchSize: 64 },
      extraArgs: ["--no-warmup"]
    }
  });

  assert.equal(next.metadata.localModels.variants["qwen-balanced"].runtimeProfile.mode, "custom");
  assert.equal(next.metadata.localModels.variants["qwen-balanced"].runtimeProfile.overrides.gpuLayers, 0);
  assert.equal(next.metadata.localModels.variants["qwen-balanced"].runtimeStatus.lastFailure, null);
});
