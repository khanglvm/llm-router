import { promises as fsPromises } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { SnapTui, runPasswordPrompt } from "@levu/snap/dist/index.js";
import {
  applyConfigChanges,
  buildProviderFromConfigInput,
  buildWorkerConfigPayload,
  parseModelListInput
} from "../node/config-workflows.js";
import {
  configFileExists,
  getDefaultConfigPath,
  migrateConfigFile,
  readConfigFile,
  removeProvider,
  writeConfigFile
} from "../node/config-store.js";
import { probeProvider, probeProviderEndpointMatrix } from "../node/provider-probe.js";
import { runStartCommand } from "../node/start-command.js";
import { installStartup, restartStartup, startupStatus, stopStartup, uninstallStartup } from "../node/startup-manager.js";
import {
  buildStartArgsFromState,
  clearRuntimeState,
  getActiveRuntimeState,
  spawnDetachedStart,
  stopProcessByPid
} from "../node/instance-state.js";
import {
  CONFIG_VERSION,
  configHasProvider,
  DEFAULT_PROVIDER_USER_AGENT,
  maskSecret,
  PROVIDER_ID_PATTERN,
  sanitizeConfigForDisplay,
  validateRuntimeConfig
} from "../runtime/config.js";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_VALIDATION = 2;
const NPM_PACKAGE_NAME = "@khanglvm/llm-router";
const STRONG_MASTER_KEY_MIN_LENGTH = 24;
const DEFAULT_GENERATED_MASTER_KEY_LENGTH = 48;
const MAX_GENERATED_MASTER_KEY_LENGTH = 256;
const WEAK_MASTER_KEY_PATTERN = /(password|changeme|default|secret|token|admin|qwerty|letmein|123456)/i;
export const CLOUDFLARE_FREE_SECRET_SIZE_LIMIT_BYTES = 5 * 1024;
const CLOUDFLARE_FREE_TIER_PATTERN = /\bfree\b/i;
const CLOUDFLARE_PAID_TIER_PATTERN = /\b(pro|business|enterprise|paid|unbound)\b/i;
const CLOUDFLARE_API_TOKEN_ENV_NAME = "CLOUDFLARE_API_TOKEN";
const CLOUDFLARE_API_TOKEN_ALT_ENV_NAME = "CF_API_TOKEN";
const CLOUDFLARE_ACCOUNT_ID_ENV_NAME = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_API_TOKEN_PRESET_NAME = "Edit Cloudflare Workers";
const CLOUDFLARE_API_TOKEN_DASHBOARD_URL = "https://dash.cloudflare.com/profile/api-tokens";
const CLOUDFLARE_API_TOKEN_GUIDE_URL = "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/";
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_VERIFY_TOKEN_URL = `${CLOUDFLARE_API_BASE_URL}/user/tokens/verify`;
const CLOUDFLARE_MEMBERSHIPS_URL = `${CLOUDFLARE_API_BASE_URL}/memberships`;
const CLOUDFLARE_ZONES_URL = `${CLOUDFLARE_API_BASE_URL}/zones`;
const CLOUDFLARE_API_PREFLIGHT_TIMEOUT_MS = 10_000;
const MODEL_ALIAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MODEL_ROUTING_STRATEGY_OPTIONS = [
  {
    value: "auto",
    label: "Auto",
    hint: "Recommended set-and-forget mode. Uses quota, cooldown, and health signals to avoid rate limits."
  },
  {
    value: "ordered",
    label: "Ordered",
    hint: "Try targets in the listed order. Move to the next one only when earlier targets are unavailable."
  },
  {
    value: "round-robin",
    label: "Round-robin",
    hint: "Rotate evenly across eligible targets."
  },
  {
    value: "weighted-rr",
    label: "Weighted round-robin",
    hint: "Rotate across eligible targets, but favor higher weights."
  },
  {
    value: "quota-aware-weighted-rr",
    label: "Quota-aware weighted round-robin",
    hint: "Like weighted round-robin, but also shifts traffic away from targets nearing limits."
  }
];
const MODEL_ALIAS_STRATEGIES = MODEL_ROUTING_STRATEGY_OPTIONS.map((option) => option.value);
const DEFAULT_PROBE_REQUESTS_PER_MINUTE = 30;
const DEFAULT_PROBE_MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_AI_HELP_GATEWAY_TEST_TIMEOUT_MS = 6000;
const RATE_LIMIT_WINDOW_UNIT_ALIASES = new Map([
  ["s", "second"],
  ["sec", "second"],
  ["second", "second"],
  ["seconds", "second"],
  ["m", "minute"],
  ["min", "minute"],
  ["minute", "minute"],
  ["minutes", "minute"],
  ["h", "hour"],
  ["hr", "hour"],
  ["hour", "hour"],
  ["hours", "hour"],
  ["d", "day"],
  ["day", "day"],
  ["days", "day"],
  ["w", "week"],
  ["wk", "week"],
  ["week", "week"],
  ["weeks", "week"],
  ["mo", "month"],
  ["mon", "month"],
  ["month", "month"],
  ["months", "month"]
]);

function canPrompt() {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

function readArg(args, names, fallback = undefined) {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== "") return args[name];
  }
  return fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInteger(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Math.floor(toNumber(value, Number.NaN));
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function clampMasterKeyLength(value) {
  const parsed = Math.floor(toNumber(value, DEFAULT_GENERATED_MASTER_KEY_LENGTH));
  if (!Number.isFinite(parsed)) return DEFAULT_GENERATED_MASTER_KEY_LENGTH;
  return Math.min(MAX_GENERATED_MASTER_KEY_LENGTH, Math.max(parsed, STRONG_MASTER_KEY_MIN_LENGTH));
}

function normalizeMasterKeyPrefix(value) {
  const normalized = String(value ?? "gw_")
    .replace(/[\r\n\t]/g, "")
    .trim();
  if (!normalized) return "gw_";
  return normalized.slice(0, 32);
}

function analyzeMasterKeyStrength(rawKey) {
  const key = String(rawKey || "");
  const reasons = [];
  if (key.length < STRONG_MASTER_KEY_MIN_LENGTH) {
    reasons.push(`length must be >= ${STRONG_MASTER_KEY_MIN_LENGTH}`);
  }

  const hasLower = /[a-z]/.test(key);
  const hasUpper = /[A-Z]/.test(key);
  const hasDigit = /[0-9]/.test(key);
  const hasSymbol = /[^A-Za-z0-9]/.test(key);
  const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
  if (classes < 3) {
    reasons.push("use at least 3 character classes (lower/upper/digits/symbols)");
  }

  if (WEAK_MASTER_KEY_PATTERN.test(key)) {
    reasons.push("contains common weak pattern");
  }
  if (/(.)\1{5,}/.test(key)) {
    reasons.push("contains long repeated characters");
  }

  return {
    strong: reasons.length === 0,
    reasons
  };
}

function generateStrongMasterKey({ length, prefix } = {}) {
  const targetLength = clampMasterKeyLength(length);
  const safePrefix = normalizeMasterKeyPrefix(prefix);
  const randomLength = Math.max(
    STRONG_MASTER_KEY_MIN_LENGTH,
    targetLength - safePrefix.length
  );

  let fallbackKey = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const token = randomBytes(Math.ceil(randomLength * 0.8) + 16)
      .toString("base64url")
      .slice(0, randomLength);
    const key = `${safePrefix}${token}`;
    fallbackKey = key;
    if (analyzeMasterKeyStrength(key).strong) {
      return key;
    }
  }

  return fallbackKey;
}

async function ensureStrongWorkerMasterKey(context, masterKey, { allowWeakMasterKey = false } = {}) {
  const report = analyzeMasterKeyStrength(masterKey);
  if (report.strong || allowWeakMasterKey) {
    return { ok: true, allowWeakMasterKey };
  }

  const reasons = report.reasons.join("; ");
  if (canPrompt()) {
    const proceed = await context.prompts.confirm({
      message: `Worker master key looks weak (${reasons}). Continue anyway?`,
      initialValue: false
    });
    if (proceed) {
      return { ok: true, allowWeakMasterKey: true };
    }
  }

  return {
    ok: false,
    errorMessage: `Weak worker master key rejected (${reasons}). Use a stronger random key or pass --allow-weak-master-key=true to override.`
  };
}

function parseJsonObjectArg(value, fieldName) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`${fieldName} must be a JSON object string. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasHeaderName(headers, name) {
  const lower = String(name).toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === lower);
}

function applyDefaultHeaders(headers, { force = true } = {}) {
  const source = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  const next = { ...source };
  if (force && !hasHeaderName(next, "user-agent")) {
    next["User-Agent"] = DEFAULT_PROVIDER_USER_AGENT;
  }
  return next;
}

async function promptSecretInput(context, {
  message,
  required = true,
  validate
} = {}) {
  if (context?.prompts && typeof context.prompts.password === "function") {
    return context.prompts.password({
      message,
      required,
      validate,
      mask: "*"
    });
  }

  if (canPrompt()) {
    return runPasswordPrompt({
      message,
      required,
      validate,
      mask: "*"
    });
  }

  return context.prompts.text({
    message,
    required,
    validate
  });
}

function providerEndpointsFromConfig(provider) {
  const values = [
    provider?.baseUrlByFormat?.openai,
    provider?.baseUrlByFormat?.claude,
    provider?.baseUrl
  ];
  return parseModelListInput(values.filter(Boolean).join(","));
}

function normalizeNameForCompare(value) {
  return String(value || "").trim().toLowerCase();
}

function findProviderByFriendlyName(providers, name, { excludeId = "" } = {}) {
  const needle = normalizeNameForCompare(name);
  if (!needle) return null;
  const excluded = String(excludeId || "").trim();
  return (providers || []).find((provider) => {
    if (!provider || typeof provider !== "object") return false;
    const sameName = normalizeNameForCompare(provider.name) === needle;
    if (!sameName) return false;
    if (!excluded) return true;
    return String(provider.id || "").trim() !== excluded;
  }) || null;
}

function printProviderInputGuidance(context) {
  if (!canPrompt()) return;
  const info = typeof context?.terminal?.info === "function" ? context.terminal.info.bind(context.terminal) : null;
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
  const warn = typeof context?.terminal?.warn === "function" ? context.terminal.warn.bind(context.terminal) : null;
  if (!line) return;

  info?.("Provider config tips:");
  line("  - Provider Friendly Name is shown in the management screen and must be unique.");
  line("  - Provider ID is auto-generated by slugifying the friendly name; you can edit it.");
  line("  - Examples:");
  line("    Friendly Name: OpenRouter Primary, RamClouds Production");
  line("    Provider ID: openrouterPrimary, ramcloudsProd");
  line("    API Key: sk-or-v1-xxxxxxxx, sk-ant-api03-xxxxxxxx, sk-xxxxxxxx");
}

function trimOuterPunctuation(value) {
  return String(value || "")
    .trim()
    .replace(/^[\s"'`([{<]+/, "")
    .replace(/[\s"'`)\]}>.,;:]+$/, "")
    .trim();
}

function dedupeList(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function tokenizeLooseListInput(raw) {
  if (Array.isArray(raw)) return dedupeList(raw.flatMap((item) => tokenizeLooseListInput(item)));
  const text = String(raw || "").replace(/[;,]+/g, "\n");
  const tokens = text
    .split(/\r?\n/g)
    .flatMap((line) => String(line || "").trim().split(/\s+/g));
  return dedupeList(tokens);
}

function normalizeEndpointToken(token) {
  let value = trimOuterPunctuation(token);
  if (!value) return "";

  value = value
    .replace(/^(?:openaiBaseUrl|claudeBaseUrl|anthropicBaseUrl|baseUrl)\s*=\s*/i, "")
    .replace(/^url\s*=\s*/i, "");

  const urlMatch = value.match(/https?:\/\/[^\s,;'"`<>()\]]*?(?=(?:https?:\/\/)|[\s,;'"`<>()\]]|$)/i);
  if (urlMatch) value = urlMatch[0];

  // Common typo: missing colon after scheme.
  if (/^http\/\/+/i.test(value) || /^https\/\/+/i.test(value)) {
    value = value.replace(/^http\/\/+/i, "http://").replace(/^https\/\/+/i, "https://");
  }
  if (/^ttps?:\/\//i.test(value)) {
    value = `h${value}`;
  }
  if (/^https?:\/\/$/i.test(value)) return "";

  // Accept domain-like values pasted without scheme.
  if (!/^https?:\/\//i.test(value) && /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?$/i.test(value)) {
    value = `https://${value}`;
  }

  value = value.replace(/[)\]}>.,;:]+$/g, "");
  return /^https?:\/\/.+/i.test(value) ? value : "";
}

function splitConcatenatedEndpointSchemes(text) {
  return String(text || "").replace(/([A-Za-z0-9/_-])(https?:\/\/)/g, "$1\n$2");
}

export function parseEndpointListInput(raw) {
  const text = splitConcatenatedEndpointSchemes(Array.isArray(raw) ? raw.join("\n") : String(raw || ""));
  const extracted = [];

  const urlRegex = /https?:\/\/[^\s,;'"`<>()\]]*?(?=(?:https?:\/\/)|[\s,;'"`<>()\]]|$)/gi;
  for (const match of text.matchAll(urlRegex)) {
    extracted.push(match[0]);
  }

  const typoUrlRegex = /\bhttps?:\/\/?[^\s,;'"`<>()\]]+/gi;
  for (const match of text.matchAll(typoUrlRegex)) {
    extracted.push(match[0]);
  }

  const domainRegex = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s,;'"`<>()\]]*)?/gi;
  for (const match of text.matchAll(domainRegex)) {
    extracted.push(match[0]);
  }

  const fallbackTokens = tokenizeLooseListInput(text);
  const normalized = dedupeList([...(extracted.length > 0 ? extracted : []), ...fallbackTokens]
    .map(normalizeEndpointToken)
    .filter(Boolean));

  return normalized;
}

const MODEL_INPUT_NOISE_TOKENS = new Set([
  "discover",
  "progress",
  "endpoint",
  "testing",
  "formats",
  "format",
  "working",
  "supported",
  "auto-discovery",
  "auto",
  "discovery",
  "completed",
  "started",
  "done",
  "openai",
  "claude",
  "anthropic",
  "skip",
  "ok",
  "tentative",
  "listed",
  "assigned",
  "rate-limit",
  "rate-limit-max-retries",
  "runtime-error",
  "network-error",
  "format-mismatch",
  "model-unsupported",
  "auth-error",
  "unconfirmed",
  "error",
  "errors",
  "warning",
  "warnings",
  "failed",
  "failure",
  "invalid",
  "request",
  "response",
  "http",
  "https",
  "status",
  "probe",
  "provider",
  "models",
  "model",
  "on",
  "at"
]);

function normalizeModelToken(token) {
  let value = trimOuterPunctuation(token);
  if (!value) return "";

  value = value
    .replace(/^(?:models?|modelSupport|modelPreferredFormat)\s*=\s*/i, "")
    .replace(/\[(?:openai|claude)\]?$/i, "")
    .replace(/[)\]}>.,;:]+$/g, "")
    .trim();

  if (!value) return "";
  if (value.includes("://")) return "";
  if (value.includes("@")) return "";
  if (/^\d+(?:\/\d+)?$/.test(value)) return "";
  if (/^https?$/i.test(value)) return "";
  if (/^(?:openai|claude|anthropic)$/i.test(value)) return "";
  if (MODEL_INPUT_NOISE_TOKENS.has(value.toLowerCase())) return "";

  // Ignore obvious prose fragments. Keep model-like IDs with delimiters.
  if (!/[._:/-]/.test(value) && !/\d/.test(value)) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) return "";

  return value;
}

function parseProviderModelListInput(raw) {
  const text = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
  const extracted = [];

  // "Progress ... - <model> on <format> @ <endpoint>"
  const progressRegex = /-\s+([A-Za-z0-9][A-Za-z0-9._:/-]*)\s+on\s+(?:openai|claude)\s+@/gi;
  for (const match of text.matchAll(progressRegex)) {
    extracted.push(match[1]);
  }

  // "models=foo[openai], bar[claude]"
  const modelsLineRegex = /\bmodels?\s*=\s*([^\n\r]+)/gi;
  for (const match of text.matchAll(modelsLineRegex)) {
    extracted.push(...tokenizeLooseListInput(match[1]));
  }

  const fallbackTokens = tokenizeLooseListInput(text);
  return dedupeList([...(extracted.length > 0 ? extracted : []), ...fallbackTokens]
    .map(normalizeModelToken)
    .filter(Boolean));
}

function normalizeQualifiedModelToken(token) {
  const value = trimOuterPunctuation(token)
    .replace(/[)\]}>.,;:]+$/g, "")
    .trim();
  if (!value) return "";
  if (value.includes("://") || value.includes("@")) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) return "";
  return value;
}

function parseQualifiedModelListInput(raw) {
  const text = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
  const tokens = tokenizeLooseListInput(text);
  return dedupeList(tokens
    .map(normalizeQualifiedModelToken)
    .filter(Boolean));
}

function normalizeAliasTargetToken(token) {
  const value = trimOuterPunctuation(token)
    .replace(/[)\]}>.,;]+$/g, "")
    .trim();
  if (!value) return "";
  if (value.includes("://")) return "";
  if (/\s/.test(value)) return "";
  return value;
}

function parseAliasTargetToken(token) {
  const normalized = normalizeAliasTargetToken(token);
  if (!normalized) return null;

  const splitByWeight = (separator) => {
    const index = normalized.lastIndexOf(separator);
    if (index <= 0 || index >= normalized.length - 1) return null;
    const refPart = normalized.slice(0, index).trim();
    const weightPart = normalized.slice(index + 1).trim();
    if (!refPart || !weightPart) return null;
    const weight = Number(weightPart);
    if (!Number.isFinite(weight) || weight <= 0) return null;
    return {
      ref: refPart,
      weight
    };
  };

  const fromAt = splitByWeight("@");
  if (fromAt) return fromAt;
  const fromColon = splitByWeight(":");
  if (fromColon) return fromColon;
  return { ref: normalized };
}

export function parseAliasTargetListInput(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const entries = raw
      .map((entry) => {
        if (typeof entry === "string") return parseAliasTargetToken(entry);
        if (!entry || typeof entry !== "object") return null;
        const parsed = parseAliasTargetToken(entry.ref || entry.target || "");
        if (!parsed) return null;
        if (entry.weight !== undefined) {
          const weight = Number(entry.weight);
          if (!Number.isFinite(weight) || weight <= 0) return null;
          parsed.weight = weight;
        }
        if (entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)) {
          parsed.metadata = entry.metadata;
        }
        return parsed;
      })
      .filter(Boolean);
    return dedupeAliasTargets(entries);
  }

  const text = String(raw || "").trim();
  if (!text) return [];
  if ((text.startsWith("[") && text.endsWith("]")) || (text.startsWith("{") && text.endsWith("}"))) {
    try {
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return parseAliasTargetListInput(rows);
    } catch {
      // Fall through to token parsing for forgiving CLI input.
    }
  }

  const tokens = tokenizeLooseListInput(text);
  const entries = tokens.map(parseAliasTargetToken).filter(Boolean);
  return dedupeAliasTargets(entries);
}

function dedupeAliasTargets(targets) {
  const seen = new Set();
  const rows = [];
  for (const target of (targets || [])) {
    const ref = String(target?.ref || "").trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    rows.push({
      ref,
      ...(Number.isFinite(target?.weight) && Number(target.weight) > 0 ? { weight: Number(target.weight) } : {}),
      ...(target?.metadata && typeof target.metadata === "object" && !Array.isArray(target.metadata)
        ? { metadata: target.metadata }
        : {})
    });
  }
  return rows;
}

function normalizeRateLimitModelSelectorToken(token) {
  const value = trimOuterPunctuation(token)
    .replace(/[)\]}>.,;:]+$/g, "")
    .trim();
  if (!value) return "";
  if (value.includes("://")) return "";
  if (/\s/.test(value)) return "";
  if (value.toLowerCase() === "all") return "all";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) return "";
  return value;
}

function parseRateLimitModelSelectorsInput(raw) {
  if (!raw) return [];
  const tokens = tokenizeLooseListInput(raw);
  return dedupeList(tokens.map(normalizeRateLimitModelSelectorToken).filter(Boolean));
}

function normalizeRateLimitWindowUnit(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!key) return "";
  return RATE_LIMIT_WINDOW_UNIT_ALIASES.get(key) || "";
}

export function parseRateLimitWindowInput(raw) {
  if (!raw && raw !== 0) return null;

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const unit = normalizeRateLimitWindowUnit(raw.unit || raw.windowUnit || raw["window-unit"]);
    const size = Number.parseInt(String(raw.size ?? raw.windowSize ?? raw["window-size"] ?? ""), 10);
    if (!unit || !Number.isFinite(size) || size <= 0) return null;
    return { unit, size };
  }

  const text = String(raw || "").trim();
  if (!text) return null;

  const unitFirst = text.match(/^([A-Za-z]+)\s*[:/x-]?\s*(\d+)$/);
  if (unitFirst) {
    const unit = normalizeRateLimitWindowUnit(unitFirst[1]);
    const size = Number.parseInt(unitFirst[2], 10);
    if (!unit || !Number.isFinite(size) || size <= 0) return null;
    return { unit, size };
  }

  const sizeFirst = text.match(/^(\d+)\s*([A-Za-z]+)$/);
  if (sizeFirst) {
    const unit = normalizeRateLimitWindowUnit(sizeFirst[2]);
    const size = Number.parseInt(sizeFirst[1], 10);
    if (!unit || !Number.isFinite(size) || size <= 0) return null;
    return { unit, size };
  }

  return null;
}

function maybeReportInputCleanup(context, label, rawValue, cleanedValues) {
  if (!canPrompt()) return;
  const info = typeof context?.terminal?.info === "function" ? context.terminal.info.bind(context.terminal) : null;
  const warn = typeof context?.terminal?.warn === "function" ? context.terminal.warn.bind(context.terminal) : null;
  if (!info && !warn) return;

  const raw = String(rawValue || "").trim();
  if (!raw) return;

  const normalizedRaw = raw.toLowerCase();
  const looksMessy =
    /[;\n\r\t]/.test(raw) ||
    /\[discover\]|auto-discovery|error|warning|failed|models?=/i.test(raw) ||
    /\s{2,}/.test(raw);

  if (!looksMessy) return;

  if ((cleanedValues || []).length > 0) {
    info?.(`Cleaned ${label} input: parsed ${(cleanedValues || []).length} item(s) from free-form text.`);
  } else {
    warn?.(`Could not parse any ${label} from the provided text. Use comma/semicolon/space/newline-separated values.`);
  }
}

