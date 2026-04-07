// Keep in sync with MODEL_CAPABILITY_KEYS in src/runtime/config.js
export const CAPABILITY_DEFINITIONS = [
  { key: "supportsReasoning", label: "Reasoning", field: "reasoning_effort" },
  { key: "supportsThinking", label: "Thinking", field: "thinking" },
  { key: "supportsResponseFormat", label: "Response Format", field: "response_format" },
  { key: "supportsLogprobs", label: "Logprobs", field: "logprobs" },
  { key: "supportsServiceTier", label: "Service Tier", field: "service_tier" },
  { key: "supportsPrediction", label: "Prediction", field: "prediction" },
  { key: "supportsStreamOptions", label: "Stream Options", field: "stream_options" }
];

/** Merge litellm capabilities into existing row capabilities (don't overwrite user-set values) */
export function mergeLiteLlmCapabilities(existing = {}, litellm = {}) {
  if (!litellm || typeof litellm !== "object") return existing;
  const merged = { ...existing };
  for (const key of Object.keys(litellm)) {
    if (typeof litellm[key] !== "boolean") continue;
    if (merged[key] === undefined) {
      merged[key] = litellm[key];
    }
  }
  return merged;
}

/** Cycle capability value: undefined → true → false → undefined */
export function cycleCapabilityValue(current) {
  if (current === undefined) return true;
  if (current === true) return false;
  return undefined;
}

/** Check if any capabilities are explicitly set */
export function hasExplicitCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== "object") return false;
  return Object.values(capabilities).some((v) => typeof v === "boolean");
}
