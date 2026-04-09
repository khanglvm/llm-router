import { JSON_HEADERS } from "./constants.js";
import { CODEX_SUBSCRIPTION_MODELS, CLAUDE_CODE_SUBSCRIPTION_MODELS } from "../../runtime/subscription-constants.js";

/** Factory for OpenAI-compatible model discovery via /models endpoint. */
function createOpenAICompatDiscover(endpoint, { requiresAuth = true } = {}) {
  return Object.freeze({
    requiresAuth,
    fetchModels: async ({ apiKey, apiKeyEnv } = {}) => {
      const body = { endpoints: [endpoint] };
      if (apiKey) body.apiKey = apiKey;
      if (apiKeyEnv) body.apiKeyEnv = apiKeyEnv;
      const res = await fetchJson("/api/config/discover-provider-models", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body)
      });
      return (res.result?.models || []).map((id) => String(id || "").trim()).filter(Boolean);
    }
  });
}

/** Unified provider preset registry — single source of truth for all presets. */
const PROVIDER_PRESETS = Object.freeze([
  // ── API presets ──
  Object.freeze({
    key: "custom",
    category: "api",
    label: "Custom",
    description: "Generic OpenAI-compatible API provider.",
    providerName: "My Provider",
    providerId: "my-provider",
    endpoint: "",
    apiKeyEnv: "",
    defaultModels: Object.freeze({ openai: Object.freeze(["gpt-4o-mini", "gpt-4.1-mini"]), claude: Object.freeze(["claude-3-5-sonnet", "claude-3-5-haiku"]) }),
    rateLimitDefaults: Object.freeze({ limit: 60, windowValue: 1, windowUnit: "minute" })
  }),
  Object.freeze({
    key: "groq",
    category: "api",
    label: "Groq",
    description: "Groq cloud inference with Llama, Qwen, and GPT-OSS models.",
    providerName: "Groq",
    providerId: "groq",
    endpoint: "https://api.groq.com/openai/v1",
    apiKeyEnv: "",
    defaultModels: Object.freeze(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]),
    rateLimitDefaults: Object.freeze({ limit: 30, windowValue: 1, windowUnit: "minute" }),
    freeTierRpm: Object.freeze({
      host: "api.groq.com",
      models: Object.freeze({
        "llama-3.1-8b-instant": 30,
        "llama-3.3-70b-versatile": 30,
        "openai/gpt-oss-20b": 30,
        "openai/gpt-oss-120b": 15,
        "qwen/qwen3-32b": 30,
        "meta-llama/llama-4-scout-17b-16e-instruct": 15,
        "moonshotai/kimi-k2-instruct": 15,
        "_default": 30
      })
    }),
    discover: createOpenAICompatDiscover("https://api.groq.com/openai/v1")
  }),
  Object.freeze({
    key: "gemini",
    category: "api",
    label: "Google Gemini",
    description: "Google Gemini models via OpenAI-compatible endpoint.",
    providerName: "Google Gemini",
    providerId: "gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "",
    defaultModels: Object.freeze(["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"]),
    rateLimitDefaults: Object.freeze({ limit: 10, windowValue: 1, windowUnit: "minute" }),
    freeTierRpm: Object.freeze({
      host: "generativelanguage.googleapis.com",
      models: Object.freeze({
        "gemini-3-flash-preview": 15,
        "gemini-3.1-flash-lite-preview": 15,
        "gemini-3.1-pro-preview": 5,
        "gemini-2.5-flash": 15,
        "gemini-2.5-flash-lite": 15,
        "gemini-2.5-pro": 5,
        "_default": 10
      })
    }),
    discover: createOpenAICompatDiscover("https://generativelanguage.googleapis.com/v1beta/openai")
  }),
  Object.freeze({
    key: "zai-global",
    category: "api",
    label: "Z.AI Coding (Global)",
    description: "Zhipu AI coding models (GLM-4.7, GLM-5) via global endpoint.",
    providerName: "Z.AI Coding",
    providerId: "zai-coding",
    endpoint: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: "",
    defaultModels: Object.freeze(["glm-4.7", "glm-4.7-flash"]),
    rateLimitDefaults: Object.freeze({ limit: 60, windowValue: 1, windowUnit: "minute" }),
    discover: createOpenAICompatDiscover("https://api.z.ai/api/coding/paas/v4")
  }),
  Object.freeze({
    key: "zai-china",
    category: "api",
    label: "Z.AI Coding (China)",
    description: "Zhipu AI coding models via China mainland endpoint.",
    providerName: "Z.AI Coding CN",
    providerId: "zai-coding-cn",
    endpoint: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiKeyEnv: "",
    defaultModels: Object.freeze(["glm-4.7", "glm-4.7-flash"]),
    rateLimitDefaults: Object.freeze({ limit: 60, windowValue: 1, windowUnit: "minute" }),
    discover: createOpenAICompatDiscover("https://open.bigmodel.cn/api/coding/paas/v4")
  }),
  Object.freeze({
    key: "openrouter",
    category: "api",
    label: "OpenRouter",
    description: "300+ models from multiple providers, including free tier models.",
    providerName: "OpenRouter",
    providerId: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    apiKeyEnv: "",
    defaultModels: Object.freeze(["qwen/qwen3.6-plus:free", "google/gemma-4-26b-a4b-it"]),
    rateLimitDefaults: Object.freeze({ limit: 200, windowValue: 1, windowUnit: "minute" }),
    discover: createOpenAICompatDiscover("https://openrouter.ai/api/v1", { requiresAuth: false })
  }),

  // ── Subscription (OAuth) presets ──
  Object.freeze({
    key: "oauth-gpt",
    category: "subscription",
    label: "ChatGPT",
    description: "Use ChatGPT subscription login with GPT models.",
    providerName: "ChatGPT Subscription",
    providerId: "chatgpt-sub",
    subscriptionType: "chatgpt-codex",
    format: "openai",
    defaultModels: CODEX_SUBSCRIPTION_MODELS,
    rateLimitDefaults: Object.freeze({ limit: 999999, windowValue: 1, windowUnit: "month" }),
    warning: "chatgpt-tos"
  }),
  Object.freeze({
    key: "oauth-claude",
    category: "subscription",
    label: "Claude",
    description: "Use Claude Code subscription login with Claude models.",
    providerName: "Claude Subscription",
    providerId: "claude-sub",
    subscriptionType: "claude-code",
    format: "claude",
    defaultModels: CLAUDE_CODE_SUBSCRIPTION_MODELS,
    rateLimitDefaults: Object.freeze({ limit: 999999, windowValue: 1, windowUnit: "month" }),
    warning: "claude-extra-usage"
  })
]);

