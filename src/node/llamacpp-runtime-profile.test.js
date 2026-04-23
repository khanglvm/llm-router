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
    preset: "long-context"
  });

  assert.equal(typeof estimate, "number");
  assert.ok(estimate > 10 * 1024 ** 3);
});

test("deriveLlamacppLaunchProfile honors the persisted top-level variant preset", () => {
  const profile = deriveLlamacppLaunchProfile({
    variant: {
      id: "local/qwen-low-memory",
      preset: "low-memory",
      contextWindow: 16384,
      runtimeProfile: {
        mode: "auto",
        preset: "balanced",
        lastFailure: null
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

  assert.equal(profile.preset, "low-memory");
  assert.match(profile.args.join(" "), /-ngl 0/);
});

test("supported llama.cpp presets produce distinct tuning profiles", () => {
  const common = {
    variant: {
      id: "local/qwen",
      contextWindow: 65536,
      runtimeProfile: { mode: "auto", lastFailure: null }
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
  };

  const balanced = deriveLlamacppLaunchProfile({
    ...common,
    variant: { ...common.variant, preset: "balanced" }
  });
  const longContext = deriveLlamacppLaunchProfile({
    ...common,
    variant: { ...common.variant, preset: "long-context" }
  });
  const lowMemory = deriveLlamacppLaunchProfile({
    ...common,
    variant: { ...common.variant, preset: "low-memory" }
  });
  const fastResponse = deriveLlamacppLaunchProfile({
    ...common,
    variant: { ...common.variant, preset: "fast-response" }
  });

  assert.notEqual(balanced.args.join(" "), longContext.args.join(" "));
  assert.notEqual(lowMemory.args.join(" "), fastResponse.args.join(" "));
  assert.notEqual(
    estimateLlamacppRuntimeBytes({ sizeBytes: 24 * 1024 ** 3, contextWindow: 65536, preset: "balanced" }),
    estimateLlamacppRuntimeBytes({ sizeBytes: 24 * 1024 ** 3, contextWindow: 65536, preset: "low-memory" })
  );
});