function truncateLogText(value, max = 160) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function formatDurationMs(value) {
  const ms = Math.max(0, Math.round(Number(value) || 0));
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function describeModelCheckStatus(event) {
  const statusCode = Number(event.status || 0);
  const statusSuffix = statusCode > 0 ? ` (http ${statusCode})` : "";
  const rawMessage = event.error || event.message || "";
  const detail = truncateLogText(rawMessage === "ok" ? "" : rawMessage);
  const outcome = String(event.outcome || "");

  if (event.confirmed) {
    if (outcome === "already-assigned") {
      return {
        shortLabel: "assigned",
        fullLabel: `assigned${statusSuffix}`,
        detail,
        isOk: true
      };
    }
    if (outcome === "model-listed") {
      return {
        shortLabel: "listed",
        fullLabel: `listed${statusSuffix}`,
        detail,
        isOk: true
      };
    }
    return {
      shortLabel: "ok",
      fullLabel: `ok${statusSuffix}`,
      detail,
      isOk: true
    };
  }

  if (outcome === "runtime-error") {
    return {
      shortLabel: "runtime-error",
      fullLabel: `runtime-error${statusSuffix}`,
      detail,
      isOk: false
    };
  }
  if (outcome === "rate-limit") {
    return {
      shortLabel: "rate-limit",
      fullLabel: `rate-limit${statusSuffix}`,
      detail,
      isOk: false
    };
  }
  if (outcome === "rate-limit-max-retries") {
    return {
      shortLabel: "rate-limit-max-retries",
      fullLabel: `rate-limit-max-retries${statusSuffix}`,
      detail,
      isOk: false
    };
  }
  if (outcome === "model-unsupported") {
    return {
      shortLabel: "model-unsupported",
      fullLabel: `model-unsupported${statusSuffix}`,
      detail,
      isOk: false
    };
  }
  if (outcome === "format-mismatch") {
    return {
      shortLabel: "format-mismatch",
      fullLabel: `format-mismatch${statusSuffix}`,
      detail,
      isOk: false
    };
  }
  if (outcome === "network-error") {
    return {
      shortLabel: "network-error",
      fullLabel: `network-error${statusSuffix}`,
      detail,
      isOk: false
    };
  }
  if (outcome === "auth-error") {
    return {
      shortLabel: "auth-error",
      fullLabel: `auth-error${statusSuffix}`,
      detail,
      isOk: false
    };
  }
  if (outcome === "unconfirmed") {
    return {
      shortLabel: "unconfirmed",
      fullLabel: `unconfirmed${statusSuffix}`,
      detail,
      isOk: false
    };
  }

  return {
    shortLabel: event.supported ? "tentative" : "skip",
    fullLabel: `${event.supported ? "tentative" : "skip"}${statusSuffix}`,
    detail,
    isOk: false
  };
}

function probeProgressReporter(context) {
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
  if (!line) return () => {};

  const info = typeof context?.terminal?.info === "function" ? context.terminal.info.bind(context.terminal) : line;
  const success = typeof context?.terminal?.success === "function" ? context.terminal.success.bind(context.terminal) : line;
  const warn = typeof context?.terminal?.warn === "function" ? context.terminal.warn.bind(context.terminal) : line;
  let lastProgressPrinted = -1;

  return (event) => {
    if (!event || typeof event !== "object") return;
    const phase = String(event.phase || "");

    if (phase === "matrix-start") {
      const endpointCount = Number(event.endpointCount || 0);
      const modelCount = Number(event.modelCount || 0);

      info(`Auto-discovery started: ${endpointCount} endpoint(s) x ${modelCount} model(s).`);
      return;
    }
    if (phase === "model-check") {
      const completed = Number(event.completedChecks || 0);
      const total = Number(event.totalChecks || 0);
      if (completed <= 0 || total <= 0) return;
      if (completed === lastProgressPrinted) return;
      const status = describeModelCheckStatus(event);
      lastProgressPrinted = completed;
      const detailSuffix = status.detail ? ` - ${status.detail}` : "";
      line(
        `[discover] Progress ${completed}/${total} - ${event.model} on ${event.format} @ ${event.endpoint}: ${status.fullLabel}${detailSuffix}`
      );
      return;
    }
    if (phase === "rate-limit-wait") {
      const retryAttempt = Number(event.retryAttempt || 0);
      const maxRetries = Number(event.maxRetries || 0);
      const waitLabel = formatDurationMs(event.waitMs || 0);
      const reason = String(event.reason || "");
      const retrySuffix = maxRetries > 0
        ? ` retry ${Math.max(0, retryAttempt)}/${Math.max(0, maxRetries)}`
        : "";
      line(
        `[discover] Waiting ${waitLabel} before next probe (${reason || "throttle"}) for ${event.model || "model"} on ${event.format || "format"} @ ${event.endpoint || "endpoint"}${retrySuffix}`
      );
      return;
    }
    if (phase === "endpoint-done") {
      const formats = Array.isArray(event.workingFormats) && event.workingFormats.length > 0
        ? event.workingFormats.join(", ")
        : "(none)";
      if (formats === "(none)") {
        warn(`[discover] Endpoint done: ${event.endpoint} working formats=${formats}`);
      } else {
        success(`[discover] Endpoint done: ${event.endpoint} working formats=${formats}`);
      }
      return;
    }
    if (phase === "matrix-done") {
      const openaiBase = event.baseUrlByFormat?.openai || "(none)";
      const claudeBase = event.baseUrlByFormat?.claude || "(none)";
      const formats = Array.isArray(event.workingFormats) && event.workingFormats.length > 0
        ? event.workingFormats.join(", ")
        : "(none)";
      const finalMessage = `Auto-discovery completed: working formats=${formats}, models=${event.supportedModelCount || 0}, openaiBase=${openaiBase}, claudeBase=${claudeBase}`;
      if (formats === "(none)") {
        warn(finalMessage);
      } else {
        success(finalMessage);
      }
      lastProgressPrinted = -1;
    }
  };
}

async function promptProviderFormat(context, {
  message = "Primary provider format",
  initialFormat = ""
} = {}) {
  const preferred = initialFormat === "claude" ? "claude" : (initialFormat === "openai" ? "openai" : "");
  const options = preferred === "claude"
    ? [
        { value: "claude", label: "Anthropic-compatible" },
        { value: "openai", label: "OpenAI-compatible" }
      ]
    : [
        { value: "openai", label: "OpenAI-compatible" },
        { value: "claude", label: "Anthropic-compatible" }
      ];

  return context.prompts.select({ message, options });
}

async function runProbeManualFallback(context, {
  probe,
  selectedFormat,
  effectiveOpenAIBaseUrl,
  effectiveClaudeBaseUrl,
  effectiveModels
}) {
  if (!canPrompt()) {
    return {
      selectedFormat,
      effectiveOpenAIBaseUrl,
      effectiveClaudeBaseUrl,
      effectiveModels
    };
  }

  const info = typeof context?.terminal?.info === "function" ? context.terminal.info.bind(context.terminal) : null;
  const warn = typeof context?.terminal?.warn === "function" ? context.terminal.warn.bind(context.terminal) : null;

  const scope = probe?.failureScope === "full" ? "full" : "partial";
  warn?.(
    scope === "full"
      ? "Auto-discovery failed to detect a usable endpoint/model setup. Switching to manual fallback for unresolved items."
      : "Auto-discovery completed partially. Switching to manual fallback for unresolved items."
  );

  const warnings = Array.isArray(probe?.warnings) ? probe.warnings.filter(Boolean) : [];
  for (const message of warnings.slice(0, 3)) {
    warn?.(`  - ${message}`);
  }

  const unresolvedModels = dedupeList(Array.isArray(probe?.unresolvedModels) ? probe.unresolvedModels : []);
  const detectedModels = dedupeList(Array.isArray(probe?.models) ? probe.models : []);
  let mergedModels = dedupeList(effectiveModels?.length ? effectiveModels : detectedModels);

  if (unresolvedModels.length > 0) {
    info?.(`Manual fallback needs unresolved model review (${unresolvedModels.length} item(s)).`);
    const unresolvedInput = await context.prompts.text({
      message: "Undetected models to add manually (comma / newline separated; leave blank to skip)",
      initialValue: unresolvedModels.join("\n"),
      paste: true,
      multiline: true
    });
    const manualModels = parseProviderModelListInput(unresolvedInput);
    maybeReportInputCleanup(context, "model", unresolvedInput, manualModels);
    mergedModels = dedupeList([...detectedModels, ...manualModels]);
  }

  let openaiBase = String(effectiveOpenAIBaseUrl || "").trim();
  if (!openaiBase) {
    const openaiInput = await context.prompts.text({
      message: "OpenAI-compatible endpoint for unresolved items (optional)",
      initialValue: "",
      paste: true
    });
    openaiBase = parseEndpointListInput(openaiInput)[0] || "";
  }

  let claudeBase = String(effectiveClaudeBaseUrl || "").trim();
  if (!claudeBase) {
    const claudeInput = await context.prompts.text({
      message: "Anthropic-compatible endpoint for unresolved items (optional)",
      initialValue: "",
      paste: true
    });
    claudeBase = parseEndpointListInput(claudeInput)[0] || "";
  }

  let resolvedFormat = selectedFormat || probe?.preferredFormat || "";
  if (!resolvedFormat) {
    resolvedFormat = await promptProviderFormat(context, {
      message: "Choose primary provider format for manual fallback",
      initialFormat: resolvedFormat
    });
  }

  return {
    selectedFormat: resolvedFormat,
    effectiveOpenAIBaseUrl: openaiBase,
    effectiveClaudeBaseUrl: claudeBase,
    effectiveModels: mergedModels
  };
}

function slugifyId(value, fallback = "provider") {
  const slug = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return fallback;
  return /^[A-Z]/.test(slug)
    ? slug.charAt(0).toLowerCase() + slug.slice(1)
    : slug;
}

function sanitizeRateLimitBucketName(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function slugifyRateLimitBucketId(value, fallback = "bucket") {
  const slug = String(value || fallback)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function resolveUniqueRateLimitBucketId(baseId, reservedIds) {
  const normalizedBase = String(baseId || "").trim() || "bucket";
  if (!(reservedIds instanceof Set)) return normalizedBase;
  if (!reservedIds.has(normalizedBase)) return normalizedBase;
  let suffix = 2;
  let candidate = `${normalizedBase}-${suffix}`;
  while (reservedIds.has(candidate)) {
    suffix += 1;
    candidate = `${normalizedBase}-${suffix}`;
  }
  return candidate;
}

function formatAliasTargetsForSummary(targets) {
  return (targets || []).map((target) => {
    const weight = Number.isFinite(target?.weight) ? `@${Number(target.weight)}` : "";
    return `${target.ref}${weight}`;
  }).join(", ") || "(none)";
}

function formatRateLimitWindowForSummary(window) {
  const unit = String(window?.unit || "").trim();
  const size = Number(window?.size || 0);
  if (!unit || !Number.isFinite(size) || size <= 0) return "(invalid)";
  return `${size}/${unit}`;
}

function formatRateLimitWindowForHuman(window) {
  const unit = String(window?.unit || "").trim();
  const size = Number(window?.size || 0);
  if (!unit || !Number.isFinite(size) || size <= 0) return "(invalid)";
  return `${size} ${size === 1 ? unit : `${unit}s`}`;
}

function summarizeRateLimitBucketCap(bucket) {
  const requests = Number.parseInt(String(bucket?.requests ?? ""), 10);
  const requestText = Number.isFinite(requests) && requests > 0 ? `${requests} req` : "(unset)";
  return `${requestText} / ${formatRateLimitWindowForHuman(bucket?.window)}`;
}

function formatRateLimitBucketLabel(bucket, { includeId = false } = {}) {
  const id = String(bucket?.id || "").trim();
  const name = sanitizeRateLimitBucketName(bucket?.name);
  const title = name || id || "(unnamed bucket)";
  if (!includeId || !id || title === id) return title;
  return `${title} (${id})`;
}

function formatRateLimitBucketScopeLabel(bucket) {
  const models = dedupeList(bucket?.models || []);
  if (models.includes("all")) return "all models";
  return models.length > 0 ? models.join(", ") : "(none)";
}

export function summarizeConfig(config, configPath, { includeSecrets = false } = {}) {
  const target = includeSecrets ? config : sanitizeConfigForDisplay(config);
  const lines = [];
  lines.push(`Config: ${configPath}`);
  lines.push(`Version: ${target.version || 1}`);
  lines.push(`Default model: ${target.defaultModel || "(not set)"}`);
  lines.push(`Master key: ${target.masterKey || "(not set)"}`);

  if (!target.providers || target.providers.length === 0) {
    lines.push("Providers: (none)");
  } else {
    lines.push("Providers:");
    for (const provider of target.providers) {
      lines.push(`- ${provider.id} (${provider.name})`);
      lines.push(`  baseUrl=${provider.baseUrl}`);
      if (provider.baseUrlByFormat?.openai) {
        lines.push(`  openaiBaseUrl=${provider.baseUrlByFormat.openai}`);
      }
      if (provider.baseUrlByFormat?.claude) {
        lines.push(`  claudeBaseUrl=${provider.baseUrlByFormat.claude}`);
      }
      lines.push(`  formats=${(provider.formats || []).join(", ") || provider.format || "unknown"}`);
      lines.push(`  apiKey=${provider.apiKey || "(from env/hidden)"}`);
      lines.push(`  models=${(provider.models || []).map((model) => {
        const fallbacks = (model.fallbackModels || []).join("|");
        return fallbacks ? `${model.id}{fallback:${fallbacks}}` : model.id;
      }).join(", ") || "(none)"}`);

      const rateLimits = provider.rateLimits || [];
      if (rateLimits.length === 0) {
        lines.push("  rateLimits=(none)");
      } else {
        lines.push("  rateLimits:");
        for (const bucket of rateLimits) {
          lines.push(
            `    - ${formatRateLimitBucketLabel(bucket, { includeId: true })}: models=${formatRateLimitBucketScopeLabel(bucket)} cap=${summarizeRateLimitBucketCap(bucket)} window=${formatRateLimitWindowForSummary(bucket.window)}`
          );
        }
      }
    }
  }

  const aliasEntries = Object.entries(target.modelAliases || {});
  if (aliasEntries.length === 0) {
    lines.push("Model aliases: (none)");
  } else {
    lines.push("Model aliases:");
    for (const [aliasId, alias] of aliasEntries) {
      lines.push(`- ${aliasId} strategy=${alias.strategy || "ordered"}`);
      lines.push(`  targets=${formatAliasTargetsForSummary(alias.targets)}`);
      lines.push(`  fallbackTargets=${formatAliasTargetsForSummary(alias.fallbackTargets)}`);
    }
  }

  return lines.join("\n");
}

function runCommand(command, args, { cwd, input, envOverrides } = {}) {
  const safeEnvOverrides = envOverrides && typeof envOverrides === "object"
    ? envOverrides
    : {};
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      ...safeEnvOverrides,
      FORCE_COLOR: "0"
    }
  });

  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error
  };
}

function runCommandAsync(command, args, { cwd, input, envOverrides } = {}) {
  const safeEnvOverrides = envOverrides && typeof envOverrides === "object"
    ? envOverrides
    : {};

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...safeEnvOverrides,
        FORCE_COLOR: "0"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let spawnError = null;

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        status: Number.isInteger(code) ? code : 1,
        stdout,
        stderr,
        error: spawnError
      });
    });

    if (input !== undefined && input !== null) {
      child.stdin.write(String(input));
    }
    child.stdin.end();
  });
}

function runWrangler(args, { cwd, input, envOverrides } = {}) {
  const direct = runCommand("wrangler", args, { cwd, input, envOverrides });
  if (!direct.error) return direct;

  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  return runCommand(npxCmd, ["wrangler", ...args], { cwd, input, envOverrides });
}

async function runWranglerAsync(args, { cwd, input, envOverrides } = {}) {
  const direct = await runCommandAsync("wrangler", args, { cwd, input, envOverrides });
  if (!direct.error) return direct;

  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  return runCommandAsync(npxCmd, ["wrangler", ...args], { cwd, input, envOverrides });
}

export function resolveCloudflareApiTokenFromEnv(env = process.env) {
  const primary = String(env?.[CLOUDFLARE_API_TOKEN_ENV_NAME] || "").trim();
  if (primary) {
    return {
      token: primary,
      source: CLOUDFLARE_API_TOKEN_ENV_NAME
    };
  }

  const fallback = String(env?.[CLOUDFLARE_API_TOKEN_ALT_ENV_NAME] || "").trim();
  if (fallback) {
    return {
      token: fallback,
      source: CLOUDFLARE_API_TOKEN_ALT_ENV_NAME
    };
  }

  return {
    token: "",
    source: "none"
  };
}

export function buildCloudflareApiTokenSetupGuide() {
  return [
    `Cloudflare deploy requires ${CLOUDFLARE_API_TOKEN_ENV_NAME}.`,
    `Create a User Profile API token in dashboard: ${CLOUDFLARE_API_TOKEN_DASHBOARD_URL}`,
    "Do not use Account API Tokens for this deploy flow.",
    `Token docs: ${CLOUDFLARE_API_TOKEN_GUIDE_URL}`,
    `Recommended preset: ${CLOUDFLARE_API_TOKEN_PRESET_NAME}.`,
    `Then set ${CLOUDFLARE_API_TOKEN_ENV_NAME} in your shell/CI environment.`
  ].join("\n");
}

export function validateCloudflareApiTokenInput(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return `${CLOUDFLARE_API_TOKEN_ENV_NAME} is required for deploy.`;
  return undefined;
}

function buildCloudflareApiTokenTroubleshooting(preflightMessage = "") {
  return [
    preflightMessage,
    "Required token capabilities for wrangler deploy:",
    "- User details: Read",
    "- User memberships: Read",
    `- Account preset/template: ${CLOUDFLARE_API_TOKEN_PRESET_NAME}`,
    `Verify token manually: curl \"${CLOUDFLARE_VERIFY_TOKEN_URL}\" -H \"Authorization: Bearer $${CLOUDFLARE_API_TOKEN_ENV_NAME}\"`,
    buildCloudflareApiTokenSetupGuide()
  ].filter(Boolean).join("\n");
}

function normalizeCloudflareMembershipAccount(entry) {
  if (!entry || typeof entry !== "object") return null;
  const accountObj = entry.account && typeof entry.account === "object" ? entry.account : {};
  const accountId = String(
    accountObj.id
    || entry.account_id
    || entry.accountId
    || entry.id
    || ""
  ).trim();
  if (!accountId) return null;

  const accountName = String(
    accountObj.name
    || entry.account_name
    || entry.accountName
    || entry.name
    || `Account ${accountId.slice(0, 8)}`
  ).trim();

  return {
    accountId,
    accountName: accountName || `Account ${accountId.slice(0, 8)}`
  };
}

export function extractCloudflareMembershipAccounts(payload) {
  const list = Array.isArray(payload?.result) ? payload.result : [];
  const map = new Map();
  for (const entry of list) {
    const normalized = normalizeCloudflareMembershipAccount(entry);
    if (!normalized) continue;
    if (!map.has(normalized.accountId)) {
      map.set(normalized.accountId, normalized);
    }
  }
  return Array.from(map.values());
}

function cloudflareErrorFromPayload(payload, fallback) {
  const base = String(fallback || "Unknown Cloudflare API error");
  if (!payload || typeof payload !== "object") return base;

  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const first = errors.find((entry) => entry && typeof entry === "object");
  if (!first) return base;

  const code = Number.isFinite(first.code) ? `code ${first.code}` : "";
  const message = String(first.message || first.error || "").trim();
  if (code && message) return `${message} (${code})`;
  if (message) return message;
  if (code) return code;
  return base;
}

export function evaluateCloudflareTokenVerifyResult(payload) {
  const status = String(payload?.result?.status || "").toLowerCase();
  const active = payload?.success === true && status === "active";
  if (active) {
    return { ok: true, message: "Token is active." };
  }
  return {
    ok: false,
    message: cloudflareErrorFromPayload(
      payload,
      "Token verification failed. Ensure token is valid and active."
    )
  };
}

export function evaluateCloudflareMembershipsResult(payload) {
  if (payload?.success !== true || !Array.isArray(payload?.result)) {
    return {
      ok: false,
      message: cloudflareErrorFromPayload(
        payload,
        "Could not list Cloudflare memberships for this token."
      )
    };
  }

  if (payload.result.length === 0) {
    return {
      ok: false,
      message: "Token can authenticate but has no accessible memberships."
    };
  }

  const accounts = extractCloudflareMembershipAccounts(payload);
  return {
    ok: true,
    message: `Token has access to ${payload.result.length} membership(s).`,
    count: payload.result.length,
    accounts
  };
}

