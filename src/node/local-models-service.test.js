import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileLocalModelPaths,
  registerAttachedLlamacppModel,
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
