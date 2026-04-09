import { MODEL_ALIAS_STRATEGY_OPTIONS, MODEL_ALIAS_STRATEGY_LABELS, DRAGGING_ROW_CLASSES, ACTIVITY_CATEGORY_META } from "./constants.js";
import {
  normalizeRateLimitModelSelectors,
  normalizeRateLimitWindowUnit,
  RATE_LIMIT_ALL_MODELS_SELECTOR,
  formatRateLimitBucketCap
} from "./rate-limit-utils.js";
import { PROVIDER_PRESET_BY_KEY } from "./provider-presets.js";

export function splitListValues(value) {
  return Array.from(new Set(String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)));
}

export function isLikelyHttpEndpoint(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function mergeChipValuesAndDraft(values = [], draft = "") {
  return Array.from(new Set([
    ...(Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean),
    ...splitListValues(draft)
  ]));
}

export function moveItemsByKey(items = [], fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return items;
  const nextItems = [...items];
  const fromIndex = nextItems.findIndex((item) => item?.key === fromKey);
  const toIndex = nextItems.findIndex((item) => item?.key === toKey);
  if (fromIndex === -1 || toIndex === -1) return items;
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

export function moveItemUp(items = [], itemKey, getKey = (item) => item?.key) {
  if (!itemKey) return items;
  const currentIndex = items.findIndex((item) => getKey(item) === itemKey);
  if (currentIndex <= 0) return items;
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(currentIndex, 1);
  nextItems.splice(currentIndex - 1, 0, movedItem);
  return nextItems;
}

export function moveItemDown(items = [], itemKey, getKey = (item) => item?.key) {
  if (!itemKey) return items;
  const currentIndex = items.findIndex((item) => getKey(item) === itemKey);
  if (currentIndex === -1 || currentIndex >= items.length - 1) return items;
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(currentIndex, 1);
  nextItems.splice(currentIndex + 1, 0, movedItem);
  return nextItems;
}

export function captureScrollSettleSnapshot(node, scrollContainers = []) {
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

export function isScrollSettleSnapshotStable(previousSnapshot, nextSnapshot, threshold = 0.5) {
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

export function getActivityEntryCategory(entry) {
  const category = String(entry?.category || "").trim().toLowerCase();
  if (category === "usage" || category === "router") return category;
  const source = String(entry?.source || "").trim().toLowerCase();
  const kind = String(entry?.kind || "").trim().toLowerCase();
  if (source === "runtime" || kind.startsWith("request") || kind.startsWith("fallback")) {
    return "usage";
  }
  return "router";
}

export function setDraggingRowClasses(node, active) {
  if (!node?.classList) return;
  if (active) {
    node.classList.add(...DRAGGING_ROW_CLASSES);
    return;
  }
  node.classList.remove(...DRAGGING_ROW_CLASSES);
}

export function getReorderRowNode(node) {
  return typeof node?.closest === "function" ? node.closest("[data-reorder-row='true']") : null;
}

export function normalizeModelAliasStrategyValue(strategy) {
  const normalized = String(strategy || "").trim().toLowerCase();
  if (normalized === "automatic" || normalized === "smart") return "auto";
  if (normalized === "rr") return "round-robin";
  if (normalized === "weighted-round-robin" || normalized === "weighted_rr") return "weighted-rr";
  if (normalized === "quota-aware-weighted-round-robin") return "quota-aware-weighted-rr";
  return Object.prototype.hasOwnProperty.call(MODEL_ALIAS_STRATEGY_LABELS, normalized) ? normalized : "ordered";
}

export function formatModelAliasStrategyLabel(strategy) {
  const normalized = normalizeModelAliasStrategyValue(strategy);
  return MODEL_ALIAS_STRATEGY_LABELS[normalized] || MODEL_ALIAS_STRATEGY_LABELS.ordered;
}

export function normalizeUniqueTrimmedValues(values = []) {
  return Array.from(new Set((values || []).map((entry) => String(entry || "").trim()).filter(Boolean)));
}

export function hasDuplicateTrimmedValues(values = []) {
  const seen = new Set();
  for (const value of (values || []).map((entry) => String(entry || "").trim()).filter(Boolean)) {
    if (seen.has(value)) return true;
    seen.add(value);
  }
  return false;
}

export function hasDuplicateHeaderName(rows = [], name = "", exceptIndex = -1) {
  const normalizedName = String(name || "").trim().toLowerCase();
  if (!normalizedName) return false;
  return (rows || []).some((row, index) => index !== exceptIndex && String(row?.name || "").trim().toLowerCase() === normalizedName);
}

export function createPendingAliasSeed() {
  return {
    id: "",
    strategy: "auto",
    targets: [{ ref: "" }],
    fallbackTargets: []
  };
}

export function buildAliasDraftResetKey(aliasId = "", alias = {}, { isNew = false } = {}) {
  return JSON.stringify({
    aliasId: isNew ? "" : String(aliasId || "").trim(),
    id: String(alias?.id || (isNew ? "" : aliasId) || "").trim(),
    strategy: String(alias?.strategy || "ordered").trim() || "ordered",
    targets: (Array.isArray(alias?.targets) ? alias.targets : []).map((target) => String(target?.ref || "").trim()),
    fallbackTargets: (Array.isArray(alias?.fallbackTargets) ? alias.fallbackTargets : []).map((target) => String(target?.ref || "").trim())
  });
}

export function createMasterKey() {
  const prefix = "gw_";
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(18);
    globalThis.crypto.getRandomValues(bytes);
    return `${prefix}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `${prefix}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function looksLikeEnvVarName(value) {
  return /^[A-Z][A-Z0-9_]*$/.test(String(value || "").trim());
}

export function slugifyProviderId(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!normalized) return "";
  if (/^[a-z]/.test(normalized)) return normalized;
  return `provider-${normalized}`;
}

export function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function collectProviderModelIds(provider = {}) {
  return normalizeUniqueTrimmedValues(
    (Array.isArray(provider?.models) ? provider.models : []).map((model) => model?.id)
  );
}

export function createRateLimitDraftRow(row = {}, {
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

export function createRateLimitDraftRows(rateLimits = [], {
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

export function isBlankRateLimitDraftRow(row = {}) {
  const models = normalizeRateLimitModelSelectors(mergeChipValuesAndDraft(row?.models, row?.modelsDraft || ""));
  return models.length === 0
    && !String(row?.requests ?? "").trim()
    && !String(row?.windowValue ?? "").trim();
}

export function resolveRateLimitDraftRows(rows = []) {
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

export function serializeRateLimitDraftRows(rows = []) {
  return resolveRateLimitDraftRows(rows).map((row) => ({
    sourceId: row.sourceId,
    models: row.models,
    requests: row.requests,
    windowValue: row.windowValue,
    windowUnit: row.windowUnit
  }));
}

export function formatRateLimitSummary(rateLimits = []) {
  const buckets = Array.isArray(rateLimits) ? rateLimits.filter(Boolean) : [];
  if (buckets.length === 0) return "";
  if (buckets.length === 1) return formatRateLimitBucketCap(buckets[0]);
  return `${buckets.length} rate limits`;
}

export function safeClone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

export function tryParseConfigObject(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function parseDraftConfigText(rawText, fallback = {}) {
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

export function formatTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function detectValidationVariant(summary) {
  if (summary?.parseError) return "danger";
  if ((summary?.validationErrors || []).length > 0) return "warning";
  return "success";
}

export function describeConfigStatus(summary) {
  const variant = detectValidationVariant(summary);
  if (variant === "danger") return { variant, label: "Config: invalid" };
  if (variant === "warning") return { variant, label: "Config: invalid" };
  return { variant: "success", label: "Config: valid" };
}
