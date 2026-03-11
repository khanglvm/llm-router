import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge } from "./components/ui/badge.jsx";
import { Button } from "./components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.jsx";
import { Input } from "./components/ui/input.jsx";
import { Switch } from "./components/ui/switch.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.jsx";
import { Textarea } from "./components/ui/textarea.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.jsx";
import { cn } from "./lib/utils.js";
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

const JSON_HEADERS = { "content-type": "application/json" };
const LOG_LEVEL_STYLES = {
  info: "bg-sky-50 text-sky-700 ring-sky-100",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  warn: "bg-amber-50 text-amber-700 ring-amber-100",
  error: "bg-rose-50 text-rose-700 ring-rose-100"
};

const QUICK_START_FALLBACK_USER_AGENT = "AICodeClient/1.0.0";
const LIVE_UPDATES_RETRY_MS = 3000;
const TOAST_DURATION_MS = 5000;
const TOAST_STATUS_TICK_MS = 100;
const QUICK_START_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const QUICK_START_ALIAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const QUICK_START_CONNECTION_OPTIONS = [
  {
    value: "api",
    label: "API-based",
    description: "Test endpoint + model candidates with an API key env before saving."
  },
  {
    value: "oauth-gpt",
    label: "OAuth · GPT",
    description: "Use ChatGPT subscription login with GPT models."
  },
  {
    value: "oauth-claude",
    label: "OAuth · Claude",
    description: "Use Claude subscription login with Claude models."
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
const QUICK_START_WINDOW_OPTIONS = RATE_LIMIT_WINDOW_OPTIONS;
const QUICK_START_API_ENV_BY_CONNECTION = {
  openai: "OPENAI_API_KEY",
  claude: "ANTHROPIC_API_KEY"
};
const QUICK_START_DEFAULT_ENDPOINT_BY_PROTOCOL = {
  openai: "https://api.openai.com/v1",
  claude: "https://api.anthropic.com"
};
const QUICK_START_DEFAULT_MODELS = Object.freeze({
  api: Object.freeze({
    openai: Object.freeze(["gpt-4o-mini", "gpt-4.1-mini"]),
    claude: Object.freeze(["claude-3-5-sonnet", "claude-3-5-haiku"])
  }),
  "oauth-gpt": CODEX_SUBSCRIPTION_MODELS,
  "oauth-claude": CLAUDE_CODE_SUBSCRIPTION_MODELS
});
const QUICK_START_RATE_LIMIT_DEFAULTS = Object.freeze({
  api: Object.freeze({
    limit: 60,
    windowValue: 1,
    windowUnit: "minute"
  }),
  oauth: Object.freeze({
    limit: 999999,
    windowValue: 1,
    windowUnit: "month"
  })
});
const QUICK_START_CONNECTION_PRESETS = Object.freeze({
  api: Object.freeze({
    providerName: "My Provider",
    providerId: "my-provider",
    subscriptionProfile: ""
  }),
  "oauth-gpt": Object.freeze({
    providerName: "ChatGPT Subscription",
    providerId: "chatgpt-sub",
    subscriptionProfile: ""
  }),
  "oauth-claude": Object.freeze({
    providerName: "Claude Subscription",
    providerId: "claude-sub",
    subscriptionProfile: ""
  })
});

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

function MoveUpButton({ disabled = false, label = "Move up", onClick }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-8 w-8 rounded-full p-0"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <ArrowUpIcon className="h-4 w-4" />
    </Button>
  );
}

function MoveDownButton({ disabled = false, label = "Move down", onClick }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-8 w-8 rounded-full p-0"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <ArrowDownIcon className="h-4 w-4" />
    </Button>
  );
}

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
  defaults = QUICK_START_RATE_LIMIT_DEFAULTS.api,
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
  defaults = QUICK_START_RATE_LIMIT_DEFAULTS.api,
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

