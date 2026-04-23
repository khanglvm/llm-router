import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveLlamacppLaunchProfile,
  estimateLlamacppRuntimeBytes
} from "./llamacpp-runtime-profile.js";

test("deriveLlamacppLaunchProfile falls back to cpu-safe after a Metal OOM failure", () => {
  const profile = deriveLlamacppLaunchProfile({
    variant: {
      id: "local/qwen-balanced",
      contextWindow: 2048,
      runtimeProfile: {
        mode: "auto",
        preset: "balanced",
        lastFailure: {
          category: "metal-oom",
          launchProfileHash: "gpu-balanced"
        }
      }
    },
    baseModel: {
      path: "/models/Qwen.Q5_K_M.gguf",
      metadata: { sizeBytes: 24 * 1024 ** 3 }
    },
    system: {
      platform: "darwin",
      unifiedMemory: true,
      totalMemoryBytes: 64 * 1024 ** 3
    }
  });

  assert.equal(profile.preset, "cpu-safe");
  assert.match(profile.args.join(" "), /-ngl 0/);
  assert.match(profile.args.join(" "), /--no-cont-batching/);
});

test("estimateLlamacppRuntimeBytes adds context and preset overhead", () => {
  const estimate = estimateLlamacppRuntimeBytes({
    sizeBytes: 10 * 1024 ** 3,
    contextWindow: 4096,
    preset: "throughput"
  });

  assert.equal(typeof estimate, "number");
  assert.ok(estimate > 10 * 1024 ** 3);
});