async function cloudflareApiGetJson(url, token) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      },
      signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(CLOUDFLARE_API_PREFLIGHT_TIMEOUT_MS)
        : undefined
    });
    const rawText = await response.text();
    const payload = parseJsonSafely(rawText) || {};
    return {
      ok: response.ok,
      status: response.status,
      payload
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function preflightCloudflareApiToken(token) {
  const verified = await cloudflareApiGetJson(CLOUDFLARE_VERIFY_TOKEN_URL, token);
  if (verified.status === 0) {
    return {
      ok: false,
      stage: "verify",
      message: `Cloudflare token preflight failed while verifying token: ${verified.error || "network error"}`
    };
  }

  const verifyEval = evaluateCloudflareTokenVerifyResult(verified.payload);
  if (!verified.ok || !verifyEval.ok) {
    return {
      ok: false,
      stage: "verify",
      message: `Cloudflare token verification failed: ${verifyEval.message}`
    };
  }

  const memberships = await cloudflareApiGetJson(CLOUDFLARE_MEMBERSHIPS_URL, token);
  if (memberships.status === 0) {
    return {
      ok: false,
      stage: "memberships",
      message: `Cloudflare token preflight failed while checking memberships: ${memberships.error || "network error"}`
    };
  }

  const membershipEval = evaluateCloudflareMembershipsResult(memberships.payload);
  if (!memberships.ok || !membershipEval.ok) {
    return {
      ok: false,
      stage: "memberships",
      message: `Cloudflare memberships check failed: ${membershipEval.message}`
    };
  }

  return {
    ok: true,
    stage: "ready",
    message: membershipEval.message,
    memberships: membershipEval.accounts || []
  };
}

function buildWranglerCloudflareEnv({
  apiToken,
  accountId
} = {}) {
  const env = {};
  const token = String(apiToken || "").trim();
  if (token) env[CLOUDFLARE_API_TOKEN_ENV_NAME] = token;
  const account = String(accountId || "").trim();
  if (account) env[CLOUDFLARE_ACCOUNT_ID_ENV_NAME] = account;
  return Object.keys(env).length > 0 ? env : undefined;
}

function formatCloudflareAccountOptions(accounts = []) {
  return (accounts || []).map((entry) => `\`${entry.accountName}\`: \`${entry.accountId}\``);
}

export function hasNoDeployTargets(outputText = "") {
  return /no deploy targets/i.test(String(outputText || ""));
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return toBoolean(value, false);
}

function parseTomlStringField(text, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*$`, "m");
  const match = String(text || "").match(pattern);
  return match?.[1] ? String(match[1]).trim() : "";
}

function topLevelTomlLineInfo(text = "") {
  const lines = String(text || "").split(/\r?\n/g);
  const info = [];
  let currentSection = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^\s*\[.*\]\s*$/.test(line)) {
      currentSection = trimmed;
    }
    info.push({
      index,
      line,
      trimmed,
      section: currentSection
    });
  }

  return info;
}

export function hasWranglerDeployTargetConfigured(tomlText = "") {
  const info = topLevelTomlLineInfo(tomlText);

  const hasTopLevelWorkersDev = info.some((entry) =>
    entry.section === "" && /^\s*workers_dev\s*=\s*true\s*$/i.test(entry.line)
  );
  if (hasTopLevelWorkersDev) return true;

  const hasTopLevelRoute = info.some((entry) =>
    entry.section === "" && /^\s*route\s*=\s*["'][^"']+["']\s*$/i.test(entry.line)
  );
  if (hasTopLevelRoute) return true;

  const hasTopLevelRoutes = info.some((entry) =>
    entry.section === "" && /^\s*routes\s*=\s*\[/i.test(entry.line)
  );
  if (hasTopLevelRoutes) return true;

  return false;
}

function stripNonTopLevelRouteDeclarations(text = "") {
  const lines = String(text || "").split(/\r?\n/g);
  const output = [];
  let currentSection = "";
  let skippingRoutesArray = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\s*\[.*\]\s*$/.test(line)) {
      currentSection = trimmed;
      skippingRoutesArray = false;
      output.push(line);
      continue;
    }

    if (currentSection && /^\s*route\s*=/.test(line)) {
      continue;
    }

    if (currentSection && /^\s*routes\s*=\s*\[/.test(line)) {
      skippingRoutesArray = true;
      if (line.includes("]")) {
        skippingRoutesArray = false;
      }
      continue;
    }

    if (skippingRoutesArray) {
      if (trimmed.includes("]")) {
        skippingRoutesArray = false;
      }
      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}

function insertTopLevelBlockBeforeFirstSection(text = "", block = "") {
  const source = String(text || "");
  const blockText = String(block || "").trim();
  if (!blockText) return source;

  const lines = source.split(/\r?\n/g);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[.*\]\s*$/.test(line));
  if (firstSectionIndex < 0) {
    const prefix = source.trimEnd();
    return `${prefix}${prefix ? "\n" : ""}${blockText}\n`;
  }

  const before = lines.slice(0, firstSectionIndex).join("\n").trimEnd();
  const after = lines.slice(firstSectionIndex).join("\n").trimStart();
  return `${before}${before ? "\n" : ""}${blockText}\n\n${after}\n`;
}

function upsertTomlBooleanField(text, key, value) {
  const normalized = String(text || "");
  const replacement = `${key} = ${value ? "true" : "false"}`;
  if (new RegExp(`^\\s*${key}\\s*=`, "m").test(normalized)) {
    return normalized.replace(new RegExp(`^\\s*${key}\\s*=.*$`, "m"), replacement);
  }
  return `${normalized.trimEnd()}\n${replacement}\n`;
}

function stripTopLevelRouteDeclarations(text = "") {
  const lines = String(text || "").split(/\r?\n/g);
  const output = [];
  let currentSection = "";
  let skippingRoutesArray = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\s*\[.*\]\s*$/.test(line)) {
      currentSection = trimmed;
      skippingRoutesArray = false;
      output.push(line);
      continue;
    }

    if (!currentSection && /^\s*route\s*=/.test(line)) {
      continue;
    }

    if (!currentSection && /^\s*routes\s*=\s*\[/.test(line)) {
      skippingRoutesArray = true;
      if (line.includes("]")) {
        skippingRoutesArray = false;
      }
      continue;
    }

    if (skippingRoutesArray) {
      if (trimmed.includes("]")) {
        skippingRoutesArray = false;
      }
      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}

export function normalizeWranglerRoutePattern(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let candidate = raw;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      candidate = `${parsed.hostname}${parsed.pathname || "/"}`;
    } catch {
      return "";
    }
  }

  if (candidate.startsWith("/")) return "";
  if (!candidate.includes("*")) {
    if (candidate.endsWith("/")) candidate = `${candidate}*`;
    else if (!candidate.includes("/")) candidate = `${candidate}/*`;
  }

  return candidate;
}

export function buildDefaultWranglerTomlForDeploy({
  name = "llm-router-route",
  main = "src/index.js",
  compatibilityDate = "2024-01-01",
  useWorkersDev = false,
  routePattern = "",
  zoneName = ""
} = {}) {
  const lines = [
    `name = "${String(name || "llm-router-route")}"`,
    `main = "${String(main || "src/index.js")}"`,
    `compatibility_date = "${String(compatibilityDate || "2024-01-01")}"`,
    `workers_dev = ${useWorkersDev ? "true" : "false"}`
  ];

  const normalizedPattern = normalizeWranglerRoutePattern(routePattern);
  const normalizedZone = String(zoneName || "").trim();
  if (!useWorkersDev && normalizedPattern && normalizedZone) {
    lines.push("routes = [");
    lines.push(`  { pattern = "${normalizedPattern}", zone_name = "${normalizedZone}" }`);
    lines.push("]");
  }

  lines.push("preview_urls = false");
  lines.push("");
  lines.push("[vars]");
  lines.push('ENVIRONMENT = "production"');
  lines.push("");
  return `${lines.join("\n")}`;
}

export function applyWranglerDeployTargetToToml(existingToml, {
  useWorkersDev = false,
  routePattern = "",
  zoneName = "",
  replaceExistingTarget = false
} = {}) {
  let next = String(existingToml || "");
  next = stripNonTopLevelRouteDeclarations(next);
  if (replaceExistingTarget) {
    next = stripTopLevelRouteDeclarations(next);
  }
  next = upsertTomlBooleanField(next, "workers_dev", useWorkersDev);

  if (!useWorkersDev) {
    const normalizedPattern = normalizeWranglerRoutePattern(routePattern);
    const normalizedZone = String(zoneName || "").trim();
    if (normalizedPattern && normalizedZone && (replaceExistingTarget || !hasWranglerDeployTargetConfigured(next))) {
      const routeBlock = `routes = [\n  { pattern = "${normalizedPattern}", zone_name = "${normalizedZone}" }\n]`;
      next = insertTopLevelBlockBeforeFirstSection(next, routeBlock);
    }
  }

  if (!/^\s*preview_urls\s*=/mi.test(next)) {
    next = `${next.trimEnd()}\npreview_urls = false\n`;
  }

  return `${next.trimEnd()}\n`;
}

async function createTemporaryWranglerConfigFile(projectDir, tomlText) {
  await fsPromises.mkdir(projectDir, { recursive: true });
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const wranglerConfigPath = path.join(projectDir, `.llm-router.deploy.${suffix}.wrangler.toml`);
  await fsPromises.writeFile(wranglerConfigPath, String(tomlText || ""), "utf8");

  let cleaned = false;
  return {
    wranglerConfigPath,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        await fsPromises.unlink(wranglerConfigPath);
      } catch (error) {
        if (!error || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  };
}

async function prepareWranglerDeployConfig(context, {
  projectDir,
  args = {},
  cloudflareApiToken = "",
  cloudflareAccountId = "",
  wait = async (_label, fn) => fn()
} = {}) {
  const wranglerPath = path.join(projectDir, "wrangler.toml");
  const line = typeof context?.terminal?.line === "function"
    ? context.terminal.line.bind(context.terminal)
    : console.log;

  let exists = false;
  let currentToml = "";
  try {
    currentToml = await fsPromises.readFile(wranglerPath, "utf8");
    exists = true;
  } catch {
    exists = false;
    currentToml = "";
  }

  const workersDevArg = parseOptionalBoolean(readArg(args, ["workers-dev", "workersDev"], undefined));
  const zoneNameArg = String(readArg(args, ["zone-name", "zoneName"], "") || "").trim();
  const routePatternArgRaw = String(readArg(args, ["route-pattern", "routePattern"], "") || "").trim();
  const domainArgRaw = String(readArg(args, ["domain"], "") || "").trim();
  const routePatternArg = normalizeWranglerRoutePattern(routePatternArgRaw || domainArgRaw);
  const hasExistingTarget = exists && hasWranglerDeployTargetConfigured(currentToml);
  const hasExplicitTargetArgs = workersDevArg !== undefined || Boolean(routePatternArg) || Boolean(zoneNameArg);

  if (workersDevArg === undefined && ((routePatternArg && !zoneNameArg) || (!routePatternArg && zoneNameArg))) {
    return {
      ok: false,
      errorMessage: "Custom route deploy target requires both --route-pattern (or --domain) and --zone-name."
    };
  }

  if (hasExistingTarget && !hasExplicitTargetArgs) {
    const tempConfig = await createTemporaryWranglerConfigFile(projectDir, currentToml);
    return {
      ok: true,
      wranglerPath,
      wranglerConfigPath: tempConfig.wranglerConfigPath,
      cleanup: tempConfig.cleanup,
      changed: false,
      message: ""
    };
  }

  let useWorkersDev = workersDevArg === true;
  let routePattern = routePatternArg;
  let zoneName = zoneNameArg;

  if (workersDevArg === false && (!routePattern || !zoneName)) {
    return {
      ok: false,
      errorMessage: "workers-dev=false requires both --route-pattern and --zone-name."
    };
  }

  if (workersDevArg !== true && (!routePattern || !zoneName)) {
    if (!canPrompt()) {
      return {
        ok: false,
        errorMessage: [
          "Wrangler deploy target is not configured.",
          "Provide one of:",
          "- --workers-dev=true (quick public workers.dev URL), or",
          "- --route-pattern=router.example.com/* --zone-name=example.com (custom domain route)."
        ].join("\n")
      };
    }

    const targetMode = await context.prompts.select({
      message: "No deploy target found. Choose deploy target mode",
      options: [
        { value: "workers-dev", label: "Use workers.dev URL (quick start)" },
        { value: "custom-route", label: "Use custom domain route (production)" }
      ]
    });

    if (targetMode === "workers-dev") {
      useWorkersDev = true;
      routePattern = "";
      zoneName = "";
    } else {
      const promptedHost = await context.prompts.text({
        message: "Custom domain host (example: llm.example.com)",
        required: true,
        validate: (value) => {
          const normalized = extractHostnameFromRoutePattern(value);
          if (!normalized || !normalized.includes(".")) return "Enter a valid domain hostname.";
          return undefined;
        }
      });

      const normalizedHost = extractHostnameFromRoutePattern(promptedHost);
      const suggestedRoutePattern = normalizeWranglerRoutePattern(`${normalizedHost}/*`);
      const zones = cloudflareApiToken
        ? await wait("Loading Cloudflare zones...", () => cloudflareListZones(cloudflareApiToken, cloudflareAccountId), { doneMessage: "Cloudflare zones loaded." })
        : [];      const suggestedZoneFromApi = suggestZoneNameForHostname(normalizedHost, zones);
      const suggestedZone = suggestedZoneFromApi || inferZoneNameFromHostname(normalizedHost);

      const promptedRoute = await context.prompts.text({
        message: "Route pattern (example: llm.example.com/*)",
        required: true,
        initialValue: suggestedRoutePattern,
        validate: (value) => {
          const normalized = normalizeWranglerRoutePattern(value);
          if (!normalized) return "Enter a valid route pattern.";
          return undefined;
        }
      });
      const promptedZone = await context.prompts.text({
        message: "Zone name (example: example.com)",
        required: true,
        initialValue: suggestedZone,
        validate: (value) => String(value || "").trim() ? undefined : "Zone name is required."
      });
      useWorkersDev = false;
      routePattern = normalizeWranglerRoutePattern(promptedRoute);
      zoneName = String(promptedZone || "").trim();

      const routeHost = extractHostnameFromRoutePattern(routePattern);
      if (routeHost && zoneName && !isHostnameUnderZone(routeHost, zoneName)) {
        const proceedMismatch = await context.prompts.confirm({
          message: `Route host ${routeHost} does not appear under zone ${zoneName}. Continue anyway?`,
          initialValue: false
        });
        if (!proceedMismatch) {
          return {
            ok: false,
            errorMessage: "Cancelled due to route host and zone mismatch."
          };
        }
      }
    }
  }

  const nextToml = exists
    ? applyWranglerDeployTargetToToml(currentToml, {
      useWorkersDev,
      routePattern,
      zoneName,
      replaceExistingTarget: hasExplicitTargetArgs
    })
    : buildDefaultWranglerTomlForDeploy({
      name: parseTomlStringField(currentToml, "name") || "llm-router-route",
      main: parseTomlStringField(currentToml, "main") || "src/index.js",
      compatibilityDate: parseTomlStringField(currentToml, "compatibility_date") || "2024-01-01",
      useWorkersDev,
      routePattern,
      zoneName
    });

  const tempConfig = await createTemporaryWranglerConfigFile(projectDir, nextToml);

  if (useWorkersDev) {
    line("Prepared temporary deploy target: workers_dev=true");
  } else {
    line(`Prepared temporary deploy target: route=${routePattern} zone=${zoneName}`);
    line(buildCloudflareDnsManualGuide({
      hostname: extractHostnameFromRoutePattern(routePattern),
      zoneName,
      routePattern
    }));
  }

  return {
    ok: true,
    wranglerPath,
    wranglerConfigPath: tempConfig.wranglerConfigPath,
    cleanup: tempConfig.cleanup,
    changed: true,
    routePattern,
    zoneName,
    useWorkersDev,
    message: useWorkersDev
      ? "Using workers.dev deploy target (temporary config)."
      : `Using custom route deploy target (${routePattern}) with temporary config.`
  };
}


function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

export function extractHostnameFromRoutePattern(value) {
  const route = String(value || "").trim();
  if (!route) return "";

  if (/^https?:\/\//i.test(route)) {
    try {
      return normalizeHostname(new URL(route).hostname);
    } catch {
      return "";
    }
  }

  const left = route.split("/")[0] || "";
  return normalizeHostname(left.replace(/\*+$/g, ""));
}

export function inferZoneNameFromHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host || !host.includes(".")) return "";
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  return labels.slice(-2).join(".");
}

export function isHostnameUnderZone(hostname, zoneName) {
  const host = normalizeHostname(hostname);
  const zone = normalizeHostname(zoneName);
  if (!host || !zone) return false;
  return host === zone || host.endsWith(`.${zone}`);
}

export function suggestZoneNameForHostname(hostname, zones = []) {
  const host = normalizeHostname(hostname);
  if (!host) return "";

  let best = "";
  for (const zone of zones || []) {
    const candidate = normalizeHostname(zone?.name || zone);
    if (!candidate) continue;
    if (host === candidate || host.endsWith(`.${candidate}`)) {
      if (!best || candidate.length > best.length) {
        best = candidate;
      }
    }
  }
  return best;
}

export function buildCloudflareDnsManualGuide({
  hostname = "",
  zoneName = "",
  routePattern = ""
} = {}) {
  const host = normalizeHostname(hostname || extractHostnameFromRoutePattern(routePattern));
  const zone = normalizeHostname(zoneName || inferZoneNameFromHostname(host));
  const subdomain = host && zone && host.endsWith(`.${zone}`)
    ? host.slice(0, -(`.${zone}`).length)
    : "";
  const label = subdomain || "<subdomain>";

  return [
    "Custom domain checklist:",
    `- Route target: ${routePattern || `${host || "<host>"}/*`} (zone: ${zone || "<zone>"})`,
    `- DNS: create/update CNAME \`${label}\` -> \`@\` in zone \`${zone || "<zone>"}\``,
    "- Proxy status must be ON (orange cloud / proxied)",
    host ? `- Verify DNS: dig +short ${host} @1.1.1.1` : "- Verify DNS: dig +short <host> @1.1.1.1",
    host ? `- Verify HTTP: curl -I https://${host}/anthropic` : "- Verify HTTP: curl -I https://<host>/anthropic",
    "- Claude base URL must NOT include :8787 for Cloudflare Worker deployments"
  ].join("\n");
}

async function cloudflareListZones(token, accountId = "") {
  const params = new URLSearchParams({ per_page: "50" });
  if (accountId) params.set("account.id", accountId);
  const result = await cloudflareApiGetJson(`${CLOUDFLARE_ZONES_URL}?${params.toString()}`, token);
  if (!result.ok || !Array.isArray(result.payload?.result)) return [];
  return result.payload.result
    .map((zone) => ({ id: String(zone?.id || "").trim(), name: normalizeHostname(zone?.name || "") }))
    .filter((zone) => zone.id && zone.name);
}
function parseJsonSafely(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectCloudflareTierSignals(value, out = [], depth = 0, parentKey = "") {
  if (depth > 6 || value === null || value === undefined) return out;

  if (typeof value === "string") {
    if (/(plan|tier|subscription|type|account|membership|name)/i.test(parentKey)) {
      const normalized = value.trim().toLowerCase();
      if (normalized) out.push(normalized);
    }
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectCloudflareTierSignals(item, out, depth + 1, parentKey);
    }
    return out;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectCloudflareTierSignals(child, out, depth + 1, key);
    }
  }

  return out;
}

export function inferCloudflareTierFromWhoami(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      tier: "unknown",
      reason: "invalid-payload",
      signals: []
    };
  }

  if (payload.loggedIn === false) {
    return {
      tier: "unknown",
      reason: "not-logged-in",
      signals: []
    };
  }

  const signals = [...new Set(collectCloudflareTierSignals(payload))]
    .slice(0, 12);
  const freeSignals = signals.filter((entry) => CLOUDFLARE_FREE_TIER_PATTERN.test(entry));
  const paidSignals = signals.filter((entry) => CLOUDFLARE_PAID_TIER_PATTERN.test(entry));

  if (freeSignals.length > 0 && paidSignals.length > 0) {
    return {
      tier: "unknown",
      reason: "ambiguous-tier",
      signals
    };
  }

  if (freeSignals.length > 0) {
    return {
      tier: "free",
      reason: "detected-free",
      signals
    };
  }

  if (paidSignals.length > 0) {
    return {
      tier: "paid",
      reason: "detected-paid",
      signals
    };
  }

  return {
    tier: "unknown",
    reason: "tier-not-found",
    signals
  };
}

function detectCloudflareTierViaWrangler(projectDir, cfEnv = "", apiToken = "", accountId = "") {
  const args = ["whoami", "--json"];
  if (cfEnv) args.push("--env", cfEnv);

  const result = runWranglerWithNpx(args, {
    cwd: projectDir,
    envOverrides: buildWranglerCloudflareEnv({
      apiToken,
      accountId
    })
  });
  const parsed = parseJsonSafely(result.stdout) || parseJsonSafely(result.stderr);
  if (!parsed) {
    const errorText = `${result.stderr || ""}\n${result.stdout || ""}`.toLowerCase();
    const reason = errorText.includes("unknown argument: json")
      ? "whoami-json-not-supported"
      : (result.ok ? "whoami-unparseable" : "whoami-failed");
    return {
      tier: "unknown",
      reason,
      signals: [],
      source: "npx wrangler whoami --json"
    };
  }

  return {
    ...inferCloudflareTierFromWhoami(parsed),
    source: "npx wrangler whoami --json"
  };
}

export function shouldConfirmLargeWorkerConfigDeploy({ payloadBytes, tier }) {
  if (!Number.isFinite(payloadBytes)) return false;
  if (payloadBytes <= CLOUDFLARE_FREE_SECRET_SIZE_LIMIT_BYTES) return false;
  return String(tier || "unknown") !== "paid";
}

function formatCloudflareTierLabel(tierReport) {
  if (tierReport?.tier === "free") return "free";
  if (tierReport?.tier === "paid") return "paid";
  return "unknown";
}

function buildLargeWorkerConfigWarningLines({ payloadBytes, tierReport }) {
  const lines = [
    `LLM_ROUTER_CONFIG_JSON payload is ${payloadBytes} bytes, above Cloudflare Free tier limit (${CLOUDFLARE_FREE_SECRET_SIZE_LIMIT_BYTES} bytes).`
  ];

  if (tierReport?.tier === "free") {
    lines.push("Detected Cloudflare tier: free.");
  } else if (tierReport?.tier === "paid") {
    lines.push("Detected Cloudflare tier: paid (no free-tier block expected).");
  } else {
    lines.push("Could not reliably determine Cloudflare tier.");
    lines.push(`Tier check reason: ${tierReport?.reason || "unknown"}.`);
  }

  return lines;
}

function runNpmInstallLatest(packageName) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return runCommand(npmCmd, ["install", "-g", `${packageName}@latest`]);
}

async function stopRunningInstance() {
  const active = await getActiveRuntimeState();
  if (active?.managedByStartup) {
    const stopped = await stopStartup();
    await clearRuntimeState();
    return {
      ok: true,
      mode: "startup",
      detail: stopped
    };
  }

  if (active) {
    const stopped = await stopProcessByPid(active.pid);
    if (!stopped.ok) {
      return {
        ok: false,
        mode: "manual",
        reason: stopped.reason || `Failed stopping pid ${active.pid}.`
      };
    }
    await clearRuntimeState({ pid: active.pid });
    return {
      ok: true,
      mode: "manual",
      detail: {
        pid: active.pid,
        signal: stopped.signal || "SIGTERM"
      }
    };
  }

  const startup = await startupStatus();
  if (startup.running) {
    const stopped = await stopStartup();
    await clearRuntimeState();
    return {
      ok: true,
      mode: "startup",
      detail: stopped
    };
  }

  return {
    ok: true,
    mode: "none",
    detail: null
  };
}

async function reloadRunningInstance({
  terminalLine = () => {},
  terminalError = () => {},
  runDetachedForManual = false
} = {}) {
  const active = await getActiveRuntimeState();
  if (active?.managedByStartup) {
    const restarted = await restartStartup();
    await clearRuntimeState();
    return {
      ok: true,
      mode: "startup",
      detail: restarted
    };
  }

  if (active) {
    const stopped = await stopProcessByPid(active.pid);
    if (!stopped.ok) {
      return {
        ok: false,
        mode: "manual",
        reason: stopped.reason || `Failed stopping pid ${active.pid}.`
      };
    }
    await clearRuntimeState({ pid: active.pid });
    const startArgs = buildStartArgsFromState(active);

    if (runDetachedForManual) {
      const pid = spawnDetachedStart({
        cliPath: active.cliPath || process.argv[1],
        ...startArgs
      });
      return {
        ok: true,
        mode: "manual-detached",
        detail: {
          pid,
          ...startArgs
        }
      };
    }

    const restarted = await runStartCommand({
      ...startArgs,
      cliPathForWatch: process.argv[1],
      onLine: terminalLine,
      onError: terminalError
    });

    return {
      ok: restarted.ok,
      mode: "manual-inline",
      detail: restarted
    };
  }

  const startup = await startupStatus();
  if (startup.running) {
    const restarted = await restartStartup();
    await clearRuntimeState();
    return {
      ok: true,
      mode: "startup",
      detail: restarted
    };
  }

  return {
    ok: false,
    mode: "none",
    reason: "No running llm-router instance detected."
  };
}

function removeModelFromConfig(config, providerId, modelId) {
  const next = structuredClone(config);
  const provider = next.providers.find((p) => p.id === providerId);
  if (!provider) return { config: next, changed: false, reason: `Provider '${providerId}' not found.` };

  const before = provider.models.length;
  provider.models = provider.models.filter((m) => m.id !== modelId && !(m.aliases || []).includes(modelId));
  const changed = provider.models.length !== before;

  if (!changed) {
    return { config: next, changed: false, reason: `Model '${modelId}' not found under '${providerId}'.` };
  }

  if (next.defaultModel && next.defaultModel.startsWith(`${providerId}/`)) {
    const exact = next.defaultModel.slice(providerId.length + 1);
    if (exact === modelId) {
      next.defaultModel = provider.models[0] ? `${providerId}/${provider.models[0].id}` : undefined;
    }
  }

  return { config: next, changed: true };
}

function resolveProviderAndModel(config, providerId, modelId) {
  const provider = (config.providers || []).find((item) => item.id === providerId);
  if (!provider) {
    return { provider: null, model: null, reason: `Provider '${providerId}' not found.` };
  }

  const model = (provider.models || []).find((item) => item.id === modelId || (item.aliases || []).includes(modelId));
  if (!model) {
    return { provider, model: null, reason: `Model '${modelId}' not found under '${providerId}'.` };
  }

  return { provider, model, reason: "" };
}

function listFallbackModelOptions(config, providerId, modelId) {
  const self = `${providerId}/${modelId}`;
  const options = [];

  for (const provider of (config.providers || [])) {
    for (const model of (provider.models || [])) {
      const qualified = `${provider.id}/${model.id}`;
      if (qualified === self) continue;
      options.push({
        value: qualified,
        label: qualified
      });
    }
  }

  return options;
}

function setModelFallbacksInConfig(config, providerId, modelId, fallbackModels) {
  const next = structuredClone(config);
  const resolved = resolveProviderAndModel(next, providerId, modelId);
  if (!resolved.provider || !resolved.model) {
    return { config: next, changed: false, reason: resolved.reason || "Provider/model not found." };
  }

  const canonicalModelId = resolved.model.id;
  const options = listFallbackModelOptions(next, providerId, canonicalModelId);
  const availableSet = new Set(options.map((option) => option.value));
  const nextFallbacks = dedupeList((fallbackModels || []).map((entry) => String(entry || "").trim()).filter(Boolean));
  const invalidEntries = nextFallbacks.filter((entry) => !availableSet.has(entry));
  if (invalidEntries.length > 0) {
    return {
      config: next,
      changed: false,
      reason: `Invalid fallback model(s): ${invalidEntries.join(", ")}.`,
      invalidEntries
    };
  }

  const currentFallbacks = dedupeList(resolved.model.fallbackModels || []);
  const changed = currentFallbacks.join("\n") !== nextFallbacks.join("\n");
  resolved.model.fallbackModels = nextFallbacks;

  return {
    config: next,
    changed,
    reason: "",
    modelId: canonicalModelId,
    fallbackModels: nextFallbacks
  };
}

function normalizeModelAliasStrategy(strategy) {
  const normalized = String(strategy || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "automatic" || normalized === "smart") return "auto";
  return MODEL_ALIAS_STRATEGIES.includes(normalized) ? normalized : "";
}

function serializeStable(value) {
  return JSON.stringify(value);
}

function formatConfigValidationError(errors) {
  return (errors || []).map((line) => String(line || "").trim()).filter(Boolean).join(" ");
}

export function upsertModelAliasInConfig(config, {
  aliasId,
  strategy,
  targets,
  fallbackTargets,
  clearFallbackTargets = false,
  metadata
}) {
  const next = structuredClone(config);
  const normalizedAliasId = String(aliasId || "").trim();
  if (!normalizedAliasId) {
    return { config: next, changed: false, reason: "alias-id is required." };
  }
  if (!MODEL_ALIAS_ID_PATTERN.test(normalizedAliasId)) {
    return {
      config: next,
      changed: false,
      reason: `Invalid alias-id '${normalizedAliasId}'. Use letters/numbers and . _ : - separators.`
    };
  }

  next.modelAliases = next.modelAliases && typeof next.modelAliases === "object" && !Array.isArray(next.modelAliases)
    ? next.modelAliases
    : {};

  const previousAlias = next.modelAliases[normalizedAliasId] || {};
  const nextStrategy = strategy === undefined
    ? normalizeModelAliasStrategy(previousAlias.strategy || "ordered") || "ordered"
    : normalizeModelAliasStrategy(strategy);
  if (!nextStrategy) {
    return {
      config: next,
      changed: false,
      reason: `Invalid model routing strategy '${strategy}'. Use one of: ${MODEL_ALIAS_STRATEGIES.join(", ")}.`
    };
  }

  const nextTargets = targets === undefined
    ? dedupeAliasTargets(previousAlias.targets || [])
    : parseAliasTargetListInput(targets);
  if (!Array.isArray(nextTargets) || nextTargets.length === 0) {
    return {
      config: next,
      changed: false,
      reason: "Alias targets are required. Use --targets='provider/model@weight,provider/model'."
    };
  }

  const nextFallbackTargets = clearFallbackTargets
    ? []
    : (fallbackTargets === undefined
      ? dedupeAliasTargets(previousAlias.fallbackTargets || [])
      : parseAliasTargetListInput(fallbackTargets));

  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
    return {
      config: next,
      changed: false,
      reason: "alias-metadata must be a JSON object when provided."
    };
  }

  const nextAlias = {
    strategy: nextStrategy,
    targets: nextTargets,
    fallbackTargets: nextFallbackTargets,
    ...(metadata !== undefined
      ? { metadata }
      : (previousAlias.metadata && typeof previousAlias.metadata === "object" && !Array.isArray(previousAlias.metadata)
        ? { metadata: previousAlias.metadata }
        : {}))
  };

  const previousSerialized = serializeStable(previousAlias);
  const nextSerialized = serializeStable(nextAlias);
  next.modelAliases[normalizedAliasId] = nextAlias;

  const validationErrors = validateRuntimeConfig(next, { requireProvider: false, requireMasterKey: false });
  if (validationErrors.length > 0) {
    return {
      config: config,
      changed: false,
      reason: formatConfigValidationError(validationErrors)
    };
  }

  return {
    config: next,
    changed: previousSerialized !== nextSerialized,
    reason: "",
    aliasId: normalizedAliasId
  };
}

export function removeModelAliasFromConfig(config, aliasId) {
  const next = structuredClone(config);
  const normalizedAliasId = String(aliasId || "").trim();
  if (!normalizedAliasId) {
    return { config: next, changed: false, reason: "alias-id is required." };
  }
  if (!next.modelAliases || typeof next.modelAliases !== "object" || Array.isArray(next.modelAliases)) {
    return { config: next, changed: false, reason: "No model aliases configured." };
  }
  if (!Object.prototype.hasOwnProperty.call(next.modelAliases, normalizedAliasId)) {
    return { config: next, changed: false, reason: `Alias '${normalizedAliasId}' not found.` };
  }

  delete next.modelAliases[normalizedAliasId];
  if (next.defaultModel === normalizedAliasId) {
    const fallbackProvider = (next.providers || [])[0];
    const fallbackModel = (fallbackProvider?.models || [])[0];
    next.defaultModel = fallbackProvider && fallbackModel
      ? `${fallbackProvider.id}/${fallbackModel.id}`
      : undefined;
  }

  return {
    config: next,
    changed: true,
    reason: "",
    aliasId: normalizedAliasId
  };
}

function normalizeRateLimitBucketForConfig(rawBucket, { reservedIds } = {}) {
  if (!rawBucket || typeof rawBucket !== "object" || Array.isArray(rawBucket)) {
    return { bucket: null, reason: "bucket entry must be an object." };
  }

  const explicitId = String(rawBucket.id || "").trim();
  const name = sanitizeRateLimitBucketName(rawBucket.name ?? rawBucket["bucket-name"]);
  if ((rawBucket.name !== undefined || rawBucket["bucket-name"] !== undefined) && !name) {
    return { bucket: null, reason: "bucket name cannot be empty." };
  }

  if (!explicitId && !name) {
    return { bucket: null, reason: "bucket id or bucket name is required." };
  }

  const baseId = explicitId || slugifyRateLimitBucketId(name, "bucket");
  const id = explicitId || resolveUniqueRateLimitBucketId(baseId, reservedIds);
  reservedIds?.add(id);

  const models = parseRateLimitModelSelectorsInput(rawBucket.models ?? rawBucket.model ?? rawBucket["model-selector"]);
  if (models.length === 0) {
    return { bucket: null, reason: `bucket '${id}' requires models (use 'all' or model ids).` };
  }

  const requests = Number.parseInt(String(rawBucket.requests ?? rawBucket.limit ?? ""), 10);
  if (!Number.isFinite(requests) || requests <= 0) {
    return { bucket: null, reason: `bucket '${id}' requests must be a positive integer.` };
  }

  const window = parseRateLimitWindowInput({
    unit: rawBucket.window?.unit ?? rawBucket.windowUnit ?? rawBucket["window-unit"],
    size: rawBucket.window?.size ?? rawBucket.windowSize ?? rawBucket["window-size"]
  }) || parseRateLimitWindowInput(rawBucket.window);
  if (!window) {
    return { bucket: null, reason: `bucket '${id}' window is invalid. Use e.g. 'month:1' or '1 week'.` };
  }

  const metadata = rawBucket.metadata;
  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
    return { bucket: null, reason: `bucket '${id}' metadata must be a JSON object when provided.` };
  }

  return {
    bucket: {
      id,
      ...(name ? { name } : {}),
      models,
      requests,
      window,
      ...(metadata !== undefined ? { metadata } : {})
    },
    reason: ""
  };
}

function parseRateLimitBucketListInput(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return [raw];

  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed];
  } catch {
    return [];
  }
  return [];
}

export function setProviderRateLimitsInConfig(config, {
  providerId,
  buckets,
  replaceBuckets = false,
  removeBucketId = ""
}) {
  const next = structuredClone(config);
  const normalizedProviderId = String(providerId || "").trim();
  if (!normalizedProviderId) {
    return { config: next, changed: false, reason: "provider-id is required." };
  }

  const provider = (next.providers || []).find((item) => item.id === normalizedProviderId);
  if (!provider) {
    return { config: next, changed: false, reason: `Provider '${normalizedProviderId}' not found.` };
  }

  const previousRateLimits = Array.isArray(provider.rateLimits) ? provider.rateLimits : [];
  const currentById = new Map(previousRateLimits.map((bucket) => [bucket.id, bucket]));
  const removeId = String(removeBucketId || "").trim();

  if (removeId) {
    if (!currentById.has(removeId)) {
      return {
        config: next,
        changed: false,
        reason: `Rate-limit bucket '${removeId}' not found on provider '${normalizedProviderId}'.`
      };
    }
    currentById.delete(removeId);
  } else {
    const normalizedBuckets = [];
    const reservedIds = replaceBuckets
      ? new Set()
      : new Set(currentById.keys());
    for (const rawBucket of (buckets || [])) {
      const normalized = normalizeRateLimitBucketForConfig(rawBucket, { reservedIds });
      if (!normalized.bucket) {
        return {
          config: next,
          changed: false,
          reason: normalized.reason || "Invalid rate-limit bucket input."
        };
      }
      normalizedBuckets.push(normalized.bucket);
    }

    if (normalizedBuckets.length === 0) {
      return {
        config: next,
        changed: false,
        reason: "At least one rate-limit bucket is required."
      };
    }

    if (replaceBuckets) {
      currentById.clear();
    }
    for (const bucket of normalizedBuckets) {
      currentById.set(bucket.id, bucket);
    }
  }

  provider.rateLimits = Array.from(currentById.values());
  const validationErrors = validateRuntimeConfig(next, { requireProvider: false, requireMasterKey: false });
  if (validationErrors.length > 0) {
    return {
      config,
      changed: false,
      reason: formatConfigValidationError(validationErrors)
    };
  }

  return {
    config: next,
    changed: serializeStable(previousRateLimits) !== serializeStable(provider.rateLimits),
    reason: "",
    providerId: normalizedProviderId,
    rateLimits: provider.rateLimits
  };
}

function setMasterKeyInConfig(config, masterKey) {
  return {
    ...config,
    masterKey
  };
}

async function resolveUpsertInput(context, existingConfig) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const providers = existingConfig.providers || [];

  const argProviderId = String(readArg(args, ["provider-id", "providerId"], "") || "");
  let selectedExisting = null;

  if (canPrompt() && !argProviderId && providers.length > 0) {
    const choice = await context.prompts.select({
      message: "Provider config action",
      options: [
        { value: "__new__", label: "Add new provider" },
        ...providers.map((provider) => ({
          value: provider.id,
          label: `Edit ${provider.id}`,
          hint: `${provider.baseUrl}`
        }))
      ]
    });
    if (choice !== "__new__") {
      selectedExisting = providers.find((p) => p.id === choice) || null;
    }
  } else if (argProviderId) {
    selectedExisting = providers.find((p) => p.id === argProviderId) || null;
  }

  const baseProviderId = argProviderId || selectedExisting?.id || "";
  const baseName = String(readArg(args, ["name"], selectedExisting?.name || "") || "");
  const baseUrl = String(readArg(args, ["base-url", "baseUrl"], selectedExisting?.baseUrl || "") || "");
  const baseEndpoints = parseEndpointListInput(readArg(
    args,
    ["endpoints"],
    providerEndpointsFromConfig(selectedExisting).join(",")
  ));
  const baseOpenAIBaseUrl = String(readArg(
    args,
    ["openai-base-url", "openaiBaseUrl"],
    selectedExisting?.baseUrlByFormat?.openai || ""
  ) || "");
  const baseClaudeBaseUrl = String(readArg(
    args,
    ["claude-base-url", "claudeBaseUrl", "anthropic-base-url", "anthropicBaseUrl"],
    selectedExisting?.baseUrlByFormat?.claude || ""
  ) || "");
  const baseApiKey = String(readArg(args, ["api-key", "apiKey"], "") || "");
  const baseModels = String(readArg(args, ["models"], (selectedExisting?.models || []).map((m) => m.id).join(",")) || "");
  const baseFormat = String(readArg(args, ["format"], selectedExisting?.format || "") || "");
  const baseFormats = parseModelListInput(readArg(args, ["formats"], (selectedExisting?.formats || []).join(",")));
  const hasHeadersArg = args.headers !== undefined;
  const baseHeaders = readArg(args, ["headers"], selectedExisting?.headers ? JSON.stringify(selectedExisting.headers) : "");
  const baseProbeRequestsPerMinute = toPositiveInteger(
    readArg(args, ["probe-rpm", "probe-requests-per-minute", "probeRequestsPerMinute"], DEFAULT_PROBE_REQUESTS_PER_MINUTE),
    DEFAULT_PROBE_REQUESTS_PER_MINUTE
  );
  const shouldProbe = !toBoolean(readArg(args, ["skip-probe", "skipProbe"], false), false);
  const setMasterKeyFlag = toBoolean(readArg(args, ["set-master-key", "setMasterKey"], false), false);
  const providedMasterKey = String(readArg(args, ["master-key", "masterKey"], "") || "");
  const parsedHeaders = applyDefaultHeaders(
    parseJsonObjectArg(baseHeaders, "--headers"),
    { force: !hasHeadersArg }
  );

  if (!canPrompt()) {
    return {
      configPath,
      providerId: baseProviderId || slugifyId(baseName || "provider"),
      name: baseName,
      baseUrl,
      endpoints: baseEndpoints,
      openaiBaseUrl: baseOpenAIBaseUrl,
      claudeBaseUrl: baseClaudeBaseUrl,
      apiKey: baseApiKey || selectedExisting?.apiKey || "",
      models: parseProviderModelListInput(baseModels),
      format: baseFormat,
      formats: baseFormats,
      headers: parsedHeaders,
      probeRequestsPerMinute: baseProbeRequestsPerMinute,
      shouldProbe,
      setMasterKey: setMasterKeyFlag || Boolean(providedMasterKey),
      masterKey: providedMasterKey
    };
  }

  printProviderInputGuidance(context);

  const name = baseName || await context.prompts.text({
    message: "Provider Friendly Name (unique, shown in management screen)",
    required: true,
    placeholder: "OpenRouter Primary",
    validate: (value) => {
      const candidate = String(value || "").trim();
      if (!candidate) return "Provider Friendly Name is required.";
      const duplicate = findProviderByFriendlyName(providers, candidate, { excludeId: selectedExisting?.id || baseProviderId });
      if (duplicate) return `Provider Friendly Name '${candidate}' already exists (provider-id: ${duplicate.id}). Use a unique name.`;
      return undefined;
    }
  });

  const providerId = baseProviderId || await context.prompts.text({
    message: "Provider ID (auto-slug from Friendly Name; editable)",
    required: true,
    initialValue: slugifyId(name),
    placeholder: "openrouterPrimary",
    validate: (value) => {
      const candidate = String(value || "").trim();
      if (!candidate) return "Provider ID is required.";
      if (!PROVIDER_ID_PATTERN.test(candidate)) {
        return "Use slug/camelCase with letters, numbers, underscore, dot, or hyphen (e.g. openrouterPrimary).";
      }
      return undefined;
    }
  });

  const askReplaceKey = selectedExisting?.apiKey ? await context.prompts.confirm({
    message: "Replace saved API key?",
    initialValue: false
  }) : true;

  const apiKey = (baseApiKey || (!askReplaceKey ? selectedExisting?.apiKey : "")) || await promptSecretInput(context, {
    message: "Provider API key",
    required: true,
    validate: (value) => {
      const candidate = String(value || "").trim();
      if (!candidate) return "Provider API key is required.";
      return undefined;
    }
  });

  const endpointsInput = await context.prompts.text({
    message: "Provider endpoints (comma / ; / space / newline separated; multiline paste supported)",
    required: true,
    initialValue: baseEndpoints.join("\n"),
    paste: true,
    multiline: true
  });
  const endpoints = parseEndpointListInput(endpointsInput);
  maybeReportInputCleanup(context, "endpoint", endpointsInput, endpoints);

  const modelsInput = await context.prompts.text({
    message: "Provider models (comma / ; / space / newline separated; multiline paste supported)",
    required: true,
    initialValue: baseModels,
    paste: true,
    multiline: true
  });
  const models = parseProviderModelListInput(modelsInput);
  maybeReportInputCleanup(context, "model", modelsInput, models);

  const headersInput = await context.prompts.text({
    message: "Custom headers JSON (optional; default User-Agent included)",
    initialValue: JSON.stringify(applyDefaultHeaders(
      parseJsonObjectArg(baseHeaders, "Custom headers"),
      { force: true }
    ))
  });
  const interactiveHeaders = parseJsonObjectArg(headersInput, "Custom headers");

  const probe = await context.prompts.confirm({
    message: "Auto-detect endpoint formats and model support via live probe?",
    initialValue: shouldProbe
  });
  const warn = typeof context?.terminal?.warn === "function" ? context.terminal.warn.bind(context.terminal) : null;
  let probeRequestsPerMinute = baseProbeRequestsPerMinute;
  if (probe) {
    warn?.("Auto-discovery sends real API requests and may consume paid provider usage.");
    const rpmInput = await context.prompts.text({
      message: `Provider probe request budget per minute (default ${DEFAULT_PROBE_REQUESTS_PER_MINUTE})`,
      required: true,
      initialValue: String(baseProbeRequestsPerMinute),
      validate: (value) => {
        const parsed = toPositiveInteger(value, Number.NaN);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return "Enter a positive integer request-per-minute value.";
        }
        return undefined;
      }
    });
    probeRequestsPerMinute = toPositiveInteger(rpmInput, DEFAULT_PROBE_REQUESTS_PER_MINUTE);
  }

  let manualFormat = baseFormat;
  if (!probe) {
    manualFormat = await promptProviderFormat(context, {
      message: "Primary provider format",
      initialFormat: manualFormat
    });
  }

  const setMasterKey = setMasterKeyFlag || await context.prompts.confirm({
    message: "Set/update worker master key?",
    initialValue: false
  });
  let masterKey = providedMasterKey;
  if (setMasterKey && !masterKey) {
    masterKey = await context.prompts.text({
      message: "Worker master key",
      required: true
    });
  }

  return {
    configPath,
    providerId,
    name,
    baseUrl,
    endpoints,
    openaiBaseUrl: baseOpenAIBaseUrl,
    claudeBaseUrl: baseClaudeBaseUrl,
    apiKey,
    models,
    format: probe ? "" : manualFormat,
    formats: baseFormats,
    headers: interactiveHeaders,
    probeRequestsPerMinute,
    shouldProbe: probe,
    setMasterKey,
    masterKey
  };
}

async function doUpsertProvider(context) {
  const configPath = readArg(context.args, ["config", "configPath"], getDefaultConfigPath());
  const existingConfig = await readConfigFile(configPath);
  const input = await resolveUpsertInput(context, existingConfig);

  const endpointCandidates = parseEndpointListInput([
    ...(input.endpoints || []),
    input.openaiBaseUrl,
    input.claudeBaseUrl,
    input.baseUrl
  ].filter(Boolean).join(","));
  const hasAnyEndpoint = endpointCandidates.length > 0;
  if (!input.name || !hasAnyEndpoint || !input.apiKey) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "Missing provider inputs: provider-id, name, api-key, and at least one endpoint."
    };
  }

  if (!PROVIDER_ID_PATTERN.test(input.providerId)) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `Invalid provider id '${input.providerId}'. Use slug/camelCase (e.g. openrouter or myProvider).`
    };
  }

  const duplicateFriendlyName = findProviderByFriendlyName(existingConfig.providers || [], input.name, {
    excludeId: input.providerId
  });
  if (duplicateFriendlyName) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `Provider Friendly Name '${input.name}' already exists (provider-id: ${duplicateFriendlyName.id}). Choose a unique name.`
    };
  }

  let probe = null;
  let selectedFormat = String(input.format || "").trim();
  let effectiveBaseUrl = String(input.baseUrl || "").trim();
  let effectiveOpenAIBaseUrl = String(input.openaiBaseUrl || "").trim();
  let effectiveClaudeBaseUrl = String(input.claudeBaseUrl || "").trim();
  let effectiveModels = [...(input.models || [])];

  if (input.shouldProbe && endpointCandidates.length > 0 && effectiveModels.length === 0) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "Model list is required for endpoint-model probe. Provide --models=modelA,modelB."
    };
  }

  if (input.shouldProbe) {
    const startedAt = Date.now();
    const reportProgress = probeProgressReporter(context);
    const probeRequestsPerMinute = toPositiveInteger(
      input.probeRequestsPerMinute,
      DEFAULT_PROBE_REQUESTS_PER_MINUTE
    );
    const canRunMatrixProbe = endpointCandidates.length > 0 && effectiveModels.length > 0;
    if (canRunMatrixProbe) {
      probe = await probeProviderEndpointMatrix({
        endpoints: endpointCandidates,
        models: effectiveModels,
        apiKey: input.apiKey,
        headers: input.headers,
        requestsPerMinute: probeRequestsPerMinute,
        maxRateLimitRetries: DEFAULT_PROBE_MAX_RATE_LIMIT_RETRIES,
        onProgress: reportProgress
      });
      effectiveOpenAIBaseUrl = probe.baseUrlByFormat?.openai || effectiveOpenAIBaseUrl;
      effectiveClaudeBaseUrl = probe.baseUrlByFormat?.claude || effectiveClaudeBaseUrl;
      effectiveBaseUrl =
        (probe.preferredFormat && probe.baseUrlByFormat?.[probe.preferredFormat]) ||
        effectiveOpenAIBaseUrl ||
        effectiveClaudeBaseUrl ||
        endpointCandidates[0] ||
        effectiveBaseUrl;
      if ((probe.models || []).length > 0) {
        effectiveModels = effectiveModels.length > 0
          ? effectiveModels.filter((model) => (probe.models || []).includes(model))
          : [...probe.models];
      }
    } else {
      const probeBaseUrlByFormat = {};
      if (effectiveOpenAIBaseUrl) probeBaseUrlByFormat.openai = effectiveOpenAIBaseUrl;
      if (effectiveClaudeBaseUrl) probeBaseUrlByFormat.claude = effectiveClaudeBaseUrl;

      probe = await probeProvider({
        baseUrl: effectiveBaseUrl || endpointCandidates[0],
        baseUrlByFormat: Object.keys(probeBaseUrlByFormat).length > 0 ? probeBaseUrlByFormat : undefined,
        apiKey: input.apiKey,
        headers: input.headers,
        onProgress: reportProgress
      });
    }
    const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
    if (line) {
      const tookMs = Date.now() - startedAt;
      line(`Auto-discovery finished in ${(tookMs / 1000).toFixed(1)}s.`);
    }
    selectedFormat = probe.preferredFormat || selectedFormat;
    if (probe?.manualFallbackRecommended) {
      if (!canPrompt()) {
        const scope = probe?.failureScope === "full" ? "full" : "partial";
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_FAILURE,
          errorMessage: scope === "full"
            ? "Auto-discovery failed fully (no working endpoint/format detected). Re-run interactively for manual fallback or use --skip-probe=true with explicit endpoint/format."
            : "Auto-discovery failed partially (some endpoint/model checks unresolved). Re-run interactively for manual fallback or use --skip-probe=true with explicit endpoint/model inputs."
        };
      }
      const fallback = await runProbeManualFallback(context, {
        probe,
        selectedFormat,
        effectiveOpenAIBaseUrl,
        effectiveClaudeBaseUrl,
        effectiveModels
      });
      selectedFormat = fallback.selectedFormat;
      effectiveOpenAIBaseUrl = fallback.effectiveOpenAIBaseUrl;
      effectiveClaudeBaseUrl = fallback.effectiveClaudeBaseUrl;
      effectiveModels = fallback.effectiveModels;
      effectiveBaseUrl =
        (selectedFormat === "openai" ? effectiveOpenAIBaseUrl : "") ||
        (selectedFormat === "claude" ? effectiveClaudeBaseUrl : "") ||
        effectiveOpenAIBaseUrl ||
        effectiveClaudeBaseUrl ||
        effectiveBaseUrl ||
        endpointCandidates[0];
    } else if (!probe.ok) {
      if (canPrompt()) {
        const continueWithoutProbe = await context.prompts.confirm({
          message: "Probe failed to confirm working endpoint/model support. Save provider anyway?",
          initialValue: false
        });
        if (!continueWithoutProbe) {
          return {
            ok: false,
            mode: context.mode,
            exitCode: EXIT_FAILURE,
            errorMessage: "Config cancelled because provider probe failed."
          };
        }

        selectedFormat = await promptProviderFormat(context, {
          message: "Probe could not confirm a working format. Choose primary provider format",
          initialFormat: selectedFormat
        });
      } else {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_FAILURE,
          errorMessage: "Provider probe failed. Provide valid endpoints/models or use --skip-probe=true to force save."
        };
      }
    }
  }

  if (!input.shouldProbe) {
    if (!effectiveBaseUrl && endpointCandidates.length > 0) {
      effectiveBaseUrl = endpointCandidates[0];
    }
    if (!effectiveOpenAIBaseUrl && !effectiveClaudeBaseUrl && endpointCandidates.length === 1 && selectedFormat) {
      if (selectedFormat === "openai") effectiveOpenAIBaseUrl = endpointCandidates[0];
      if (selectedFormat === "claude") effectiveClaudeBaseUrl = endpointCandidates[0];
    }
    if (!effectiveOpenAIBaseUrl && !effectiveClaudeBaseUrl && endpointCandidates.length > 1) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: "Multiple endpoints require probe mode (recommended) or explicit --openai-base-url/--claude-base-url."
      };
    }
  }

  const effectiveFormat = selectedFormat || (input.shouldProbe ? "" : "openai");

  const provider = buildProviderFromConfigInput({
    providerId: input.providerId,
    name: input.name,
    baseUrl: effectiveBaseUrl,
    openaiBaseUrl: effectiveOpenAIBaseUrl,
    claudeBaseUrl: effectiveClaudeBaseUrl,
    apiKey: input.apiKey,
    models: effectiveModels,
    format: effectiveFormat,
    formats: input.formats,
    headers: input.headers,
    probe
  });

  if (!provider.models || provider.models.length === 0) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "Provider must have at least one model. Add --models or enable probe discovery."
    };
  }

  const nextConfig = applyConfigChanges(existingConfig, {
    provider,
    masterKey: input.setMasterKey ? input.masterKey : existingConfig.masterKey,
    setDefaultModel: true
  });

  await writeConfigFile(nextConfig, input.configPath);
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: [
      `Saved provider '${provider.id}' to ${input.configPath}`,
      probe
        ? `probe preferred=${probe.preferredFormat || "(none)"} working=${(probe.workingFormats || []).join(",") || "(none)"}`
        : "probe=skipped",
      provider.baseUrlByFormat?.openai ? `openaiBaseUrl=${provider.baseUrlByFormat.openai}` : "",
      provider.baseUrlByFormat?.claude ? `claudeBaseUrl=${provider.baseUrlByFormat.claude}` : "",
      `formats=${(provider.formats || []).join(", ") || provider.format || "unknown"}`,
      `models=${provider.models.map((m) => `${m.id}${m.formats?.length ? `[${m.formats.join("|")}]` : ""}`).join(", ")}`,
      `masterKey=${nextConfig.masterKey ? maskSecret(nextConfig.masterKey) : "(not set)"}`
    ].join("\n")
  };
}

async function doListConfig(context) {
  const configPath = readArg(context.args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: summarizeConfig(config, configPath)
  };
}

async function doListRouting(context) {
  return doListConfig(context);
}

async function doMigrateConfig(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const targetVersionRaw = readArg(args, ["target-version", "targetVersion"], CONFIG_VERSION);
  const targetVersion = Number.parseInt(String(targetVersionRaw), 10);
  const createBackup = toBoolean(readArg(args, ["create-backup", "createBackup", "backup"], true), true);

  if (!Number.isFinite(targetVersion) || targetVersion <= 0) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `Invalid target-version '${targetVersionRaw}'.`
    };
  }

  if (!(await configFileExists(configPath))) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `Config not found at ${configPath}.`
    };
  }

  if (canPrompt()) {
    const confirm = await context.prompts.confirm({
      message: `Migrate config to version ${targetVersion}${createBackup ? " with backup" : ""}?`,
      initialValue: true
    });
    if (!confirm) {
      return { ok: false, mode: context.mode, exitCode: EXIT_FAILURE, errorMessage: "Cancelled." };
    }
  }

  let migration;
  try {
    migration = await migrateConfigFile(configPath, {
      targetVersion,
      createBackup
    });
  } catch (error) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: [
      migration.changed
        ? `Migrated config ${migration.beforeVersion} -> ${migration.afterVersion}.`
        : `Config already at target schema (version ${migration.afterVersion}).`,
      migration.backupPath ? `backup=${migration.backupPath}` : "backup=(not created)",
      `config=${configPath}`
    ].join("\n")
  };
}

async function doRemoveProvider(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  let providerId = String(readArg(args, ["provider-id", "providerId"], "") || "");

  if (canPrompt() && !providerId) {
    if (!config.providers.length) {
      return { ok: true, mode: context.mode, exitCode: EXIT_SUCCESS, data: "No providers to remove." };
    }
    providerId = await context.prompts.select({
      message: "Remove provider",
      options: config.providers.map((provider) => ({
        value: provider.id,
        label: provider.id,
        hint: `${provider.models.length} model(s)`
      }))
    });
  }

  if (!providerId) {
    return { ok: false, mode: context.mode, exitCode: EXIT_VALIDATION, errorMessage: "provider-id is required." };
  }

  const exists = config.providers.some((p) => p.id === providerId);
  if (!exists) {
    return { ok: false, mode: context.mode, exitCode: EXIT_VALIDATION, errorMessage: `Provider '${providerId}' not found.` };
  }

  if (canPrompt()) {
    const confirm = await context.prompts.confirm({ message: `Delete provider '${providerId}'?`, initialValue: false });
    if (!confirm) {
      return { ok: false, mode: context.mode, exitCode: EXIT_FAILURE, errorMessage: "Cancelled." };
    }
  }

  let nextConfig = removeProvider(config, providerId);
  if (nextConfig.defaultModel?.startsWith(`${providerId}/`)) {
    const fallbackProvider = nextConfig.providers[0];
    nextConfig = {
      ...nextConfig,
      defaultModel: fallbackProvider?.models?.[0] ? `${fallbackProvider.id}/${fallbackProvider.models[0].id}` : undefined
    };
  }

  await writeConfigFile(nextConfig, configPath);
  return { ok: true, mode: context.mode, exitCode: EXIT_SUCCESS, data: `Removed provider '${providerId}'.` };
}

async function doRemoveModel(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  let providerId = String(readArg(args, ["provider-id", "providerId"], "") || "");
  let modelId = String(readArg(args, ["model"], "") || "");

  if (canPrompt()) {
    if (!providerId) {
      if (!config.providers.length) {
        return { ok: true, mode: context.mode, exitCode: EXIT_SUCCESS, data: "No providers configured." };
      }
      providerId = await context.prompts.select({
        message: "Select provider",
        options: config.providers.map((provider) => ({
          value: provider.id,
          label: provider.id,
          hint: `${provider.models.length} model(s)`
        }))
      });
    }
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) {
      return { ok: false, mode: context.mode, exitCode: EXIT_VALIDATION, errorMessage: `Provider '${providerId}' not found.` };
    }
    if (!modelId) {
      if (!provider.models.length) {
        return { ok: true, mode: context.mode, exitCode: EXIT_SUCCESS, data: `Provider '${providerId}' has no models.` };
      }
      modelId = await context.prompts.select({
        message: `Remove model from ${providerId}`,
        options: provider.models.map((model) => ({
          value: model.id,
          label: model.id
        }))
      });
    }
  }

  if (!providerId || !modelId) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "provider-id and model are required."
    };
  }

  const removal = removeModelFromConfig(config, providerId, modelId);
  if (!removal.changed) {
    return { ok: false, mode: context.mode, exitCode: EXIT_VALIDATION, errorMessage: removal.reason };
  }
  await writeConfigFile(removal.config, configPath);
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: `Removed model '${modelId}' from '${providerId}'.`
  };
}

async function doSetModelFallbacks(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  let providerId = String(readArg(args, ["provider-id", "providerId"], "") || "");
  let modelId = String(readArg(args, ["model"], "") || "");
  const hasFallbackModelsArg =
    Object.prototype.hasOwnProperty.call(args, "fallback-models") ||
    Object.prototype.hasOwnProperty.call(args, "fallbackModels") ||
    Object.prototype.hasOwnProperty.call(args, "fallbacks");
  const fallbackModelsRaw = hasFallbackModelsArg
    ? (args["fallback-models"] ?? args.fallbackModels ?? args.fallbacks ?? "")
    : "";
  const clearFallbacks = toBoolean(readArg(args, ["clear-fallbacks", "clearFallbacks"], false), false);
  let selectedFallbacks = clearFallbacks ? [] : parseQualifiedModelListInput(fallbackModelsRaw);

  if (canPrompt()) {
    if (!providerId) {
      if (!config.providers.length) {
        return { ok: true, mode: context.mode, exitCode: EXIT_SUCCESS, data: "No providers configured." };
      }
      providerId = await context.prompts.select({
        message: "Select provider for silent-fallback",
        options: config.providers.map((provider) => ({
          value: provider.id,
          label: provider.id,
          hint: `${provider.models.length} model(s)`
        }))
      });
    }

    const resolved = resolveProviderAndModel(config, providerId, modelId);
    const provider = resolved.provider;
    if (!provider) {
      return { ok: false, mode: context.mode, exitCode: EXIT_VALIDATION, errorMessage: resolved.reason };
    }

    if (!modelId) {
      if (!provider.models.length) {
        return { ok: true, mode: context.mode, exitCode: EXIT_SUCCESS, data: `Provider '${providerId}' has no models.` };
      }
      modelId = await context.prompts.select({
        message: `Select source model from ${providerId}`,
        options: provider.models.map((model) => ({
          value: model.id,
          label: model.id
        }))
      });
    } else if (!resolved.model) {
      return { ok: false, mode: context.mode, exitCode: EXIT_VALIDATION, errorMessage: resolved.reason };
    }

    const resolvedModel = resolveProviderAndModel(config, providerId, modelId);
    if (!resolvedModel.model) {
      return { ok: false, mode: context.mode, exitCode: EXIT_VALIDATION, errorMessage: resolvedModel.reason };
    }

    const sourceModelId = resolvedModel.model.id;
    const fallbackOptions = listFallbackModelOptions(config, providerId, sourceModelId);
    const fallbackOptionSet = new Set(fallbackOptions.map((option) => option.value));
    const currentFallbacks = dedupeList(resolvedModel.model.fallbackModels || [])
      .filter((entry) => fallbackOptionSet.has(entry));
    const initialValues = selectedFallbacks.length > 0
      ? selectedFallbacks.filter((entry) => fallbackOptionSet.has(entry))
      : currentFallbacks;

    if (fallbackOptions.length === 0) {
      selectedFallbacks = [];
      const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
      line?.("No other models available. Silent-fallback list will be cleared.");
    } else {
      selectedFallbacks = await context.prompts.multiselect({
        message: `Silent-fallback models for ${providerId}/${sourceModelId}`,
        options: fallbackOptions,
        initialValues,
        required: false
      });
    }

    modelId = sourceModelId;
  }

  if (!providerId || !modelId) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "provider-id and model are required."
    };
  }

  if (!canPrompt() && !hasFallbackModelsArg && !clearFallbacks) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "fallback-models is required (or use --clear-fallbacks=true)."
    };
  }

  const updated = setModelFallbacksInConfig(config, providerId, modelId, selectedFallbacks);
  if (!updated.changed && updated.reason) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: updated.reason
    };
  }

  await writeConfigFile(updated.config, configPath);
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: [
      `Updated silent-fallback models for '${providerId}/${updated.modelId || modelId}'.`,
      `fallbacks=${(updated.fallbackModels || []).join(", ") || "(none)"}`
    ].join("\n")
  };
}

async function doUpsertModelAlias(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  const aliases = config.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};
  let aliasId = String(readArg(args, ["alias-id", "aliasId", "alias"], "") || "").trim();
  const strategyArg = readArg(args, ["strategy"], undefined);
  const hasTargetsArg =
    Object.prototype.hasOwnProperty.call(args, "targets") ||
    Object.prototype.hasOwnProperty.call(args, "alias-targets") ||
    Object.prototype.hasOwnProperty.call(args, "aliasTargets");
  const hasFallbackTargetsArg =
    Object.prototype.hasOwnProperty.call(args, "fallback-targets") ||
    Object.prototype.hasOwnProperty.call(args, "fallbackTargets");
  const clearFallbackTargets = toBoolean(readArg(args, ["clear-fallback-targets", "clearFallbackTargets"], false), false);
  let targetsInput = hasTargetsArg ? (args.targets ?? args["alias-targets"] ?? args.aliasTargets ?? "") : undefined;
  let fallbackTargetsInput = hasFallbackTargetsArg ? (args["fallback-targets"] ?? args.fallbackTargets ?? "") : undefined;
  const hasAliasMetadataArg =
    Object.prototype.hasOwnProperty.call(args, "alias-metadata") ||
    Object.prototype.hasOwnProperty.call(args, "aliasMetadata");
  const aliasMetadataRaw = hasAliasMetadataArg ? (args["alias-metadata"] ?? args.aliasMetadata ?? "") : undefined;
  let aliasMetadata = undefined;
  if (hasAliasMetadataArg) {
    aliasMetadata = parseJsonObjectArg(aliasMetadataRaw, "--alias-metadata");
  }

  if (canPrompt()) {
    const info = typeof context?.terminal?.info === "function" ? context.terminal.info.bind(context.terminal) : null;
    const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
    info?.("A model alias lets you group models from multiple providers behind one model name.");
    line?.("Routing strategy decides how requests are distributed across the alias targets.");

    if (!aliasId) {
      const aliasIds = Object.keys(aliases);
      if (aliasIds.length > 0) {
        const selected = await context.prompts.select({
          message: "Model alias action",
          options: [
            { value: "__new__", label: "Create new alias" },
            ...aliasIds.map((id) => ({
              value: id,
              label: `Edit ${id}`,
              hint: `${(aliases[id]?.targets || []).length} target(s)`
            }))
          ]
        });
        if (selected !== "__new__") aliasId = selected;
      }
    }

    const existingAlias = aliasId ? aliases[aliasId] : null;
    if (!aliasId) {
      aliasId = await context.prompts.text({
        message: "Alias ID (e.g. chat.default)",
        required: true,
        validate: (value) => {
          const candidate = String(value || "").trim();
          if (!candidate) return "Alias ID is required.";
          if (!MODEL_ALIAS_ID_PATTERN.test(candidate)) {
            return "Use letters/numbers and . _ : - separators.";
          }
          return undefined;
        }
      });
    }

    const selectedStrategy = normalizeModelAliasStrategy(strategyArg || existingAlias?.strategy || "auto") || "auto";
    const strategy = await context.prompts.select({
      message: "Model alias routing strategy",
      options: MODEL_ROUTING_STRATEGY_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        hint: option.hint
      })),
      initialValue: selectedStrategy
    });

    if (!hasTargetsArg) {
      const defaultTargets = formatAliasTargetsForSummary(existingAlias?.targets || []);
      targetsInput = await context.prompts.text({
        message: "Alias targets (<ref>@<weight>, comma-separated)",
        required: true,
        initialValue: defaultTargets === "(none)" ? "" : defaultTargets,
        placeholder: "openrouter/gpt-4o-mini@3,anthropic/claude-3-5-haiku@2"
      });
    }

    if (!clearFallbackTargets && !hasFallbackTargetsArg) {
      const defaultFallbacks = formatAliasTargetsForSummary(existingAlias?.fallbackTargets || []);
      fallbackTargetsInput = await context.prompts.text({
        message: "Alias fallback targets (optional; same syntax)",
        required: false,
        initialValue: defaultFallbacks === "(none)" ? "" : defaultFallbacks,
        placeholder: "openrouter/gpt-4o"
      });
    }

    const updated = upsertModelAliasInConfig(config, {
      aliasId,
      strategy,
      targets: targetsInput,
      fallbackTargets: clearFallbackTargets ? [] : fallbackTargetsInput,
      clearFallbackTargets,
      metadata: aliasMetadata
    });
    if (!updated.changed && updated.reason) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: updated.reason
      };
    }

    await writeConfigFile(updated.config, configPath);
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: [
        `Upserted model alias '${updated.aliasId || aliasId}'.`,
        `targets=${formatAliasTargetsForSummary(updated.config.modelAliases?.[updated.aliasId || aliasId]?.targets)}`,
        `fallbackTargets=${formatAliasTargetsForSummary(updated.config.modelAliases?.[updated.aliasId || aliasId]?.fallbackTargets)}`
      ].join("\n")
    };
  }

  const updated = upsertModelAliasInConfig(config, {
    aliasId,
    strategy: strategyArg,
    targets: targetsInput,
    fallbackTargets: clearFallbackTargets ? [] : fallbackTargetsInput,
    clearFallbackTargets,
    metadata: aliasMetadata
  });

  if (!updated.changed && updated.reason) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: updated.reason
    };
  }

  await writeConfigFile(updated.config, configPath);
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: [
      `Upserted model alias '${updated.aliasId || aliasId}'.`,
      `targets=${formatAliasTargetsForSummary(updated.config.modelAliases?.[updated.aliasId || aliasId]?.targets)}`,
      `fallbackTargets=${formatAliasTargetsForSummary(updated.config.modelAliases?.[updated.aliasId || aliasId]?.fallbackTargets)}`
    ].join("\n")
  };
}

async function doRemoveModelAlias(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  let aliasId = String(readArg(args, ["alias-id", "aliasId", "alias"], "") || "").trim();

  const aliasEntries = Object.keys(config.modelAliases || {});
  if (canPrompt() && !aliasId) {
    if (aliasEntries.length === 0) {
      return { ok: true, mode: context.mode, exitCode: EXIT_SUCCESS, data: "No model aliases configured." };
    }

    aliasId = await context.prompts.select({
      message: "Remove model alias",
      options: aliasEntries.map((id) => ({
        value: id,
        label: id
      }))
    });
  }

  const removal = removeModelAliasFromConfig(config, aliasId);
  if (!removal.changed) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: removal.reason
    };
  }

  await writeConfigFile(removal.config, configPath);
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: `Removed model alias '${removal.aliasId}'.`
  };
}

function printRateLimitBucketIntro(context) {
  if (!canPrompt()) return;
  const info = typeof context?.terminal?.info === "function" ? context.terminal.info.bind(context.terminal) : null;
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
  info?.("A bucket is a request cap for a time window.");
  line?.("You can add multiple buckets to the same models, for example 40/minute and 600/6 hours.");
}

function buildProviderRateLimitReview(provider) {
  const buckets = provider?.rateLimits || [];
  if (buckets.length === 0) {
    return `Provider '${provider?.id || "(unknown)"}' has no rate-limit buckets.`;
  }

  return [
    `Rate-limit buckets for '${provider?.id || "(unknown)"}':`,
    ...buckets.map((bucket) => `- ${formatRateLimitBucketLabel(bucket, { includeId: true })}: ${summarizeRateLimitBucketCap(bucket)} | scope=${formatRateLimitBucketScopeLabel(bucket)}`)
  ].join("\n");
}

function buildRateLimitBucketPromptOptions(provider) {
  return (provider?.rateLimits || []).map((bucket) => ({
    value: bucket.id,
    label: `${formatRateLimitBucketLabel(bucket)} (${summarizeRateLimitBucketCap(bucket)})`,
    hint: formatRateLimitBucketScopeLabel(bucket)
  }));
}

function buildRateLimitWindowUnitOptions(initialUnit = "") {
  const options = [
    { value: "minute", label: "Minute", hint: "Fixed to 1 minute" },
    { value: "hour", label: "Hour(s)", hint: "Choose any positive hour count" },
    { value: "week", label: "Week", hint: "Fixed to 1 week" },
    { value: "month", label: "Month", hint: "Fixed to 1 month" }
  ];
  if (initialUnit === "day") {
    options.push({ value: "day", label: "Day (legacy)", hint: "Retained for existing configs" });
  }
  if (initialUnit === "second") {
    options.push({ value: "second", label: "Second (legacy)", hint: "Retained for existing configs" });
  }
  return options;
}

function printRateLimitBucketPreview(context, bucket) {
  if (!canPrompt()) return;
  const info = typeof context?.terminal?.info === "function" ? context.terminal.info.bind(context.terminal) : null;
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
  info?.("Bucket review:");
  line?.(`  Name: ${formatRateLimitBucketLabel(bucket)}`);
  line?.(`  Scope: ${formatRateLimitBucketScopeLabel(bucket)}`);
  line?.(`  Cap: ${summarizeRateLimitBucketCap(bucket)}`);
  line?.(`  Advanced detail: internal id = ${bucket.id}`);
}

async function promptRateLimitBucketWizard(context, {
  provider,
  initialBucket = null,
  reservedIds = new Set()
} = {}) {
  const initialName = sanitizeRateLimitBucketName(initialBucket?.name || initialBucket?.id || "");
  const providerModelIds = dedupeList((provider?.models || []).map((model) => model?.id));
  const initialModels = dedupeList(initialBucket?.models || []);
  const initialScope = initialModels.includes("all") || initialModels.length === 0 ? "all" : "selected";
  const initialWindow = parseRateLimitWindowInput(initialBucket?.window) || { unit: "minute", size: 1 };
  const initialUnit = String(initialWindow.unit || "").trim().toLowerCase() || "minute";
  const initialSize = Number.parseInt(String(initialWindow.size ?? "1"), 10) || 1;

  const name = await context.prompts.text({
    message: "Bucket name",
    required: true,
    initialValue: initialName,
    placeholder: "Minute cap",
    validate: (value) => sanitizeRateLimitBucketName(value) ? undefined : "Bucket name is required."
  });

  const modelScope = await context.prompts.select({
    message: "Bucket model scope",
    options: [
      { value: "all", label: "All models" },
      { value: "selected", label: "Selected models" }
    ],
    initialValue: initialScope
  });

  let models = ["all"];
  if (modelScope === "selected") {
    if (providerModelIds.length === 0) {
      return {
        bucket: null,
        reason: `Provider '${provider?.id || "(unknown)"}' has no models to choose from.`
      };
    }
    models = await context.prompts.multiselect({
      message: `Choose models for ${provider?.id || "provider"}`,
      options: providerModelIds.map((modelId) => ({
        value: modelId,
        label: modelId
      })),
      initialValues: initialModels.filter((modelId) => modelId !== "all" && providerModelIds.includes(modelId)),
      required: true
    });
  }

  const requestsInput = await context.prompts.text({
    message: "Request cap",
    required: true,
    initialValue: initialBucket?.requests !== undefined ? String(initialBucket.requests) : "",
    placeholder: "40",
    validate: (value) => {
      const parsed = Number.parseInt(String(value ?? ""), 10);
      return Number.isFinite(parsed) && parsed > 0 ? undefined : "Enter a positive integer.";
    }
  });

  const windowUnit = await context.prompts.select({
    message: "Window unit",
    options: buildRateLimitWindowUnitOptions(initialUnit),
    initialValue: initialUnit
  });

  let windowSize = 1;
  if (windowUnit === "hour" || windowUnit === "day" || windowUnit === "second") {
    const sizeInput = await context.prompts.text({
      message: windowUnit === "hour" ? "How many hours?" : "Window size",
      required: true,
      initialValue: String(initialSize),
      placeholder: windowUnit === "hour" ? "6" : "1",
      validate: (value) => {
        const parsed = Number.parseInt(String(value ?? ""), 10);
        return Number.isFinite(parsed) && parsed > 0 ? undefined : "Enter a positive integer.";
      }
    });
    windowSize = Number.parseInt(String(sizeInput), 10);
  }

  let bucketId = String(initialBucket?.id || "").trim();
  if (initialBucket && name !== initialName && bucketId) {
    const regenerateId = await context.prompts.confirm({
      message: "Regenerate internal bucket id from the new name?",
      initialValue: false
    });
    if (regenerateId) {
      bucketId = "";
    }
  }

  const previewReservedIds = new Set(reservedIds || []);
  if (initialBucket?.id) {
    previewReservedIds.delete(initialBucket.id);
  }
  const normalized = normalizeRateLimitBucketForConfig({
    ...(bucketId ? { id: bucketId } : {}),
    name,
    models,
    requests: requestsInput,
    window: {
      unit: windowUnit,
      size: windowSize
    }
  }, {
    reservedIds: previewReservedIds
  });
  if (!normalized.bucket) {
    return normalized;
  }

  printRateLimitBucketPreview(context, normalized.bucket);
  const confirm = await context.prompts.confirm({
    message: initialBucket ? "Save bucket changes?" : "Create this bucket?",
    initialValue: true
  });
  if (!confirm) {
    return {
      bucket: null,
      reason: "Cancelled.",
      cancelled: true
    };
  }

  return normalized;
}

async function doSetProviderRateLimits(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  let providerId = String(readArg(args, ["provider-id", "providerId"], "") || "").trim();
  let bucketId = String(readArg(args, ["bucket-id", "bucketId"], "") || "").trim();
  let bucketName = sanitizeRateLimitBucketName(readArg(args, ["bucket-name", "bucketName"], ""));
  let modelsInput = readArg(args, ["bucket-models", "models"], undefined);
  let requestsInput = readArg(args, ["bucket-requests", "requests"], undefined);
  let windowInput = readArg(args, ["bucket-window", "window"], undefined);
  const removeBucket = toBoolean(readArg(args, ["remove-bucket", "removeBucket"], false), false);
  const replaceBuckets = toBoolean(readArg(args, ["replace-rate-limits", "replaceRateLimits"], false), false);
  const hasRateLimitsArg =
    Object.prototype.hasOwnProperty.call(args, "rate-limits") ||
    Object.prototype.hasOwnProperty.call(args, "rateLimits");
  const rateLimitsRaw = hasRateLimitsArg ? (args["rate-limits"] ?? args.rateLimits ?? "") : undefined;
  const parsedRateLimitBuckets = parseRateLimitBucketListInput(rateLimitsRaw);
  if (hasRateLimitsArg && parsedRateLimitBuckets.length === 0) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "rate-limits must be a JSON object or JSON array."
    };
  }

  if (canPrompt()) {
    if (!providerId) {
      if (!config.providers.length) {
        return { ok: true, mode: context.mode, exitCode: EXIT_SUCCESS, data: "No providers configured." };
      }
      providerId = await context.prompts.select({
        message: "Select provider for rate-limit buckets",
        options: config.providers.map((provider) => ({
          value: provider.id,
          label: provider.id,
          hint: `${(provider.rateLimits || []).length} bucket(s)`
        }))
      });
    }

    const provider = config.providers.find((item) => item.id === providerId);
    if (!provider) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: `Provider '${providerId}' not found.`
      };
    }

    const hasDirectInputs = removeBucket ||
      hasRateLimitsArg ||
      replaceBuckets ||
      !!bucketId ||
      !!bucketName ||
      modelsInput !== undefined ||
      requestsInput !== undefined ||
      windowInput !== undefined;

    if (!hasDirectInputs) {
      printRateLimitBucketIntro(context);
      const action = await context.prompts.select({
        message: "Rate-limit bucket action",
        options: [
          { value: "create", label: "Create bucket(s)" },
          { value: "edit", label: "Edit existing bucket" },
          { value: "remove", label: "Remove bucket" },
          { value: "review", label: "Review current buckets" }
        ]
      });

      if (action === "review") {
        return {
          ok: true,
          mode: context.mode,
          exitCode: EXIT_SUCCESS,
          data: buildProviderRateLimitReview(provider)
        };
      }

      if (action === "remove") {
        const bucketOptions = buildRateLimitBucketPromptOptions(provider);
        if (bucketOptions.length === 0) {
          return { ok: true, mode: context.mode, exitCode: EXIT_SUCCESS, data: `Provider '${providerId}' has no rate-limit buckets.` };
        }

        const selectedBucketId = await context.prompts.select({
          message: `Remove rate-limit bucket from ${providerId}`,
          options: bucketOptions
        });
        const selectedBucket = (provider.rateLimits || []).find((bucket) => bucket.id === selectedBucketId);
        const confirm = await context.prompts.confirm({
          message: `Remove '${formatRateLimitBucketLabel(selectedBucket)}'?`,
          initialValue: false
        });
        if (!confirm) {
          return { ok: false, mode: context.mode, exitCode: EXIT_FAILURE, errorMessage: "Cancelled." };
        }

        const removed = setProviderRateLimitsInConfig(config, {
          providerId,
          removeBucketId: selectedBucketId
        });
        if (!removed.changed) {
          return {
            ok: false,
            mode: context.mode,
            exitCode: EXIT_VALIDATION,
            errorMessage: removed.reason
          };
        }
        await writeConfigFile(removed.config, configPath);
        return {
          ok: true,
          mode: context.mode,
          exitCode: EXIT_SUCCESS,
          data: `Removed rate-limit bucket '${formatRateLimitBucketLabel(selectedBucket, { includeId: true })}' from '${providerId}'.`
        };
      }

      if (action === "edit") {
        const bucketOptions = buildRateLimitBucketPromptOptions(provider);
        if (bucketOptions.length === 0) {
          return { ok: true, mode: context.mode, exitCode: EXIT_SUCCESS, data: `Provider '${providerId}' has no rate-limit buckets.` };
        }

        const selectedBucketId = await context.prompts.select({
          message: `Edit rate-limit bucket on ${providerId}`,
          options: bucketOptions
        });
        const selectedBucket = (provider.rateLimits || []).find((bucket) => bucket.id === selectedBucketId);
        if (!selectedBucket) {
          return {
            ok: false,
            mode: context.mode,
            exitCode: EXIT_VALIDATION,
            errorMessage: `Rate-limit bucket '${selectedBucketId}' not found on provider '${providerId}'.`
          };
        }

        const wizard = await promptRateLimitBucketWizard(context, {
          provider,
          initialBucket: selectedBucket,
          reservedIds: new Set((provider.rateLimits || []).map((bucket) => bucket.id))
        });
        if (!wizard.bucket) {
          if (wizard.cancelled) {
            return { ok: false, mode: context.mode, exitCode: EXIT_FAILURE, errorMessage: wizard.reason || "Cancelled." };
          }
          return { ok: false, mode: context.mode, exitCode: EXIT_VALIDATION, errorMessage: wizard.reason || "Invalid bucket input." };
        }

        const updated = setProviderRateLimitsInConfig(config, {
          providerId,
          buckets: [wizard.bucket]
        });
        if (!updated.changed && updated.reason) {
          return {
            ok: false,
            mode: context.mode,
            exitCode: EXIT_VALIDATION,
            errorMessage: updated.reason
          };
        }
        await writeConfigFile(updated.config, configPath);
        return {
          ok: true,
          mode: context.mode,
          exitCode: EXIT_SUCCESS,
          data: [
            `Updated rate-limit bucket '${formatRateLimitBucketLabel(wizard.bucket, { includeId: true })}' on '${providerId}'.`,
            `bucketCount=${updated.rateLimits?.length || 0}`
          ].join("\n")
        };
      }

      const reservedIds = new Set((provider.rateLimits || []).map((bucket) => bucket.id));
      const newBuckets = [];
      let keepAdding = true;
      while (keepAdding) {
        const wizard = await promptRateLimitBucketWizard(context, {
          provider,
          reservedIds
        });
        if (!wizard.bucket) {
          if (wizard.cancelled) {
            if (newBuckets.length === 0) {
              return { ok: false, mode: context.mode, exitCode: EXIT_FAILURE, errorMessage: wizard.reason || "Cancelled." };
            }
            break;
          }
          return { ok: false, mode: context.mode, exitCode: EXIT_VALIDATION, errorMessage: wizard.reason || "Invalid bucket input." };
        }

        newBuckets.push(wizard.bucket);
        reservedIds.add(wizard.bucket.id);
        keepAdding = await context.prompts.confirm({
          message: "Add another bucket?",
          initialValue: false
        });
      }

      if (newBuckets.length === 0) {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_VALIDATION,
          errorMessage: "At least one rate-limit bucket is required."
        };
      }

      const updated = setProviderRateLimitsInConfig(config, {
        providerId,
        buckets: newBuckets,
        replaceBuckets: false
      });
      if (!updated.changed && updated.reason) {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_VALIDATION,
          errorMessage: updated.reason
        };
      }
      await writeConfigFile(updated.config, configPath);
      return {
        ok: true,
        mode: context.mode,
        exitCode: EXIT_SUCCESS,
        data: [
          `Updated rate-limit buckets for '${providerId}'.`,
          `bucketCount=${updated.rateLimits?.length || 0}`
        ].join("\n")
      };
    }

    if (removeBucket) {
      if (!bucketId) {
        const bucketOptions = buildRateLimitBucketPromptOptions(provider);
        if (bucketOptions.length === 0) {
          return { ok: true, mode: context.mode, exitCode: EXIT_SUCCESS, data: `Provider '${providerId}' has no rate-limit buckets.` };
        }
        bucketId = await context.prompts.select({
          message: `Remove rate-limit bucket from ${providerId}`,
          options: bucketOptions
        });
      }
    } else if (!hasRateLimitsArg) {
      if (!bucketId && !bucketName) {
        bucketName = await context.prompts.text({
          message: "Bucket name",
          required: true,
          placeholder: "Minute cap",
          validate: (value) => sanitizeRateLimitBucketName(value) ? undefined : "Bucket name is required."
        });
      }

      if (!modelsInput) {
        const providerModelIds = dedupeList((provider.models || []).map((model) => model.id));
        const initialScope = String(modelsInput || "").trim().toLowerCase() === "all" ? "all" : "selected";
        const modelScope = await context.prompts.select({
          message: "Bucket model scope",
          options: [
            { value: "all", label: "All models" },
            { value: "selected", label: "Selected models" }
          ],
          initialValue: initialScope
        });
        if (modelScope === "all") {
          modelsInput = "all";
        } else if (providerModelIds.length === 0) {
          return {
            ok: false,
            mode: context.mode,
            exitCode: EXIT_VALIDATION,
            errorMessage: `Provider '${providerId}' has no models to select.`
          };
        } else {
          modelsInput = await context.prompts.multiselect({
            message: `Choose models for ${providerId}`,
            options: providerModelIds.map((modelId) => ({
              value: modelId,
              label: modelId
            })),
            required: true
          });
        }
      }

      if (!requestsInput) {
        requestsInput = await context.prompts.text({
          message: "Request cap",
          required: true,
          placeholder: "40",
          validate: (value) => {
            const parsed = Number.parseInt(String(value ?? ""), 10);
            return Number.isFinite(parsed) && parsed > 0 ? undefined : "Enter a positive integer.";
          }
        });
      }

      if (!windowInput) {
        const windowUnit = await context.prompts.select({
          message: "Window unit",
          options: buildRateLimitWindowUnitOptions("minute"),
          initialValue: "minute"
        });
        let windowSize = 1;
        if (windowUnit === "hour") {
          const sizeInput = await context.prompts.text({
            message: "How many hours?",
            required: true,
            placeholder: "6",
            validate: (value) => {
              const parsed = Number.parseInt(String(value ?? ""), 10);
              return Number.isFinite(parsed) && parsed > 0 ? undefined : "Enter a positive integer.";
            }
          });
          windowSize = Number.parseInt(String(sizeInput), 10);
        }
        windowInput = `${windowUnit}:${windowSize}`;
      }
    }
  }

  if (!providerId) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "provider-id is required."
    };
  }

  if (removeBucket) {
    if (!bucketId) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: "bucket-id is required when remove-bucket=true."
      };
    }

    const removed = setProviderRateLimitsInConfig(config, {
      providerId,
      removeBucketId: bucketId
    });
    if (!removed.changed) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: removed.reason
      };
    }
    await writeConfigFile(removed.config, configPath);
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: `Removed rate-limit bucket '${bucketId}' from '${providerId}'.`
    };
  }

  let buckets = parsedRateLimitBuckets;
  if (!hasRateLimitsArg) {
    const window = parseRateLimitWindowInput(windowInput);
    const requests = Number.parseInt(String(requestsInput ?? ""), 10);
    const models = parseRateLimitModelSelectorsInput(modelsInput);
    if ((!bucketId && !bucketName) || !Number.isFinite(requests) || requests <= 0 || !window || models.length === 0) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: "bucket-id or bucket-name, models, requests, and valid window are required. Example: --bucket-window=month:1"
      };
    }
    buckets = [{
      ...(bucketId ? { id: bucketId } : {}),
      ...(bucketName ? { name: bucketName } : {}),
      models,
      requests,
      window
    }];
  }

  const updated = setProviderRateLimitsInConfig(config, {
    providerId,
    buckets,
    replaceBuckets
  });
  if (!updated.changed && updated.reason) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: updated.reason
    };
  }

  await writeConfigFile(updated.config, configPath);
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: [
      `Updated rate-limit buckets for '${providerId}'.`,
      `bucketCount=${updated.rateLimits?.length || 0}`
    ].join("\n")
  };
}

async function doSetMasterKey(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  let masterKey = String(readArg(args, ["master-key", "masterKey"], "") || "");
  const generateMasterKey = toBoolean(readArg(args, ["generate-master-key", "generateMasterKey"], false), false);
  const generatedLength = readArg(args, ["master-key-length", "masterKeyLength"], DEFAULT_GENERATED_MASTER_KEY_LENGTH);
  const generatedPrefix = readArg(args, ["master-key-prefix", "masterKeyPrefix"], "gw_");
  let keyGenerated = false;

  if (!masterKey && generateMasterKey) {
    masterKey = generateStrongMasterKey({ length: generatedLength, prefix: generatedPrefix });
    keyGenerated = true;
  }

  if (canPrompt() && !masterKey) {
    const autoGenerate = await context.prompts.confirm({
      message: "Generate a strong master key automatically?",
      initialValue: true
    });
    if (autoGenerate) {
      masterKey = generateStrongMasterKey({
        length: generatedLength,
        prefix: generatedPrefix
      });
      keyGenerated = true;
    } else {
      masterKey = await context.prompts.text({
        message: "Worker master key",
        required: true
      });
    }
  }

  if (!masterKey) {
    return { ok: false, mode: context.mode, exitCode: EXIT_VALIDATION, errorMessage: "master-key is required." };
  }

  const next = setMasterKeyInConfig(config, masterKey);
  await writeConfigFile(next, configPath);
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: [
      `Updated master key in ${configPath} (${maskSecret(masterKey)}).`,
      keyGenerated ? `Generated key (copy now): ${masterKey}` : ""
    ].filter(Boolean).join("\n")
  };
}

async function doStartupInstall(context) {
  const configPath = readArg(context.args, ["config", "configPath"], getDefaultConfigPath());
  const host = String(readArg(context.args, ["host"], "127.0.0.1"));
  const port = toNumber(readArg(context.args, ["port"]), 8787);
  const watchConfig = toBoolean(readArg(context.args, ["watch-config", "watchConfig"], true), true);
  const watchBinary = toBoolean(readArg(context.args, ["watch-binary", "watchBinary"], true), true);
  const requireAuth = toBoolean(readArg(context.args, ["require-auth", "requireAuth"], false), false);

  if (!(await configFileExists(configPath))) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `Config not found at ${configPath}. Run 'llm-router config' first.`
    };
  }

  const config = await readConfigFile(configPath);
  if (!configHasProvider(config)) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `No providers configured in ${configPath}. Run 'llm-router config'.`
    };
  }
  if (requireAuth && !config.masterKey) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `Local auth requires masterKey in ${configPath}. Run 'llm-router config --operation=set-master-key' first.`
    };
  }

  if (canPrompt()) {
    const confirm = await context.prompts.confirm({
      message: `Install llm-router startup service on ${process.platform}?`,
      initialValue: true
    });
    if (!confirm) {
      return { ok: false, mode: context.mode, exitCode: EXIT_FAILURE, errorMessage: "Cancelled." };
    }
  }

  const result = await installStartup({ configPath, host, port, watchConfig, watchBinary, requireAuth });
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: [
      `Installed OS startup (${result.manager})`,
      `service=${result.serviceId}`,
      `file=${result.filePath}`,
      `start target=http://${host}:${port}`,
      `binary watch=${watchBinary ? "enabled" : "disabled"}`,
      `local auth=${requireAuth ? "required (masterKey)" : "disabled"}`
    ].join("\n")
  };
}

async function doStartupUninstall(context) {
  if (canPrompt()) {
    const confirm = await context.prompts.confirm({
      message: "Uninstall llm-router OS startup service?",
      initialValue: false
    });
    if (!confirm) {
      return { ok: false, mode: context.mode, exitCode: EXIT_FAILURE, errorMessage: "Cancelled." };
    }
  }

  const result = await uninstallStartup();
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: [
      `Uninstalled OS startup (${result.manager})`,
      `service=${result.serviceId}`,
      `file=${result.filePath}`
    ].join("\n")
  };
}

async function doStartupStatus(context) {
  const status = await startupStatus();
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: [
      `manager=${status.manager}`,
      `service=${status.serviceId}`,
      `installed=${status.installed}`,
      `running=${status.running}`,
      status.filePath ? `file=${status.filePath}` : "",
      status.detail ? `detail=${String(status.detail).trim()}` : ""
    ].filter(Boolean).join("\n")
  };
}

async function resolveConfigOperation(context) {
  const opArg = String(readArg(context.args, ["operation", "op"], "") || "").trim();
  if (opArg) return opArg;

  if (canPrompt()) {
    return context.prompts.select({
      message: "Config operation",
      options: [
        { value: "upsert-provider", label: "Add/Edit provider" },
        { value: "remove-provider", label: "Remove provider" },
        { value: "remove-model", label: "Remove model from provider" },
        { value: "upsert-model-alias", label: "Add/Edit model alias" },
        { value: "remove-model-alias", label: "Remove model alias" },
        { value: "set-provider-rate-limits", label: "Manage provider rate-limit buckets" },
        { value: "set-model-fallbacks", label: "Set model silent-fallbacks" },
        { value: "set-master-key", label: "Set worker master key" },
        { value: "migrate-config", label: "Migrate config schema version" },
        { value: "list", label: "Show config summary" },
        { value: "list-routing", label: "Show routing summary" },
        { value: "startup-install", label: "Install OS startup" },
        { value: "startup-status", label: "Show OS startup status" },
        { value: "startup-uninstall", label: "Uninstall OS startup" }
      ]
    });
  }

  return "list";
}

async function runConfigAction(context) {
  const op = await resolveConfigOperation(context);

  switch (op) {
    case "upsert-provider":
    case "add-provider":
    case "edit-provider":
      return doUpsertProvider(context);
    case "remove-provider":
      return doRemoveProvider(context);
    case "remove-model":
      return doRemoveModel(context);
    case "upsert-model-alias":
    case "set-model-alias":
      return doUpsertModelAlias(context);
    case "remove-model-alias":
      return doRemoveModelAlias(context);
    case "set-provider-rate-limits":
    case "set-rate-limits":
      return doSetProviderRateLimits(context);
    case "set-model-fallbacks":
    case "set-model-fallback":
      return doSetModelFallbacks(context);
    case "set-master-key":
      return doSetMasterKey(context);
    case "migrate-config":
      return doMigrateConfig(context);
    case "list":
      return doListConfig(context);
    case "list-routing":
      return doListRouting(context);
    case "startup-install":
      return doStartupInstall(context);
    case "startup-uninstall":
      return doStartupUninstall(context);
    case "startup-status":
      return doStartupStatus(context);
    default:
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: `Unknown config operation '${op}'.`
      };
  }
}

async function runStartAction(context) {
  const args = context.args || {};
  const result = await runStartCommand({
    configPath: readArg(args, ["config", "configPath"], getDefaultConfigPath()),
    host: String(readArg(args, ["host"], "127.0.0.1")),
    port: toNumber(readArg(args, ["port"]), 8787),
    watchConfig: toBoolean(readArg(args, ["watch-config", "watchConfig"], true), true),
    watchBinary: toBoolean(readArg(args, ["watch-binary", "watchBinary"], true), true),
    requireAuth: toBoolean(readArg(args, ["require-auth", "requireAuth"], false), false),
    cliPathForWatch: process.argv[1],
    onLine: (line) => context.terminal.line(line),
    onError: (line) => context.terminal.error(line)
  });

  return {
    ok: result.ok,
    mode: context.mode,
    exitCode: result.exitCode,
    data: result.data,
    errorMessage: result.errorMessage
  };
}

async function runStopAction(context) {
  let stopped;
  try {
    stopped = await stopRunningInstance();
  } catch (error) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: `Failed to stop llm-router: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!stopped.ok) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: stopped.reason || "Failed to stop llm-router."
    };
  }

  if (stopped.mode === "startup") {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: [
        "Stopped startup-managed llm-router instance.",
        `manager=${stopped.detail?.manager || "unknown"}`,
        `service=${stopped.detail?.serviceId || "unknown"}`
      ].join("\n")
    };
  }

  if (stopped.mode === "manual") {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: `Stopped llm-router process pid=${stopped.detail?.pid || "unknown"} (${stopped.detail?.signal || "SIGTERM"}).`
    };
  }

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: "No running llm-router instance found."
  };
}

async function runReloadAction(context) {
  let result;
  try {
    result = await reloadRunningInstance({
      terminalLine: (line) => context.terminal.line(line),
      terminalError: (line) => context.terminal.error(line),
      runDetachedForManual: false
    });
  } catch (error) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: `Failed to reload llm-router: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!result.ok && result.mode !== "manual-inline") {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: result.reason || "Failed to reload llm-router."
    };
  }

  if (result.mode === "startup") {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: [
        "Restarted startup-managed llm-router instance.",
        `manager=${result.detail?.manager || "unknown"}`,
        `service=${result.detail?.serviceId || "unknown"}`
      ].join("\n")
    };
  }

  if (result.mode === "manual-inline") {
    return {
      ok: result.detail?.ok === true,
      mode: context.mode,
      exitCode: result.detail?.exitCode ?? (result.detail?.ok ? EXIT_SUCCESS : EXIT_FAILURE),
      data: result.detail?.data,
      errorMessage: result.detail?.errorMessage || (result.detail?.ok ? undefined : "Failed to restart llm-router.")
    };
  }

  return {
    ok: false,
    mode: context.mode,
    exitCode: EXIT_FAILURE,
    errorMessage: result.reason || "No running llm-router instance detected."
  };
}

async function runUpdateAction(context) {
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : console.log;
  line(`Updating ${NPM_PACKAGE_NAME} to latest with npm...`);

  const updateResult = runNpmInstallLatest(NPM_PACKAGE_NAME);
  if (!updateResult.ok) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: [
        `Failed to update ${NPM_PACKAGE_NAME}.`,
        updateResult.error ? String(updateResult.error) : "",
        updateResult.stderr || updateResult.stdout
      ].filter(Boolean).join("\n")
    };
  }

  let reloadResult;
  try {
    reloadResult = await reloadRunningInstance({
      runDetachedForManual: true
    });
  } catch (error) {
    reloadResult = {
      ok: false,
      mode: "error",
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  const details = [`Updated ${NPM_PACKAGE_NAME} successfully.`];
  if (reloadResult.ok && reloadResult.mode === "startup") {
    details.push("Detected startup-managed running instance and restarted it.");
  } else if (reloadResult.ok && reloadResult.mode === "manual-detached") {
    details.push(`Detected running terminal instance and restarted it in background (pid ${reloadResult.detail?.pid || "unknown"}).`);
  } else if (reloadResult.mode === "none") {
    details.push("No running instance detected; update applied for next start.");
  } else if (!reloadResult.ok) {
    details.push(`Update succeeded but auto-reload failed: ${reloadResult.reason || "unknown error"}`);
  }

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: details.join("\n")
  };
}

function toHomeRelativePath(value) {
  const input = String(value || "").trim();
  const home = String(process.env.HOME || "").trim();
  if (!input || !home) return input;
  if (!input.startsWith(`${home}/`)) return input;
  return `~${input.slice(home.length)}`;
}

function collectEnabledModelRefsFromConfig(config) {
  const providers = (config?.providers || []).filter((provider) => provider && provider.enabled !== false);
  const refs = [];
  for (const provider of providers) {
    const providerId = String(provider?.id || "").trim();
    if (!providerId) continue;
    for (const model of (provider.models || [])) {
      if (!model || model.enabled === false) continue;
      const modelId = String(model.id || "").trim();
      if (!modelId) continue;
      refs.push(`${providerId}/${modelId}`);
    }
  }
  return dedupeList(refs);
}

function quoteShellSingle(value) {
  return `'${String(value || "").replace(/'/g, "'\"'\"'")}'`;
}

function buildCurlGuideCommand(url, {
  method = "GET",
  headers = [],
  jsonBody
} = {}) {
  const parts = ["curl -sS"];
  if (String(method || "").toUpperCase() !== "GET") {
    parts.push(`-X ${String(method || "").toUpperCase()}`);
  }
  for (const header of headers) {
    parts.push(`-H ${quoteShellSingle(header)}`);
  }
  if (jsonBody !== undefined) {
    parts.push("-H 'content-type: application/json'");
    parts.push(`--data ${quoteShellSingle(JSON.stringify(jsonBody))}`);
  }
  parts.push(quoteShellSingle(url));
  return parts.join(" ");
}

async function runGatewayHttpProbe({
  url,
  method = "GET",
  headers = {},
  jsonBody,
  timeoutMs = DEFAULT_AI_HELP_GATEWAY_TEST_TIMEOUT_MS
} = {}) {
  const requestHeaders = { ...(headers || {}) };
  const requestInit = {
    method: String(method || "GET").toUpperCase(),
    headers: requestHeaders
  };

  if (jsonBody !== undefined) {
    if (!requestHeaders["content-type"] && !requestHeaders["Content-Type"]) {
      requestHeaders["content-type"] = "application/json";
    }
    requestInit.body = JSON.stringify(jsonBody);
  }

  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    requestInit.signal = AbortSignal.timeout(timeoutMs);
  }

  try {
    const response = await fetch(url, requestInit);
    const rawText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      payload: parseJsonSafely(rawText),
      rawText: String(rawText || "").trim().slice(0, 280)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      rawText: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function summarizeProbeMessage(probe) {
  if (!probe) return "";
  if (probe.error) return String(probe.error);
  const payloadError = probe.payload?.error;
  if (typeof payloadError === "string") return payloadError.trim();
  if (payloadError && typeof payloadError === "object") {
    if (payloadError.message) return String(payloadError.message).trim();
    if (payloadError.type) return String(payloadError.type).trim();
  }
  if (probe.rawText) return String(probe.rawText).trim().slice(0, 140);
  return "";
}

function formatProbeStatusLabel(probe, {
  passStatuses = [200],
  passWhenStatusIsNot = null
} = {}) {
  if (!probe) return "not-run";
  if (probe.error) return `error (${probe.error})`;
  const status = Number(probe.status || 0);
  const isPass = passWhenStatusIsNot !== null
    ? status !== passWhenStatusIsNot
    : passStatuses.includes(status);
  const message = summarizeProbeMessage(probe);
  if (message) return `${isPass ? "pass" : "fail"} (status=${status}; ${message})`;
  return `${isPass ? "pass" : "fail"} (status=${status})`;
}

async function runAiHelpGatewayLiveTests({
  runtimeState,
  authToken = "",
  probeModel = "",
  timeoutMs = DEFAULT_AI_HELP_GATEWAY_TEST_TIMEOUT_MS
} = {}) {
  if (!runtimeState) {
    return {
      ran: false,
      reason: "local-server-not-running",
      baseUrl: "",
      tests: {}
    };
  }

  const baseUrl = `http://${runtimeState.host}:${runtimeState.port}`;
  const token = String(authToken || "").trim();
  const headers = token
    ? {
        Authorization: `Bearer ${token}`,
        "x-api-key": token
      }
    : {};

  const modelId = String(probeModel || "").trim() || "chat.default";
  const [health, openaiModels, claudeModels, codexResponses] = await Promise.all([
    runGatewayHttpProbe({
      url: `${baseUrl}/health`,
      method: "GET",
      headers,
      timeoutMs
    }),
    runGatewayHttpProbe({
      url: `${baseUrl}/openai/v1/models`,
      method: "GET",
      headers,
      timeoutMs
    }),
    runGatewayHttpProbe({
      url: `${baseUrl}/anthropic/v1/models`,
      method: "GET",
      headers,
      timeoutMs
    }),
    runGatewayHttpProbe({
      url: `${baseUrl}/openai/v1/responses`,
      method: "POST",
      headers,
      jsonBody: {
        model: modelId,
        input: "ping"
      },
      timeoutMs
    })
  ]);

  return {
    ran: true,
    reason: "completed",
    baseUrl,
    tests: {
      health,
      openaiModels,
      claudeModels,
      codexResponses
    }
  };
}

async function runAiHelpAction(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const skipLiveTest = toBoolean(readArg(args, ["skip-live-test", "skipLiveTest"], false), false);
  const liveTestTimeoutMs = toPositiveInteger(
    readArg(args, ["live-test-timeout-ms", "liveTestTimeoutMs"], DEFAULT_AI_HELP_GATEWAY_TEST_TIMEOUT_MS),
    DEFAULT_AI_HELP_GATEWAY_TEST_TIMEOUT_MS,
    { min: 500, max: 60_000 }
  );
  const explicitGatewayAuthToken = String(readArg(args, ["gateway-auth-token", "gatewayAuthToken"], "") || "").trim();
  const config = await readConfigFile(configPath);

  const providers = (config.providers || []).filter((provider) => provider && provider.enabled !== false);
  const providerCount = providers.length;
  const modelCount = providers.reduce((sum, provider) => {
    const count = (provider.models || []).filter((model) => model && model.enabled !== false).length;
    return sum + count;
  }, 0);

  const aliasEntries = Object.entries(config.modelAliases || {});
  const aliasCount = aliasEntries.length;
  const aliasStrategySummary = aliasEntries
    .map(([aliasId, alias]) => `${aliasId}:${alias?.strategy || "ordered"}`)
    .join(", ") || "(none)";
  const rateLimitBucketCount = providers.reduce((sum, provider) => sum + (provider.rateLimits || []).length, 0);
  const defaultModel = String(config.defaultModel || "smart");
  const hasMasterKey = Boolean(String(config.masterKey || "").trim());

  let runtimeState = null;
  try {
    runtimeState = await getActiveRuntimeState();
  } catch {
    runtimeState = null;
  }
  const serverRunning = Boolean(runtimeState);
  const runtimeRequiresAuth = Boolean(runtimeState?.requireAuth);

  let runtimeConfig = null;
  const runtimeConfigPath = String(runtimeState?.configPath || "").trim();
  if (runtimeConfigPath && runtimeConfigPath !== configPath) {
    try {
      runtimeConfig = await readConfigFile(runtimeConfigPath);
    } catch {
      runtimeConfig = null;
    }
  }

  const runtimeMasterKey = String(runtimeConfig?.masterKey || "").trim();
  const gatewayAuthToken = explicitGatewayAuthToken
    || (runtimeConfigPath && runtimeConfigPath !== configPath ? runtimeMasterKey : "")
    || String(config.masterKey || "").trim()
    || runtimeMasterKey;

  const directModelRefs = collectEnabledModelRefsFromConfig(config);
  const aliasIds = aliasEntries.map(([aliasId]) => aliasId);
  const modelDecisionOptions = dedupeList([
    defaultModel && defaultModel !== "smart" ? defaultModel : "",
    ...aliasIds,
    ...directModelRefs
  ]);
  const probeModel = modelDecisionOptions[0] || "chat.default";

  let liveTest = {
    ran: false,
    reason: skipLiveTest ? "skipped-by-flag" : "local-server-not-running",
    baseUrl: serverRunning ? `http://${runtimeState.host}:${runtimeState.port}` : "",
    tests: {}
  };
  if (!skipLiveTest && serverRunning) {
    liveTest = await runAiHelpGatewayLiveTests({
      runtimeState,
      authToken: gatewayAuthToken,
      probeModel,
      timeoutMs: liveTestTimeoutMs
    });
  }

  const healthProbe = liveTest.tests?.health || null;
  const openaiModelsProbe = liveTest.tests?.openaiModels || null;
  const claudeModelsProbe = liveTest.tests?.claudeModels || null;
  const codexResponsesProbe = liveTest.tests?.codexResponses || null;

  const claudePatchGate = !liveTest.ran
    ? "pending-live-test"
    : (claudeModelsProbe?.status === 200 ? "ready" : "blocked");
  const openCodePatchGate = !liveTest.ran
    ? "pending-live-test"
    : (openaiModelsProbe?.status === 200 ? "ready" : "blocked");
  let codexPatchGate = "pending-live-test";
  if (liveTest.ran) {
    if (codexResponsesProbe?.error) {
      codexPatchGate = "blocked";
    } else if (codexResponsesProbe?.status === 404) {
      codexPatchGate = "blocked-responses-endpoint-missing";
    } else if ([401, 403].includes(Number(codexResponsesProbe?.status || 0))) {
      codexPatchGate = "blocked-auth";
    } else {
      codexPatchGate = "ready";
    }
  }

  const suggestions = [];
  if (providerCount === 0) {
    suggestions.push("Add first provider with at least one model. Run: llm-router config --operation=upsert-provider --provider-id=<id> --name=\"<name>\" --base-url=<url> --api-key=<key> --models=<model1,model2>");
  } else {
    const providersWithoutModels = providers
      .filter((provider) => (provider.models || []).filter((model) => model && model.enabled !== false).length === 0)
      .map((provider) => provider.id);
    if (providersWithoutModels.length > 0) {
      suggestions.push(`Add models to provider(s) with empty model list: ${providersWithoutModels.join(", ")}. Run: llm-router config --operation=upsert-provider --provider-id=<id> --models=<model1,model2>`);
    }
  }

  if (modelCount > 0 && aliasCount === 0) {
    suggestions.push("Create a model alias/group for stable app routing. Run: llm-router config --operation=upsert-model-alias --alias-id=chat.default --strategy=auto --targets=<provider/model,...>");
  }

  if (aliasCount > 0) {
    const nonAutoAliases = aliasEntries
      .filter(([, alias]) => String(alias?.strategy || "ordered") !== "auto")
      .map(([aliasId]) => aliasId);
    if (nonAutoAliases.length > 0) {
      suggestions.push(`Review load-balancer strategy for alias(es): ${nonAutoAliases.join(", ")}. Recommended default: auto.`);
    }
  }

  if (providerCount > 0 && rateLimitBucketCount === 0) {
    suggestions.push("Add at least one provider rate-limit bucket for quota safety. Run: llm-router config --operation=set-provider-rate-limits --provider-id=<id> --bucket-name=\"Monthly cap\" --bucket-models=all --bucket-requests=<n> --bucket-window=month:1");
  }

  if (!hasMasterKey) {
    suggestions.push("Set master key for authenticated access. Run: llm-router config --operation=set-master-key --generate-master-key=true");
  }

  if (!serverRunning) {
    suggestions.push(`Start local proxy server. Run: llm-router start${hasMasterKey ? " --require-auth=true" : ""}`);
  } else {
    suggestions.push(`Local proxy is running on http://${runtimeState.host}:${runtimeState.port}. Apply config changes with llm-router config; updates hot-reload automatically.`);
  }

  if (serverRunning && skipLiveTest) {
    suggestions.push("Run live llm-router API test before patching coding-tool config. Re-run: llm-router ai-help --skip-live-test=false");
  }

  if (liveTest.ran && claudePatchGate !== "ready") {
    suggestions.push("Claude/OpenCode patch gate is blocked. Fix llm-router auth/provider/model readiness, then re-run llm-router ai-help.");
  }
  if (liveTest.ran && codexPatchGate === "blocked-responses-endpoint-missing") {
    suggestions.push("Codex CLI requires OpenAI Responses API. Current llm-router endpoint does not expose /openai/v1/responses; do not patch Codex until this gate is resolved.");
  }

  if (suggestions.length === 0) {
    suggestions.push("No blocking setup gaps detected. Review routing summary with: llm-router config --operation=list-routing");
  }

  const runtimeConfigPathForDisplay = runtimeConfigPath ? toHomeRelativePath(runtimeConfigPath) : "";
  const gatewayBaseUrlForGuide = liveTest.baseUrl || (serverRunning ? `http://${runtimeState.host}:${runtimeState.port}` : "http://127.0.0.1:8787");
  const authGuideHeaders = runtimeRequiresAuth ? ["Authorization: Bearer <master_key>"] : [];

  const lines = [
    "# AI-HELP",
    "ENTITY: llm-router",
    "MODE: cli-automation",
    "PROFILE: agent-guide-v2",
    "",
    "## INTRO",
    "Use this output as an AI-agent operating brief for llm-router.",
    "The agent should auto-discover commands, inspect current state, configure llm-router on your behalf, run live API gates, and only then patch coding tool configs.",
    "",
    "## WHAT AGENT CAN DO WITH LLM-ROUTER",
    "- explain llm-router capabilities and current setup readiness",
    "- set provider, model list, model alias/group, and rate-limit buckets via CLI",
    "- validate local llm-router endpoint health/model-list/routes with real API probes",
    "- patch coding tools (Claude Code, Codex CLI, OpenCode) after pre-patch gates pass",
    "",
    "## DISCOVERY COMMANDS",
    "- llm-router -h",
    "- llm-router config -h",
    "- llm-router start -h",
    "- llm-router deploy -h",
    "",
    "## CURRENT STATE",
    `- config_path=${configPath}`,
    `- providers=${providerCount}`,
    `- models=${modelCount}`,
    `- model_aliases=${aliasCount}`,
    `- alias_strategies=${aliasStrategySummary}`,
    `- rate_limit_buckets=${rateLimitBucketCount}`,
    `- default_model=${defaultModel}`,
    `- master_key_configured=${hasMasterKey}`,
    `- local_server_running=${serverRunning}`,
    serverRunning ? `- local_server_endpoint=http://${runtimeState.host}:${runtimeState.port}` : "",
    runtimeState ? `- local_server_require_auth=${runtimeRequiresAuth}` : "",
    runtimeConfigPathForDisplay ? `- local_server_config_path=${runtimeConfigPathForDisplay}` : "",
    "",
    "## MODEL/GROUP DECISION INPUT (REQUIRED BEFORE PATCHING TOOL CONFIG)",
    "- Ask user to choose target_tool: claude-code | codex-cli | opencode",
    "- Ask user to choose target_model_or_group for that tool",
    `- available_alias_groups=${aliasIds.join(", ") || "(none)"}`,
    `- available_direct_models=${directModelRefs.join(", ") || "(none)"}`,
    `- decision_options_preview=${modelDecisionOptions.slice(0, 12).join(", ") || "(none)"}`,
    "- If user chooses an alias/group, keep alias id unchanged so llm-router balancing still works.",
    "",
    "## PRE-PATCH API GATE (MUST PASS BEFORE EDITING TOOL CONFIG)",
    `- live_test_mode=${skipLiveTest ? "skipped-by-flag" : (liveTest.ran ? "executed" : "pending-local-server")}`,
    `- live_test_timeout_ms=${liveTestTimeoutMs}`,
    `- gateway_base_url=${gatewayBaseUrlForGuide}`,
    `- health_probe=${liveTest.ran ? formatProbeStatusLabel(healthProbe, { passStatuses: [200] }) : "not-run"}`,
    `- openai_models_probe=${liveTest.ran ? formatProbeStatusLabel(openaiModelsProbe, { passStatuses: [200] }) : "not-run"}`,
    `- claude_models_probe=${liveTest.ran ? formatProbeStatusLabel(claudeModelsProbe, { passStatuses: [200] }) : "not-run"}`,
    `- codex_responses_probe=${liveTest.ran ? formatProbeStatusLabel(codexResponsesProbe, { passWhenStatusIsNot: 404 }) : "not-run"}`,
    `- patch_gate_claude_code=${claudePatchGate}`,
    `- patch_gate_opencode=${openCodePatchGate}`,
    `- patch_gate_codex_cli=${codexPatchGate}`,
    "- Rule: Do NOT patch any coding-tool config until required gate is ready.",
    "",
    "## LIVE TEST COMMANDS (RUN BEFORE PATCHING TOOL CONFIG)",
    runtimeRequiresAuth ? "- export LLM_ROUTER_MASTER_KEY='<master_key>'" : "- Local auth currently disabled; auth header is optional.",
    `- ${buildCurlGuideCommand(`${gatewayBaseUrlForGuide}/health`, { method: "GET", headers: authGuideHeaders })}`,
    `- ${buildCurlGuideCommand(`${gatewayBaseUrlForGuide}/openai/v1/models`, { method: "GET", headers: authGuideHeaders })}`,
    `- ${buildCurlGuideCommand(`${gatewayBaseUrlForGuide}/anthropic/v1/models`, { method: "GET", headers: authGuideHeaders })}`,
    `- ${buildCurlGuideCommand(`${gatewayBaseUrlForGuide}/openai/v1/responses`, {
      method: "POST",
      headers: authGuideHeaders,
      jsonBody: { model: "<target_model_or_group>", input: "ping" }
    })}  # required for Codex CLI compatibility`,
    "",
    "## LLM-ROUTER CONFIG WORKFLOWS (CLI)",
    "1. Upsert provider + models:",
    "   llm-router config --operation=upsert-provider --provider-id=<id> --name=\"<name>\" --endpoints=<url1,url2> --api-key=<key> --models=<model1,model2>",
    "2. Upsert model alias/group:",
    "   llm-router config --operation=upsert-model-alias --alias-id=<alias> --strategy=auto --targets=<provider/model,...>",
    "3. Set provider rate limit bucket:",
    "   llm-router config --operation=set-provider-rate-limits --provider-id=<id> --bucket-name=\"Monthly cap\" --bucket-models=all --bucket-requests=<n> --bucket-window=month:1",
    "4. Review final routing summary:",
    "   llm-router config --operation=list-routing",
    "",
    "## CODING TOOL PATCH PLAYBOOK",
    "### Claude Code",
    "- patch_target_priority=.claude/settings.local.json (project) -> ~/.claude/settings.json (user)",
    "- required_gate=patch_gate_claude_code=ready",
    "- set env keys: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL",
    "```json",
    "{",
    "  \"env\": {",
    `    \"ANTHROPIC_BASE_URL\": \"${gatewayBaseUrlForGuide}/anthropic\",`,
    "    \"ANTHROPIC_AUTH_TOKEN\": \"<master_key>\",",
    "    \"ANTHROPIC_MODEL\": \"<target_model_or_group>\"",
    "  }",
    "}",
    "```",
    "",
    "### Codex CLI",
    "- patch_target_priority=.codex/config.toml (project) -> ~/.codex/config.toml (user)",
    "- required_gate=patch_gate_codex_cli=ready",
    "- hard requirement: Codex uses OpenAI Responses API; /openai/v1/responses must be reachable",
    "```toml",
    "model_provider = \"llm_router\"",
    "model = \"<target_model_or_group>\"",
    "",
    "[model_providers.llm_router]",
    "name = \"llm-router\"",
    `base_url = \"${gatewayBaseUrlForGuide}/openai/v1\"`,
    "wire_api = \"responses\"",
    "env_http_headers = { Authorization = \"LLM_ROUTER_AUTH_HEADER\" }",
    "```",
    "- export env before launching Codex: export LLM_ROUTER_AUTH_HEADER='Bearer <master_key>'",
    "",
    "### OpenCode",
    "- patch_target_priority=./opencode.json (project) -> ~/.config/opencode/opencode.json (user)",
    "- required_gate=patch_gate_opencode=ready",
    "```json",
    "{",
    "  \"model\": \"<target_model_or_group>\",",
    "  \"small_model\": \"<target_model_or_group>\",",
    "  \"provider\": {",
    "    \"llm-router\": {",
    "      \"options\": {",
    `        \"baseURL\": \"${gatewayBaseUrlForGuide}/openai\",`,
    "        \"apiKey\": \"<master_key>\"",
    "      }",
    "    }",
    "  }",
    "}",
    "```",
    "",
    "## NEXT SUGGESTIONS",
    ...suggestions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## UPDATE RULE",
    "When local server is running, llm-router config changes are hot-reloaded in memory (no manual restart required).",
    "Agent policy: always run live API gate checks first, then patch tool configs only after gate status is ready."
  ].filter(Boolean);

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: lines.join("\n")
  };
}

async function runDeployAction(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const projectDir = path.resolve(readArg(args, ["project-dir", "projectDir"], process.cwd()));
  const dryRun = toBoolean(readArg(args, ["dry-run", "dryRun"], false), false);
  const exportOnly = toBoolean(readArg(args, ["export-only", "exportOnly"], false), false);
  const generateMasterKey = toBoolean(readArg(args, ["generate-master-key", "generateMasterKey"], false), false);
  const generatedLength = readArg(args, ["master-key-length", "masterKeyLength"], DEFAULT_GENERATED_MASTER_KEY_LENGTH);
  const generatedPrefix = readArg(args, ["master-key-prefix", "masterKeyPrefix"], "gw_");
  let allowWeakMasterKey = toBoolean(readArg(args, ["allow-weak-master-key", "allowWeakMasterKey"], false), false);
  const allowLargeConfig = toBoolean(readArg(args, ["allow-large-config", "allowLargeConfig"], false), false);
  const outPath = String(readArg(args, ["out", "output"], "") || "");
  const cfEnv = String(readArg(args, ["env"], "") || "");
  const argAccountId = String(readArg(args, ["account-id", "accountId"], "") || "").trim();
  let masterKey = String(readArg(args, ["master-key", "masterKey"], "") || "");
  let generatedDeployMasterKey = false;
  let wranglerTargetMessage = "";
  const requiresCloudflareToken = !dryRun && !exportOnly;
  const envToken = resolveCloudflareApiTokenFromEnv(process.env);
  let cloudflareApiToken = envToken.token;
  let cloudflareApiTokenSource = envToken.source;
  const envAccountId = String(process.env?.[CLOUDFLARE_ACCOUNT_ID_ENV_NAME] || "").trim();
  let cloudflareAccountId = argAccountId || envAccountId;
  const line = typeof context?.terminal?.line === "function"
    ? context.terminal.line.bind(context.terminal)
    : console.log;
  let wranglerConfigPath = "";
  let cleanupWranglerConfig = null;
  let deployRoutePattern = "";
  let deployZoneName = "";
  let deployUsesWorkersDev = false;
  const longTaskSpinner = canPrompt() && typeof SnapTui?.createSpinner === "function"
    ? SnapTui.createSpinner()
    : null;
  const withLongTaskSpinner = async (label, fn, { doneMessage = "" } = {}) => {
    if (!longTaskSpinner) {
      line(label);
      const result = await fn();
      if (doneMessage) line(doneMessage);
      return result;
    }

    longTaskSpinner.start(label);
    try {
      const result = await fn();
      longTaskSpinner.stop(doneMessage || `${label} done`);
      return result;
    } catch (error) {
      longTaskSpinner.error("Operation failed");
      throw error;
    }
  };

  try {
    if (requiresCloudflareToken && !cloudflareApiToken) {
      const tokenGuide = buildCloudflareApiTokenSetupGuide();
      if (canPrompt()) {
        line(tokenGuide);
        cloudflareApiToken = await promptSecretInput(context, {
          message: `Cloudflare API token (${CLOUDFLARE_API_TOKEN_ENV_NAME})`,
          required: true,
          validate: validateCloudflareApiTokenInput
        });
        cloudflareApiTokenSource = "prompt";
      } else {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_VALIDATION,
          errorMessage: [
            tokenGuide,
            `Set ${CLOUDFLARE_API_TOKEN_ENV_NAME} and re-run deploy.`
          ].join("\n")
        };
      }
    }

  if (requiresCloudflareToken) {
    let preflight = await withLongTaskSpinner("Verifying Cloudflare API token...", () => preflightCloudflareApiToken(cloudflareApiToken), {
      doneMessage: "Cloudflare API token verified."
    });
    let attempts = 1;
    while (!preflight.ok && canPrompt() && cloudflareApiTokenSource === "prompt" && attempts < 3) {
      const retry = await context.prompts.confirm({
        message: `${preflight.message} Enter a different Cloudflare API token?`,
        initialValue: true
      });
      if (!retry) break;

      cloudflareApiToken = await promptSecretInput(context, {
        message: `Cloudflare API token (${CLOUDFLARE_API_TOKEN_ENV_NAME})`,
        required: true,
        validate: validateCloudflareApiTokenInput
      });
      cloudflareApiTokenSource = "prompt";
      attempts += 1;
      preflight = await withLongTaskSpinner("Re-validating Cloudflare API token...", () => preflightCloudflareApiToken(cloudflareApiToken), {
        doneMessage: "Cloudflare API token re-validated."
      });
    }

    if (!preflight.ok) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: buildCloudflareApiTokenTroubleshooting(preflight.message)
      };
    }

    const availableAccounts = Array.isArray(preflight.memberships) ? preflight.memberships : [];
    if (cloudflareAccountId) {
      const matched = availableAccounts.find((entry) => entry.accountId === cloudflareAccountId);
      if (!matched && availableAccounts.length > 0) {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_VALIDATION,
          errorMessage: [
            `Configured ${CLOUDFLARE_ACCOUNT_ID_ENV_NAME} (${cloudflareAccountId}) is not available for this token.`,
            "Available accounts:",
            ...formatCloudflareAccountOptions(availableAccounts)
          ].join("\n")
        };
      }
    } else if (availableAccounts.length === 1) {
      cloudflareAccountId = availableAccounts[0].accountId;
      line(`Using Cloudflare account ${availableAccounts[0].accountName} (${cloudflareAccountId}) from token memberships.`);
    } else if (availableAccounts.length > 1) {
      if (canPrompt()) {
        const selectedAccount = await context.prompts.select({
          message: "Multiple Cloudflare accounts found. Select account for deploy",
          options: availableAccounts.map((entry) => ({
            value: entry.accountId,
            label: `${entry.accountName} (${entry.accountId})`
          }))
        });
        cloudflareAccountId = String(selectedAccount || "").trim();
      } else {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_VALIDATION,
          errorMessage: [
            "More than one Cloudflare account is available for this token.",
            `Set --account-id=<id> or ${CLOUDFLARE_ACCOUNT_ID_ENV_NAME}=<id>.`,
            "Available accounts:",
            ...formatCloudflareAccountOptions(availableAccounts)
          ].join("\n")
        };
      }
    }

    line(`Cloudflare token preflight passed (${cloudflareApiTokenSource === "prompt" ? "from prompt" : `from ${cloudflareApiTokenSource}`}).`);

    const targetResolution = await prepareWranglerDeployConfig(context, {
      projectDir,
      args,
      cloudflareApiToken,
      cloudflareAccountId,
      wait: withLongTaskSpinner
    });
    if (!targetResolution.ok) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: targetResolution.errorMessage || "Failed to configure wrangler deploy target."
      };
    }
    wranglerConfigPath = String(targetResolution.wranglerConfigPath || "").trim();
    cleanupWranglerConfig = typeof targetResolution.cleanup === "function"
      ? targetResolution.cleanup
      : null;
    wranglerTargetMessage = targetResolution.message || "";
    deployRoutePattern = String(targetResolution.routePattern || "").trim();
    deployZoneName = String(targetResolution.zoneName || "").trim();
    deployUsesWorkersDev = targetResolution.useWorkersDev === true;
  }

  const wranglerEnvOverrides = buildWranglerCloudflareEnv({
    apiToken: cloudflareApiToken,
    accountId: cloudflareAccountId
  });
  const wranglerConfigArgs = wranglerConfigPath ? ["--config", wranglerConfigPath] : [];

  if (canPrompt() && !masterKey) {
    const ask = await context.prompts.confirm({
      message: "Set/override worker master key for this deploy?",
      initialValue: false
    });
    if (ask) {
      masterKey = await context.prompts.text({ message: "Worker master key", required: true });
    }
  }

  const config = await readConfigFile(configPath);
  if (!masterKey && !config.masterKey && generateMasterKey) {
    masterKey = generateStrongMasterKey({
      length: generatedLength,
      prefix: generatedPrefix
    });
    generatedDeployMasterKey = true;
  }

  const effectiveMasterKey = String(masterKey || config.masterKey || "");
  const keyCheck = await ensureStrongWorkerMasterKey(context, effectiveMasterKey, { allowWeakMasterKey });
  if (!keyCheck.ok) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: keyCheck.errorMessage
    };
  }
  allowWeakMasterKey = keyCheck.allowWeakMasterKey === true;

  const payload = buildWorkerConfigPayload(config, { masterKey: effectiveMasterKey });
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const tierReport = payloadBytes > CLOUDFLARE_FREE_SECRET_SIZE_LIMIT_BYTES
    ? detectCloudflareTierViaWrangler(projectDir, cfEnv, cloudflareApiToken, cloudflareAccountId)
    : { tier: "unknown", reason: "size-within-free-limit", signals: [] };
  const mustConfirmLargeConfig = shouldConfirmLargeWorkerConfigDeploy({
    payloadBytes,
    tier: tierReport.tier
  });
  const largeConfigWarningLines = mustConfirmLargeConfig
    ? buildLargeWorkerConfigWarningLines({
      payloadBytes,
      tierReport
    })
    : [];

  if (outPath || exportOnly) {
    const finalOut = outPath || path.resolve(process.cwd(), ".llm-router.worker.json");
    const resolvedOut = path.resolve(finalOut);
    await fsPromises.mkdir(path.dirname(resolvedOut), { recursive: true });
    await fsPromises.writeFile(resolvedOut, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    if (exportOnly) {
      return {
        ok: true,
        mode: context.mode,
        exitCode: EXIT_SUCCESS,
        data: [
          ...largeConfigWarningLines,
          mustConfirmLargeConfig
            ? "Manual deploy may fail on Cloudflare Free tier unless you reduce config size."
            : "",
          `Exported worker config to ${resolvedOut}`,
          `wrangler secret put LLM_ROUTER_CONFIG_JSON${cfEnv ? ` --env ${cfEnv}` : ""} < ${resolvedOut}`
        ].filter(Boolean).join("\n")
      };
    }
  }

  if (dryRun) {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: [
        "Dry run (no deployment executed).",
        allowWeakMasterKey ? "WARNING: weak master key override enabled." : "",
        ...largeConfigWarningLines,
        mustConfirmLargeConfig
          ? "Interactive deploy requires explicit confirmation (default: No)."
          : "",
        mustConfirmLargeConfig
          ? "Use --allow-large-config=true to bypass this check in non-interactive mode."
          : "",
        generatedDeployMasterKey ? "Generated a deploy-time master key (not written to local config)." : "",
        `projectDir=${projectDir}`,
        cloudflareApiTokenSource !== "none"
          ? `cloudflareApiToken=${cloudflareApiTokenSource === "prompt" ? "provided-via-prompt" : `from-${cloudflareApiTokenSource}`}`
          : "",
        cloudflareAccountId ? `cloudflareAccountId=${cloudflareAccountId}` : "",
        `cloudflareTier=${formatCloudflareTierLabel(tierReport)} (${tierReport.reason || "unknown"})`,
        `wrangler${wranglerConfigPath ? ` --config ${wranglerConfigPath}` : ""} secret put LLM_ROUTER_CONFIG_JSON${cfEnv ? ` --env ${cfEnv}` : ""}`,
        `wrangler${wranglerConfigPath ? ` --config ${wranglerConfigPath}` : ""} deploy${cfEnv ? ` --env ${cfEnv}` : ""}`,
        `Payload bytes=${payloadBytes}`
      ].filter(Boolean).join("\n")
    };
  }

  if (mustConfirmLargeConfig && !allowLargeConfig) {
    if (canPrompt()) {
      const proceed = await context.prompts.confirm({
        message: `${largeConfigWarningLines.join(" ")} Continue deploy anyway?`,
        initialValue: false
      });
      if (!proceed) {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_FAILURE,
          errorMessage: "Deployment cancelled because oversized worker config was not confirmed."
        };
      }
    } else {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: [
          ...largeConfigWarningLines,
          "Non-interactive mode requires --allow-large-config=true to continue deployment."
        ].filter(Boolean).join("\n")
      };
    }
  }

  if (canPrompt()) {
    const confirm = await context.prompts.confirm({
      message: `Deploy current config to Cloudflare Worker from ${projectDir}?`,
      initialValue: true
    });
    if (!confirm) {
      return { ok: false, mode: context.mode, exitCode: EXIT_FAILURE, errorMessage: "Deployment cancelled." };
    }
  }

  const deploySpinner = canPrompt() && typeof SnapTui?.createSpinner === "function"
    ? SnapTui.createSpinner()
    : null;
  const withDeploySpinner = async (label, fn, { doneMessage = "" } = {}) => {
    if (!deploySpinner) {
      line(label);
      const result = await fn();
      if (doneMessage) line(doneMessage);
      return result;
    }
    deploySpinner.start(label);
    try {
      const result = await fn();
      deploySpinner.stop(doneMessage || `${label} done`);
      return result;
    } catch (error) {
      deploySpinner.error("Deploy step failed");
      throw error;
    }
  };

  const envArgs = cfEnv ? ["--env", cfEnv] : [];
  const secretResult = await withDeploySpinner("Uploading worker config secret via Wrangler...", () => runWranglerAsync([...wranglerConfigArgs, "secret", "put", "LLM_ROUTER_CONFIG_JSON", ...envArgs], {
    cwd: projectDir,
    input: payloadJson,
    envOverrides: wranglerEnvOverrides
  }), { doneMessage: "Worker config secret uploaded." });
  if (!secretResult.ok) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: [
        "Failed to upload LLM_ROUTER_CONFIG_JSON secret.",
        secretResult.error ? String(secretResult.error) : "",
        secretResult.stderr || secretResult.stdout
      ].filter(Boolean).join("\n")
    };
  }

  const deployResult = await withDeploySpinner("Deploying Cloudflare Worker via Wrangler...", () => runWranglerAsync([...wranglerConfigArgs, "deploy", ...envArgs], {
    cwd: projectDir,
    envOverrides: wranglerEnvOverrides
  }), { doneMessage: "Cloudflare Worker deploy finished." });
  if (!deployResult.ok) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: [
        "Secret uploaded but worker deploy failed.",
        deployResult.error ? String(deployResult.error) : "",
        deployResult.stderr || deployResult.stdout
      ].filter(Boolean).join("\n")
    };
  }

  const deploySummary = [deployResult.stdout, deployResult.stderr].filter(Boolean).join("\n");
  if (hasNoDeployTargets(deploySummary)) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: [
        "Worker upload succeeded, but no deploy target is configured.",
        "Set one deploy target and re-run:",
        "- `--workers-dev=true`, or",
        "- `--route-pattern=router.example.com/* --zone-name=example.com` (or `--domain=router.example.com`).",
        deploySummary.trim()
      ].filter(Boolean).join("\n")
    };
  }

  const deployHost = extractHostnameFromRoutePattern(deployRoutePattern);
  const postDeployGuide = !deployUsesWorkersDev && deployHost
    ? [
      "",
      "Post-deploy checks:",
      `- dig +short ${deployHost} @1.1.1.1`,
      `- curl -I https://${deployHost}/anthropic`,
      `- Claude Code base URL: https://${deployHost}/anthropic (no :8787)`
    ].join("\n")
    : "";

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: [
      "Cloudflare deployment completed.",
      generatedDeployMasterKey ? "Generated a deploy-time master key. Persist it with `llm-router config --operation=set-master-key --master-key=...` if needed." : "",
      wranglerTargetMessage,
      deployZoneName ? `Deploy zone: ${deployZoneName}` : "",
      secretResult.stdout.trim(),
      deployResult.stdout.trim(),
      postDeployGuide
    ].filter(Boolean).join("\n")
  };
  } finally {
    if (typeof cleanupWranglerConfig === "function") {
      try {
        await cleanupWranglerConfig();
      } catch {
        // best-effort cleanup for temporary wrangler config file
      }
    }
  }
}

function parseWranglerSecretListOutput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            return item.name || item.key || item.secret_name || null;
          }
          return null;
        })
        .filter(Boolean);
    }
  } catch {
    // fall through to text parser
  }

  const names = new Set();
  for (const line of trimmed.split(/\r?\n/g)) {
    if (line.includes("LLM_ROUTER_")) {
      for (const match of line.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
        names.add(match[0]);
      }
    }
  }
  return [...names];
}

async function runWorkerKeyAction(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const projectDir = path.resolve(readArg(args, ["project-dir", "projectDir"], process.cwd()));
  const cfEnv = String(readArg(args, ["env"], "") || "");
  const dryRun = toBoolean(readArg(args, ["dry-run", "dryRun"], false), false);
  const useConfigKey = toBoolean(readArg(args, ["use-config-key", "useConfigKey"], true), true);
  const generateMasterKey = toBoolean(readArg(args, ["generate-master-key", "generateMasterKey"], false), false);
  const generatedLength = readArg(args, ["master-key-length", "masterKeyLength"], DEFAULT_GENERATED_MASTER_KEY_LENGTH);
  const generatedPrefix = readArg(args, ["master-key-prefix", "masterKeyPrefix"], "gw_");
  let allowWeakMasterKey = toBoolean(readArg(args, ["allow-weak-master-key", "allowWeakMasterKey"], false), false);
  let masterKey = String(readArg(args, ["master-key", "masterKey"], "") || "");
  let keyGenerated = false;

  if (!masterKey && useConfigKey) {
    try {
      const config = await readConfigFile(configPath);
      masterKey = String(config.masterKey || "");
    } catch {
      // allow prompting/manual input fallback
    }
  }

  if (!masterKey && generateMasterKey) {
    masterKey = generateStrongMasterKey({
      length: generatedLength,
      prefix: generatedPrefix
    });
    keyGenerated = true;
  }

  if (canPrompt() && !masterKey) {
    const autoGenerate = await context.prompts.confirm({
      message: "Generate a strong worker master key automatically?",
      initialValue: true
    });
    if (autoGenerate) {
      masterKey = generateStrongMasterKey({
        length: generatedLength,
        prefix: generatedPrefix
      });
      keyGenerated = true;
    } else {
      masterKey = await context.prompts.text({
        message: "New worker master key (LLM_ROUTER_MASTER_KEY)",
        required: true
      });
    }
  }

  if (!masterKey) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "master-key is required (or set one in local config and use --use-config-key=true)."
    };
  }

  const keyCheck = await ensureStrongWorkerMasterKey(context, masterKey, { allowWeakMasterKey });
  if (!keyCheck.ok) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: keyCheck.errorMessage
    };
  }
  allowWeakMasterKey = keyCheck.allowWeakMasterKey === true;

  const envArgs = cfEnv ? ["--env", cfEnv] : [];
  let exists = null;
  const listResult = runWrangler(["secret", "list", ...envArgs], { cwd: projectDir });
  if (listResult.ok) {
    const secretNames = parseWranglerSecretListOutput(`${listResult.stdout}\n${listResult.stderr}`);
    exists = secretNames.includes("LLM_ROUTER_MASTER_KEY");
  }

  if (dryRun) {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: [
        "Dry run (no secret update executed).",
        allowWeakMasterKey ? "WARNING: weak master key override enabled." : "",
        keyGenerated ? "Generated key for this operation." : "",
        `projectDir=${projectDir}`,
        cfEnv ? `env=${cfEnv}` : "",
        `target=LLM_ROUTER_MASTER_KEY (${exists === null ? "existence unknown" : (exists ? "exists" : "missing")})`,
        `wrangler secret put LLM_ROUTER_MASTER_KEY${cfEnv ? ` --env ${cfEnv}` : ""}`,
        `masterKey=${maskSecret(masterKey)}`
      ].filter(Boolean).join("\n")
    };
  }

  if (canPrompt()) {
    const confirm = await context.prompts.confirm({
      message: `${exists === true ? "Update" : "Set"} LLM_ROUTER_MASTER_KEY on Cloudflare Worker${cfEnv ? ` (${cfEnv})` : ""}?`,
      initialValue: true
    });
    if (!confirm) {
      return { ok: false, mode: context.mode, exitCode: EXIT_FAILURE, errorMessage: "Operation cancelled." };
    }
  }

  const putResult = runWrangler(["secret", "put", "LLM_ROUTER_MASTER_KEY", ...envArgs], {
    cwd: projectDir,
    input: masterKey
  });
  if (!putResult.ok) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: [
        "Failed to create/update LLM_ROUTER_MASTER_KEY secret.",
        putResult.error ? String(putResult.error) : "",
        putResult.stderr || putResult.stdout
      ].filter(Boolean).join("\n")
    };
  }

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: [
      `${exists === true ? "Updated" : "Set"} LLM_ROUTER_MASTER_KEY on Cloudflare Worker.`,
      cfEnv ? `env=${cfEnv}` : "",
      `projectDir=${projectDir}`,
      `masterKey=${maskSecret(masterKey)}`,
      keyGenerated ? `Generated key (copy now): ${masterKey}` : "",
      putResult.stdout.trim()
    ].filter(Boolean).join("\n")
  };
}

const routerModule = {
  moduleId: "router",
  description: "LLM Router local start, config manager, and Cloudflare deploy.",
  actions: [
    {
      actionId: "start",
      description: "Start local llm-router route.",
      tui: { steps: ["start-server"] },
      commandline: { requiredArgs: [], optionalArgs: ["host", "port", "config", "watch-config", "watch-binary", "require-auth"] },
      help: {
        summary: "Start local llm-router on localhost. Hot-reloads config in memory and auto-relaunches after llm-router upgrades.",
        args: [
          { name: "host", required: false, description: "Listen host.", example: "--host=127.0.0.1" },
          { name: "port", required: false, description: "Listen port.", example: "--port=8787" },
          { name: "config", required: false, description: "Path to config file.", example: "--config=~/.llm-router.json" },
          { name: "watch-config", required: false, description: "Hot-reload config in memory without process restart.", example: "--watch-config=true" },
          { name: "watch-binary", required: false, description: "Watch for llm-router upgrades and relaunch the latest version.", example: "--watch-binary=true" },
          { name: "require-auth", required: false, description: "Require local API auth using config.masterKey.", example: "--require-auth=true" }
        ],
        examples: ["llm-router start", "llm-router start --port=8787", "llm-router start --require-auth=true"],
        useCases: [
          {
            name: "run local route",
            description: "Serve Anthropic and OpenAI route endpoints locally.",
            command: "llm-router start"
          }
        ],
        keybindings: ["Ctrl+C stop"]
      },
      run: runStartAction
    },
    {
      actionId: "stop",
      description: "Stop a running llm-router instance (manual or OS startup-managed).",
      tui: { steps: ["stop-instance"] },
      commandline: { requiredArgs: [], optionalArgs: [] },
      help: {
        summary: "Stop a running llm-router instance.",
        args: [],
        examples: ["llm-router stop"],
        useCases: [
          {
            name: "stop instance",
            description: "Stops startup-managed service or running terminal process.",
            command: "llm-router stop"
          }
        ],
        keybindings: []
      },
      run: runStopAction
    },
    {
      actionId: "reload",
      description: "Force restart running llm-router instance.",
      tui: { steps: ["reload-instance"] },
      commandline: { requiredArgs: [], optionalArgs: [] },
      help: {
        summary: "Restart running llm-router: restart startup service or restart terminal instance in current terminal.",
        args: [],
        examples: ["llm-router reload"],
        useCases: [
          {
            name: "force restart",
            description: "Restarts currently running llm-router instance.",
            command: "llm-router reload"
          }
        ],
        keybindings: []
      },
      run: runReloadAction
    },
    {
      actionId: "update",
      description: "Update llm-router global package to latest and reload running instance.",
      tui: { steps: ["npm-install", "reload-running"] },
      commandline: { requiredArgs: [], optionalArgs: [] },
      help: {
        summary: "Run npm global install for latest llm-router and reload any running instance.",
        args: [],
        examples: ["llm-router update"],
        useCases: [
          {
            name: "upgrade cli",
            description: "Installs latest global package and reloads startup/manual running instance.",
            command: "llm-router update"
          }
        ],
        keybindings: []
      },
      run: runUpdateAction
    },
    {
      actionId: "ai-help",
      description: "Print AI-agent guide with llm-router setup workflows, live API gates, and coding-tool patch playbooks.",
      tui: { steps: ["print-ai-help"] },
      commandline: {
        requiredArgs: [],
        optionalArgs: [
          "config",
          "skip-live-test",
          "live-test-timeout-ms",
          "gateway-auth-token"
        ]
      },
      help: {
        summary: "AI guide for setup + operation: state snapshot, provider/alias/rate-limit workflows, live gateway tests, and patch rules for Claude/Codex/OpenCode.",
        args: [
          { name: "config", required: false, description: "Path to config file used for state-aware suggestions.", example: "--config=~/.llm-router.json" },
          { name: "skip-live-test", required: false, description: "Skip live llm-router API probes in ai-help output.", example: "--skip-live-test=true" },
          { name: "live-test-timeout-ms", required: false, description: `HTTP timeout for ai-help live probes (default ${DEFAULT_AI_HELP_GATEWAY_TEST_TIMEOUT_MS}ms).`, example: "--live-test-timeout-ms=8000" },
          { name: "gateway-auth-token", required: false, description: "Override auth token for live probes when runtime config differs from selected --config.", example: "--gateway-auth-token=gw_..." }
        ],
        examples: [
          "llm-router ai-help",
          "llm-router ai-help --config=~/.llm-router.json",
          "llm-router ai-help --skip-live-test=true",
          "llm-router ai-help --live-test-timeout-ms=8000"
        ],
        useCases: [
          {
            name: "agent setup brief",
            description: "Generate a machine-readable operating guide so AI agents can configure llm-router, run pre-patch API gates, and patch tool configs safely.",
            command: "llm-router ai-help"
          }
        ],
        keybindings: []
      },
      run: runAiHelpAction
    },
    {
      actionId: "config",
      description: "Config manager for providers/models/master-key/startup service.",
      tui: { steps: ["select-operation", "execute"] },
      commandline: {
        requiredArgs: [],
        optionalArgs: [
          "operation",
          "op",
          "config",
          "provider-id",
          "name",
          "endpoints",
          "base-url",
          "openai-base-url",
          "claude-base-url",
          "anthropic-base-url",
          "api-key",
          "models",
          "bucket-models",
          "bucket-id",
          "bucket-name",
          "bucket-window",
          "bucket-requests",
          "rate-limits",
          "remove-bucket",
          "replace-rate-limits",
          "alias-id",
          "alias",
          "targets",
          "fallback-targets",
          "clear-fallback-targets",
          "alias-metadata",
          "strategy",
          "format",
          "formats",
          "headers",
          "skip-probe",
          "probe-rpm",
          "probe-requests-per-minute",
          "set-master-key",
          "master-key",
          "generate-master-key",
          "master-key-length",
          "master-key-prefix",
          "target-version",
          "create-backup",
          "backup",
          "model",
          "fallback-models",
          "fallbacks",
          "clear-fallbacks",
          "host",
          "port",
          "watch-config",
          "watch-binary",
          "require-auth"
        ]
      },
      help: {
        summary: "Manage providers, model aliases, rate-limit buckets, master key, and OS startup. TUI by default; commandline via --operation.",
        args: [
          { name: "operation", required: false, description: "Config operation (optional; prompts if omitted).", example: "--operation=upsert-provider" },
          { name: "provider-id", required: false, description: "Provider id (slug/camelCase).", example: "--provider-id=openrouter" },
          { name: "name", required: false, description: "Provider Friendly Name (must be unique; shown in management screen).", example: "--name=OpenRouter Primary" },
          { name: "endpoints", required: false, description: "Provider endpoint candidates for auto-probe (comma/semicolon/space/newline separated; TUI supports multiline paste).", example: "--endpoints=https://ramclouds.me,https://ramclouds.me/v1" },
          { name: "base-url", required: false, description: "Provider base URL.", example: "--base-url=https://openrouter.ai/api/v1" },
          { name: "openai-base-url", required: false, description: "OpenAI endpoint base URL (format-specific override).", example: "--openai-base-url=https://ramclouds.me/v1" },
          { name: "claude-base-url", required: false, description: "Anthropic endpoint base URL (format-specific override).", example: "--claude-base-url=https://ramclouds.me" },
          { name: "api-key", required: false, description: "Provider API key.", example: "--api-key=sk-or-v1-..." },
          { name: "models", required: false, description: "Model list (comma/semicolon/space/newline separated; strips common log/error noise; TUI supports multiline paste).", example: "--models=gpt-4o,claude-3-5-sonnet-latest" },
          { name: "model", required: false, description: "Single model id (used by remove-model).", example: "--model=gpt-4o" },
          { name: "fallback-models", required: false, description: "Qualified fallback models for set-model-fallbacks (comma/semicolon/space separated).", example: "--fallback-models=openrouter/gpt-4o,anthropic/claude-3-7-sonnet" },
          { name: "clear-fallbacks", required: false, description: "Clear all fallback models for set-model-fallbacks.", example: "--clear-fallbacks=true" },
          { name: "alias-id", required: false, description: "Model alias id for upsert/remove alias operations.", example: "--alias-id=chat.default" },
          { name: "strategy", required: false, description: "Model alias routing strategy: auto | ordered | round-robin | weighted-rr | quota-aware-weighted-rr.", example: "--strategy=auto" },
          { name: "targets", required: false, description: "Model alias target list syntax: <ref>@<weight> (comma/semicolon/space/newline separated).", example: "--targets=openrouter/gpt-4o-mini@3,anthropic/claude-3-5-haiku@2" },
          { name: "fallback-targets", required: false, description: "Model alias fallback target list with same syntax as --targets.", example: "--fallback-targets=openrouter/gpt-4o" },
          { name: "clear-fallback-targets", required: false, description: "Clear alias fallback target list.", example: "--clear-fallback-targets=true" },
          { name: "alias-metadata", required: false, description: "Optional alias metadata JSON object.", example: "--alias-metadata={\"owner\":\"router-team\"}" },
          { name: "bucket-id", required: false, description: "Rate-limit bucket id for set-provider-rate-limits.", example: "--bucket-id=openrouter-all-month" },
          { name: "bucket-name", required: false, description: "Friendly bucket name (id auto-generated when --bucket-id is omitted).", example: "--bucket-name=\"Monthly cap\"" },
          { name: "bucket-models", required: false, description: "Bucket model selectors ('all' or comma-separated model ids).", example: "--bucket-models=all" },
          { name: "bucket-requests", required: false, description: "Bucket request cap (positive integer).", example: "--bucket-requests=20000" },
          { name: "bucket-window", required: false, description: "Bucket window syntax: <unit>:<size> or <size><unit>.", example: "--bucket-window=month:1" },
          { name: "remove-bucket", required: false, description: "Remove bucket by --bucket-id in set-provider-rate-limits.", example: "--remove-bucket=true" },
          { name: "replace-rate-limits", required: false, description: "Replace all provider buckets with provided entries.", example: "--replace-rate-limits=true" },
          { name: "rate-limits", required: false, description: "Rate-limit bucket JSON object/array for bulk update.", example: "--rate-limits='[{\"id\":\"or-month\",\"models\":[\"all\"],\"requests\":20000,\"window\":{\"unit\":\"month\",\"size\":1}}]'" },
          { name: "format", required: false, description: "Manual format if probe is skipped.", example: "--format=openai" },
          { name: "headers", required: false, description: "Custom provider headers as JSON object (default User-Agent applied when omitted).", example: "--headers={\"User-Agent\":\"Mozilla/5.0\"}" },
          { name: "skip-probe", required: false, description: "Skip live endpoint/model probe.", example: "--skip-probe=true" },
          { name: "probe-rpm", required: false, description: `Auto-discovery request budget per minute (default ${DEFAULT_PROBE_REQUESTS_PER_MINUTE}).`, example: "--probe-rpm=30" },
          { name: "master-key", required: false, description: "Worker auth token.", example: "--master-key=my-token" },
          { name: "generate-master-key", required: false, description: "Generate a strong master key automatically (set-master-key flow).", example: "--generate-master-key=true" },
          { name: "master-key-length", required: false, description: "Generated master key length (min 24).", example: "--master-key-length=48" },
          { name: "master-key-prefix", required: false, description: "Generated master key prefix.", example: "--master-key-prefix=gw_" },
          { name: "target-version", required: false, description: "For migrate-config: target schema version.", example: "--target-version=2" },
          { name: "create-backup", required: false, description: "For migrate-config: create backup before write.", example: "--create-backup=true" },
          { name: "watch-binary", required: false, description: "For startup-install: detect llm-router upgrades and auto-relaunch under OS startup.", example: "--watch-binary=true" },
          { name: "require-auth", required: false, description: "Require masterKey auth for local start/startup-install.", example: "--require-auth=true" },
          { name: "config", required: false, description: "Path to config file.", example: "--config=~/.llm-router.json" }
        ],
        examples: [
          "llm-router config",
          "llm-router config --operation=upsert-provider --provider-id=ramclouds --name=RamClouds --api-key=sk-... --endpoints=https://ramclouds.me,https://ramclouds.me/v1 --models=claude-opus-4-6-thinking,gpt-5.3-codex",
          "llm-router config --operation=upsert-model-alias --alias-id=chat.default --strategy=auto --targets=openrouter/gpt-4o-mini@3,anthropic/claude-3-5-haiku@2 --fallback-targets=openrouter/gpt-4o",
          "llm-router config --operation=set-provider-rate-limits --provider-id=openrouter --bucket-id=openrouter-all-month --bucket-models=all --bucket-requests=20000 --bucket-window=month:1",
          "llm-router config --operation=set-provider-rate-limits --provider-id=openrouter --bucket-name=\"6-hours cap\" --bucket-models=all --bucket-requests=600 --bucket-window=hour:6",
          "llm-router config --operation=migrate-config --target-version=2 --create-backup=true",
          "llm-router config --operation=set-model-fallbacks --provider-id=openrouter --model=gpt-4o --fallback-models=anthropic/claude-3-7-sonnet,openrouter/gpt-4.1-mini",
          "llm-router config --operation=remove-model --provider-id=openrouter --model=gpt-4o",
          "llm-router config --operation=list-routing",
          "llm-router config --operation=startup-install"
        ],
        useCases: [
          {
            name: "interactive config",
            description: "Add/edit/remove providers and manage startup.",
            command: "llm-router config"
          }
        ],
        keybindings: ["Enter confirm", "Esc cancel"]
      },
      run: runConfigAction
    },
    {
      actionId: "deploy",
      description: "Guide/deploy current config to Cloudflare Worker.",
      tui: { steps: ["validate", "confirm", "deploy"] },
      commandline: {
        requiredArgs: [],
        optionalArgs: [
          "mode",
          "config",
          "project-dir",
          "master-key",
          "account-id",
          "workers-dev",
          "route-pattern",
          "zone-name",
          "domain",
          "generate-master-key",
          "master-key-length",
          "master-key-prefix",
          "allow-weak-master-key",
          "allow-large-config",
          "env",
          "dry-run",
          "export-only",
          "out"
        ]
      },
      help: {
        summary: "Export worker config and/or deploy to Cloudflare Worker with Wrangler.",
        args: [
          { name: "mode", required: false, description: "Optional compatibility flag (ignored).", example: "--mode=run" },
          { name: "config", required: false, description: "Path to config file.", example: "--config=~/.llm-router.json" },
          { name: "project-dir", required: false, description: "Worker project directory (uses wrangler.toml as optional base).", example: "--project-dir=./route" },
          { name: "master-key", required: false, description: "Override master key for deployment payload.", example: "--master-key=prod-token" },
          { name: "account-id", required: false, description: "Cloudflare account id override (useful for multi-account tokens).", example: "--account-id=03819f97b5cb3101faecbbcb6019c4cc" },
          { name: "workers-dev", required: false, description: "Use workers.dev deploy target in temporary runtime config.", example: "--workers-dev=true" },
          { name: "route-pattern", required: false, description: "Route pattern for custom domain target (temporary runtime config).", example: "--route-pattern=router.example.com/*" },
          { name: "zone-name", required: false, description: "Cloudflare zone name for route target (temporary runtime config).", example: "--zone-name=example.com" },
          { name: "domain", required: false, description: "Convenience alias for route host (auto-converted to <domain>/*).", example: "--domain=router.example.com" },
          { name: "generate-master-key", required: false, description: "Generate a strong master key when config has no master key.", example: "--generate-master-key=true" },
          { name: "master-key-length", required: false, description: "Generated master key length (min 24).", example: "--master-key-length=48" },
          { name: "master-key-prefix", required: false, description: "Generated master key prefix.", example: "--master-key-prefix=gw_" },
          { name: "allow-weak-master-key", required: false, description: "Allow weak master key (not recommended).", example: "--allow-weak-master-key=true" },
          { name: "allow-large-config", required: false, description: "Bypass oversized Free-tier secret confirmation (useful in CI).", example: "--allow-large-config=true" },
          { name: "env", required: false, description: "Wrangler environment.", example: "--env=production" },
          { name: "dry-run", required: false, description: "Print commands only.", example: "--dry-run=true" },
          { name: "export-only", required: false, description: "Only export config JSON, no deploy.", example: "--export-only=true" },
          { name: "out", required: false, description: "Write exported JSON to file.", example: "--out=.llm-router.worker.json" }
        ],
        examples: [
          "llm-router deploy",
          "llm-router deploy --dry-run=true",
          "llm-router deploy --account-id=03819f97b5cb3101faecbbcb6019c4cc",
          "llm-router deploy --workers-dev=true",
          "llm-router deploy --route-pattern=router.example.com/* --zone-name=example.com",
          "llm-router deploy --generate-master-key=true",
          "llm-router deploy --export-only=true --out=.llm-router.worker.json",
          "llm-router deploy --allow-large-config=true",
          "llm-router deploy --env=production"
        ],
        useCases: [
          {
            name: "cloudflare deploy",
            description: "Push LLM_ROUTER_CONFIG_JSON secret and deploy worker.",
            command: "llm-router deploy"
          }
        ],
        keybindings: ["Enter confirm", "Esc cancel"]
      },
      run: runDeployAction
    },
    {
      actionId: "worker-key",
      description: "Quickly create/update the LLM_ROUTER_MASTER_KEY Worker secret.",
      tui: { steps: ["key-input", "confirm", "secret-put"] },
      commandline: {
        requiredArgs: [],
        optionalArgs: [
          "config",
          "project-dir",
          "master-key",
          "generate-master-key",
          "master-key-length",
          "master-key-prefix",
          "allow-weak-master-key",
          "use-config-key",
          "env",
          "dry-run"
        ]
      },
      help: {
        summary: "Fast master-key rotation/update on Cloudflare Worker using LLM_ROUTER_MASTER_KEY secret (runtime override).",
        args: [
          { name: "master-key", required: false, description: "New worker master key. If omitted, reads local config when allowed.", example: "--master-key=prod-token-v2" },
          { name: "generate-master-key", required: false, description: "Generate a strong worker master key automatically.", example: "--generate-master-key=true" },
          { name: "master-key-length", required: false, description: "Generated master key length (min 24).", example: "--master-key-length=48" },
          { name: "master-key-prefix", required: false, description: "Generated master key prefix.", example: "--master-key-prefix=gw_" },
          { name: "allow-weak-master-key", required: false, description: "Allow weak master key (not recommended).", example: "--allow-weak-master-key=true" },
          { name: "use-config-key", required: false, description: "Read key from local config if --master-key is omitted.", example: "--use-config-key=true" },
          { name: "config", required: false, description: "Path to local config file.", example: "--config=~/.llm-router.json" },
          { name: "project-dir", required: false, description: "Directory containing wrangler.toml.", example: "--project-dir=./route" },
          { name: "env", required: false, description: "Wrangler environment.", example: "--env=production" },
          { name: "dry-run", required: false, description: "Print commands only.", example: "--dry-run=true" }
        ],
        examples: [
          "llm-router worker-key --master-key=prod-token-v2",
          "llm-router worker-key --generate-master-key=true",
          "llm-router worker-key --env=production --master-key=rotated-key",
          "llm-router worker-key --use-config-key=true"
        ],
        useCases: [
          {
            name: "rotate leaked key",
            description: "Set LLM_ROUTER_MASTER_KEY quickly without rebuilding the full worker config secret.",
            command: "llm-router worker-key --master-key=new-secret"
          }
        ],
        keybindings: ["Enter confirm", "Esc cancel"]
      },
      run: runWorkerKeyAction
    }
  ]
};

export default routerModule;
