import { RATE_LIMIT_WINDOW_OPTIONS } from "./rate-limit-utils.js";

export const JSON_HEADERS = { "content-type": "application/json" };
export const LOG_LEVEL_STYLES = {
  info: "bg-sky-50 text-sky-700 ring-sky-100",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  warn: "bg-amber-50 text-amber-700 ring-amber-100",
  error: "bg-rose-50 text-rose-700 ring-rose-100"
};
export const ACTIVITY_FILTER_OPTIONS = [
  { value: "usage", label: "Request / response" },
  { value: "router", label: "LLM Router" },
  { value: "all", label: "All categories" }
];
export const ACTIVITY_CATEGORY_META = {
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
export const GITHUB_REPO_URL = "https://github.com/khanglvm/llm-router";
export const GITHUB_SPONSORS_URL = "https://github.com/sponsors/khanglvm";

export const QUICK_START_FALLBACK_USER_AGENT = "AICodeClient/1.0.0";
export const LIVE_UPDATES_RETRY_MS = 3000;
export const TOAST_DURATION_MS = 4000;
export const TOAST_STATUS_TICK_MS = 100;
export const CONTEXT_LOOKUP_SUGGESTION_LIMIT = 6;
export const QUICK_START_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const QUICK_START_ALIAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]*$/;
export const QUICK_START_CONNECTION_CATEGORIES = [
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
export const MODEL_ALIAS_STRATEGY_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "ordered", label: "Ordered" },
  { value: "round-robin", label: "Round robin" },
  { value: "weighted-rr", label: "Weighted RR" },
  { value: "quota-aware-weighted-rr", label: "Quota-aware weighted RR" }
];
export const MODEL_ALIAS_STRATEGY_LABELS = Object.fromEntries(MODEL_ALIAS_STRATEGY_OPTIONS.map((option) => [option.value, option.label]));
export const CODEX_THINKING_LEVEL_OPTIONS = Object.freeze([
  { value: "minimal", label: "Minimal", hint: "Fastest supported reasoning" },
  { value: "low", label: "Low", hint: "Lighter reasoning" },
  { value: "medium", label: "Medium", hint: "Balanced depth" },
  { value: "high", label: "High", hint: "Deeper reasoning" },
  { value: "xhigh", label: "XHigh", hint: "Model-dependent extra depth" }
]);
export const CLAUDE_THINKING_LEVEL_OPTIONS = Object.freeze([
  { value: "low", label: "Low", hint: "Sets CLAUDE_CODE_EFFORT_LEVEL=low" },
  { value: "medium", label: "Medium", hint: "Sets CLAUDE_CODE_EFFORT_LEVEL=medium" },
  { value: "high", label: "High", hint: "Sets CLAUDE_CODE_EFFORT_LEVEL=high" },
  { value: "xhigh", label: "XHigh", hint: "Sets CLAUDE_CODE_EFFORT_LEVEL=xhigh" },
  { value: "max", label: "Max", hint: "Sets CLAUDE_CODE_EFFORT_LEVEL=max" }
]);
export const FACTORY_DROID_REASONING_EFFORT_OPTIONS = Object.freeze([
  { value: "off", label: "Off", hint: "Disable reasoning" },
  { value: "none", label: "None", hint: "No extended reasoning" },
  { value: "low", label: "Low", hint: "Lighter reasoning" },
  { value: "medium", label: "Medium", hint: "Balanced depth" },
  { value: "high", label: "High", hint: "Maximum reasoning depth" }
]);
export const QUICK_START_WINDOW_OPTIONS = RATE_LIMIT_WINDOW_OPTIONS;
export const QUICK_START_DEFAULT_ENDPOINT_BY_PROTOCOL = {
  openai: "https://api.openai.com/v1",
  claude: "https://api.anthropic.com"
};

export const AMP_WEB_SEARCH_STRATEGY_OPTIONS = Object.freeze([
  { value: "ordered", label: "Ordered" },
  { value: "quota-balance", label: "Quota balance" }
]);
export const AMP_WEB_SEARCH_PROVIDER_OPTIONS = Object.freeze([
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
export const AMP_WEB_SEARCH_PROVIDER_META = Object.fromEntries(
  AMP_WEB_SEARCH_PROVIDER_OPTIONS.map((provider) => [provider.id, provider])
);
export const AMP_WEB_SEARCH_DEFAULT_COUNT = 5;
export const AMP_WEB_SEARCH_MIN_COUNT = 1;
export const AMP_WEB_SEARCH_MAX_COUNT = 20;

export const ROW_REMOVE_BUTTON_CLASS = "w-[5.5rem] justify-self-end";
export const DRAGGING_ROW_CLASSES = ["border-primary/45", "bg-primary/5"];

export const OLLAMA_KEEP_ALIVE_OPTIONS = [
  { value: "5m", label: "5 minutes" },
  { value: "10m", label: "10 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "-1", label: "Forever (blocks eviction)" },
  { value: "0", label: "Disabled (unload immediately)" }
];