/** Index helpers for PROVIDER_PRESETS registry. */
const PROVIDER_PRESET_BY_KEY = Object.freeze(Object.fromEntries(PROVIDER_PRESETS.map((p) => [p.key, p])));

function findPresetByKey(key) {
  return PROVIDER_PRESET_BY_KEY[key] || PROVIDER_PRESET_BY_KEY.custom;
}

function findPresetByHost(hostname) {
  return PROVIDER_PRESETS.find((p) => p.freeTierRpm?.host === hostname) || null;
}

function getPresetOptionsByCategory(category) {
  return PROVIDER_PRESETS.filter((p) => p.category === category);
}

/** Build the free-tier RPM lookup map keyed by hostname (used by detectPresetHostFromEndpoints). */
const PROVIDER_PRESET_FREE_TIER_RPM_BY_HOST = Object.freeze(
  Object.fromEntries(
    PROVIDER_PRESETS
      .filter((p) => p.freeTierRpm?.host && p.freeTierRpm?.models)
      .map((p) => [p.freeTierRpm.host, p.freeTierRpm.models])
  )
);

/** Module-level cache for preset model discovery — survives React re-renders. */
const presetModelCache = new Map();
let _presetInitPromise = null;

/** Non-blocking background init: fetches models for presets that don't require auth. */
function initPresetModels() {
  if (_presetInitPromise) return _presetInitPromise;
  _presetInitPromise = Promise.allSettled(
    PROVIDER_PRESETS
      .filter((p) => p.discover && !p.discover.requiresAuth)
      .map(async (preset) => {
        try {
          const models = await preset.discover.fetchModels();
          if (models.length) presetModelCache.set(preset.key, models);
        } catch { /* background — swallow errors */ }
      })
  );
  return _presetInitPromise;
}

export {
  createOpenAICompatDiscover,
  PROVIDER_PRESETS,
  PROVIDER_PRESET_BY_KEY,
  findPresetByKey,
  findPresetByHost,
  getPresetOptionsByCategory,
  PROVIDER_PRESET_FREE_TIER_RPM_BY_HOST,
  presetModelCache,
  initPresetModels
};