function buildManagedRouteOptions(config = {}) {
  const options = [];
  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};

  for (const aliasId of Object.keys(aliases)) {
    options.push({
      value: aliasId,
      label: aliasId,
      hint: `Alias · ${(aliases[aliasId]?.targets || []).length || 0} target(s)`
    });
  }

  for (const provider of (Array.isArray(config?.providers) ? config.providers : [])) {
    const providerLabel = provider?.name || provider?.id || "provider";
    for (const model of (Array.isArray(provider?.models) ? provider.models : [])) {
      const modelId = String(model?.id || "").trim();
      if (!provider?.id || !modelId) continue;
      options.push({
        value: `${provider.id}/${modelId}`,
        label: `${provider.id}/${modelId}`,
        hint: providerLabel
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

function withCurrentManagedRouteOptions(options = [], values = []) {
  const nextOptions = [...(Array.isArray(options) ? options : [])];
  const seen = new Set(nextOptions.map((option) => String(option?.value || "").trim()).filter(Boolean));

  for (const value of (Array.isArray(values) ? values : []).map((entry) => String(entry || "").trim()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    nextOptions.push({
      value,
      label: value,
      hint: "Current config"
    });
  }

  return nextOptions;
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

function buildAmpEntityRows(config = {}) {
  const nextConfig = ensureAmpDraftConfigShape(config);
  const amp = nextConfig.amp;
  ensureAmpRouteCollections(amp);

  const builtInRouteEntries = DEFAULT_AMP_ENTITY_DEFINITIONS.map((entry) => {
    const routeKey = String(entry.id || "").trim();
    const defaultMatch = getAmpDefaultMatchForRouteKey(routeKey);
    return {
      id: `route:${routeKey}`,
      source: "route",
      routeKey,
      inbound: defaultMatch || routeKey,
      outbound: String(amp.routes?.[routeKey] || "").trim(),
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

  const rawRouteEntries = (amp.rawModelRoutes || []).map((mapping, index) => ({
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
  }));

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
  const nextKnownRouteKey = isKnownAmpRouteKey(nextInbound)
    ? nextInbound
    : (preferredRouteKey && preferredDefaultMatch && nextInbound === preferredDefaultMatch ? preferredRouteKey : "");

  if (currentEntry.source === "route" && currentEntry.routeKey) {
    delete amp.routes[currentEntry.routeKey];
  }
  if (currentEntry.source === "raw" && Number.isInteger(currentEntry.index)) {
    amp.rawModelRoutes.splice(currentEntry.index, 1);
  }

  if (nextKnownRouteKey) {
    if (nextOutbound) {
      amp.routes[nextKnownRouteKey] = nextOutbound;
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

function inferQuickStartConnectionType(provider = {}) {
  if (provider?.type === "subscription") {
    return provider?.subscriptionType === "claude-code" ? "oauth-claude" : "oauth-gpt";
  }
  return "api";
}

function createProviderInlineDraftState(provider = {}) {
  const endpoints = collectQuickStartEndpoints(provider);
  const connectionType = inferQuickStartConnectionType(provider);
  const rateLimitDefaults = getQuickStartRateLimitDefaults(connectionType);
  return {
    id: String(provider?.id || "").trim(),
    name: String(provider?.name || provider?.id || "").trim(),
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

function getQuickStartConnectionLabel(connectionType) {
  return QUICK_START_CONNECTION_OPTIONS.find((option) => option.value === connectionType)?.label || "API-based";
}

function getQuickStartSuggestedModelIds(connectionType, protocol = "openai") {
  if (connectionType === "api") {
    return [...(QUICK_START_DEFAULT_MODELS.api[protocol] || QUICK_START_DEFAULT_MODELS.api.openai)];
  }
  return [...(QUICK_START_DEFAULT_MODELS[connectionType] || QUICK_START_DEFAULT_MODELS["oauth-gpt"])];
}

function getQuickStartRateLimitDefaults(connectionType) {
  return connectionType === "api"
    ? QUICK_START_RATE_LIMIT_DEFAULTS.api
    : QUICK_START_RATE_LIMIT_DEFAULTS.oauth;
}

function getQuickStartConnectionDefaults(connectionType, protocol = "openai") {
  const preset = QUICK_START_CONNECTION_PRESETS[connectionType] || QUICK_START_CONNECTION_PRESETS.api;
  const rateLimitDefaults = getQuickStartRateLimitDefaults(connectionType);

  return {
    providerName: preset.providerName,
    providerId: preset.providerId,
    endpoints: connectionType === "api" ? [] : [],
    apiKeyEnv: connectionType === "api" ? "" : "",
    subscriptionProfile: connectionType === "api" ? "" : preset.subscriptionProfile,
    modelIds: connectionType === "api" ? [] : getQuickStartSuggestedModelIds(connectionType, protocol),
    rateLimitRows: connectionType === "api"
      ? createRateLimitDraftRows([], {
          keyPrefix: `quick-start-${connectionType}-rate-limit`,
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
  const protocol = provider?.format === "claude" ? "claude" : "openai";
  const defaults = getQuickStartConnectionDefaults(connectionType, protocol);
  const rateLimitDefaults = getQuickStartRateLimitDefaults(connectionType);
  const providerModels = Array.isArray(provider?.models)
    ? provider.models.map((model) => model?.id).filter(Boolean)
    : [];
  const resolvedProviderId = String(provider?.id || defaults.providerId || slugifyProviderId(provider?.name || defaults.providerName || "my-provider") || "my-provider");
  const aliasEntry = useExistingProvider
    ? findQuickStartAliasEntry(baseConfig, resolvedProviderId, { aliasId: DEFAULT_MODEL_ALIAS_ID })
    : null;
  const resolvedModelIds = providerModels.length > 0 ? providerModels : [...defaults.modelIds];
  const headerRows = connectionType === "api"
    ? headerObjectToRows(provider?.headers, defaultProviderUserAgent)
    : [];

  return {
    connectionType,
    providerName: String(provider?.name || defaults.providerName),
    providerId: resolvedProviderId,
    endpoints: collectQuickStartEndpoints(provider).length > 0 ? collectQuickStartEndpoints(provider) : defaults.endpoints,
    endpointDraft: "",
    apiKeyEnv: String(provider?.apiKeyEnv || provider?.apiKey || defaults.apiKeyEnv),
    subscriptionProfile: String(provider?.subscriptionProfile || defaults.subscriptionProfile),
    modelIds: resolvedModelIds,
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

function buildQuickStartModelEntries(modelIds, modelPreferredFormat = {}) {
  return (modelIds || []).map((id) => {
    const preferred = modelPreferredFormat[id];
    return preferred ? { id, formats: [preferred] } : { id };
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
  const effectiveRateLimitDefaults = getQuickStartRateLimitDefaults(quickStart?.connectionType);
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
      models: buildQuickStartModelEntries(effectiveModelIds, testedProviderConfig?.modelPreferredFormat || {}),
      ...(providerMetadata ? { metadata: providerMetadata } : {})
    };
  } else {
    const subscriptionType = quickStart?.connectionType === "oauth-claude" ? "claude-code" : "chatgpt-codex";
    const providerFormat = quickStart?.connectionType === "oauth-claude" ? "claude" : "openai";

    provider = {
      id: providerId,
      name: providerName,
      type: "subscription",
      subscriptionType,
      subscriptionProfile: resolveQuickStartSubscriptionProfile(quickStart),
      format: providerFormat,
      formats: [providerFormat],
      models: buildQuickStartModelEntries(orderedModelIds)
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
  footer = null,
  contentClassName = "",
  bodyClassName = "",
  footerClassName = ""
}) {
  useEffect(() => {
    if (!open || typeof window === "undefined") return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  const isPage = variant === "page";

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-sm",
        isPage ? "p-0" : "flex items-center justify-center p-4"
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
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
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
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
}

function EditIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
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
      className="inline-flex h-9 min-w-0 max-w-full items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3 text-left transition hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-70 sm:max-w-[15rem]"
      onClick={onClick}
      disabled={disabled}
      aria-label={actionLabel}
      title={actionLabel}
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

function SummaryChipGroup({ label, items = [], emptyLabel = "None yet", onCopy, compact = false }) {
  return (
    <div className="min-w-0">
      <div className={cn("text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground", compact ? "mb-2" : "mb-3")}>{label}</div>
      {items.length > 0 ? (
        <div className={cn("overflow-y-auto", compact ? "max-h-20" : "max-h-28")}>
          <div className={cn("flex flex-wrap", compact ? "gap-2" : "gap-3")}>
            {items.map((item) => (
              <button
                key={`${label}-${item.value}`}
                type="button"
                className={cn(
                  "inline-flex max-w-full items-center rounded-full border border-border/70 bg-background text-foreground transition hover:border-accent hover:bg-accent",
                  compact ? "px-3 py-1.5 text-xs font-medium" : "px-3.5 py-2 text-sm font-medium"
                )}
                onClick={() => onCopy(item)}
                title={item.value}
              >
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={cn(
          "rounded-xl border border-dashed border-border text-muted-foreground",
          compact ? "px-3 py-1.5 text-xs" : "px-3 py-2 text-sm"
        )}>{emptyLabel}</div>
      )}
    </div>
  );
}

function ConsoleSummarySection({
  aliasItems = [],
  onCopyAlias
}) {
  return (
    <section aria-label="Model aliases">
      <div className="rounded-2xl border border-border/70 bg-card p-3">
        <SummaryChipGroup
          label="Model aliases"
          items={aliasItems}
          emptyLabel="No aliases yet."
          onCopy={onCopyAlias}
          compact
        />
      </div>
    </section>
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

function ProviderModelsEditor({ provider, disabled = false, disabledReason = "", busy = false, onApply, framed = true, focusRequest = 0 }) {
  const initialRows = useMemo(() => createProviderModelDraftRows(provider), [provider]);
  const [rows, setRows] = useState([]);
  const [submitState, setSubmitState] = useState("");
  const rowCounterRef = useRef(0);
  const inputRefs = useRef(new Map());
  const pendingFocusRowKeyRef = useRef("");
  const draggingKeyRef = useRef("");
  const draggingNodeRef = useRef(null);

  function createDraftRow(overrides = {}) {
    rowCounterRef.current += 1;
    return {
      key: `model-${provider.id}-draft-${rowCounterRef.current}`,
      id: "",
      sourceId: "",
      ...overrides
    };
  }

  function focusRow(rowKey) {
    pendingFocusRowKeyRef.current = rowKey;
  }

  function ensureTrailingDraftRow(nextRows = [], { preserveFocus = false } = {}) {
    const filledRows = [];
    let draftRow = null;

    for (const row of (Array.isArray(nextRows) ? nextRows : [])) {
      const value = String(row?.id || "");
      if (String(value).trim()) {
        filledRows.push({ ...row, id: value });
        continue;
      }
      if (!draftRow) {
        draftRow = {
          ...row,
          id: ""
        };
      }
    }

    if (!draftRow) {
      draftRow = createDraftRow();
      if (preserveFocus) focusRow(draftRow.key);
    }

    return [...filledRows, draftRow];
  }

  useEffect(() => {
    setRows(ensureTrailingDraftRow(initialRows, { preserveFocus: true }));
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
      const nextRows = ensureTrailingDraftRow(current, { preserveFocus: false });
      const draftRow = nextRows.find((row) => !String(row?.id || "").trim()) || nextRows[nextRows.length - 1];
      if (draftRow) focusRow(draftRow.key);
      return nextRows;
    });
  }, [focusRequest]);

  const filledRows = rows.filter((row) => String(row?.id || "").trim());
  const filledModelIds = filledRows.map((row) => String(row?.id || "").trim());
  const initialModelIds = initialRows.map((row) => String(row?.id || "").trim()).filter(Boolean);
  const newModelIds = filledModelIds.filter((modelId) => !initialModelIds.includes(modelId));
  const hasDuplicates = hasDuplicateTrimmedValues(filledModelIds);
  const hasModels = filledModelIds.length > 0;
  const isDirty = JSON.stringify(initialModelIds) !== JSON.stringify(filledModelIds);
  const actionBusy = submitState !== "";
  const locked = disabled || busy || actionBusy;
  const issue = disabled
    ? disabledReason
    : !hasModels
      ? "Keep at least one model id on the provider."
      : hasDuplicates
        ? "Model ids must be unique for each provider."
        : "";
  const setAnimatedRowRef = useReorderLayoutAnimation(rows.map((row) => row.key));

  function updateRow(rowKey, value) {
    setRows((current) => ensureTrailingDraftRow(
      current.map((row) => (row.key === rowKey ? { ...row, id: value } : row)),
      { preserveFocus: false }
    ));
  }

  function removeRow(rowKey) {
    setRows((current) => ensureTrailingDraftRow(current.filter((row) => row.key !== rowKey)));
  }

  function moveRowUp(rowKey) {
    setRows((current) => ensureTrailingDraftRow(moveItemUp(current, rowKey, (row) => row?.key)));
  }

  function clearDraggingState() {
    draggingKeyRef.current = "";
    setDraggingRowClasses(draggingNodeRef.current, false);
    draggingNodeRef.current = null;
  }

  async function handleApply() {
    if (locked || issue || !isDirty) return false;
    const willTestNewModels = inferQuickStartConnectionType(provider) === "api" && newModelIds.length > 0;
    setSubmitState(willTestNewModels ? "testing" : "saving");
    try {
      return await onApply(filledRows);
    } finally {
      setSubmitState("");
    }
  }

  return (
    <div className={cn(framed ? "space-y-3 rounded-2xl border border-border/70 bg-background/60 p-4" : "space-y-3")}>
      <div className="rounded-2xl border border-border/70 bg-secondary/35 px-4 py-3 text-sm leading-6 text-muted-foreground">
        Direct routes follow this top-to-bottom order. A fresh empty row stays at the bottom so you can add models without switching context.
      </div>

      <div className="space-y-2">
        {rows.map((row, index) => {
          const trimmedValue = String(row?.id || "").trim();
          const showRemoveButton = Boolean(trimmedValue);
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
                setRows((current) => ensureTrailingDraftRow(moveItemsByKey(current, fromKey, row.key)));
              }}
              className={cn(
                "grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-border/70 bg-card/90 p-3",
                !showRemoveButton ? "border-dashed bg-background/85" : null
              )}
            >
              <span className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground",
                showRemoveButton && !locked ? "cursor-grab" : "opacity-45"
              )}
                draggable={!locked && showRemoveButton}
                onDragStart={(event) => {
                  if (locked || !showRemoveButton) return;
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
                title={showRemoveButton ? "Drag to reorder" : "New model draft row"}
              >
                <DragGripIcon className="h-4 w-4" />
              </span>
              <MoveUpButton
                disabled={locked || index === 0 || !showRemoveButton}
                label={index === 0 ? "Already first" : `Move ${row.id || `model ${index + 1}`} up`}
                onClick={() => moveRowUp(row.key)}
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
                onChange={(event) => updateRow(row.key, event.target.value)}
                placeholder={showRemoveButton ? "Model id" : "Add a new model id"}
                disabled={locked}
              />
              {showRemoveButton ? (
                <Button type="button" variant="ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => removeRow(row.key)} disabled={locked}>
                  Remove
                </Button>
              ) : (
                <div className="h-9 w-[5.5rem]" aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>

      {issue ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{issue}</div> : null}

      <div className="flex min-h-9 items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {newModelIds.length > 0 && inferQuickStartConnectionType(provider) === "api"
            ? `${newModelIds.length} new model${newModelIds.length === 1 ? "" : "s"} will be tested before save.`
            : "Existing models keep their current configuration metadata."}
        </div>
        <div className="flex items-center justify-end gap-2">
          {!disabled && !locked && isDirty ? <Button type="button" variant="ghost" onClick={() => setRows(ensureTrailingDraftRow(initialRows, { preserveFocus: true }))}>Reset</Button> : null}
          {!disabled && !locked && isDirty && !issue ? (
            <Button type="button" onClick={() => void handleApply()}>
              {submitState === "testing"
                ? "Testing…"
                : submitState === "saving" || busy
                  ? "Saving…"
                  : "Save models"}
            </Button>
          ) : null}
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
  trailingDraftRow = false,
  showWeightInput = false,
  filterOtherSelectedValues = false,
  excludedValues = []
}) {
  const rowCounterRef = useRef(0);
  const draggingKeyRef = useRef("");
  const draggingNodeRef = useRef(null);
  const rowKeyPrefix = useMemo(
    () => String(title || "targets").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "targets",
    [title]
  );
  const draftRowKey = `${rowKeyPrefix}-draft-row`;
  const displayRows = useMemo(() => {
    const filledRows = (rows || []).filter((row) => String(row?.ref || "").trim());
    if (!trailingDraftRow) return filledRows;
    return [...filledRows, { key: draftRowKey, ref: "", sourceRef: "" }];
  }, [rows, trailingDraftRow, draftRowKey]);
  const setAnimatedRowRef = useReorderLayoutAnimation(displayRows.map((row) => row.key));
  const normalizedExcludedValues = useMemo(
    () => normalizeUniqueTrimmedValues(excludedValues),
    [excludedValues]
  );
  const resolvedOptions = useMemo(
    () => withCurrentManagedRouteOptions(options, [...displayRows.map((row) => row?.ref), ...normalizedExcludedValues]),
    [options, displayRows, normalizedExcludedValues]
  );

  function updateRow(rowKey, value) {
    if (trailingDraftRow && rowKey === draftRowKey) {
      if (!String(value || "").trim()) return;
      rowCounterRef.current += 1;
      onChange([
        ...(rows || []).filter((row) => String(row?.ref || "").trim()),
        {
          key: `${rowKeyPrefix}-draft-${rowCounterRef.current}`,
          ref: value,
          sourceRef: "",
          ...(showWeightInput ? { weight: "1" } : {})
        }
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

  return (
    <div className="space-y-2 rounded-2xl border border-border/70 bg-background/55 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{title}</div>
        {!trailingDraftRow ? <Button type="button" variant="ghost" onClick={addRow} disabled={disabled}>{addLabel}</Button> : null}
      </div>

      {displayRows.length > 0 ? (
        <div className="space-y-2">
          {displayRows.map((row, index) => {
            const isDraftRow = trailingDraftRow && row.key === draftRowKey;
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
                ref={setAnimatedRowRef(row.key)}
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
                    ? "grid grid-cols-[auto_auto_auto_minmax(0,1fr)_10rem_auto] items-center gap-2 rounded-xl border border-border/70 bg-card/90 p-3"
                    : "grid grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-border/70 bg-card/90 p-3",
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
                  disabled={disabled || index === 0 || isDraftRow}
                  label={index === 0 ? "Already first" : `Move ${row.ref || `target ${index + 1}`} up`}
                  onClick={() => moveRowUp(row.key)}
                />
                <MoveDownButton
                  disabled={disabled || isDraftRow || index === (rows || []).length - 1}
                  label={isDraftRow || index === (rows || []).length - 1 ? "Already last" : `Move ${row.ref || `target ${index + 1}`} down`}
                  onClick={() => moveRowDown(row.key)}
                />
                <div className="flex h-9 min-w-0 overflow-hidden rounded-lg border border-input bg-background/80 shadow-sm transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
                  <div className="flex shrink-0 items-center border-r border-border/70 bg-secondary/55 px-2.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Model
                  </div>
                  <Select value={row.ref || undefined} onValueChange={(value) => updateRow(row.key, value)} disabled={disabled}>
                    <SelectTrigger className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-3 shadow-none focus:border-transparent focus:ring-0">
                      <SelectValue placeholder={isDraftRow ? draftPlaceholder : placeholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {rowOptions.length > 0 ? rowOptions.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          searchText={`${option.label || ""} ${option.value || ""} ${option.hint || ""}`}
                        >
                          {option.label}
                        </SelectItem>
                      )) : (
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
                  <Button type="button" variant="ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => removeRow(row.key)} disabled={disabled}>Remove</Button>
                ) : (
                  <div className="h-9 w-[5.5rem]" aria-hidden="true" />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{emptyLabel}</div>
      )}

      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{helperText}</div>
        {helperAction ? <div className="flex shrink-0 items-center">{helperAction}</div> : null}
      </div>
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

  useEffect(() => {
    if (!open) return;
    setSelectedStrategy(normalizedInitialStrategy);
  }, [open, normalizedInitialStrategy, aliasLabel]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={aliasLabel ? `Choose strategy · ${aliasLabel}` : "Choose strategy"}
      description="Review each routing strategy in its own tab. Save applies the currently selected tab to this alias."
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onSave(selectedStrategy);
              onClose();
            }}
            disabled={disabled}
          >
            Save strategy
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
  isNew = false,
  onDiscard = () => {},
  onOpenStrategyModal = () => {},
  framed = true
}) {
  const initialDraftResetKey = buildAliasDraftResetKey(aliasId, alias, { isNew });
  const initialDraft = useMemo(
    () => createAliasDraftState(isNew ? "" : aliasId, alias),
    [initialDraftResetKey]
  );
  const [draft, setDraft] = useState(initialDraft);
  const [aliasIdEditing, setAliasIdEditing] = useState(isNew);
  const aliasIdInputRef = useRef(null);

  useEffect(() => {
    setDraft(initialDraft);
    setAliasIdEditing(isNew);
  }, [initialDraft, isNew]);

  useEffect(() => {
    if (!aliasIdEditing) return undefined;
    const frameId = typeof window !== "undefined"
      ? window.requestAnimationFrame(() => {
        aliasIdInputRef.current?.focus();
        aliasIdInputRef.current?.select?.();
      })
      : 0;
    return () => {
      if (typeof window !== "undefined") window.cancelAnimationFrame(frameId);
    };
  }, [aliasIdEditing]);

  const normalizedAliasId = String(draft?.id || "").trim();
  const isFixedDefault = aliasId === DEFAULT_MODEL_ALIAS_ID || normalizedAliasId === DEFAULT_MODEL_ALIAS_ID;
  const filteredRouteOptions = useMemo(
    () => (routeOptions || []).filter((option) => option.value !== normalizedAliasId && option.value !== `alias:${normalizedAliasId}`),
    [routeOptions, normalizedAliasId]
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
  const issue = disabled
    ? disabledReason
    : !normalizedAliasId
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
  const locked = disabled || busy;
  const isDefault = isFixedDefault || defaultModel === aliasId || defaultModel === normalizedAliasId;
  const isAmpDefault = ampDefaultRoute === aliasId || ampDefaultRoute === normalizedAliasId;
  const strategyEntries = useMemo(
    () => buildAliasStrategyEntries({ ...draft, fallbackTargets: [] }, { ...alias, fallbackTargets: [] }, routeOptions),
    [draft, alias, routeOptions]
  );

  async function handleApplyClick() {
    const result = await onApply(aliasId, { ...draft, fallbackTargets: [] });
    if (result && isNew) onDiscard(aliasId);
  }

  const content = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {aliasIdEditing ? (
            <Input
              ref={aliasIdInputRef}
              autoFocus={isNew}
              value={draft.id}
              onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
              onBlur={() => setAliasIdEditing(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "Escape") {
                  event.preventDefault();
                  setAliasIdEditing(false);
                }
              }}
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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {isDefault ? <Badge variant="success">Default route</Badge> : null}
            {isAmpDefault ? <Badge variant="info">AMP default</Badge> : null}
          </div>
        </div>
        <div className="flex items-start gap-2 self-start">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="group gap-1.5 normal-case tracking-normal"
            onClick={() => onOpenStrategyModal({
              aliasLabel: normalizedAliasId || (isNew ? "New alias" : aliasId),
              strategy: draft?.strategy || "auto",
              entries: strategyEntries,
              disabled: locked,
              onSave: (strategy) => setDraft((current) => ({ ...current, strategy }))
            })}
            disabled={locked}
          >
            <EditIcon className="h-4 w-4 shrink-0" />
            {`Strategy: ${formatModelAliasStrategyLabel(draft.strategy || "auto")}`}
          </Button>
        </div>
      </div>

      <RouteTargetListEditor
        title="Targets"
        rows={draft.targets}
        onChange={(targets) => setDraft((current) => ({ ...current, targets }))}
        options={filteredRouteOptions}
        disabled={locked}
        addLabel="Add target"
        emptyLabel="No targets yet. This alias can stay empty until you wire routes back in."
        helperText="Drag targets to change the alias preference order. Existing weights and target metadata stay attached when the ref is unchanged."
        draftPlaceholder="Add a new target"
        trailingDraftRow
        showWeightInput
        helperAction={!isNew && !isFixedDefault ? (
          <Button
            type="button"
            variant="danger"
            size="sm"
            className="gap-1.5 normal-case tracking-normal"
            onClick={() => onRemove(aliasId)}
            disabled={locked}
          >
            <TrashIcon className="h-4 w-4" />
            Remove alias
          </Button>
        ) : null}
        filterOtherSelectedValues
        excludedValues={[]}
      />

      {issue ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{issue}</div> : null}
      {!issue && isFixedDefault && !hasTargets ? (
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
            {isDirty ? <Button type="button" variant="ghost" onClick={() => setDraft(initialDraft)} disabled={locked}>Reset</Button> : null}
            {isDirty && !issue ? (
              <Button type="button" onClick={() => void handleApplyClick()} disabled={locked}>{busy ? "Saving…" : (isNew ? "Create alias" : "Apply alias")}</Button>
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
  aliasIds,
  routeOptions,
  defaultModel,
  ampDefaultRoute,
  disabledReason = "",
  busy = false,
  requestAddAliasToken = 0,
  onApplyAlias,
  onRemoveAlias
}) {
  const aliasEntries = Object.entries(aliases || {});
  const disabled = Boolean(disabledReason);
  const [pendingNewAliasKey, setPendingNewAliasKey] = useState("");
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

  useEffect(() => {
    if (!requestAddAliasToken) return;
    handleCreateNewAlias();
  }, [requestAddAliasToken]);

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

  return (
    <>
      <Card>
        <CardHeader>
          <div className="space-y-1">
            <CardDescription>Model aliases give clients one stable route name that can point to multiple provider/models, so you can swap, balance, and fail over without changing client config.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {disabled ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{disabledReason}</div> : null}

          {aliasEntries.length > 0 ? (
            <div className="grid gap-4">
              {aliasEntries.map(([aliasId, alias]) => (
                <ModelAliasCard
                  key={aliasId}
                  aliasId={aliasId}
                  alias={alias}
                  aliasIds={aliasIds}
                  routeOptions={routeOptions}
                  defaultModel={defaultModel}
                  ampDefaultRoute={ampDefaultRoute}
                  disabled={disabled}
                  disabledReason={disabledReason}
                  busy={busy}
                  onApply={onApplyAlias}
                  onRemove={onRemoveAlias}
                  onOpenStrategyModal={handleOpenStrategyModal}
                />
              ))}
            </div>
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
        contentClassName="max-h-[92vh] max-w-5xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
        bodyClassName="max-h-[calc(92vh-5.5rem)]"
      >
        <div className="space-y-4">
          <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Alias</div>
                <div className="mt-1 text-sm text-muted-foreground">Create a stable route id and map it to one or more provider/model targets.</div>
              </div>
              <Badge variant="outline">New route</Badge>
            </div>
          </div>

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
              onApply={onApplyAlias}
              onRemove={onRemoveAlias}
              isNew
              onDiscard={handleDiscardNewAlias}
              onOpenStrategyModal={handleOpenStrategyModal}
              framed={false}
            />
          ) : null}
        </div>
      </Modal>

      <ModelAliasStrategyModal
        open={strategyModalState.open}
        onClose={handleCloseStrategyModal}
        onSave={(strategy) => {
          strategyModalState.onSave?.(strategy);
        }}
        aliasLabel={strategyModalState.aliasLabel}
        initialStrategy={strategyModalState.strategy}
        entries={strategyModalState.entries}
        disabled={strategyModalState.disabled}
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
  onApplyProviderDetails,
  onApplyProviderModels,
  disabledReason = "",
  busy = false
}) {
  const initialDraft = useMemo(() => createProviderInlineDraftState(provider), [provider]);
  const [draft, setDraft] = useState(initialDraft);
  const [editOpen, setEditOpen] = useState(false);
  const [editTab, setEditTab] = useState("provider");
  const [editFocusTarget, setEditFocusTarget] = useState("");
  const [modelFocusRequest, setModelFocusRequest] = useState(0);
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
    endpoints: resolvedEndpoints,
    endpointDraft: String(draft?.endpointDraft || "").trim(),
    rateLimitRows: serializeRateLimitDraftRows(draft?.rateLimitRows)
  });
  const initialSignature = JSON.stringify({
    id: String(initialDraft?.id || "").trim(),
    name: String(initialDraft?.name || "").trim(),
    endpoints: normalizeUniqueTrimmedValues(initialDraft?.endpoints),
    endpointDraft: String(initialDraft?.endpointDraft || "").trim(),
    rateLimitRows: serializeRateLimitDraftRows(initialDraft?.rateLimitRows)
  });
  const isDirty = draftSignature !== initialSignature;
  const locked = Boolean(disabledReason) || busy;
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
            ? "Add at least one endpoint for API-based providers."
            : !isSubscription && resolvedEndpoints.some((endpoint) => !isLikelyHttpEndpoint(endpoint))
              ? "All endpoints must start with http:// or https://."
              : rateLimitIssue;

  async function handleApplyClick() {
    return onApplyProviderDetails(
      provider.id,
      isSubscription ? draft : { ...draft, endpoints: resolvedEndpoints, endpointDraft: "" }
    );
  }

  function handleResetProviderDraft() {
    setDraft(initialDraft);
  }

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
    setEditTab(tab);
    setEditFocusTarget(focusTarget);
    if (tab === "models" && focusTarget === "models") {
      setModelFocusRequest((current) => current + 1);
    }
    setEditOpen(true);
  }

  function handleCloseEditModal() {
    setEditOpen(false);
    setEditTab("provider");
    setEditFocusTarget("");
    setDraft(initialDraft);
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
                  onClick={() => handleOpenEditModal("models", "models")}
                  disabled={locked}
                  title={`Edit models for ${provider.name || provider.id}`}
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
        description="Switch between provider settings and model list. Each tab saves independently."
        contentClassName="max-h-[92vh] max-w-5xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
        bodyClassName="max-h-[calc(92vh-5.5rem)]"
      >
        <Tabs value={editTab} onValueChange={setEditTab}>
          <TabsList className="w-full justify-start">
            <TabsTrigger value="provider">Provider</TabsTrigger>
            <TabsTrigger value="models">Model list</TabsTrigger>
          </TabsList>

          <TabsContent value="provider" className="space-y-4">
            <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Provider</div>
                  <div className="mt-1 text-sm text-muted-foreground">Update provider identity and connection settings here.</div>
                </div>
                <Badge variant="outline">{isSubscription ? "Subscription" : "API-based"}</Badge>
              </div>
            </div>

            <div className={cn("grid gap-3", isSubscription ? "md:grid-cols-2" : "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
              <Field label="Provider name" stacked>
                <Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} disabled={locked} />
              </Field>
              <Field label="Provider id" hint="Used in direct routes like provider/model" stacked>
                <Input value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: slugifyProviderId(event.target.value) }))} disabled={locked} />
              </Field>
            </div>

            {!isSubscription ? (
              <div className="space-y-3">
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
                      disabled={locked}
                      isValueValid={isLikelyHttpEndpoint}
                      inputRef={endpointInputRef}
                      inputClassName="placeholder:text-muted-foreground/55"
                      placeholder="Click here to type new endpoint"
                      helperText="Paste one or more candidate endpoints. Example for OpenAI-compatible providers: https://api.openai.com/v1"
                    />
                  </Field>
                </div>
                <div ref={rateLimitSectionRef} className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1fr)]">
                  <div className="md:col-span-2 xl:col-span-4">
                    <Field
                      label="Rate limit"
                      hint="Ids are generated from request and window values. Duplicate caps are blocked automatically."
                      stacked
                      headerAction={(
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setDraft((current) => ({ ...current, rateLimitRows: appendRateLimitDraftRow(current.rateLimitRows) }))}
                          disabled={locked}
                        >
                          Add rate limit
                        </Button>
                      )}
                    >
                      <RateLimitBucketsEditor
                        rows={draft.rateLimitRows}
                        onChange={(value) => setDraft((current) => ({ ...current, rateLimitRows: value }))}
                        availableModelIds={modelIds}
                        disabled={locked}
                        inputRef={rateLimitInputRef}
                      />
                    </Field>
                  </div>
                </div>
              </div>
            ) : null}

            {issue ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{issue}</div> : null}

            <div className="flex min-h-9 items-center justify-end gap-2">
              {!locked && isDirty ? <Button type="button" variant="ghost" onClick={handleResetProviderDraft}>Reset</Button> : null}
              {!locked && isDirty && !issue ? (
                <Button type="button" onClick={() => void handleApplyClick()}>
                  {busy ? "Saving…" : "Save provider"}
                </Button>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="models">
            <ProviderModelsEditor
              provider={provider}
              disabled={Boolean(disabledReason)}
              disabledReason={disabledReason}
              busy={busy}
              framed={false}
              focusRequest={modelFocusRequest}
              onApply={(rows) => onApplyProviderModels(provider.id, rows)}
            />
          </TabsContent>
        </Tabs>
      </Modal>
    </>
  );
}

function ProviderList({
  providers,
  onRemove,
  onApplyProviderDetails,
  onApplyProviderModels,
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
          onApplyProviderDetails={onApplyProviderDetails}
          onApplyProviderModels={onApplyProviderModels}
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
  onApplyProviderDetails,
  onApplyProviderModels,
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
          onApplyProviderDetails={onApplyProviderDetails}
          onApplyProviderModels={onApplyProviderModels}
          disabledReason={disabledReason}
          busy={busy}
        />
      </div>
    </section>
  );
}

function ConnectionFilePathsCard({
  primaryLabel = "Config file",
  primaryPath = "",
  secondaryLabel = "Backup file",
  secondaryPath = "",
  endpointUrl = ""
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
      <div className="grid gap-3 xl:grid-cols-2">
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{primaryLabel}</div>
          <div className="mt-2 break-all rounded-xl border border-border/70 bg-background px-3 py-3 font-mono text-xs text-foreground">
            {primaryPath || "Not resolved"}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{secondaryLabel}</div>
          <div className="mt-2 break-all rounded-xl border border-border/70 bg-background px-3 py-3 font-mono text-xs text-foreground">
            {secondaryPath || "Not resolved"}
          </div>
        </div>
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        Endpoint: <span className="font-mono">{endpointUrl || "Router URL not ready yet"}</span>
      </div>
    </div>
  );
}

function AmpSettingsPanel({
  rows,
  routeOptions,
  ampClientUrl,
  ampClientGlobal,
  routingBusy,
  openAmpConfigBusy,
  onToggleGlobalRouting,
  onOpenAmpConfigFile,
  onInboundChange,
  onOutboundChange,
  onCreateEntry,
  onRemoveEntry,
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

  const statusVariant = disabledReason
    ? "warning"
    : autosaveState.status === "error"
      ? "danger"
      : autosaveState.status === "saving"
        ? "info"
        : autosaveState.savedAt
          ? "success"
          : "outline";

  const statusLabel = disabledReason
    ? "Needs review"
    : autosaveState.status === "error"
      ? "Save failed"
      : autosaveState.status === "saving"
        ? "Auto-saving"
        : autosaveState.savedAt
          ? "Auto-saved"
          : "Ready";

  const statusMessage = disabledReason
    ? disabledReason
    : autosaveState.status === "error"
      ? autosaveState.message
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
        <CardHeader className="flex flex-row items-start justify-between gap-3 p-4 pb-0">
          <div className="space-y-1">
            <CardTitle>Use AMP via LLM-Router</CardTitle>
            <CardDescription className="text-xs leading-5">
              {globalRoutingEnabled ? "Connected" : "Not connected"}
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={onOpenAmpConfigFile} disabled={openAmpConfigBusy}>
              {openAmpConfigBusy ? "Opening…" : "Open AMP Config File"}
            </Button>
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

        <ConnectionFilePathsCard
          primaryLabel="Config file"
          primaryPath={ampClientGlobal?.settingsFilePath || ""}
          secondaryLabel="Secrets file"
          secondaryPath={ampClientGlobal?.secretsFilePath || ""}
          endpointUrl={ampClientGlobal?.configuredUrl || ampClientUrl}
        />

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
                  <Button type="button" size="sm" variant="outline" onClick={handleOpenAddEntry}>Add route mapping</Button>
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

                    <Field label="Route target" hint="Alias or provider/model route in llm-router">
                      <Select value={newOutbound || undefined} onValueChange={setNewOutbound}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select local route" />
                        </SelectTrigger>
                        <SelectContent>
                          {routeOptions.map((option) => (
                            <SelectItem
                              key={option.value}
                              value={option.value}
                              searchText={`${option.label || ""} ${option.value || ""} ${option.hint || ""}`}
                            >
                              {`${option.label} · ${option.hint}`}
                            </SelectItem>
                          ))}
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
                        <Input
                          value={row.inbound}
                          onChange={(event) => onInboundChange(row.id, event.target.value)}
                          placeholder={row.defaultMatch || "gpt-*-codex*"}
                        />
                      </Field>

                      <Field label="Target route" hint="Alias or provider/model route">
                        <Select value={row.outbound || "__default__"} onValueChange={(value) => onOutboundChange(row.id, value)}>
                          <SelectTrigger>
                            <SelectValue placeholder={row.removable ? "Choose target route" : "Use default route"} />
                          </SelectTrigger>
                          <SelectContent>
                            {!row.removable ? <SelectItem value="__default__">Use default route</SelectItem> : null}
                            {routeOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                                searchText={`${option.label || ""} ${option.value || ""} ${option.hint || ""}`}
                              >
                                {`${option.label} · ${option.hint}`}
                              </SelectItem>
                            ))}
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

function CodingToolSettingsPanel({
  toolName,
  openButtonLabel,
  toolState,
  endpointUrl,
  routeOptions,
  connectionBusy,
  bindingBusy,
  openConfigBusy,
  onToggleRouting,
  onOpenConfigFile,
  onBindingChange,
  hasMasterKey,
  disabledReason,
  bindingFields = []
}) {
  const routingEnabled = toolState?.routedViaRouter === true;
  const routingError = String(toolState?.error || "").trim();
  const canEnableRouting = Boolean(hasMasterKey && endpointUrl && !disabledReason && !routingError);
  const resolvedRouteOptions = withCurrentManagedRouteOptions(
    routeOptions,
    bindingFields.map((field) => field?.value)
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 p-4 pb-0">
        <div className="space-y-1">
          <CardTitle>{`Use ${toolName} via LLM-Router`}</CardTitle>
          <CardDescription className="text-xs leading-5">
            {routingEnabled ? "Connected" : "Not connected"}
          </CardDescription>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onOpenConfigFile} disabled={openConfigBusy}>
            {openConfigBusy ? "Opening…" : openButtonLabel}
          </Button>
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

        <ConnectionFilePathsCard
          primaryLabel="Config file"
          primaryPath={toolState?.configFilePath || toolState?.settingsFilePath || ""}
          secondaryLabel="Backup file"
          secondaryPath={toolState?.backupFilePath || ""}
          endpointUrl={endpointUrl}
        />

        <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-foreground">Model bindings</div>
              <div className="mt-1 text-xs text-muted-foreground">Prefer LLM-Router aliases here so you can retarget models later from the Alias &amp; Fallback tab.</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={routingEnabled ? "success" : "outline"}>
                {routingEnabled ? "Managed by router" : "Connect first"}
              </Badge>
              <Badge variant="outline">{resolvedRouteOptions.length} route options</Badge>
            </div>
          </div>

          {resolvedRouteOptions.length === 0 ? (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Add at least one alias or provider/model route before choosing tool-specific model bindings.
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
                    <BindingRouteSelect
                      field={field}
                      options={resolvedRouteOptions}
                      disabled={!routingEnabled || bindingBusy || resolvedRouteOptions.length === 0}
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

function BindingRouteSelect({
  field,
  options,
  disabled = false,
  onValueChange
}) {
  const selectValue = String(field?.value || "").trim() || (field?.allowUnset ? "__unset__" : "");
  const selectOptions = useMemo(() => {
    return field?.allowUnset
      ? [{ value: "__unset__", label: "Inherit tool default", hint: "" }, ...options]
      : [...options];
  }, [field?.allowUnset, options]);

  return (
    <Select value={selectValue} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger>
        <SelectValue placeholder={field.placeholder || "Select a route"} />
      </SelectTrigger>
      <SelectContent>
        {selectOptions.length > 0 ? selectOptions.map((option) => (
          <SelectItem
            key={`${field.id}-${option.value}`}
            value={option.value}
            searchText={`${option.label || ""} ${option.value || ""} ${option.hint || ""}`}
          >
            {option.label}
          </SelectItem>
        )) : (
          <SelectItem value="__no-route-options" disabled>No routes available</SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

function LogList({ logs }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Router actions, live reloads, saves, and config tests stream here.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-h-[32rem] space-y-3 overflow-auto pr-1">
          {logs?.length ? logs.map((entry) => (
            <div key={entry.id} className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className={cn("inline-flex h-2.5 w-2.5 rounded-full ring-4", LOG_LEVEL_STYLES[entry.level] || LOG_LEVEL_STYLES.info)} />
                  <span className="text-sm font-medium text-foreground">{entry.message}</span>
                </div>
                <span className="text-xs text-muted-foreground">{formatTime(entry.time)}</span>
              </div>
              {entry.detail ? <div className="mt-2 text-sm leading-6 text-muted-foreground">{entry.detail}</div> : null}
            </div>
          )) : (
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
    windowUnit: QUICK_START_RATE_LIMIT_DEFAULTS.api.windowUnit
  }, {
    keyPrefix: "rate-limit-draft",
    defaults: QUICK_START_RATE_LIMIT_DEFAULTS.api,
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
        <div
          className="absolute bottom-full left-0 right-0 z-30 mb-1 rounded-xl border border-border/70 bg-popover p-2 shadow-lg"
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
            <div className="max-h-48 overflow-y-auto">
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
        </div>
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
  helperText = "Leave models empty to apply the cap to all model.",
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
      <div className="text-xs leading-5 text-muted-foreground">{helperText}</div>
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

function LiveUpdatesIndicator({ status = "connecting", attempt = 0, onRetry }) {
  const tone = status === "connected"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : status === "reconnecting"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-sky-200 bg-sky-50 text-sky-800";
  const dotTone = status === "connected"
    ? "bg-emerald-500"
    : status === "reconnecting"
      ? "bg-amber-500"
      : "bg-sky-500";
  const label = status === "connected"
    ? "Live"
    : status === "reconnecting"
      ? `Reconnecting${attempt > 1 ? ` · ${attempt}` : ""}`
      : "Connecting";

  return (
    <div className="fixed bottom-4 right-4 z-40">
      <div className={cn("flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm backdrop-blur", tone)}>
        <span className={cn("inline-flex h-2 w-2 rounded-full", dotTone)} />
        <span className="font-medium">{label}</span>
        {status !== "connected" ? (
          <button className="font-medium uppercase tracking-[0.16em] underline underline-offset-2" onClick={onRetry} type="button">
            Retry now
          </button>
        ) : null}
      </div>
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
    { title: "Provider", detail: "Choose API-based or OAuth first, then enter the provider details needed for that connection type." },
    { title: "Models", detail: "Add model ids, then configure one or more rate limits for all models or selected models. API-based providers are tested before continue." },
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
    : getQuickStartSuggestedModelIds(quickStart.connectionType);
  const normalizedProviderId = slugifyProviderId(quickStart.providerId || quickStart.providerName || "my-provider") || "my-provider";
  const resolvedSubscriptionProfile = resolveQuickStartSubscriptionProfile(quickStart);
  const subscriptionLoginSignature = JSON.stringify({
    connectionType: quickStart.connectionType,
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

  function handleConnectionChange(nextConnectionType) {
    setTestError("");
    setTestedConfig(null);
    setModelTestStates({});
    setModelDiscovery(null);
    setModelDiscoveryError("");
    setQuickStart((current) => {
      const currentDefaults = getQuickStartConnectionDefaults(current.connectionType);
      const nextDefaults = getQuickStartConnectionDefaults(nextConnectionType);
      const currentHeaderDefaults = current.connectionType === "api"
        ? getQuickStartDefaultHeaderRows(defaultProviderUserAgent)
        : [];
      const nextHeaderDefaults = nextConnectionType === "api"
        ? getQuickStartDefaultHeaderRows(defaultProviderUserAgent)
        : [];
      const currentHeaderRows = normalizeQuickStartHeaderRows(current.headerRows || []);
      const providerIdWasAuto = !current.providerId
        || current.providerId === currentDefaults.providerId
        || current.providerId === slugifyProviderId(current.providerName || "");
      const providerNameWasAuto = !current.providerName || current.providerName === currentDefaults.providerName;
      const apiKeyEnvWasAuto = !current.apiKeyEnv || current.apiKeyEnv === currentDefaults.apiKeyEnv;
      const profileWasAuto = !current.subscriptionProfile || current.subscriptionProfile === currentDefaults.subscriptionProfile;
      const modelsWereDefault = (current.modelIds || []).length === 0
        || JSON.stringify(current.modelIds || []) === JSON.stringify(currentDefaults.modelIds || []);
      const headerRowsWereDefault = JSON.stringify(currentHeaderRows) === JSON.stringify(currentHeaderDefaults);

      return {
        ...current,
        connectionType: nextConnectionType,
        providerName: providerNameWasAuto ? nextDefaults.providerName : current.providerName,
        providerId: providerIdWasAuto ? nextDefaults.providerId : current.providerId,
        endpoints: nextConnectionType === "api"
          ? ((current.endpoints || []).length > 0 ? current.endpoints : nextDefaults.endpoints)
          : [],
        endpointDraft: nextConnectionType === "api" ? String(current.endpointDraft || "") : "",
        apiKeyEnv: nextConnectionType === "api"
          ? (apiKeyEnvWasAuto ? nextDefaults.apiKeyEnv : current.apiKeyEnv)
          : "",
        subscriptionProfile: nextConnectionType === "api"
          ? ""
          : (profileWasAuto ? nextDefaults.subscriptionProfile : current.subscriptionProfile),
        modelIds: modelsWereDefault ? nextDefaults.modelIds : current.modelIds,
        modelDraft: "",
        rateLimitRows: nextConnectionType === "api"
          ? nextDefaults.rateLimitRows
          : [],
        headerRows: nextConnectionType === "api"
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
      setModelDiscovery({ signature: apiConnectionSignature, result: payload.result });
      if ((payload.result?.models || []).length > 0) {
        setQuickStart((current) => {
          if (buildQuickStartApiSignature(current) !== apiConnectionSignature || current.connectionType !== "api") return current;
          const currentModelIds = Array.isArray(current.modelIds) ? current.modelIds : [];
          const discoveredModelIds = payload.result.models.map((modelId) => String(modelId || "").trim()).filter(Boolean);
          const nextModelIds = force && currentModelIds.length > 0
            ? Array.from(new Set([...currentModelIds, ...discoveredModelIds]))
            : currentModelIds.length > 0
              ? currentModelIds
              : discoveredModelIds;
          if (JSON.stringify(nextModelIds) === JSON.stringify(currentModelIds)) return current;
          return {
            ...current,
            modelIds: nextModelIds
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

    setBusyAction("oauth-login");
    setTestError("");
    try {
      await fetchJson("/api/subscription/login", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          profileId: resolvedSubscriptionProfile,
          providerId: normalizedProviderId,
          subscriptionType: quickStart.connectionType === "oauth-claude" ? "claude-code" : "chatgpt-codex"
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
    if (stepIndex === 0 && quickStart.connectionType !== "api") {
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
    || (stepIndex === 0 && quickStart.connectionType !== "api" && completedOAuthSignature !== subscriptionLoginSignature
      ? "Continue opens the browser sign-in flow for this provider."
      : stepIndex === 1 && quickStart.connectionType === "api" && !hasFreshApiTest
        ? "Continue will test this provider against the entered endpoints and model ids using your API key or env."
        : steps[stepIndex].detail);
  const showStepBadge = !isAdditionalProviderFlow;
  const headingTitle = isEditMode ? "Edit provider" : isAdditionalProviderFlow ? "Add provider" : "Quick start wizard";
  const headingDescription = isEditMode
    ? "Update this provider in place. Change endpoints, model ids, rate limits, alias, or provider id, then save the refreshed config."
    : isAdditionalProviderFlow
      ? "Add another provider with endpoints, model ids, rate limits, and a stable alias. API-based providers are auto-tested before save."
      : "Add the first provider, models list, rate limits, stable alias, and then start the router. API-based providers are auto-tested before save.";
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
        <div className="mt-3 flex flex-col gap-1 border-t border-border/60 px-1 pt-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="text-sm font-medium text-foreground">{activeStep.title}</div>
          <div className="max-w-2xl text-xs leading-5 text-muted-foreground">{activeStep.detail}</div>
        </div>
      </div>

      {stepIndex === 0 ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            {QUICK_START_CONNECTION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "rounded-2xl border px-4 py-3 text-left transition",
                  quickStart.connectionType === option.value
                    ? "border-ring bg-background shadow-sm"
                    : "border-border/70 bg-background/70 hover:border-border"
                )}
                onClick={() => handleConnectionChange(option.value)}
              >
                <div className="text-sm font-medium text-foreground">{option.label}</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">{option.description}</div>
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Provider name">
              <Input
                value={quickStart.providerName}
                onChange={(event) => handleProviderNameChange(event.target.value)}
                placeholder={getQuickStartConnectionDefaults(quickStart.connectionType).providerName}
              />
            </Field>
            <Field label="Provider id" hint="lowercase-hyphenated">
              <Input
                value={quickStart.providerId}
                onChange={(event) => updateQuickStart("providerId", event.target.value)}
                onBlur={() => updateQuickStart("providerId", slugifyProviderId(quickStart.providerId || quickStart.providerName || "my-provider") || "my-provider")}
                placeholder={getQuickStartConnectionDefaults(quickStart.connectionType).providerId}
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
                  helperText="Paste one or more candidate endpoints. Example for OpenAI-compatible providers: https://api.openai.com/v1"
                />
              </Field>
              <Field label="API key or env">
                <Input
                  value={quickStart.apiKeyEnv}
                  onChange={(event) => updateQuickStart("apiKeyEnv", event.target.value)}
                  placeholder="Example: OPENAI_API_KEY or sk-..."
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
            <div className="rounded-2xl border border-border/70 bg-secondary/45 px-4 py-3 text-sm leading-6 text-muted-foreground">
              {quickStart.connectionType === "oauth-claude"
                ? "Continue opens the Claude sign-in page in your browser and stores the login for this provider automatically."
                : "Continue opens the ChatGPT sign-in page in your browser and stores the login for this provider automatically."}
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
              helperText={quickStart.connectionType === "oauth-claude"
                ? "Examples: claude-opus-4-6 claude-sonnet-4-6 claude-haiku-4-5"
                : quickStart.connectionType === "oauth-gpt"
                  ? "Examples: gpt-5.3-codex gpt-5.2-codex gpt-5.1-codex-mini"
                  : "Examples: gpt-4o-mini gpt-4.1-mini"}
              suggestedValues={suggestedModelIds}
            />
          </Field>
          {quickStart.connectionType === "api" ? (
            <>
              <Field
                label="Rate limit"
                hint="Ids are generated from request and window values. Duplicate caps are blocked automatically."
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
              <div className="mt-2 text-sm font-medium text-foreground">{getQuickStartConnectionLabel(quickStart.connectionType)}</div>
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

      <div className="flex flex-col gap-3 border-t border-border/70 pt-4 md:flex-row md:items-center md:justify-between">
        <div className={cn("text-sm", stepError || testError ? "text-amber-700" : "text-muted-foreground")}>
          {footerMessage}
        </div>
        <div className="flex flex-wrap gap-2">
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
  const [openAmpConfigBusy, setOpenAmpConfigBusy] = useState(false);
  const [openCodexConfigBusy, setOpenCodexConfigBusy] = useState(false);
  const [openClaudeConfigBusy, setOpenClaudeConfigBusy] = useState(false);
  const [routerBusy, setRouterBusy] = useState("");
  const [startupBusy, setStartupBusy] = useState("");
  const [activeTab, setActiveTab] = useState("model-alias");
  const [aliasCreateRequest, setAliasCreateRequest] = useState(0);
  const [remoteConfigUpdated, setRemoteConfigUpdated] = useState(false);
  const [providerWizardOpen, setProviderWizardOpen] = useState(false);
  const [providerWizardKey, setProviderWizardKey] = useState(0);
  const [liveUpdates, setLiveUpdates] = useState({ status: "connecting", attempt: 0 });
  const [ampRoutingBusy, setAmpRoutingBusy] = useState("");
  const [codexRoutingBusy, setCodexRoutingBusy] = useState("");
  const [claudeRoutingBusy, setClaudeRoutingBusy] = useState("");
  const [codexBindingsBusy, setCodexBindingsBusy] = useState(false);
  const [claudeBindingsBusy, setClaudeBindingsBusy] = useState(false);
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
  const reconnectAttemptRef = useRef(0);
  const reconnectNowRef = useRef(() => {});
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
  const aliasSummaryItems = useMemo(
    () => Object.keys(modelAliases).map((aliasId) => ({
      value: aliasId,
      label: aliasId
    })),
    [modelAliases]
  );
  const providerEditorDisabledReason = parsedDraftState.parseError ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}` : "";
  const ampEditableConfig = editableConfig;
  const ampClientUrl = useMemo(() => buildAmpClientUrl(), []);
  const ampClientGlobal = snapshot?.ampClient?.global || {};
  const codexCliState = snapshot?.codingTools?.codexCli || {};
  const claudeCodeState = snapshot?.codingTools?.claudeCode || {};
  const ampRouteOptions = useMemo(() => buildManagedRouteOptions(ampEditableConfig), [ampEditableConfig]);
  const ampRows = useMemo(() => buildAmpEntityRows(ampEditableConfig), [ampEditableConfig]);
  const ampDisabledReason = parsedDraftState.parseError
    ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`
    : (ampRouteOptions.length === 0 ? "Add at least one alias or provider/model route before configuring AMP." : "");
  const codingToolDisabledReason = parsedDraftState.parseError
    ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`
    : (managedRouteOptions.length === 0 ? "Add at least one alias or provider/model route before configuring coding-tool bindings." : "");
  const codexRouteOptions = useMemo(
    () => withCurrentManagedRouteOptions(managedRouteOptions, [codexCliState?.bindings?.defaultModel]),
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
  const onboardingSeedMode = providers.length > 0 ? "existing" : "blank";
  const onboardingTargetProviderId = providers[0]?.id || "";
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
    }, 450);

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

  function handleRequestNewAlias() {
    setAliasCreateRequest((current) => current + 1);
  }

  function showNotice(tone, message) {
    noticeIdRef.current += 1;
    setNotices((current) => [...current, { id: `notice-${noticeIdRef.current}`, tone, message }]);
  }

  function dismissNotice(noticeId) {
    setNotices((current) => current.filter((notice) => notice.id !== noticeId));
  }

  function handleRetryLiveUpdates() {
    reconnectNowRef.current();
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
      reconnectAttemptRef.current += 1;
      setLiveUpdates({ status: "reconnecting", attempt: reconnectAttemptRef.current });
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectEventSource({ isReconnect: true });
      }, LIVE_UPDATES_RETRY_MS);
    }

    function connectEventSource({ isReconnect = false } = {}) {
      if (cancelled) return;
      clearReconnectTimer();
      closeEventSource();
      setLiveUpdates({ status: isReconnect ? "reconnecting" : "connecting", attempt: reconnectAttemptRef.current });
      const source = new EventSource("/api/events");
      eventSourceRef.current = source;

      source.onopen = () => {
        if (cancelled || eventSourceRef.current !== source) return;
        reconnectAttemptRef.current = 0;
        setLiveUpdates({ status: "connected", attempt: 0 });
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

      source.onerror = () => {
        if (cancelled || eventSourceRef.current !== source) return;
        closeEventSource();
        scheduleReconnect();
      };
    }

    reconnectNowRef.current = () => {
      if (cancelled) return;
      clearReconnectTimer();
      connectEventSource({ isReconnect: true });
    };

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
      reconnectNowRef.current = () => {};
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

  function queueAmpAutosave(rawText) {
    const sequence = ampAutosaveSequenceRef.current + 1;
    ampAutosaveSequenceRef.current = sequence;
    setAmpAutosaveRequest({
      sequence,
      rawText
    });
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
      showNotice("warning", "API-based providers require at least one valid http(s) endpoint.");
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

  async function handleCopySummaryItem(item, itemLabel) {
    const value = String(item?.value || "").trim();
    if (!value) {
      showNotice("warning", `${itemLabel} is not ready yet.`);
      return;
    }

    try {
      await copyTextToClipboard(value);
      showNotice("success", `${itemLabel} copied to clipboard.`);
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

  async function handleApplyProviderModels(providerId, rows) {
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
    const currentModelIds = (Array.isArray(existingProvider?.models) ? existingProvider.models : [])
      .map((model) => String(model?.id || "").trim())
      .filter(Boolean);
    const newModelIds = nextRows
      .map((row) => row.id)
      .filter((modelId) => !currentModelIds.includes(modelId));

    if (inferQuickStartConnectionType(existingProvider) === "api" && newModelIds.length > 0) {
      const endpoints = collectQuickStartEndpoints(existingProvider);
      if (endpoints.length === 0) {
        showNotice("warning", `Provider '${providerId}' needs at least one endpoint before testing new models.`);
        return false;
      }

      const credentialPayload = getStoredProviderCredentialPayload(existingProvider);
      if (!credentialPayload.apiKey && !credentialPayload.apiKeyEnv) {
        showNotice("warning", `Provider '${providerId}' needs an API key or env before testing new models.`);
        return false;
      }

      try {
        const result = await fetchJsonLineStream("/api/config/test-provider-stream", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            endpoints,
            models: newModelIds,
            ...credentialPayload,
            ...(existingProvider?.headers && typeof existingProvider.headers === "object" && !Array.isArray(existingProvider.headers)
              ? { headers: existingProvider.headers }
              : {})
          })
        });
        const confirmedModels = new Set(Array.isArray(result?.models) ? result.models : []);
        const unresolvedModels = newModelIds.filter((modelId) => !confirmedModels.has(modelId));
        if (!result?.ok || unresolvedModels.length > 0) {
          const warningMessage = unresolvedModels.length > 0
            ? `New model test failed for ${providerId}: ${unresolvedModels.join(", ")}.`
            : (result?.warnings || []).join(" ") || `New model test failed for ${providerId}.`;
          showNotice("warning", warningMessage);
          return false;
        }
      } catch (error) {
        showNotice("error", error instanceof Error ? error.message : String(error));
        return false;
      }
    }

    const nextConfig = applyProviderModelEdits(parsedDraftState.value || persistedConfig, providerId, nextRows);
    try {
      const successMessage = newModelIds.length > 0
        ? `Tested ${newModelIds.length} new model${newModelIds.length === 1 ? "" : "s"} and updated ${providerId}.`
        : `Updated models for ${providerId}.`;
      await saveInlineConfigObject(nextConfig, successMessage);
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

  async function handleOpenAmpConfigFileDefault() {
    setOpenAmpConfigBusy(true);
    try {
      await fetchJson("/api/amp/config/open", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ editorId: "default" })
      });
      showNotice("success", "Opened AMP config file in the default app.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setOpenAmpConfigBusy(false);
    }
  }

  async function handleOpenCodexConfigFileDefault() {
    setOpenCodexConfigBusy(true);
    try {
      await fetchJson("/api/codex-cli/config/open", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ editorId: "default" })
      });
      showNotice("success", "Opened Codex CLI config file in the default app.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setOpenCodexConfigBusy(false);
    }
  }

  async function handleOpenClaudeConfigFileDefault() {
    setOpenClaudeConfigBusy(true);
    try {
      await fetchJson("/api/claude-code/config/open", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ editorId: "default" })
      });
      showNotice("success", "Opened Claude Code config file in the default app.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setOpenClaudeConfigBusy(false);
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
            defaultModel: codexCliState?.bindings?.defaultModel || ampDefaultRoute
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
            subagentModel: claudeCodeState?.bindings?.subagentModel || ""
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
    if (fieldId !== "defaultModel") return;
    setCodexBindingsBusy(true);
    try {
      await fetchJson("/api/codex-cli/model-bindings", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          bindings: {
            defaultModel: value
          }
        })
      });
      await loadState({ preserveDraft: true });
      showNotice("success", "Codex CLI model binding updated.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setCodexBindingsBusy(false);
    }
  }

  async function handleClaudeBindingChange(fieldId, value) {
    const nextBindings = {
      primaryModel: claudeCodeState?.bindings?.primaryModel || "",
      defaultOpusModel: claudeCodeState?.bindings?.defaultOpusModel || "",
      defaultSonnetModel: claudeCodeState?.bindings?.defaultSonnetModel || "",
      defaultHaikuModel: claudeCodeState?.bindings?.defaultHaikuModel || "",
      subagentModel: claudeCodeState?.bindings?.subagentModel || ""
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
        <LiveUpdatesIndicator status={liveUpdates.status} attempt={liveUpdates.attempt} onRetry={handleRetryLiveUpdates} />
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
      <LiveUpdatesIndicator status={liveUpdates.status} attempt={liveUpdates.attempt} onRetry={handleRetryLiveUpdates} />
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <Card className="overflow-hidden">
          <CardContent className="p-5">
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground">LLM Router Web Console</h1>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant={routerRunning ? "danger" : undefined}
                      onClick={() => runRouterAction(routerRunning ? "stop" : "start")}
                      disabled={routerBusy !== ""}
                    >
                      {routerActionLabel}
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleOpenConfigFileDefault} disabled={openEditorBusy}>
                      {openEditorBusy ? "Opening…" : "Open config file"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runStartupAction(startupInstalled ? "disable" : "enable")}
                      disabled={startupBusy !== ""}
                    >
                      {startupActionLabel}
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
          <ConsoleSummarySection
            aliasItems={aliasSummaryItems}
            onCopyAlias={(item) => handleCopySummaryItem(item, `Alias ${item.value}`)}
          />
          <ProviderModelsSection
            providers={providers}
            onAddProvider={handleOpenQuickStart}
            onRemove={handleRemoveProvider}
            onApplyProviderDetails={handleApplyProviderDetails}
            onApplyProviderModels={handleApplyProviderModels}
            disabledReason={providerEditorDisabledReason}
            busy={saving}
          />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-0">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <TabsList>
              <TabsTrigger value="model-alias">Alias &amp; Fallback</TabsTrigger>
              <TabsTrigger value="amp">AMP</TabsTrigger>
              <TabsTrigger value="codex-cli">Codex CLI</TabsTrigger>
              <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            {activeTab === "model-alias" ? (
              <Button onClick={handleRequestNewAlias} disabled={Boolean(providerEditorDisabledReason) || saving}>
                {saving ? "Saving…" : "Add alias"}
              </Button>
            ) : null}
          </div>

          <TabsContent value="model-alias" className="space-y-4">
            <ModelAliasSection
              aliases={modelAliases}
              aliasIds={Object.keys(modelAliases)}
              routeOptions={managedRouteOptions}
              defaultModel={String(editableConfig?.defaultModel || "").trim()}
              ampDefaultRoute={ampDefaultRoute}
              disabledReason={providerEditorDisabledReason}
              busy={saving}
              requestAddAliasToken={aliasCreateRequest}
              onApplyAlias={handleApplyModelAlias}
              onRemoveAlias={handleRemoveModelAlias}
            />
          </TabsContent>

          <TabsContent value="amp" className="space-y-4">
            <AmpSettingsPanel
              rows={ampRows}
              routeOptions={ampRouteOptions}
              ampClientUrl={ampClientUrl}
              ampClientGlobal={ampClientGlobal}
              routingBusy={ampRoutingBusy}
              openAmpConfigBusy={openAmpConfigBusy}
              onToggleGlobalRouting={handleToggleAmpGlobalRouting}
              onOpenAmpConfigFile={handleOpenAmpConfigFileDefault}
              onInboundChange={handleAmpInboundChange}
              onOutboundChange={handleAmpOutboundChange}
              onCreateEntry={handleCreateAmpEntry}
              onRemoveEntry={handleRemoveAmpEntry}
              hasMasterKey={Boolean(String(ampEditableConfig?.masterKey || "").trim())}
              disabledReason={ampDisabledReason}
              autosaveState={ampAutosaveState}
            />
          </TabsContent>

          <TabsContent value="codex-cli" className="space-y-4">
            <CodingToolSettingsPanel
              toolName="Codex CLI"
              openButtonLabel="Open Codex CLI Config File"
              toolState={codexCliState}
              endpointUrl={codexCliState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/openai/v1` : ""}`}
              routeOptions={codexRouteOptions}
              connectionBusy={codexRoutingBusy}
              bindingBusy={codexBindingsBusy}
              openConfigBusy={openCodexConfigBusy}
              onToggleRouting={handleToggleCodexCliRouting}
              onOpenConfigFile={handleOpenCodexConfigFileDefault}
              onBindingChange={handleCodexBindingChange}
              hasMasterKey={Boolean(effectiveMasterKey)}
              disabledReason={codingToolDisabledReason}
              bindingFields={[
                {
                  id: "defaultModel",
                  label: "Default model",
                  description: "Sets the Codex CLI global `model` value so prompts go to one managed route or alias by default.",
                  envKey: "model",
                  value: codexCliState?.bindings?.defaultModel || "",
                  allowUnset: false,
                  placeholder: "Select a default route"
                }
              ]}
            />
          </TabsContent>

          <TabsContent value="claude-code" className="space-y-4">
            <CodingToolSettingsPanel
              toolName="Claude Code"
              openButtonLabel="Open Claude Code Config File"
              toolState={claudeCodeState}
              endpointUrl={claudeCodeState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/anthropic` : ""}`}
              routeOptions={claudeRouteOptions}
              connectionBusy={claudeRoutingBusy}
              bindingBusy={claudeBindingsBusy}
              openConfigBusy={openClaudeConfigBusy}
              onToggleRouting={handleToggleClaudeCodeRouting}
              onOpenConfigFile={handleOpenClaudeConfigFileDefault}
              onBindingChange={handleClaudeBindingChange}
              hasMasterKey={Boolean(effectiveMasterKey)}
              disabledReason={codingToolDisabledReason}
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
                }
              ]}
            />
          </TabsContent>

          <TabsContent value="activity">
            <LogList logs={snapshot?.logs || []} />
          </TabsContent>
        </Tabs>

        <Modal
          open={showProviderWizardModal}
          onClose={handleHideQuickStart}
          title="Add provider"
          description="Add another provider with endpoints, model ids, rate limits, and a stable alias. API-based providers are auto-tested before save."
          contentClassName="max-h-[92vh] max-w-5xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
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
