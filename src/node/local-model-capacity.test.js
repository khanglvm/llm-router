import test from "node:test";
import assert from "node:assert/strict";
import { classifyVariantCapacity, canActivateVariant } from "./local-model-capacity.js";

test("classifyVariantCapacity marks large long-context variants as over budget on 64 GB Macs", () => {
  const result = classifyVariantCapacity({
    sizeBytes: 24 * 1024 ** 3,
    contextWindow: 200000,
    preload: true
  }, {
    platform: "darwin",
    totalMemoryBytes: 64 * 1024 ** 3,
    unifiedMemory: true
  });

  assert.equal(result.fit, "over-budget");
});

test("canActivateVariant blocks enabling a variant that would exceed the current active budget", () => {
  const decision = canActivateVariant({
    candidate: { estimatedBytes: 20 * 1024 ** 3, preload: true },
    activeVariants: [{ estimatedBytes: 28 * 1024 ** 3, preload: true }],
    totalMemoryBytes: 64 * 1024 ** 3
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /capacity/i);
});
