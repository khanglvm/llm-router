import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalModelsSummary } from "./local-models-utils.js";

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
