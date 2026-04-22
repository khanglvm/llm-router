import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyGgufCandidateForMac,
  shapeHuggingFaceGgufResults
} from "./huggingface-gguf.js";

test("shapeHuggingFaceGgufResults keeps unsupported candidates visible with explicit disabled reasons", () => {
  const results = shapeHuggingFaceGgufResults([
    { repo: "org/model", file: "model.Q5_K_M.gguf", size: 24 * 1024 ** 3 },
    { repo: "org/model", file: "model.safetensors", size: 24 * 1024 ** 3 }
  ], { totalMemoryBytes: 64 * 1024 ** 3 });

  assert.equal(results[0].disabled, false);
  assert.equal(results[1].disabled, true);
  assert.match(results[1].disabledReason, /not a gguf file/i);
});

test("classifyGgufCandidateForMac flags oversized files as over budget", () => {
  const status = classifyGgufCandidateForMac(
    { sizeBytes: 80 * 1024 ** 3, file: "model.Q5_K_M.gguf" },
    { totalMemoryBytes: 64 * 1024 ** 3 }
  );
  assert.equal(status.fit, "over-budget");
  assert.match(status.reason, /too large/i);
});
