import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEditableLlamacppVariantDraft,
  buildLlamacppVariantDraft,
  buildLocalModelsSummary,
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
