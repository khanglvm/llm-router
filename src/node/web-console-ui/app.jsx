import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "./components/ui/badge.jsx";
import { Button } from "./components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.jsx";
import { Input } from "./components/ui/input.jsx";
import { Switch } from "./components/ui/switch.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.jsx";
import { Textarea } from "./components/ui/textarea.jsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from "./components/ui/select.jsx";
import { getClippingAncestors, useDropdownPlacement } from "./dropdown-placement.js";
import { cn } from "./lib/utils.js";
import { BufferedTextInput } from "./buffered-text-input.js";
import {
  applyModelAliasEdits,
  applyProviderInlineEdits,
  applyProviderModelEdits,
  createAliasDraftState,
  createProviderModelDraftRows,
  removeModelAlias
} from "./config-editor-utils.js";
import {
  buildAutoRateLimitBucketId,
  buildRateLimitBucketsFromDraftRows,
  formatRateLimitBucketCap,
  normalizeRateLimitModelSelectors,
  normalizeRateLimitWindowUnit,
  RATE_LIMIT_ALL_MODELS_SELECTOR,
  RATE_LIMIT_WINDOW_OPTIONS,
  validateRateLimitDraftRows
} from "./rate-limit-utils.js";
import { CODEX_SUBSCRIPTION_MODELS, CLAUDE_CODE_SUBSCRIPTION_MODELS } from "../../runtime/subscription-constants.js";
import { DEFAULT_AMP_ENTITY_DEFINITIONS, DEFAULT_AMP_SIGNATURE_DEFINITIONS, DEFAULT_MODEL_ALIAS_ID } from "../../runtime/config.js";
import { LOCAL_ROUTER_ORIGIN, LOCAL_ROUTER_PORT } from "../../shared/local-router-defaults.js";
import {
  CODEX_CLI_INHERIT_MODEL_VALUE,
  normalizeClaudeCodeEffortLevel,
  normalizeFactoryDroidReasoningEffort,
  isCodexCliInheritModelBinding
} from "../../shared/coding-tool-bindings.js";
import { classifyTransientIntegerInput } from "./transient-integer-input-utils.js";

const JSON_HEADERS = { "content-type": "application/json" };
const LOG_LEVEL_STYLES = {
  info: "bg-sky-50 text-sky-700 ring-sky-100",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  warn: "bg-amber-50 text-amber-700 ring-amber-100",
  error: "bg-rose-50 text-rose-700 ring-rose-100"
};
const ACTIVITY_FILTER_OPTIONS = [
  { value: "usage", label: "Request / response" },
  { value: "router", label: "LLM Router" },
  { value: "all", label: "All categories" }
];
const ACTIVITY_CATEGORY_META = {
  usage: {
    label: "Request / response",
    badgeVariant: "info",
    emptyLabel: "request/response"
  },
  router: {
    label: "LLM Router",
    badgeVariant: "outline",
    emptyLabel: "LLM Router"
  }
};
const GITHUB_REPO_URL = "https://github.com/khanglvm/llm-router";
const GITHUB_SPONSORS_URL = "https://github.com/sponsors/khanglvm";

const QUICK_START_FALLBACK_USER_AGENT = "AICodeClient/1.0.0";
const LIVE_UPDATES_RETRY_MS = 3000;
const TOAST_DURATION_MS = 4000;
const TOAST_STATUS_TICK_MS = 100;
const CONTEXT_LOOKUP_SUGGESTION_LIMIT = 6;
const QUICK_START_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const QUICK_START_ALIAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const QUICK_START_CONNECTION_CATEGORIES = [
  {
    value: "api",
    label: "API Key",
    description: "Test endpoint + model candidates with an API key env before saving."
  },
  {
    value: "subscription",
    label: "Subscription",
    description: "Use an OAuth subscription login with ChatGPT or Claude models."
  }
];
const MODEL_ALIAS_STRATEGY_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "ordered", label: "Ordered" },
  { value: "round-robin", label: "Round robin" },
  { value: "weighted-rr", label: "Weighted RR" },
  { value: "quota-aware-weighted-rr", label: "Quota-aware weighted RR" }
];
const MODEL_ALIAS_STRATEGY_LABELS = Object.fromEntries(MODEL_ALIAS_STRATEGY_OPTIONS.map((option) => [option.value, option.label]));
const CODEX_THINKING_LEVEL_OPTIONS = Object.freeze([
  { value: "minimal", label: "Minimal", hint: "Fastest supported reasoning" },
  { value: "low", label: "Low", hint: "Lighter reasoning" },
  { value: "medium", label: "Medium", hint: "Balanced depth" },
  { value: "high", label: "High", hint: "Deeper reasoning" },
  { value: "xhigh", label: "XHigh", hint: "Model-dependent extra depth" }
]);
const CLAUDE_THINKING_LEVEL_OPTIONS = Object.freeze([
  { value: "low", label: "Low", hint: "Sets CLAUDE_CODE_EFFORT_LEVEL=low" },
  { value: "medium", label: "Medium", hint: "Sets CLAUDE_CODE_EFFORT_LEVEL=medium" },
  { value: "high", label: "High", hint: "Sets CLAUDE_CODE_EFFORT_LEVEL=high" },
  { value: "max", label: "Max", hint: "Sets CLAUDE_CODE_EFFORT_LEVEL=max" }
]);
const FACTORY_DROID_REASONING_EFFORT_OPTIONS = Object.freeze([
  { value: "off", label: "Off", hint: "Disable reasoning" },
  { value: "none", label: "None", hint: "No extended reasoning" },
  { value: "low", label: "Low", hint: "Lighter reasoning" },
  { value: "medium", label: "Medium", hint: "Balanced depth" },
  { value: "high", label: "High", hint: "Maximum reasoning depth" }
]);
const QUICK_START_WINDOW_OPTIONS = RATE_LIMIT_WINDOW_OPTIONS;
const QUICK_START_DEFAULT_ENDPOINT_BY_PROTOCOL = {
  openai: "https://api.openai.com/v1",
  claude: "https://api.anthropic.com"
};

// ── Preset discovery ──

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
    apiKeyEnv: "GROQ_API_KEY",
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
    apiKeyEnv: "GEMINI_API_KEY",
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
    apiKeyEnv: "ZAI_API_KEY",
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
    apiKeyEnv: "ZAI_API_KEY",
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
    apiKeyEnv: "OPENROUTER_API_KEY",
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

const AMP_WEB_SEARCH_STRATEGY_OPTIONS = Object.freeze([
  { value: "ordered", label: "Ordered" },
  { value: "quota-balance", label: "Quota balance" }
]);
const AMP_WEB_SEARCH_PROVIDER_OPTIONS = Object.freeze([
  Object.freeze({
    id: "brave",
    label: "Brave",
    credentialField: "apiKey",
    credentialLabel: "API key",
    credentialPlaceholder: "brv_...",
    defaultLimit: 1000
  }),
  Object.freeze({
    id: "tavily",
    label: "Tavily",
    credentialField: "apiKey",
    credentialLabel: "API key",
    credentialPlaceholder: "tvly-...",
    defaultLimit: 1000
  }),
  Object.freeze({
    id: "exa",
    label: "Exa",
    credentialField: "apiKey",
    credentialLabel: "API key",
    credentialPlaceholder: "exa_...",
    defaultLimit: 1000
  }),
  Object.freeze({
    id: "searxng",
    label: "SearXNG",
    credentialField: "url",
    credentialLabel: "Base URL",
    credentialPlaceholder: "https://searx.example.com",
    defaultLimit: 0
  })
]);
const AMP_WEB_SEARCH_PROVIDER_META = Object.fromEntries(
  AMP_WEB_SEARCH_PROVIDER_OPTIONS.map((provider) => [provider.id, provider])
);
const AMP_WEB_SEARCH_DEFAULT_COUNT = 5;
const AMP_WEB_SEARCH_MIN_COUNT = 1;
const AMP_WEB_SEARCH_MAX_COUNT = 20;

function splitListValues(value) {
  return Array.from(new Set(String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)));
}

function isLikelyHttpEndpoint(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function mergeChipValuesAndDraft(values = [], draft = "") {
  return Array.from(new Set([
    ...(Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean),
    ...splitListValues(draft)
  ]));
}

function moveItemsByKey(items = [], fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return items;
  const nextItems = [...items];
  const fromIndex = nextItems.findIndex((item) => item?.key === fromKey);
  const toIndex = nextItems.findIndex((item) => item?.key === toKey);
  if (fromIndex === -1 || toIndex === -1) return items;
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function moveItemUp(items = [], itemKey, getKey = (item) => item?.key) {
  if (!itemKey) return items;
  const currentIndex = items.findIndex((item) => getKey(item) === itemKey);
  if (currentIndex <= 0) return items;
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(currentIndex, 1);
  nextItems.splice(currentIndex - 1, 0, movedItem);
  return nextItems;
}

function moveItemDown(items = [], itemKey, getKey = (item) => item?.key) {
  if (!itemKey) return items;
  const currentIndex = items.findIndex((item) => getKey(item) === itemKey);
  if (currentIndex === -1 || currentIndex >= items.length - 1) return items;
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(currentIndex, 1);
  nextItems.splice(currentIndex + 1, 0, movedItem);
  return nextItems;
}

function captureScrollSettleSnapshot(node, scrollContainers = []) {
  const rect = node?.getBoundingClientRect?.();
  return {
    top: Number.isFinite(rect?.top) ? Number(rect.top) : Number.NaN,
    left: Number.isFinite(rect?.left) ? Number(rect.left) : Number.NaN,
    windowX: typeof window === "undefined" ? 0 : Number(window.scrollX || window.pageXOffset || 0),
    windowY: typeof window === "undefined" ? 0 : Number(window.scrollY || window.pageYOffset || 0),
    containers: scrollContainers.map((container) => ({
      top: Number(container?.scrollTop || 0),
      left: Number(container?.scrollLeft || 0)
    }))
  };
}

function isScrollSettleSnapshotStable(previousSnapshot, nextSnapshot, threshold = 0.5) {
  if (!previousSnapshot || !nextSnapshot) return false;
  if (!Number.isFinite(nextSnapshot.top) || !Number.isFinite(nextSnapshot.left)) return false;
  if (Math.abs(nextSnapshot.top - previousSnapshot.top) > threshold) return false;
  if (Math.abs(nextSnapshot.left - previousSnapshot.left) > threshold) return false;
  if (Math.abs(nextSnapshot.windowX - previousSnapshot.windowX) > threshold) return false;
  if (Math.abs(nextSnapshot.windowY - previousSnapshot.windowY) > threshold) return false;
  if ((previousSnapshot.containers?.length || 0) !== (nextSnapshot.containers?.length || 0)) return false;

  return nextSnapshot.containers.every((position, index) => {
    const previousPosition = previousSnapshot.containers[index];
    if (!previousPosition) return false;
    return Math.abs(position.top - previousPosition.top) <= threshold
      && Math.abs(position.left - previousPosition.left) <= threshold;
  });
}

function getActivityEntryCategory(entry) {
  const category = String(entry?.category || "").trim().toLowerCase();
  if (category === "usage" || category === "router") return category;
  const source = String(entry?.source || "").trim().toLowerCase();
  const kind = String(entry?.kind || "").trim().toLowerCase();
  if (source === "runtime" || kind.startsWith("request") || kind.startsWith("fallback")) {
    return "usage";
  }
  return "router";
}

const DRAGGING_ROW_CLASSES = ["border-primary/45", "bg-primary/5"];

function setDraggingRowClasses(node, active) {
  if (!node?.classList) return;
  if (active) {
    node.classList.add(...DRAGGING_ROW_CLASSES);
    return;
  }
  node.classList.remove(...DRAGGING_ROW_CLASSES);
}

function getReorderRowNode(node) {
  return typeof node?.closest === "function" ? node.closest("[data-reorder-row='true']") : null;
}

function useReorderLayoutAnimation(itemKeys = []) {
  const itemRefs = useRef(new Map());
  const refCallbacksRef = useRef(new Map());
  const previousRectsRef = useRef(new Map());
  const previousSignatureRef = useRef("");
  const keySignature = JSON.stringify(itemKeys);

  useLayoutEffect(() => {
    const nextRects = new Map();
    for (const itemKey of itemKeys) {
      const node = itemRefs.current.get(itemKey);
      if (node) nextRects.set(itemKey, node.getBoundingClientRect());
    }

    const prefersReducedMotion = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shouldAnimate = previousSignatureRef.current !== "" && previousSignatureRef.current !== keySignature;

    if (shouldAnimate && !prefersReducedMotion) {
      for (const itemKey of itemKeys) {
        const previousRect = previousRectsRef.current.get(itemKey);
        const nextRect = nextRects.get(itemKey);
        const node = itemRefs.current.get(itemKey);
        if (!previousRect || !nextRect || !node) continue;
        const deltaY = previousRect.top - nextRect.top;
        if (Math.abs(deltaY) < 1 || typeof node.animate !== "function") continue;
        node.animate(
          [
            { transform: `translateY(${deltaY}px)` },
            { transform: "translateY(0)" }
          ],
          {
            duration: 220,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)"
          }
        );
      }
    }

    const activeKeys = new Set(itemKeys);
    for (const itemKey of refCallbacksRef.current.keys()) {
      if (!activeKeys.has(itemKey)) refCallbacksRef.current.delete(itemKey);
    }

    previousRectsRef.current = nextRects;
    previousSignatureRef.current = keySignature;
  }, [keySignature]);

  return useMemo(() => (itemKey) => {
    if (!refCallbacksRef.current.has(itemKey)) {
      refCallbacksRef.current.set(itemKey, (node) => {
        if (node) {
          itemRefs.current.set(itemKey, node);
          return;
        }
        itemRefs.current.delete(itemKey);
      });
    }
    return refCallbacksRef.current.get(itemKey);
  }, []);
}

function DragGripIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="5" cy="4" r="1.25" fill="currentColor" />
      <circle cx="11" cy="4" r="1.25" fill="currentColor" />
      <circle cx="5" cy="8" r="1.25" fill="currentColor" />
      <circle cx="11" cy="8" r="1.25" fill="currentColor" />
      <circle cx="5" cy="12" r="1.25" fill="currentColor" />
      <circle cx="11" cy="12" r="1.25" fill="currentColor" />
    </svg>
  );
}

function ArrowUpIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 12V4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.75 7.25 8 4l3.25 3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowDownIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 4v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.75 8.75 8 12l3.25-3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 3.5v9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GitHubIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.2-.02-2.18-3.2.69-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.72-1.54-2.56-.29-5.25-1.28-5.25-5.71 0-1.26.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a10.9 10.9 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.62 1.59.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.08 0 4.44-2.69 5.41-5.26 5.69.41.35.78 1.05.78 2.11 0 1.52-.01 2.75-.01 3.12 0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function HeartIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 21.3 10.9 20.3C5.4 15.3 2 12.3 2 8.5 2 5.4 4.4 3 7.5 3c1.8 0 3.5.8 4.5 2.1C13 3.8 14.7 3 16.5 3 19.6 3 22 5.4 22 8.5c0 3.8-3.4 6.8-8.9 11.8L12 21.3Z" />
    </svg>
  );
}

function PlayIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M6.25 4.7a.75.75 0 0 1 1.14-.64l8.1 5.05a1.05 1.05 0 0 1 0 1.78l-8.1 5.05a.75.75 0 0 1-1.14-.64V4.7Z" />
    </svg>
  );
}

function PauseIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M6.25 4.5A1.25 1.25 0 0 1 7.5 3.25h.5a1.25 1.25 0 0 1 1.25 1.25v11A1.25 1.25 0 0 1 8 16.75h-.5a1.25 1.25 0 0 1-1.25-1.25v-11Zm4.5 0A1.25 1.25 0 0 1 12 3.25h.5a1.25 1.25 0 0 1 1.25 1.25v11A1.25 1.25 0 0 1 12.5 16.75H12a1.25 1.25 0 0 1-1.25-1.25v-11Z" />
    </svg>
  );
}

function FolderIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M2.75 6.5A1.75 1.75 0 0 1 4.5 4.75h3L9.4 6.4h6.1a1.75 1.75 0 0 1 1.75 1.75v6.35a1.75 1.75 0 0 1-1.75 1.75h-11A1.75 1.75 0 0 1 2.75 14.5v-8Z" />
      <path d="M2.75 8h14.5" />
    </svg>
  );
}

function EyeIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M2.5 10s3-5.5 7.5-5.5S17.5 10 17.5 10s-3 5.5-7.5 5.5S2.5 10 2.5 10Z" />
      <circle cx="10" cy="10" r="2.5" />
    </svg>
  );
}

function EyeOffIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8.15 4.85A8.5 8.5 0 0 1 10 4.5c4.5 0 7.5 5.5 7.5 5.5a12.4 12.4 0 0 1-1.67 2.28" />
      <path d="M5.6 5.6A12.2 12.2 0 0 0 2.5 10s3 5.5 7.5 5.5a8.3 8.3 0 0 0 4.4-1.6" />
      <path d="M8.23 8.23a2.5 2.5 0 0 0 3.54 3.54" />
      <path d="M3 3l14 14" />
    </svg>
  );
}

function CredentialInput({ value, onChange, onValueChange, placeholder, disabled, isEnvVar, buffered, commitOnBlur, onValueCommit, className }) {
  const [visible, setVisible] = useState(false);
  const shouldMask = !isEnvVar && !visible;
  const inputProps = buffered
    ? {
        value: value || "",
        onValueChange,
        onValueCommit,
        commitOnBlur,
        type: shouldMask ? "password" : "text",
        autoComplete: "off",
        placeholder,
        disabled,
        className: cn("flex h-9 w-full rounded-lg rounded-r-none border border-r-0 border-input bg-background/80 px-3 py-2 text-sm text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40", className)
      }
    : {
        value: value || "",
        onChange,
        type: shouldMask ? "password" : "text",
        autoComplete: "off",
        placeholder,
        disabled,
        className: cn("flex h-9 w-full rounded-lg rounded-r-none border border-r-0 border-input bg-background/80 px-3 py-2 text-sm text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40", className)
      };

  return (
    <div className="flex">
      {buffered
        ? <BufferedTextInput {...inputProps} />
        : <input {...inputProps} />}
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg rounded-l-none border border-l-0 border-input bg-background/80 text-muted-foreground transition hover:text-foreground focus:outline-none disabled:pointer-events-none disabled:opacity-50"
        aria-label={visible ? "Hide credential" : "Show credential"}
      >
        {visible ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
      </button>
    </div>
  );
}

function PowerIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M10 3.25v5" />
      <path d="M6.1 5.15a6.25 6.25 0 1 0 7.8 0" />
    </svg>
  );
}

function MoveUpButton({ disabled = false, label = "Move up", onClick }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 w-7 rounded-full p-0"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <ArrowUpIcon className="h-3.5 w-3.5" />
    </Button>
  );
}

function MoveDownButton({ disabled = false, label = "Move down", onClick }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 w-7 rounded-full p-0"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <ArrowDownIcon className="h-3.5 w-3.5" />
    </Button>
  );
}

function ProviderStatusDot({ active = false }) {
  if (!active) return null;
  return <span aria-hidden="true" className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />;
}

const ROW_REMOVE_BUTTON_CLASS = "w-[5.5rem] justify-self-end";

function normalizeModelAliasStrategyValue(strategy) {
  const normalized = String(strategy || "").trim().toLowerCase();
  if (normalized === "automatic" || normalized === "smart") return "auto";
  if (normalized === "rr") return "round-robin";
  if (normalized === "weighted-round-robin" || normalized === "weighted_rr") return "weighted-rr";
  if (normalized === "quota-aware-weighted-round-robin") return "quota-aware-weighted-rr";
  return Object.prototype.hasOwnProperty.call(MODEL_ALIAS_STRATEGY_LABELS, normalized) ? normalized : "ordered";
}

function formatModelAliasStrategyLabel(strategy) {
  const normalized = normalizeModelAliasStrategyValue(strategy);
  return MODEL_ALIAS_STRATEGY_LABELS[normalized] || MODEL_ALIAS_STRATEGY_LABELS.ordered;
}

function normalizeUniqueTrimmedValues(values = []) {
  return Array.from(new Set((values || []).map((entry) => String(entry || "").trim()).filter(Boolean)));
}

function hasDuplicateTrimmedValues(values = []) {
  const seen = new Set();
  for (const value of (values || []).map((entry) => String(entry || "").trim()).filter(Boolean)) {
    if (seen.has(value)) return true;
    seen.add(value);
  }
  return false;
}

function hasDuplicateHeaderName(rows = [], name = "", exceptIndex = -1) {
  const normalizedName = String(name || "").trim().toLowerCase();
  if (!normalizedName) return false;
  return (rows || []).some((row, index) => index !== exceptIndex && String(row?.name || "").trim().toLowerCase() === normalizedName);
}

function createPendingAliasSeed() {
  return {
    id: "",
    strategy: "auto",
    targets: [{ ref: "" }],
    fallbackTargets: []
  };
}

function buildAliasDraftResetKey(aliasId = "", alias = {}, { isNew = false } = {}) {
  return JSON.stringify({
    aliasId: isNew ? "" : String(aliasId || "").trim(),
    id: String(alias?.id || (isNew ? "" : aliasId) || "").trim(),
    strategy: String(alias?.strategy || "ordered").trim() || "ordered",
    targets: (Array.isArray(alias?.targets) ? alias.targets : []).map((target) => String(target?.ref || "").trim()),
    fallbackTargets: (Array.isArray(alias?.fallbackTargets) ? alias.fallbackTargets : []).map((target) => String(target?.ref || "").trim())
  });
}

function createMasterKey() {
  const prefix = "gw_";
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(18);
    globalThis.crypto.getRandomValues(bytes);
    return `${prefix}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `${prefix}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function looksLikeEnvVarName(value) {
  return /^[A-Z][A-Z0-9_]*$/.test(String(value || "").trim());
}

function slugifyProviderId(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!normalized) return "";
  if (/^[a-z]/.test(normalized)) return normalized;
  return `provider-${normalized}`;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function collectProviderModelIds(provider = {}) {
  return normalizeUniqueTrimmedValues(
    (Array.isArray(provider?.models) ? provider.models : []).map((model) => model?.id)
  );
}

function createRateLimitDraftRow(row = {}, {
  keyPrefix = "rate-limit",
  index = 0,
  defaults = PROVIDER_PRESET_BY_KEY.custom.rateLimitDefaults,
  useDefaults = true
} = {}) {
  const sourceId = String(row?.sourceId || row?.id || "").trim();
  const resolvedRequests = row?.requests ?? row?.limit;
  const resolvedWindowValue = row?.windowValue ?? row?.window?.size ?? row?.window?.value;
  const resolvedWindowUnit = row?.windowUnit ?? row?.window?.unit;

  return {
    key: String(row?.key || "").trim() || `${keyPrefix}-${sourceId || index + 1}`,
    sourceId,
    models: normalizeRateLimitModelSelectors(Array.isArray(row?.models) ? row.models : []),
    modelsDraft: String(row?.modelsDraft || ""),
    requests: resolvedRequests !== undefined
      ? String(resolvedRequests)
      : (useDefaults ? String(defaults.limit ?? "") : ""),
    windowValue: resolvedWindowValue !== undefined
      ? String(resolvedWindowValue)
      : (useDefaults ? String(defaults.windowValue ?? "") : ""),
    windowUnit: String(
      resolvedWindowUnit !== undefined
        ? resolvedWindowUnit
        : (useDefaults ? defaults.windowUnit : "minute")
    ).trim() || "minute"
  };
}

function createRateLimitDraftRows(rateLimits = [], {
  keyPrefix = "rate-limit",
  defaults = PROVIDER_PRESET_BY_KEY.custom.rateLimitDefaults,
  includeDefault = true
} = {}) {
  const sourceRows = Array.isArray(rateLimits) && rateLimits.length > 0
    ? rateLimits
    : (includeDefault
        ? [{
            models: [RATE_LIMIT_ALL_MODELS_SELECTOR],
            requests: defaults.limit,
            window: { size: defaults.windowValue, unit: defaults.windowUnit }
          }]
        : []);

  return sourceRows.map((row, index) => createRateLimitDraftRow(row, {
    keyPrefix,
    index,
    defaults,
    useDefaults: true
  }));
}

function isBlankRateLimitDraftRow(row = {}) {
  const models = normalizeRateLimitModelSelectors(mergeChipValuesAndDraft(row?.models, row?.modelsDraft || ""));
  return models.length === 0
    && !String(row?.requests ?? "").trim()
    && !String(row?.windowValue ?? "").trim();
}

function resolveRateLimitDraftRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({
      key: String(row?.key || `rate-limit-${index + 1}`).trim() || `rate-limit-${index + 1}`,
      sourceId: String(row?.sourceId || "").trim(),
      models: normalizeRateLimitModelSelectors(mergeChipValuesAndDraft(row?.models, row?.modelsDraft || "")),
      requests: String(row?.requests ?? "").trim(),
      windowValue: String(row?.windowValue ?? "").trim(),
      windowUnit: normalizeRateLimitWindowUnit(row?.windowUnit, "minute")
    }))
    .filter((row, index) => !isBlankRateLimitDraftRow({ ...(rows?.[index] || {}), ...row }));
}

function serializeRateLimitDraftRows(rows = []) {
  return resolveRateLimitDraftRows(rows).map((row) => ({
    sourceId: row.sourceId,
    models: row.models,
    requests: row.requests,
    windowValue: row.windowValue,
    windowUnit: row.windowUnit
  }));
}

function formatRateLimitSummary(rateLimits = []) {
  const buckets = Array.isArray(rateLimits) ? rateLimits.filter(Boolean) : [];
  if (buckets.length === 0) return "";
  if (buckets.length === 1) return formatRateLimitBucketCap(buckets[0]);
  return `${buckets.length} rate limits`;
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function tryParseConfigObject(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function getQuickStartDefaultHeaderRows(defaultProviderUserAgent = QUICK_START_FALLBACK_USER_AGENT) {
  return [{ name: "User-Agent", value: String(defaultProviderUserAgent || QUICK_START_FALLBACK_USER_AGENT) }];
}

function normalizeQuickStartHeaderRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    name: String(row?.name || ""),
    value: row?.value === undefined || row?.value === null ? "" : String(row.value)
  }));
}

function headerObjectToRows(headers, defaultProviderUserAgent = QUICK_START_FALLBACK_USER_AGENT) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return getQuickStartDefaultHeaderRows(defaultProviderUserAgent);
  }

  const rows = Object.entries(headers)
    .map(([name, value]) => ({
      name: String(name || ""),
      value: value === undefined || value === null ? "" : String(value)
    }))
    .filter((row) => row.name.trim());

  return rows.length > 0 ? rows : getQuickStartDefaultHeaderRows(defaultProviderUserAgent);
}

function headerRowsToObject(rows = []) {
  const output = {};
  for (const row of normalizeQuickStartHeaderRows(rows)) {
    const name = String(row.name || "").trim();
    if (!name) continue;
    const isUserAgent = name.toLowerCase() === "user-agent";
    const value = String(row.value || "").trim();
    if (!value && !isUserAgent) continue;
    output[name] = value;
  }
  return output;
}

function buildQuickStartApiSignature(quickStart = {}) {
  return JSON.stringify({
    connectionType: String(quickStart?.connectionType || ""),
    endpoints: Array.isArray(quickStart?.endpoints) ? quickStart.endpoints.map((entry) => String(entry || "").trim()).filter(Boolean) : [],
    apiKeyEnv: String(quickStart?.apiKeyEnv || "").trim(),
    headers: headerRowsToObject(quickStart?.headerRows || [])
  });
}

function isProviderReference(value, providerId) {
  return String(value || "").trim().startsWith(`${providerId}/`);
}

function pickFallbackDefaultModel(config) {
  const aliasIds = Object.keys(config?.modelAliases || {});
  if (aliasIds.includes(DEFAULT_MODEL_ALIAS_ID)) return DEFAULT_MODEL_ALIAS_ID;
  if (aliasIds.length > 0) return aliasIds[0];
  const provider = (config?.providers || []).find((entry) => (entry?.models || []).length > 0);
  return provider?.models?.[0]?.id ? `${provider.id}/${provider.models[0].id}` : undefined;
}

function parseDraftConfigText(rawText, fallback = {}) {
  try {
    const parsed = String(rawText || "").trim() ? JSON.parse(rawText) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        value: fallback,
        parseError: "Config root must be a JSON object."
      };
    }
    return {
      value: parsed,
      parseError: ""
    };
  } catch (error) {
    return {
      value: fallback,
      parseError: error instanceof Error ? error.message : String(error)
    };
  }
}

function formatAmpEntityLabel(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function getAmpDefaultMatchForRouteKey(routeKey) {
  const key = String(routeKey || "").trim();
  if (!key) return "";

  const signatureMatch = DEFAULT_AMP_SIGNATURE_DEFINITIONS.find((entry) => entry?.id === key);
  if (signatureMatch?.defaultMatch) return String(signatureMatch.defaultMatch).trim();

  const entityMatch = DEFAULT_AMP_ENTITY_DEFINITIONS.find((entry) => entry?.id === key);
  if (!entityMatch) return "";

  const defaultMatches = [...new Set((entityMatch.signatures || [])
    .map((signatureId) => DEFAULT_AMP_SIGNATURE_DEFINITIONS.find((entry) => entry?.id === signatureId)?.defaultMatch)
    .map((value) => String(value || "").trim())
    .filter(Boolean))];

  return defaultMatches.length === 1 ? defaultMatches[0] : defaultMatches.join(" | ");
}

function buildAmpClientUrl() {
  return LOCAL_ROUTER_ORIGIN;
}

function maskShortSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= 10) return `${text.slice(0, 2)}…${text.slice(-2)}`;
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function ensureAmpDraftConfigShape(config = {}) {
  const next = safeClone(config && typeof config === "object" && !Array.isArray(config) ? config : {});
  if (!next.amp || typeof next.amp !== "object" || Array.isArray(next.amp)) next.amp = {};
  if (!next.amp.routes || typeof next.amp.routes !== "object" || Array.isArray(next.amp.routes)) next.amp.routes = {};
  if (!Array.isArray(next.amp.rawModelRoutes)) next.amp.rawModelRoutes = [];
  if (!next.amp.overrides || typeof next.amp.overrides !== "object" || Array.isArray(next.amp.overrides)) next.amp.overrides = {};
  if (!Array.isArray(next.amp.overrides.entities)) next.amp.overrides.entities = [];
  if (next.amp.restrictManagementToLocalhost === undefined) next.amp.restrictManagementToLocalhost = true;
  if (!String(next.amp.preset || "").trim()) next.amp.preset = "builtin";
  if (!String(next.amp.defaultRoute || "").trim()) {
    next.amp.defaultRoute = String(next.defaultModel || pickFallbackDefaultModel(next) || "").trim();
  }
  return next;
}

function parseAmpWebSearchInteger(value, fallback = 0, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function ensureWebSearchConfigShape(config = {}) {
  const next = config && typeof config === "object" && !Array.isArray(config)
    ? config
    : {};
  const legacyWebSearch = next.amp?.webSearch && typeof next.amp.webSearch === "object" && !Array.isArray(next.amp.webSearch)
    ? safeClone(next.amp.webSearch)
    : null;

  if (!next.webSearch || typeof next.webSearch !== "object" || Array.isArray(next.webSearch)) {
    next.webSearch = legacyWebSearch || {};
  }

  if (next.amp && typeof next.amp === "object" && !Array.isArray(next.amp) && Object.prototype.hasOwnProperty.call(next.amp, "webSearch")) {
    delete next.amp.webSearch;
  }

  const strategy = String(next.webSearch.strategy || "").trim();
  next.webSearch.strategy = strategy === "quota-balance" ? "quota-balance" : "ordered";
  if (next.webSearch.count !== undefined && next.webSearch.count !== null && String(next.webSearch.count).trim() !== "") {
    next.webSearch.count = parseAmpWebSearchInteger(next.webSearch.count, AMP_WEB_SEARCH_DEFAULT_COUNT, {
      min: AMP_WEB_SEARCH_MIN_COUNT,
      max: AMP_WEB_SEARCH_MAX_COUNT
    });
  } else {
    delete next.webSearch.count;
  }
  if (!Array.isArray(next.webSearch.providers)) {
    next.webSearch.providers = [];
  }
  return next.webSearch;
}

function isHostedWebSearchProviderId(value = "") {
  const text = String(value || "").trim();
  return text.includes("/");
}

function normalizeWebSearchProviderKey(value = "") {
  const text = String(value || "").trim();
  return isHostedWebSearchProviderId(text) ? text : text.toLowerCase();
}

function buildHostedWebSearchProviderId(providerId = "", modelId = "") {
  const normalizedProviderId = String(providerId || "").trim();
  const normalizedModelId = String(modelId || "").trim();
  if (!normalizedProviderId || !normalizedModelId) return "";
  return `${normalizedProviderId}/${normalizedModelId}`;
}

function getWebSearchProviderFormats(provider = {}) {
  return [...new Set(
    [provider?.format, ...(Array.isArray(provider?.formats) ? provider.formats : [])]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value === "openai" || value === "claude")
  )];
}

function getWebSearchModelFormats(provider = {}, model = {}) {
  const modelId = String(model?.id || "").trim();
  const preferredFormat = modelId ? String(provider?.lastProbe?.modelPreferredFormat?.[modelId] || "").trim().toLowerCase() : "";
  if (preferredFormat === "openai" || preferredFormat === "claude") {
    return [preferredFormat];
  }

  const probedFormats = modelId
    ? [...new Set(
      (Array.isArray(provider?.lastProbe?.modelSupport?.[modelId]) ? provider.lastProbe.modelSupport[modelId] : [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter((value) => value === "openai" || value === "claude")
    )]
    : [];
  if (probedFormats.length > 0) return probedFormats;

  return [...new Set(
    [model?.format, ...(Array.isArray(model?.formats) ? model.formats : [])]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value === "openai" || value === "claude")
  )];
}

function providerHasHostedWebSearchConnection(provider = {}) {
  const subscriptionType = String(provider?.subscriptionType || provider?.subscription_type || "").trim().toLowerCase();
  if (String(provider?.type || "").trim().toLowerCase() === "subscription") {
    return subscriptionType === "chatgpt-codex";
  }

  const providerFormats = getWebSearchProviderFormats(provider);
  if (!providerFormats.includes("openai")) return false;
  return Boolean(String(provider?.baseUrlByFormat?.openai || provider?.baseUrl || "").trim());
}

function providerHasHostedWebSearchAuth(provider = {}) {
  if (String(provider?.type || "").trim().toLowerCase() === "subscription") {
    return String(provider?.subscriptionType || provider?.subscription_type || "").trim().toLowerCase() === "chatgpt-codex";
  }
  if (String(provider?.apiKey || "").trim() || String(provider?.apiKeyEnv || "").trim()) return true;
  if (String(provider?.auth?.type || "").trim().toLowerCase() === "none") return true;

  return Object.keys(provider?.headers && typeof provider.headers === "object" ? provider.headers : {})
    .some((key) => {
      const normalized = String(key || "").trim().toLowerCase();
      return normalized === "authorization" || normalized === "x-api-key";
    });
}

function modelSupportsHostedWebSearch(provider = {}, model = {}) {
  if (!providerHasHostedWebSearchConnection(provider)) return false;
  const modelFormats = getWebSearchModelFormats(provider, model);
  return modelFormats.length === 0 || modelFormats.includes("openai");
}

function hasWebSearchDraftField(entry = {}, keys = []) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(entry, key) && entry[key] !== undefined && entry[key] !== null && String(entry[key]).trim() !== "");
}

function normalizeBuiltinWebSearchProviderDraft(entry = {}, explicitId = "") {
  const providerId = String(explicitId || entry?.id || "").trim().toLowerCase();
  const providerMeta = AMP_WEB_SEARCH_PROVIDER_META[providerId];
  if (!providerMeta) return null;

  const credentialField = providerMeta.credentialField;
  const credentialValue = String(entry?.[credentialField] || "").trim();
  const hasExplicitCount = hasWebSearchDraftField(entry, ["count", "resultCount", "result-count", "resultsPerCall", "results-per-call"]);
  const hasExplicitLimit = hasWebSearchDraftField(entry, ["limit", "monthlyLimit", "monthly-limit", "quota"]);
  const hasExplicitRemaining = hasWebSearchDraftField(entry, ["remaining", "remainingQuota", "remaining-quota", "remainingQueries", "remaining-queries"]);
  const includeQuotaDefaults = Boolean(credentialValue) || hasExplicitLimit || hasExplicitRemaining;
  const defaultLimit = includeQuotaDefaults ? (Number(providerMeta.defaultLimit) || 0) : 0;
  const count = parseAmpWebSearchInteger(
    entry?.count ?? entry?.resultCount ?? entry?.["result-count"] ?? entry?.resultsPerCall ?? entry?.["results-per-call"],
    AMP_WEB_SEARCH_DEFAULT_COUNT,
    { min: AMP_WEB_SEARCH_MIN_COUNT, max: AMP_WEB_SEARCH_MAX_COUNT }
  );
  const limit = parseAmpWebSearchInteger(entry?.limit, defaultLimit, { min: 0 });
  const remainingFallback = limit > 0 ? limit : 0;
  const remaining = parseAmpWebSearchInteger(entry?.remaining, remainingFallback, { min: 0 });

  return {
    kind: "builtin",
    id: providerId,
    [credentialField]: credentialValue,
    ...(hasExplicitCount && count !== AMP_WEB_SEARCH_DEFAULT_COUNT ? { count } : {}),
    ...(hasExplicitLimit || (includeQuotaDefaults && limit > 0) ? { limit } : {}),
    ...(hasExplicitRemaining || (includeQuotaDefaults && (limit > 0 || remaining > 0))
      ? { remaining: limit > 0 ? Math.min(remaining, limit) : remaining }
      : {})
  };
}

function normalizeHostedWebSearchProviderDraft(entry = {}, explicitId = "") {
  const routeId = String(
    explicitId
    || entry?.id
    || buildHostedWebSearchProviderId(entry?.providerId ?? entry?.provider, entry?.model ?? entry?.modelId)
  ).trim();
  if (!isHostedWebSearchProviderId(routeId)) return null;
  const providerId = String(entry?.providerId ?? entry?.provider ?? routeId.slice(0, routeId.indexOf("/"))).trim();
  const modelId = String(entry?.model ?? entry?.modelId ?? routeId.slice(routeId.indexOf("/") + 1)).trim();
  const normalizedRouteId = buildHostedWebSearchProviderId(providerId, modelId);
  if (!normalizedRouteId || normalizedRouteId !== routeId) return null;

  return {
    kind: "hosted",
    id: normalizedRouteId,
    providerId,
    model: modelId
  };
}

function normalizeWebSearchProviderDraft(entry = {}, explicitId = "") {
  return normalizeHostedWebSearchProviderDraft(entry, explicitId)
    || normalizeBuiltinWebSearchProviderDraft(entry, explicitId);
}

function buildHostedWebSearchCandidateGroups(config = {}, existingIds = new Set()) {
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  return providers
    .map((provider) => {
      const providerId = String(provider?.id || "").trim();
      if (!providerId || provider?.enabled === false || !providerHasHostedWebSearchConnection(provider) || !providerHasHostedWebSearchAuth(provider)) {
        return null;
      }
      const models = (Array.isArray(provider?.models) ? provider.models : [])
        .map((model) => {
          const modelId = String(model?.id || "").trim();
          const routeId = buildHostedWebSearchProviderId(providerId, modelId);
          if (!modelId || !routeId || existingIds.has(routeId)) return null;
          if (!modelSupportsHostedWebSearch(provider, model)) return null;
          if (!modelId.toLowerCase().includes("gpt")) return null;
          return {
            value: modelId,
            label: modelId,
            routeId
          };
        })
        .filter(Boolean);
      if (models.length === 0) return null;
      return {
        providerId,
        providerLabel: String(provider?.name || providerId).trim() || providerId,
        providerHint: String(provider?.subscriptionType || "").trim().toLowerCase() === "chatgpt-codex"
          ? "ChatGPT subscription"
          : (String(provider?.baseUrlByFormat?.openai || provider?.baseUrl || "").trim() || "OpenAI-compatible endpoint"),
        models
      };
    })
    .filter(Boolean);
}

function buildWebSearchProviderRows(config = {}, snapshot = null) {
  const nextConfig = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(nextConfig);
  const configuredProviders = Array.isArray(webSearch.providers)
    ? webSearch.providers
        .map((provider) => normalizeWebSearchProviderDraft(provider, provider?.id))
        .filter(Boolean)
    : [];
  const configuredIds = new Set(configuredProviders.map((provider) => normalizeWebSearchProviderKey(provider.id)));
  const orderedProviders = [
    ...configuredProviders,
    ...AMP_WEB_SEARCH_PROVIDER_OPTIONS
      .filter((provider) => !configuredIds.has(provider.id))
      .map((provider) => normalizeBuiltinWebSearchProviderDraft({ id: provider.id }, provider.id))
      .filter(Boolean)
  ];
  const snapshotProviders = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
  const snapshotById = new Map(
    snapshotProviders
      .map((provider) => [normalizeWebSearchProviderKey(provider?.id), provider])
      .filter(([providerId]) => Boolean(providerId))
  );
  const providerConfigById = new Map(
    (Array.isArray(config?.providers) ? config.providers : [])
      .map((provider) => [String(provider?.id || "").trim(), provider])
      .filter(([providerId]) => Boolean(providerId))
  );
  const fallbackCount = parseAmpWebSearchInteger(webSearch?.count, AMP_WEB_SEARCH_DEFAULT_COUNT, {
    min: AMP_WEB_SEARCH_MIN_COUNT,
    max: AMP_WEB_SEARCH_MAX_COUNT
  });

  return orderedProviders.map((provider) => {
    const normalizedId = normalizeWebSearchProviderKey(provider.id);
    const runtimeState = snapshotById.get(normalizedId) || null;
    const configuredIndex = configuredProviders.findIndex((entry) => normalizeWebSearchProviderKey(entry.id) === normalizedId);
    const displayIndex = orderedProviders.findIndex((entry) => normalizeWebSearchProviderKey(entry.id) === normalizedId);
    const isReady = provider.kind === "hosted"
      ? runtimeState?.ready !== false
      : Boolean(provider?.[AMP_WEB_SEARCH_PROVIDER_META[provider.id]?.credentialField || "apiKey"]);

    if (provider.kind === "hosted") {
      const sourceProvider = providerConfigById.get(provider.providerId) || null;
      return {
        id: provider.id,
        key: provider.id,
        kind: "hosted",
        label: String(sourceProvider?.name || provider.providerId).trim() || provider.providerId,
        providerId: provider.providerId,
        modelId: provider.model,
        routeId: provider.id,
        configured: true,
        configuredIndex,
        configuredCount: configuredProviders.length,
        displayIndex,
        displayCount: orderedProviders.length,
        active: isReady,
        runtimeState
      };
    }

    const providerMeta = AMP_WEB_SEARCH_PROVIDER_META[provider.id];
    const credentialField = providerMeta?.credentialField || "apiKey";
    const credentialValue = String(provider?.[credentialField] || "").trim();
    const hasExplicitCount = hasWebSearchDraftField(provider, ["count"]);
    const resultPerCall = parseAmpWebSearchInteger(provider?.count, fallbackCount, {
      min: AMP_WEB_SEARCH_MIN_COUNT,
      max: AMP_WEB_SEARCH_MAX_COUNT
    });
    return {
      id: provider.id,
      key: provider.id,
      kind: "builtin",
      label: providerMeta?.label || provider.id,
      credentialField,
      credentialLabel: providerMeta?.credentialLabel || "Credential",
      credentialPlaceholder: providerMeta?.credentialPlaceholder || "",
      credentialValue,
      resultPerCall,
      resultPerCallInput: hasExplicitCount
        ? String(resultPerCall)
        : (fallbackCount !== AMP_WEB_SEARCH_DEFAULT_COUNT ? String(fallbackCount) : ""),
      limit: parseAmpWebSearchInteger(provider?.limit, providerMeta?.defaultLimit || 0, { min: 0 }),
      remaining: parseAmpWebSearchInteger(provider?.remaining, providerMeta?.defaultLimit || 0, { min: 0 }),
      configured: Boolean(credentialValue),
      configuredIndex,
      configuredCount: configuredProviders.length,
      displayIndex,
      displayCount: orderedProviders.length,
      active: isReady,
      runtimeState
    };
  });
}

function updateWebSearchConfig(config = {}, updates = {}) {
  const next = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(next);
  if (updates.strategy !== undefined) {
    webSearch.strategy = String(updates.strategy || "").trim() === "quota-balance" ? "quota-balance" : "ordered";
  }
  if (updates.count !== undefined) {
    webSearch.count = parseAmpWebSearchInteger(updates.count, webSearch.count, { min: 1, max: 20 });
  }
  return next;
}

function updateWebSearchProviderConfig(config = {}, providerId, updates = {}) {
  const normalizedProviderId = String(providerId || "").trim().toLowerCase();
  if (!AMP_WEB_SEARCH_PROVIDER_META[normalizedProviderId]) return ensureAmpDraftConfigShape(config);

  const next = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(next);
  const existingProviders = Array.isArray(webSearch.providers) ? webSearch.providers.slice() : [];
  const existingIndex = existingProviders.findIndex((provider) => normalizeWebSearchProviderKey(provider?.id) === normalizedProviderId);
  const existingProvider = existingIndex >= 0 ? existingProviders[existingIndex] : null;
  const baseProvider = normalizeBuiltinWebSearchProviderDraft(
    existingProvider || { id: normalizedProviderId },
    normalizedProviderId
  ) || normalizeBuiltinWebSearchProviderDraft({ id: normalizedProviderId }, normalizedProviderId);
  const providerMeta = AMP_WEB_SEARCH_PROVIDER_META[normalizedProviderId];
  const credentialField = providerMeta.credentialField;
  const mergedProvider = normalizeBuiltinWebSearchProviderDraft({
    ...(existingProvider && typeof existingProvider === "object" && !Array.isArray(existingProvider) ? existingProvider : {}),
    ...baseProvider,
    ...updates,
    id: normalizedProviderId,
    [credentialField]: updates[credentialField] !== undefined ? String(updates[credentialField] || "").trim() : baseProvider?.[credentialField]
  }, normalizedProviderId);
  const hasCredential = Boolean(String(mergedProvider?.[credentialField] || "").trim());
  const shouldPersistCount = hasWebSearchDraftField(updates, ["count"])
    ? Boolean(String(updates?.count || "").trim()) && Number(mergedProvider?.count) !== AMP_WEB_SEARCH_DEFAULT_COUNT
    : hasWebSearchDraftField(existingProvider, ["count"]) && Number(mergedProvider?.count) !== AMP_WEB_SEARCH_DEFAULT_COUNT;
  const shouldPersistLimit = hasCredential
    || hasWebSearchDraftField(updates, ["limit"])
    || hasWebSearchDraftField(existingProvider, ["limit"]);
  const shouldPersistRemaining = hasCredential
    || hasWebSearchDraftField(updates, ["remaining"])
    || hasWebSearchDraftField(existingProvider, ["remaining"]);

  const persistedProvider = {
    id: normalizedProviderId,
    ...(hasCredential ? { [credentialField]: String(mergedProvider?.[credentialField] || "").trim() } : {}),
    ...(shouldPersistCount ? { count: Number(mergedProvider.count) } : {}),
    ...(shouldPersistLimit && Number(mergedProvider?.limit) > 0 ? { limit: Number(mergedProvider.limit) } : {}),
    ...(shouldPersistRemaining && (Number(mergedProvider?.limit) > 0 || Number(mergedProvider?.remaining) > 0)
      ? { remaining: Number(mergedProvider.remaining) }
      : {})
  };

  if (existingIndex >= 0) {
    existingProviders[existingIndex] = persistedProvider;
  } else {
    existingProviders.push(persistedProvider);
  }
  webSearch.providers = existingProviders;
  return next;
}

function addHostedWebSearchProviderConfig(config = {}, providerId, modelId) {
  const routeId = buildHostedWebSearchProviderId(providerId, modelId);
  if (!routeId) return ensureAmpDraftConfigShape(config);

  const next = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(next);
  const providers = Array.isArray(webSearch.providers) ? webSearch.providers.slice() : [];
  const routeKey = normalizeWebSearchProviderKey(routeId);
  if (providers.some((provider) => normalizeWebSearchProviderKey(provider?.id) === routeKey)) {
    return next;
  }
  providers.push({
    id: routeId,
    providerId: String(providerId || "").trim(),
    model: String(modelId || "").trim()
  });
  webSearch.providers = providers;
  return next;
}

function removeWebSearchProviderConfig(config = {}, providerId) {
  const normalizedProviderId = normalizeWebSearchProviderKey(providerId);
  const next = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(next);
  const providers = Array.isArray(webSearch.providers) ? webSearch.providers.slice() : [];
  const filteredProviders = providers.filter((provider) => normalizeWebSearchProviderKey(provider?.id) !== normalizedProviderId);
  if (filteredProviders.length === providers.length) return next;
  webSearch.providers = filteredProviders;
  return next;
}

function moveWebSearchProviderConfig(config = {}, providerId, direction = "up") {
  const normalizedProviderId = normalizeWebSearchProviderKey(providerId);
  const next = ensureAmpDraftConfigShape(config);
  const webSearch = ensureWebSearchConfigShape(next);
  const providers = Array.isArray(webSearch.providers) ? webSearch.providers.slice() : [];
  const providerById = new Map(
    providers.map((provider) => [normalizeWebSearchProviderKey(provider?.id), provider]).filter(([id]) => Boolean(id))
  );
  const currentIndex = providers.findIndex((provider) => normalizeWebSearchProviderKey(provider?.id) === normalizedProviderId);

  if (currentIndex !== -1) {
    const targetIndex = direction === "down" ? currentIndex + 1 : currentIndex - 1;
    if (targetIndex < 0 || targetIndex >= providers.length) return next;
    const [movedProvider] = providers.splice(currentIndex, 1);
    providers.splice(targetIndex, 0, movedProvider);
    webSearch.providers = providers;
    return next;
  }

  if (!AMP_WEB_SEARCH_PROVIDER_META[normalizedProviderId]) return next;

  const displayOrder = [
    ...providers.map((provider) => normalizeWebSearchProviderKey(provider?.id)).filter(Boolean),
    ...AMP_WEB_SEARCH_PROVIDER_OPTIONS
      .map((provider) => provider.id)
      .filter((id) => !providerById.has(id))
  ];
  const displayIndex = displayOrder.indexOf(normalizedProviderId);
  if (displayIndex === -1) return next;
  const targetIndex = direction === "down" ? displayIndex + 1 : displayIndex - 1;
  if (targetIndex < 0 || targetIndex >= displayOrder.length) return next;
  const reordered = displayOrder.slice();
  const [movedProviderId] = reordered.splice(displayIndex, 1);
  reordered.splice(targetIndex, 0, movedProviderId);

  const persistedIds = new Set(providerById.keys());
  persistedIds.add(normalizedProviderId);
  for (const id of reordered.slice(0, targetIndex + 1)) {
    if (AMP_WEB_SEARCH_PROVIDER_META[id]) persistedIds.add(id);
  }

  webSearch.providers = reordered
    .filter((id) => persistedIds.has(id))
    .map((id) => providerById.get(id) || { id });
  return next;
}

function shouldImmediateAutosaveWebSearchProviderChange(providerId, field, value) {
  const normalizedProviderId = String(providerId || "").trim().toLowerCase();
  const providerMeta = AMP_WEB_SEARCH_PROVIDER_META[normalizedProviderId];
  if (!providerMeta) return false;
  if (String(field || "").trim() !== providerMeta.credentialField) return false;
  return !String(value || "").trim();
}

function buildManagedRouteOptions(config = {}) {
  const options = [];
  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};

  for (const aliasId of Object.keys(aliases)) {
    options.push({
      value: aliasId,
      label: aliasId,
      hint: `Alias · ${(aliases[aliasId]?.targets || []).length || 0} target(s)`,
      kind: "alias",
      groupKey: "aliases",
      groupLabel: "Aliases"
    });
  }

  for (const provider of (Array.isArray(config?.providers) ? config.providers : [])) {
    const providerId = String(provider?.id || "").trim();
    const providerLabel = String(provider?.name || providerId || "provider").trim() || "provider";
    for (const model of (Array.isArray(provider?.models) ? provider.models : [])) {
      const modelId = String(model?.id || "").trim();
      if (!providerId || !modelId) continue;
      const contextWindow = Number.isFinite(model?.contextWindow) ? Number(model.contextWindow) : null;
      options.push({
        value: `${providerId}/${modelId}`,
        label: `${providerId}/${modelId}`,
        hint: contextWindow ? `${providerLabel} · ${formatContextWindow(contextWindow)}` : providerLabel,
        kind: "model",
        providerId,
        groupKey: `provider:${providerId}`,
        groupLabel: providerLabel
      });
    }
  }

  const seen = new Set();
  return options.filter((option) => {
    if (!option?.value || seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

function inferManagedRouteOptionMetadata(value = "") {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return {};

  const normalizedAliasValue = normalizedValue.startsWith("alias:")
    ? normalizedValue.slice("alias:".length).trim()
    : normalizedValue;
  if (!normalizedAliasValue.includes("/")) {
    return {
      kind: "alias",
      groupKey: "aliases",
      groupLabel: "Aliases"
    };
  }

  const separatorIndex = normalizedAliasValue.indexOf("/");
  const providerId = normalizedAliasValue.slice(0, separatorIndex).trim();
  if (!providerId) return {};
  return {
    kind: "model",
    providerId,
    groupKey: `provider:${providerId}`,
    groupLabel: providerId
  };
}

function formatContextWindow(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return "Unknown";
  if (normalized >= 1000) {
    const roundedK = normalized / 1000;
    const rendered = Number.isInteger(roundedK) ? String(roundedK) : roundedK.toFixed(1).replace(/\.0$/, "");
    return `${rendered}K`;
  }
  return String(normalized);
}

function formatCompactContextWindowInput(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return "";

  const units = [
    { suffix: "M", divisor: 1000 * 1000 },
    { suffix: "K", divisor: 1000 }
  ];

  for (const unit of units) {
    if (normalized < unit.divisor) continue;
    const scaledValue = normalized / unit.divisor;
    const renderedValue = scaledValue >= 10
      ? String(Math.round(scaledValue))
      : scaledValue.toFixed(1).replace(/\.0$/, "");
    return `${renderedValue}${unit.suffix}`;
  }

  return String(normalized);
}

function formatEditableContextWindowInput(value) {
  const normalizedValue = normalizeContextWindowInput(value);
  const normalized = Number(normalizedValue);
  if (!Number.isFinite(normalized) || normalized <= 0) return String(value || "");
  return new Intl.NumberFormat().format(normalized);
}

function buildProviderModelContextWindowMap(config = {}) {
  const map = new Map();
  for (const provider of (Array.isArray(config?.providers) ? config.providers : [])) {
    const providerId = String(provider?.id || "").trim();
    if (!providerId) continue;
    for (const model of (Array.isArray(provider?.models) ? provider.models : [])) {
      const modelId = String(model?.id || "").trim();
      if (!modelId) continue;
      map.set(`${providerId}/${modelId}`, {
        ref: `${providerId}/${modelId}`,
        providerId,
        providerName: String(provider?.name || providerId).trim() || providerId,
        modelId,
        contextWindow: Number.isFinite(model?.contextWindow) ? Number(model.contextWindow) : null
      });
    }
  }
  return map;
}

function buildAliasContextWindowSummary(aliasId = "", config = {}) {
  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};
  const modelContextMap = buildProviderModelContextWindowMap(config);
  const seenAliases = new Set();
  const seenModelRefs = new Set();
  const models = [];
  const unknownRefs = [];

  function visitRouteRef(ref) {
    const normalizedRef = String(ref || "").trim();
    if (!normalizedRef) return;

    if (modelContextMap.has(normalizedRef)) {
      if (seenModelRefs.has(normalizedRef)) return;
      seenModelRefs.add(normalizedRef);
      models.push(modelContextMap.get(normalizedRef));
      return;
    }

    const normalizedAliasRef = normalizedRef.startsWith("alias:") ? normalizedRef.slice("alias:".length).trim() : normalizedRef;
    if (!normalizedAliasRef || !Object.prototype.hasOwnProperty.call(aliases, normalizedAliasRef)) {
      if (!unknownRefs.includes(normalizedRef)) unknownRefs.push(normalizedRef);
      return;
    }

    if (seenAliases.has(normalizedAliasRef)) return;
    seenAliases.add(normalizedAliasRef);
    const nestedAlias = aliases[normalizedAliasRef];
    for (const target of [...(nestedAlias?.targets || []), ...(nestedAlias?.fallbackTargets || [])]) {
      visitRouteRef(target?.ref);
    }
  }

  visitRouteRef(aliasId);

  const knownModels = models.filter((model) => Number.isFinite(model?.contextWindow));
  const uniqueWindows = [...new Set(knownModels.map((model) => model.contextWindow))].sort((left, right) => left - right);
  const smallestContextWindow = uniqueWindows[0] ?? null;
  const largestContextWindow = uniqueWindows[uniqueWindows.length - 1] ?? null;

  return {
    aliasId,
    models,
    unknownRefs,
    smallestContextWindow,
    largestContextWindow,
    hasMixedContextWindows: uniqueWindows.length > 1
  };
}

function buildAliasGuideContextNotes(config = {}) {
  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};

  return Object.keys(aliases)
    .map((aliasId) => buildAliasContextWindowSummary(aliasId, config))
    .filter((summary) => summary.hasMixedContextWindows)
    .sort((left, right) => String(left.aliasId || "").localeCompare(String(right.aliasId || "")));
}

function withCurrentManagedRouteOptions(options = [], values = []) {
  const nextOptions = [...(Array.isArray(options) ? options : [])];
  const seen = new Set(nextOptions.map((option) => String(option?.value || "").trim()).filter(Boolean));

  for (const value of (Array.isArray(values) ? values : []).map((entry) => String(entry || "").trim()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    nextOptions.push({
      value,
      label: value,
      hint: "Current config",
      ...inferManagedRouteOptionMetadata(value)
    });
  }

  return nextOptions;
}

function buildGroupedSelectOptions(options = []) {
  const groups = [];
  const groupsByKey = new Map();
  let ungroupedGroup = null;

  for (const option of (Array.isArray(options) ? options : []).filter(Boolean)) {
    const groupKey = String(option?.groupKey || option?.groupLabel || "").trim();
    const groupLabel = String(option?.groupLabel || "").trim();

    if (!groupKey) {
      if (!ungroupedGroup) {
        ungroupedGroup = { key: "__ungrouped__", label: "", options: [] };
        groups.push(ungroupedGroup);
      }
      ungroupedGroup.options.push(option);
      continue;
    }

    let group = groupsByKey.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        label: groupLabel || groupKey,
        options: []
      };
      groupsByKey.set(groupKey, group);
      groups.push(group);
    }
    group.options.push(option);
  }

  return groups;
}

function formatRouteOptionSelectLabel(option = {}, { includeHint = false } = {}) {
  const label = String(option?.label || option?.value || "").trim() || String(option?.value || "").trim();
  const hint = String(option?.hint || "").trim();
  return includeHint && hint ? `${label} · ${hint}` : label;
}

function renderSelectOptionNodes(options = [], {
  keyPrefix = "select-option",
  includeHint = false
} = {}) {
  return buildGroupedSelectOptions(options).map((group, groupIndex) => {
    const items = group.options.map((option) => (
      <SelectItem
        key={`${keyPrefix}-${option.value}`}
        value={option.value}
        searchText={`${option.label || ""} ${option.value || ""} ${option.hint || ""} ${group.label || ""}`}
      >
        {formatRouteOptionSelectLabel(option, { includeHint })}
      </SelectItem>
    ));

    if (!group.label) return items;
    return (
      <SelectGroup key={`${keyPrefix}-group-${group.key || groupIndex}`}>
        <SelectLabel>{group.label}</SelectLabel>
        {items}
      </SelectGroup>
    );
  });
}

function buildCodexCliGuideContent({
  bindingValue = "",
  thinkingLevel = "",
  configFilePath = "",
  endpointUrl = ""
} = {}) {
  const normalizedBindingValue = String(bindingValue || "").trim();
  const normalizedThinkingLevel = String(thinkingLevel || "").trim();
  const normalizedConfigFilePath = String(configFilePath || "").trim();
  const normalizedEndpointUrl = String(endpointUrl || "").trim();
  const inheritMode = isCodexCliInheritModelBinding(normalizedBindingValue);

  const modeBadgeLabel = inheritMode
    ? "Mode: Inherit Codex model"
    : normalizedBindingValue
      ? `Mode: Pinned to ${normalizedBindingValue}`
      : "Mode: Choose a route";
  const callout = inheritMode
    ? {
        variant: "success",
        title: "Inherit mode keeps Codex-native model picks intact.",
        body: (
          <>
            Codex CLI still chooses its own model name. Create a same-name alias in the <span className="font-medium">Alias &amp; Fallback</span> tab so LLM Router can resolve that name to the real upstream target you want.
          </>
        )
      }
    : normalizedBindingValue
      ? {
          variant: "info",
          title: "Pinned mode forces one router target.",
          body: (
            <>
              LLM Router writes <code>model={normalizedBindingValue}</code> into Codex CLI config. That is the simplest setup when every Codex session should use one managed route or alias.
            </>
          )
        }
      : {
          variant: "warning",
          title: "Choose your model strategy before you connect.",
          body: (
            <>
              Pick <span className="font-medium">Inherit Codex CLI model</span> if Codex should keep using its built-in model names, or pick one managed route/alias if you want a single fixed target.
            </>
          )
        };

  return {
    title: "Codex CLI guide",
    description: "Quick setup for routing Codex CLI through LLM Router while keeping model routing easy to inspect and change later.",
    badges: [
      { label: modeBadgeLabel, variant: inheritMode ? "success" : normalizedBindingValue ? "info" : "outline" },
      { label: normalizedThinkingLevel ? `Thinking: ${normalizedThinkingLevel}` : "Thinking: Codex default", variant: "outline" },
      { label: normalizedConfigFilePath ? "Config file detected" : "User config: ~/.codex/config.toml", variant: "outline" }
    ],
    callout,
    highlights: [
      {
        eyebrow: "1. Connect",
        title: "Point Codex CLI at LLM Router",
        body: normalizedEndpointUrl
          ? (
              <>
                When connected, Codex sends requests to <code>{normalizedEndpointUrl}</code>. LLM Router then handles upstream auth, alias resolution, and failover.
              </>
            )
          : (
              <>
                Click <span className="font-medium">Connect</span> to patch Codex CLI so it talks to LLM Router instead of a provider directly.
              </>
            )
      },
      {
        eyebrow: "2. Route",
        title: "Choose between inherit and pinned mode",
        body: inheritMode
          ? (
              <>
                Keep Codex model names such as <code>gpt-5.4</code>, then create matching aliases in LLM Router, for example <code>gpt-5.4</code> -&gt; <code>demo/gpt-4o-mini</code>.
              </>
            )
          : (
              <>
                Select one managed route or alias in <span className="font-medium">Default model</span> when you want every Codex request to land on the same router target.
              </>
            )
      },
      {
        eyebrow: "3. Tune",
        title: "Optional reasoning control",
        body: (
          <>
            <span className="font-medium">Thinking level</span> writes Codex CLI <code>model_reasoning_effort</code> with the official values <code>minimal</code>, <code>low</code>, <code>medium</code>, <code>high</code>, or <code>xhigh</code>.
          </>
        )
      }
    ],
    sections: [
      {
        title: "Quick start",
        items: [
          <>Set a <code>masterKey</code> in LLM Router first. The <span className="font-medium">Connect</span> button stays disabled until gateway auth is ready.</>,
          <>Click <span className="font-medium">Connect</span> to patch the Codex CLI config file and router base URL.</>,
          inheritMode
            ? <>Leave <span className="font-medium">Default model</span> on <span className="font-medium">Inherit Codex CLI model</span>, then create aliases that match the Codex model names you actually use.</>
            : normalizedBindingValue
              ? <>Your current default is pinned to <code>{normalizedBindingValue}</code>. Change it only when you want Codex to use a different managed route or alias.</>
              : <>Choose either <span className="font-medium">Inherit Codex CLI model</span> or one managed route/alias in <span className="font-medium">Default model</span> before you start using Codex through the router.</>,
          <>Set <span className="font-medium">Thinking level</span> only when you want LLM Router to write <code>model_reasoning_effort</code>; leave it unset to keep Codex CLI defaults.</>
        ]
      },
      {
        title: "Choose the right model strategy",
        items: [
          <>Use <span className="font-medium">Inherit Codex CLI model</span> when you want Codex-native model names and model-specific UI/options to remain visible.</>,
          <>Use a fixed route or alias when your team wants one centrally managed target regardless of what Codex would otherwise choose.</>,
          <>If Codex-specific options disappear after pinning a route, switch back to inherit mode and route those same model names through aliases instead.</>
        ]
      },
      {
        title: "Where these settings land",
        items: [
          normalizedConfigFilePath
            ? <>This page is currently managing <code>{normalizedConfigFilePath}</code>.</>
            : <>Codex CLI usually stores user settings in <code>~/.codex/config.toml</code>. Trusted projects can also add overrides in <code>.codex/config.toml</code>.</>,
          <>The router-managed bindings in this panel map to Codex CLI <code>model</code> and <code>model_reasoning_effort</code>.</>,
          <>Use <span className="font-medium">Open Codex CLI Config File</span> whenever you want to inspect the exact generated config.</>
        ]
      },
      {
        title: "Quick verify",
        items: [
          <>Open the config file from this page and confirm the values match the mode you intended.</>,
          <>Start Codex CLI and run a small prompt. If inherit mode is on, make sure the Codex model you selected has a same-name alias in LLM Router.</>,
          <>If requests fail after switching models, check the <span className="font-medium">Alias &amp; Fallback</span> tab first because the alias behind that model name may be missing or pointed at the wrong target.</>
        ]
      }
    ]
  };
}

function buildClaudeCodeGuideContent({
  bindings = {},
  settingsFilePath = "",
  endpointUrl = ""
} = {}) {
  const primaryModel = String(bindings?.primaryModel || "").trim();
  const defaultOpusModel = String(bindings?.defaultOpusModel || "").trim();
  const defaultSonnetModel = String(bindings?.defaultSonnetModel || "").trim();
  const defaultHaikuModel = String(bindings?.defaultHaikuModel || "").trim();
  const subagentModel = String(bindings?.subagentModel || "").trim();
  const normalizedLevel = normalizeClaudeCodeEffortLevel(bindings?.thinkingLevel);
  const normalizedSettingsFilePath = String(settingsFilePath || "").trim();
  const normalizedEndpointUrl = String(endpointUrl || "").trim();
  const activeOverrideCount = [
    primaryModel,
    defaultOpusModel,
    defaultSonnetModel,
    defaultHaikuModel,
    subagentModel,
    normalizedLevel
  ].filter(Boolean).length;

  const callout = primaryModel
    ? {
        variant: "info",
        title: "Primary model override is active.",
        body: (
          <>
            LLM Router is currently writing <code>ANTHROPIC_MODEL={primaryModel}</code>. Leave that field blank if you want Claude Code to keep choosing its own primary model.
          </>
        )
      }
    : activeOverrideCount > 0
      ? {
          variant: "info",
          title: "Only filled fields are overridden.",
          body: (
            <>
              Claude Code continues to inherit its normal defaults for every blank field. This is useful when you only want to steer alias models, subagents, or effort level through LLM Router.
            </>
          )
        }
      : {
          variant: "success",
          title: "Blank fields are a valid setup.",
          body: (
            <>
              You do not need to fill every binding. Leave fields empty unless you want LLM Router to override that specific Claude Code setting.
            </>
          )
        };

  return {
    title: "Claude Code guide",
    description: "Quick setup for routing Claude Code through LLM Router while keeping only the model and effort level overrides you actually want.",
    badges: [
      { label: activeOverrideCount > 0 ? `${activeOverrideCount} override${activeOverrideCount === 1 ? "" : "s"} active` : "No router overrides", variant: activeOverrideCount > 0 ? "info" : "outline" },
      { label: normalizedLevel ? `Effort: ${normalizedLevel}` : "Effort: Claude adaptive default", variant: "outline" },
      { label: normalizedSettingsFilePath ? "Settings file detected" : "Settings scope: local/project/user", variant: "outline" }
    ],
    callout,
    highlights: [
      {
        eyebrow: "1. Connect",
        title: "Point Claude Code at the router",
        body: normalizedEndpointUrl
          ? (
              <>
                When connected, Claude Code sends requests to <code>{normalizedEndpointUrl}</code>. LLM Router then handles upstream auth, route selection, and failover.
              </>
            )
          : (
              <>
                Click <span className="font-medium">Connect</span> to patch Claude Code so it uses the router Anthropic endpoint instead of a provider directly.
              </>
            )
      },
      {
        eyebrow: "2. Override",
        title: "Set only the bindings you need",
        body: (
          <>
            Leave fields blank to inherit Claude Code defaults. Fill <code>ANTHROPIC_MODEL</code>, the Opus/Sonnet/Haiku defaults, or <code>CLAUDE_CODE_SUBAGENT_MODEL</code> only when you want LLM Router to manage those values.
          </>
        )
      },
      {
        eyebrow: "3. Effort",
        title: "Set thinking effort level",
        body: (
          <>
            The <span className="font-medium">Effort level</span> dropdown writes <code>CLAUDE_CODE_EFFORT_LEVEL</code> to your shell profile. If the shell profile cannot be updated, <code>effortLevel</code> is set in <code>settings.json</code> as a fallback (only &quot;high&quot; is supported there).
          </>
        )
      }
    ],
    sections: [
      {
        title: "Quick start",
        items: [
          <>Click <span className="font-medium">Connect</span> to patch Claude Code toward the router and keep provider credentials centralized inside LLM Router.</>,
          <>Leave <span className="font-medium">Current model override</span> empty unless you explicitly want to replace Claude Code&apos;s own main model selection.</>,
          <>Use <span className="font-medium">Default Opus</span>, <span className="font-medium">Default Sonnet</span>, and <span className="font-medium">Default Haiku</span> when you want Claude Code&apos;s built-in alias names to resolve to managed routes or aliases.</>,
          <>Use <span className="font-medium">Sub-agent model</span> when background workers or helper agents should run on a different route than the main session.</>,
          <>Use <span className="font-medium">Effort level</span> to set <code>CLAUDE_CODE_EFFORT_LEVEL</code> in your shell profile; leave it unset to keep Claude Code&apos;s adaptive default. The <code>effortLevel</code> key in <code>settings.json</code> (only &quot;high&quot;) acts as a fallback when the shell profile cannot be updated.</>
        ]
      },
      {
        title: "What each binding controls",
        items: [
          <><code>ANTHROPIC_MODEL</code>: overrides the main model for the active Claude Code session.</>,
          <><code>ANTHROPIC_DEFAULT_OPUS_MODEL</code>, <code>ANTHROPIC_DEFAULT_SONNET_MODEL</code>, and <code>ANTHROPIC_DEFAULT_HAIKU_MODEL</code>: remap Claude Code&apos;s built-in alias names to managed routes or aliases.</>,
          <><code>CLAUDE_CODE_SUBAGENT_MODEL</code>: routes subagents and background workers to a specific managed model.</>,
          normalizedLevel
            ? <><code>CLAUDE_CODE_EFFORT_LEVEL</code>: currently set to <span className="font-medium">{normalizedLevel}</span> in your shell profile.</>
            : <><code>CLAUDE_CODE_EFFORT_LEVEL</code>: stays unset unless you choose an effort level.</>
        ]
      },
      {
        title: "Settings scope and precedence",
        items: [
          <>Claude Code settings apply in this order: <code>managed-settings.json</code>, CLI arguments, <code>.claude/settings.local.json</code>, <code>.claude/settings.json</code>, then <code>~/.claude/settings.json</code>.</>,
          normalizedSettingsFilePath
            ? <>This page is currently managing <code>{normalizedSettingsFilePath}</code>.</>
            : <>Claude Code can read from project-local, project-shared, or user settings files depending on what exists in your environment.</>,
          <>If a value seems ignored, check whether a higher-precedence file or command-line flag is overriding it.</>
        ]
      },
      {
        title: "Quick verify",
        items: [
          <>Open the settings file from this page and confirm the <code>env</code> block contains only the overrides you meant to set.</>,
          <>Launch Claude Code and test both the main session and any subagents if you changed <code>CLAUDE_CODE_SUBAGENT_MODEL</code>.</>,
          <>If thinking behavior is not what you expected, remember this UI writes <code>CLAUDE_CODE_EFFORT_LEVEL</code> to your shell profile; clearing the field returns control to Claude Code&apos;s own default behavior.</>
        ]
      }
    ]
  };
}

function buildFactoryDroidGuideContent({
  bindings = {},
  settingsFilePath = "",
  endpointUrl = ""
} = {}) {
  const defaultModel = String(bindings?.defaultModel || "").trim();
  const reasoningEffort = normalizeFactoryDroidReasoningEffort(bindings?.reasoningEffort);
  const normalizedSettingsFilePath = String(settingsFilePath || "").trim();
  const normalizedEndpointUrl = String(endpointUrl || "").trim();

  const callout = defaultModel
    ? {
        variant: "info",
        title: "Default model is set.",
        body: (
          <>
            LLM Router is writing <code>model={defaultModel}</code> and injecting a <code>customModels</code> entry into your Factory Droid settings. All requests route through the gateway.
          </>
        )
      }
    : {
        variant: "success",
        title: "Factory Droid connected via custom model entry.",
        body: (
          <>
            LLM Router injects a managed <code>customModels</code> entry pointing at the gateway. Select a default model below or use Factory Droid&apos;s <code>/model</code> command to pick the routed model at runtime.
          </>
        )
      };

  return {
    title: "Factory Droid guide",
    description: "Quick setup for routing Factory Droid through LLM Router via a managed custom model entry.",
    badges: [
      { label: defaultModel ? `Model: ${defaultModel}` : "No model override", variant: defaultModel ? "info" : "outline" },
      { label: reasoningEffort ? `Reasoning: ${reasoningEffort}` : "Reasoning: Droid default", variant: "outline" },
      { label: normalizedSettingsFilePath ? "Settings file detected" : "User config: ~/.factory/settings.json", variant: "outline" }
    ],
    callout,
    highlights: [
      {
        eyebrow: "1. Connect",
        title: "Point Factory Droid at LLM Router",
        body: normalizedEndpointUrl
          ? (
              <>
                When connected, Factory Droid sends requests to <code>{normalizedEndpointUrl}</code>. LLM Router handles upstream auth, alias resolution, and failover.
              </>
            )
          : (
              <>
                Click <span className="font-medium">Connect</span> to inject a managed custom model entry into Factory Droid settings.
              </>
            )
      },
      {
        eyebrow: "2. Route",
        title: "Set the default model",
        body: (
          <>
            Pick a managed route or alias in <span className="font-medium">Default model</span> to control which upstream model Factory Droid uses.
          </>
        )
      },
      {
        eyebrow: "3. Tune",
        title: "Optional reasoning control",
        body: (
          <>
            <span className="font-medium">Reasoning effort</span> writes Factory Droid <code>reasoningEffort</code>. Values: <code>off</code>, <code>none</code>, <code>low</code>, <code>medium</code>, or <code>high</code>.
          </>
        )
      }
    ],
    sections: [
      {
        title: "Quick start",
        items: [
          <>Set a <code>masterKey</code> in LLM Router first. The <span className="font-medium">Connect</span> button stays disabled until gateway auth is ready.</>,
          <>Click <span className="font-medium">Connect</span> to inject a managed <code>customModels</code> entry into <code>~/.factory/settings.json</code>.</>,
          defaultModel
            ? <>Your default model is set to <code>{defaultModel}</code>. Change it any time from this panel.</>
            : <>Choose a managed route or alias in <span className="font-medium">Default model</span> to route all Factory Droid requests.</>,
          <>Set <span className="font-medium">Reasoning effort</span> only when you want LLM Router to write <code>reasoningEffort</code>; leave it unset to keep Factory Droid defaults.</>
        ]
      },
      {
        title: "How it works",
        items: [
          <>LLM Router adds a <code>customModels</code> entry with <code>provider: &quot;openai&quot;</code> and the gateway base URL. Factory Droid treats it as a standard OpenAI-compatible endpoint.</>,
          <>The injected entry has a <code>_llmRouterManaged</code> marker so it can be cleanly updated or removed without touching your other custom models.</>,
          <>Disconnecting removes only the managed entry and restores any backed-up model or reasoning settings.</>
        ]
      },
      {
        title: "Where these settings land",
        items: [
          normalizedSettingsFilePath
            ? <>This page is managing <code>{normalizedSettingsFilePath}</code>.</>
            : <>Factory Droid stores user settings in <code>~/.factory/settings.json</code>.</>,
          <>The router-managed bindings map to Factory Droid <code>model</code> and <code>reasoningEffort</code> fields.</>,
          <>Use <span className="font-medium">Open Config File</span> to inspect the generated settings.</>
        ]
      },
      {
        title: "Quick verify",
        items: [
          <>Open the settings file from this page and confirm the <code>customModels</code> array contains the LLM Router entry.</>,
          <>Launch Factory Droid and run a small prompt. Use <code>/model</code> to confirm the routed model is available.</>,
          <>If requests fail, check the <span className="font-medium">Alias &amp; Fallback</span> tab first to ensure the alias behind your model exists.</>
        ]
      }
    ]
  };
}

function buildAmpKnownRouteKeySet() {
  return new Set([
    ...DEFAULT_AMP_ENTITY_DEFINITIONS.map((entry) => entry.id),
    ...DEFAULT_AMP_SIGNATURE_DEFINITIONS.map((entry) => entry.id)
  ].map((value) => String(value || "").trim()).filter(Boolean));
}

const KNOWN_AMP_ROUTE_KEYS = buildAmpKnownRouteKeySet();

function isKnownAmpRouteKey(value) {
  return KNOWN_AMP_ROUTE_KEYS.has(String(value || "").trim());
}

function ensureAmpRouteCollections(amp) {
  if (!amp.routes || typeof amp.routes !== "object" || Array.isArray(amp.routes)) {
    amp.routes = {};
  }
  if (!Array.isArray(amp.rawModelRoutes)) {
    amp.rawModelRoutes = [];
  }
}

function getAmpAnchoredRouteKey(mapping = {}) {
  return String(mapping?.sourceRouteKey || "").trim();
}

function buildAmpEntityRows(config = {}) {
  const nextConfig = ensureAmpDraftConfigShape(config);
  const amp = nextConfig.amp;
  ensureAmpRouteCollections(amp);

  const anchoredRawRoutes = new Map();
  const rawRouteEntries = [];
  for (const [index, mapping] of (amp.rawModelRoutes || []).entries()) {
    const sourceRouteKey = getAmpAnchoredRouteKey(mapping);
    if (sourceRouteKey && isKnownAmpRouteKey(sourceRouteKey)) {
      anchoredRawRoutes.set(sourceRouteKey, { mapping, index });
      continue;
    }

    rawRouteEntries.push({
      id: `raw:${index}`,
      source: "raw",
      index,
      routeKey: "",
      inbound: String(mapping?.from || "").trim(),
      outbound: String(mapping?.to || "").trim(),
      label: "Custom mapping",
      description: `Wildcard/raw match: ${String(mapping?.from || "").trim() || "(empty)"}`,
      defaultMatch: "",
      isCustom: true,
      removable: true
    });
  }

  const builtInRouteEntries = DEFAULT_AMP_ENTITY_DEFINITIONS.map((entry) => {
    const routeKey = String(entry.id || "").trim();
    const defaultMatch = getAmpDefaultMatchForRouteKey(routeKey);
    const anchoredRawRoute = anchoredRawRoutes.get(routeKey)?.mapping || null;
    return {
      id: `route:${routeKey}`,
      source: "route",
      routeKey,
      inbound: String(anchoredRawRoute?.from || defaultMatch || routeKey).trim(),
      outbound: String(anchoredRawRoute?.to || amp.routes?.[routeKey] || "").trim(),
      label: formatAmpEntityLabel(routeKey),
      description: entry.description || "",
      defaultMatch,
      isCustom: false,
      removable: false
    };
  });

  const configuredRouteEntries = Object.entries(amp.routes || {})
    .filter(([key]) => !DEFAULT_AMP_ENTITY_DEFINITIONS.some((entry) => entry.id === key))
    .map(([key, target]) => {
      const routeKey = String(key || "").trim();
      const defaultMatch = getAmpDefaultMatchForRouteKey(routeKey);
      const isKnownKey = isKnownAmpRouteKey(routeKey);
      return {
        id: `route:${routeKey}`,
        source: "route",
        routeKey,
        inbound: routeKey,
        outbound: String(target || "").trim(),
        label: isKnownKey ? (defaultMatch || routeKey) : formatAmpEntityLabel(routeKey),
        description: isKnownKey ? `Route key: ${routeKey}` : `Custom route key: ${routeKey}`,
        defaultMatch,
        isCustom: true,
        removable: true
      };
    });

  return [...builtInRouteEntries, ...configuredRouteEntries, ...rawRouteEntries];
}

function findAmpEditableRouteEntry(config, entryId) {
  return buildAmpEntityRows(config).find((entry) => entry.id === entryId) || null;
}

function updateAmpEditableRouteConfig(config = {}, entryId, {
  inbound,
  outbound
} = {}) {
  const next = ensureAmpDraftConfigShape(config);
  const amp = next.amp;
  ensureAmpRouteCollections(amp);

  const currentEntry = findAmpEditableRouteEntry(next, entryId);
  if (!currentEntry) return next;

  const nextInbound = String(inbound ?? currentEntry.inbound ?? "").trim();
  const nextOutbound = String(outbound ?? currentEntry.outbound ?? "").trim();
  const preferredRouteKey = currentEntry.source === "route"
    ? String(currentEntry.routeKey || "").trim()
    : "";
  const preferredDefaultMatch = preferredRouteKey
    ? String(currentEntry.defaultMatch || "").trim()
    : "";
  const anchoredRawRouteIndex = preferredRouteKey
    ? amp.rawModelRoutes.findIndex((mapping) => getAmpAnchoredRouteKey(mapping) === preferredRouteKey)
    : -1;
  const usesAnchoredBuiltInRoute = preferredRouteKey && isKnownAmpRouteKey(preferredRouteKey);
  const nextKnownRouteKey = isKnownAmpRouteKey(nextInbound)
    ? nextInbound
    : (preferredRouteKey && preferredDefaultMatch && nextInbound === preferredDefaultMatch ? preferredRouteKey : "");

  if (currentEntry.source === "route" && currentEntry.routeKey) {
    delete amp.routes[currentEntry.routeKey];
  }
  if (currentEntry.source === "raw" && Number.isInteger(currentEntry.index)) {
    amp.rawModelRoutes.splice(currentEntry.index, 1);
  }
  if (anchoredRawRouteIndex >= 0) {
    amp.rawModelRoutes.splice(anchoredRawRouteIndex, 1);
  }

  if (nextKnownRouteKey) {
    if (nextOutbound) {
      amp.routes[nextKnownRouteKey] = nextOutbound;
    }
    return next;
  }

  if (usesAnchoredBuiltInRoute) {
    const defaultInbound = preferredDefaultMatch || preferredRouteKey;
    if (nextOutbound) {
      amp.routes[preferredRouteKey] = nextOutbound;
    }
    if (nextInbound && nextInbound !== defaultInbound) {
      amp.rawModelRoutes.push({
        from: nextInbound,
        sourceRouteKey: preferredRouteKey
      });
    }
    return next;
  }

  if (nextInbound && nextOutbound) {
    amp.rawModelRoutes.push({ from: nextInbound, to: nextOutbound });
  }

  return next;
}

function createAmpEditableRoute(config = {}, {
  inbound,
  outbound
} = {}) {
  const next = ensureAmpDraftConfigShape(config);
  const amp = next.amp;
  ensureAmpRouteCollections(amp);

  const nextInbound = String(inbound || "").trim();
  const nextOutbound = String(outbound || "").trim();
  const nextKnownRouteKey = isKnownAmpRouteKey(nextInbound) ? nextInbound : "";

  if (!nextInbound || !nextOutbound) return next;

  if (nextKnownRouteKey) {
    amp.routes[nextKnownRouteKey] = nextOutbound;
    return next;
  }

  amp.rawModelRoutes.push({ from: nextInbound, to: nextOutbound });
  return next;
}

function removeAmpEditableRoute(config = {}, entryId) {
  const next = ensureAmpDraftConfigShape(config);
  const amp = next.amp;
  ensureAmpRouteCollections(amp);

  const currentEntry = findAmpEditableRouteEntry(next, entryId);
  if (!currentEntry?.removable) return next;

  if (currentEntry.source === "route" && currentEntry.routeKey) {
    delete amp.routes[currentEntry.routeKey];
  }
  if (currentEntry.source === "raw" && Number.isInteger(currentEntry.index)) {
    amp.rawModelRoutes.splice(currentEntry.index, 1);
  }

  return next;
}

function removeProviderFromConfig(config, providerId) {
  const next = safeClone(config && typeof config === "object" ? config : {});
  next.providers = (Array.isArray(next.providers) ? next.providers : []).filter((provider) => provider?.id !== providerId);

  const remainingModelRefs = new Set(
    (next.providers || []).flatMap((provider) =>
      (provider.models || []).map((model) => `${provider.id}/${model.id}`)
    )
  );

  const aliases = next.modelAliases && typeof next.modelAliases === "object" ? next.modelAliases : {};
  const nextAliases = {};
  for (const [aliasId, alias] of Object.entries(aliases)) {
    const targets = Array.isArray(alias?.targets)
      ? alias.targets.filter((target) => !isProviderReference(target?.ref, providerId))
      : [];
    const fallbackTargets = Array.isArray(alias?.fallbackTargets)
      ? alias.fallbackTargets.filter((target) => !isProviderReference(target?.ref, providerId))
      : [];

    nextAliases[aliasId] = {
      ...alias,
      ...(Array.isArray(alias?.targets) ? { targets } : {}),
      ...(Array.isArray(alias?.fallbackTargets) ? { fallbackTargets } : {})
    };
  }
  next.modelAliases = nextAliases;

  if (next.defaultModel && !next.modelAliases?.[next.defaultModel] && !remainingModelRefs.has(next.defaultModel)) {
    next.defaultModel = DEFAULT_MODEL_ALIAS_ID;
  }

  if (next?.amp?.defaultRoute && !next.modelAliases?.[next.amp.defaultRoute] && !remainingModelRefs.has(next.amp.defaultRoute)) {
    next.amp = {
      ...next.amp,
      defaultRoute: next.defaultModel || pickFallbackDefaultModel(next)
    };
  }

  return next;
}

function collectQuickStartEndpoints(provider = {}) {
  const fromMetadata = Array.isArray(provider?.metadata?.endpointCandidates) ? provider.metadata.endpointCandidates : [];
  const fromConfig = [provider?.baseUrl, ...Object.values(provider?.baseUrlByFormat || {})];
  return Array.from(new Set((fromMetadata.length > 0 ? fromMetadata : fromConfig)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)));
}

function getStoredProviderCredentialPayload(provider = {}) {
  const apiKeyEnv = String(provider?.apiKeyEnv || "").trim();
  if (apiKeyEnv) return { apiKeyEnv };

  const apiKey = String(provider?.apiKey || provider?.credential || "").trim();
  return apiKey ? { apiKey } : {};
}

function getDraftProviderCredentialPayload(draftProvider = {}, provider = {}) {
  if (draftProvider && Object.prototype.hasOwnProperty.call(draftProvider, "credentialInput")) {
    const credentialInput = String(draftProvider?.credentialInput || "").trim();
    if (!credentialInput) return {};
    return looksLikeEnvVarName(credentialInput)
      ? { apiKeyEnv: credentialInput }
      : { apiKey: credentialInput };
  }

  return getStoredProviderCredentialPayload(provider);
}

function inferQuickStartConnectionType(provider = {}) {
  if (provider?.type === "subscription") {
    return "subscription";
  }
  return "api";
}

function inferQuickStartPresetKey(provider = {}) {
  if (provider?.type === "subscription") {
    return provider?.subscriptionType === "claude-code" ? "oauth-claude" : "oauth-gpt";
  }
  const endpoints = collectQuickStartEndpoints(provider);
  for (const ep of endpoints) {
    try {
      const host = new URL(String(ep || "")).hostname;
      const preset = findPresetByHost(host);
      if (preset) return preset.key;
    } catch { /* ignore */ }
  }
  return "custom";
}

function createProviderInlineDraftState(provider = {}) {
  const endpoints = collectQuickStartEndpoints(provider);
  const connectionType = inferQuickStartConnectionType(provider);
  const presetKey = inferQuickStartPresetKey(provider);
  const rateLimitDefaults = getQuickStartRateLimitDefaults(presetKey);
  return {
    id: String(provider?.id || "").trim(),
    name: String(provider?.name || provider?.id || "").trim(),
    credentialInput: connectionType === "api"
      ? String(provider?.apiKeyEnv || provider?.apiKey || provider?.credential || "").trim()
      : "",
    endpoints: connectionType === "api" ? endpoints : [],
    endpointDraft: "",
    rateLimitRows: connectionType === "api"
      ? createRateLimitDraftRows(provider?.rateLimits, {
          keyPrefix: `provider-${provider?.id || "new"}-rate-limit`,
          defaults: rateLimitDefaults,
          includeDefault: true
        })
      : []
  };
}

function getQuickStartConnectionLabel(presetKey) {
  const preset = findPresetByKey(presetKey);
  return preset.label || "API Key";
}

function detectPresetHostFromEndpoints(endpoints) {
  for (const ep of (endpoints || [])) {
    try {
      const host = new URL(String(ep || "")).hostname;
      if (PROVIDER_PRESET_FREE_TIER_RPM_BY_HOST[host]) return host;
    } catch { /* ignore */ }
  }
  return null;
}

function buildPresetFreeTierRateLimitRows(presetHost, modelIds) {
  const limits = PROVIDER_PRESET_FREE_TIER_RPM_BY_HOST[presetHost];
  if (!limits || !Array.isArray(modelIds) || modelIds.length === 0) return null;
  const defaultLimit = limits._default || 30;
  return modelIds.map((modelId, index) => createRateLimitDraftRow({
    models: [String(modelId)],
    requests: limits[modelId] || defaultLimit,
    window: { size: 1, unit: "minute" }
  }, { keyPrefix: `preset-rl`, index }));
}

function pickFreeTierProbeModels(modelIds) {
  const tiers = new Map();
  for (const id of modelIds) {
    const lower = id.toLowerCase();
    const tier = lower.includes("flash-lite") ? "flash-lite"
      : lower.includes("flash") ? "flash"
      : lower.includes("pro") ? "pro"
      : lower;
    if (!tiers.has(tier)) tiers.set(tier, id);
  }
  return [...tiers.values()];
}

async function probeFreeTierModels(baseUrl, credential, modelIds) {
  const sampleIds = pickFreeTierProbeModels(modelIds);
  if (sampleIds.length === 0) return null;
  try {
    const payload = await fetchJson("/api/config/probe-free-tier-models", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        baseUrl,
        ...(looksLikeEnvVarName(credential) ? { apiKeyEnv: credential } : { apiKey: credential }),
        modelIds: sampleIds
      })
    });
    if (!payload?.result) return null;
    const freeTiers = new Set();
    const paidTiers = new Set();
    for (const [id, info] of Object.entries(payload.result)) {
      const lower = id.toLowerCase();
      const tier = lower.includes("flash-lite") ? "flash-lite"
        : lower.includes("flash") ? "flash"
        : lower.includes("pro") ? "pro"
        : lower;
      if (info?.freeTier) freeTiers.add(tier);
      else paidTiers.add(tier);
    }
    return modelIds.filter((id) => {
      const lower = id.toLowerCase();
      const tier = lower.includes("flash-lite") ? "flash-lite"
        : lower.includes("flash") ? "flash"
        : lower.includes("pro") ? "pro"
        : lower;
      if (freeTiers.has(tier)) return true;
      if (paidTiers.has(tier)) return false;
      return true;
    });
  } catch {
    return null;
  }
}

function getQuickStartSuggestedModelIds(presetKey, protocol = "openai") {
  const cached = presetModelCache.get(presetKey);
  if (cached?.length) return [...cached];
  const preset = findPresetByKey(presetKey);
  const models = preset.defaultModels;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    return [...(models[protocol] || models.openai || [])];
  }
  return Array.isArray(models) ? [...models] : [];
}

function getQuickStartRateLimitDefaults(presetKey) {
  const preset = findPresetByKey(presetKey);
  return preset.rateLimitDefaults || PROVIDER_PRESET_BY_KEY.custom.rateLimitDefaults;
}

function deduplicateProviderId(baseId, baseName, existingProviders = []) {
  const ids = new Set((existingProviders || []).map((p) => p?.id).filter(Boolean));
  if (!ids.has(baseId)) return { providerId: baseId, providerName: baseName };
  let n = 2;
  while (ids.has(`${baseId}-${n}`)) n++;
  return { providerId: `${baseId}-${n}`, providerName: `${baseName} ${n}` };
}

function getQuickStartConnectionDefaults(presetKey, protocol = "openai") {
  const preset = findPresetByKey(presetKey);
  const rateLimitDefaults = getQuickStartRateLimitDefaults(presetKey);
  const isApi = preset.category === "api";

  return {
    providerName: preset.providerName,
    providerId: preset.providerId,
    endpoints: isApi && preset.endpoint ? [preset.endpoint] : [],
    apiKeyEnv: isApi ? (preset.apiKeyEnv || "") : "",
    subscriptionProfile: isApi ? "" : "",
    modelIds: presetKey === "custom" ? [] : getQuickStartSuggestedModelIds(presetKey, protocol),
    rateLimitRows: isApi
      ? createRateLimitDraftRows([], {
          keyPrefix: `quick-start-${presetKey}-rate-limit`,
          defaults: rateLimitDefaults,
          includeDefault: true
        })
      : []
  };
}

function findQuickStartAliasEntry(baseConfig = {}, providerId = "", { aliasId = "" } = {}) {
  if (!providerId) return null;
  const aliases = baseConfig?.modelAliases && typeof baseConfig.modelAliases === "object" && !Array.isArray(baseConfig.modelAliases)
    ? baseConfig.modelAliases
    : {};
  const entries = aliasId
    ? [[aliasId, aliases[aliasId]]]
    : Object.entries(aliases);

  for (const [candidateAliasId, alias] of entries) {
    if (!alias || typeof alias !== "object") continue;
    const targets = Array.isArray(alias?.targets) ? alias.targets : [];
    const fallbackTargets = Array.isArray(alias?.fallbackTargets) ? alias.fallbackTargets : [];
    if ([...targets, ...fallbackTargets].some((target) => isProviderReference(target?.ref, providerId))) {
      return { aliasId: candidateAliasId, alias };
    }
  }
  return null;
}

function getQuickStartAliasTargetModelIds(aliasEntry, providerId = "", fallbackModelIds = []) {
  const normalizedFallbackModelIds = Array.from(new Set((fallbackModelIds || []).map((modelId) => String(modelId || "").trim()).filter(Boolean)));
  if (!providerId || !aliasEntry?.alias) return normalizedFallbackModelIds;

  const allowedModelIds = new Set(normalizedFallbackModelIds);
  const aliasTargets = Array.isArray(aliasEntry.alias?.targets) ? aliasEntry.alias.targets : [];
  const orderedAliasModelIds = [];

  for (const target of aliasTargets) {
    const ref = String(target?.ref || "").trim();
    if (!isProviderReference(ref, providerId)) continue;
    const modelId = ref.slice(providerId.length + 1);
    if (!allowedModelIds.has(modelId) || orderedAliasModelIds.includes(modelId)) continue;
    orderedAliasModelIds.push(modelId);
  }

  return orderedAliasModelIds.length > 0 ? orderedAliasModelIds : normalizedFallbackModelIds;
}

function syncQuickStartAliasModelIds(aliasModelIds = [], modelIds = []) {
  const normalizedModelIds = Array.from(new Set((modelIds || []).map((modelId) => String(modelId || "").trim()).filter(Boolean)));
  const remaining = new Set(normalizedModelIds);
  const ordered = [];

  for (const modelId of (aliasModelIds || []).map((entry) => String(entry || "").trim()).filter(Boolean)) {
    if (!remaining.has(modelId)) continue;
    ordered.push(modelId);
    remaining.delete(modelId);
  }

  return [
    ...ordered,
    ...normalizedModelIds.filter((modelId) => remaining.has(modelId))
  ];
}

function rewriteQuickStartAliasTarget(target, { fromProviderId, toProviderId, allowedModelIds }) {
  if (!target || typeof target !== "object") return target;
  const ref = String(target.ref || "").trim();
  if (!fromProviderId || !isProviderReference(ref, fromProviderId)) return target;
  const modelId = ref.slice(fromProviderId.length + 1);
  if (!allowedModelIds.has(modelId)) return null;
  return {
    ...target,
    ref: `${toProviderId}/${modelId}`
  };
}

function rewriteQuickStartAlias(alias, options) {
  if (!alias || typeof alias !== "object") return alias;
  const nextAlias = { ...alias };
  const hasTargets = Array.isArray(alias.targets);
  const hasFallbackTargets = Array.isArray(alias.fallbackTargets);

  if (hasTargets) {
    nextAlias.targets = alias.targets
      .map((target) => rewriteQuickStartAliasTarget(target, options))
      .filter(Boolean);
  }
  if (hasFallbackTargets) {
    nextAlias.fallbackTargets = alias.fallbackTargets
      .map((target) => rewriteQuickStartAliasTarget(target, options))
      .filter(Boolean);
  }

  return nextAlias;
}

function rewriteQuickStartProviderRef(value, { fromProviderId, toProviderId, allowedModelIds }) {
  const ref = String(value || "").trim();
  if (!ref || !fromProviderId || !isProviderReference(ref, fromProviderId)) return ref;
  const modelId = ref.slice(fromProviderId.length + 1);
  if (!allowedModelIds.has(modelId)) return "";
  return `${toProviderId}/${modelId}`;
}

function collectQuickStartProviderRefs(providers = []) {
  return new Set(
    (providers || []).flatMap((provider) =>
      (provider?.models || []).map((model) => `${provider.id}/${model.id}`)
    )
  );
}

function createQuickStartState(baseConfig = {}, { seedMode = "blank", targetProviderId = "", defaultProviderUserAgent = QUICK_START_FALLBACK_USER_AGENT } = {}) {
  const providerList = Array.isArray(baseConfig?.providers) ? baseConfig.providers : [];
  const targetedProvider = targetProviderId
    ? providerList.find((entry) => entry?.id === targetProviderId) || null
    : null;
  const useExistingProvider = seedMode === "existing" || Boolean(targetedProvider);
  const provider = useExistingProvider ? (targetedProvider || providerList[0] || {}) : {};
  const connectionType = useExistingProvider ? inferQuickStartConnectionType(provider) : "api";
  const presetKey = useExistingProvider ? inferQuickStartPresetKey(provider) : "custom";
  const protocol = provider?.format === "claude" ? "claude" : "openai";
  const defaults = getQuickStartConnectionDefaults(presetKey, protocol);
  const rateLimitDefaults = getQuickStartRateLimitDefaults(presetKey);
  const providerModels = Array.isArray(provider?.models)
    ? provider.models.map((model) => model?.id).filter(Boolean)
    : [];
  const resolvedProviderId = String(provider?.id || defaults.providerId || slugifyProviderId(provider?.name || defaults.providerName || "my-provider") || "my-provider");
  const aliasEntry = useExistingProvider
    ? findQuickStartAliasEntry(baseConfig, resolvedProviderId, { aliasId: DEFAULT_MODEL_ALIAS_ID })
    : null;
  const resolvedModelIds = providerModels.length > 0 ? providerModels : [...defaults.modelIds];
  const modelContextWindows = Object.fromEntries(
    (Array.isArray(provider?.models) ? provider.models : [])
      .map((model) => {
        const modelId = String(model?.id || "").trim();
        const contextWindow = Number(model?.contextWindow);
        if (!modelId || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
        return [modelId, Math.floor(contextWindow)];
      })
      .filter(Boolean)
  );
  const headerRows = connectionType === "api"
    ? headerObjectToRows(provider?.headers, defaultProviderUserAgent)
    : [];

  return {
    connectionType,
    selectedConnection: presetKey,
    providerName: String(provider?.name || defaults.providerName),
    providerId: resolvedProviderId,
    endpoints: collectQuickStartEndpoints(provider).length > 0 ? collectQuickStartEndpoints(provider) : defaults.endpoints,
    endpointDraft: "",
    apiKeyEnv: String(provider?.apiKeyEnv || provider?.apiKey || defaults.apiKeyEnv),
    subscriptionProfile: String(provider?.subscriptionProfile || defaults.subscriptionProfile),
    modelIds: resolvedModelIds,
    modelContextWindows,
    modelDraft: "",
    aliasModelIds: getQuickStartAliasTargetModelIds(aliasEntry, resolvedProviderId, resolvedModelIds),
    headerRows,
    rateLimitRows: connectionType === "api"
      ? createRateLimitDraftRows(provider?.rateLimits, {
          keyPrefix: `quick-start-${resolvedProviderId}-rate-limit`,
          defaults: rateLimitDefaults,
          includeDefault: true
        })
      : [],
    enableAlias: true,
    aliasId: DEFAULT_MODEL_ALIAS_ID,
    sourceAliasId: aliasEntry?.aliasId || "",
    useAliasAsDefault: useExistingProvider ? Boolean(aliasEntry) : true
  };
}

function buildQuickStartModelEntries(modelIds, modelPreferredFormat = {}, modelContextWindows = {}) {
  return (modelIds || []).map((id) => {
    const preferred = modelPreferredFormat[id];
    const contextWindow = Number(modelContextWindows?.[id]);
    return {
      id,
      ...(preferred ? { formats: [preferred] } : {}),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.floor(contextWindow) } : {})
    };
  });
}

function resolveQuickStartSubscriptionProfile(quickStart = {}) {
  const providerId = slugifyProviderId(quickStart?.providerId || quickStart?.providerName || "") || "";
  return String(quickStart?.subscriptionProfile || providerId || "default").trim() || providerId || "default";
}

function buildQuickStartConfig(baseConfig = {}, quickStart, testedProviderConfig = null, { targetProviderId = "" } = {}) {
  const next = safeClone(baseConfig && typeof baseConfig === "object" ? baseConfig : {});
  const providerId = slugifyProviderId(quickStart?.providerId || quickStart?.providerName || "my-provider") || "my-provider";
  const providerName = String(quickStart?.providerName || providerId).trim() || providerId;
  const modelIds = Array.isArray(quickStart?.modelIds) ? quickStart.modelIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
  const orderedModelIds = syncQuickStartAliasModelIds(quickStart?.aliasModelIds, modelIds);
  const effectiveRateLimitDefaults = getQuickStartRateLimitDefaults(quickStart?.selectedConnection || quickStart?.connectionType);
  const resolvedRateLimitRows = Array.isArray(quickStart?.rateLimitRows)
    ? quickStart.rateLimitRows
    : [];
  const effectiveApiRateLimitRows = resolvedRateLimitRows.length > 0
    ? resolvedRateLimitRows
    : [{
        models: [RATE_LIMIT_ALL_MODELS_SELECTOR],
        requests: effectiveRateLimitDefaults.limit,
        windowValue: effectiveRateLimitDefaults.windowValue,
        windowUnit: effectiveRateLimitDefaults.windowUnit
      }];
  const hadProviders = Array.isArray(baseConfig?.providers) && baseConfig.providers.length > 0;
  const sourceProviderId = String(targetProviderId || "").trim();
  const sourceAliasId = String(quickStart?.sourceAliasId || "").trim();
  let provider;

  if (quickStart?.connectionType === "api") {
    const endpoints = Array.isArray(quickStart?.endpoints) ? quickStart.endpoints.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
    const workingFormats = Array.isArray(testedProviderConfig?.workingFormats)
      ? testedProviderConfig.workingFormats.filter(Boolean)
      : [];
    const preferredFormat = testedProviderConfig?.preferredFormat || workingFormats[0] || "openai";
    const baseUrlByFormat = testedProviderConfig?.baseUrlByFormat && typeof testedProviderConfig.baseUrlByFormat === "object"
      ? testedProviderConfig.baseUrlByFormat
      : (endpoints[0] ? { [preferredFormat]: endpoints[0] } : undefined);
    const baseUrl = (preferredFormat && baseUrlByFormat?.[preferredFormat])
      || baseUrlByFormat?.openai
      || baseUrlByFormat?.claude
      || endpoints[0]
      || "";
    const confirmedModelIds = Array.isArray(testedProviderConfig?.models) && testedProviderConfig.models.length > 0
      ? orderedModelIds.filter((id) => testedProviderConfig.models.includes(id))
      : orderedModelIds;
    const effectiveModelIds = confirmedModelIds.length > 0 ? confirmedModelIds : orderedModelIds;
    const providerMetadata = endpoints.length > 1 ? { endpointCandidates: endpoints } : undefined;

    const credentialInput = String(quickStart?.apiKeyEnv || "").trim();
    const providerCredential = looksLikeEnvVarName(credentialInput)
      ? { apiKeyEnv: credentialInput }
      : (credentialInput ? { apiKey: credentialInput } : {});
    const customHeaders = headerRowsToObject(quickStart?.headerRows || []);

    provider = {
      id: providerId,
      name: providerName,
      baseUrl,
      baseUrlByFormat,
      ...providerCredential,
      ...(Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {}),
      format: preferredFormat,
      formats: workingFormats.length > 0 ? workingFormats : [preferredFormat],
      models: buildQuickStartModelEntries(
        effectiveModelIds,
        testedProviderConfig?.modelPreferredFormat || {},
        quickStart?.modelContextWindows || {}
      ),
      ...(providerMetadata ? { metadata: providerMetadata } : {})
    };
  } else {
    const preset = findPresetByKey(quickStart?.selectedConnection || "oauth-gpt");
    const subscriptionType = preset.subscriptionType || "chatgpt-codex";
    const providerFormat = preset.format || "openai";

    provider = {
      id: providerId,
      name: providerName,
      type: "subscription",
      subscriptionType,
      subscriptionProfile: resolveQuickStartSubscriptionProfile(quickStart),
      format: providerFormat,
      formats: [providerFormat],
      models: buildQuickStartModelEntries(orderedModelIds, {}, quickStart?.modelContextWindows || {})
    };
  }

  provider.rateLimits = quickStart?.connectionType === "api"
    ? buildRateLimitBucketsFromDraftRows(effectiveApiRateLimitRows, {
        fallbackRequests: effectiveRateLimitDefaults.limit,
        fallbackWindowValue: effectiveRateLimitDefaults.windowValue,
        fallbackWindowUnit: effectiveRateLimitDefaults.windowUnit
      })
    : buildRateLimitBucketsFromDraftRows([{
        models: [RATE_LIMIT_ALL_MODELS_SELECTOR],
        requests: effectiveRateLimitDefaults.limit,
        windowValue: effectiveRateLimitDefaults.windowValue,
        windowUnit: effectiveRateLimitDefaults.windowUnit
      }], {
        fallbackRequests: effectiveRateLimitDefaults.limit,
        fallbackWindowValue: effectiveRateLimitDefaults.windowValue,
        fallbackWindowUnit: effectiveRateLimitDefaults.windowUnit
      });

  if (!String(next.masterKey || "").trim()) {
    next.masterKey = createMasterKey();
  }

  next.version = typeof next.version === "number" ? next.version : 2;

  const existingProviders = Array.isArray(next.providers) ? next.providers : [];
  let providerIndex = sourceProviderId
    ? existingProviders.findIndex((entry) => entry?.id === sourceProviderId)
    : -1;
  if (providerIndex === -1) {
    providerIndex = existingProviders.findIndex((entry) => entry?.id === providerId);
  }
  next.providers = providerIndex === -1
    ? [...existingProviders, provider]
    : existingProviders.map((entry, index) => (index === providerIndex ? provider : entry));

  const existingAliases = next.modelAliases && typeof next.modelAliases === "object" && !Array.isArray(next.modelAliases)
    ? next.modelAliases
    : {};
  const allowedModelIds = new Set((provider.models || []).map((model) => model.id));
  const shouldManageDefaultAlias = !hadProviders || quickStart?.useAliasAsDefault === true;
  const nextAliases = {};

  for (const [aliasId, alias] of Object.entries(existingAliases)) {
    const rewrittenAlias = sourceProviderId
      ? rewriteQuickStartAlias(alias, { fromProviderId: sourceProviderId, toProviderId: providerId, allowedModelIds })
      : alias;
    nextAliases[aliasId] = rewrittenAlias;
  }

  const primaryRef = provider.models?.[0]?.id ? `${providerId}/${provider.models[0].id}` : "";
  const aliasTargetModelIds = (orderedModelIds.length > 0 ? orderedModelIds : (provider.models || []).map((model) => model.id))
    .filter((modelId) => allowedModelIds.has(modelId));
  const defaultAliasId = DEFAULT_MODEL_ALIAS_ID;
  const existingDefaultAlias = nextAliases[defaultAliasId] && typeof nextAliases[defaultAliasId] === "object"
    ? nextAliases[defaultAliasId]
    : { id: defaultAliasId, strategy: "ordered", targets: [], fallbackTargets: [] };
  nextAliases[defaultAliasId] = shouldManageDefaultAlias
    ? {
        ...existingDefaultAlias,
        id: defaultAliasId,
        strategy: "ordered",
        targets: aliasTargetModelIds.map((modelId) => ({ ref: `${providerId}/${modelId}` })),
        fallbackTargets: []
      }
    : {
        ...existingDefaultAlias,
        id: defaultAliasId,
        strategy: String(existingDefaultAlias.strategy || "ordered").trim() || "ordered",
        targets: Array.isArray(existingDefaultAlias.targets) ? existingDefaultAlias.targets : [],
        fallbackTargets: Array.isArray(existingDefaultAlias.fallbackTargets) ? existingDefaultAlias.fallbackTargets : []
      };
  next.modelAliases = nextAliases;

  const remainingModelRefs = collectQuickStartProviderRefs(next.providers);
  next.defaultModel = DEFAULT_MODEL_ALIAS_ID;

  if (!next.amp || typeof next.amp !== "object" || Array.isArray(next.amp)) {
    next.amp = { restrictManagementToLocalhost: true, overrides: { entities: [] } };
  }
  if (next.amp.restrictManagementToLocalhost === undefined) {
    next.amp.restrictManagementToLocalhost = true;
  }
  if (!next.amp.overrides || typeof next.amp.overrides !== "object" || Array.isArray(next.amp.overrides)) {
    next.amp.overrides = { entities: [] };
  }
  if (!Array.isArray(next.amp.overrides.entities)) {
    next.amp.overrides.entities = [];
  }

  let nextAmpDefaultRoute = String(next.amp.defaultRoute || "").trim();
  if (sourceProviderId) {
    nextAmpDefaultRoute = rewriteQuickStartProviderRef(nextAmpDefaultRoute, {
      fromProviderId: sourceProviderId,
      toProviderId: providerId,
      allowedModelIds
    });
  }
  if (shouldManageDefaultAlias || !nextAmpDefaultRoute || (!next.modelAliases?.[nextAmpDefaultRoute] && !remainingModelRefs.has(nextAmpDefaultRoute))) {
    nextAmpDefaultRoute = DEFAULT_MODEL_ALIAS_ID;
  }
  if (nextAmpDefaultRoute) {
    next.amp.defaultRoute = nextAmpDefaultRoute;
  }

  if (!next.metadata || typeof next.metadata !== "object" || Array.isArray(next.metadata)) {
    next.metadata = {};
  }

  return next;
}

function hasCompletedProviderSetup(config = {}) {
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  return providers.some((provider) => {
    if (provider?.enabled === false) return false;
    const models = Array.isArray(provider?.models)
      ? provider.models.filter((model) => String(model?.id || "").trim())
      : [];
    const rateLimits = Array.isArray(provider?.rateLimits) ? provider.rateLimits : [];
    return models.length > 0 && rateLimits.length > 0;
  });
}

function getQuickStartStepError(stepIndex, quickStart, baseConfig = {}, { targetProviderId = "" } = {}) {
  const providerId = slugifyProviderId(quickStart?.providerId || quickStart?.providerName || "");
  const modelIds = mergeChipValuesAndDraft(quickStart?.modelIds, quickStart?.modelDraft);
  const aliasModelIds = syncQuickStartAliasModelIds(quickStart?.aliasModelIds, modelIds);
  const rateLimitRows = resolveRateLimitDraftRows(quickStart?.rateLimitRows);
  const endpoints = quickStart?.connectionType === "api"
    ? mergeChipValuesAndDraft(quickStart?.endpoints, quickStart?.endpointDraft)
    : [];
  const providerList = Array.isArray(baseConfig?.providers) ? baseConfig.providers : [];
  const aliasMap = baseConfig?.modelAliases && typeof baseConfig.modelAliases === "object" && !Array.isArray(baseConfig.modelAliases)
    ? baseConfig.modelAliases
    : {};

  if (stepIndex === 0) {
    if (!String(quickStart?.providerName || "").trim()) return "Add a provider name to continue.";
    if (!providerId || !QUICK_START_PROVIDER_ID_PATTERN.test(providerId)) return "Provider id must start with a letter and use lowercase letters, numbers, or hyphens.";
    if (providerList.some((provider) => provider?.id === providerId && provider?.id !== targetProviderId)) {
      return "Provider id already exists. Choose another id or edit that provider instead.";
    }
    if (quickStart?.connectionType === "api") {
      if (endpoints.length === 0) return "Add at least one endpoint to continue.";
      if (!String(quickStart?.apiKeyEnv || "").trim()) return "API key or env is required before testing config.";
    }
  }

  if (stepIndex === 1) {
    if (modelIds.length === 0) return "Add at least one model id.";
    if (quickStart?.connectionType === "api") {
      const rateLimitIssue = validateRateLimitDraftRows(rateLimitRows, {
        knownModelIds: modelIds,
        requireAtLeastOne: true
      });
      if (rateLimitIssue) return rateLimitIssue;
    }
  }

  if (stepIndex === 2) {
    if (quickStart?.useAliasAsDefault && Object.prototype.hasOwnProperty.call(aliasMap, String(quickStart?.aliasId || DEFAULT_MODEL_ALIAS_ID).trim()) === false) {
      return "";
    }
  }

  return "";
}

function formatTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function detectValidationVariant(summary) {
  if (summary?.parseError) return "danger";
  if ((summary?.validationErrors || []).length > 0) return "warning";
  return "success";
}

function describeConfigStatus(summary) {
  const variant = detectValidationVariant(summary);
  if (variant === "danger") return { variant, label: "Config: invalid" };
  if (variant === "warning") return { variant, label: "Config: invalid" };
  return { variant: "success", label: "Config: valid" };
}

function measureAliasSwitcherWidth(aliasLabel = "") {
  const label = String(aliasLabel || "Select alias").trim() || "Select alias";
  const fallbackWidth = Math.min(Math.max(Math.ceil(label.length * 8.5 + 62), 160), 520);

  if (typeof document === "undefined") return fallbackWidth;

  const canvas = measureAliasSwitcherWidth.canvas
    || (measureAliasSwitcherWidth.canvas = document.createElement("canvas"));
  const context = canvas.getContext("2d");
  if (!context) return fallbackWidth;

  context.font = '500 14px "Inter", "SF Pro Display", ui-sans-serif, system-ui, sans-serif';
  return Math.min(Math.max(Math.ceil(context.measureText(label).width + 62), 160), 520);
}

async function copyTextToClipboard(value) {
  const text = String(value || "");
  if (!text) return;

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is not available in this environment.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function fetchJsonLineStream(url, options = {}, { onMessage } = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = null;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (rawLine) {
        const message = JSON.parse(rawLine);
        onMessage?.(message);
        if (message?.type === "result") {
          finalResult = message.result;
        }
        if (message?.type === "error") {
          const error = new Error(message.error || "Request failed.");
          error.statusCode = message.statusCode || 500;
          throw error;
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }

    if (done) break;
  }

  const finalLine = buffer.trim();
  if (finalLine) {
    const message = JSON.parse(finalLine);
    onMessage?.(message);
    if (message?.type === "result") finalResult = message.result;
    if (message?.type === "error") {
      const error = new Error(message.error || "Request failed.");
      error.statusCode = message.statusCode || 500;
      throw error;
    }
  }

  return finalResult;
}

function buildLiteLlmContextSuggestionKey(result = {}) {
  return `${String(result?.model || "").trim()}::${String(result?.contextWindow || "").trim()}`;
}

function stripContextWindowFormatting(value) {
  return String(value || "").trim().replace(/[.,\s_'`]/g, "");
}

function normalizeContextWindowInput(value) {
  const text = stripContextWindowFormatting(value);
  if (!text) return "";
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : text;
}

async function lookupLiteLlmContextWindow(models = []) {
  const normalizedModels = [...new Set((Array.isArray(models) ? models : [])
    .map((model) => String(model || "").trim())
    .filter(Boolean))];
  if (normalizedModels.length === 0) return [];
  const payload = await fetchJson("/api/config/litellm-context-lookup", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      models: normalizedModels,
      limit: CONTEXT_LOOKUP_SUGGESTION_LIMIT
    })
  });
  return Array.isArray(payload?.result) ? payload.result : [];
}

function normalizeLiteLlmContextCandidate(candidate = {}) {
  const model = String(candidate?.model || "").trim();
  const provider = String(candidate?.provider || "").trim();
  const mode = String(candidate?.mode || "").trim();
  const contextWindow = Number(candidate?.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return {
    model,
    provider,
    mode,
    contextWindow: Math.floor(contextWindow)
  };
}

function simplifyLiteLlmContextLabel(model = "", provider = "") {
  const normalizedModel = String(model || "").trim();
  const normalizedProvider = String(provider || "").trim();
  if (!normalizedModel || !normalizedProvider) return normalizedModel;

  const lowercaseModel = normalizedModel.toLowerCase();
  const lowercaseProvider = normalizedProvider.toLowerCase();
  const knownPrefixes = [`${lowercaseProvider}/`, `${lowercaseProvider}:`];

  for (const prefix of knownPrefixes) {
    if (!lowercaseModel.startsWith(prefix)) continue;
    const simplifiedLabel = normalizedModel.slice(prefix.length).trim();
    return simplifiedLabel || normalizedModel;
  }

  return normalizedModel;
}

function buildLiteLlmContextLookupState(result = {}, { fallbackQuery = "" } = {}) {
  const query = String(result?.query || fallbackQuery || "").trim();
  const exactMatch = normalizeLiteLlmContextCandidate(result?.exactMatch);
  const suggestions = (Array.isArray(result?.suggestions) ? result.suggestions : [])
    .map((candidate) => normalizeLiteLlmContextCandidate(candidate))
    .filter(Boolean);
  const medianContextWindow = Number(result?.medianContextWindow);
  const normalizedMedianContextWindow = Number.isFinite(medianContextWindow) && medianContextWindow > 0
    ? Math.floor(medianContextWindow)
    : (exactMatch?.contextWindow || null);

  const options = [];
  const seenKeys = new Set();

  function addOption(option) {
    if (!option?.key || seenKeys.has(option.key)) return;
    seenKeys.add(option.key);
    options.push(option);
  }

  if (exactMatch) {
    addOption({
      key: `exact::${buildLiteLlmContextSuggestionKey(exactMatch)}`,
      label: simplifyLiteLlmContextLabel(exactMatch.model, exactMatch.provider) || "Exact match",
      detail: exactMatch.provider ? `Exact · ${exactMatch.provider}` : "Exact",
      contextWindow: exactMatch.contextWindow
    });
  }

  for (const suggestion of suggestions) {
    addOption({
      key: buildLiteLlmContextSuggestionKey(suggestion),
      label: simplifyLiteLlmContextLabel(suggestion.model, suggestion.provider) || "Suggestion",
      detail: suggestion.provider || "Known model",
      contextWindow: suggestion.contextWindow
    });
  }

  return {
    query,
    exactMatch,
    suggestions,
    medianContextWindow: normalizedMedianContextWindow,
    options,
    status: options.length > 0 ? "ready" : "miss"
  };
}

function resolveLiteLlmPrefillContextWindow(result = {}) {
  const state = buildLiteLlmContextLookupState(result);
  if (state.exactMatch?.contextWindow) return String(state.exactMatch.contextWindow);
  if (state.medianContextWindow) return String(state.medianContextWindow);
  return "";
}

function buildLiteLlmContextLookupMap(results = []) {
  const lookupMap = new Map();
  for (const result of (Array.isArray(results) ? results : [])) {
    const state = buildLiteLlmContextLookupState(result);
    if (!state.query) continue;
    lookupMap.set(state.query, state);
  }
  return lookupMap;
}

function buildLiteLlmModelContextWindowMap(results = []) {
  const next = {};
  for (const result of (Array.isArray(results) ? results : [])) {
    const query = String(result?.query || "").trim();
    const prefill = resolveLiteLlmPrefillContextWindow(result);
    if (!query || !prefill) continue;
    next[query] = Number(prefill);
  }
  return next;
}

function Field({ label, hint, className, children, stacked = false, headerClassName, hintClassName, headerAction = null }) {
  return (
    <div className={cn("flex flex-col gap-2 text-sm", className)}>
      <div className={cn(
        "text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground",
        stacked ? "flex min-h-10 items-start justify-between gap-3" : "flex items-center justify-between gap-2",
        headerClassName
      )}>
        <div className={cn("min-w-0", stacked ? "flex-1 space-y-1" : "flex min-w-0 items-center gap-2")}>
          <span>{label}</span>
          {hint ? (
            <span className={cn(
              "block normal-case tracking-normal text-[11px] text-muted-foreground/80",
              stacked ? "leading-4" : null,
              hintClassName
            )}>{hint}</span>
          ) : null}
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>
      {children}
    </div>
  );
}

function TransientIntegerInput({ value, onValueChange, disabled = false, allowEmptyCommit = false, ...props }) {
  const canonicalValue = String(value ?? "");
  const [draftValue, setDraftValue] = useState(canonicalValue);

  useEffect(() => {
    setDraftValue(canonicalValue);
  }, [canonicalValue]);

  return (
    <Input
      {...props}
      value={draftValue}
      inputMode="numeric"
      disabled={disabled}
      onChange={(event) => {
        const change = classifyTransientIntegerInput(event.target.value);
        if (!change.accepted) return;
        setDraftValue(change.draftValue);
        if (change.shouldCommit) {
          onValueChange(change.commitValue);
        } else if (allowEmptyCommit && change.draftValue === "") {
          onValueChange("");
        }
      }}
      onBlur={() => {
        setDraftValue((current) => {
          if (current !== "") return current;
          if (allowEmptyCommit) {
            onValueChange("");
            return "";
          }
          return canonicalValue;
        });
      }}
    />
  );
}

function ToggleField({ label, hint, checked = false, onCheckedChange, disabled = false, className }) {
  return (
    <div className={cn("flex items-center justify-between gap-4 rounded-2xl border border-border/70 bg-background/80 px-4 py-3", className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {hint ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</div> : null}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60"
      />
    </div>
  );
}

function Modal({
  open = false,
  title = "",
  description = "",
  onClose = () => {},
  children,
  variant = "dialog",
  headerActions = null,
  showCloseButton = true,
  closeDisabled = false,
  closeOnEscape = true,
  closeOnBackdrop = true,
  footer = null,
  contentClassName = "",
  bodyClassName = "",
  footerClassName = ""
}) {
  useEffect(() => {
    if (!open || typeof window === "undefined") return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape" && closeOnEscape) onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeOnEscape, open, onClose]);

  if (!open) return null;
  const isPage = variant === "page";
  const modalContent = (
    <div
      className={cn(
        "fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-sm",
        isPage ? "p-0" : "flex items-center justify-center p-4"
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && closeOnBackdrop) onClose();
      }}
    >
      <div className={cn(
        "overflow-hidden border border-border/70 bg-card/95 shadow-2xl",
        isPage
          ? "flex h-full w-full flex-col rounded-none border-x-0 border-y-0 bg-background/98"
          : "flex max-h-[85vh] w-full max-w-3xl flex-col rounded-3xl",
        contentClassName
      )}>
        <div className={cn(
          "flex items-start justify-between gap-3 border-b border-border/70",
          isPage ? "px-5 py-4 sm:px-6" : "px-5 py-4"
        )}>
          <div className="min-w-0">
            <div className="text-base font-semibold text-foreground">{title}</div>
            {description ? <div className="mt-1 text-sm leading-6 text-muted-foreground">{description}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            {showCloseButton ? (
              <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={closeDisabled}>
                Close
              </Button>
            ) : null}
          </div>
        </div>
        <div className={cn(
          "overflow-y-auto",
          isPage ? "min-h-0 flex-1 px-5 py-4 sm:px-6 sm:py-5" : "min-h-0 flex-1 px-5 py-4",
          bodyClassName
        )}>
          {children}
        </div>
        {footer ? (
          <div className={cn(
            "border-t border-border/70 bg-background/96",
            isPage ? "px-5 py-4 sm:px-6" : "px-5 py-4",
            footerClassName
          )}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (typeof document === "undefined" || !document.body) return modalContent;
  return createPortal(modalContent, document.body);
}

function AdaptiveDropdownPanel({
  open = false,
  anchorRef,
  preferredSide = "bottom",
  desiredHeight = 288,
  offset = 4,
  className = "",
  children,
  ...props
}) {
  const placement = useDropdownPlacement({
    open,
    anchorRef,
    preferredSide,
    desiredHeight,
    offset
  });

  if (!open) return null;

  return (
    <div
      className={cn(
        "absolute left-0 right-0 z-30 overflow-y-auto rounded-xl border border-border/70 bg-popover shadow-lg",
        placement.side === "top" ? "bottom-full mb-1" : "top-full mt-1",
        className
      )}
      style={{
        maxHeight: `${Math.max(0, Math.floor(placement.maxHeight || desiredHeight))}px`
      }}
      {...props}
    >
      {children}
    </div>
  );
}

function UnsavedChangesModal({
  open = false,
  onKeepEditing = () => {},
  onDiscardAndClose = () => {},
  onSaveAndClose = () => {},
  saveDisabled = false,
  dirtyLabels = [],
  details = ""
}) {
  const sectionLabel = dirtyLabels.length > 1
    ? `${dirtyLabels.slice(0, -1).join(", ")} and ${dirtyLabels[dirtyLabels.length - 1]}`
    : dirtyLabels[0] || "this form";

  return (
    <Modal
      open={open}
      onClose={onKeepEditing}
      title="Unsaved changes"
      description={`You have unsaved edits in ${sectionLabel}.`}
      contentClassName="max-w-lg rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
      showCloseButton={false}
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onKeepEditing}>
            Keep editing
          </Button>
          <Button type="button" variant="outline" onClick={onDiscardAndClose}>
            Cancel + Close
          </Button>
          <Button type="button" onClick={() => void onSaveAndClose()} disabled={saveDisabled}>
            Save + Close
          </Button>
        </div>
      )}
    >
      <div className="space-y-3 text-sm leading-6 text-muted-foreground">
        <div>Choose whether to save these edits before closing the modal.</div>
        {details ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
            {details}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function FailedModelsCloseModal({
  open = false,
  failedModelIds = [],
  onKeepEditing = () => {},
  onRemoveFailedAndClose = () => {},
  removeDisabled = false
}) {
  const failedLabel = failedModelIds.length > 1
    ? `${failedModelIds.length} failed models`
    : failedModelIds[0] || "the failed model";

  return (
    <Modal
      open={open}
      onClose={onKeepEditing}
      title="Failed model tests"
      description={`Some new models did not pass validation: ${failedLabel}.`}
      contentClassName="max-w-lg rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
      showCloseButton={false}
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onKeepEditing}>
            Keep editing
          </Button>
          <Button type="button" variant="outline" onClick={() => void onRemoveFailedAndClose()} disabled={removeDisabled}>
            Remove failed + close
          </Button>
        </div>
      )}
    >
      <div className="space-y-3 text-sm leading-6 text-muted-foreground">
        <div>Successful new models are still kept in the draft. You can continue editing, or remove only the failed rows and close the modal.</div>
        {failedModelIds.length > 0 ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-900">
            {failedModelIds.join(", ")}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function EditIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
    </svg>
  );
}

function CheckIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m5 12 4.25 4.25L19 6.5" />
    </svg>
  );
}

function TrashIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4.75A1.75 1.75 0 0 1 9.75 3h4.5A1.75 1.75 0 0 1 16 4.75V6" />
      <path d="M18 6v12.25A1.75 1.75 0 0 1 16.25 20h-8.5A1.75 1.75 0 0 1 6 18.25V6" />
      <path d="M10 10.5v5" />
      <path d="M14 10.5v5" />
    </svg>
  );
}

function CopyIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

function EndpointIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M7.25 5.75h-1.5A2.75 2.75 0 0 0 3 8.5v5.75A2.75 2.75 0 0 0 5.75 17h5.75a2.75 2.75 0 0 0 2.75-2.75v-1.5" />
      <path d="M10.5 9.5 17 3" />
      <path d="M12 3h5v5" />
    </svg>
  );
}

function KeyIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="6.75" cy="10" r="3.25" />
      <path d="M10 10h6.5" />
      <path d="M13.5 10v2.25" />
      <path d="M15.75 10v1.5" />
    </svg>
  );
}

function RotateIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M16.25 10a6.25 6.25 0 1 1-1.83-4.42" />
      <path d="M13.5 3.75h3v3" />
      <path d="M16.5 3.75 12.75 7.5" />
    </svg>
  );
}

function FileIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 3.5h5.25L15 7.25V16A1.5 1.5 0 0 1 13.5 17.5h-7A1.5 1.5 0 0 1 5 16V5A1.5 1.5 0 0 1 6.5 3.5H6Z" />
      <path d="M11 3.5V7.5H15" />
      <path d="M7.75 11h4.5" />
      <path d="M7.75 14h4.5" />
    </svg>
  );
}

function BackupFileIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 3.5h5.25L15 7.25V16A1.5 1.5 0 0 1 13.5 17.5h-7A1.5 1.5 0 0 1 5 16V5A1.5 1.5 0 0 1 6.5 3.5H6Z" />
      <path d="M11 3.5V7.5H15" />
      <path d="M7 12.25a3 3 0 1 1 2.85 2.99" />
      <path d="M8.5 10.25h1.5v1.5" />
    </svg>
  );
}

function SecretFileIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M10 2.75 4.75 5v4.12c0 3.42 2.1 6.58 5.25 7.88 3.15-1.3 5.25-4.46 5.25-7.88V5L10 2.75Z" />
      <circle cx="10" cy="9" r="1.4" />
      <path d="M10 10.4v2.1" />
    </svg>
  );
}

function HeaderAccessChip({
  label,
  value,
  icon,
  disabled = false,
  onClick,
  actionLabel
}) {
  return (
    <button
      type="button"
      className="inline-flex h-9 min-w-0 max-w-full items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3 text-left transition hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-70 sm:max-w-[18rem]"
      onClick={onClick}
      disabled={disabled}
      aria-label={actionLabel}
      title={disabled ? actionLabel : value}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        {icon}
      </span>
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-xs font-medium text-foreground">{value}</span>
    </button>
  );
}

function HeaderGatewayChip({
  value,
  pending = false,
  disabled = false,
  rotateDisabled = false,
  onCopy,
  onRotate
}) {
  return (
    <div className="flex h-9 min-w-0 max-w-full items-stretch overflow-hidden rounded-full border border-border/70 bg-background/90 sm:max-w-[18rem]">
      <button
        type="button"
        className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-l-full px-3 text-left transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-70"
        onClick={onCopy}
        disabled={disabled}
        aria-label={pending ? "Gateway key is still generating" : "Copy gateway key"}
        title={pending ? "Gateway key is still generating" : "Copy gateway key"}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <KeyIcon className="h-3.5 w-3.5" />
        </span>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Gateway key</span>
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{value}</span>
      </button>
      <button
        type="button"
        className="inline-flex w-9 shrink-0 items-center justify-center rounded-r-full border-l border-border/70 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70"
        onClick={onRotate}
        disabled={rotateDisabled}
        aria-label="Rotate gateway key"
        title="Rotate gateway key"
      >
        <RotateIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function HeaderAccessGroup({
  endpointValue,
  endpointDisabled = false,
  gatewayValue,
  gatewayPending = false,
  gatewayDisabled = false,
  rotateDisabled = false,
  onCopyEndpoint,
  onCopyGatewayKey,
  onRotateKey
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <HeaderAccessChip
        label="Endpoint"
        value={endpointValue}
        icon={<EndpointIcon className="h-3.5 w-3.5" />}
        disabled={endpointDisabled}
        onClick={onCopyEndpoint}
        actionLabel={endpointDisabled ? "API endpoint not ready yet" : "Copy API endpoint"}
      />
      <HeaderGatewayChip
        value={gatewayValue}
        pending={gatewayPending}
        disabled={gatewayDisabled}
        rotateDisabled={rotateDisabled}
        onCopy={onCopyGatewayKey}
        onRotate={onRotateKey}
      />
    </div>
  );
}

function CompactHeaderChip({
  label,
  value,
  icon,
  disabled = false,
  onClick,
  actionLabel = "",
  emptyLabel = "Not resolved"
}) {
  const displayValue = String(value || "").trim() || emptyLabel;

  return (
    <button
      type="button"
      className="inline-flex min-w-0 max-w-full items-start gap-2 rounded-2xl border border-border/70 bg-background/90 px-3 py-2 text-left transition hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-70"
      onClick={onClick}
      disabled={disabled}
      aria-label={actionLabel}
      title={disabled ? actionLabel : displayValue}
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
        <span className="mt-1 block break-all text-[11px] font-medium leading-4 text-foreground">{displayValue}</span>
      </span>
    </button>
  );
}

function ConnectedIndicatorDot({
  connected = false,
  className,
  srLabel = "Connected",
  size = "sm"
}) {
  if (!connected) return null;

  const outerSizeClassName = size === "md" ? "h-3.5 w-3.5" : "h-2.5 w-2.5";
  const innerSizeClassName = size === "md" ? "h-2 w-2" : "h-1.5 w-1.5";

  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center", outerSizeClassName, className)}>
      <span aria-hidden="true" className="absolute inset-0 rounded-full bg-emerald-400/45 animate-ping motion-reduce:animate-none" />
      <span aria-hidden="true" className={cn("relative rounded-full bg-emerald-500 ring-2 ring-emerald-500/15", innerSizeClassName)} />
      <span className="sr-only">{srLabel}</span>
    </span>
  );
}

function ConnectionStatusChipRow({
  primaryLabel = "Config file",
  primaryValue = "",
  primaryIcon = <FileIcon className="h-3 w-3" />,
  onOpenPrimary,
  secondaryLabel = "Backup file",
  secondaryValue = "",
  secondaryIcon = <BackupFileIcon className="h-3 w-3" />,
  onOpenSecondary
}) {
  const resolvedPrimaryValue = String(primaryValue || "").trim();
  const resolvedSecondaryValue = String(secondaryValue || "").trim();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CompactHeaderChip
        label={primaryLabel}
        value={resolvedPrimaryValue}
        icon={primaryIcon}
        disabled={!resolvedPrimaryValue || typeof onOpenPrimary !== "function"}
        onClick={onOpenPrimary}
        actionLabel={resolvedPrimaryValue ? `Open ${primaryLabel.toLowerCase()}` : `${primaryLabel} path is not resolved yet`}
      />
      <CompactHeaderChip
        label={secondaryLabel}
        value={resolvedSecondaryValue}
        icon={secondaryIcon}
        disabled={!resolvedSecondaryValue || typeof onOpenSecondary !== "function"}
        onClick={onOpenSecondary}
        actionLabel={resolvedSecondaryValue ? `Open ${secondaryLabel.toLowerCase()}` : `${secondaryLabel} path is not resolved yet`}
      />
    </div>
  );
}

function getToastToneLabel(tone) {
  if (tone === "error") return "Error";
  if (tone === "success") return "Success";
  return "Notice";
}

function Toast({ notice, onDismiss }) {
  const [remainingMs, setRemainingMs] = useState(TOAST_DURATION_MS);
  const [visibleRemainingMs, setVisibleRemainingMs] = useState(TOAST_DURATION_MS);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (remainingMs <= 0) {
      onDismiss();
      return undefined;
    }

    if (paused) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return undefined;
    }

    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onDismiss();
    }, remainingMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [onDismiss, paused, remainingMs]);

  useEffect(() => {
    if (paused || remainingMs <= 0) {
      setVisibleRemainingMs(remainingMs);
      return undefined;
    }

    const syncRemaining = () => {
      const elapsed = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
      setVisibleRemainingMs(Math.max(0, remainingMs - elapsed));
    };

    syncRemaining();
    const intervalId = setInterval(syncRemaining, TOAST_STATUS_TICK_MS);
    return () => clearInterval(intervalId);
  }, [paused, remainingMs]);

  function pauseTimer() {
    if (paused) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const elapsed = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
    const nextRemainingMs = Math.max(0, remainingMs - elapsed);
    setRemainingMs(nextRemainingMs);
    setVisibleRemainingMs(nextRemainingMs);
    setPaused(true);
  }

  function resumeTimer() {
    setPaused(false);
  }

  const classes = notice.tone === "error"
    ? "border-rose-200 bg-rose-50 text-rose-800"
    : notice.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-amber-200 bg-amber-50 text-amber-800";
  const progressRadius = 9;
  const progressCircumference = 2 * Math.PI * progressRadius;
  const progressRatio = Math.max(0, Math.min(1, visibleRemainingMs / TOAST_DURATION_MS));
  const progressOffset = progressCircumference * (1 - progressRatio);
  const progressLabel = paused
    ? `Auto-dismiss paused with ${Math.max(0, visibleRemainingMs / 1000).toFixed(1)} seconds remaining`
    : `Auto-dismiss in ${Math.max(0, visibleRemainingMs / 1000).toFixed(1)} seconds`;

  return (
    <div
      className={cn("pointer-events-auto rounded-2xl border px-4 py-3 text-sm shadow-lg backdrop-blur", classes)}
      onMouseEnter={pauseTimer}
      onMouseLeave={resumeTimer}
      onFocusCapture={pauseTimer}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        resumeTimer();
      }}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] opacity-75">
            {getToastToneLabel(notice.tone)}
          </div>
          <div className="relative mt-0.5 h-6 w-6 shrink-0 opacity-85" aria-label={progressLabel} title={progressLabel}>
            <svg viewBox="0 0 24 24" className={cn("h-6 w-6 -rotate-90", paused ? "opacity-70" : "opacity-100")} aria-hidden="true">
              <circle
                cx="12"
                cy="12"
                r={progressRadius}
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.18"
                strokeWidth="2"
              />
              <circle
                cx="12"
                cy="12"
                r={progressRadius}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={progressCircumference}
                strokeDashoffset={progressOffset}
                className="transition-[stroke-dashoffset,opacity] duration-100 ease-linear"
              />
            </svg>
            <span
              className={cn(
                "pointer-events-none absolute inset-0 flex items-center justify-center",
                paused ? "gap-[2px]" : ""
              )}
              aria-hidden="true"
            >
              {paused ? (
                <>
                  <span className="h-2.5 w-[2px] rounded-full bg-current/75" />
                  <span className="h-2.5 w-[2px] rounded-full bg-current/75" />
                </>
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-current/75" />
              )}
            </span>
          </div>
        </div>
        <div className="mt-1 leading-6">{notice.message}</div>
        <div className="mt-2 flex justify-end">
          <button
            className="rounded-full border border-current/15 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] opacity-85 transition hover:border-current/30 hover:opacity-100"
            onClick={onDismiss}
            type="button"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function ToastStack({ notices, onDismiss }) {
  if (!Array.isArray(notices) || notices.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-4 top-4 z-50 flex flex-col items-end gap-3" aria-live="polite" aria-relevant="additions text">
      {notices.map((notice) => (
        <div key={notice.id} className="w-full max-w-md">
          <Toast notice={notice} onDismiss={() => onDismiss(notice.id)} />
        </div>
      ))}
    </div>
  );
}

function ValidationPanel({ summary, validationMessages, isDirty }) {
  const variant = detectValidationVariant(summary);
  const badgeVariant = variant === "danger" ? "danger" : variant === "warning" ? "warning" : "success";

  return (
    <div className="rounded-2xl border border-border/70 bg-secondary/45 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badgeVariant}>{summary?.validationSummary || "Waiting for validation"}</Badge>
        {isDirty ? <Badge variant="outline">Unsaved local edits</Badge> : null}
      </div>
      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
        {validationMessages?.length > 0 ? validationMessages.map((entry, index) => (
          <div key={`${entry.message}-${index}`} className="rounded-xl border border-border/70 bg-background/80 px-3 py-2">
            {entry.message}
          </div>
        )) : (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">
            Schema and JSON are in good shape.
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderModelsEditor({
  provider,
  disabled = false,
  disabledReason = "",
  busy = false,
  onApply,
  framed = true,
  focusRequest = 0,
  onStateChange = null,
  testStateByModel = {},
  savePhase = "",
  saveMessage = ""
}) {
  const initialRows = useMemo(() => createProviderModelDraftRows(provider), [provider]);
  const [rows, setRows] = useState([]);
  const [submitState, setSubmitState] = useState("");
  const [contextLookupBusy, setContextLookupBusy] = useState(false);
  const [contextLookupPendingByRowKey, setContextLookupPendingByRowKey] = useState({});
  const [contextLookupStateByRowKey, setContextLookupStateByRowKey] = useState({});
  const [contextLookupStatus, setContextLookupStatus] = useState(null);
  const [activeContextLookupRowKey, setActiveContextLookupRowKey] = useState("");
  const [editingContextRowKey, setEditingContextRowKey] = useState("");
  const [editingContextDraftByRowKey, setEditingContextDraftByRowKey] = useState({});
  const rowCounterRef = useRef(0);
  const rowsRef = useRef([]);
  const inputRefs = useRef(new Map());
  const contextInputShellRefs = useRef(new Map());
  const pendingFocusRowKeyRef = useRef("");
  const draggingKeyRef = useRef("");
  const draggingNodeRef = useRef(null);
  const contextLookupCacheRef = useRef(new Map());
  const contextLookupRequestRef = useRef(new Map());

  function createDraftRow(overrides = {}) {
    rowCounterRef.current += 1;
    return {
      key: `model-${provider.id}-draft-${rowCounterRef.current}`,
      id: "",
      sourceId: "",
      contextWindow: "",
      ...overrides
    };
  }

  function focusRow(rowKey) {
    pendingFocusRowKeyRef.current = rowKey;
  }

  function ensureDraftRow(nextRows = [], { preserveFocus = false } = {}) {
    const filledRows = [];
    let draftRow = null;

    for (const row of (Array.isArray(nextRows) ? nextRows : [])) {
      const value = String(row?.id || "");
      const contextWindow = row?.contextWindow === undefined || row?.contextWindow === null
        ? ""
        : String(row.contextWindow);
      if (String(value).trim()) {
        filledRows.push({ ...row, id: value, contextWindow });
        continue;
      }
      if (!draftRow) {
        draftRow = {
          ...row,
          id: "",
          contextWindow
        };
      }
    }

    if (!draftRow) {
      draftRow = createDraftRow();
      if (preserveFocus) focusRow(draftRow.key);
    }

    return [draftRow, ...filledRows];
  }

  function clearContextLookupState(rowKey) {
    setContextLookupStateByRowKey((current) => {
      if (!current[rowKey]) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
  }

  function setRowLookupPending(rowKey, pending) {
    setContextLookupPendingByRowKey((current) => {
      if (pending) {
        if (current[rowKey]) return current;
        return {
          ...current,
          [rowKey]: true
        };
      }
      if (!current[rowKey]) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
  }

  function updateRow(rowKey, patch = {}, { clearLookupState = false, clearStatus = true, closeLookupMenu = false } = {}) {
    if (clearLookupState) clearContextLookupState(rowKey);
    if (clearStatus) setContextLookupStatus(null);
    if (closeLookupMenu && activeContextLookupRowKey === rowKey) {
      setActiveContextLookupRowKey("");
    }
    setRows((current) => ensureDraftRow(
      current.map((row) => (row.key === rowKey ? { ...row, ...patch } : row)),
      { preserveFocus: false }
    ));
  }

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    const nextRows = ensureDraftRow(initialRows, { preserveFocus: true });
    setRows(nextRows);
    rowsRef.current = nextRows;
    contextLookupCacheRef.current.clear();
    contextLookupRequestRef.current.clear();
    setContextLookupPendingByRowKey({});
    setContextLookupStateByRowKey({});
    setContextLookupStatus(null);
    setActiveContextLookupRowKey("");
    setEditingContextRowKey("");
    setEditingContextDraftByRowKey({});
  }, [initialRows]);

  useEffect(() => {
    const rowKey = pendingFocusRowKeyRef.current;
    if (!rowKey) return;
    const input = inputRefs.current.get(rowKey);
    if (!input) return;
    input.scrollIntoView?.({ block: "nearest" });
    input.focus();
    const length = input.value?.length || 0;
    input.setSelectionRange?.(length, length);
    pendingFocusRowKeyRef.current = "";
  }, [rows]);

  useEffect(() => {
    if (!focusRequest) return;
    setRows((current) => {
      const nextRows = ensureDraftRow(current, { preserveFocus: false });
      const draftRow = nextRows.find((row) => !String(row?.id || "").trim()) || nextRows[nextRows.length - 1];
      if (draftRow) focusRow(draftRow.key);
      return nextRows;
    });
  }, [focusRequest]);

  useEffect(() => {
    if (!activeContextLookupRowKey) return;
    if (rows.some((row) => row.key === activeContextLookupRowKey)) return;
    setActiveContextLookupRowKey("");
  }, [rows, activeContextLookupRowKey]);

  useEffect(() => {
    if (!editingContextRowKey) return;
    if (rows.some((row) => row.key === editingContextRowKey)) return;
    setEditingContextRowKey("");
  }, [rows, editingContextRowKey]);

  useEffect(() => {
    setEditingContextDraftByRowKey((current) => {
      const activeRowKeys = new Set(rows.map((row) => row.key));
      let changed = false;
      const next = {};
      for (const [rowKey, value] of Object.entries(current)) {
        if (!activeRowKeys.has(rowKey)) {
          changed = true;
          continue;
        }
        next[rowKey] = value;
      }
      return changed ? next : current;
    });
  }, [rows]);

  useEffect(() => {
    if (!activeContextLookupRowKey || typeof document === "undefined") return undefined;

    function handlePointerDown(event) {
      const activeShell = contextInputShellRefs.current.get(activeContextLookupRowKey);
      if (activeShell?.contains(event.target)) return;
      setActiveContextLookupRowKey("");
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [activeContextLookupRowKey]);

  const filledRows = useMemo(
    () => rows.filter((row) => String(row?.id || "").trim()),
    [rows]
  );
  const normalizedInitialRows = useMemo(
    () => initialRows
      .map((row) => ({
        id: String(row?.id || "").trim(),
        contextWindow: normalizeContextWindowInput(row?.contextWindow || "")
      }))
      .filter((row) => row.id),
    [initialRows]
  );
  const normalizedFilledRows = useMemo(
    () => filledRows.map((row) => ({
      ...row,
      id: String(row?.id || "").trim(),
      contextWindow: normalizeContextWindowInput(row?.contextWindow || "")
    })),
    [filledRows]
  );
  const filledModelIds = normalizedFilledRows.map((row) => row.id);
  const initialModelIds = normalizedInitialRows.map((row) => row.id);
  const newModelIds = filledModelIds.filter((modelId) => !initialModelIds.includes(modelId));
  const hasDuplicates = hasDuplicateTrimmedValues(filledModelIds);
  const hasModels = filledModelIds.length > 0;
  const invalidContextWindowRowKeys = new Set(
    normalizedFilledRows
      .filter((row) => {
        const rawValue = String(row?.contextWindow || "").trim();
        if (!rawValue) return false;
        const parsed = Number.parseInt(rawValue, 10);
        return !Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== rawValue;
      })
      .map((row) => row.key)
  );
  const rowsMissingContextWindow = normalizedFilledRows.filter((row) => !String(row?.contextWindow || "").trim());
  const isDirty = JSON.stringify(normalizedInitialRows) !== JSON.stringify(normalizedFilledRows.map((row) => ({
    id: row.id,
    contextWindow: row.contextWindow
  })));
  const actionBusy = submitState !== "" || savePhase === "testing" || savePhase === "saving";
  const locked = disabled || busy || actionBusy || contextLookupBusy;
  const lastFilledRowIndex = useMemo(() => {
    let lastIndex = -1;
    rows.forEach((row, index) => {
      if (String(row?.id || "").trim()) lastIndex = index;
    });
    return lastIndex;
  }, [rows]);
  const issue = disabled
    ? disabledReason
    : !hasModels
      ? "Keep at least one model id on the provider."
      : hasDuplicates
        ? "Model ids must be unique for each provider."
        : invalidContextWindowRowKeys.size > 0
          ? "Context windows must be positive integers when set."
          : "";
  const setAnimatedRowRef = useReorderLayoutAnimation(rows.map((row) => row.key));

  useEffect(() => {
    onStateChange?.({
      isDirty,
      issue,
      locked,
      rows: normalizedFilledRows.map((row) => ({
        ...row,
        contextWindow: normalizeContextWindowInput(row.contextWindow)
      }))
    });
  }, [onStateChange, isDirty, issue, locked, normalizedFilledRows]);

  function removeRow(rowKey) {
    clearContextLookupState(rowKey);
    setRowLookupPending(rowKey, false);
    setContextLookupStatus(null);
    if (activeContextLookupRowKey === rowKey) setActiveContextLookupRowKey("");
    if (editingContextRowKey === rowKey) setEditingContextRowKey("");
    setEditingContextDraftByRowKey((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, rowKey)) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
    setRows((current) => ensureDraftRow(current.filter((row) => row.key !== rowKey)));
  }

  function moveRowUp(rowKey) {
    setRows((current) => ensureDraftRow(moveItemUp(current, rowKey, (row) => row?.key)));
  }

  function moveRowDown(rowKey) {
    setRows((current) => ensureDraftRow(moveItemDown(current, rowKey, (row) => row?.key)));
  }

  function clearDraggingState() {
    draggingKeyRef.current = "";
    setDraggingRowClasses(draggingNodeRef.current, false);
    draggingNodeRef.current = null;
  }

  async function getContextLookupState(modelId, { force = false } = {}) {
    const normalizedModelId = String(modelId || "").trim();
    if (!normalizedModelId) {
      return buildLiteLlmContextLookupState({ query: normalizedModelId });
    }
    if (!force && contextLookupCacheRef.current.has(normalizedModelId)) {
      return contextLookupCacheRef.current.get(normalizedModelId);
    }
    if (!force && contextLookupRequestRef.current.has(normalizedModelId)) {
      return contextLookupRequestRef.current.get(normalizedModelId);
    }

    const request = (async () => {
      const results = await lookupLiteLlmContextWindow([normalizedModelId]);
      const rawLookupResult = (Array.isArray(results) ? results : [])
        .find((entry) => String(entry?.query || "").trim() === normalizedModelId) || { query: normalizedModelId };
      const lookupState = buildLiteLlmContextLookupState(rawLookupResult, { fallbackQuery: normalizedModelId });
      contextLookupCacheRef.current.set(normalizedModelId, lookupState);
      return lookupState;
    })();

    contextLookupRequestRef.current.set(normalizedModelId, request);
    try {
      return await request;
    } finally {
      contextLookupRequestRef.current.delete(normalizedModelId);
    }
  }

  async function ensureContextLookupForRow(rowKey, { openMenu = false, prefill = false, modelId: nextModelId = "" } = {}) {
    const currentRow = rowsRef.current.find((row) => row.key === rowKey);
    const modelId = String(nextModelId || currentRow?.id || "").trim();
    if (!modelId) return null;

    if (openMenu) setActiveContextLookupRowKey(rowKey);
    setRowLookupPending(rowKey, true);

    try {
      const lookupState = await getContextLookupState(modelId);
      setContextLookupStateByRowKey((current) => ({
        ...current,
        [rowKey]: lookupState
      }));

      if (prefill) {
        const prefillValue = resolveLiteLlmPrefillContextWindow(lookupState);
        if (prefillValue) {
          setRows((current) => ensureDraftRow(current.map((row) => {
            if (row.key !== rowKey) return row;
            const currentId = String(row?.id || "").trim();
            const currentContextWindow = String(row?.contextWindow || "").trim();
            if (!currentId || currentId !== modelId || currentContextWindow) return row;
            return {
              ...row,
              contextWindow: prefillValue
            };
          }), { preserveFocus: false }));
        }
      }

      return lookupState;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureState = {
        query: modelId,
        status: "error",
        error: message,
        options: []
      };
      setContextLookupStateByRowKey((current) => ({
        ...current,
        [rowKey]: failureState
      }));
      return failureState;
    } finally {
      setRowLookupPending(rowKey, false);
    }
  }

  async function handleLookupEmptyContextWindows(rowKeys = []) {
    const lookupKeySet = new Set(Array.isArray(rowKeys) ? rowKeys : []);
    const lookupTargets = normalizedFilledRows
      .filter((row) => {
        if (!row.id) return false;
        if (String(row?.contextWindow || "").trim()) return false;
        if (lookupKeySet.size === 0) return true;
        return lookupKeySet.has(row.key);
      })
      .map((row) => ({
        key: row.key,
        id: row.id
      }));

    if (lookupTargets.length === 0) return;

    setContextLookupBusy(true);
    setContextLookupStatus(null);

    try {
      const results = await lookupLiteLlmContextWindow(lookupTargets.map((row) => row.id));
      const lookupByQuery = buildLiteLlmContextLookupMap(results);
      const targetByKey = new Map(lookupTargets.map((row) => [row.key, row]));

      for (const lookupState of lookupByQuery.values()) {
        if (!lookupState?.query) continue;
        contextLookupCacheRef.current.set(lookupState.query, lookupState);
      }

      const currentRows = Array.isArray(rowsRef.current) ? rowsRef.current : [];
      let filledCount = 0;
      let missCount = 0;
      const nextRows = currentRows.map((row) => {
        const target = targetByKey.get(row.key);
        if (!target) return row;

        const currentId = String(row?.id || "").trim();
        const currentContextWindow = String(row?.contextWindow || "").trim();
        if (!currentId || currentId !== target.id || currentContextWindow) return row;

        const lookupState = lookupByQuery.get(currentId) || buildLiteLlmContextLookupState({ query: currentId });
        const prefillValue = resolveLiteLlmPrefillContextWindow(lookupState);
        if (prefillValue) {
          filledCount += 1;
          return {
            ...row,
            contextWindow: prefillValue
          };
        }
        missCount += 1;
        return row;
      });

      setRows(ensureDraftRow(nextRows, { preserveFocus: false }));
      setContextLookupStatus({
        tone: filledCount > 0 ? "success" : "warning",
        message: filledCount > 0
          ? `Filled ${filledCount} context size${filledCount === 1 ? "" : "s"}${missCount > 0 ? `; ${missCount} still need a manual value` : ""}.`
          : `Could not fill ${missCount} model${missCount === 1 ? "" : "s"}.`
      });
    } catch (error) {
      setContextLookupStatus({
        tone: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setContextLookupBusy(false);
    }
  }

  async function handleApply() {
    if (locked || issue || !isDirty) return false;
    const willTestNewModels = inferQuickStartConnectionType(provider) === "api" && newModelIds.length > 0;
    setSubmitState(willTestNewModels ? "testing" : "saving");
    try {
      return await onApply(normalizedFilledRows.map((row) => ({
        ...row,
        contextWindow: normalizeContextWindowInput(row.contextWindow)
      })));
    } finally {
      setSubmitState("");
    }
  }

  return (
    <div className={cn(framed ? "space-y-3 rounded-2xl border border-border/70 bg-background/60 p-4" : "space-y-3")}>
      <div className="rounded-2xl border border-border/70 bg-secondary/35 px-4 py-3 text-sm leading-6 text-muted-foreground">
        Direct routes follow this top-to-bottom order. Focus a context field to load suggested sizes, or use Fill missing context size to fill each empty row with a median size.
      </div>

      <div className="space-y-2">
        {rows.map((row, index) => {
          const trimmedValue = String(row?.id || "").trim();
          const normalizedContextWindow = String(row?.contextWindow || "").trim();
          const isFilledRow = Boolean(trimmedValue);
          const filledRowIndex = isFilledRow
            ? filledRows.findIndex((candidate) => candidate.key === row.key)
            : -1;
          const rowLookupState = contextLookupStateByRowKey[row.key] || null;
          const rowLookupPending = Boolean(contextLookupPendingByRowKey[row.key]);
          const showContextLookupMenu = activeContextLookupRowKey === row.key && Boolean(trimmedValue);
          const hasInvalidContextWindow = invalidContextWindowRowKeys.has(row.key);
          const rowTestState = trimmedValue ? (testStateByModel?.[trimmedValue] || "default") : "default";

          return (
            <div
              key={row.key}
              ref={setAnimatedRowRef(row.key)}
              data-reorder-row="true"
              onDragOver={(event) => {
                if (!locked && draggingKeyRef.current && draggingKeyRef.current !== row.key) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                if (locked) return;
                event.preventDefault();
                const fromKey = event.dataTransfer.getData("text/plain") || draggingKeyRef.current;
                clearDraggingState();
                setRows((current) => ensureDraftRow(moveItemsByKey(current, fromKey, row.key)));
              }}
              className={cn(
                "space-y-2 rounded-xl border border-border/70 bg-card/90 p-3",
                !isFilledRow ? "border-dashed bg-background/85" : null,
                hasInvalidContextWindow ? "border-amber-200 bg-amber-50/70" : null,
                !hasInvalidContextWindow && rowTestState === "success" ? "border-emerald-200 bg-emerald-50/70" : null,
                !hasInvalidContextWindow && rowTestState === "error" ? "border-rose-200 bg-rose-50/70" : null,
                !hasInvalidContextWindow && rowTestState === "pending" ? "border-sky-200 bg-sky-50/70" : null
              )}
            >
              <div className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)_minmax(12rem,14rem)_5.5rem] items-center gap-2">
                <span className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground",
                  isFilledRow && !locked ? "cursor-grab" : "opacity-45"
                )}
                  draggable={!locked && isFilledRow}
                  onDragStart={(event) => {
                    if (locked || !isFilledRow) return;
                    const rowNode = getReorderRowNode(event.currentTarget);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", row.key);
                    if (rowNode && typeof event.dataTransfer?.setDragImage === "function") {
                      event.dataTransfer.setDragImage(rowNode, 20, 20);
                    }
                    clearDraggingState();
                    draggingKeyRef.current = row.key;
                    draggingNodeRef.current = rowNode;
                    setDraggingRowClasses(rowNode, true);
                  }}
                  onDragEnd={clearDraggingState}
                  title={isFilledRow ? "Drag to reorder" : "New model draft row"}
                >
                  <DragGripIcon className="h-4 w-4" />
                </span>
                <MoveUpButton
                  disabled={locked || !isFilledRow || filledRowIndex <= 0}
                  label={!isFilledRow || filledRowIndex <= 0 ? "Already first" : `Move ${row.id || `model ${filledRowIndex + 1}`} up`}
                  onClick={() => moveRowUp(row.key)}
                />
                <MoveDownButton
                  disabled={locked || !isFilledRow || index >= lastFilledRowIndex}
                  label={!isFilledRow || index >= lastFilledRowIndex ? "Already last" : `Move ${row.id || `model ${filledRowIndex + 1}`} down`}
                  onClick={() => moveRowDown(row.key)}
                />
                <Input
                  ref={(node) => {
                    if (node) {
                      inputRefs.current.set(row.key, node);
                    } else {
                      inputRefs.current.delete(row.key);
                    }
                  }}
                  value={row.id}
                  onChange={(event) => updateRow(
                    row.key,
                    { id: event.target.value },
                    { clearLookupState: true, closeLookupMenu: true }
                  )}
                  placeholder={isFilledRow ? "Model id" : "Add a new model id"}
                  disabled={locked}
                />
                <div
                  ref={(node) => {
                    if (node) {
                      contextInputShellRefs.current.set(row.key, node);
                    } else {
                      contextInputShellRefs.current.delete(row.key);
                    }
                  }}
                  className="relative min-w-0"
                >
                  <Input
                    value={editingContextRowKey === row.key
                      ? (editingContextDraftByRowKey[row.key] ?? formatEditableContextWindowInput(row.contextWindow))
                      : formatCompactContextWindowInput(row.contextWindow)}
                    onChange={(event) => {
                      const nextDisplayValue = event.target.value;
                      const normalizedContextWindow = normalizeContextWindowInput(nextDisplayValue);
                      setEditingContextDraftByRowKey((current) => ({
                        ...current,
                        [row.key]: formatEditableContextWindowInput(normalizedContextWindow)
                      }));
                      updateRow(row.key, { contextWindow: normalizedContextWindow }, { clearStatus: false });
                    }}
                    onBlur={(event) => {
                      setEditingContextRowKey((current) => (current === row.key ? "" : current));
                      setEditingContextDraftByRowKey((current) => {
                        if (!Object.prototype.hasOwnProperty.call(current, row.key)) return current;
                        const next = { ...current };
                        delete next[row.key];
                        return next;
                      });
                      updateRow(row.key, { contextWindow: normalizeContextWindowInput(event.target.value) }, { clearStatus: false });
                    }}
                    onFocus={() => {
                      if (!trimmedValue) return;
                      setEditingContextRowKey(row.key);
                      setEditingContextDraftByRowKey((current) => ({
                        ...current,
                        [row.key]: formatEditableContextWindowInput(row.contextWindow)
                      }));
                      void ensureContextLookupForRow(row.key, { openMenu: true });
                    }}
                    onClick={() => {
                      if (!trimmedValue) return;
                      void ensureContextLookupForRow(row.key, { openMenu: true });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" && trimmedValue) {
                        event.preventDefault();
                        void ensureContextLookupForRow(row.key, { openMenu: true });
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setActiveContextLookupRowKey("");
                      }
                    }}
                    placeholder="Context window"
                    inputMode="numeric"
                    disabled={locked || !trimmedValue}
                    className="font-medium tabular-nums"
                    aria-label={trimmedValue ? `Context window for ${trimmedValue}` : "Context window"}
                  />
                  {showContextLookupMenu ? (
                    <AdaptiveDropdownPanel
                      open={showContextLookupMenu}
                      anchorRef={{ current: contextInputShellRefs.current.get(row.key) || null }}
                      preferredSide="top"
                      desiredHeight={224}
                      className="z-20 rounded-lg bg-background/98 p-2"
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      {rowLookupPending ? (
                        <div className="inline-flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
                          <InlineSpinner />
                          Fetching size options for <code>{trimmedValue}</code>.
                        </div>
                      ) : rowLookupState?.status === "error" ? (
                        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                          {rowLookupState.error || "Could not load suggested sizes."}
                        </div>
                      ) : rowLookupState?.options?.length > 0 ? (
                        <div className="space-y-1">
                          {rowLookupState.options.map((option) => (
                            <button
                              key={option.key}
                              type="button"
                              className="flex w-full flex-col gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-left text-sm text-foreground transition hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-70"
                              disabled={locked}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setEditingContextDraftByRowKey((current) => ({
                                  ...current,
                                  [row.key]: formatEditableContextWindowInput(option.contextWindow)
                                }));
                                updateRow(
                                  row.key,
                                  { contextWindow: String(option.contextWindow) },
                                  { clearStatus: false }
                                );
                                setActiveContextLookupRowKey("");
                              }}
                              title={`Use ${option.label}`}
                            >
                              <div className="min-w-0 space-y-1">
                                <div className="break-words font-medium leading-5">{option.label}</div>
                                <div className="break-words text-xs leading-4 text-muted-foreground">{option.detail}</div>
                              </div>
                              <div className="w-full rounded-md border border-border/70 bg-secondary/70 px-3 py-2">
                                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Context size</div>
                                <div className="mt-1 text-lg font-semibold leading-none tabular-nums text-foreground">
                                  {formatContextWindow(option.contextWindow)}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border/70 bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                          No suggested size was found for <code>{rowLookupState?.query || trimmedValue}</code>.
                        </div>
                      )}
                    </AdaptiveDropdownPanel>
                  ) : null}
                </div>
                {isFilledRow ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className={ROW_REMOVE_BUTTON_CLASS}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => removeRow(row.key)}
                    disabled={locked}
                  >
                    Remove
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(ROW_REMOVE_BUTTON_CLASS, "pointer-events-none invisible")}
                    tabIndex={-1}
                    disabled
                    aria-hidden="true"
                  >
                    Remove
                  </Button>
                )}
              </div>

              {rowLookupPending ? (
                <div className="flex justify-end text-xs">
                  <div className="inline-flex items-center gap-1.5 text-sky-700">
                    <InlineSpinner />
                    Looking up sizes
                  </div>
                </div>
              ) : null}

              {hasInvalidContextWindow ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Enter a positive integer like <code>128000</code>, or leave the field blank.
                </div>
              ) : rowTestState === "pending" ? (
                <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
                  Testing this model against the provider endpoint now.
                </div>
              ) : rowTestState === "success" ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                  Confirmed by the latest live provider test.
                </div>
              ) : rowTestState === "error" ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                  This model failed the latest live provider test.
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {issue ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{issue}</div> : null}
      {contextLookupStatus ? (
        <div className={cn(
          "rounded-xl px-3 py-2 text-sm",
          contextLookupStatus.tone === "error"
            ? "border border-rose-200 bg-rose-50 text-rose-900"
            : contextLookupStatus.tone === "warning"
              ? "border border-amber-200 bg-amber-50 text-amber-900"
              : "border border-emerald-200 bg-emerald-50 text-emerald-900"
        )}>
          {contextLookupStatus.message}
        </div>
      ) : null}

      <div
        className={cn(
          "sticky z-10 border-t border-border/70 bg-background/95 pt-3 backdrop-blur",
          framed
            ? "bottom-0"
            : "bottom-0 -mx-5 rounded-b-[1rem] px-5 pb-4"
        )}
      >
        <div className="flex min-h-9 items-center justify-between gap-3">
          <div className={cn(
            "text-xs",
            savePhase === "testing"
              ? "text-sky-700"
              : savePhase === "saving"
                ? "text-foreground"
                : "text-muted-foreground"
          )}>
            {savePhase === "testing" ? (
              <span className="inline-flex items-center gap-1.5">
                <InlineSpinner />
                {saveMessage || "Testing new models before save."}
              </span>
            ) : savePhase === "saving" ? (
              <span className="inline-flex items-center gap-1.5">
                <InlineSpinner />
                {saveMessage || "Saving provider models."}
              </span>
            ) : newModelIds.length > 0 && inferQuickStartConnectionType(provider) === "api"
              ? `${newModelIds.length} new model${newModelIds.length === 1 ? "" : "s"} will be tested before save.`
              : "Existing models keep their current configuration metadata."}
          </div>
          <div className="flex items-center justify-end gap-2">
            {!disabled && !locked && rowsMissingContextWindow.length > 0 ? (
              <Button type="button" variant="outline" onClick={() => void handleLookupEmptyContextWindows()}>
                {contextLookupBusy ? "Filling…" : "Fill missing context size"}
              </Button>
            ) : null}
            {!disabled && !locked && isDirty ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setContextLookupPendingByRowKey({});
                  setContextLookupStateByRowKey({});
                  setContextLookupStatus(null);
                  setActiveContextLookupRowKey("");
                  contextLookupCacheRef.current.clear();
                  contextLookupRequestRef.current.clear();
                  setRows(ensureDraftRow(initialRows, { preserveFocus: true }));
                }}
              >
                Reset
              </Button>
            ) : null}
            {!disabled && isDirty && !issue ? (
              <Button type="button" onClick={() => void handleApply()} disabled={locked}>
                {savePhase === "testing" || submitState === "testing"
                  ? "Testing…"
                  : savePhase === "saving" || submitState === "saving" || busy
                    ? "Saving…"
                    : "Save models"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function RouteTargetListEditor({
  title,
  rows,
  onChange,
  options,
  disabled = false,
  addLabel = "Add target",
  emptyLabel = "No targets configured.",
  helperText = "Drag rows or use the arrow to change routing order.",
  helperAction = null,
  placeholder = "provider/model or alias",
  draftPlaceholder = "Add a new route",
  showDraftRow = false,
  showDraftFocusButton = false,
  showWeightInput = false,
  filterOtherSelectedValues = false,
  excludedValues = []
}) {
  const rowCounterRef = useRef(0);
  const draggingKeyRef = useRef("");
  const draggingNodeRef = useRef(null);
  const rowNodeRefs = useRef(new Map());
  const draftRowScrollFrameRef = useRef(0);
  const draftRowScrollRequestRef = useRef(0);
  const [draftRowOpenSearchRequest, setDraftRowOpenSearchRequest] = useState(0);
  const rowKeyPrefix = useMemo(
    () => String(title || "targets").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "targets",
    [title]
  );
  const draftRowKey = `${rowKeyPrefix}-draft-row`;
  const displayRows = useMemo(() => {
    const filledRows = (rows || []).filter((row) => String(row?.ref || "").trim());
    if (!showDraftRow) return filledRows;
    return [{ key: draftRowKey, ref: "", sourceRef: "" }, ...filledRows];
  }, [rows, showDraftRow, draftRowKey]);
  const setAnimatedRowRef = useReorderLayoutAnimation(displayRows.map((row) => row.key));
  const normalizedExcludedValues = useMemo(
    () => normalizeUniqueTrimmedValues(excludedValues),
    [excludedValues]
  );
  const resolvedOptions = useMemo(
    () => withCurrentManagedRouteOptions(options, [...displayRows.map((row) => row?.ref), ...normalizedExcludedValues]),
    [options, displayRows, normalizedExcludedValues]
  );

  useEffect(() => () => {
    if (typeof window !== "undefined" && draftRowScrollFrameRef.current) {
      window.cancelAnimationFrame(draftRowScrollFrameRef.current);
    }
  }, []);

  function updateRow(rowKey, value) {
    if (showDraftRow && rowKey === draftRowKey) {
      if (!String(value || "").trim()) return;
      rowCounterRef.current += 1;
      onChange([
        {
          key: `${rowKeyPrefix}-draft-${rowCounterRef.current}`,
          ref: value,
          sourceRef: "",
          ...(showWeightInput ? { weight: "1" } : {})
        },
        ...(rows || []).filter((row) => String(row?.ref || "").trim())
      ]);
      return;
    }

    onChange((rows || []).map((row) => (row.key === rowKey ? { ...row, ref: value } : row)));
  }

  function updateWeight(rowKey, value) {
    onChange((rows || []).map((row) => (row.key === rowKey ? { ...row, weight: value } : row)));
  }

  function removeRow(rowKey) {
    onChange((rows || []).filter((row) => row.key !== rowKey));
  }

  function moveRowUp(rowKey) {
    onChange(moveItemUp(rows || [], rowKey, (row) => row?.key));
  }

  function moveRowDown(rowKey) {
    onChange(moveItemDown(rows || [], rowKey, (row) => row?.key));
  }

  function clearDraggingState() {
    draggingKeyRef.current = "";
    setDraggingRowClasses(draggingNodeRef.current, false);
    draggingNodeRef.current = null;
  }

  function addRow() {
    rowCounterRef.current += 1;
    const usedRefs = new Set([
      ...(rows || []).map((row) => String(row?.ref || "").trim()).filter(Boolean),
      ...normalizedExcludedValues
    ]);
    const suggestedRef = resolvedOptions.find((option) => !usedRefs.has(option.value))?.value || "";
    onChange([
      ...(rows || []),
      {
        key: `${rowKeyPrefix}-draft-${rowCounterRef.current}`,
        ref: suggestedRef,
        sourceRef: ""
      }
    ]);
  }

  function handleDraftFocusButtonClick() {
    if (!showDraftRow || disabled) return;
    const rowNode = rowNodeRefs.current.get(draftRowKey);
    if (!rowNode || typeof window === "undefined") {
      setDraftRowOpenSearchRequest((current) => current + 1);
      return;
    }

    draftRowScrollRequestRef.current += 1;
    const scrollRequestId = draftRowScrollRequestRef.current;
    if (draftRowScrollFrameRef.current) {
      window.cancelAnimationFrame(draftRowScrollFrameRef.current);
      draftRowScrollFrameRef.current = 0;
    }

    rowNode.scrollIntoView({ block: "start", behavior: "smooth" });

    const scrollContainers = getClippingAncestors(rowNode);
    let lastSnapshot = captureScrollSettleSnapshot(rowNode, scrollContainers);
    let stableFrames = 0;
    let frameCount = 0;
    const maxFrames = 90;
    const minFrames = 8;
    const stableFramesRequired = 6;
    const settleThreshold = 0.5;

    const waitForScrollSettle = () => {
      if (draftRowScrollRequestRef.current !== scrollRequestId) return;
      const currentRowNode = rowNodeRefs.current.get(draftRowKey) || rowNode;
      const currentSnapshot = captureScrollSettleSnapshot(currentRowNode, scrollContainers);
      if (!Number.isFinite(currentSnapshot.top) || !Number.isFinite(currentSnapshot.left)) {
        draftRowScrollFrameRef.current = 0;
        setDraftRowOpenSearchRequest((current) => current + 1);
        return;
      }

      if (isScrollSettleSnapshotStable(lastSnapshot, currentSnapshot, settleThreshold)) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }

      lastSnapshot = currentSnapshot;
      frameCount += 1;

      if ((frameCount >= minFrames && stableFrames >= stableFramesRequired) || frameCount >= maxFrames) {
        draftRowScrollFrameRef.current = 0;
        setDraftRowOpenSearchRequest((current) => current + 1);
        return;
      }

      draftRowScrollFrameRef.current = window.requestAnimationFrame(waitForScrollSettle);
    };

    draftRowScrollFrameRef.current = window.requestAnimationFrame(waitForScrollSettle);
  }

  return (
    <div className="space-y-2 rounded-2xl border border-border/70 bg-background/55 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{title}</div>
          {showDraftFocusButton && showDraftRow ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 rounded-md p-0 text-muted-foreground hover:text-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleDraftFocusButtonClick}
              disabled={disabled}
              aria-label={addLabel}
              title={addLabel}
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-start justify-end gap-x-3 gap-y-2">
          {helperText ? (
            <div className="max-w-[34rem] text-right text-[11px] leading-4 text-muted-foreground">{helperText}</div>
          ) : null}
          {!showDraftRow ? <Button type="button" variant="ghost" onClick={addRow} disabled={disabled}>{addLabel}</Button> : null}
        </div>
      </div>

      {displayRows.length > 0 ? (
        <div className="space-y-2">
          {displayRows.map((row, index) => {
            const isDraftRow = showDraftRow && row.key === draftRowKey;
            const filledRowIndex = isDraftRow
              ? -1
              : (rows || []).findIndex((candidate) => candidate?.key === row.key);
            const rowOptions = filterOtherSelectedValues
              ? resolvedOptions.filter((option) => {
                const optionValue = String(option?.value || "").trim();
                if (!optionValue) return false;
                if (optionValue === String(row?.ref || "").trim()) return true;
                if (normalizedExcludedValues.includes(optionValue)) return false;
                return !(displayRows || []).some((candidate) => candidate?.key !== row.key && String(candidate?.ref || "").trim() === optionValue);
              })
              : resolvedOptions;
            return (
              <div
                key={row.key}
                ref={(node) => {
                  setAnimatedRowRef(row.key)(node);
                  if (node) {
                    rowNodeRefs.current.set(row.key, node);
                    return;
                  }
                  rowNodeRefs.current.delete(row.key);
                }}
                data-reorder-row="true"
                onDragOver={(event) => {
                  if (!disabled && draggingKeyRef.current && draggingKeyRef.current !== row.key) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(event) => {
                  if (disabled) return;
                  event.preventDefault();
                  const fromKey = event.dataTransfer.getData("text/plain") || draggingKeyRef.current;
                  clearDraggingState();
                  onChange(moveItemsByKey(rows || [], fromKey, row.key));
                }}
                className={cn(
                  showWeightInput
                    ? "grid grid-cols-[auto_auto_auto_minmax(0,1fr)_10rem_5.5rem] items-center gap-2 rounded-xl border border-border/70 bg-card/90 p-3"
                    : "grid grid-cols-[auto_auto_auto_minmax(0,1fr)_5.5rem] items-center gap-2 rounded-xl border border-border/70 bg-card/90 p-3",
                  isDraftRow ? "border-dashed bg-background/85" : null
                )}
              >
                <span className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground",
                  isDraftRow || disabled ? "opacity-45" : "cursor-grab"
                )}
                  draggable={!disabled && !isDraftRow}
                  onDragStart={(event) => {
                    if (disabled || isDraftRow) return;
                    const rowNode = getReorderRowNode(event.currentTarget);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", row.key);
                    if (rowNode && typeof event.dataTransfer?.setDragImage === "function") {
                      event.dataTransfer.setDragImage(rowNode, 20, 20);
                    }
                    clearDraggingState();
                    draggingKeyRef.current = row.key;
                    draggingNodeRef.current = rowNode;
                    setDraggingRowClasses(rowNode, true);
                  }}
                  onDragEnd={clearDraggingState}
                  title={isDraftRow ? "New route draft row" : "Drag to reorder"}
                >
                  <DragGripIcon className="h-4 w-4" />
                </span>
                <MoveUpButton
                  disabled={disabled || isDraftRow || filledRowIndex <= 0}
                  label={isDraftRow || filledRowIndex <= 0 ? "Already first" : `Move ${row.ref || `target ${filledRowIndex + 1}`} up`}
                  onClick={() => moveRowUp(row.key)}
                />
                <MoveDownButton
                  disabled={disabled || isDraftRow || filledRowIndex === -1 || filledRowIndex >= (rows || []).length - 1}
                  label={isDraftRow || filledRowIndex === -1 || filledRowIndex >= (rows || []).length - 1 ? "Already last" : `Move ${row.ref || `target ${filledRowIndex + 1}`} down`}
                  onClick={() => moveRowDown(row.key)}
                />
                <div className="flex h-9 min-w-0 overflow-hidden rounded-lg border border-input bg-background/80 shadow-sm transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
                  <div className="flex shrink-0 items-center border-r border-border/70 bg-secondary/55 px-2.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Model
                  </div>
                  <Select
                    value={row.ref || undefined}
                    onValueChange={(value) => updateRow(row.key, value)}
                    disabled={disabled}
                    openSearchRequest={isDraftRow ? draftRowOpenSearchRequest : 0}
                  >
                    <SelectTrigger className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-3 shadow-none focus:border-transparent focus:ring-0">
                      <SelectValue placeholder={isDraftRow ? draftPlaceholder : placeholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {rowOptions.length > 0 ? renderSelectOptionNodes(rowOptions, {
                        keyPrefix: `${title}-row-${row.key}`
                      }) : (
                        <SelectItem value="__no-route-options" disabled>No routes available</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                {showWeightInput ? (
                  <div className={cn(
                    "flex h-9 overflow-hidden rounded-lg border border-input bg-background/80 shadow-sm transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40",
                    isDraftRow ? "opacity-45" : null
                  )}>
                    <div className="flex shrink-0 items-center border-r border-border/70 bg-secondary/55 px-2.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                      Weight
                    </div>
                    <Input
                      value={isDraftRow ? "" : String(row?.weight || "1")}
                      onChange={(event) => updateWeight(row.key, event.target.value)}
                      inputMode="numeric"
                      placeholder="1"
                      disabled={disabled || isDraftRow}
                      className="h-full min-w-0 rounded-none border-0 bg-transparent px-3 text-center shadow-none focus:border-transparent focus:ring-0"
                      aria-label={isDraftRow ? "Weight for new target" : `Weight for ${row.ref || `target ${index + 1}`}`}
                    />
                  </div>
                ) : null}
                {!isDraftRow ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className={ROW_REMOVE_BUTTON_CLASS}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => removeRow(row.key)}
                    disabled={disabled}
                  >
                    Remove
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(ROW_REMOVE_BUTTON_CLASS, "pointer-events-none invisible")}
                    tabIndex={-1}
                    disabled
                    aria-hidden="true"
                  >
                    Remove
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{emptyLabel}</div>
      )}

      {helperAction ? <div className="flex min-h-8 items-center justify-end">{helperAction}</div> : null}
    </div>
  );
}

function gcd(left, right) {
  let a = Math.abs(Number(left) || 0);
  let b = Math.abs(Number(right) || 0);
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function gcdMany(values = []) {
  if (!Array.isArray(values) || values.length === 0) return 1;
  return values.reduce((accumulator, value) => gcd(accumulator, value), 0) || 1;
}

function formatRouteOptionLabel(ref, routeOptionMap) {
  const normalizedRef = String(ref || "").trim();
  if (!normalizedRef) return "Unconfigured route";
  const option = routeOptionMap.get(normalizedRef);
  if (!option) return normalizedRef;
  const label = String(option.label || normalizedRef).trim() || normalizedRef;
  const hint = String(option.hint || "").trim();
  return hint && hint !== label ? `${label} · ${hint}` : label;
}

function buildAliasStrategyEntries(draft, alias, routeOptions = []) {
  const routeOptionMap = new Map(
    (routeOptions || [])
      .map((option) => [String(option?.value || "").trim(), option])
      .filter(([value]) => Boolean(value))
  );
  const primarySourceMap = new Map(
    (Array.isArray(alias?.targets) ? alias.targets : [])
      .map((target) => [String(target?.ref || "").trim(), target])
      .filter(([ref]) => Boolean(ref))
  );
  const fallbackSourceMap = new Map(
    (Array.isArray(alias?.fallbackTargets) ? alias.fallbackTargets : [])
      .map((target) => [String(target?.ref || "").trim(), target])
      .filter(([ref]) => Boolean(ref))
  );

  function buildEntries(rows, bucket, sourceMap) {
    return (rows || []).map((row, index) => {
      const ref = String(row?.ref || "").trim();
      const sourceRef = String(row?.sourceRef || row?.ref || "").trim();
      const sourceTarget = sourceMap.get(sourceRef) || sourceMap.get(ref) || {};
      const parsedWeight = Number(row?.weight ?? sourceTarget?.weight);
      const weight = Number.isFinite(parsedWeight) && parsedWeight > 0 ? Math.floor(parsedWeight) : 1;
      return {
        key: `${bucket}-${ref || "empty"}-${index}`,
        ref,
        label: formatRouteOptionLabel(ref, routeOptionMap),
        bucket,
        weight
      };
    }).filter((entry) => Boolean(entry.ref));
  }

  return [
    ...buildEntries(draft?.targets, "primary", primarySourceMap),
    ...buildEntries(draft?.fallbackTargets, "fallback", fallbackSourceMap)
  ];
}

function buildWeightedPreview(entries = [], limit = 8) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const weights = entries.map((entry) => Math.max(1, Number(entry?.weight) || 1));
  const divisor = gcdMany(weights);
  let slotWeights = weights.map((weight) => Math.max(1, Math.floor(weight / divisor)));
  let totalSlots = slotWeights.reduce((sum, weight) => sum + weight, 0);

  if (totalSlots > 24) {
    const scaleDown = totalSlots / 24;
    slotWeights = slotWeights.map((weight) => Math.max(1, Math.round(weight / scaleDown)));
    totalSlots = slotWeights.reduce((sum, weight) => sum + weight, 0);
  }

  const slots = [];
  for (let index = 0; index < entries.length; index += 1) {
    for (let slotIndex = 0; slotIndex < slotWeights[index]; slotIndex += 1) {
      slots.push(entries[index]);
    }
  }

  return Array.from({ length: Math.max(entries.length, limit) }, (_, index) => slots[index % slots.length]);
}

function buildAliasStrategyExplanation(strategy, entries = []) {
  const normalizedStrategy = normalizeModelAliasStrategyValue(strategy);
  const strategyLabel = formatModelAliasStrategyLabel(normalizedStrategy);
  const normalizedEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const hasFallbackEntries = normalizedEntries.some((entry) => entry.bucket === "fallback");
  const fallbackNote = hasFallbackEntries
    ? "Runtime builds the candidate pool as all primary targets first, then all fallback targets."
    : "Runtime builds the candidate pool from the primary target list only.";

  if (normalizedStrategy === "round-robin") {
    const sequenceEntries = normalizedEntries.length > 0
      ? Array.from({ length: Math.max(normalizedEntries.length, 8) }, (_, index) => normalizedEntries[index % normalizedEntries.length])
      : [];
    return {
      strategyLabel,
      summary: "Each new request starts from the next candidate in the current pool, then wraps around.",
      poolNote: `${fallbackNote} Round-robin rotates across that combined eligible list.`,
      sequenceLabel: "Example starting candidate by request",
      sequenceEntries,
      footnote: "If a candidate is unhealthy or quota-blocked, it is skipped and the next eligible candidate is chosen."
    };
  }

  if (normalizedStrategy === "weighted-rr" || normalizedStrategy === "quota-aware-weighted-rr" || normalizedStrategy === "auto") {
    const normalizedAuto = normalizedStrategy === "auto";
    const sequenceEntries = buildWeightedPreview(normalizedEntries, 8);
    return {
      strategyLabel,
      summary: normalizedAuto
        ? "`auto` normalizes to quota-aware weighted round-robin in the runtime balancer."
        : normalizedStrategy === "quota-aware-weighted-rr"
          ? "Candidates rotate like weighted round-robin, but low remaining quota or poor health lowers their share."
          : "Candidates repeat in proportion to their configured weights.",
      poolNote: `${fallbackNote} This strategy ranks across the full eligible pool after it is built.`,
      sequenceLabel: "Example starting candidate by request",
      sequenceEntries,
      footnote: normalizedAuto || normalizedStrategy === "quota-aware-weighted-rr"
        ? "When all quotas and health scores are equal, the rotation looks like the weighted example below. Low remaining capacity or retryable failures push a target later."
        : "Weights come from the existing alias target metadata when present. Targets without a stored weight behave as weight 1."
    };
  }

  return {
    strategyLabel,
    summary: "Requests try candidates in the configured list order and only move to later candidates when earlier ones are unavailable or fail.",
    poolNote: `${fallbackNote} Ordered keeps that exact sequence.`,
    sequenceLabel: "Attempt order",
    sequenceEntries: normalizedEntries,
    footnote: "This is the most predictable option when you want a strict preference order."
  };
}

function ModelAliasStrategyModal({
  open = false,
  onClose = () => {},
  onSave = () => {},
  aliasLabel = "",
  initialStrategy = "auto",
  entries = [],
  disabled = false
}) {
  const normalizedInitialStrategy = normalizeModelAliasStrategyValue(initialStrategy);
  const [selectedStrategy, setSelectedStrategy] = useState(normalizedInitialStrategy);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedStrategy(normalizedInitialStrategy);
    setSaving(false);
  }, [open, normalizedInitialStrategy, aliasLabel]);

  async function handleSaveClick() {
    if (disabled || saving) return;
    setSaving(true);
    try {
      const result = await onSave(selectedStrategy);
      if (result !== false) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={aliasLabel ? `Choose strategy · ${aliasLabel}` : "Choose strategy"}
      description="Review each routing strategy in its own tab. Save applies the currently selected tab to this alias."
      showCloseButton={false}
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSaveClick()}
            disabled={disabled || saving}
          >
            {saving ? "Saving…" : "Save strategy"}
          </Button>
        </div>
      )}
    >
      <Tabs value={selectedStrategy} onValueChange={setSelectedStrategy}>
        <div className="overflow-x-auto pb-1">
          <TabsList className="h-auto min-w-max flex-wrap justify-start gap-2 rounded-2xl bg-secondary/80 p-2">
            {MODEL_ALIAS_STRATEGY_OPTIONS.map((option) => (
              <TabsTrigger key={option.value} value={option.value} className="h-auto min-h-10 rounded-xl px-4 py-2">
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {MODEL_ALIAS_STRATEGY_OPTIONS.map((option) => {
          const strategyExplanation = buildAliasStrategyExplanation(option.value, entries);
          const sequenceEntries = (strategyExplanation.sequenceEntries || []).filter(Boolean);
          return (
            <TabsContent key={option.value} value={option.value} className="mt-4">
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
                <div className="space-y-4">
                  <div className="rounded-2xl border border-border/70 bg-background/80 p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{strategyExplanation.strategyLabel}</Badge>
                      <Badge variant="info">{entries.length} candidate{entries.length === 1 ? "" : "s"}</Badge>
                    </div>
                    <div className="mt-4 space-y-3 text-sm leading-6 text-foreground">
                      <p>{strategyExplanation.summary}</p>
                      <p className="text-muted-foreground">{strategyExplanation.poolNote}</p>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-border/70 bg-background/80 p-5">
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{strategyExplanation.sequenceLabel}</div>
                    {sequenceEntries.length > 0 ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {sequenceEntries.map((entry, index) => (
                          <div key={`${entry.key}-sequence-${index}`} className="rounded-full border border-border/70 bg-card/90 px-3 py-1.5 text-sm text-foreground">
                            <span className="mr-2 text-xs text-muted-foreground">{index + 1}</span>
                            <span>{entry.label}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
                        Add at least one target to preview how this strategy would route requests.
                      </div>
                    )}
                    <div className="mt-4 text-sm leading-6 text-muted-foreground">{strategyExplanation.footnote}</div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-2xl border border-border/70 bg-background/80 p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Current setup</div>
                      {aliasLabel ? <Badge variant="outline">{aliasLabel}</Badge> : null}
                    </div>
                    {entries.length > 0 ? (
                      <div className="mt-4 space-y-2">
                        {entries.map((entry) => (
                          <div key={entry.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-sm">
                            <Badge variant={entry.bucket === "primary" ? "info" : "outline"}>{entry.bucket}</Badge>
                            <span className="font-medium text-foreground">{entry.label}</span>
                            <span className="text-xs text-muted-foreground">weight {entry.weight}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
                        This alias does not have any targets yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </TabsContent>
          );
        })}
      </Tabs>
    </Modal>
  );
}

function AliasGuideModal({
  open = false,
  onClose = () => {},
  config = {}
}) {
  const mixedContextAliases = useMemo(
    () => buildAliasGuideContextNotes(config),
    [config]
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Alias guide"
      description="Aliases give clients one stable route while letting LLM Router swap, balance, and fail over across provider/model targets behind that route."
      contentClassName="max-h-[92vh] max-w-4xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
      bodyClassName="max-h-[calc(92vh-5.5rem)]"
    >
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Stable route</div>
            <div className="mt-2 text-sm leading-6 text-foreground">Expose one alias like <code>coding</code> or <code>gpt-5.4</code> to clients, then retarget the alias later without touching client config.</div>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Selection strategy</div>
            <div className="mt-2 text-sm leading-6 text-foreground">The alias strategy controls how LLM Router picks from the configured targets. Ordered is strict preference; the other strategies distribute traffic when multiple targets are healthy.</div>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Fallback behavior</div>
            <div className="mt-2 text-sm leading-6 text-foreground">If one target is unavailable or rate limited, LLM Router can continue to later candidates in the same alias instead of failing the whole request immediately.</div>
          </div>
        </div>

        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="warning">Important</Badge>
            <div className="text-sm font-medium text-amber-950">Mixed context windows inside one alias can change behavior.</div>
          </div>
          <div className="mt-3 text-sm leading-6 text-amber-900">
            If an alias mixes models with different context windows, requests that fit the larger model may still fail on the smaller model.
            For example, an alias that includes both a <code>258K</code> model and a <code>128K</code> model can still fail when routing lands on the smaller target.
            Keep aliases aligned by context size when you expect long histories or large prompts.
          </div>
        </div>

        <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Current config check</div>
              <div className="mt-1 text-sm text-muted-foreground">Aliases below currently mix different configured model context windows.</div>
            </div>
            <Badge variant={mixedContextAliases.length > 0 ? "warning" : "success"}>
              {mixedContextAliases.length > 0 ? `${mixedContextAliases.length} alias${mixedContextAliases.length === 1 ? "" : "es"} need review` : "No mixed context windows detected"}
            </Badge>
          </div>

          {mixedContextAliases.length > 0 ? (
            <div className="mt-4 space-y-3">
              {mixedContextAliases.map((summary) => (
                <div key={summary.aliasId} className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{summary.aliasId}</Badge>
                    <div className="text-sm font-medium text-amber-950">
                      Smallest target: {formatContextWindow(summary.smallestContextWindow)}. Largest target: {formatContextWindow(summary.largestContextWindow)}.
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {summary.models.map((model) => (
                      <div key={model.ref} className="rounded-full border border-amber-200 bg-background/90 px-3 py-1.5 text-sm text-foreground">
                        {model.ref} · {formatContextWindow(model.contextWindow)}
                      </div>
                    ))}
                    {summary.unknownRefs.map((ref) => (
                      <div key={ref} className="rounded-full border border-dashed border-amber-300 bg-background/70 px-3 py-1.5 text-sm text-muted-foreground">
                        {ref} · context unknown
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
              No alias currently mixes known context-window sizes across its configured targets.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ModelAliasCard({
  aliasId,
  alias,
  aliasIds,
  routeOptions,
  defaultModel,
  ampDefaultRoute,
  disabled = false,
  disabledReason = "",
  busy = false,
  onApply,
  onRemove,
  onCopyAliasId = () => {},
  isNew = false,
  alwaysShowAliasIdInput = false,
  showIssueOnSubmitOnly = false,
  onDiscard = () => {},
  onOpenStrategyModal = () => {},
  titleAccessory = null,
  aliasSwitcher = null,
  framed = true
}) {
  const initialDraftResetKey = buildAliasDraftResetKey(aliasId, alias, { isNew });
  const initialDraft = useMemo(
    () => createAliasDraftState(isNew ? "" : aliasId, alias),
    [initialDraftResetKey]
  );
  const [draft, setDraft] = useState(initialDraft);
  const [aliasIdEditing, setAliasIdEditing] = useState(isNew);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const aliasIdInputRef = useRef(null);

  useEffect(() => {
    setDraft(initialDraft);
    setAliasIdEditing(isNew);
    setSubmitAttempted(false);
  }, [initialDraft, isNew]);

  const hasAliasSwitcher = !isNew && Array.isArray(aliasSwitcher?.entries) && aliasSwitcher.entries.length > 1;
  const showAliasIdInput = alwaysShowAliasIdInput || aliasIdEditing;

  useEffect(() => {
    if (!showAliasIdInput) return undefined;
    const frameId = typeof window !== "undefined"
      ? window.requestAnimationFrame(() => {
        aliasIdInputRef.current?.focus();
        aliasIdInputRef.current?.select?.();
      })
      : 0;
    return () => {
      if (typeof window !== "undefined") window.cancelAnimationFrame(frameId);
    };
  }, [showAliasIdInput]);

  const normalizedAliasId = String(draft?.id || "").trim();
  const isFixedDefault = aliasId === DEFAULT_MODEL_ALIAS_ID || normalizedAliasId === DEFAULT_MODEL_ALIAS_ID;
  const filteredRouteOptions = useMemo(
    () => withCurrentManagedRouteOptions(
      (routeOptions || []).filter((option) => (
        option.kind !== "alias"
        && option.value !== normalizedAliasId
        && option.value !== `alias:${normalizedAliasId}`
      )),
      (draft?.targets || []).map((row) => row?.ref)
    ),
    [routeOptions, normalizedAliasId, draft?.targets]
  );
  const primaryRefs = (draft?.targets || []).map((row) => String(row?.ref || "").trim());
  const hasBlankRows = (draft?.targets || []).some((row) => !String(row?.ref || "").trim());
  const hasDuplicates = hasDuplicateTrimmedValues(primaryRefs);
  const hasInvalidWeights = (draft?.targets || []).some((row) => {
    if (!String(row?.ref || "").trim()) return false;
    const weight = Math.floor(Number(row?.weight));
    return !Number.isFinite(weight) || weight <= 0;
  });
  const aliasIdConflict = normalizedAliasId && aliasIds.some((candidate) => candidate !== aliasId && candidate === normalizedAliasId);
  const hasSelfReference = normalizedAliasId
    && primaryRefs.some((ref) => ref === normalizedAliasId || ref === `alias:${normalizedAliasId}`);
  const hasTargets = primaryRefs.filter(Boolean).length > 0;
  const initialSignature = JSON.stringify({
    id: initialDraft.id,
    strategy: initialDraft.strategy,
    targets: initialDraft.targets.map((row) => ({ ref: row.ref, weight: String(row?.weight || "1") }))
  });
  const draftSignature = JSON.stringify({
    id: normalizedAliasId,
    strategy: draft?.strategy,
    targets: (draft?.targets || []).map((row) => ({ ref: String(row?.ref || "").trim(), weight: String(row?.weight || "1").trim() }))
  });
  const isDirty = initialSignature !== draftSignature;
  const validationIssue = !normalizedAliasId
      ? "Alias id is required."
      : !QUICK_START_ALIAS_ID_PATTERN.test(normalizedAliasId)
        ? "Alias id must start with a letter or number and use letters, numbers, dots, underscores, colons, or hyphens."
        : aliasIdConflict
        ? "Alias id already exists. Choose another id."
        : hasBlankRows
          ? "Fill or remove blank target rows before applying."
          : hasDuplicates
            ? "Duplicate targets are not allowed anywhere in this alias."
            : hasInvalidWeights
              ? "Target weights must be positive integers."
            : hasSelfReference
              ? "An alias cannot target itself."
              : "";
  const issue = disabled ? disabledReason : validationIssue;
  const visibleIssue = disabled
    ? disabledReason
    : (showIssueOnSubmitOnly && validationIssue && !submitAttempted ? "" : validationIssue);
  const locked = disabled || busy;
  const selectedAliasId = String(normalizedAliasId || aliasId || "").trim();
  const selectedAliasLabel = selectedAliasId || "Select alias";
  const removeAliasDisabled = locked || isFixedDefault || isNew;
  const removeAliasLabel = isFixedDefault
    ? "Default alias cannot be removed"
    : `Remove alias ${selectedAliasId || aliasId}`;
  const aliasSwitcherTriggerWidth = useMemo(
    () => measureAliasSwitcherWidth(selectedAliasLabel),
    [selectedAliasLabel]
  );
  const isDefault = isFixedDefault || defaultModel === aliasId || defaultModel === normalizedAliasId;
  const isAmpDefault = ampDefaultRoute === aliasId || ampDefaultRoute === normalizedAliasId;
  const aliasIdPlaceholder = isNew ? "Enter alias name. Example: claude-opus" : undefined;
  const strategyEntries = useMemo(
    () => buildAliasStrategyEntries({ ...draft, fallbackTargets: [] }, { ...alias, fallbackTargets: [] }, routeOptions),
    [draft, alias, routeOptions]
  );

  async function handleApplyClick() {
    setSubmitAttempted(true);
    if (issue) return false;
    const result = await onApply(aliasId, { ...draft, fallbackTargets: [] });
    if (result && isNew) onDiscard(aliasId);
    return result;
  }

  async function handleSaveStrategy(strategy) {
    const nextDraft = { ...draft, strategy };
    const result = await onApply(aliasId, { ...nextDraft, fallbackTargets: [] });
    if (!result) return false;
    if (isNew) {
      onDiscard(aliasId);
      return true;
    }
    setDraft(nextDraft);
    return true;
  }

  async function handleInlineAliasRename() {
    setSubmitAttempted(true);
    if (issue) return false;
    const result = await onApply(aliasId, { ...draft, fallbackTargets: [] });
    if (result) {
      setAliasIdEditing(false);
      setSubmitAttempted(false);
    }
    return result;
  }

  function handleAliasIdBlur() {
    if (alwaysShowAliasIdInput) return;
    if (!hasAliasSwitcher) {
      setAliasIdEditing(false);
      return;
    }

    const currentAliasId = String(aliasId || "").trim();
    const nextAliasId = String(draft?.id || "").trim();
    if (!nextAliasId || nextAliasId === currentAliasId) {
      setDraft((current) => ({ ...current, id: currentAliasId }));
      setAliasIdEditing(false);
      setSubmitAttempted(false);
      return;
    }

    void handleInlineAliasRename();
  }

  function handleAliasIdKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft((current) => ({ ...current, id: initialDraft.id }));
      setAliasIdEditing(false);
      setSubmitAttempted(false);
      return;
    }

    if (!alwaysShowAliasIdInput && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  async function handleAliasIdActionClick() {
    if (showAliasIdInput) {
      const currentAliasId = String(aliasId || "").trim();
      const nextAliasId = String(draft?.id || "").trim();
      if (!nextAliasId || nextAliasId === currentAliasId) {
        setDraft((current) => ({ ...current, id: currentAliasId }));
        setAliasIdEditing(false);
        setSubmitAttempted(false);
        return;
      }
      await handleInlineAliasRename();
      return;
    }

    setAliasIdEditing(true);
  }

  const content = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {hasAliasSwitcher ? (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <div className={cn(
                  "flex h-9 min-w-0 max-w-full overflow-hidden rounded-lg border border-input bg-background/80 shadow-sm transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40",
                  showAliasIdInput ? "flex-1" : "w-fit"
                )}>
                  <div className="flex shrink-0 items-center border-r border-border/70 bg-secondary/55 px-2.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Select an alias
                  </div>
                  {showAliasIdInput ? (
                    <Input
                      ref={aliasIdInputRef}
                      value={draft.id}
                      placeholder={aliasIdPlaceholder}
                      onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
                      onBlur={handleAliasIdBlur}
                      onKeyDown={handleAliasIdKeyDown}
                      disabled={locked || isFixedDefault}
                      className="h-full min-w-[12rem] flex-1 rounded-none border-0 bg-transparent px-3 text-sm font-medium shadow-none focus:border-transparent focus:ring-0"
                    />
                  ) : (
                    <Select value={aliasSwitcher.value || undefined} onValueChange={aliasSwitcher.onValueChange}>
                      <SelectTrigger
                        className="h-full min-w-[10rem] flex-none rounded-none border-0 bg-transparent px-3 pr-[50px] text-left text-sm font-medium shadow-none focus:border-transparent focus:ring-0"
                        style={{ width: `${aliasSwitcherTriggerWidth}px`, maxWidth: "100%" }}
                      >
                        <SelectValue placeholder="Select alias" />
                      </SelectTrigger>
                      <SelectContent>
                        {aliasSwitcher.entries.map(([entryAliasId, entryAlias]) => (
                          <SelectItem
                            key={entryAliasId}
                            value={entryAliasId}
                            searchText={`${entryAliasId} ${(entryAlias?.targets || []).length} ${(entryAlias?.fallbackTargets || []).length}`}
                          >
                            {entryAliasId}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {!showAliasIdInput ? (
                    <button
                      type="button"
                      className="flex h-full w-10 shrink-0 items-center justify-center border-l border-border/70 text-muted-foreground transition hover:bg-accent/60 hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => void onCopyAliasId(selectedAliasId)}
                      disabled={locked || !selectedAliasId}
                      aria-label={`Copy alias id ${selectedAliasId}`}
                      title={selectedAliasId ? `Copy alias id ${selectedAliasId}` : "Alias id is not ready yet"}
                    >
                      <CopyIcon className="h-4 w-4 shrink-0" />
                    </button>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 w-9 rounded-lg border-border/70 bg-background/70 p-0 text-muted-foreground shadow-none hover:bg-background/90 hover:text-foreground"
                  onMouseDown={(event) => {
                    if (showAliasIdInput) event.preventDefault();
                  }}
                  onClick={() => void handleAliasIdActionClick()}
                  disabled={locked || isFixedDefault}
                  aria-label={showAliasIdInput ? "Save alias id" : (isFixedDefault ? "Default alias id cannot be edited" : "Edit alias id")}
                  title={showAliasIdInput ? "Save alias id" : (isFixedDefault ? "Default alias id cannot be edited" : "Edit alias id")}
                >
                  {showAliasIdInput ? <CheckIcon className="h-4 w-4 shrink-0" /> : <EditIcon className="h-4 w-4 shrink-0" />}
                </Button>
                {!isNew ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 w-9 rounded-lg border-border/70 bg-background/70 p-0 text-muted-foreground shadow-none hover:border-destructive hover:bg-background/90 hover:text-destructive"
                    onClick={() => onRemove(aliasId)}
                    disabled={removeAliasDisabled}
                    aria-label={removeAliasLabel}
                    title={removeAliasLabel}
                  >
                    <TrashIcon className="h-4 w-4 shrink-0" />
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                {showAliasIdInput ? (
                  <Input
                    ref={aliasIdInputRef}
                    autoFocus={isNew}
                    value={draft.id}
                    placeholder={aliasIdPlaceholder}
                    onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
                    onBlur={handleAliasIdBlur}
                    onKeyDown={handleAliasIdKeyDown}
                    disabled={locked || (isFixedDefault && !isNew)}
                    className="max-w-[22rem] font-semibold"
                  />
                ) : (
                  isFixedDefault && !isNew ? (
                    <div className="truncate text-base font-semibold text-foreground">{aliasId}</div>
                  ) : (
                    <button
                      type="button"
                      className="group inline-flex max-w-full items-center gap-2 rounded-lg text-left text-base font-semibold text-foreground transition hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      onClick={() => setAliasIdEditing(true)}
                      disabled={locked}
                      aria-label="Edit alias id"
                      title="Edit alias id"
                    >
                      <span className="truncate">{isNew ? (normalizedAliasId || "New alias") : normalizedAliasId || aliasId}</span>
                      <EditIcon className="h-4 w-4 shrink-0" />
                    </button>
                  )
                )}
                {titleAccessory ? <div className="min-w-[11rem] max-w-full">{titleAccessory}</div> : null}
              </>
            )}
          </div>
          {!isFixedDefault ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {isDefault ? <Badge variant="success">Default route</Badge> : null}
              {isAmpDefault ? <Badge variant="info">AMP default</Badge> : null}
            </div>
          ) : null}
        </div>
        <div className="flex items-start gap-2 self-start">
          <Button
            type="button"
            variant="outline"
            size="default"
            className="group h-9 gap-0 overflow-hidden rounded-lg border-border/70 bg-background/70 px-0 text-sm font-medium normal-case tracking-normal shadow-none hover:bg-background/90"
            onClick={() => onOpenStrategyModal({
              aliasLabel: normalizedAliasId || (isNew ? "New alias" : aliasId),
              strategy: draft?.strategy || "auto",
              entries: strategyEntries,
              disabled: locked || Boolean(issue),
              onSave: handleSaveStrategy
            })}
            disabled={locked}
          >
            <span className="flex h-full shrink-0 items-center border-r border-border/70 bg-secondary/55 px-2.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Routing stratergy
            </span>
            <span className="inline-flex min-w-0 items-center gap-2 px-3 text-left">
              <span className="truncate">{formatModelAliasStrategyLabel(draft.strategy || "auto")}</span>
              <EditIcon className="h-4 w-4 shrink-0" />
            </span>
          </Button>
          {!hasAliasSwitcher && !isNew ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 w-9 rounded-lg border-border/70 bg-background/70 p-0 text-muted-foreground shadow-none hover:border-destructive hover:bg-background/90 hover:text-destructive"
              onClick={() => onRemove(aliasId)}
              disabled={removeAliasDisabled}
              aria-label={removeAliasLabel}
              title={removeAliasLabel}
            >
              <TrashIcon className="h-4 w-4 shrink-0" />
            </Button>
          ) : null}
        </div>
      </div>

      <RouteTargetListEditor
        title="Manage model in alias"
        rows={draft.targets}
        onChange={(targets) => setDraft((current) => ({ ...current, targets }))}
        options={filteredRouteOptions}
        disabled={locked}
        addLabel="Add target"
        emptyLabel="No targets yet. This alias can stay empty until you wire routes back in."
        helperText="Drag to reorder targets. Weights and metadata stay with the same ref."
        draftPlaceholder="Add a new target"
        showDraftRow
        showDraftFocusButton
        showWeightInput
        filterOtherSelectedValues
        excludedValues={[]}
      />

      {visibleIssue ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{visibleIssue}</div> : null}
      {!visibleIssue && isFixedDefault && !hasTargets ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The fixed <code>default</code> route is empty. Requests routed to <code>default</code> or <code>smart</code> will return 500 until you add a working target.
        </div>
      ) : null}

      {isNew || isDirty ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {isNew ? (
              <Button type="button" variant="ghost" onClick={() => onDiscard(aliasId)} disabled={locked}>Discard</Button>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {isDirty ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDraft(initialDraft);
                  setSubmitAttempted(false);
                }}
                disabled={locked}
              >
                Reset
              </Button>
            ) : null}
            {(isNew || (isDirty && !issue)) ? (
              <Button type="button" onClick={() => void handleApplyClick()} disabled={locked}>
                {busy ? "Saving…" : (isNew ? "Create alias" : "Apply alias")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );

  if (!framed) {
    return content;
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        {content}
      </CardContent>
    </Card>
  );
}

function ModelAliasSection({
  aliases,
  config,
  aliasIds,
  routeOptions,
  defaultModel,
  ampDefaultRoute,
  disabledReason = "",
  busy = false,
  onApplyAlias,
  onRemoveAlias,
  onCopyAliasId
}) {
  const aliasEntries = Object.entries(aliases || {});
  const disabled = Boolean(disabledReason);
  const [pendingNewAliasKey, setPendingNewAliasKey] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectedAliasId, setSelectedAliasId] = useState("");
  const pendingAliasSeed = useMemo(() => createPendingAliasSeed(), []);
  const [strategyModalState, setStrategyModalState] = useState({
    open: false,
    aliasLabel: "",
    strategy: "auto",
    entries: [],
    disabled: false,
    onSave: null
  });

  function handleCreateNewAlias() {
    if (disabled || busy) return;
    setPendingNewAliasKey(`draft-${Date.now()}`);
  }

  function handleDiscardNewAlias(key) {
    if (!key || key === pendingNewAliasKey) {
      setPendingNewAliasKey("");
    }
  }

  function handleCloseCreateAliasModal() {
    setPendingNewAliasKey("");
  }

  function handleOpenStrategyModal({ aliasLabel = "", strategy = "auto", entries = [], disabled: strategyDisabled = false, onSave = null }) {
    setStrategyModalState({
      open: true,
      aliasLabel,
      strategy,
      entries,
      disabled: strategyDisabled,
      onSave
    });
  }

  function handleCloseStrategyModal() {
    setStrategyModalState((current) => ({
      ...current,
      open: false
    }));
  }

  async function handleApplyAliasDraft(aliasId, draftAlias) {
    const result = await onApplyAlias(aliasId, draftAlias);
    if (result) {
      const nextAliasId = String(draftAlias?.id || aliasId || "").trim() || aliasId;
      setSelectedAliasId(nextAliasId);
    }
    return result;
  }

  useEffect(() => {
    const availableAliasIds = aliasEntries.map(([aliasId]) => aliasId);
    if (availableAliasIds.length === 0) {
      if (selectedAliasId) setSelectedAliasId("");
      return;
    }
    if (!selectedAliasId || !availableAliasIds.includes(selectedAliasId)) {
      setSelectedAliasId(availableAliasIds[0]);
    }
  }, [aliasEntries, selectedAliasId]);

  const activeAliasEntry = aliasEntries.find(([aliasId]) => aliasId === selectedAliasId) || aliasEntries[0] || null;
  const activeAliasId = activeAliasEntry?.[0] || "";
  const activeAlias = activeAliasEntry?.[1] || null;
  const activeAliasSwitcher = aliasEntries.length > 1
    ? {
      value: activeAliasId,
      onValueChange: setSelectedAliasId,
      entries: aliasEntries
    }
    : null;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardDescription>Model aliases give clients one stable route across multiple provider/models, so you can swap, balance, and fail over without changing client config.</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setHelpOpen(true)}>
                Help
              </Button>
              <Button type="button" size="sm" onClick={handleCreateNewAlias} disabled={disabled || busy}>
                {busy ? "Saving…" : "Add alias"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {disabled ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{disabledReason}</div> : null}

          {aliasEntries.length > 0 ? (
            activeAliasId && activeAlias ? (
              <ModelAliasCard
                key={activeAliasId}
                aliasId={activeAliasId}
                alias={activeAlias}
                aliasIds={aliasIds}
                routeOptions={routeOptions}
                defaultModel={defaultModel}
                ampDefaultRoute={ampDefaultRoute}
                disabled={disabled}
                disabledReason={disabledReason}
                busy={busy}
                onApply={handleApplyAliasDraft}
                onRemove={onRemoveAlias}
                onCopyAliasId={onCopyAliasId}
                onOpenStrategyModal={handleOpenStrategyModal}
                aliasSwitcher={activeAliasSwitcher}
                framed={false}
              />
            ) : null
          ) : (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">No model aliases yet. Add one to expose stable routes like <code>coding</code> or <code>chat.fast</code> in the Web UI.</div>
          )}
        </CardContent>
      </Card>

      <Modal
        open={Boolean(pendingNewAliasKey)}
        onClose={handleCloseCreateAliasModal}
        title="Add alias"
        description="Set a stable client-facing route, choose its strategy, and order the targets it should use."
        showCloseButton={false}
        contentClassName="max-h-[92vh] max-w-5xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
        bodyClassName="max-h-[calc(92vh-5.5rem)]"
      >
        {pendingNewAliasKey ? (
          <ModelAliasCard
            key={pendingNewAliasKey}
            aliasId={pendingNewAliasKey}
            alias={pendingAliasSeed}
            aliasIds={aliasIds}
            routeOptions={routeOptions}
            defaultModel={defaultModel}
            ampDefaultRoute={ampDefaultRoute}
            disabled={disabled}
            disabledReason={disabledReason}
            busy={busy}
            onApply={handleApplyAliasDraft}
            onRemove={onRemoveAlias}
            onCopyAliasId={onCopyAliasId}
            isNew
            alwaysShowAliasIdInput
            showIssueOnSubmitOnly
            onDiscard={handleDiscardNewAlias}
            onOpenStrategyModal={handleOpenStrategyModal}
            framed={false}
          />
        ) : null}
      </Modal>

      <ModelAliasStrategyModal
        open={strategyModalState.open}
        onClose={handleCloseStrategyModal}
        onSave={(strategy) => strategyModalState.onSave?.(strategy)}
        aliasLabel={strategyModalState.aliasLabel}
        initialStrategy={strategyModalState.strategy}
        entries={strategyModalState.entries}
        disabled={strategyModalState.disabled}
      />

      <AliasGuideModal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        config={config}
      />
    </>
  );
}

function SummaryChipButton({ children, onClick, disabled = false, title = "", className = "" }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-background/70 px-2.5 py-1 text-[11px] font-medium tracking-wide text-muted-foreground transition hover:border-primary/35 hover:bg-primary/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title || undefined}
    >
      {children}
    </button>
  );
}

function ProviderCard({
  provider,
  onRemove,
  onCopyModelId,
  onApplyProviderDetails,
  onApplyProviderModels,
  onSaveAndCloseEditor,
  disabledReason = "",
  busy = false
}) {
  const initialDraft = useMemo(() => createProviderInlineDraftState(provider), [provider]);
  const [draft, setDraft] = useState(initialDraft);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [failedCloseOpen, setFailedCloseOpen] = useState(false);
  const [editTab, setEditTab] = useState("provider");
  const [editFocusTarget, setEditFocusTarget] = useState("");
  const [modelFocusRequest, setModelFocusRequest] = useState(0);
  const [modelEditorState, setModelEditorState] = useState({
    isDirty: false,
    issue: "",
    locked: false,
    rows: []
  });
  const [modelSaveState, setModelSaveState] = useState({
    phase: "",
    modelStates: {},
    failedModelIds: [],
    message: ""
  });
  const endpointSectionRef = useRef(null);
  const endpointInputRef = useRef(null);
  const rateLimitSectionRef = useRef(null);
  const rateLimitInputRef = useRef(null);

  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  const connectionType = inferQuickStartConnectionType(provider);
  const isSubscription = connectionType !== "api";
  const modelIds = (Array.isArray(provider?.models) ? provider.models : []).map((model) => String(model?.id || "").trim()).filter(Boolean);
  const endpointCandidates = collectQuickStartEndpoints(provider);
  const rateLimitSummary = !isSubscription ? formatRateLimitSummary(provider?.rateLimits) : "";
  const resolvedEndpoints = isSubscription
    ? []
    : mergeChipValuesAndDraft(draft?.endpoints, draft?.endpointDraft);
  const resolvedRateLimitRows = isSubscription ? [] : resolveRateLimitDraftRows(draft?.rateLimitRows);
  const draftSignature = JSON.stringify({
    id: String(draft?.id || "").trim(),
    name: String(draft?.name || "").trim(),
    credentialInput: String(draft?.credentialInput || "").trim(),
    endpoints: resolvedEndpoints,
    endpointDraft: String(draft?.endpointDraft || "").trim(),
    rateLimitRows: serializeRateLimitDraftRows(draft?.rateLimitRows)
  });
  const initialSignature = JSON.stringify({
    id: String(initialDraft?.id || "").trim(),
    name: String(initialDraft?.name || "").trim(),
    credentialInput: String(initialDraft?.credentialInput || "").trim(),
    endpoints: normalizeUniqueTrimmedValues(initialDraft?.endpoints),
    endpointDraft: String(initialDraft?.endpointDraft || "").trim(),
    rateLimitRows: serializeRateLimitDraftRows(initialDraft?.rateLimitRows)
  });
  const isDirty = draftSignature !== initialSignature;
  const locked = Boolean(disabledReason) || busy;
  const activeModelIds = new Set((Array.isArray(modelEditorState.rows) ? modelEditorState.rows : []).map((row) => String(row?.id || "").trim()).filter(Boolean));
  const activeFailedModelIds = modelSaveState.failedModelIds.filter((modelId) => activeModelIds.has(modelId));
  const modalCloseLocked = locked || modelSaveState.phase === "testing" || modelSaveState.phase === "saving";
  const rateLimitIssue = !isSubscription
    ? validateRateLimitDraftRows(resolvedRateLimitRows, {
        knownModelIds: modelIds,
        requireAtLeastOne: true
      })
    : "";
  const issue = disabledReason
    ? disabledReason
    : !String(draft?.id || "").trim()
      ? "Provider id is required."
      : !QUICK_START_PROVIDER_ID_PATTERN.test(String(draft?.id || "").trim())
        ? "Provider id must start with a letter and use lowercase letters, digits, or dashes only."
        : !String(draft?.name || "").trim()
          ? "Provider name is required."
          : !isSubscription && resolvedEndpoints.length === 0
            ? "Add at least one endpoint for API Key providers."
            : !isSubscription && resolvedEndpoints.some((endpoint) => !isLikelyHttpEndpoint(endpoint))
            ? "All endpoints must start with http:// or https://."
              : rateLimitIssue;
  const providerDraftForSave = isSubscription ? draft : { ...draft, endpoints: resolvedEndpoints, endpointDraft: "" };
  const hasModelUnsavedChanges = Boolean(modelEditorState.isDirty);
  const hasUnsavedChanges = isDirty || hasModelUnsavedChanges;
  const closeDirtyLabels = [
    isDirty ? "provider settings" : "",
    hasModelUnsavedChanges ? "model list" : ""
  ].filter(Boolean);
  const closeDetails = [
    isDirty && issue ? `Provider: ${issue}` : "",
    hasModelUnsavedChanges && modelEditorState.issue ? `Models: ${modelEditorState.issue}` : ""
  ].filter(Boolean).join(" ");
  const saveAndCloseDisabled = locked
    || modelSaveState.phase === "testing"
    || modelSaveState.phase === "saving"
    || (isDirty && Boolean(issue))
    || (hasModelUnsavedChanges && (Boolean(modelEditorState.issue) || modelEditorState.locked))
    || typeof onSaveAndCloseEditor !== "function";

  async function handleApplyClick() {
    const saved = await onApplyProviderDetails(
      provider.id,
      providerDraftForSave
    );
    if (saved) finalizeCloseEditModal();
    return saved;
  }

  async function handleApplyModelsAndClose(rows) {
    const saved = await onApplyProviderModels(provider.id, rows, {
      providerDraft: isDirty ? providerDraftForSave : null,
      onModelTestStateChange: (nextState) => {
        setModelSaveState({
          phase: String(nextState?.phase || ""),
          modelStates: nextState?.modelStates && typeof nextState.modelStates === "object" ? nextState.modelStates : {},
          failedModelIds: Array.isArray(nextState?.failedModelIds) ? nextState.failedModelIds : [],
          message: String(nextState?.message || "")
        });
      }
    });
    if (saved) finalizeCloseEditModal();
    return saved;
  }

  function handleResetProviderDraft() {
    setDraft(initialDraft);
  }

  const handleModelEditorStateChange = useCallback((nextState) => {
    setModelEditorState(nextState);
  }, []);

  function finalizeCloseEditModal() {
    setConfirmCloseOpen(false);
    setFailedCloseOpen(false);
    setEditOpen(false);
    setEditTab("provider");
    setEditFocusTarget("");
    setDraft(initialDraft);
    setModelEditorState({
      isDirty: false,
      issue: "",
      locked: false,
      rows: []
    });
    setModelSaveState({
      phase: "",
      modelStates: {},
      failedModelIds: [],
      message: ""
    });
  }

  async function handleRemoveFailedModelsAndClose() {
    const remainingRows = (Array.isArray(modelEditorState.rows) ? modelEditorState.rows : [])
      .filter((row) => !activeFailedModelIds.includes(String(row?.id || "").trim()));

    if (remainingRows.length === 0 && !isDirty) {
      finalizeCloseEditModal();
      return true;
    }

    const saved = await onSaveAndCloseEditor(provider.id, {
      providerDraft: isDirty ? providerDraftForSave : null,
      modelRows: hasModelUnsavedChanges ? remainingRows : null,
      onModelTestStateChange: (nextState) => {
        setModelSaveState({
          phase: String(nextState?.phase || ""),
          modelStates: nextState?.modelStates && typeof nextState.modelStates === "object" ? nextState.modelStates : {},
          failedModelIds: Array.isArray(nextState?.failedModelIds) ? nextState.failedModelIds : [],
          message: String(nextState?.message || "")
        });
      }
    });
    if (!saved) {
      setEditTab("models");
      return false;
    }
    finalizeCloseEditModal();
    return true;
  }

  useEffect(() => {
    setModelSaveState({
      phase: "",
      modelStates: {},
      failedModelIds: [],
      message: ""
    });
  }, [initialDraft]);

  useEffect(() => {
    if (activeFailedModelIds.length > 0 || !failedCloseOpen) return;
    setFailedCloseOpen(false);
  }, [activeFailedModelIds, failedCloseOpen]);

  useEffect(() => {
    if (!editOpen || editTab !== "provider") return undefined;
    if (editFocusTarget !== "endpoint" && editFocusTarget !== "rate-limit") return undefined;
    if (typeof window === "undefined") return undefined;
    const frameId = window.requestAnimationFrame(() => {
      const sectionNode = editFocusTarget === "endpoint" ? endpointSectionRef.current : rateLimitSectionRef.current;
      const inputNode = editFocusTarget === "endpoint" ? endpointInputRef.current : rateLimitInputRef.current;
      sectionNode?.scrollIntoView?.({ block: "nearest" });
      inputNode?.focus?.();
      inputNode?.select?.();
      setEditFocusTarget("");
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [editOpen, editTab, editFocusTarget]);

  function handleOpenEditModal(tab = "provider", focusTarget = "") {
    setConfirmCloseOpen(false);
    setFailedCloseOpen(false);
    setEditTab(tab);
    setEditFocusTarget(focusTarget);
    if (tab === "models" && focusTarget === "models") {
      setModelFocusRequest((current) => current + 1);
    }
    setEditOpen(true);
  }

  function handleCloseEditModal() {
    if (modalCloseLocked) return;
    if (activeFailedModelIds.length > 0) {
      setConfirmCloseOpen(false);
      setFailedCloseOpen(true);
      return;
    }
    if (hasUnsavedChanges) {
      setConfirmCloseOpen(true);
      return;
    }
    finalizeCloseEditModal();
  }

  async function handleSaveAndCloseEditModal() {
    if (saveAndCloseDisabled) return;
    const saved = await onSaveAndCloseEditor(provider.id, {
      providerDraft: isDirty ? providerDraftForSave : null,
      modelRows: hasModelUnsavedChanges ? modelEditorState.rows : null,
      onModelTestStateChange: (nextState) => {
        setModelSaveState({
          phase: String(nextState?.phase || ""),
          modelStates: nextState?.modelStates && typeof nextState.modelStates === "object" ? nextState.modelStates : {},
          failedModelIds: Array.isArray(nextState?.failedModelIds) ? nextState.failedModelIds : [],
          message: String(nextState?.message || "")
        });
      }
    });
    if (!saved) {
      if (hasModelUnsavedChanges) {
        setConfirmCloseOpen(false);
        setEditTab("models");
      }
      return;
    }
    finalizeCloseEditModal();
  }

  return (
    <>
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 px-0.5 py-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-base font-semibold text-foreground">{provider.name || provider.id}</span>
                <span className="text-sm text-muted-foreground">({provider.id})</span>
              </div>
            </div>
            <div className="flex items-start gap-2 self-start">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 normal-case tracking-normal"
                onClick={() => handleOpenEditModal("provider")}
                disabled={locked}
                aria-label={`Edit provider ${provider.name || provider.id}`}
                title="Edit provider"
              >
                <EditIcon className="h-4 w-4 shrink-0" />
                Edit
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:border-destructive/35 hover:bg-destructive/5 hover:text-destructive"
                onClick={() => onRemove(provider.id)}
                disabled={busy}
                aria-label="Remove provider"
                title="Remove provider"
              >
                <TrashIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {modelIds.length > 0 ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {modelIds.map((modelId) => (
                <SummaryChipButton
                  key={`${provider.id}-${modelId}`}
                  onClick={() => onCopyModelId?.(modelId)}
                  title={`Copy model id ${modelId}`}
                  className="max-w-full"
                >
                  <span className="truncate">{modelId}</span>
                </SummaryChipButton>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Modal
        open={editOpen}
        onClose={handleCloseEditModal}
        title={`Edit · ${provider.id}`}
        description={modelSaveState.phase === "testing"
          ? (modelSaveState.message || "Testing new models before save.")
          : modelSaveState.phase === "saving"
            ? (modelSaveState.message || "Saving provider changes.")
            : "Switch between provider settings and model list. Each tab saves independently."}
        closeDisabled={modalCloseLocked}
        closeOnBackdrop={!modalCloseLocked}
        closeOnEscape={!modalCloseLocked}
        contentClassName="max-h-[92vh] max-w-5xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
        bodyClassName="max-h-[calc(92vh-5.5rem)] pb-0"
      >
        <Tabs value={editTab} onValueChange={setEditTab}>
          <TabsList className="w-full justify-start">
            <TabsTrigger value="provider">Provider</TabsTrigger>
            <TabsTrigger value="models">Model list</TabsTrigger>
          </TabsList>

          <TabsContent forceMount value="provider" className={cn("space-y-4 pb-4", editTab !== "provider" ? "hidden" : null)}>
            <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Provider</div>
                  <div className="mt-1 text-sm text-muted-foreground">Update provider identity and connection settings here.</div>
                </div>
                <Badge variant="outline">{isSubscription ? "Subscription" : "API Key"}</Badge>
              </div>
            </div>

            <div className={cn("grid gap-3", isSubscription ? "md:grid-cols-2" : "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
              <Field label="Provider name" stacked>
                <Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} disabled={modalCloseLocked} />
              </Field>
              <Field label="Provider id" hint="Used in direct routes like provider/model" stacked>
                <Input value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: slugifyProviderId(event.target.value) }))} disabled={modalCloseLocked} />
              </Field>
            </div>

            {!isSubscription ? (
              <div className="space-y-3">
                <Field label="API key or env" hint="Use an env var like OPENAI_API_KEY or paste the direct key." stacked>
                  <CredentialInput
                    value={draft.credentialInput || ""}
                    onChange={(event) => setDraft((current) => ({ ...current, credentialInput: event.target.value }))}
                    disabled={modalCloseLocked}
                    placeholder="Example: OPENAI_API_KEY or sk-..."
                    isEnvVar={looksLikeEnvVarName(draft.credentialInput)}
                  />
                </Field>
                <div ref={endpointSectionRef}>
                  <Field
                    label="Endpoints"
                    hint={endpointCandidates.length > 1
                      ? "Comma, space, or newline turns into chips. The first endpoint stays active until you re-test this provider."
                      : "Comma, space, or newline turns into chips."}
                    stacked
                  >
                    <ChipInput
                      values={draft.endpoints}
                      onChange={(value) => setDraft((current) => ({ ...current, endpoints: value }))}
                      draftValue={draft.endpointDraft}
                      onDraftValueChange={(value) => setDraft((current) => ({ ...current, endpointDraft: value }))}
                      commitOnBlur
                      disabled={modalCloseLocked}
                      isValueValid={isLikelyHttpEndpoint}
                      inputRef={endpointInputRef}
                      inputClassName="placeholder:text-muted-foreground/55"
                      placeholder="Click here to type new endpoint"
                      helperText="Paste one or more endpoints"
                    />
                  </Field>
                </div>
                <div ref={rateLimitSectionRef} className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1fr)]">
                  <div className="md:col-span-2 xl:col-span-4">
                    <Field
                      label="Rate limit"
                      stacked
                      headerAction={(
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setDraft((current) => ({ ...current, rateLimitRows: appendRateLimitDraftRow(current.rateLimitRows) }))}
                          disabled={modalCloseLocked}
                        >
                          Add rate limit
                        </Button>
                      )}
                    >
                      <RateLimitBucketsEditor
                        rows={draft.rateLimitRows}
                        onChange={(value) => setDraft((current) => ({ ...current, rateLimitRows: value }))}
                        availableModelIds={modelIds}
                        disabled={modalCloseLocked}
                        inputRef={rateLimitInputRef}
                      />
                    </Field>
                  </div>
                </div>
              </div>
            ) : null}

            {issue ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{issue}</div> : null}

            <div className="flex min-h-9 items-center justify-end gap-2">
              {!modalCloseLocked && isDirty ? <Button type="button" variant="ghost" onClick={handleResetProviderDraft}>Reset</Button> : null}
              {isDirty && !issue ? (
                <Button type="button" onClick={() => void handleApplyClick()} disabled={modalCloseLocked}>
                  {modelSaveState.phase === "saving" || busy ? "Saving…" : "Save provider"}
                </Button>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent forceMount value="models" className={cn(editTab !== "models" ? "hidden" : null)}>
            <ProviderModelsEditor
              provider={provider}
              disabled={Boolean(disabledReason)}
              disabledReason={disabledReason}
              busy={busy}
              framed={false}
              focusRequest={modelFocusRequest}
              onStateChange={handleModelEditorStateChange}
              onApply={handleApplyModelsAndClose}
              testStateByModel={modelSaveState.modelStates}
              savePhase={modelSaveState.phase}
              saveMessage={modelSaveState.message}
            />
          </TabsContent>
        </Tabs>
      </Modal>

      <UnsavedChangesModal
        open={confirmCloseOpen}
        onKeepEditing={() => setConfirmCloseOpen(false)}
        onDiscardAndClose={finalizeCloseEditModal}
        onSaveAndClose={handleSaveAndCloseEditModal}
        saveDisabled={saveAndCloseDisabled}
        dirtyLabels={closeDirtyLabels}
        details={closeDetails}
      />

      <FailedModelsCloseModal
        open={failedCloseOpen}
        failedModelIds={activeFailedModelIds}
        onKeepEditing={() => setFailedCloseOpen(false)}
        onRemoveFailedAndClose={handleRemoveFailedModelsAndClose}
        removeDisabled={modalCloseLocked || typeof onSaveAndCloseEditor !== "function"}
      />
    </>
  );
}

function ProviderList({
  providers,
  onRemove,
  onCopyModelId,
  onApplyProviderDetails,
  onApplyProviderModels,
  onSaveAndCloseEditor,
  disabledReason = "",
  busy = false
}) {
  if (!providers.length) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 p-5 text-sm text-muted-foreground">
          <div>No enabled providers are configured yet. Use Add provider to create your first provider, model list, and rate limits.</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          onRemove={onRemove}
          onCopyModelId={onCopyModelId}
          onApplyProviderDetails={onApplyProviderDetails}
          onApplyProviderModels={onApplyProviderModels}
          onSaveAndCloseEditor={onSaveAndCloseEditor}
          disabledReason={disabledReason}
          busy={busy}
        />
      ))}
    </div>
  );
}

function ProviderModelsSection({
  providers,
  onAddProvider,
  onRemove,
  onCopyModelId,
  onApplyProviderDetails,
  onApplyProviderModels,
  onSaveAndCloseEditor,
  disabledReason = "",
  busy = false
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-card p-4" aria-label="Provider models">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Provider &amp; Models</div>
          <div className="mt-1 text-sm text-muted-foreground">Manage providers, direct model routes, endpoints, and rate limits in one place.</div>
        </div>
        <Button onClick={onAddProvider}>Add provider</Button>
      </div>
      <div className="mt-4">
        <ProviderList
          providers={providers}
          onRemove={onRemove}
          onCopyModelId={onCopyModelId}
          onApplyProviderDetails={onApplyProviderDetails}
          onApplyProviderModels={onApplyProviderModels}
          onSaveAndCloseEditor={onSaveAndCloseEditor}
          disabledReason={disabledReason}
          busy={busy}
        />
      </div>
    </section>
  );
}

const OLLAMA_KEEP_ALIVE_OPTIONS = [
  { value: "5m", label: "5 minutes" },
  { value: "10m", label: "10 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "-1", label: "Forever (blocks eviction)" },
  { value: "0", label: "Disabled (unload immediately)" }
];

function OllamaSettingsPanel({
  connected, snapshot, models, busy, refreshing, config,
  onRefresh, onLoad, onUnload, onPin, onKeepAlive, onContextLength,
  onAddToRouter, onRemoveFromRouter, onAutoLoad, onSaveSettings,
  onInstall, onStartServer, onStopServer, onSyncRouter
}) {
  const ollamaConfig = config?.ollama || {};
  const [settingsBaseUrl, setSettingsBaseUrl] = useState(ollamaConfig.baseUrl || "http://localhost:11434");
  const [settingsAutoConnect, setSettingsAutoConnect] = useState(ollamaConfig.autoConnect !== false);
  const [settingsDefaultKeepAlive, setSettingsDefaultKeepAlive] = useState(ollamaConfig.defaultKeepAlive || "5m");

  const isInstalled = snapshot?.installed === true;

  return (
    <div className="space-y-4">
      {/* Connection Section */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="font-medium">Ollama Connection</h3>
              {connected ? (
                <Badge variant="success">Connected</Badge>
              ) : (
                <Badge variant="outline">Disconnected</Badge>
              )}
            </div>
            <div className="flex gap-2">
              {!isInstalled && (
                <Button size="sm" onClick={onInstall} disabled={busy._install}>
                  {busy._install ? "Installing…" : "Install Ollama"}
                </Button>
              )}
              {isInstalled && !connected && (
                <Button size="sm" onClick={onStartServer} disabled={busy._startServer}>
                  {busy._startServer ? "Starting…" : "Start Server"}
                </Button>
              )}
              {connected && (
                <Button size="sm" variant="outline" onClick={onStopServer}>Stop Server</Button>
              )}
            </div>
          </div>
          {snapshot?.version && <p className="text-xs text-muted-foreground">Version: {snapshot.version}</p>}
        </CardContent>
      </Card>

      {/* Model List Section */}
      {connected && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Models</h3>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={onSyncRouter} disabled={busy._syncRouter}>
                  {busy._syncRouter ? "Syncing…" : "Sync All to Router"}
                </Button>
                <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
                  {refreshing ? "Refreshing…" : "Reload Models"}
                </Button>
              </div>
            </div>
            {models.length === 0 && !refreshing && (
              <p className="text-sm text-muted-foreground">No models found. Pull models with <code className="text-xs bg-muted px-1 py-0.5 rounded">ollama pull &lt;model&gt;</code></p>
            )}
            <div className="space-y-2">
              {models.map((model) => (
                <OllamaModelRow
                  key={model.name}
                  model={model}
                  busy={busy[model.name] || {}}
                  onLoad={onLoad}
                  onUnload={onUnload}
                  onPin={onPin}
                  onKeepAlive={onKeepAlive}
                  onContextLength={onContextLength}
                  onAddToRouter={onAddToRouter}
                  onRemoveFromRouter={onRemoveFromRouter}
                  onAutoLoad={onAutoLoad}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Settings Section */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-medium">Settings</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Base URL</label>
              <Input
                value={settingsBaseUrl}
                onChange={(e) => setSettingsBaseUrl(e.target.value)}
                placeholder="http://localhost:11434"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Default Keep Alive</label>
              <Select value={settingsDefaultKeepAlive} onValueChange={setSettingsDefaultKeepAlive}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OLLAMA_KEEP_ALIVE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm text-foreground">Auto-connect on startup</label>
            <Switch checked={settingsAutoConnect} onCheckedChange={setSettingsAutoConnect} />
          </div>
          <Button
            size="sm"
            onClick={() => onSaveSettings({ baseUrl: settingsBaseUrl, autoConnect: settingsAutoConnect, defaultKeepAlive: settingsDefaultKeepAlive })}
          >Save Settings</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function OllamaModelRow({ model, busy, onLoad, onUnload, onPin, onKeepAlive, onContextLength, onAddToRouter, onRemoveFromRouter, onAutoLoad }) {
  const [localContextLength, setLocalContextLength] = useState(model.contextLength || 0);

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm font-medium">{model.name}</span>
          <Badge variant="outline">{model.parameterSize || "?"}</Badge>
          <Badge variant="outline">{model.quantizationLevel || "?"}</Badge>
          {model.loaded ? (
            <Badge variant="success">Loaded{model.sizeVramFormatted ? ` (${model.sizeVramFormatted})` : ""}</Badge>
          ) : (
            <Badge variant="default">Available</Badge>
          )}
          {model.isPinned && <Badge variant="warning">Pinned</Badge>}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {!model.loaded ? (
            <Button size="sm" variant="outline" onClick={() => onLoad(model.name)} disabled={busy.loading}>
              {busy.loading ? "Loading…" : "Load"}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => onUnload(model.name)} disabled={busy.unloading}>
              {busy.unloading ? "Unloading…" : "Unload"}
            </Button>
          )}
          <Button
            size="sm"
            variant={model.isPinned ? "default" : "outline"}
            onClick={() => onPin(model.name, !model.isPinned)}
            disabled={busy.pinning}
            title={model.isPinned ? "Unpin (allow auto-unload)" : "Pin in memory (blocks eviction)"}
          >
            {model.isPinned ? "Unpin" : "Pin"}
          </Button>
          {model.inRouter ? (
            <Button size="sm" variant="outline" onClick={() => onRemoveFromRouter(model.name)} className="text-red-600 hover:text-red-700">Remove from Router</Button>
          ) : (
            <Button size="sm" variant="default" onClick={() => onAddToRouter(model.name)}>Add to Router</Button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4 flex-wrap text-xs">
        <div className="flex items-center gap-1.5">
          <label className="text-muted-foreground whitespace-nowrap">Keep Alive:</label>
          <Select value={model.keepAlive || "5m"} onValueChange={(v) => onKeepAlive(model.name, v)}>
            <SelectTrigger className="h-7 w-[160px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {OLLAMA_KEEP_ALIVE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-muted-foreground whitespace-nowrap">Context:</label>
          <Input
            type="number"
            className="h-7 w-24 text-xs"
            value={localContextLength}
            onChange={(e) => setLocalContextLength(Number(e.target.value))}
            onBlur={() => { if (localContextLength !== model.contextLength) onContextLength(model.name, localContextLength); }}
            min={0}
            step={1024}
          />
          {model.contextLength > 0 && <span className="text-muted-foreground">max: {model.contextLength.toLocaleString()}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={model.autoLoad}
            onCheckedChange={(checked) => onAutoLoad(model.name, checked)}
          />
          <label className="text-muted-foreground">Auto-load on start</label>
        </div>
        {model.estimatedVram && <span className="text-muted-foreground">Est. VRAM: {model.estimatedVram}</span>}
      </div>
    </div>
  );
}

function AmpSettingsPanel({
  rows,
  routeOptions,
  webSearchSnapshot,
  ampClientUrl,
  ampClientGlobal,
  routingBusy,
  onToggleGlobalRouting,
  onInboundChange,
  onOutboundChange,
  onCreateEntry,
  onRemoveEntry,
  onOpenWebSearchTab,
  onOpenConfigPath,
  onOpenSecretsPath,
  hasMasterKey,
  disabledReason,
  autosaveState
}) {
  const [addingEntry, setAddingEntry] = useState(false);
  const [newInbound, setNewInbound] = useState("");
  const [newOutbound, setNewOutbound] = useState(String(routeOptions[0]?.value || "").trim());
  const hasNewInboundDuplicate = rows.some((row) => String(row?.inbound || "").trim() === String(newInbound || "").trim() && String(newInbound || "").trim());
  const canCreateEntry = String(newInbound || "").trim() && String(newOutbound || "").trim() && !hasNewInboundDuplicate;
  const globalRoutingEnabled = ampClientGlobal?.routedViaRouter === true;
  const globalRoutingError = String(ampClientGlobal?.error || "").trim();
  const canEnableGlobalRouting = Boolean(hasMasterKey && ampClientUrl && !disabledReason && !globalRoutingError);
  const configuredSearchProviderCount = Number(webSearchSnapshot?.configuredProviderCount) || 0;
  const showWebSearchWarning = globalRoutingEnabled && configuredSearchProviderCount === 0;

  const statusVariant = disabledReason
    ? "warning"
    : autosaveState.status === "error"
      ? "danger"
      : autosaveState.status === "pending"
        ? "outline"
      : autosaveState.status === "saving"
        ? "info"
        : autosaveState.savedAt
          ? "success"
          : "outline";

  const statusLabel = disabledReason
    ? "Needs review"
    : autosaveState.status === "error"
      ? "Save failed"
        : autosaveState.status === "pending"
          ? "Unsaved"
        : autosaveState.status === "saving"
          ? "saving..."
        : autosaveState.savedAt
          ? "Saved"
          : "Ready";

  const statusMessage = disabledReason
    ? disabledReason
    : autosaveState.status === "error"
      ? autosaveState.message
      : autosaveState.status === "pending"
        ? "Unsaved changes queued. Auto-save will run shortly."
      : autosaveState.status === "saving"
        ? "Saving changes..."
      : autosaveState.savedAt
        ? `Last saved ${formatTime(autosaveState.savedAt)}.`
        : "AMP route changes auto-save after valid edits.";

  async function handleSubmitNewEntry() {
    if (!canCreateEntry) return;
    const result = await onCreateEntry?.({ inbound: newInbound, outbound: newOutbound });
    if (result === false) return;
    setAddingEntry(false);
    setNewInbound("");
    setNewOutbound(String(routeOptions[0]?.value || "").trim());
  }

  function handleOpenAddEntry() {
    setAddingEntry(true);
    setNewInbound("");
    setNewOutbound(String(routeOptions[0]?.value || "").trim());
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 p-4 pb-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <CardTitle className="flex items-center gap-2">
              <span>Use AMP via LLM Router</span>
            </CardTitle>
            <ConnectionStatusChipRow
              primaryLabel="Config file"
              primaryValue={ampClientGlobal?.settingsFilePath || ""}
              onOpenPrimary={onOpenConfigPath}
              secondaryLabel="Secrets file"
              secondaryValue={ampClientGlobal?.secretsFilePath || ""}
              secondaryIcon={<SecretFileIcon className="h-3 w-3" />}
              onOpenSecondary={onOpenSecretsPath}
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={globalRoutingEnabled ? "outline" : undefined}
              onClick={onToggleGlobalRouting}
              disabled={routingBusy !== "" || (!globalRoutingEnabled && !canEnableGlobalRouting)}
            >
              {routingBusy === "enable"
                ? "Connecting…"
                : routingBusy === "disable"
                  ? "Disconnecting…"
                  : globalRoutingEnabled
                    ? "Disconnect"
                    : "Connect"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-4">
          {globalRoutingError ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{globalRoutingError}</div>
          ) : null}
        {!globalRoutingEnabled && !hasMasterKey ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Set <code>masterKey</code> first to connect AMP.
          </div>
        ) : null}

        {showWebSearchWarning ? (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="max-w-3xl">
              AMP is connected, but no alternative web search provider is configured. AMP web search is only available through the shared Web Search tab.
            </div>
            <Button type="button" size="sm" variant="outline" onClick={onOpenWebSearchTab}>
              Open Web Search
            </Button>
          </div>
        ) : null}

        {disabledReason ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{disabledReason}</div>
        ) : (
            <div className="space-y-3 rounded-2xl border border-border/70 bg-background/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-foreground">Route mapping editor</div>
                  <div className="mt-1 text-xs text-muted-foreground">Map built-in AMP route keys and wildcard model matches to managed routes.</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={statusVariant}>{statusLabel}</Badge>
                  <Badge variant="outline">{rows.length} routes</Badge>
                  <Button type="button" size="sm" onClick={handleOpenAddEntry}>Add custom mapping</Button>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">{statusMessage}</div>

              {addingEntry ? (
                <div className="rounded-2xl border border-dashed border-border bg-background/80 p-3">
                  <div className="grid gap-3 xl:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-medium text-foreground">Add custom mapping</div>
                        <Badge variant="info">Custom</Badge>
                      </div>
                      <div className="text-xs leading-5 text-muted-foreground">Match a built-in AMP route key like <code>smart</code> or a wildcard such as <code>gpt-*-codex*</code>, then send it to any managed route.</div>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" size="sm" onClick={handleSubmitNewEntry} disabled={!canCreateEntry}>Create mapping</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setAddingEntry(false)}>Close</Button>
                      </div>
                    </div>

                    <Field label="Inbound match" hint="Built-in route key or AMP model pattern">
                      <Input
                        value={newInbound}
                        onChange={(event) => setNewInbound(event.target.value)}
                        placeholder="smart or gpt-*-codex*"
                      />
                    </Field>

                    <Field label="Route target" hint="Alias or provider/model route in LLM Router">
                      <Select value={newOutbound || undefined} onValueChange={setNewOutbound}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select local route" />
                        </SelectTrigger>
                        <SelectContent>
                          {renderSelectOptionNodes(routeOptions, {
                            keyPrefix: "amp-route-create",
                            includeHint: true
                          })}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                {rows.map((row) => (
                  <div key={row.id} className="rounded-2xl border border-border/70 bg-background/75 p-3">
                    <div className="grid gap-3 xl:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-medium text-foreground">{row.label}</div>
                          {row.isCustom ? <Badge variant="info">Custom</Badge> : null}
                        </div>
                        <div className="text-xs leading-5 text-muted-foreground">{row.description}</div>
                        {row.removable ? <Button type="button" size="sm" variant="ghost" onClick={() => onRemoveEntry(row.id)}>Remove</Button> : null}
                      </div>

                      <Field label="Inbound wildcard" hint={row.defaultMatch ? `Default: ${row.defaultMatch}` : "AMP model pattern"}>
                        <BufferedTextInput
                          commitOnBlur
                          value={row.inbound}
                          onValueCommit={(value) => onInboundChange(row.id, value)}
                          placeholder={row.defaultMatch || "gpt-*-codex*"}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            event.currentTarget.blur();
                          }}
                        />
                      </Field>

                      <Field label="Target route" hint="Alias or provider/model route">
                        <Select value={row.outbound || "__default__"} onValueChange={(value) => onOutboundChange(row.id, value)}>
                          <SelectTrigger>
                            <SelectValue placeholder={row.removable ? "Choose target route" : "Use default route"} />
                          </SelectTrigger>
                          <SelectContent>
                            {!row.removable ? <SelectItem value="__default__">Use default route</SelectItem> : null}
                            {renderSelectOptionNodes(routeOptions, {
                              keyPrefix: `amp-route-${row.id}`,
                              includeHint: true
                            })}
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HostedWebSearchEndpointModal({
  open = false,
  onClose = () => {},
  candidates = [],
  onTestAndAdd = async () => {},
  disabledReason = ""
}) {
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState("");
  const providerOptions = Array.isArray(candidates) ? candidates : [];
  const selectedProvider = providerOptions.find((provider) => provider.providerId === selectedProviderId) || providerOptions[0] || null;
  const modelOptions = Array.isArray(selectedProvider?.models) ? selectedProvider.models : [];

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setIssue("");
      return;
    }

    const defaultProviderId = providerOptions[0]?.providerId || "";
    setSelectedProviderId((current) => {
      const currentExists = providerOptions.some((provider) => provider.providerId === current);
      return currentExists ? current : defaultProviderId;
    });
  }, [open, providerOptions]);

  useEffect(() => {
    const nextModelId = modelOptions[0]?.value || "";
    setSelectedModelId((current) => {
      const currentExists = modelOptions.some((model) => model.value === current);
      return currentExists ? current : nextModelId;
    });
  }, [modelOptions]);

  const routeId = buildHostedWebSearchProviderId(selectedProviderId, selectedModelId);
  const canSubmit = open && !busy && !disabledReason && selectedProviderId && selectedModelId;

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setIssue("");
    try {
      await onTestAndAdd({
        providerId: selectedProviderId,
        modelId: selectedModelId
      });
      onClose();
    } catch (error) {
      setIssue(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      title="Add ChatGPT Search Endpoint"
      description="Choose a configured OpenAI-compatible GPT route. Test runs a live Responses API request with the native web search tool, then saves the route on success."
      contentClassName="max-h-[92vh] max-w-3xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
      showCloseButton={false}
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {busy ? "Testing…" : "Test connection"}
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        {disabledReason ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {disabledReason}
          </div>
        ) : null}

        {!disabledReason && providerOptions.length === 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            No configured OpenAI-compatible GPT providers are available yet. Add a provider with a GPT model first.
          </div>
        ) : null}

        {providerOptions.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Provider" hint="Configured provider or ChatGPT subscription" stacked>
              <Select value={selectedProviderId || undefined} onValueChange={setSelectedProviderId} disabled={busy || Boolean(disabledReason)}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose provider" />
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((provider) => (
                    <SelectItem key={provider.providerId} value={provider.providerId}>
                      {provider.providerLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="GPT model" hint="Only GPT models on OpenAI-compatible routes are listed" stacked>
              <Select value={selectedModelId || undefined} onValueChange={setSelectedModelId} disabled={busy || Boolean(disabledReason) || modelOptions.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose model" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((model) => (
                    <SelectItem key={model.routeId} value={model.value}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        ) : null}

        {routeId ? (
          <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Saved route id</div>
            <div className="mt-1 text-sm font-medium text-foreground">{routeId}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">This route stores only the provider/model reference. No separate API key or quota is saved here.</div>
          </div>
        ) : null}

        {issue ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {issue}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function WebSearchSettingsPanel({
  webSearchConfig,
  webSearchProviders,
  hostedSearchCandidates,
  onWebSearchStrategyChange,
  onWebSearchProviderChange,
  onWebSearchProviderMove,
  onRemoveWebSearchProvider,
  onAddHostedSearchEndpoint,
  disabledReason,
  autosaveState
}) {
  const [hostedSearchModalOpen, setHostedSearchModalOpen] = useState(false);
  const searchStrategy = String(webSearchConfig?.strategy || "ordered").trim() === "quota-balance" ? "quota-balance" : "ordered";
  const canAddHostedSearchEndpoint = Array.isArray(hostedSearchCandidates) && hostedSearchCandidates.some((provider) => Array.isArray(provider?.models) && provider.models.length > 0);
  const statusMessage = disabledReason
    ? disabledReason
    : autosaveState.status === "error"
      ? autosaveState.message
      : autosaveState.status === "pending"
        ? "Unsaved changes queued. Auto-save will run shortly."
      : autosaveState.status === "saving"
        ? "Saving changes..."
      : autosaveState.savedAt
        ? `Last saved ${formatTime(autosaveState.savedAt)}.`
        : "";

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-4 p-4 pb-0 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-1">
            <CardTitle>Web Search</CardTitle>
            <CardDescription className="text-xs leading-5">
              Shared web search routing for AMP and other router-managed tools.
            </CardDescription>
            {statusMessage ? <div className="text-xs text-muted-foreground">{statusMessage}</div> : null}
          </div>

          <div className="flex w-full shrink-0 flex-wrap items-end justify-end gap-3 xl:w-auto">
            <div className="min-w-[12rem] space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Routing strategy</div>
              <Select value={searchStrategy} onValueChange={onWebSearchStrategyChange} disabled={Boolean(disabledReason)}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose strategy" />
                </SelectTrigger>
                <SelectContent>
                  {AMP_WEB_SEARCH_STRATEGY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => setHostedSearchModalOpen(true)}
              disabled={Boolean(disabledReason) || !canAddHostedSearchEndpoint}
            >
              <PlusIcon className="h-3.5 w-3.5" />
              <span>Endpoint</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-4">
          <div className="space-y-3">
            {(webSearchProviders || []).map((provider) => {
              if (provider.kind === "hosted") {
                const runtimeIssue = provider.runtimeState && provider.runtimeState.ready === false
                  ? "This provider/model route is no longer available or is not OpenAI-compatible."
                  : "";
                return (
                  <div key={provider.key} className="rounded-2xl border border-border/70 bg-background/80 p-4">
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <ProviderStatusDot active={provider.active} />
                            <div className="text-sm font-medium text-foreground">{provider.label}</div>
                            <Badge variant="outline">GPT Search</Badge>
                          </div>
                          <div className="mt-1 text-xs break-all text-muted-foreground">{provider.routeId}</div>
                          <div className="mt-2 text-xs leading-5 text-muted-foreground">Uses the provider&apos;s native OpenAI Responses web search tool. No local API key or quota is stored here.</div>
                        </div>
                        <div className="flex items-center gap-2 self-start">
                          <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/70 p-1">
                            <MoveUpButton
                              disabled={Boolean(disabledReason) || provider.displayIndex <= 0}
                              label={`Move ${provider.routeId} up`}
                              onClick={() => onWebSearchProviderMove(provider.id, "up")}
                            />
                            <MoveDownButton
                              disabled={Boolean(disabledReason) || provider.displayIndex >= provider.displayCount - 1}
                              label={`Move ${provider.routeId} down`}
                              onClick={() => onWebSearchProviderMove(provider.id, "down")}
                            />
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => onRemoveWebSearchProvider(provider.id)}
                            disabled={Boolean(disabledReason)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>

                      {runtimeIssue ? (
                        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                          {runtimeIssue}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              }

              const credentialField = provider.credentialField;
              const credentialValue = String(provider?.credentialValue || "").trim();
              return (
                <div key={provider.key} className="rounded-2xl border border-border/70 bg-background/80 p-4">
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <ProviderStatusDot active={provider.active} />
                          <div className="text-sm font-medium text-foreground">{provider.label}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-start rounded-xl border border-border/70 bg-background/70 p-1">
                        <MoveUpButton
                          disabled={Boolean(disabledReason) || provider.displayIndex <= 0}
                          label={`Move ${provider.label} up`}
                          onClick={() => onWebSearchProviderMove(provider.id, "up")}
                        />
                        <MoveDownButton
                          disabled={Boolean(disabledReason) || provider.displayIndex >= provider.displayCount - 1}
                          label={`Move ${provider.label} down`}
                          onClick={() => onWebSearchProviderMove(provider.id, "down")}
                        />
                      </div>
                    </div>

                    <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.35fr)]">
                      <Field
                        label={provider.credentialLabel}
                        hint={provider.credentialField === "url" ? "Required to enable this backend." : "Required to enable this backend. Stored in router config."}
                        stacked
                        className="gap-1"
                        headerClassName="min-h-0"
                        hintClassName="leading-4"
                      >
                        <CredentialInput
                          buffered
                          value={credentialValue}
                          placeholder={provider.credentialPlaceholder}
                          onValueChange={(value) => onWebSearchProviderChange(provider.id, credentialField, value)}
                          disabled={Boolean(disabledReason)}
                          isEnvVar={provider.credentialField === "url"}
                        />
                      </Field>

                      <div className="grid gap-3 sm:grid-cols-3">
                        <Field
                          label="Result per call"
                          hint="Empty keeps the default of 5."
                          stacked
                          className="gap-1"
                          headerClassName="min-h-0"
                          hintClassName="leading-4"
                        >
                          <TransientIntegerInput
                            value={provider.resultPerCallInput}
                            placeholder="Default: 5"
                            allowEmptyCommit
                            onValueChange={(value) => onWebSearchProviderChange(provider.id, "count", value)}
                            disabled={Boolean(disabledReason)}
                          />
                        </Field>

                        <Field
                          label="Monthly limit"
                          hint="0 keeps quotas self-managed."
                          stacked
                          className="gap-1"
                          headerClassName="min-h-0"
                          hintClassName="leading-4"
                        >
                          <TransientIntegerInput
                            value={String(provider.limit || 0)}
                            onValueChange={(value) => onWebSearchProviderChange(provider.id, "limit", value)}
                            disabled={Boolean(disabledReason)}
                          />
                        </Field>

                        <Field
                          label="Synced remaining"
                          hint="Adjust after manual upstream sync."
                          stacked
                          className="gap-1"
                          headerClassName="min-h-0"
                          hintClassName="leading-4"
                        >
                          <TransientIntegerInput
                            value={String(provider.remaining || 0)}
                            onValueChange={(value) => onWebSearchProviderChange(provider.id, "remaining", value)}
                            disabled={Boolean(disabledReason)}
                          />
                        </Field>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <HostedWebSearchEndpointModal
        open={hostedSearchModalOpen}
        onClose={() => setHostedSearchModalOpen(false)}
        candidates={hostedSearchCandidates}
        onTestAndAdd={onAddHostedSearchEndpoint}
        disabledReason={disabledReason}
      />
    </>
  );
}

function CodingToolSettingsPanel({
  toolName,
  toolState,
  endpointUrl,
  routeOptions,
  connectionBusy,
  bindingBusy,
  onToggleRouting,
  onBindingChange,
  hasMasterKey,
  disabledReason,
  onOpenPrimaryPath,
  onOpenSecondaryPath,
  secondaryPathLabel = "Backup file",
  secondaryPathIcon = <BackupFileIcon className="h-3 w-3" />,
  bindingFields = [],
  guideContent = null
}) {
  const routingEnabled = toolState?.routedViaRouter === true;
  const routingError = String(toolState?.error || "").trim();
  const canEnableRouting = Boolean(hasMasterKey && endpointUrl && !disabledReason && !routingError);
  const currentManagedBindingValues = useMemo(() => {
    const reservedValues = new Set(["__unset__"]);
    for (const field of bindingFields) {
      for (const option of (Array.isArray(field?.extraOptions) ? field.extraOptions : [])) {
        const value = String(option?.value || "").trim();
        if (value) reservedValues.add(value);
      }
      for (const option of (Array.isArray(field?.options) ? field.options : [])) {
        const value = String(option?.value || "").trim();
        if (value) reservedValues.add(value);
      }
    }

    return bindingFields
      .filter((field) => field?.usesRouteOptions !== false)
      .map((field) => String(field?.value || "").trim())
      .filter((value) => value && !reservedValues.has(value));
  }, [bindingFields]);
  const resolvedRouteOptions = withCurrentManagedRouteOptions(
    routeOptions,
    currentManagedBindingValues
  );

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 p-4 pb-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <CardTitle className="flex items-center gap-2">
            <span>{`Use ${toolName} via LLM Router`}</span>
          </CardTitle>
          <ConnectionStatusChipRow
            primaryLabel="Config file"
            primaryValue={toolState?.configFilePath || toolState?.settingsFilePath || ""}
            onOpenPrimary={onOpenPrimaryPath}
            secondaryLabel={secondaryPathLabel}
            secondaryValue={toolState?.backupFilePath || ""}
            secondaryIcon={secondaryPathIcon}
            onOpenSecondary={onOpenSecondaryPath}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {guideContent ? <PanelGuideButton guideContent={guideContent} /> : null}
          <Button
            type="button"
            size="sm"
            variant={routingEnabled ? "outline" : undefined}
            onClick={onToggleRouting}
            disabled={connectionBusy !== "" || (!routingEnabled && !canEnableRouting)}
          >
            {connectionBusy === "enable"
              ? "Connecting…"
              : connectionBusy === "disable"
                ? "Disconnecting…"
                : routingEnabled
                  ? "Disconnect"
                  : "Connect"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {routingError ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{routingError}</div>
        ) : null}
        {!routingEnabled && !hasMasterKey ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Set <code>masterKey</code> first to connect {toolName}.
          </div>
        ) : null}
        {disabledReason ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{disabledReason}</div>
        ) : null}

        <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
          <div>
            <div>
              <div className="text-sm font-medium text-foreground">Model bindings</div>
              <div className="mt-1 text-xs text-muted-foreground">Prefer LLM Router aliases here so you can retarget models later from the Alias &amp; Fallback tab.</div>
            </div>
          </div>

          {bindingFields.length === 0 ? (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              No tool bindings are available yet.
            </div>
          ) : (
            <div className="mt-4 grid gap-3">
              {bindingFields.map((field) => {
                return (
                  <div key={field.id} className="rounded-xl border border-border/70 bg-background/80 p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm font-medium text-foreground">{field.label}</div>
                      <Badge variant="outline">{field.envKey}</Badge>
                    </div>
                    <div className="mb-3 text-xs leading-5 text-muted-foreground">{field.description}</div>
                    <BindingValueSelect
                      field={field}
                      routeOptions={resolvedRouteOptions}
                      disabled={field.standaloneWhenDisconnected ? bindingBusy : (!routingEnabled || bindingBusy)}
                      onValueChange={(value) => onBindingChange(field.id, value === "__unset__" ? "" : value)}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function getGuideCalloutClasses(variant = "outline") {
  switch (variant) {
    case "success":
      return "border-emerald-200 bg-emerald-50";
    case "warning":
      return "border-amber-200 bg-amber-50";
    case "danger":
      return "border-rose-200 bg-rose-50";
    case "info":
      return "border-sky-200 bg-sky-50";
    default:
      return "border-border/70 bg-background/70";
  }
}

function getGuideCalloutTextClasses(variant = "outline") {
  switch (variant) {
    case "success":
      return "text-emerald-950";
    case "warning":
      return "text-amber-950";
    case "danger":
      return "text-rose-950";
    case "info":
      return "text-sky-950";
    default:
      return "text-foreground";
  }
}

function PanelGuideButton({
  guideContent
}) {
  const [open, setOpen] = useState(false);
  const title = String(guideContent?.title || "").trim() || "Guide";
  const description = String(guideContent?.description || "").trim();
  const badges = Array.isArray(guideContent?.badges)
    ? guideContent.badges.filter(Boolean)
    : [];
  const highlights = Array.isArray(guideContent?.highlights)
    ? guideContent.highlights.filter(Boolean)
    : [];
  const sections = Array.isArray(guideContent?.sections)
    ? guideContent.sections.filter(Boolean)
    : [];
  const callout = guideContent?.callout && guideContent.callout.body
    ? guideContent.callout
    : null;
  const calloutVariant = callout?.variant || "outline";

  if (highlights.length === 0 && sections.length === 0 && !callout) return null;

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={title}
        onClick={() => setOpen(true)}
      >
        Guide
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={description}
        contentClassName="max-h-[92vh] max-w-4xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
        bodyClassName="max-h-[calc(92vh-5.5rem)]"
      >
        <div className="space-y-4">
          {badges.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {badges.map((badge, index) => (
                <Badge
                  key={`${title}-badge-${index}`}
                  variant={badge?.variant || "outline"}
                >
                  {badge?.label}
                </Badge>
              ))}
            </div>
          ) : null}

          {callout ? (
            <div className={cn("rounded-2xl border p-4", getGuideCalloutClasses(calloutVariant))}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={["success", "warning", "danger", "info"].includes(calloutVariant) ? calloutVariant : "outline"}>
                  {calloutVariant === "success"
                    ? "Current best fit"
                    : calloutVariant === "warning"
                      ? "Needs attention"
                      : calloutVariant === "info"
                        ? "Current behavior"
                        : "Guide note"}
                </Badge>
                <div className={cn("text-sm font-medium", getGuideCalloutTextClasses(calloutVariant))}>
                  {callout.title}
                </div>
              </div>
              <div className={cn("mt-3 text-sm leading-6", getGuideCalloutTextClasses(calloutVariant))}>
                {callout.body}
              </div>
            </div>
          ) : null}

          {highlights.length > 0 ? (
            <div className={cn("grid gap-4", highlights.length > 2 ? "md:grid-cols-3" : "md:grid-cols-2")}>
              {highlights.map((entry, index) => (
                <div key={`${title}-highlight-${index}`} className="rounded-2xl border border-border/70 bg-background/70 p-4">
                  {entry?.eyebrow ? (
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{entry.eyebrow}</div>
                  ) : null}
                  <div className="mt-2 text-sm font-medium text-foreground">{entry?.title}</div>
                  <div className="mt-2 text-sm leading-6 text-muted-foreground">{entry?.body}</div>
                </div>
              ))}
            </div>
          ) : null}

          {sections.map((section, sectionIndex) => {
            const items = Array.isArray(section?.items) ? section.items.filter(Boolean) : [];
            return (
              <div key={`${title}-section-${sectionIndex}`} className="rounded-2xl border border-border/70 bg-background/70 p-4">
                <div className="text-sm font-medium text-foreground">{section?.title}</div>
                {section?.description ? (
                  <div className="mt-2 text-sm leading-6 text-muted-foreground">{section.description}</div>
                ) : null}
                {items.length > 0 ? (
                  <div className="mt-3 space-y-3">
                    {items.map((item, itemIndex) => (
                      <div key={`${title}-section-${sectionIndex}-item-${itemIndex}`} className="flex gap-3 text-sm leading-6 text-foreground">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/50" />
                        <div className="min-w-0">{item}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Modal>
    </>
  );
}

function BindingValueSelect({
  field,
  routeOptions,
  disabled = false,
  onValueChange
}) {
  const selectValue = String(field?.value || "").trim() || (field?.allowUnset ? "__unset__" : "");
  const selectOptions = useMemo(() => {
    const routeDrivenOptions = field?.usesRouteOptions === false ? [] : routeOptions;
    const explicitOptions = Array.isArray(field?.options) ? field.options : [];
    const extraOptions = Array.isArray(field?.extraOptions) ? field.extraOptions : [];
    return field?.allowUnset
      ? [{ value: "__unset__", label: "Inherit tool default", hint: "" }, ...extraOptions, ...explicitOptions, ...routeDrivenOptions]
      : [...extraOptions, ...explicitOptions, ...routeDrivenOptions];
  }, [field?.allowUnset, field?.extraOptions, field?.options, field?.usesRouteOptions, routeOptions]);

  return (
    <Select value={selectValue} onValueChange={onValueChange} disabled={disabled || selectOptions.length === 0}>
      <SelectTrigger>
        <SelectValue placeholder={field.placeholder || "Select a route"} />
      </SelectTrigger>
      <SelectContent>
        {selectOptions.length > 0 ? renderSelectOptionNodes(selectOptions, {
          keyPrefix: field.id || "binding-option"
        }) : (
          <SelectItem value="__no-route-options" disabled>No routes available</SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

function LogList({
  logs,
  activityLogEnabled = true,
  activityFilter = "usage",
  busyAction = "",
  onActivityFilterChange,
  onToggleEnabled,
  onClear
}) {
  const normalizedLogs = Array.isArray(logs) ? logs : [];
  const filteredLogs = normalizedLogs.filter((entry) => activityFilter === "all"
    ? true
    : getActivityEntryCategory(entry) === activityFilter);
  const activeCategoryMeta = ACTIVITY_CATEGORY_META[activityFilter] || ACTIVITY_CATEGORY_META.usage;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Activity</CardTitle>
            <CardDescription>
              {activityLogEnabled
                ? "Router actions, request fallbacks, and runtime issues stream here."
                : "Activity logging is paused. Re-enable it to capture router actions, request fallbacks, and runtime issues."}
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="min-w-[13rem]">
              <Select value={activityFilter} onValueChange={onActivityFilterChange} searchEnabled={false}>
                <SelectTrigger>
                  <SelectValue placeholder="Filter category" />
                </SelectTrigger>
                <SelectContent>
                  {ACTIVITY_FILTER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={onClear} disabled={busyAction !== "" || !logs?.length}>
              {busyAction === "clear" ? "Clearing…" : "Clear log"}
            </Button>
            <Button type="button" size="sm" variant={activityLogEnabled ? "outline" : "default"} onClick={onToggleEnabled} disabled={busyAction !== ""}>
              {busyAction === "toggle"
                ? "Updating…"
                : (activityLogEnabled ? "Disable log" : "Enable log")}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="max-h-[32rem] space-y-3 overflow-auto pr-1">
          {filteredLogs.length ? filteredLogs.map((entry) => {
            const category = getActivityEntryCategory(entry);
            const categoryMeta = ACTIVITY_CATEGORY_META[category] || ACTIVITY_CATEGORY_META.usage;
            return (
            <div key={entry.id} className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className={cn("inline-flex h-2.5 w-2.5 rounded-full ring-4", LOG_LEVEL_STYLES[entry.level] || LOG_LEVEL_STYLES.info)} />
                  <Badge variant={categoryMeta.badgeVariant}>{categoryMeta.label}</Badge>
                  <span className="text-sm font-medium text-foreground">{entry.message}</span>
                </div>
                <span className="text-xs text-muted-foreground">{formatTime(entry.time)}</span>
              </div>
              {entry.detail ? <div className="mt-2 text-sm leading-6 text-muted-foreground">{entry.detail}</div> : null}
            </div>
            );
          }) : normalizedLogs.length ? (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              No {activeCategoryMeta.emptyLabel} activity matches the current filter. Switch the dropdown to inspect the hidden categories.
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              Activity is quiet. Save config changes or start the router to populate this stream.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ChipInput({
  values,
  onChange,
  placeholder,
  helperText,
  inputRef = null,
  inputClassName = "",
  suggestedValues = [],
  valueStates = {},
  draftValue = "",
  onDraftValueChange = () => {},
  commitOnBlur = false,
  disabled = false,
  isValueValid = (value) => Boolean(String(value || "").trim())
}) {
  const normalizedValues = useMemo(() => normalizeUniqueTrimmedValues(values), [values]);
  const [editingValue, setEditingValue] = useState("");
  const [editingDraft, setEditingDraft] = useState("");

  function commit(rawValue = draftValue, { clearDraft = true } = {}) {
    if (disabled) return false;
    const nextValues = splitListValues(rawValue).filter((value) => isValueValid(value));
    if (nextValues.length === 0) {
      if (clearDraft) onDraftValueChange("");
      return false;
    }

    const merged = Array.from(new Set([...(normalizedValues || []), ...nextValues]));
    if (JSON.stringify(merged) !== JSON.stringify(normalizedValues || [])) {
      onChange(merged);
    }
    if (clearDraft) onDraftValueChange("");
    return true;
  }

  function removeChip(value) {
    if (disabled) return;
    onChange(normalizedValues.filter((entry) => entry !== value));
    if (editingValue === value) {
      setEditingValue("");
      setEditingDraft("");
    }
  }

  function handleUseSuggestedValues() {
    if (disabled) return;
    if (!suggestedValues.length) return;
    onChange(Array.from(new Set([...(normalizedValues || []), ...suggestedValues])));
    onDraftValueChange("");
  }

  function startEditing(value) {
    if (disabled) return;
    setEditingValue(value);
    setEditingDraft(value);
  }

  function commitEditedValue(rawValue = editingDraft) {
    if (disabled) {
      setEditingValue("");
      setEditingDraft("");
      return false;
    }
    if (!editingValue) return false;
    const replacementValues = splitListValues(rawValue).filter((value) => isValueValid(value));
    const nextValues = [];
    let replaced = false;
    for (const value of normalizedValues || []) {
      if (value !== editingValue) {
        nextValues.push(value);
        continue;
      }
      if (!replaced) {
        nextValues.push(...replacementValues);
        replaced = true;
      }
    }
    const deduped = Array.from(new Set(nextValues.map((value) => String(value || "").trim()).filter(Boolean)));
    if (JSON.stringify(deduped) !== JSON.stringify(normalizedValues || [])) {
      onChange(deduped);
    }
    setEditingValue("");
    setEditingDraft("");
    return replacementValues.length > 0;
  }

  useEffect(() => {
    if (!disabled || !editingValue) return;
    setEditingValue("");
    setEditingDraft("");
  }, [disabled, editingValue]);

  return (
    <div className="space-y-2">
      <div className={cn(
        "flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-input bg-background/80 px-3 py-2",
        disabled ? "opacity-80" : null
      )}>
        {normalizedValues.map((value) => {
          const state = valueStates?.[value] || "default";
          const chipClassName = state === "success"
            ? "border-emerald-200 bg-emerald-50 text-emerald-900"
            : state === "error"
              ? "border-rose-200 bg-rose-50 text-rose-900"
              : state === "pending"
                ? "border-sky-200 bg-sky-50 text-sky-900"
                : "border-border bg-secondary text-foreground";
          const isEditing = !disabled && editingValue === value;
          return (
            <span key={value} className={cn("inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs", chipClassName)}>
              {isEditing ? (
                <input
                  autoFocus
                  className="min-w-[7rem] bg-transparent text-xs text-foreground outline-none"
                  value={editingDraft}
                  onChange={(event) => setEditingDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      commitEditedValue();
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingValue("");
                      setEditingDraft("");
                    }
                  }}
                  onBlur={() => {
                    commitEditedValue();
                  }}
                />
              ) : (
                <button
                  className="max-w-[16rem] truncate text-left transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70"
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => startEditing(value)}
                  disabled={disabled}
                  title="Click to edit"
                >
                  {value}
                </button>
              )}
              <button
                className="text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => removeChip(value)}
                disabled={disabled}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          className={cn(
            "min-w-[10rem] flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70",
            inputClassName
          )}
          value={draftValue}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            if (/[\s,]/.test(value)) {
              const parts = value.split(/[\s,]+/);
              const trailing = parts.pop() || "";
              if (parts.length > 0) commit(parts.join(","), { clearDraft: false });
              onDraftValueChange(trailing);
              return;
            }
            onDraftValueChange(value);
          }}
          onKeyDown={(event) => {
            if ((event.key === "," || event.key === " " || event.key === "Enter" || event.key === "Tab") && draftValue.trim()) {
              event.preventDefault();
              commit();
              return;
            }
            if (event.key === "Backspace" && !draftValue && normalizedValues.length > 0) {
              event.preventDefault();
              removeChip(normalizedValues[normalizedValues.length - 1]);
            }
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData?.getData("text") || "";
            if (/[\s,]/.test(pasted)) {
              event.preventDefault();
              const parts = pasted.split(/[\s,]+/).filter(Boolean).filter((value) => isValueValid(value));
              if (parts.length > 0) {
                onChange(Array.from(new Set([...(normalizedValues || []), ...parts])));
                onDraftValueChange("");
              }
              return;
            }
            event.preventDefault();
            onDraftValueChange(`${draftValue}${pasted}`);
          }}
          onBlur={() => {
            if (commitOnBlur && isValueValid(draftValue)) {
              commit(draftValue);
              return;
            }
            onDraftValueChange(draftValue);
          }}
          placeholder={placeholder}
        />
        {normalizedValues.length > 0 || draftValue ? (
          <button
            className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange([]);
              onDraftValueChange("");
            }}
            disabled={disabled}
          >
            Clear all
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {helperText ? <span>{helperText}</span> : null}
        {normalizedValues.length === 0 && suggestedValues.length > 0 ? (
          <button
            className="font-medium uppercase tracking-[0.16em] text-foreground transition hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            onClick={handleUseSuggestedValues}
            disabled={disabled}
          >
            Use suggested values
          </button>
        ) : null}
      </div>
    </div>
  );
}

function createBlankRateLimitEditorRow(key = "rate-limit-draft-row") {
  return createRateLimitDraftRow({
    key,
    models: [],
    requests: "",
    windowValue: "",
    windowUnit: PROVIDER_PRESET_BY_KEY.custom.rateLimitDefaults.windowUnit
  }, {
    keyPrefix: "rate-limit-draft",
    defaults: PROVIDER_PRESET_BY_KEY.custom.rateLimitDefaults,
    useDefaults: false
  });
}

function appendRateLimitDraftRow(rows = [], { keyPrefix = "rate-limit-draft" } = {}) {
  const nextKey = `${keyPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return [
    ...(Array.isArray(rows) ? rows : []),
    createBlankRateLimitEditorRow(nextKey)
  ];
}

function RateLimitModelSelector({
  value = [],
  onChange,
  availableModelIds = [],
  disabled = false
}) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const normalizedValue = useMemo(
    () => normalizeRateLimitModelSelectors(value),
    [value]
  );
  const explicitAll = normalizedValue.includes(RATE_LIMIT_ALL_MODELS_SELECTOR);
  const selectedModelIds = explicitAll ? [] : normalizedValue.filter(Boolean);
  const effectiveAll = explicitAll || selectedModelIds.length === 0;
  const knownModelIds = useMemo(
    () => normalizeUniqueTrimmedValues(availableModelIds),
    [availableModelIds]
  );

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;

    function handlePointerDown(event) {
      if (rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  function commit(nextValues) {
    onChange(normalizeRateLimitModelSelectors(nextValues));
  }

  function handleToggleAll(checked) {
    commit(checked ? [RATE_LIMIT_ALL_MODELS_SELECTOR] : []);
  }

  function handleToggleModel(modelId, checked) {
    const nextValues = checked
      ? [...selectedModelIds, modelId]
      : selectedModelIds.filter((entry) => entry !== modelId);
    commit(nextValues);
  }

  function handleRemoveChip(modelId) {
    if (modelId === RATE_LIMIT_ALL_MODELS_SELECTOR) {
      commit([]);
      return;
    }
    commit(selectedModelIds.filter((entry) => entry !== modelId));
  }

  const chips = explicitAll
    ? [{ key: RATE_LIMIT_ALL_MODELS_SELECTOR, label: "All model", removable: true }]
    : selectedModelIds.length > 0
      ? selectedModelIds.map((modelId) => ({ key: modelId, label: modelId, removable: true }))
      : [{ key: "__implicit-all__", label: "All model", removable: false, muted: true }];

  return (
    <div ref={rootRef} className="relative space-y-1.5">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        className={cn(
          "flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background/80 px-3 py-1.5 text-left text-sm text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/40",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
          open ? "border-ring ring-2 ring-ring/40" : null
        )}
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((current) => !current);
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {chips.map((chip) => chip.removable ? (
            <button
              key={chip.key}
              type="button"
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background px-2 py-0.5 text-xs font-medium text-foreground transition hover:border-accent hover:bg-accent"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleRemoveChip(chip.key);
              }}
              disabled={disabled}
              title={`Remove ${chip.label}`}
            >
              <span className="truncate">{chip.label}</span>
              <span className="text-muted-foreground">x</span>
            </button>
          ) : (
            <span
              key={chip.key}
              className={cn(
                "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                chip.muted
                  ? "border-border/70 bg-secondary/45 text-muted-foreground"
                  : "border-border/70 bg-background text-foreground"
              )}
            >
              <span className="truncate">{chip.label}</span>
            </span>
          ))}
        </div>
        <span className="text-muted-foreground">▾</span>
      </div>

      {open ? (
        <AdaptiveDropdownPanel
          open={open}
          anchorRef={rootRef}
          preferredSide="top"
          desiredHeight={192}
          className="p-2"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground transition hover:bg-secondary/60">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={explicitAll}
              onChange={(event) => handleToggleAll(event.target.checked)}
            />
            <span>All model</span>
          </label>
          <div className="my-1 border-t border-border/70" />
          {knownModelIds.length > 0 ? (
            <div>
              {knownModelIds.map((modelId) => (
                <label key={modelId} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground transition hover:bg-secondary/60">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input"
                    checked={selectedModelIds.includes(modelId)}
                    onChange={(event) => handleToggleModel(modelId, event.target.checked)}
                  />
                  <span className="truncate">{modelId}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="px-2 py-2 text-sm text-muted-foreground">No models available yet.</div>
          )}
        </AdaptiveDropdownPanel>
      ) : null}
    </div>
  );
}

function RateLimitBucketsEditor({
  rows,
  onChange,
  availableModelIds = [],
  disabled = false,
  inputRef = null,
  helperText = "",
  onValidBlur = null
}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const rootRef = useRef(null);
  const rowsRef = useRef(normalizedRows);
  const knownModelIds = useMemo(
    () => normalizeUniqueTrimmedValues(availableModelIds),
    [availableModelIds]
  );
  const duplicateBucketIds = useMemo(() => {
    const seen = new Set();
    const duplicates = new Set();
    for (const row of resolveRateLimitDraftRows(normalizedRows)) {
      const bucketId = buildAutoRateLimitBucketId(row);
      if (!bucketId) continue;
      if (seen.has(bucketId)) {
        duplicates.add(bucketId);
        continue;
      }
      seen.add(bucketId);
    }
    return duplicates;
  }, [normalizedRows]);
  const displayRows = useMemo(
    () => normalizedRows.map((row) => ({
      ...createBlankRateLimitEditorRow(row.key),
      ...row,
      models: normalizeRateLimitModelSelectors(row?.models || [])
    })),
    [normalizedRows]
  );

  useEffect(() => {
    rowsRef.current = normalizedRows;
  }, [normalizedRows]);

  function updateRows(nextRows) {
    const resolvedRows = Array.isArray(nextRows) ? nextRows : [];
    rowsRef.current = resolvedRows;
    onChange(resolvedRows);
  }

  function updateRow(rowKey, patch) {
    updateRows(normalizedRows.map((row) => (row.key === rowKey ? { ...row, ...patch } : row)));
  }

  function removeRow(rowKey) {
    updateRows(normalizedRows.filter((row) => row.key !== rowKey));
  }

  function getRowIssue(row) {
    if (isBlankRateLimitDraftRow(row)) return "";
    const resolvedModels = normalizeRateLimitModelSelectors(row?.models || []);
    if (knownModelIds.length > 0 && resolvedModels.some((modelId) => modelId !== RATE_LIMIT_ALL_MODELS_SELECTOR && !knownModelIds.includes(modelId))) {
      return "Use exact provider model ids only.";
    }
    if (normalizePositiveInteger(row?.requests, 0) <= 0) return "Requests must be a positive integer.";
    if (normalizePositiveInteger(row?.windowValue, 0) <= 0) return "Window size must be a positive integer.";
    if (!QUICK_START_WINDOW_OPTIONS.includes(String(row?.windowUnit || "").trim())) return "Window unit is invalid.";
    const bucketId = buildAutoRateLimitBucketId({
      requests: row?.requests,
      windowValue: row?.windowValue,
      windowUnit: row?.windowUnit
    });
    if (bucketId && duplicateBucketIds.has(bucketId)) return "Another row already uses this cap.";
    return "";
  }

  function handleRootBlur(event) {
    if (!onValidBlur || disabled) return;
    if (event.currentTarget.contains(event.relatedTarget)) return;
    if (typeof window === "undefined") {
      const resolvedRows = resolveRateLimitDraftRows(rowsRef.current);
      const issue = validateRateLimitDraftRows(resolvedRows, {
        knownModelIds,
        requireAtLeastOne: true
      });
      if (!issue) onValidBlur(resolvedRows);
      return;
    }

    window.setTimeout(() => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(document.activeElement)) return;
      const resolvedRows = resolveRateLimitDraftRows(rowsRef.current);
      const issue = validateRateLimitDraftRows(resolvedRows, {
        knownModelIds,
        requireAtLeastOne: true
      });
      if (!issue) onValidBlur(resolvedRows);
    }, 0);
  }

  return (
    <div ref={rootRef} className="space-y-2.5" onBlurCapture={handleRootBlur}>
      <div className="space-y-2.5">
        {displayRows.map((row, index) => {
          const isEmptyRow = isBlankRateLimitDraftRow(row);
          const rowIssue = getRowIssue(row);
          return (
            <div
              key={row.key}
              className={cn(
                "rounded-2xl border border-border/70 bg-background/70 p-3",
                rowIssue ? "border-amber-200 bg-amber-50/70" : null,
                isEmptyRow ? "border-dashed bg-background/80" : null
              )}
            >
              <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,0.72fr)_minmax(0,0.72fr)_minmax(0,0.86fr)_auto] xl:items-end">
                <Field label="Models" stacked className="gap-1" headerClassName="min-h-0" hintClassName="leading-4">
                  <RateLimitModelSelector
                    value={row.models}
                    onChange={(value) => updateRow(row.key, { models: value })}
                    availableModelIds={knownModelIds}
                    disabled={disabled}
                  />
                </Field>
                <Field label="Request" stacked className="gap-1" headerClassName="min-h-0">
                  <Input
                    ref={index === 0 ? inputRef : null}
                    value={row.requests}
                    onChange={(event) => updateRow(row.key, { requests: event.target.value })}
                    disabled={disabled}
                    inputMode="numeric"
                    placeholder="60"
                  />
                </Field>
                <Field label="Window" stacked className="gap-1" headerClassName="min-h-0">
                  <Input
                    value={row.windowValue}
                    onChange={(event) => updateRow(row.key, { windowValue: event.target.value })}
                    disabled={disabled}
                    inputMode="numeric"
                    placeholder="1"
                  />
                </Field>
                <Field label="Unit" stacked className="gap-1" headerClassName="min-h-0">
                  <Select value={String(row.windowUnit || "minute")} onValueChange={(value) => updateRow(row.key, { windowUnit: value })} disabled={disabled}>
                    <SelectTrigger>
                      <SelectValue placeholder="Window unit" />
                    </SelectTrigger>
                    <SelectContent>
                      {QUICK_START_WINDOW_OPTIONS.map((unit) => (
                        <SelectItem key={`${row.key}-${unit}`} value={unit}>{unit}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Button type="button" variant="ghost" onClick={() => removeRow(row.key)} disabled={disabled} className="xl:self-end">
                  Remove
                </Button>
              </div>
              {rowIssue ? (
                <div className="mt-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {rowIssue}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {helperText ? <div className="text-xs leading-5 text-muted-foreground">{helperText}</div> : null}
    </div>
  );
}

function HeaderEditor({ rows, onChange }) {
  const normalizedRows = normalizeQuickStartHeaderRows(rows);
  const effectiveRows = normalizedRows.length > 0 ? normalizedRows : [{ name: "", value: "" }];

  function updateRow(index, field, value) {
    if (field === "name" && hasDuplicateHeaderName(effectiveRows, value, index)) {
      return;
    }
    onChange(effectiveRows.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row)));
  }

  function addRow() {
    onChange([...effectiveRows, { name: "", value: "" }]);
  }

  function removeRow(index) {
    const nextRows = effectiveRows.filter((_, rowIndex) => rowIndex !== index);
    onChange(nextRows.length > 0 ? nextRows : [{ name: "", value: "" }]);
  }

  return (
    <div className="space-y-2">
      {effectiveRows.map((row, index) => (
        <div key={`header-row-${index}`} className="grid gap-2 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_auto]">
          <Input
            value={row.name}
            onChange={(event) => updateRow(index, "name", event.target.value)}
            placeholder={index === 0 ? "User-Agent" : "Header name"}
          />
          <Input
            value={row.value}
            onChange={(event) => updateRow(index, "value", event.target.value)}
            placeholder={index === 0 ? QUICK_START_FALLBACK_USER_AGENT : "Header value"}
          />
          <Button type="button" variant="ghost" onClick={() => removeRow(index)}>
            Remove
          </Button>
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>User-Agent is included by default. Add more only when a provider needs them.</span>
        <Button type="button" variant="outline" onClick={addRow}>Add custom header</Button>
      </div>
    </div>
  );
}

function InlineSpinner() {
  return <span className="mr-2 inline-flex h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent align-[-0.125em]" />;
}

function AliasTargetEditor({ providerId, values, onChange }) {
  const normalizedValues = (values || []).map((value) => String(value || "").trim()).filter(Boolean);
  const setAnimatedRowRef = useReorderLayoutAnimation(normalizedValues);
  const draggingModelIdRef = useRef("");
  const draggingNodeRef = useRef(null);

  function removeValue(modelId) {
    onChange((values || []).filter((entry) => entry !== modelId));
  }

  function moveValue(fromModelId, toModelId) {
    if (!fromModelId || !toModelId || fromModelId === toModelId) return;
    const nextValues = [...(values || [])];
    const fromIndex = nextValues.indexOf(fromModelId);
    const toIndex = nextValues.indexOf(toModelId);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = nextValues.splice(fromIndex, 1);
    nextValues.splice(toIndex, 0, moved);
    onChange(nextValues);
  }

  function moveValueUp(modelId) {
    onChange(moveItemUp(values || [], modelId, (entry) => String(entry || "").trim()));
  }

  function clearDraggingState() {
    draggingModelIdRef.current = "";
    setDraggingRowClasses(draggingNodeRef.current, false);
    draggingNodeRef.current = null;
  }

  return (
    <div className="space-y-2">
      <div className="space-y-2 rounded-xl border border-input bg-background/80 px-3 py-3">
        {normalizedValues.length > 0 ? normalizedValues.map((modelId, index) => (
          <div
            key={modelId}
            ref={setAnimatedRowRef(modelId)}
            data-reorder-row="true"
            onDragOver={(event) => {
              if (draggingModelIdRef.current && draggingModelIdRef.current !== modelId) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const fromModelId = event.dataTransfer.getData("text/plain") || draggingModelIdRef.current;
              clearDraggingState();
              moveValue(fromModelId, modelId);
            }}
            className={cn(
              "grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-border/70 bg-card/90 p-3",
            )}
          >
            <span
              className="flex h-8 w-8 cursor-grab items-center justify-center rounded-full text-muted-foreground"
              draggable
              onDragStart={(event) => {
                const rowNode = getReorderRowNode(event.currentTarget);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", modelId);
                if (rowNode && typeof event.dataTransfer?.setDragImage === "function") {
                  event.dataTransfer.setDragImage(rowNode, 20, 20);
                }
                clearDraggingState();
                draggingModelIdRef.current = modelId;
                draggingNodeRef.current = rowNode;
                setDraggingRowClasses(rowNode, true);
              }}
              onDragEnd={clearDraggingState}
              title="Drag to reorder"
            >
              <DragGripIcon className="h-4 w-4" />
            </span>
            <MoveUpButton
              disabled={index === 0}
              label={index === 0 ? "Already first" : `Move ${providerId}/${modelId} up`}
              onClick={() => moveValueUp(modelId)}
            />
            <span className="truncate text-sm font-medium text-foreground">{providerId}/{modelId}</span>
            <button
              className="text-muted-foreground transition hover:text-foreground"
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => removeValue(modelId)}
            >
              ×
            </button>
          </div>
        )) : (
          <span className="block px-1 text-xs text-muted-foreground">Leave it empty for now, or add models to back the fixed <code>default</code> route. An empty default route returns 500 until you add a working model.</span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">Drag rows to change the preferred order, use the arrow to move a model earlier, or remove any models you do not want in this route.</div>
    </div>
  );
}

function QuickStartWizard({
  baseConfig,
  onApplyDraft,
  onValidateDraft,
  onSaveDraft,
  onSaveAndStart,
  seedMode = "blank",
  mode = "add",
  targetProviderId = "",
  defaultProviderUserAgent = QUICK_START_FALLBACK_USER_AGENT,
  framed = true,
  showHeader = true
}) {

  const [stepIndex, setStepIndex] = useState(0);
  const [busyAction, setBusyAction] = useState("");
  const [quickStart, setQuickStart] = useState(() => createQuickStartState(baseConfig, { seedMode, targetProviderId, defaultProviderUserAgent }));
  const [testedConfig, setTestedConfig] = useState(null);
  const [testError, setTestError] = useState("");
  const [modelTestStates, setModelTestStates] = useState({});
  const [modelDiscovery, setModelDiscovery] = useState(null);
  const [modelDiscoveryError, setModelDiscoveryError] = useState("");
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [completedOAuthSignature, setCompletedOAuthSignature] = useState("");
  const lastRenderedTestSignatureRef = useRef("");
  const isEditMode = mode === "edit";
  const isAdditionalProviderFlow = !isEditMode && seedMode === "blank" && hasCompletedProviderSetup(baseConfig);

  const steps = [
    { title: "Provider", detail: "Choose API Key or OAuth first, then enter the provider details needed for that connection type." },
    { title: "Models", detail: "Add model ids, then configure one or more rate limits for all models or selected models. API Key providers are tested before continue." },
    { title: "Default", detail: "Order the models behind the fixed `default` route before you finish." }
  ];

  const modelIds = mergeChipValuesAndDraft(quickStart.modelIds, quickStart.modelDraft);
  const aliasModelIds = syncQuickStartAliasModelIds(quickStart.aliasModelIds, modelIds);
  const endpoints = quickStart.connectionType === "api"
    ? mergeChipValuesAndDraft(quickStart.endpoints, quickStart.endpointDraft)
    : [];
  const resolvedQuickStart = useMemo(() => ({
    ...quickStart,
    endpoints,
    modelIds,
    aliasModelIds,
    rateLimitRows: resolveRateLimitDraftRows(quickStart.rateLimitRows)
  }), [quickStart, endpoints, modelIds, aliasModelIds]);
  const customHeaders = useMemo(() => headerRowsToObject(quickStart.headerRows || []), [quickStart.headerRows]);
  const credentialInput = String(quickStart.apiKeyEnv || "").trim();
  const apiConnectionSignature = useMemo(() => buildQuickStartApiSignature(resolvedQuickStart), [resolvedQuickStart]);
  const activeDiscoveryResult = modelDiscovery?.signature === apiConnectionSignature ? modelDiscovery.result : null;
  const suggestedModelIds = activeDiscoveryResult?.models?.length > 0
    ? activeDiscoveryResult.models
    : getQuickStartSuggestedModelIds(quickStart.selectedConnection || "custom");
  const normalizedProviderId = slugifyProviderId(quickStart.providerId || quickStart.providerName || "my-provider") || "my-provider";
  const resolvedSubscriptionProfile = resolveQuickStartSubscriptionProfile(quickStart);
  const subscriptionLoginSignature = JSON.stringify({
    connectionType: quickStart.connectionType,
    selectedConnection: quickStart.selectedConnection,
    subscriptionProfile: resolvedSubscriptionProfile
  });
  const testSignature = JSON.stringify({
    apiConnectionSignature,
    modelIds
  });
  const activeTestResult = testedConfig?.signature === testSignature ? testedConfig.result : null;
  const hasFreshApiTest = quickStart.connectionType !== "api" || Boolean(activeTestResult?.ok);
  const previewConfig = useMemo(
    () => buildQuickStartConfig(baseConfig, resolvedQuickStart, activeTestResult, { targetProviderId }),
    [baseConfig, resolvedQuickStart, activeTestResult, targetProviderId]
  );
  const previewText = useMemo(() => `${JSON.stringify(previewConfig, null, 2)}
`, [previewConfig]);
  const defaultRoute = DEFAULT_MODEL_ALIAS_ID;
  const activeStep = steps[stepIndex];
  const stepError = getQuickStartStepError(stepIndex, resolvedQuickStart, baseConfig, { targetProviderId });

  useEffect(() => { initPresetModels(); }, []);

  useEffect(() => {
    if (lastRenderedTestSignatureRef.current !== testSignature) {
      lastRenderedTestSignatureRef.current = testSignature;
      if (Object.keys(modelTestStates).length > 0) setModelTestStates({});
    }
    if (quickStart.connectionType !== "api") {
      if (testedConfig !== null) setTestedConfig(null);
      if (testError) setTestError("");
      if (Object.keys(modelTestStates).length > 0) setModelTestStates({});
      if (modelDiscovery !== null) setModelDiscovery(null);
      if (modelDiscoveryError) setModelDiscoveryError("");
      return;
    }
    if (testedConfig?.signature && testedConfig.signature !== testSignature) {
      setTestedConfig(null);
      setTestError("");
      setModelTestStates({});
    }
    if (modelDiscovery?.signature && modelDiscovery.signature !== apiConnectionSignature) {
      setModelDiscovery(null);
      setModelDiscoveryError("");
    }
  }, [quickStart.connectionType, testSignature, testedConfig, testError, modelTestStates, modelDiscovery, modelDiscoveryError, apiConnectionSignature]);

  function updateQuickStart(field, value) {
    setQuickStart((current) => ({ ...current, [field]: value }));
  }

  function handleProviderNameChange(value) {
    setQuickStart((current) => {
      const previousGenerated = slugifyProviderId(current.providerName || "");
      const nextGenerated = slugifyProviderId(value || "") || "my-provider";
      const shouldSyncProviderId = !current.providerId || current.providerId === previousGenerated;
      return {
        ...current,
        providerName: value,
        providerId: shouldSyncProviderId ? nextGenerated : current.providerId
      };
    });
  }

  function handleConnectionChange(nextCategory) {
    setTestError("");
    setTestedConfig(null);
    setModelTestStates({});
    setModelDiscovery(null);
    setModelDiscoveryError("");

    const defaultPresetKey = nextCategory === "api" ? "custom" : "oauth-gpt";
    applyPreset(nextCategory, defaultPresetKey);
  }

  function handlePresetChange(nextPresetKey) {
    setTestError("");
    setTestedConfig(null);
    setModelTestStates({});
    setModelDiscovery(null);
    setModelDiscoveryError("");

    const preset = findPresetByKey(nextPresetKey);
    applyPreset(preset.category, nextPresetKey);
  }

  function applyPreset(nextCategory, nextPresetKey) {
    const preset = findPresetByKey(nextPresetKey);
    const isApi = nextCategory === "api";

    setQuickStart((current) => {
      const currentPreset = findPresetByKey(current.selectedConnection || "custom");
      const currentDefaults = getQuickStartConnectionDefaults(current.selectedConnection || "custom");
      const existingProviders = Array.isArray(baseConfig?.providers) ? baseConfig.providers : [];
      const deduped = deduplicateProviderId(preset.providerId, preset.providerName, existingProviders);
      const currentHeaderDefaults = current.connectionType === "api"
        ? getQuickStartDefaultHeaderRows(defaultProviderUserAgent)
        : [];
      const nextHeaderDefaults = isApi
        ? getQuickStartDefaultHeaderRows(defaultProviderUserAgent)
        : [];
      const currentHeaderRows = normalizeQuickStartHeaderRows(current.headerRows || []);
      const providerIdWasAuto = !current.providerId
        || current.providerId === currentPreset.providerId
        || current.providerId === currentDefaults.providerId
        || current.providerId === slugifyProviderId(current.providerName || "");
      const providerNameWasAuto = !current.providerName
        || current.providerName === currentPreset.providerName
        || current.providerName === currentDefaults.providerName;
      const apiKeyEnvWasAuto = !current.apiKeyEnv || current.apiKeyEnv === (currentPreset.apiKeyEnv || "") || current.apiKeyEnv === currentDefaults.apiKeyEnv;
      const profileWasAuto = !current.subscriptionProfile || current.subscriptionProfile === currentDefaults.subscriptionProfile;
      const currentDefaultModels = Array.isArray(currentPreset.defaultModels) ? currentPreset.defaultModels : [];
      const modelsWereDefault = (current.modelIds || []).length === 0
        || JSON.stringify(current.modelIds || []) === JSON.stringify(currentDefaultModels)
        || JSON.stringify(current.modelIds || []) === JSON.stringify(currentDefaults.modelIds || []);
      const headerRowsWereDefault = JSON.stringify(currentHeaderRows) === JSON.stringify(currentHeaderDefaults);

      const presetModels = Array.isArray(preset.defaultModels)
        ? [...preset.defaultModels]
        : [];
      const nextDefaults = getQuickStartConnectionDefaults(nextPresetKey);

      return {
        ...current,
        connectionType: nextCategory,
        selectedConnection: nextPresetKey,
        providerName: providerNameWasAuto ? deduped.providerName : current.providerName,
        providerId: providerIdWasAuto ? deduped.providerId : current.providerId,
        endpoints: isApi
          ? (preset.endpoint ? [preset.endpoint] : [])
          : [],
        endpointDraft: isApi ? String(current.endpointDraft || "") : "",
        apiKeyEnv: isApi
          ? (apiKeyEnvWasAuto ? (preset.apiKeyEnv || "") : current.apiKeyEnv)
          : "",
        subscriptionProfile: isApi
          ? ""
          : (profileWasAuto ? nextDefaults.subscriptionProfile : current.subscriptionProfile),
        modelIds: modelsWereDefault ? (presetModels.length > 0 ? presetModels : nextDefaults.modelIds) : current.modelIds,
        modelContextWindows: modelsWereDefault ? {} : (current.modelContextWindows || {}),
        modelDraft: "",
        rateLimitRows: isApi
          ? createRateLimitDraftRows([], {
              keyPrefix: `quick-start-${nextPresetKey}-rate-limit`,
              defaults: preset.rateLimitDefaults || PROVIDER_PRESET_BY_KEY.custom.rateLimitDefaults,
              includeDefault: true
            })
          : [],
        headerRows: isApi
          ? ((currentHeaderRows.length === 0 || headerRowsWereDefault) ? nextHeaderDefaults : currentHeaderRows)
          : []
      };
    });
  }

  async function runModelDiscovery({ force = false, silent = false } = {}) {
    if (quickStart.connectionType !== "api") return false;
    if (endpoints.length === 0 || !credentialInput) {
      if (!silent) {
        setModelDiscoveryError("Add endpoints and an API key or env before checking the model list API.");
      }
      return false;
    }
    if (!force && modelDiscovery?.signature === apiConnectionSignature) {
      return Boolean((modelDiscovery?.result?.models || []).length);
    }

    setDiscoveringModels(true);
    if (!silent) setModelDiscoveryError("");
    try {
      const payload = await fetchJson("/api/config/discover-provider-models", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          endpoints,
          ...(looksLikeEnvVarName(credentialInput)
            ? { apiKeyEnv: credentialInput }
            : { apiKey: credentialInput }),
          ...(Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {})
        })
      });
      let discoveredModelIds = (payload.result?.models || [])
        .map((modelId) => String(modelId || "").trim())
        .filter(Boolean);
      let discoveredModelContextWindows = {};

      if (discoveredModelIds.length > 0) {
        const activePresetKey = quickStart.selectedConnection;
        if (activePresetKey) presetModelCache.set(activePresetKey, discoveredModelIds);
        const presetHost = detectPresetHostFromEndpoints(endpoints);
        if (presetHost) {
          const freeTierModels = await probeFreeTierModels(
            endpoints[0] || "",
            credentialInput,
            discoveredModelIds.filter((id) => !id.includes("embed") && !id.includes("tts") && !id.includes("image") && !id.includes("lyria") && !id.includes("veo"))
          );
          if (freeTierModels) {
            discoveredModelIds = freeTierModels;
          }
        }
        try {
          const contextResults = await lookupLiteLlmContextWindow(discoveredModelIds);
          discoveredModelContextWindows = buildLiteLlmModelContextWindowMap(contextResults);
        } catch {
          discoveredModelContextWindows = {};
        }
      }

      const nextDiscoveryResult = {
        ...(payload.result && typeof payload.result === "object" ? payload.result : {}),
        modelContextWindows: discoveredModelContextWindows
      };
      setModelDiscovery({ signature: apiConnectionSignature, result: nextDiscoveryResult });

      if (discoveredModelIds.length > 0) {
        setQuickStart((current) => {
          if (buildQuickStartApiSignature(current) !== apiConnectionSignature || current.connectionType !== "api") return current;
          const currentModelIds = Array.isArray(current.modelIds) ? current.modelIds : [];
          const nextModelIds = force && currentModelIds.length > 0
            ? Array.from(new Set([...currentModelIds, ...discoveredModelIds]))
            : currentModelIds.length > 0
              ? currentModelIds
              : discoveredModelIds;
          const nextModelContextWindows = {
            ...(current.modelContextWindows && typeof current.modelContextWindows === "object" ? current.modelContextWindows : {}),
            ...discoveredModelContextWindows
          };
          const presetHost = detectPresetHostFromEndpoints(current.endpoints);
          const presetRateLimitRows = presetHost
            ? buildPresetFreeTierRateLimitRows(presetHost, nextModelIds)
            : null;
          if (
            JSON.stringify(nextModelIds) === JSON.stringify(currentModelIds)
            && JSON.stringify(nextModelContextWindows) === JSON.stringify(current.modelContextWindows || {})
            && !presetRateLimitRows
          ) {
            return current;
          }
          return {
            ...current,
            modelIds: nextModelIds,
            modelContextWindows: nextModelContextWindows,
            ...(presetRateLimitRows ? { rateLimitRows: presetRateLimitRows } : {})
          };
        });
        setModelDiscoveryError("");
        return true;
      }
      const warningMessage = (payload.result?.warnings || []).join(" ") || "Model list API did not return any models. Add model ids manually if needed.";
      setModelDiscoveryError(warningMessage);
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setModelDiscoveryError(message);
      return false;
    } finally {
      setDiscoveringModels(false);
    }
  }

  async function runConfigTest() {
    if (quickStart.connectionType !== "api") return true;
    setBusyAction("test");
    setTestError("");
    setModelTestStates(Object.fromEntries(modelIds.map((modelId) => [modelId, "pending"])));
    try {
      const result = await fetchJsonLineStream("/api/config/test-provider-stream", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          endpoints,
          models: modelIds,
          ...(looksLikeEnvVarName(credentialInput)
            ? { apiKeyEnv: credentialInput }
            : { apiKey: credentialInput }),
          ...(Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {})
        })
      }, {
        onMessage: (message) => {
          if (message?.type !== "progress") return;
          const event = message.event || {};
          if (event.phase !== "model-done") return;
          setModelTestStates((current) => ({
            ...current,
            [event.model]: event.confirmed ? "success" : "error"
          }));
        }
      });
      setTestedConfig({ signature: testSignature, result });
      setModelTestStates((current) => {
        const next = { ...current };
        const confirmedModels = new Set(Array.isArray(result?.models) ? result.models : []);
        for (const modelId of modelIds) {
          next[modelId] = confirmedModels.has(modelId) ? "success" : "error";
        }
        return next;
      });
      if (!result?.ok) {
        setTestError((result?.warnings || []).join(" ") || "Provider test could not confirm a working endpoint/model combination.");
        return false;
      }
      return true;
    } catch (error) {
      setModelTestStates((current) => {
        const next = { ...current };
        for (const modelId of modelIds) {
          if (!next[modelId] || next[modelId] === "pending") next[modelId] = "error";
        }
        return next;
      });
      setTestError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusyAction("");
    }
  }

  useEffect(() => {
    if (stepIndex !== 1 || quickStart.connectionType !== "api") return;
    if (modelIds.length > 0 || !credentialInput || endpoints.length === 0) return;
    if (discoveringModels || modelDiscovery?.signature === apiConnectionSignature) return;
    void runModelDiscovery({ silent: true });
  }, [stepIndex, quickStart.connectionType, modelIds.length, credentialInput, endpoints.length, discoveringModels, modelDiscovery, apiConnectionSignature]);

  async function runSubscriptionLogin({ force = false } = {}) {
    if (quickStart.connectionType === "api") return true;
    if (!force && completedOAuthSignature === subscriptionLoginSignature) return true;

    const activePreset = findPresetByKey(quickStart.selectedConnection || "oauth-gpt");
    setBusyAction("oauth-login");
    setTestError("");
    try {
      await fetchJson("/api/subscription/login", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          profileId: resolvedSubscriptionProfile,
          providerId: normalizedProviderId,
          subscriptionType: activePreset.subscriptionType || "chatgpt-codex"
        })
      });
      setCompletedOAuthSignature(subscriptionLoginSignature);
      return true;
    } catch (error) {
      setTestError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusyAction("");
    }
  }

  async function handleContinue() {
    if (stepIndex === 0 && quickStart.connectionType === "subscription") {
      const ok = await runSubscriptionLogin();
      if (!ok) return;
    }
    if (stepIndex === 1 && quickStart.connectionType === "api" && !hasFreshApiTest) {
      const ok = await runConfigTest();
      if (!ok) return;
    }
    setStepIndex((current) => Math.min(current + 1, steps.length - 1));
  }

  async function runWizardAction(action) {
    if ((action === "save" || action === "save-start") && quickStart.connectionType === "api" && !hasFreshApiTest) {
      setTestError("Finish is available after the provider test succeeds.");
      return;
    }

    setBusyAction(action);
    try {
      if (action === "apply") {
        await onApplyDraft(previewText);
        return;
      }
      if (action === "validate") {
        await onValidateDraft(previewText);
        return;
      }
      if (action === "save") {
        await onSaveDraft(previewText);
        return;
      }
      if (action === "save-start") {
        await onSaveAndStart(previewText);
      }
    } finally {
      setBusyAction("");
    }
  }

  const footerMessage = testError
    || stepError
    || (stepIndex === 0 && quickStart.connectionType === "subscription" && completedOAuthSignature !== subscriptionLoginSignature
      ? "Continue opens the browser sign-in flow for this provider."
      : stepIndex === 1 && quickStart.connectionType === "api" && !hasFreshApiTest
        ? "Continue will test this provider against the entered endpoints and model ids using your API key or env."
        : steps[stepIndex].detail);
  const modelHelperText = quickStart.selectedConnection === "oauth-claude"
    ? "Examples: claude-opus-4-6 claude-sonnet-4-6 claude-haiku-4-5"
    : quickStart.selectedConnection === "oauth-gpt"
      ? "Examples: gpt-5.3-codex gpt-5.2-codex gpt-5.1-codex-mini"
      : (
        <>
          <span>
            Examples: gpt-4o-mini gpt-4.1-mini
            {Object.keys(activeDiscoveryResult?.modelContextWindows || {}).length > 0
              ? ` · ${Object.keys(activeDiscoveryResult?.modelContextWindows || {}).length} context size${Object.keys(activeDiscoveryResult?.modelContextWindows || {}).length === 1 ? "" : "s"} ready`
              : ""}
          </span>
          <span className="ml-2 text-amber-700">
            Auto-discovered model ids may be incomplete or inaccurate if the provider is misconfigured. Verify the list and add or remove model ids yourself.
          </span>
        </>
      );
  const showStepBadge = !isAdditionalProviderFlow;
  const headingTitle = isEditMode ? "Edit provider" : isAdditionalProviderFlow ? "Add provider" : "Quick start wizard";
  const headingDescription = isEditMode
    ? "Update this provider in place. Change endpoints, model ids, rate limits, alias, or provider id, then save the refreshed config."
    : isAdditionalProviderFlow
      ? "Add another provider with endpoints, model ids, rate limits, and a stable alias. API Key providers are auto-tested before save."
      : "Add the first provider, models list, rate limits, stable alias, and then start the router. API Key providers are auto-tested before save.";
  const wizardContent = (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border/70 bg-secondary/25 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {showStepBadge ? (
            <Badge variant="outline" className="px-3 py-1 text-[10px] uppercase tracking-[0.16em]">
              Step {stepIndex + 1} of {steps.length}
            </Badge>
          ) : null}
          {steps.map((step, index) => (
            <div
              key={step.title}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl px-3 py-2 ring-1",
                index === stepIndex
                  ? "bg-background text-foreground shadow-sm ring-border"
                  : index < stepIndex
                    ? "bg-emerald-50 text-emerald-900 ring-emerald-200"
                    : "bg-background/70 text-muted-foreground ring-border/60"
              )}
            >
              <span className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
                index === stepIndex
                  ? "bg-primary text-primary-foreground"
                  : index < stepIndex
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-secondary text-secondary-foreground"
              )}>
                {index + 1}
              </span>
              <span className="text-sm font-medium">{step.title}</span>
            </div>
          ))}
        </div>
      </div>

      {stepIndex === 0 ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            {QUICK_START_CONNECTION_CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                type="button"
                className={cn(
                  "rounded-2xl border px-4 py-3 text-left transition",
                  quickStart.connectionType === cat.value
                    ? "border-ring bg-background shadow-sm"
                    : "border-border/70 bg-background/70 hover:border-border"
                )}
                onClick={() => handleConnectionChange(cat.value)}
              >
                <div className="text-sm font-medium text-foreground">{cat.label}</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">{cat.description}</div>
              </button>
            ))}
          </div>

          <Field label="Provider preset">
            <Select
              value={quickStart.selectedConnection || (quickStart.connectionType === "api" ? "custom" : "oauth-gpt")}
              onValueChange={handlePresetChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {getPresetOptionsByCategory(quickStart.connectionType === "subscription" ? "subscription" : "api").map((preset) => (
                  <SelectItem key={preset.key} value={preset.key}>
                    {preset.label}
                    <span className="ml-2 text-muted-foreground">{preset.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Provider name">
              <Input
                value={quickStart.providerName}
                onChange={(event) => handleProviderNameChange(event.target.value)}
                placeholder={findPresetByKey(quickStart.selectedConnection || "custom").providerName}
              />
            </Field>
            <Field label="Provider id" hint="lowercase-hyphenated">
              <Input
                value={quickStart.providerId}
                onChange={(event) => updateQuickStart("providerId", event.target.value)}
                onBlur={() => updateQuickStart("providerId", slugifyProviderId(quickStart.providerId || quickStart.providerName || "my-provider") || "my-provider")}
                placeholder={findPresetByKey(quickStart.selectedConnection || "custom").providerId}
              />
            </Field>
          </div>

          {quickStart.connectionType === "api" ? (
            <>
              <Field label="Endpoints" hint="comma, space, or newline turns into chips">
                <ChipInput
                  values={quickStart.endpoints}
                  onChange={(value) => updateQuickStart("endpoints", value)}
                  draftValue={quickStart.endpointDraft}
                  onDraftValueChange={(value) => updateQuickStart("endpointDraft", value)}
                  commitOnBlur
                  isValueValid={isLikelyHttpEndpoint}
                  placeholder="Example: https://api.openai.com/v1"
                  helperText="Paste one or more endpoints"
                />
              </Field>
              <Field label="API key or env">
                <CredentialInput
                  value={quickStart.apiKeyEnv}
                  onChange={(event) => updateQuickStart("apiKeyEnv", event.target.value)}
                  placeholder="Example: OPENAI_API_KEY or sk-..."
                  isEnvVar={looksLikeEnvVarName(quickStart.apiKeyEnv)}
                />
              </Field>
              <Field label="Custom headers" hint="User-Agent included by default">
                <HeaderEditor
                  rows={quickStart.headerRows}
                  onChange={(value) => updateQuickStart("headerRows", value)}
                />
              </Field>
            </>
          ) : (
            <div className="space-y-3">
              <div className="rounded-2xl border border-border/70 bg-secondary/45 px-4 py-3 text-sm leading-6 text-muted-foreground">
                {quickStart.selectedConnection === "oauth-claude"
                  ? "Continue opens the Claude sign-in page in your browser and stores the login for this provider automatically."
                  : "Continue opens the ChatGPT sign-in page in your browser and stores the login for this provider automatically."}
              </div>
              {quickStart.selectedConnection === "oauth-claude" ? (
                <div className="rounded-2xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 text-xs leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-300">
                  <span className="font-medium">Heads up:</span> Claude Code OAuth routes through Anthropic&apos;s API with your subscription credentials. Usage will count against your Claude Max/Pro plan&apos;s extra usage quota, not the included subscription messages. Make sure you have extra usage enabled on your Claude plan to avoid request failures.
                </div>
              ) : (
                <div className="rounded-2xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 text-xs leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-300">
                  <span className="font-medium">Heads up:</span> ChatGPT subscriptions (Plus / Pro / Team) are separate from the OpenAI API and are intended for use within OpenAI&apos;s own apps. Routing requests through your subscription here may violate OpenAI&apos;s terms of service and could result in account restrictions.
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {stepIndex === 1 ? (
        <div className="space-y-4">
          <Field label="Models" hint="comma, space, or newline turns into chips">
            <ChipInput
              values={quickStart.modelIds}
              onChange={(value) => updateQuickStart("modelIds", value)}
              draftValue={quickStart.modelDraft}
              onDraftValueChange={(value) => updateQuickStart("modelDraft", value)}
              commitOnBlur
              disabled={busyAction === "test"}
              valueStates={quickStart.connectionType === "api" ? modelTestStates : {}}
              placeholder="Paste model ids"
              helperText={modelHelperText}
              suggestedValues={suggestedModelIds}
            />
          </Field>
          {quickStart.connectionType === "api" && discoveringModels ? (
            <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              <div className="flex items-center gap-2 font-medium">
                <InlineSpinner />
                Loading provider models
              </div>
              <div className="mt-1 text-xs leading-5 text-sky-800/90">
                LLM Router is checking the provider model list and matching context sizes for the discovered models.
              </div>
            </div>
          ) : null}
          {quickStart.connectionType === "api" ? (
            <>
              <Field
                label="Rate limit"
                stacked
                headerAction={(
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => updateQuickStart("rateLimitRows", appendRateLimitDraftRow(quickStart.rateLimitRows))}
                    disabled={busyAction === "test"}
                  >
                    Add rate limit
                  </Button>
                )}
              >
                <RateLimitBucketsEditor
                  rows={quickStart.rateLimitRows}
                  onChange={(value) => updateQuickStart("rateLimitRows", value)}
                  availableModelIds={modelIds}
                  disabled={busyAction === "test"}
                />
              </Field>
              <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm leading-6 text-muted-foreground">
                The first model becomes the primary direct route. Add caps for <code>all</code> models or target individual model ids when you need a narrower quota bucket.
              </div>
            </>
          ) : null}
          {quickStart.connectionType === "api" ? (
            <div className={cn(
              "rounded-2xl border px-4 py-3 text-sm leading-6",
              activeTestResult?.ok
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : activeTestResult
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-border/70 bg-background/80 text-muted-foreground"
            )}>
              <div className="text-xs font-medium uppercase tracking-[0.16em]">Provider test</div>
              <div className="mt-2">
                {activeTestResult?.ok
                  ? `Confirmed ${(activeTestResult.models || []).length} model(s) across ${(activeTestResult.workingFormats || []).join(", ") || "detected formats"}.`
                  : activeTestResult
                    ? (activeTestResult.warnings || []).join(" ") || "Provider test still needs review."
                    : "Run Provider test before continuing so the wizard can auto-detect the working endpoint format(s)."}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {stepIndex === 2 ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            {isAdditionalProviderFlow || isEditMode ? (
              <ToggleField
                label="Use this provider order for the default route"
                hint="Updates the fixed `default` alias"
                checked={quickStart.useAliasAsDefault}
                onCheckedChange={(checked) => updateQuickStart("useAliasAsDefault", checked)}
              />
            ) : (
              <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm text-muted-foreground md:col-span-2">
                The fixed <code>default</code> route is created automatically. Arrange this provider&apos;s models in the order you want clients to try first.
              </div>
            )}
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Model order</div>
            <div className="mt-3">
              <AliasTargetEditor
                providerId={normalizedProviderId}
                values={aliasModelIds}
                onChange={(value) => updateQuickStart("aliasModelIds", value)}
              />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Provider</div>
              <div className="mt-2 text-sm font-medium text-foreground">{normalizedProviderId}</div>
              <div className="mt-1 text-xs text-muted-foreground">{quickStart.providerName}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Connection</div>
              <div className="mt-2 text-sm font-medium text-foreground">{getQuickStartConnectionLabel(quickStart.selectedConnection || "custom")}</div>
              <div className="mt-1 text-xs text-muted-foreground break-all">
                {quickStart.connectionType === "api"
                  ? `${endpoints.length} endpoint candidate(s)`
                  : "Browser sign-in flow"}
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Models</div>
              <div className="mt-2 text-sm font-medium text-foreground">{modelIds.length} configured</div>
              <div className="mt-1 text-xs text-muted-foreground break-all">{modelIds.join(", ") || "No models yet"}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Default route</div>
              <div className="mt-2 text-sm font-medium text-foreground break-all">{defaultRoute}</div>
              <div className="mt-1 text-xs text-muted-foreground">{quickStart.useAliasAsDefault ? "Requests to `default` and `smart` use this ordered list." : "This provider keeps its direct routes only until you opt it into the fixed default route."}</div>
            </div>
          </div>
          {quickStart.connectionType === "api" ? (
            <div className={cn(
              "rounded-2xl border px-4 py-3 text-sm leading-6",
              hasFreshApiTest ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"
            )}>
              <div className="text-xs font-medium uppercase tracking-[0.16em]">Provider test</div>
              <div className="mt-2">
                {hasFreshApiTest
                  ? `Using ${(activeTestResult?.workingFormats || []).join(", ") || "detected formats"}. The saved provider keeps the tested endpoint selection and confirmed models.`
                  : "Finish is available after the provider test succeeds."}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 border-t border-border/70 pt-4 md:flex-row md:items-start md:justify-between md:gap-4">
        <div className={cn("min-w-0 flex-1 text-sm md:max-w-2xl", stepError || testError ? "text-amber-700" : "text-muted-foreground")}>
          {footerMessage}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
          {stepIndex > 0 ? <Button variant="ghost" onClick={() => setStepIndex((current) => Math.max(current - 1, 0))}>Back</Button> : null}
          {stepIndex < steps.length - 1 ? (
            <Button onClick={() => void handleContinue()} disabled={Boolean(stepError) || busyAction !== ""}>
              {busyAction === "oauth-login" ? (
                <><InlineSpinner />Signing in…</>
              ) : busyAction === "test" ? (
                <><InlineSpinner />Testing provider…</>
              ) : "Continue"}
            </Button>
          ) : (
            <Button onClick={() => void runWizardAction("save-start")} disabled={Boolean(stepError) || busyAction !== "" || (quickStart.connectionType === "api" && !hasFreshApiTest)}>
              {busyAction === "save-start" ? (
                <><InlineSpinner />Finishing…</>
              ) : "Finish"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  if (!framed) {
    return (
      <div className="space-y-5">
        {showHeader ? (
          <div>
            <div className="text-base font-semibold text-foreground">{headingTitle}</div>
            <div className="mt-1 text-sm leading-6 text-muted-foreground">{headingDescription}</div>
          </div>
        ) : null}
        {wizardContent}
      </div>
    );
  }

  return (
    <Card className="border-dashed">
      {showHeader ? (
        <CardHeader>
          <CardTitle>{headingTitle}</CardTitle>
          <CardDescription>{headingDescription}</CardDescription>
        </CardHeader>
      ) : null}
      <CardContent className="space-y-5">
        {wizardContent}
      </CardContent>
    </Card>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [draftText, setDraftText] = useState("");
  const [baselineText, setBaselineText] = useState("");
  const [validation, setValidation] = useState(null);
  const [notices, setNotices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [openEditorBusy, setOpenEditorBusy] = useState(false);
  const [routerBusy, setRouterBusy] = useState("");
  const [startupBusy, setStartupBusy] = useState("");
  const [activeTab, setActiveTab] = useState("model-alias");
  const [remoteConfigUpdated, setRemoteConfigUpdated] = useState(false);
  const [providerWizardOpen, setProviderWizardOpen] = useState(false);
  const [providerWizardKey, setProviderWizardKey] = useState(0);
  const [ampRoutingBusy, setAmpRoutingBusy] = useState("");
  const [codexRoutingBusy, setCodexRoutingBusy] = useState("");
  const [claudeRoutingBusy, setClaudeRoutingBusy] = useState("");
  const [factoryDroidRoutingBusy, setFactoryDroidRoutingBusy] = useState("");
  const [codexBindingsBusy, setCodexBindingsBusy] = useState(false);
  const [claudeBindingsBusy, setClaudeBindingsBusy] = useState(false);
  const [factoryDroidBindingsBusy, setFactoryDroidBindingsBusy] = useState(false);
  const [activityLogBusy, setActivityLogBusy] = useState("");
  const [activityFilter, setActivityFilter] = useState("usage");
  const [ampAutosaveRequest, setAmpAutosaveRequest] = useState(null);
  const [ampAutosaveState, setAmpAutosaveState] = useState({
    status: "idle",
    message: "",
    savedAt: ""
  });

  const draftRef = useRef("");
  const baselineRef = useRef("");
  const eventSourceRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const ampAutosaveTimerRef = useRef(null);
  const ampAutosaveSequenceRef = useRef(0);
  const masterKeyBootstrapRef = useRef("");
  const noticeIdRef = useRef(0);

  useEffect(() => {
    draftRef.current = draftText;
  }, [draftText]);

  useEffect(() => {
    baselineRef.current = baselineText;
  }, [baselineText]);

  useEffect(() => () => {
    if (ampAutosaveTimerRef.current) {
      clearTimeout(ampAutosaveTimerRef.current);
      ampAutosaveTimerRef.current = null;
    }
  }, []);

  const isDirty = draftText !== baselineText;
  const configDocument = snapshot?.config?.document;
  const validationSummary = validation?.summary || snapshot?.config || {};
  const validationMessages = validation?.validationMessages || snapshot?.config?.validationMessages || [];
  const persistedConfig = useMemo(
    () => tryParseConfigObject(snapshot?.config?.rawText || "{}", snapshot?.config?.document || {}),
    [snapshot?.config?.rawText, snapshot?.config?.document]
  );
  const parsedDraftState = useMemo(() => parseDraftConfigText(draftText, persistedConfig), [draftText, persistedConfig]);
  const parsedDraftConfig = useMemo(() => tryParseConfigObject(draftText, persistedConfig), [draftText, persistedConfig]);
  const editableConfig = parsedDraftState.parseError ? persistedConfig : parsedDraftState.value;
  const providers = useMemo(() => Array.isArray(editableConfig?.providers) ? editableConfig.providers : [], [editableConfig]);
  const modelAliases = useMemo(
    () => editableConfig?.modelAliases && typeof editableConfig.modelAliases === "object" && !Array.isArray(editableConfig.modelAliases)
      ? editableConfig.modelAliases
      : {},
    [editableConfig]
  );
  const managedRouteOptions = useMemo(() => buildManagedRouteOptions(editableConfig), [editableConfig]);
  const providerEditorDisabledReason = parsedDraftState.parseError ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}` : "";
  const ampEditableConfig = editableConfig;
  const ampClientUrl = useMemo(() => buildAmpClientUrl(), []);
  const ampClientGlobal = snapshot?.ampClient?.global || {};
  const webSearchSnapshot = snapshot?.webSearch || snapshot?.ampWebSearch || null;
  const codexCliState = snapshot?.codingTools?.codexCli || {};
  const claudeCodeState = snapshot?.codingTools?.claudeCode || {};
  const factoryDroidState = snapshot?.codingTools?.factoryDroid || {};
  const ampTabConnected = ampClientGlobal?.routedViaRouter === true;
  const codexTabConnected = codexCliState?.routedViaRouter === true;
  const claudeTabConnected = claudeCodeState?.routedViaRouter === true;
  const factoryDroidTabConnected = factoryDroidState?.routedViaRouter === true;
  const ollamaSnapshot = snapshot?.ollama || null;
  const ollamaTabConnected = ollamaSnapshot?.connected === true;
  const [ollamaModels, setOllamaModels] = useState([]);
  const [ollamaBusy, setOllamaBusy] = useState({});
  const [ollamaRefreshing, setOllamaRefreshing] = useState(false);
  const activityLogState = snapshot?.activityLog || { enabled: true };
  const activityLogEnabled = activityLogState?.enabled !== false;
  const ampRouteOptions = useMemo(() => buildManagedRouteOptions(ampEditableConfig), [ampEditableConfig]);
  const ampRows = useMemo(() => buildAmpEntityRows(ampEditableConfig), [ampEditableConfig]);
  const webSearchConfig = useMemo(
    () => ensureWebSearchConfigShape(ensureAmpDraftConfigShape(ampEditableConfig)),
    [ampEditableConfig]
  );
  const webSearchProviders = useMemo(
    () => buildWebSearchProviderRows(ampEditableConfig, webSearchSnapshot),
    [ampEditableConfig, webSearchSnapshot]
  );
  const hostedSearchCandidates = useMemo(() => {
    const existingIds = new Set(
      (Array.isArray(webSearchConfig?.providers) ? webSearchConfig.providers : [])
        .map((provider) => normalizeWebSearchProviderKey(provider?.id))
        .filter(Boolean)
    );
    return buildHostedWebSearchCandidateGroups(ampEditableConfig, existingIds);
  }, [ampEditableConfig, webSearchConfig]);
  const ampDisabledReason = parsedDraftState.parseError
    ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`
    : (ampRouteOptions.length === 0 ? "Add at least one alias or provider/model route before configuring AMP." : "");
  const webSearchDisabledReason = parsedDraftState.parseError
    ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`
    : "";
  const codingToolDisabledReason = parsedDraftState.parseError
    ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`
    : (managedRouteOptions.length === 0 ? "Add at least one alias or provider/model route before configuring coding-tool bindings." : "");
  const codexRouteOptions = useMemo(
    () => withCurrentManagedRouteOptions(
      managedRouteOptions,
      isCodexCliInheritModelBinding(codexCliState?.bindings?.defaultModel) ? [] : [codexCliState?.bindings?.defaultModel]
    ),
    [managedRouteOptions, codexCliState?.bindings?.defaultModel]
  );
  const claudeRouteOptions = useMemo(
    () => withCurrentManagedRouteOptions(managedRouteOptions, [
      claudeCodeState?.bindings?.primaryModel,
      claudeCodeState?.bindings?.defaultOpusModel,
      claudeCodeState?.bindings?.defaultSonnetModel,
      claudeCodeState?.bindings?.defaultHaikuModel,
      claudeCodeState?.bindings?.subagentModel
    ]),
    [
      managedRouteOptions,
      claudeCodeState?.bindings?.primaryModel,
      claudeCodeState?.bindings?.defaultOpusModel,
      claudeCodeState?.bindings?.defaultSonnetModel,
      claudeCodeState?.bindings?.defaultHaikuModel,
      claudeCodeState?.bindings?.subagentModel
    ]
  );
  const factoryDroidRouteOptions = useMemo(
    () => withCurrentManagedRouteOptions(managedRouteOptions, [
      factoryDroidState?.bindings?.defaultModel
    ]),
    [managedRouteOptions, factoryDroidState?.bindings?.defaultModel]
  );
  const ampDefaultRoute = String(ampEditableConfig?.amp?.defaultRoute || ampEditableConfig?.defaultModel || pickFallbackDefaultModel(ampEditableConfig) || "").trim();
  const effectiveMasterKey = String(ampEditableConfig?.masterKey || snapshot?.config?.document?.masterKey || "").trim();
  const maskedMasterKey = useMemo(() => maskShortSecret(effectiveMasterKey), [effectiveMasterKey]);
  const hasProviders = providers.length > 0;
  const showProviderWizardModal = hasProviders && providerWizardOpen;
  const routerRunning = snapshot?.router?.running === true;
  const startupInstalled = snapshot?.startup?.installed === true;
  const routerActionLabel = routerBusy === "start"
    ? "Starting…"
    : routerBusy === "stop"
      ? "Stopping…"
      : routerRunning
        ? "Stop server"
        : "Start server";
  const startupActionLabel = startupBusy === "enable"
    ? "Enabling OS startup…"
    : startupBusy === "disable"
      ? "Disabling OS startup…"
      : startupInstalled
        ? "Disable OS startup"
        : "Enable OS startup";
  const routerStatusMessage = snapshot?.router?.portBusy
    ? (snapshot?.router?.portBusyReason
      || `Port ${LOCAL_ROUTER_PORT} is occupied${snapshot?.router?.listenerPids?.length > 0 ? ` by PID${snapshot.router.listenerPids.length === 1 ? "" : "s"} ${snapshot.router.listenerPids.join(", ")}` : ""}.`)
    : String(snapshot?.router?.lastError || "").trim();
  const showOnboarding = !hasCompletedProviderSetup(editableConfig);
  const wizardEligibleProviders = providers.filter((p) => p?.type !== "ollama");
  const onboardingSeedMode = wizardEligibleProviders.length > 0 ? "existing" : "blank";
  const onboardingTargetProviderId = wizardEligibleProviders[0]?.id || "";
  const defaultProviderUserAgent = snapshot?.defaults?.providerUserAgent || QUICK_START_FALLBACK_USER_AGENT;

  useEffect(() => {
    if (loading || saving || parsedDraftState.parseError) return;
    if (effectiveMasterKey) {
      masterKeyBootstrapRef.current = "";
      return;
    }

    const bootstrapSignature = String(snapshot?.config?.rawText || baselineText || "__empty__");
    if (masterKeyBootstrapRef.current === bootstrapSignature) return;
    masterKeyBootstrapRef.current = bootstrapSignature;
    void ensureMasterKeyExists({ showSuccessNotice: false });
  }, [baselineText, effectiveMasterKey, loading, parsedDraftState.parseError, saving, snapshot?.config?.rawText]);

  useEffect(() => {
    if (ampAutosaveTimerRef.current) {
      clearTimeout(ampAutosaveTimerRef.current);
      ampAutosaveTimerRef.current = null;
    }
    if (!ampAutosaveRequest) return;

    const delayMs = ampAutosaveRequest.immediate === true ? 0 : 450;
    ampAutosaveTimerRef.current = setTimeout(() => {
      ampAutosaveTimerRef.current = null;
      const currentSequence = ampAutosaveRequest.sequence;
      setAmpAutosaveState((current) => ({
        ...current,
        status: "saving",
        message: ""
      }));

      void (async () => {
        try {
          const payload = await fetchJson("/api/amp/apply", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({
              rawText: ampAutosaveRequest.rawText,
              source: "autosave"
            })
          });
          if (currentSequence !== ampAutosaveSequenceRef.current) return;
          applySnapshot(payload);
          setAmpAutosaveState({
            status: "saved",
            message: "",
            savedAt: new Date().toISOString()
          });
        } catch (error) {
          if (currentSequence !== ampAutosaveSequenceRef.current) return;
          const message = error instanceof Error ? error.message : String(error);
          setAmpAutosaveState({
            status: "error",
            message,
            savedAt: ""
          });
          showNotice("error", message);
        }
      })();
    }, delayMs);

    return () => {
      if (ampAutosaveTimerRef.current) {
        clearTimeout(ampAutosaveTimerRef.current);
        ampAutosaveTimerRef.current = null;
      }
    };
  }, [ampAutosaveRequest]);

  function openProviderWizard() {
    setProviderWizardOpen(true);
    setProviderWizardKey((current) => current + 1);
  }

  function handleOpenQuickStart() {
    openProviderWizard();
  }

  function handleHideQuickStart() {
    setProviderWizardOpen(false);
  }

  useEffect(() => {
    if (!hasProviders && providerWizardOpen) setProviderWizardOpen(false);
  }, [hasProviders, providerWizardOpen]);

  function showNotice(tone, message) {
    noticeIdRef.current += 1;
    setNotices((current) => [...current, { id: `notice-${noticeIdRef.current}`, tone, message }]);
  }

  function dismissNotice(noticeId) {
    setNotices((current) => current.filter((notice) => notice.id !== noticeId));
  }

  function applySnapshot(nextSnapshot, { preserveDraft = false } = {}) {
    setSnapshot(nextSnapshot);

    const nextRawText = String(nextSnapshot?.config?.rawText || "");
    if (!preserveDraft || draftRef.current === baselineRef.current) {
      setDraftText(nextRawText);
      setBaselineText(nextRawText);
      setRemoteConfigUpdated(false);
      setValidation({
        rawText: nextRawText,
        summary: nextSnapshot?.config,
        validationMessages: nextSnapshot?.config?.validationMessages || []
      });
      return;
    }

    setBaselineText(nextRawText);
    if (nextRawText !== baselineRef.current) {
      setRemoteConfigUpdated(true);
    }
  }

  async function loadState({ preserveDraft = false } = {}) {
    const payload = await fetchJson("/api/state");
    applySnapshot(payload, { preserveDraft });
  }

  useEffect(() => {
    let cancelled = false;

    function closeEventSource() {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    }

    function clearReconnectTimer() {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function scheduleReconnect() {
      if (cancelled || reconnectTimerRef.current) return;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectEventSource({ isReconnect: true });
      }, LIVE_UPDATES_RETRY_MS);
    }

    function connectEventSource({ isReconnect = false } = {}) {
      if (cancelled) return;
      clearReconnectTimer();
      closeEventSource();
      const source = new EventSource("/api/events");
      eventSourceRef.current = source;

      source.onopen = () => {
        if (cancelled || eventSourceRef.current !== source) return;
        if (isReconnect) {
          void loadState({
            preserveDraft: draftRef.current !== baselineRef.current
          }).catch(() => {});
        }
      };

      source.addEventListener("state", (event) => {
        if (cancelled || eventSourceRef.current !== source) return;
        try {
          const payload = JSON.parse(event.data);
          if (payload?.snapshot) {
            applySnapshot(payload.snapshot, {
              preserveDraft: true
            });
          }
        } catch (error) {
          showNotice("error", error instanceof Error ? error.message : String(error));
        }
      });

      source.addEventListener("log", (event) => {
        if (cancelled || eventSourceRef.current !== source) return;
        try {
          const entry = JSON.parse(event.data);
          setSnapshot((current) => current ? {
            ...current,
            logs: [entry, ...(current.logs || [])].slice(0, 150)
          } : current);
        } catch {
        }
      });

      source.addEventListener("logs", (event) => {
        if (cancelled || eventSourceRef.current !== source) return;
        try {
          const payload = JSON.parse(event.data);
          setSnapshot((current) => current ? {
            ...current,
            ...(payload?.activityLog ? { activityLog: payload.activityLog } : {}),
            logs: Array.isArray(payload?.logs) ? payload.logs : []
          } : current);
        } catch {
        }
      });

      source.onerror = () => {
        if (cancelled || eventSourceRef.current !== source) return;
        closeEventSource();
        scheduleReconnect();
      };
    }

    (async () => {
      try {
        await loadState();
      } catch (error) {
        if (!cancelled) {
          showNotice("error", error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          connectEventSource();
        }
      }
    })();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      closeEventSource();
    };
  }, []);


  async function validateDraftText(rawText, { silent = false } = {}) {
    setValidating(true);
    try {
      const payload = await fetchJson("/api/config/validate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ rawText })
      });
      setValidation({ rawText, summary: payload.summary, validationMessages: payload.validationMessages || [] });
      if (!silent) {
        showNotice(detectValidationVariant(payload.summary) === "success" ? "success" : "warning", payload.summary.validationSummary);
      }
      return payload;
    } catch (error) {
      if (!silent) {
        showNotice("error", error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      setValidating(false);
    }
  }

  async function saveDraftText(rawText, { successMessage = "Config saved.", showSuccessNotice = true } = {}) {
    setSaving(true);
    try {
      const payload = await fetchJson("/api/config/save", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ rawText })
      });
      applySnapshot(payload);
      if (showSuccessNotice && successMessage) {
        showNotice("success", successMessage);
      }
      return payload;
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setSaving(false);
    }
  }

  function queueAmpAutosave(rawText, { immediate = false } = {}) {
    const sequence = ampAutosaveSequenceRef.current + 1;
    ampAutosaveSequenceRef.current = sequence;
    setAmpAutosaveRequest({
      sequence,
      rawText,
      immediate: immediate === true
    });
    setAmpAutosaveState((current) => ({
      status: "pending",
      message: "",
      savedAt: current.savedAt
    }));
  }

  function handleDraftChange(value) {
    setDraftText(value);
    setValidation(null);
  }

  async function saveInlineConfigObject(nextConfig, successMessage, options = {}) {
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    setRemoteConfigUpdated(false);
    await saveDraftText(rawText, { successMessage, ...options });
  }

  async function testNewProviderModels({
    providerId,
    endpoints,
    newModelIds,
    credentialPayload,
    headers,
    onModelTestStateChange
  }) {
    if (!Array.isArray(newModelIds) || newModelIds.length === 0) {
      onModelTestStateChange?.({
        phase: "",
        modelStates: {},
        failedModelIds: [],
        message: ""
      });
      return { ok: true };
    }

    const modelStates = Object.fromEntries(newModelIds.map((modelId) => [modelId, "pending"]));
    const emitState = ({ phase = "testing", message = "", failedModelIds = [] } = {}) => {
      onModelTestStateChange?.({
        phase,
        modelStates: { ...modelStates },
        failedModelIds,
        message
      });
    };
    const buildTestingMessage = () => {
      const completedCount = newModelIds.filter((modelId) => modelStates[modelId] === "success" || modelStates[modelId] === "error").length;
      return `Testing ${completedCount}/${newModelIds.length} new model${newModelIds.length === 1 ? "" : "s"} for ${providerId}.`;
    };

    emitState({ phase: "testing", message: buildTestingMessage() });

    try {
      const result = await fetchJsonLineStream("/api/config/test-provider-stream", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          endpoints,
          models: newModelIds,
          ...credentialPayload,
          ...(headers && typeof headers === "object" && !Array.isArray(headers) ? { headers } : {})
        })
      }, {
        onMessage: (message) => {
          if (message?.type !== "progress") return;
          const event = message.event || {};
          if (event.phase !== "model-done") return;
          const modelId = String(event.model || "").trim();
          if (!modelId || !Object.prototype.hasOwnProperty.call(modelStates, modelId)) return;
          modelStates[modelId] = event.confirmed ? "success" : "error";
          emitState({ phase: "testing", message: buildTestingMessage() });
        }
      });

      const confirmedModels = new Set(Array.isArray(result?.models) ? result.models : []);
      const unresolvedModels = newModelIds.filter((modelId) => !confirmedModels.has(modelId));
      for (const modelId of newModelIds) {
        modelStates[modelId] = confirmedModels.has(modelId) ? "success" : "error";
      }
      if (!result?.ok || unresolvedModels.length > 0) {
        const warningMessage = unresolvedModels.length > 0
          ? `New model test failed for ${providerId}: ${unresolvedModels.join(", ")}.`
          : (result?.warnings || []).join(" ") || `New model test failed for ${providerId}.`;
        emitState({
          phase: "",
          failedModelIds: unresolvedModels,
          message: warningMessage
        });
        showNotice("warning", warningMessage);
        return {
          ok: false,
          failedModelIds: unresolvedModels,
          result
        };
      }

      emitState({
        phase: "saving",
        message: `Saving ${newModelIds.length} confirmed new model${newModelIds.length === 1 ? "" : "s"} for ${providerId}.`
      });
      return {
        ok: true,
        failedModelIds: [],
        result
      };
    } catch (error) {
      for (const modelId of newModelIds) {
        if (modelStates[modelId] !== "success") modelStates[modelId] = "error";
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failedModelIds = newModelIds.filter((modelId) => modelStates[modelId] === "error");
      emitState({
        phase: "",
        failedModelIds,
        message: errorMessage
      });
      showNotice("error", errorMessage);
      return {
        ok: false,
        failedModelIds
      };
    }
  }

  async function handleApplyProviderDetails(providerId, draftProvider, { showSuccessNotice = true } = {}) {
    if (providerEditorDisabledReason) {
      showNotice("warning", providerEditorDisabledReason);
      return false;
    }

    const resolvedProviderId = String(draftProvider?.id || "").trim();
    const resolvedProviderName = String(draftProvider?.name || "").trim();
    const resolvedEndpoints = Array.isArray(draftProvider?.endpoints)
      ? normalizeUniqueTrimmedValues(draftProvider.endpoints)
      : mergeChipValuesAndDraft([], draftProvider?.endpoint || "");
    const resolvedRateLimitRows = Array.isArray(draftProvider?.rateLimitRows)
      ? resolveRateLimitDraftRows(draftProvider.rateLimitRows)
      : [];
    const existingProvider = providers.find((entry) => entry?.id === providerId);
    const isApiProvider = inferQuickStartConnectionType(existingProvider) === "api";
    const knownModelIds = collectProviderModelIds(existingProvider);

    if (!resolvedProviderId) {
      showNotice("warning", "Provider id is required.");
      return false;
    }
    if (!QUICK_START_PROVIDER_ID_PATTERN.test(resolvedProviderId)) {
      showNotice("warning", "Provider id must start with a letter and use lowercase letters, digits, or dashes only.");
      return false;
    }
    if (!resolvedProviderName) {
      showNotice("warning", "Provider name is required.");
      return false;
    }
    if (resolvedProviderId !== providerId && providers.some((entry) => entry?.id === resolvedProviderId)) {
      showNotice("warning", `Provider id "${resolvedProviderId}" already exists.`);
      return false;
    }
    if (isApiProvider && resolvedEndpoints.length === 0) {
      showNotice("warning", "API Key providers require at least one valid http(s) endpoint.");
      return false;
    }
    if (isApiProvider && resolvedEndpoints.some((endpoint) => !isLikelyHttpEndpoint(endpoint))) {
      showNotice("warning", "One or more endpoints are invalid. Use full http:// or https:// URLs.");
      return false;
    }
    const rateLimitIssue = isApiProvider
      ? validateRateLimitDraftRows(resolvedRateLimitRows, {
          knownModelIds,
          requireAtLeastOne: true
        })
      : "";
    if (rateLimitIssue) {
      showNotice("warning", rateLimitIssue);
      return false;
    }

    const nextConfig = applyProviderInlineEdits(parsedDraftState.value || persistedConfig, providerId, {
      ...draftProvider,
      endpoints: resolvedEndpoints,
      rateLimitRows: resolvedRateLimitRows
    });
    try {
      await saveInlineConfigObject(nextConfig, `Updated provider ${resolvedProviderId}.`, { showSuccessNotice });
      return true;
    } catch {
      return false;
    }
  }

  async function handleSaveProviderEditorChanges(
    providerId,
    { providerDraft = null, modelRows = null, showSuccessNotice = true, onModelTestStateChange = null } = {}
  ) {
    if (providerEditorDisabledReason) {
      showNotice("warning", providerEditorDisabledReason);
      return false;
    }

    const existingProvider = providers.find((entry) => entry?.id === providerId);
    if (!existingProvider) {
      showNotice("error", `Provider '${providerId}' was not found.`);
      return false;
    }

    const hasProviderDraft = Boolean(providerDraft && typeof providerDraft === "object");
    const hasModelRows = Array.isArray(modelRows);
    if (!hasProviderDraft && !hasModelRows) return true;

    const isApiProvider = inferQuickStartConnectionType(existingProvider) === "api";
    const resolvedProviderId = hasProviderDraft ? String(providerDraft?.id || "").trim() : providerId;
    const resolvedProviderName = hasProviderDraft
      ? String(providerDraft?.name || "").trim()
      : String(existingProvider?.name || providerId).trim();
    const resolvedEndpoints = hasProviderDraft
      ? (Array.isArray(providerDraft?.endpoints)
        ? normalizeUniqueTrimmedValues(providerDraft.endpoints)
        : mergeChipValuesAndDraft([], providerDraft?.endpoint || ""))
      : collectQuickStartEndpoints(existingProvider);
    const resolvedRateLimitRows = hasProviderDraft && Array.isArray(providerDraft?.rateLimitRows)
      ? resolveRateLimitDraftRows(providerDraft.rateLimitRows)
      : [];
    const nextRows = hasModelRows
      ? modelRows
        .map((row) => ({
          ...row,
          id: String(row?.id || "").trim(),
          contextWindow: normalizeContextWindowInput(row?.contextWindow || "")
        }))
        .filter((row) => row.id)
      : [];

    if (hasProviderDraft) {
      const knownModelIds = hasModelRows
        ? nextRows.map((row) => row.id)
        : collectProviderModelIds(existingProvider);

      if (!resolvedProviderId) {
        showNotice("warning", "Provider id is required.");
        return false;
      }
      if (!QUICK_START_PROVIDER_ID_PATTERN.test(resolvedProviderId)) {
        showNotice("warning", "Provider id must start with a letter and use lowercase letters, digits, or dashes only.");
        return false;
      }
      if (!resolvedProviderName) {
        showNotice("warning", "Provider name is required.");
        return false;
      }
      if (resolvedProviderId !== providerId && providers.some((entry) => entry?.id === resolvedProviderId)) {
        showNotice("warning", `Provider id "${resolvedProviderId}" already exists.`);
        return false;
      }
      if (isApiProvider && resolvedEndpoints.length === 0) {
        showNotice("warning", "API Key providers require at least one valid http(s) endpoint.");
        return false;
      }
      if (isApiProvider && resolvedEndpoints.some((endpoint) => !isLikelyHttpEndpoint(endpoint))) {
        showNotice("warning", "One or more endpoints are invalid. Use full http:// or https:// URLs.");
        return false;
      }
      const rateLimitIssue = isApiProvider
        ? validateRateLimitDraftRows(resolvedRateLimitRows, {
            knownModelIds,
            requireAtLeastOne: true
          })
        : "";
      if (rateLimitIssue) {
        showNotice("warning", rateLimitIssue);
        return false;
      }
    }

    if (hasModelRows) {
      if (nextRows.length === 0) {
        showNotice("warning", "Keep at least one model id on the provider.");
        return false;
      }
      if (hasDuplicateTrimmedValues(nextRows.map((row) => row.id))) {
        showNotice("warning", "Model ids must be unique for each provider.");
        return false;
      }
      const hasInvalidContextWindow = nextRows.some((row) => {
        const rawValue = String(row?.contextWindow || "").trim();
        if (!rawValue) return false;
        const parsed = Number.parseInt(rawValue, 10);
        return !Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== rawValue;
      });
      if (hasInvalidContextWindow) {
        showNotice("warning", "Context windows must be positive integers when set.");
        return false;
      }

      const currentModelIds = collectProviderModelIds(existingProvider);
      const newModelIds = nextRows
        .map((row) => row.id)
        .filter((modelId) => !currentModelIds.includes(modelId));

      if (isApiProvider && newModelIds.length > 0) {
        if (resolvedEndpoints.length === 0) {
          showNotice("warning", `Provider '${resolvedProviderId}' needs at least one endpoint before testing new models.`);
          return false;
        }

        const credentialPayload = getDraftProviderCredentialPayload(providerDraft, existingProvider);
        if (!credentialPayload.apiKey && !credentialPayload.apiKeyEnv) {
          showNotice("warning", `Provider '${resolvedProviderId}' needs an API key or env before testing new models.`);
          return false;
        }

        const testOutcome = await testNewProviderModels({
          providerId: resolvedProviderId,
          endpoints: resolvedEndpoints,
          newModelIds,
          credentialPayload,
          headers: existingProvider?.headers,
          onModelTestStateChange
        });
        if (!testOutcome.ok) {
          return false;
        }
      }
    }

    let nextConfig = parsedDraftState.value || persistedConfig;
    if (hasProviderDraft) {
      nextConfig = applyProviderInlineEdits(nextConfig, providerId, {
        ...providerDraft,
        endpoints: resolvedEndpoints,
        rateLimitRows: resolvedRateLimitRows
      });
    }
    if (hasModelRows) {
      nextConfig = applyProviderModelEdits(nextConfig, hasProviderDraft ? resolvedProviderId : providerId, nextRows);
    }

    const successMessage = hasProviderDraft && hasModelRows
      ? `Updated provider ${resolvedProviderId} and saved its model list.`
      : hasProviderDraft
        ? `Updated provider ${resolvedProviderId}.`
        : (() => {
          const currentModelIds = collectProviderModelIds(existingProvider);
          const newModelIds = nextRows
            .map((row) => row.id)
            .filter((modelId) => !currentModelIds.includes(modelId));
          return newModelIds.length > 0
            ? `Tested ${newModelIds.length} new model${newModelIds.length === 1 ? "" : "s"} and updated ${resolvedProviderId}.`
            : `Updated models for ${resolvedProviderId}.`;
        })();

    try {
      await saveInlineConfigObject(nextConfig, successMessage, { showSuccessNotice });
      onModelTestStateChange?.({
        phase: "",
        modelStates: {},
        failedModelIds: [],
        message: ""
      });
      return true;
    } catch {
      return false;
    }
  }

  async function ensureMasterKeyExists({ showSuccessNotice = false } = {}) {
    if (parsedDraftState.parseError) return false;
    if (String((parsedDraftState.value || persistedConfig || {}).masterKey || "").trim()) return false;

    const nextConfig = safeClone(parsedDraftState.value || persistedConfig || {});
    nextConfig.masterKey = createMasterKey();

    try {
      await saveInlineConfigObject(nextConfig, "Gateway key ready.", { showSuccessNotice });
      return true;
    } catch {
      return false;
    }
  }

  async function handleCopyMasterKey() {
    if (!effectiveMasterKey) {
      showNotice("warning", "Gateway key is still generating. Try again in a second.");
      return;
    }

    try {
      await copyTextToClipboard(effectiveMasterKey);
      showNotice("success", "Gateway key copied to clipboard.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleCopyApiEndpoint() {
    if (!ampClientUrl) {
      showNotice("warning", "API endpoint is not ready yet.");
      return;
    }

    try {
      await copyTextToClipboard(ampClientUrl);
      showNotice("success", "API endpoint copied to clipboard.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleCopyAliasId(aliasId) {
    const value = String(aliasId || "").trim();
    if (!value) {
      showNotice("warning", "Alias id is not ready yet.");
      return;
    }

    try {
      await copyTextToClipboard(value);
      showNotice("success", `Alias id ${value} copied to clipboard.`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleOpenFilePath(pathValue, label, {
    ensureMode = "none",
    successMessage = ""
  } = {}) {
    const value = String(pathValue || "").trim();
    if (!value) {
      showNotice("warning", `${label} is not resolved yet.`);
      return;
    }

    try {
      await fetchJson("/api/file/open", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          editorId: "default",
          filePath: value,
          ensureMode
        })
      });
      showNotice("success", successMessage || `Opened ${label} in the default app.`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleCopyProviderModelId(modelId) {
    const value = String(modelId || "").trim();
    if (!value) {
      showNotice("warning", "Model id is not ready yet.");
      return;
    }

    try {
      await copyTextToClipboard(value);
      showNotice("success", `Model id ${value} copied to clipboard.`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleRotateMasterKey() {
    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm("Rotate the gateway key? Existing clients using the old key will need the new one. Linked tools like AMP, Codex CLI, and Claude Code will auto-update to the new key.");
    if (!confirmed) return;

    const nextConfig = safeClone(parsedDraftState.value || persistedConfig || {});
    nextConfig.masterKey = createMasterKey();
    try {
      await saveInlineConfigObject(nextConfig, "Rotated gateway key. Linked tools like AMP, Codex CLI, and Claude Code refreshed automatically.");
    } catch {
    }
  }

  async function handleApplyProviderModels(providerId, rows, { providerDraft = null, onModelTestStateChange = null } = {}) {
    if (providerEditorDisabledReason) {
      showNotice("warning", providerEditorDisabledReason);
      return false;
    }

    const existingProvider = providers.find((entry) => entry?.id === providerId);
    if (!existingProvider) {
      showNotice("error", `Provider '${providerId}' was not found.`);
      return false;
    }

    const nextRows = (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        ...row,
        id: String(row?.id || "").trim()
      }))
      .filter((row) => row.id);
    const resolvedProviderId = providerDraft ? String(providerDraft?.id || "").trim() || providerId : providerId;
    const endpoints = providerDraft
      ? (Array.isArray(providerDraft?.endpoints)
        ? normalizeUniqueTrimmedValues(providerDraft.endpoints)
        : mergeChipValuesAndDraft([], providerDraft?.endpoint || ""))
      : collectQuickStartEndpoints(existingProvider);
    const currentModelIds = (Array.isArray(existingProvider?.models) ? existingProvider.models : [])
      .map((model) => String(model?.id || "").trim())
      .filter(Boolean);
    const newModelIds = nextRows
      .map((row) => row.id)
      .filter((modelId) => !currentModelIds.includes(modelId));

    if (inferQuickStartConnectionType(existingProvider) === "api" && newModelIds.length > 0) {
      if (endpoints.length === 0) {
        showNotice("warning", `Provider '${resolvedProviderId}' needs at least one endpoint before testing new models.`);
        return false;
      }

      const credentialPayload = getDraftProviderCredentialPayload(providerDraft, existingProvider);
      if (!credentialPayload.apiKey && !credentialPayload.apiKeyEnv) {
        showNotice("warning", `Provider '${resolvedProviderId}' needs an API key or env before testing new models.`);
        return false;
      }

      const testOutcome = await testNewProviderModels({
        providerId: resolvedProviderId,
        endpoints,
        newModelIds,
        credentialPayload,
        headers: existingProvider?.headers,
        onModelTestStateChange
      });
      if (!testOutcome.ok) {
        return false;
      }
    }

    const nextConfig = applyProviderModelEdits(parsedDraftState.value || persistedConfig, providerId, nextRows);
    try {
      const successMessage = newModelIds.length > 0
        ? `Tested ${newModelIds.length} new model${newModelIds.length === 1 ? "" : "s"} and updated ${providerId}.`
        : `Updated models for ${providerId}.`;
      await saveInlineConfigObject(nextConfig, successMessage);
      onModelTestStateChange?.({
        phase: "",
        modelStates: {},
        failedModelIds: [],
        message: ""
      });
      return true;
    } catch {
      return false;
    }
  }

  async function handleApplyModelAlias(aliasId, draftAlias) {
    if (providerEditorDisabledReason) {
      showNotice("warning", providerEditorDisabledReason);
      return false;
    }

    const nextConfig = applyModelAliasEdits(parsedDraftState.value || persistedConfig, aliasId, draftAlias);
    const resolvedAliasId = String(draftAlias?.id || aliasId || "").trim() || aliasId;
    try {
      await saveInlineConfigObject(nextConfig, `Updated alias ${resolvedAliasId}.`);
      return true;
    } catch {
      return false;
    }
  }

  async function handleRemoveModelAlias(aliasId) {
    if (providerEditorDisabledReason) {
      showNotice("warning", providerEditorDisabledReason);
      return;
    }

    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm(`Remove alias "${aliasId}" from the config?`);
    if (!confirmed) return;

    const nextConfig = removeModelAlias(parsedDraftState.value || persistedConfig, aliasId);
    try {
      await saveInlineConfigObject(nextConfig, `Removed alias ${aliasId}.`);
    } catch {
    }
  }

  async function handleCopyEndpoint(endpoint) {
    try {
      await copyTextToClipboard(endpoint?.url || "");
      showNotice("success", `${endpoint?.label || "Endpoint"} copied to clipboard.`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleToggleAmpGlobalRouting() {
    const routingEnabled = ampClientGlobal?.routedViaRouter === true;
    const shouldEnable = !routingEnabled;

    if (shouldEnable) {
      if (ampDisabledReason) {
        showNotice("warning", ampDisabledReason);
        return;
      }
      if (!effectiveMasterKey) {
        showNotice("warning", "Gateway key is still generating. Try again in a second.");
        return;
      }
      if (!ampClientUrl) {
        showNotice("warning", "API endpoint is not ready yet.");
        return;
      }
    }

    setAmpRoutingBusy(shouldEnable ? "enable" : "disable");
    try {
      let usedCompatFallback = false;
      let payload;
      try {
        payload = await fetchJson("/api/amp/global-route", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            enabled: shouldEnable,
            rawText: shouldEnable ? draftText : undefined,
            endpointUrl: ampClientUrl
          })
        });
      } catch (error) {
        if (error?.statusCode === 404 && shouldEnable) {
          usedCompatFallback = true;
          payload = await fetchJson("/api/amp/apply", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({
              rawText: draftText,
              source: "amp-global-route-compat",
              patchScope: "global",
              endpointUrl: ampClientUrl
            })
          });
        } else if (error?.statusCode === 404) {
          throw new Error("Restart the web console so the AMP routing endpoint is available.");
        } else {
          throw error;
        }
      }
      await loadState({ preserveDraft: !shouldEnable });
      const successMessage = shouldEnable ? "AMP connected." : "AMP disconnected.";
      showNotice("success", usedCompatFallback ? `${successMessage} Restart the web console if the AMP status does not refresh.` : successMessage);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setAmpRoutingBusy("");
    }
  }

  function handleAmpInboundChange(entryId, value) {
    if (ampDisabledReason) {
      showNotice("warning", ampDisabledReason);
      return;
    }

    const normalizedValue = String(value || "").trim();
    const duplicateEntry = ampRows.find((entry) => entry.id !== entryId && String(entry?.inbound || "").trim() === normalizedValue);
    if (normalizedValue && duplicateEntry) {
      showNotice("warning", `AMP inbound match "${normalizedValue}" already exists.`);
      return;
    }

    const nextConfig = updateAmpEditableRouteConfig(parsedDraftState.value || persistedConfig, entryId, { inbound: value });
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText);
  }

  function handleAmpOutboundChange(entryId, value) {
    if (ampDisabledReason) {
      showNotice("warning", ampDisabledReason);
      return;
    }

    const nextConfig = updateAmpEditableRouteConfig(parsedDraftState.value || persistedConfig, entryId, {
      outbound: value === "__default__" ? "" : value
    });
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText);
  }

  function handleWebSearchStrategyChange(value) {
    if (webSearchDisabledReason) {
      showNotice("warning", webSearchDisabledReason);
      return;
    }

    const nextConfig = updateWebSearchConfig(parsedDraftState.value || persistedConfig, {
      strategy: value
    });
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText);
  }

  function handleWebSearchProviderChange(providerId, field, value) {
    if (webSearchDisabledReason) {
      showNotice("warning", webSearchDisabledReason);
      return;
    }

    const nextConfig = updateWebSearchProviderConfig(parsedDraftState.value || persistedConfig, providerId, {
      [field]: value
    });
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText, {
      immediate: shouldImmediateAutosaveWebSearchProviderChange(providerId, field, value)
    });
  }

  function handleWebSearchProviderMove(providerId, direction) {
    if (webSearchDisabledReason) {
      showNotice("warning", webSearchDisabledReason);
      return;
    }

    const nextConfig = moveWebSearchProviderConfig(parsedDraftState.value || persistedConfig, providerId, direction);
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText);
  }

  function handleRemoveWebSearchProvider(providerId) {
    if (webSearchDisabledReason) {
      showNotice("warning", webSearchDisabledReason);
      return;
    }

    const nextConfig = removeWebSearchProviderConfig(parsedDraftState.value || persistedConfig, providerId);
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText, { immediate: true });
  }

  async function handleAddHostedSearchEndpoint({ providerId, modelId }) {
    if (webSearchDisabledReason) {
      throw new Error(webSearchDisabledReason);
    }

    const routeId = buildHostedWebSearchProviderId(providerId, modelId);
    if (!routeId) {
      throw new Error("Choose a provider and GPT model before testing.");
    }

    const existingIds = new Set(
      (Array.isArray(webSearchConfig?.providers) ? webSearchConfig.providers : [])
        .map((provider) => normalizeWebSearchProviderKey(provider?.id))
        .filter(Boolean)
    );
    if (existingIds.has(normalizeWebSearchProviderKey(routeId))) {
      throw new Error(`Web search route '${routeId}' is already configured.`);
    }

    const payload = await fetchJson("/api/config/test-web-search-provider", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        providerId,
        modelId,
        rawText: draftText
      })
    });

    const nextConfig = addHostedWebSearchProviderConfig(parsedDraftState.value || persistedConfig, providerId, modelId);
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText, { immediate: true });
    showNotice("success", `Added ${routeId} to shared web search routing.`);
    return payload?.result || null;
  }

  async function handleCreateAmpEntry({ inbound, outbound }) {
    if (ampDisabledReason) {
      showNotice("warning", ampDisabledReason);
      return false;
    }

    const normalizedInbound = String(inbound || "").trim();
    if (normalizedInbound && ampRows.some((entry) => String(entry?.inbound || "").trim() === normalizedInbound)) {
      showNotice("warning", `AMP inbound match "${normalizedInbound}" already exists.`);
      return false;
    }

    const nextConfig = createAmpEditableRoute(parsedDraftState.value || persistedConfig, {
      inbound,
      outbound
    });
    try {
      await saveInlineConfigObject(nextConfig, `Added AMP route ${String(inbound || "").trim()}.`);
      return true;
    } catch {
      return false;
    }
  }

  async function handleRemoveAmpEntry(entryId) {
    const entry = findAmpEditableRouteEntry(parsedDraftState.value || persistedConfig, entryId);
    if (!entry?.removable) return;

    const label = entry.source === "raw"
      ? entry.inbound || entry.label
      : entry.routeKey || entry.label;
    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm(`Remove AMP route mapping "${label}"?`);
    if (!confirmed) return;

    const nextConfig = removeAmpEditableRoute(parsedDraftState.value || persistedConfig, entryId);
    try {
      await saveInlineConfigObject(nextConfig, `Removed AMP route ${label}.`);
    } catch {
    }
  }

  function handleResetDraft() {
    setDraftText(baselineText);
    setValidation({ rawText: baselineText, summary: snapshot?.config, validationMessages: snapshot?.config?.validationMessages || [] });
    setRemoteConfigUpdated(false);
    showNotice("success", "Editor reset to the latest disk version.");
  }

  function handleApplyQuickStartDraft(rawText) {
    handleDraftChange(rawText);
    setRemoteConfigUpdated(false);
    showNotice("success", "Quick-start config loaded into the editor.");
  }

  async function handleValidateQuickStart(rawText) {
    handleDraftChange(rawText);
    try {
      await validateDraftText(rawText);
    } catch {
    }
  }

  async function handleSaveQuickStart(rawText) {
    handleDraftChange(rawText);
    let validationPayload;
    try {
      validationPayload = await validateDraftText(rawText, { silent: true });
    } catch {
      return null;
    }

    const summary = validationPayload?.summary || {};
    const isValid = !summary.parseError && (summary.validationErrors || []).length === 0;
    if (!isValid) {
      showNotice("warning", summary.validationSummary || "Quick-start config still needs review.");
      return null;
    }

    try {
      return await saveDraftText(rawText, { successMessage: "Quick-start config saved." });
    } catch {
      return null;
    }
  }

  async function handleSaveAndStartQuickStart(rawText) {
    const savedSnapshot = await handleSaveQuickStart(rawText);
    if (!savedSnapshot) return false;

    setActiveTab("activity");

    if (savedSnapshot.router?.running) {
      showNotice("success", "Quick-start config saved. Router is already running.");
      return true;
    }

    showNotice("success", "Quick-start config saved. Starting router…");
    setTimeout(() => {
      void runRouterAction("start");
    }, 0);
    return true;
  }

  async function handleSaveQuickStartAndClose(rawText) {
    const savedSnapshot = await handleSaveQuickStart(rawText);
    if (savedSnapshot) handleHideQuickStart();
    return Boolean(savedSnapshot);
  }

  async function handleSaveAndStartQuickStartAndClose(rawText) {
    const saved = await handleSaveAndStartQuickStart(rawText);
    if (saved) handleHideQuickStart();
    return saved;
  }

  async function handleOpenConfigFileDefault() {
    setOpenEditorBusy(true);
    try {
      await fetchJson("/api/config/open", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ editorId: "default" })
      });
      showNotice("success", "Opened config file in the default app.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setOpenEditorBusy(false);
    }
  }

  async function handleToggleCodexCliRouting() {
    const routingEnabled = codexCliState?.routedViaRouter === true;
    const shouldEnable = !routingEnabled;

    if (shouldEnable) {
      if (codingToolDisabledReason) {
        showNotice("warning", codingToolDisabledReason);
        return;
      }
      if (!effectiveMasterKey) {
        showNotice("warning", "Gateway key is still generating. Try again in a second.");
        return;
      }
      if (!ampClientUrl) {
        showNotice("warning", "API endpoint is not ready yet.");
        return;
      }
    }

    setCodexRoutingBusy(shouldEnable ? "enable" : "disable");
    try {
      await fetchJson("/api/codex-cli/global-route", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          enabled: shouldEnable,
          rawText: shouldEnable ? draftText : undefined,
          endpointUrl: ampClientUrl,
          bindings: shouldEnable ? {
            defaultModel: codexCliState?.bindings?.defaultModel || ampDefaultRoute,
            thinkingLevel: codexCliState?.bindings?.thinkingLevel || ""
          } : undefined
        })
      });
      await loadState({ preserveDraft: !shouldEnable });
      showNotice("success", shouldEnable ? "Codex CLI connected." : "Codex CLI disconnected.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setCodexRoutingBusy("");
    }
  }

  async function handleToggleClaudeCodeRouting() {
    const routingEnabled = claudeCodeState?.routedViaRouter === true;
    const shouldEnable = !routingEnabled;

    if (shouldEnable) {
      if (codingToolDisabledReason) {
        showNotice("warning", codingToolDisabledReason);
        return;
      }
      if (!effectiveMasterKey) {
        showNotice("warning", "Gateway key is still generating. Try again in a second.");
        return;
      }
      if (!ampClientUrl) {
        showNotice("warning", "API endpoint is not ready yet.");
        return;
      }
    }

    setClaudeRoutingBusy(shouldEnable ? "enable" : "disable");
    try {
      await fetchJson("/api/claude-code/global-route", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          enabled: shouldEnable,
          rawText: shouldEnable ? draftText : undefined,
          endpointUrl: ampClientUrl,
          bindings: shouldEnable ? {
            primaryModel: claudeCodeState?.bindings?.primaryModel || "",
            defaultOpusModel: claudeCodeState?.bindings?.defaultOpusModel || "",
            defaultSonnetModel: claudeCodeState?.bindings?.defaultSonnetModel || "",
            defaultHaikuModel: claudeCodeState?.bindings?.defaultHaikuModel || "",
            subagentModel: claudeCodeState?.bindings?.subagentModel || "",
            thinkingLevel: claudeCodeState?.bindings?.thinkingLevel || ""
          } : undefined
        })
      });
      await loadState({ preserveDraft: !shouldEnable });
      showNotice("success", shouldEnable ? "Claude Code connected." : "Claude Code disconnected.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setClaudeRoutingBusy("");
    }
  }

  async function handleCodexBindingChange(fieldId, value) {
    const nextBindings = {
      defaultModel: codexCliState?.bindings?.defaultModel || ampDefaultRoute,
      thinkingLevel: codexCliState?.bindings?.thinkingLevel || ""
    };
    nextBindings[fieldId] = value;

    setCodexBindingsBusy(true);
    try {
      await fetchJson("/api/codex-cli/model-bindings", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          bindings: nextBindings
        })
      });
      await loadState({ preserveDraft: true });
      showNotice("success", "Codex CLI bindings updated.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setCodexBindingsBusy(false);
    }
  }

  async function handleClaudeBindingChange(fieldId, value) {
    const isRoutedViaRouter = claudeCodeState?.routedViaRouter === true;

    if (fieldId === "thinkingLevel" && !isRoutedViaRouter) {
      setClaudeBindingsBusy(true);
      try {
        await fetchJson("/api/claude-code/effort-level", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ effortLevel: value })
        });
        await loadState({ preserveDraft: true });
        showNotice("success", value ? `Effort level set to ${value}.` : "Effort level cleared.");
      } catch (error) {
        showNotice("error", error instanceof Error ? error.message : String(error));
      } finally {
        setClaudeBindingsBusy(false);
      }
      return;
    }

    const nextBindings = {
      primaryModel: claudeCodeState?.bindings?.primaryModel || "",
      defaultOpusModel: claudeCodeState?.bindings?.defaultOpusModel || "",
      defaultSonnetModel: claudeCodeState?.bindings?.defaultSonnetModel || "",
      defaultHaikuModel: claudeCodeState?.bindings?.defaultHaikuModel || "",
      subagentModel: claudeCodeState?.bindings?.subagentModel || "",
      thinkingLevel: claudeCodeState?.bindings?.thinkingLevel || ""
    };
    nextBindings[fieldId] = value;

    setClaudeBindingsBusy(true);
    try {
      await fetchJson("/api/claude-code/model-bindings", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          bindings: nextBindings
        })
      });
      await loadState({ preserveDraft: true });
      showNotice("success", "Claude Code model bindings updated.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setClaudeBindingsBusy(false);
    }
  }

  async function handleToggleFactoryDroidRouting() {
    const routingEnabled = factoryDroidState?.routedViaRouter === true;
    const shouldEnable = !routingEnabled;

    if (shouldEnable) {
      if (codingToolDisabledReason) {
        showNotice("warning", codingToolDisabledReason);
        return;
      }
      if (!effectiveMasterKey) {
        showNotice("warning", "Gateway key is still generating. Try again in a second.");
        return;
      }
      if (!ampClientUrl) {
        showNotice("warning", "API endpoint is not ready yet.");
        return;
      }
    }

    setFactoryDroidRoutingBusy(shouldEnable ? "enable" : "disable");
    try {
      await fetchJson("/api/factory-droid/global-route", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          enabled: shouldEnable,
          rawText: shouldEnable ? draftText : undefined,
          endpointUrl: ampClientUrl,
          bindings: shouldEnable ? {
            defaultModel: factoryDroidState?.bindings?.defaultModel || "",
            reasoningEffort: factoryDroidState?.bindings?.reasoningEffort || ""
          } : undefined
        })
      });
      await loadState({ preserveDraft: !shouldEnable });
      showNotice("success", shouldEnable ? "Factory Droid connected." : "Factory Droid disconnected.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setFactoryDroidRoutingBusy("");
    }
  }

  async function handleFactoryDroidBindingChange(fieldId, value) {
    const nextBindings = {
      defaultModel: factoryDroidState?.bindings?.defaultModel || "",
      reasoningEffort: factoryDroidState?.bindings?.reasoningEffort || ""
    };
    nextBindings[fieldId] = value;

    setFactoryDroidBindingsBusy(true);
    try {
      await fetchJson("/api/factory-droid/model-bindings", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          bindings: nextBindings
        })
      });
      await loadState({ preserveDraft: true });
      showNotice("success", "Factory Droid model bindings updated.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setFactoryDroidBindingsBusy(false);
    }
  }

  async function runRouterAction(action) {
    setRouterBusy(action);
    try {
      const payload = await fetchJson(`/api/router/${action}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}"
      });
      applySnapshot(payload, { preserveDraft: true });
      showNotice("success", payload.message || `Router ${action}ed.`);
    } catch (error) {
      await loadState({ preserveDraft: true }).catch(() => {});
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setRouterBusy("");
    }
  }

  async function runStartupAction(action) {
    setStartupBusy(action);
    try {
      const payload = await fetchJson(`/api/startup/${action}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}"
      });
      applySnapshot(payload, { preserveDraft: true });
      showNotice("success", payload.message || `Startup ${action}d.`);
    } catch (error) {
      await loadState({ preserveDraft: true }).catch(() => {});
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setStartupBusy("");
    }
  }

  async function handleToggleActivityLog() {
    const nextEnabled = !activityLogEnabled;
    setActivityLogBusy("toggle");
    try {
      const payload = await fetchJson("/api/activity-log/settings", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: nextEnabled })
      });
      applySnapshot(payload, { preserveDraft: true });
      showNotice("success", payload.message || `Activity log ${nextEnabled ? "enabled" : "disabled"}.`);
    } catch (error) {
      await loadState({ preserveDraft: true }).catch(() => {});
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setActivityLogBusy("");
    }
  }

  async function handleClearActivityLog() {
    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm("Clear the shared activity log file? This also clears the Activity tab for connected web console sessions.");
    if (!confirmed) return;

    setActivityLogBusy("clear");
    try {
      const payload = await fetchJson("/api/activity-log/clear", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}"
      });
      applySnapshot(payload, { preserveDraft: true });
      showNotice("success", payload.message || "Activity log cleared.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setActivityLogBusy("");
    }
  }

  async function handleRemoveProvider(providerId) {
    const provider = providers.find((entry) => entry.id === providerId);
    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm(`Remove provider "${provider?.name || providerId}" from the config?`);
    if (!confirmed) return;

    const nextConfig = removeProviderFromConfig(snapshot?.config?.document || parsedDraftConfig || {}, providerId);
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);

    try {
      await saveDraftText(rawText, { successMessage: `Removed provider ${provider?.name || providerId}.` });
    } catch {
    }
  }

  // ── Ollama handlers ──────────────────────────────────────────────
  async function refreshOllamaModels() {
    setOllamaRefreshing(true);
    try {
      const res = await fetch("/api/ollama/models", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = await res.json();
      if (data?.models) setOllamaModels(data.models);
    } catch { /* ignore */ } finally { setOllamaRefreshing(false); }
  }
  useEffect(() => { if (activeTab === "ollama" && ollamaTabConnected) refreshOllamaModels(); }, [activeTab, ollamaTabConnected]);

  function setOllamaBusyKey(model, key, value) {
    setOllamaBusy((prev) => ({ ...prev, [model]: { ...(prev[model] || {}), [key]: value } }));
  }
  async function handleOllamaLoad(model) {
    setOllamaBusyKey(model, "loading", true);
    try { await fetch("/api/ollama/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) }); await refreshOllamaModels(); } finally { setOllamaBusyKey(model, "loading", false); }
  }
  async function handleOllamaUnload(model) {
    setOllamaBusyKey(model, "unloading", true);
    try { await fetch("/api/ollama/unload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) }); await refreshOllamaModels(); } finally { setOllamaBusyKey(model, "unloading", false); }
  }
  async function handleOllamaPin(model, pinned) {
    setOllamaBusyKey(model, "pinning", true);
    try { await fetch("/api/ollama/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, pinned }) }); await refreshOllamaModels(); } finally { setOllamaBusyKey(model, "pinning", false); }
  }
  async function handleOllamaKeepAlive(model, keepAlive) {
    await fetch("/api/ollama/keep-alive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, keepAlive }) });
    await refreshOllamaModels();
  }
  async function handleOllamaContextLength(model, contextLength) {
    await fetch("/api/ollama/context-length", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, contextLength }) });
    await refreshOllamaModels();
  }
  async function handleOllamaAddToRouter(model) {
    await fetch("/api/ollama/add-model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
    await refreshOllamaModels();
  }
  async function handleOllamaRemoveFromRouter(model) {
    await fetch("/api/ollama/remove-model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
    await refreshOllamaModels();
  }
  async function handleOllamaAutoLoad(model, autoLoad) {
    await fetch("/api/ollama/auto-load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, autoLoad }) });
  }
  async function handleOllamaSaveSettings(settings) {
    await fetch("/api/ollama/save-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
  }
  async function handleOllamaInstall() {
    setOllamaBusy((prev) => ({ ...prev, _install: true }));
    try { await fetch("/api/ollama/install", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } finally { setOllamaBusy((prev) => ({ ...prev, _install: false })); }
  }
  async function handleOllamaStartServer() {
    setOllamaBusy((prev) => ({ ...prev, _startServer: true }));
    try { await fetch("/api/ollama/start-server", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } finally { setOllamaBusy((prev) => ({ ...prev, _startServer: false })); }
  }
  async function handleOllamaStopServer() {
    await fetch("/api/ollama/stop-server", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  }
  async function handleOllamaSyncRouter() {
    setOllamaBusy((prev) => ({ ...prev, _syncRouter: true }));
    try { await fetch("/api/ollama/sync-router", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await refreshOllamaModels(); } finally { setOllamaBusy((prev) => ({ ...prev, _syncRouter: false })); }
  }

  if (loading) {
    return (
      <div className="console-shell flex min-h-screen items-center justify-center px-6 py-10">
        <Card className="w-full max-w-lg">
          <CardContent className="space-y-3 p-6 text-center">
            <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">LLM Router</div>
            <div className="text-xl font-semibold text-foreground">Loading web console…</div>
            <div className="text-sm text-muted-foreground">Preparing config state, router controls, and live activity.</div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (showOnboarding) {
    return (
      <div className="console-shell min-h-screen px-4 py-6 md:px-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          <ToastStack notices={notices} onDismiss={dismissNotice} />
          <div id="quick-start-wizard">
            <QuickStartWizard
              key={`onboarding-wizard-${onboardingSeedMode}-${onboardingTargetProviderId || "new"}`}
              baseConfig={parsedDraftConfig}
              seedMode={onboardingSeedMode}
              mode="onboarding"
              targetProviderId={onboardingTargetProviderId}
              defaultProviderUserAgent={defaultProviderUserAgent}
              onApplyDraft={handleApplyQuickStartDraft}
              onValidateDraft={handleValidateQuickStart}
              onSaveDraft={handleSaveQuickStart}
              onSaveAndStart={handleSaveAndStartQuickStart}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="console-shell min-h-screen px-4 py-4 md:px-6 md:py-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <Card className="overflow-hidden">
          <CardContent className="p-5">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h1 className="inline-flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
                    <span>LLM Router Web Console</span>
                    <ConnectedIndicatorDot connected={routerRunning} size="md" srLabel="Router running" />
                  </h1>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <a
                    href={GITHUB_SPONSORS_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex h-8 items-center gap-2 rounded-lg border border-amber-300 bg-amber-50/90 px-3 text-xs font-medium uppercase tracking-[0.16em] text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-label="Support LLM Router via GitHub Sponsors"
                    title="Support LLM Router"
                  >
                    <HeartIcon className="h-3.5 w-3.5" />
                    <span>Buy me a coffee</span>
                  </a>
                  <a
                    href={GITHUB_REPO_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-background/80 px-3 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-label="Open the LLM Router GitHub repository"
                    title="Open GitHub repository"
                  >
                    <GitHubIcon className="h-3.5 w-3.5" />
                    <span>Repo</span>
                  </a>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={routerRunning ? "outline" : undefined}
                    className="px-2 sm:px-3"
                    onClick={() => runRouterAction(routerRunning ? "stop" : "start")}
                    disabled={routerBusy !== ""}
                    aria-label={routerActionLabel}
                    title={routerActionLabel}
                  >
                    {routerRunning ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">{routerActionLabel}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="px-2 sm:px-3"
                    onClick={handleOpenConfigFileDefault}
                    disabled={openEditorBusy}
                    aria-label={openEditorBusy ? "Opening config file" : "Open config file"}
                    title={openEditorBusy ? "Opening config file" : "Open config file"}
                  >
                    <FolderIcon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{openEditorBusy ? "Opening…" : "Open config file"}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="px-2 sm:px-3"
                    onClick={() => runStartupAction(startupInstalled ? "disable" : "enable")}
                    disabled={startupBusy !== ""}
                    aria-label={startupActionLabel}
                    title={startupActionLabel}
                  >
                    <PowerIcon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{startupActionLabel}</span>
                  </Button>
                </div>
                <HeaderAccessGroup
                  endpointValue={ampClientUrl || LOCAL_ROUTER_ORIGIN}
                  endpointDisabled={!ampClientUrl}
                  gatewayValue={effectiveMasterKey ? maskedMasterKey : "Generating…"}
                  gatewayPending={!effectiveMasterKey}
                  gatewayDisabled={!effectiveMasterKey || saving}
                  rotateDisabled={saving}
                  onCopyEndpoint={handleCopyApiEndpoint}
                  onCopyGatewayKey={handleCopyMasterKey}
                  onRotateKey={handleRotateMasterKey}
                />
              </div>
              {(saving || validating) ? (
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full bg-secondary px-2.5 py-1">{saving ? "Saving changes…" : "Validating…"}</span>
                </div>
              ) : null}
              {!routerRunning && snapshot?.router?.portBusy && !snapshot?.router?.portBusySelf ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => runRouterAction("reclaim")} disabled={routerBusy !== ""}>
                    {routerBusy === "reclaim" ? "Reclaiming…" : `Reclaim port ${LOCAL_ROUTER_PORT}`}
                  </Button>
                </div>
              ) : null}
              {routerStatusMessage ? (
                <div className={cn(
                  "rounded-xl border px-3 py-2 text-sm",
                  snapshot?.router?.portBusy
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : "border-rose-200 bg-rose-50 text-rose-800"
                )}>
                  {routerStatusMessage}
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <ToastStack notices={notices} onDismiss={dismissNotice} />

        <div className="space-y-4">
          <ProviderModelsSection
            providers={providers.filter((p) => p?.type !== "ollama")}
            onAddProvider={handleOpenQuickStart}
            onRemove={handleRemoveProvider}
            onCopyModelId={handleCopyProviderModelId}
            onApplyProviderDetails={handleApplyProviderDetails}
            onApplyProviderModels={handleApplyProviderModels}
            onSaveAndCloseEditor={handleSaveProviderEditorChanges}
            disabledReason={providerEditorDisabledReason}
            busy={saving}
          />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-0">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <TabsList>
              <TabsTrigger value="model-alias">Alias &amp; Fallback</TabsTrigger>
              <TabsTrigger value="amp">
                <span className="inline-flex items-center gap-2">
                  <span>AMP</span>
                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">Exp</span>
                  <ConnectedIndicatorDot connected={ampTabConnected} srLabel="AMP connected" />
                </span>
              </TabsTrigger>
              <TabsTrigger value="codex-cli">
                <span className="inline-flex items-center gap-2">
                  <span>Codex CLI</span>
                  <ConnectedIndicatorDot connected={codexTabConnected} srLabel="Codex CLI connected" />
                </span>
              </TabsTrigger>
              <TabsTrigger value="claude-code">
                <span className="inline-flex items-center gap-2">
                  <span>Claude Code</span>
                  <ConnectedIndicatorDot connected={claudeTabConnected} srLabel="Claude Code connected" />
                </span>
              </TabsTrigger>
              <TabsTrigger value="factory-droid">
                <span className="inline-flex items-center gap-2">
                  <span>Factory Droid</span>
                  <ConnectedIndicatorDot connected={factoryDroidTabConnected} srLabel="Factory Droid connected" />
                </span>
              </TabsTrigger>
              <TabsTrigger value="ollama">
                <span className="inline-flex items-center gap-2">
                  <span>Ollama</span>
                  <ConnectedIndicatorDot connected={ollamaTabConnected} srLabel="Ollama connected" />
                </span>
              </TabsTrigger>
              <TabsTrigger value="web-search">Web Search</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="model-alias" className="space-y-4">
            <ModelAliasSection
              aliases={modelAliases}
              config={editableConfig}
              aliasIds={Object.keys(modelAliases)}
              routeOptions={managedRouteOptions}
              defaultModel={String(editableConfig?.defaultModel || "").trim()}
              ampDefaultRoute={ampDefaultRoute}
              disabledReason={providerEditorDisabledReason}
              busy={saving}
              onApplyAlias={handleApplyModelAlias}
              onRemoveAlias={handleRemoveModelAlias}
              onCopyAliasId={handleCopyAliasId}
            />
          </TabsContent>

          <TabsContent value="amp" className="space-y-4">
            <AmpSettingsPanel
              rows={ampRows}
              routeOptions={ampRouteOptions}
              webSearchSnapshot={webSearchSnapshot}
              ampClientUrl={ampClientUrl}
              ampClientGlobal={ampClientGlobal}
              routingBusy={ampRoutingBusy}
              onToggleGlobalRouting={handleToggleAmpGlobalRouting}
              onInboundChange={handleAmpInboundChange}
              onOutboundChange={handleAmpOutboundChange}
              onCreateEntry={handleCreateAmpEntry}
              onRemoveEntry={handleRemoveAmpEntry}
              onOpenWebSearchTab={() => setActiveTab("web-search")}
              onOpenConfigPath={() => handleOpenFilePath(ampClientGlobal?.settingsFilePath, "AMP config file", {
                ensureMode: "jsonObject",
                successMessage: "Opened AMP config file in the default app."
              })}
              onOpenSecretsPath={() => handleOpenFilePath(ampClientGlobal?.secretsFilePath, "AMP secrets file", {
                ensureMode: "jsonObject",
                successMessage: "Opened AMP secrets file in the default app."
              })}
              hasMasterKey={Boolean(String(ampEditableConfig?.masterKey || "").trim())}
              disabledReason={ampDisabledReason}
              autosaveState={ampAutosaveState}
            />
          </TabsContent>

          <TabsContent value="codex-cli" className="space-y-4">
            <CodingToolSettingsPanel
              toolName="Codex CLI"
              toolState={codexCliState}
              endpointUrl={codexCliState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/openai/v1` : ""}`}
              routeOptions={codexRouteOptions}
              connectionBusy={codexRoutingBusy}
              bindingBusy={codexBindingsBusy}
              onToggleRouting={handleToggleCodexCliRouting}
              onBindingChange={handleCodexBindingChange}
              hasMasterKey={Boolean(effectiveMasterKey)}
              disabledReason={codingToolDisabledReason}
              onOpenPrimaryPath={() => handleOpenFilePath(codexCliState?.configFilePath, "Codex CLI config file", {
                ensureMode: "text",
                successMessage: "Opened Codex CLI config file in the default app."
              })}
              onOpenSecondaryPath={() => handleOpenFilePath(codexCliState?.backupFilePath, "Codex CLI backup file", {
                ensureMode: "jsonObject",
                successMessage: "Opened Codex CLI backup file in the default app."
              })}
              guideContent={buildCodexCliGuideContent({
                bindingValue: codexCliState?.bindings?.defaultModel,
                thinkingLevel: codexCliState?.bindings?.thinkingLevel,
                configFilePath: codexCliState?.configFilePath,
                endpointUrl: codexCliState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/openai/v1` : ""}`
              })}
              bindingFields={[
                {
                  id: "defaultModel",
                  label: "Default model",
                  description: "Choose a managed route/alias to set Codex CLI `model`, or use Inherit Codex CLI model to keep Codex built-in model names and route them through same-name LLM Router aliases.",
                  envKey: "model",
                  value: codexCliState?.bindings?.defaultModel || "",
                  allowUnset: false,
                  placeholder: "Select a default route",
                  extraOptions: [{
                    value: CODEX_CLI_INHERIT_MODEL_VALUE,
                    label: "Inherit Codex CLI model",
                    hint: "Keep Codex built-in model names; route them via same-name aliases in LLM Router"
                  }]
                },
                {
                  id: "thinkingLevel",
                  label: "Thinking level",
                  description: "Maps to Codex CLI `model_reasoning_effort`. Official values are `minimal`, `low`, `medium`, `high`, and `xhigh` (`xhigh` is model-dependent).",
                  envKey: "model_reasoning_effort",
                  value: codexCliState?.bindings?.thinkingLevel || "",
                  allowUnset: true,
                  usesRouteOptions: false,
                  placeholder: "Inherit Codex default",
                  options: CODEX_THINKING_LEVEL_OPTIONS
                }
              ]}
            />
          </TabsContent>

          <TabsContent value="claude-code" className="space-y-4">
            <CodingToolSettingsPanel
              toolName="Claude Code"
              toolState={claudeCodeState}
              endpointUrl={claudeCodeState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/anthropic` : ""}`}
              routeOptions={claudeRouteOptions}
              connectionBusy={claudeRoutingBusy}
              bindingBusy={claudeBindingsBusy}
              onToggleRouting={handleToggleClaudeCodeRouting}
              onBindingChange={handleClaudeBindingChange}
              hasMasterKey={Boolean(effectiveMasterKey)}
              disabledReason={codingToolDisabledReason}
              onOpenPrimaryPath={() => handleOpenFilePath(claudeCodeState?.settingsFilePath, "Claude Code config file", {
                ensureMode: "jsonObject",
                successMessage: "Opened Claude Code config file in the default app."
              })}
              onOpenSecondaryPath={() => handleOpenFilePath(claudeCodeState?.backupFilePath, "Claude Code backup file", {
                ensureMode: "jsonObject",
                successMessage: "Opened Claude Code backup file in the default app."
              })}
              guideContent={buildClaudeCodeGuideContent({
                bindings: claudeCodeState?.bindings,
                settingsFilePath: claudeCodeState?.settingsFilePath,
                endpointUrl: claudeCodeState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/anthropic` : ""}`
              })}
              bindingFields={[
                {
                  id: "primaryModel",
                  label: "Current model override",
                  description: "Optional. Set `ANTHROPIC_MODEL` only when you want to override Claude Code’s own `model` setting with a managed route or alias.",
                  envKey: "ANTHROPIC_MODEL",
                  value: claudeCodeState?.bindings?.primaryModel || "",
                  allowUnset: true,
                  placeholder: "Inherit Claude Code default"
                },
                {
                  id: "defaultOpusModel",
                  label: "Default Opus",
                  description: "Maps `ANTHROPIC_DEFAULT_OPUS_MODEL` so Claude Code’s `opus` alias points to a managed route or alias.",
                  envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL",
                  value: claudeCodeState?.bindings?.defaultOpusModel || "",
                  allowUnset: true,
                  placeholder: "Select an Opus route"
                },
                {
                  id: "defaultSonnetModel",
                  label: "Default Sonnet",
                  description: "Maps `ANTHROPIC_DEFAULT_SONNET_MODEL` so Claude Code’s `sonnet` alias points to a managed route or alias.",
                  envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
                  value: claudeCodeState?.bindings?.defaultSonnetModel || "",
                  allowUnset: true,
                  placeholder: "Select a Sonnet route"
                },
                {
                  id: "defaultHaikuModel",
                  label: "Default Haiku",
                  description: "Maps `ANTHROPIC_DEFAULT_HAIKU_MODEL` so Claude Code’s `haiku` alias points to a managed route or alias.",
                  envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                  value: claudeCodeState?.bindings?.defaultHaikuModel || "",
                  allowUnset: true,
                  placeholder: "Select a Haiku route"
                },
                {
                  id: "subagentModel",
                  label: "Sub-agent model",
                  description: "Maps `CLAUDE_CODE_SUBAGENT_MODEL` for Claude Code sub-agents and background workers.",
                  envKey: "CLAUDE_CODE_SUBAGENT_MODEL",
                  value: claudeCodeState?.bindings?.subagentModel || "",
                  allowUnset: true,
                  placeholder: "Select a sub-agent route"
                },
                {
                  id: "thinkingLevel",
                  label: "Effort level",
                  description: "Sets `CLAUDE_CODE_EFFORT_LEVEL` in your shell profile (~/.zshrc or ~/.bashrc). Falls back to `effortLevel` in settings.json (only \"high\") if shell profile cannot be updated.",
                  envKey: "CLAUDE_CODE_EFFORT_LEVEL",
                  value: claudeCodeState?.bindings?.thinkingLevel || "",
                  allowUnset: true,
                  usesRouteOptions: false,
                  standaloneWhenDisconnected: true,
                  placeholder: "Inherit Claude Code adaptive default",
                  options: CLAUDE_THINKING_LEVEL_OPTIONS
                }
              ]}
            />
          </TabsContent>

          <TabsContent value="factory-droid" className="space-y-4">
            <CodingToolSettingsPanel
              toolName="Factory Droid"
              toolState={factoryDroidState}
              endpointUrl={factoryDroidState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/openai/v1` : ""}`}
              routeOptions={factoryDroidRouteOptions}
              connectionBusy={factoryDroidRoutingBusy}
              bindingBusy={factoryDroidBindingsBusy}
              onToggleRouting={handleToggleFactoryDroidRouting}
              onBindingChange={handleFactoryDroidBindingChange}
              hasMasterKey={Boolean(effectiveMasterKey)}
              disabledReason={codingToolDisabledReason}
              onOpenPrimaryPath={() => handleOpenFilePath(factoryDroidState?.settingsFilePath, "Factory Droid config file", {
                ensureMode: "jsonObject",
                successMessage: "Opened Factory Droid config file in the default app."
              })}
              onOpenSecondaryPath={() => handleOpenFilePath(factoryDroidState?.backupFilePath, "Factory Droid backup file", {
                ensureMode: "jsonObject",
                successMessage: "Opened Factory Droid backup file in the default app."
              })}
              guideContent={buildFactoryDroidGuideContent({
                bindings: factoryDroidState?.bindings,
                settingsFilePath: factoryDroidState?.settingsFilePath,
                endpointUrl: factoryDroidState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/openai/v1` : ""}`
              })}
              bindingFields={[
                {
                  id: "defaultModel",
                  label: "Default model",
                  description: "Choose a managed route/alias to set Factory Droid `model`. This controls which upstream model Factory Droid uses by default.",
                  envKey: "model",
                  value: factoryDroidState?.bindings?.defaultModel || "",
                  allowUnset: true,
                  placeholder: "Select a default route"
                },
                {
                  id: "reasoningEffort",
                  label: "Reasoning effort",
                  description: "Maps to Factory Droid `reasoningEffort` setting. Controls the depth of extended thinking for supported models.",
                  envKey: "reasoningEffort",
                  value: factoryDroidState?.bindings?.reasoningEffort || "",
                  allowUnset: true,
                  usesRouteOptions: false,
                  placeholder: "Inherit Factory Droid default",
                  options: FACTORY_DROID_REASONING_EFFORT_OPTIONS
                }
              ]}
            />
          </TabsContent>

          <TabsContent value="ollama" className="space-y-4">
            <OllamaSettingsPanel
              connected={ollamaTabConnected}
              snapshot={ollamaSnapshot}
              models={ollamaModels}
              busy={ollamaBusy}
              refreshing={ollamaRefreshing}
              config={editableConfig}
              onRefresh={refreshOllamaModels}
              onLoad={handleOllamaLoad}
              onUnload={handleOllamaUnload}
              onPin={handleOllamaPin}
              onKeepAlive={handleOllamaKeepAlive}
              onContextLength={handleOllamaContextLength}
              onAddToRouter={handleOllamaAddToRouter}
              onRemoveFromRouter={handleOllamaRemoveFromRouter}
              onAutoLoad={handleOllamaAutoLoad}
              onSaveSettings={handleOllamaSaveSettings}
              onInstall={handleOllamaInstall}
              onStartServer={handleOllamaStartServer}
              onStopServer={handleOllamaStopServer}
              onSyncRouter={handleOllamaSyncRouter}
            />
          </TabsContent>

          <TabsContent value="web-search" className="space-y-4">
            <WebSearchSettingsPanel
              webSearchConfig={webSearchConfig}
              webSearchProviders={webSearchProviders}
              hostedSearchCandidates={hostedSearchCandidates}
              onWebSearchStrategyChange={handleWebSearchStrategyChange}
              onWebSearchProviderChange={handleWebSearchProviderChange}
              onWebSearchProviderMove={handleWebSearchProviderMove}
              onRemoveWebSearchProvider={handleRemoveWebSearchProvider}
              onAddHostedSearchEndpoint={handleAddHostedSearchEndpoint}
              disabledReason={webSearchDisabledReason}
              autosaveState={ampAutosaveState}
            />
          </TabsContent>

          <TabsContent value="activity">
            <LogList
              logs={snapshot?.logs || []}
              activityLogEnabled={activityLogEnabled}
              activityFilter={activityFilter}
              busyAction={activityLogBusy}
              onActivityFilterChange={setActivityFilter}
              onToggleEnabled={handleToggleActivityLog}
              onClear={handleClearActivityLog}
            />
          </TabsContent>
        </Tabs>

        <Modal
          open={showProviderWizardModal}
          onClose={handleHideQuickStart}
          title="Add provider"
          contentClassName="max-h-[92vh] max-w-5xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
          closeOnBackdrop={false}
          bodyClassName="max-h-[calc(92vh-5.5rem)]"
        >
          <QuickStartWizard
            key={`provider-wizard-modal-${providerWizardKey}`}
            baseConfig={parsedDraftConfig}
            seedMode="blank"
            mode="add"
            targetProviderId=""
            defaultProviderUserAgent={defaultProviderUserAgent}
            onApplyDraft={handleApplyQuickStartDraft}
            onValidateDraft={handleValidateQuickStart}
            onSaveDraft={handleSaveQuickStartAndClose}
            onSaveAndStart={handleSaveAndStartQuickStartAndClose}
            framed={false}
            showHeader={false}
          />
        </Modal>
      </div>
    </div>
  );
}
