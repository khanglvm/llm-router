import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAttachedLocalModelDraft,
  buildEditableLlamacppVariantDraft,
  buildLlamacppVariantDraft,
  buildLocalModelsSummary,
  buildManagedLocalModelDraft,
  normalizeLocalVariantContextWindow,
  resolveLocalVariantSaveDisabledReason
} from "./local-models-utils.js";

test("buildLocalModelsSummary reports stale assets and running runtime counts", () => {
  const summary = buildLocalModelsSummary({
    runtime: { llamacpp: { status: "running" }, ollama: { status: "stopped" } },
    library: {
      a: { availability: "available" },
      b: { availability: "stale" }
    },
    variants: {
      v1: { enabled: true, preload: true },
      v2: { enabled: true, preload: false }
    }
  });

  assert.equal(summary.enabledVariants, 2);
  assert.equal(summary.preloadedVariants, 1);
  assert.equal(summary.staleAssets, 1);
  assert.equal(summary.runningRuntimes, 1);
});

test("buildLlamacppVariantDraft seeds a unique balanced variant from a base model", () => {
  const draft = buildLlamacppVariantDraft({
    id: "base-qwen",
    displayName: "Qwen Managed"
  }, {
    existing: { id: "local/qwen-managed-balanced" }
  });

  assert.equal(draft.baseModelId, "base-qwen");
  assert.equal(draft.runtime, "llamacpp");
  assert.equal(draft.name, "Qwen Managed Balanced");
  assert.equal(draft.id, "local/qwen-managed-balanced-2");
  assert.equal(draft.contextWindow, 65536);
  assert.equal(draft.enabled, true);
  assert.equal(draft.preload, false);
});

test("buildEditableLlamacppVariantDraft preserves existing fields and normalizes defaults", () => {
  const draft = buildEditableLlamacppVariantDraft({
    key: "qwen-fast",
    id: "local/qwen-fast",
    name: "Qwen Fast",
    capabilities: { supportsReasoning: true }
  });

  assert.equal(draft.preset, "balanced");
  assert.equal(draft.contextWindow, 65536);
  assert.deepEqual(draft.capabilities, { supportsReasoning: true });
  assert.deepEqual(draft.runtimeProfile, {
    mode: "auto",
    preset: "balanced",
    overrides: {},
    extraArgs: [],
    lastKnownGood: null,
    lastFailure: null
  });
});

test("buildEditableLlamacppVariantDraft clones runtimeProfile fields", () => {
  const variant = {
    runtimeProfile: {
      mode: "custom",
      preset: "memory-safe",
      overrides: { gpuLayers: 0, tuning: { cacheReuse: true } },
      extraArgs: ["--no-warmup"],
      lastKnownGood: { preset: "balanced", overrides: { gpuLayers: 8 } },
      lastFailure: { reason: "oom", detail: { code: "ENOMEM" } }
    }
  };
  const draft = buildEditableLlamacppVariantDraft(variant);

  variant.runtimeProfile.overrides.gpuLayers = 12;
  variant.runtimeProfile.overrides.tuning.cacheReuse = false;
  variant.runtimeProfile.extraArgs.push("--verbose");
  variant.runtimeProfile.lastKnownGood.preset = "fast-response";
  variant.runtimeProfile.lastKnownGood.overrides.gpuLayers = 2;
  variant.runtimeProfile.lastFailure.reason = "timeout";
  variant.runtimeProfile.lastFailure.detail.code = "ETIME";

  assert.deepEqual(draft.runtimeProfile, {
    mode: "custom",
    preset: "memory-safe",
    overrides: { gpuLayers: 0, tuning: { cacheReuse: true } },
    extraArgs: ["--no-warmup"],
    lastKnownGood: { preset: "balanced", overrides: { gpuLayers: 8 } },
    lastFailure: { reason: "oom", detail: { code: "ENOMEM" } }
  });
});

test("resolveLocalVariantSaveDisabledReason validates required variant fields", () => {
  assert.match(resolveLocalVariantSaveDisabledReason({}, new Set()), /variant name is required/i);
  assert.match(resolveLocalVariantSaveDisabledReason({ name: "Qwen" }, new Set()), /model id is required/i);
  assert.match(
    resolveLocalVariantSaveDisabledReason({ name: "Qwen", id: "local/qwen", contextWindow: "65536" }, new Set(["local/qwen"])),
    /already exists/i
  );
  assert.match(
    resolveLocalVariantSaveDisabledReason({ name: "Qwen", id: "local/qwen", contextWindow: "abc" }, new Set()),
    /context window/i
  );
  assert.equal(
    resolveLocalVariantSaveDisabledReason({ name: "Qwen", id: "local/qwen", contextWindow: "65,536" }, new Set()),
    ""
  );
});

test("normalizeLocalVariantContextWindow strips formatting and rejects invalid values", () => {
  assert.equal(normalizeLocalVariantContextWindow("200,000"), 200000);
  assert.equal(normalizeLocalVariantContextWindow("0"), undefined);
  assert.equal(normalizeLocalVariantContextWindow("abc"), undefined);
});

test("buildManagedLocalModelDraft derives a unique id and display name from a hugging face file", () => {
  const draft = buildManagedLocalModelDraft({
    repo: "org/Qwen-Model",
    file: "qwen.Q5_K_M.gguf"
  }, {
    existing: { id: "org-qwen-model-qwen-q5-k-m" }
  });

  assert.equal(draft.id, "org-qwen-model-qwen-q5-k-m-2");
  assert.equal(draft.displayName, "qwen.Q5_K_M.gguf");
  assert.equal(draft.repo, "org/Qwen-Model");
  assert.equal(draft.file, "qwen.Q5_K_M.gguf");
});

test("buildAttachedLocalModelDraft derives a unique id and display name from a file path", () => {
  const draft = buildAttachedLocalModelDraft("/Volumes/models/Qwen3/qwen-local.Q5.gguf", {
    existing: { id: "qwen-local-q5" }
  });

  assert.equal(draft.id, "qwen-local-q5-2");
  assert.equal(draft.displayName, "qwen-local.Q5.gguf");
  assert.equal(draft.filePath, "/Volumes/models/Qwen3/qwen-local.Q5.gguf");
});
