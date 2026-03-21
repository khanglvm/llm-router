import { promises as fsPromises } from "node:fs";
import os from "node:os";
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
import { runWebCommand } from "../node/web-command.js";
import { resolveListenPort } from "../node/listen-port.js";
import { createLiteLlmContextLookupHelper } from "../node/litellm-context-catalog.js";
import {
  readAmpClientRoutingState as readAmpClientRoutingStateFile,
  unpatchAmpClientConfigFiles as unpatchAmpClientConfigFilesFile
} from "../node/amp-client-config.js";
import {
  patchClaudeCodeEffortLevel,
  patchClaudeCodeSettingsFile,
  patchCodexCliConfigFile,
  readClaudeCodeRoutingState,
  readCodexCliRoutingState,
  resolveClaudeCodeSettingsFilePath,
  resolveCodexCliConfigFilePath,
  resolveCodexCliModelCatalogFilePath,
  unpatchClaudeCodeSettingsFile,
  unpatchCodexCliConfigFile
} from "../node/coding-tool-config.js";
import { installStartup, restartStartup, startupStatus, stopStartup, uninstallStartup } from "../node/startup-manager.js";
import {
  buildStartArgsFromState,
  clearRuntimeState,
  getActiveRuntimeState,
  spawnDetachedStart,
  stopProcessByPid
} from "../node/instance-state.js";
import { listListeningPids, reclaimPort } from "../node/port-reclaim.js";
import {
  CONFIG_VERSION,
  DEFAULT_MODEL_ALIAS_ID,
  configHasProvider,
  DEFAULT_AMP_ENTITY_DEFINITIONS,
  DEFAULT_AMP_SIGNATURE_DEFINITIONS,
  DEFAULT_AMP_SUBAGENT_DEFINITIONS,
  DEFAULT_PROVIDER_USER_AGENT,
  maskSecret,
  normalizeRuntimeConfig,
  PROVIDER_ID_PATTERN,
  sanitizeConfigForDisplay,
  validateRuntimeConfig
} from "../runtime/config.js";
import {
  CODEX_SUBSCRIPTION_MODELS,
  CLAUDE_CODE_SUBSCRIPTION_MODELS
} from "../runtime/subscription-constants.js";
import {
  LOCAL_ROUTER_HOST,
  LOCAL_ROUTER_ORIGIN,
  LOCAL_ROUTER_PORT
} from "../shared/local-router-defaults.js";
import {
  CODEX_CLI_INHERIT_MODEL_VALUE,
  isCodexCliInheritModelBinding,
  normalizeClaudeCodeEffortLevel,
  normalizeCodexCliReasoningEffort
} from "../shared/coding-tool-bindings.js";
import { FORMATS } from "../translator/index.js";
import {
  CLOUDFLARE_ACCOUNT_ID_ENV_NAME,
  CLOUDFLARE_API_TOKEN_ENV_NAME,
  buildCloudflareApiTokenSetupGuide,
  buildCloudflareApiTokenTroubleshooting,
  cloudflareListZones,
  evaluateCloudflareMembershipsResult,
  evaluateCloudflareTokenVerifyResult,
  extractCloudflareMembershipAccounts,
  preflightCloudflareApiToken,
  resolveCloudflareApiTokenFromEnv,
  validateCloudflareApiTokenInput
} from "./cloudflare-api.js";
import {
  applyWranglerDeployTargetToToml,
  buildCloudflareDnsManualGuide,
  buildDefaultWranglerTomlForDeploy,
  extractHostnameFromRoutePattern,
  hasNoDeployTargets,
  hasWranglerDeployTargetConfigured,
  inferZoneNameFromHostname,
  isHostnameUnderZone,
  normalizeWranglerRoutePattern,
  parseTomlStringField,
  suggestZoneNameForHostname
} from "./wrangler-toml.js";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_VALIDATION = 2;
const APP_NAME = "LLM Router";
const CLI_COMMAND = "llr";
const NPM_PACKAGE_NAME = "@khanglvm/llm-router";
const STRONG_MASTER_KEY_MIN_LENGTH = 24;
const DEFAULT_GENERATED_MASTER_KEY_LENGTH = 48;
const MAX_GENERATED_MASTER_KEY_LENGTH = 256;
const WEAK_MASTER_KEY_PATTERN = /(password|changeme|default|secret|token|admin|qwerty|letmein|123456)/i;
export const CLOUDFLARE_FREE_SECRET_SIZE_LIMIT_BYTES = 5 * 1024;
const CLOUDFLARE_FREE_TIER_PATTERN = /\bfree\b/i;
const CLOUDFLARE_PAID_TIER_PATTERN = /\b(pro|business|enterprise|paid|unbound)\b/i;
const MODEL_ALIAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MODEL_ROUTING_STRATEGY_OPTIONS = [
  {
    value: "auto",
    label: "Auto",
    hint: "recommended"
  },
  {
    value: "ordered",
    label: "Ordered",
    hint: "try routes in order"
  },
  {
    value: "round-robin",
    label: "Round-robin",
    hint: "even spread"
  },
  {
    value: "weighted-rr",
    label: "Weighted round-robin",
    hint: "respect weights"
  },
  {
    value: "quota-aware-weighted-rr",
    label: "Quota-aware weighted round-robin",
    hint: "favor routes with quota left"
  }
];
const MODEL_ALIAS_STRATEGIES = MODEL_ROUTING_STRATEGY_OPTIONS.map((option) => option.value);
const DEFAULT_PROBE_REQUESTS_PER_MINUTE = 30;
const DEFAULT_PROBE_MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_AI_HELP_GATEWAY_TEST_TIMEOUT_MS = 6000;
const PROVIDER_TYPE_STANDARD = "standard";
const PROVIDER_TYPE_SUBSCRIPTION = "subscription";
const SUBSCRIPTION_TYPE_CHATGPT_CODEX = "chatgpt-codex";
const SUBSCRIPTION_TYPE_CLAUDE_CODE = "claude-code";
const SUBSCRIPTION_PROVIDER_PRESETS = Object.freeze([
  Object.freeze({
    subscriptionType: SUBSCRIPTION_TYPE_CHATGPT_CODEX,
    label: "ChatGPT",
    defaultName: "GPT Sub",
    defaultModels: CODEX_SUBSCRIPTION_MODELS,
    targetFormat: FORMATS.OPENAI
  }),
  Object.freeze({
    subscriptionType: SUBSCRIPTION_TYPE_CLAUDE_CODE,
    label: "Claude Code",
    defaultName: "Claude Sub",
    defaultModels: CLAUDE_CODE_SUBSCRIPTION_MODELS,
    targetFormat: FORMATS.CLAUDE
  })
]);
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

export {
  applyWranglerDeployTargetToToml,
  buildCloudflareDnsManualGuide,
  buildCloudflareApiTokenSetupGuide,
  buildDefaultWranglerTomlForDeploy,
  evaluateCloudflareMembershipsResult,
  evaluateCloudflareTokenVerifyResult,
  extractHostnameFromRoutePattern,
  extractCloudflareMembershipAccounts,
  hasNoDeployTargets,
  hasWranglerDeployTargetConfigured,
  inferZoneNameFromHostname,
  isHostnameUnderZone,
  normalizeWranglerRoutePattern,
  resolveCloudflareApiTokenFromEnv,
  suggestZoneNameForHostname,
  validateCloudflareApiTokenInput
};

function canPrompt() {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

function canUseInteractivePrompts(context, requiredMethods = ["select", "text", "confirm"]) {
  const prompts = context?.prompts;
  const hasMethods = Boolean(prompts) && requiredMethods.every((method) => typeof prompts?.[method] === "function");
  return Boolean((canPrompt() && hasMethods) || (context?.forcePrompt === true && hasMethods));
}

const PROMPT_CANCELLED = Symbol("prompt-cancelled");

function isPromptCancelledError(error) {
  if (!error) return false;
  if (error === PROMPT_CANCELLED) return true;
  const name = String(error?.name || "").trim().toLowerCase();
  const message = String(error?.message || error || "").trim().toLowerCase();
  return name === "aborterror"
    || message.includes("cancel")
    || message.includes("canceled")
    || message.includes("cancelled")
    || message.includes("aborted")
    || message.includes("escape");
}

async function runPromptWithEscape(promiseFactory) {
  try {
    return await promiseFactory();
  } catch (error) {
    if (isPromptCancelledError(error)) return PROMPT_CANCELLED;
    throw error;
  }
}

function normalizeAmpClientSettingsScope(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "global" || normalized === "user") return "global";
  if (normalized === "workspace" || normalized === "project") return "workspace";
  return "";
}

export function normalizeAmpClientProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return "";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";

  const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "/";
  parsed.pathname = normalizedPath;
  const out = parsed.toString();
  return normalizedPath === "/" && out.endsWith("/") ? out.slice(0, -1) : out;
}

export function resolveAmpClientSettingsFilePath({
  scope = "global",
  explicitPath = "",
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const direct = String(explicitPath || "").trim();
  if (direct) return path.resolve(direct);

  const normalizedScope = normalizeAmpClientSettingsScope(scope) || "global";
  if (normalizedScope === "workspace") {
    return path.resolve(cwd, ".amp", "settings.json");
  }

  const envOverride = String(env?.AMP_SETTINGS_FILE || "").trim();
  if (envOverride) return path.resolve(envOverride);

  const configHome = String(env?.XDG_CONFIG_HOME || "").trim() || path.join(homeDir, ".config");
  return path.join(configHome, "amp", "settings.json");
}

export function resolveAmpClientSecretsFilePath({
  explicitPath = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const direct = String(explicitPath || env?.AMP_SECRETS_FILE || "").trim();
  if (direct) return path.resolve(direct);

  const dataHome = String(env?.XDG_DATA_HOME || "").trim() || path.join(homeDir, ".local", "share");
  return path.join(dataHome, "amp", "secrets.json");
}

async function readJsonObjectFile(filePath, label) {
  try {
    const raw = await fsPromises.readFile(filePath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must contain a JSON object.`);
    }
    return {
      data: parsed,
      existed: true
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        data: {},
        existed: false
      };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} contains invalid JSON.`);
    }
    throw error;
  }
}

async function writeJsonObjectFile(filePath, data) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsPromises.chmod(filePath, 0o600);
}

async function findAmpClientApiKeyForUrl(endpointUrl, {
  env = process.env,
  homeDir = os.homedir(),
  explicitSecretsFile = ""
} = {}) {
  const normalizedUrl = normalizeAmpClientProxyUrl(endpointUrl);
  if (!normalizedUrl) return "";

  try {
    const secretsFilePath = resolveAmpClientSecretsFilePath({
      explicitPath: explicitSecretsFile,
      env,
      homeDir
    });
    const secretsState = await readJsonObjectFile(secretsFilePath, `AMP secrets file '${secretsFilePath}'`);
    const candidates = dedupeList([
      `apiKey@${normalizedUrl}`,
      normalizedUrl.endsWith("/") ? `apiKey@${normalizedUrl.slice(0, -1)}` : `apiKey@${normalizedUrl}/`
    ]);
    for (const fieldName of candidates) {
      const value = String(secretsState.data?.[fieldName] || "").trim();
      if (value) return value;
    }
  } catch {
    // Ignore discovery errors and fall through to manual prompt.
  }

  return "";
}

function hasConfiguredAmpRouting(amp) {
  const source = amp && typeof amp === "object" && !Array.isArray(amp) ? amp : {};
  if (String(source.defaultRoute || "").trim()) return true;
  if (Array.isArray(source.rawModelRoutes) && source.rawModelRoutes.length > 0) return true;
  if (Array.isArray(source.modelMappings) && source.modelMappings.length > 0) return true;
  if (source.routes && typeof source.routes === "object" && Object.keys(source.routes).length > 0) return true;
  if (source.subagentMappings && typeof source.subagentMappings === "object" && Object.keys(source.subagentMappings).length > 0) return true;
  return false;
}

function resolveAmpBootstrapRouteRef(config) {
  const configuredDefault = String(config?.defaultModel || "").trim();
  if (configuredDefault) return configuredDefault;

  for (const provider of Array.isArray(config?.providers) ? config.providers : []) {
    if (provider?.enabled === false) continue;
    const providerId = String(provider?.id || "").trim();
    if (!providerId) continue;
    const firstModel = Array.isArray(provider?.models)
      ? provider.models.find((entry) => String(entry?.id || "").trim())
      : null;
    if (firstModel?.id) return `${providerId}/${firstModel.id}`;
  }

  return "";
}

async function maybeBootstrapAmpPatchDefaults({
  config,
  amp,
  patchPlan,
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const base = await applyAmpRecommendedAmpConnectionDefaults({
    amp,
    patchPlan,
    env,
    homeDir
  });
  const nextAmp = base.amp;
  let changed = base.changed === true;
  const discoveredUpstreamApiKey = base.discoveredUpstreamApiKey === true;

  if (!hasConfiguredAmpRouting(nextAmp)) {
    const bootstrapRouteRef = resolveAmpBootstrapRouteRef(config);
    if (!bootstrapRouteRef) {
      return {
        amp: nextAmp,
        changed,
        bootstrapRouteRef: "",
        discoveredUpstreamApiKey,
        error: "AMP bootstrap needs defaultModel (or at least one provider model) when patching AMP client files without explicit AMP routes. Set defaultModel first or pass --amp-default-route."
      };
    }
    nextAmp.defaultRoute = bootstrapRouteRef;
    changed = true;
    return {
      amp: nextAmp,
      changed,
      bootstrapRouteRef,
      discoveredUpstreamApiKey,
      error: ""
    };
  }

  return {
    amp: nextAmp,
    changed,
    bootstrapRouteRef: String(nextAmp.defaultRoute || "").trim(),
    discoveredUpstreamApiKey,
    error: ""
  };
}

async function applyAmpRecommendedAmpConnectionDefaults({
  amp,
  patchPlan,
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const nextAmp = amp && typeof amp === "object" && !Array.isArray(amp)
    ? structuredClone(amp)
    : {};
  let changed = false;
  let discoveredUpstreamApiKey = false;

  if (!String(nextAmp.upstreamUrl || "").trim()) {
    nextAmp.upstreamUrl = "https://ampcode.com";
    changed = true;
  }

  if (nextAmp.restrictManagementToLocalhost !== true) {
    nextAmp.restrictManagementToLocalhost = true;
    changed = true;
  }

  if (!String(nextAmp.upstreamApiKey || "").trim()) {
    const discoveredUpstreamApiKeyValue = await findAmpClientApiKeyForUrl(nextAmp.upstreamUrl, {
      env,
      homeDir,
      explicitSecretsFile: patchPlan?.secretsFilePath || ""
    });
    if (discoveredUpstreamApiKeyValue) {
      nextAmp.upstreamApiKey = discoveredUpstreamApiKeyValue;
      changed = true;
      discoveredUpstreamApiKey = true;
    }
  }

  if (!String(nextAmp.preset || "").trim()) {
    nextAmp.preset = "builtin";
    changed = true;
  }

  return {
    amp: nextAmp,
    changed,
    discoveredUpstreamApiKey,
    error: ""
  };
}

export async function patchAmpClientConfigFiles({
  settingsFilePath,
  secretsFilePath,
  endpointUrl,
  apiKey
} = {}) {
  const normalizedUrl = normalizeAmpClientProxyUrl(endpointUrl);
  const normalizedApiKey = String(apiKey || "").trim();
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveAmpClientSettingsFilePath()).trim());
  const resolvedSecretsPath = path.resolve(String(secretsFilePath || resolveAmpClientSecretsFilePath()).trim());

  if (!normalizedUrl) {
    throw new Error("AMP client endpoint URL must be a valid http:// or https:// URL.");
  }
  if (!normalizedApiKey) {
    throw new Error("AMP client API key is required.");
  }

  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `AMP settings file '${resolvedSettingsPath}'`);
  settingsState.data["amp.url"] = normalizedUrl;
  await writeJsonObjectFile(resolvedSettingsPath, settingsState.data);

  const secretsState = await readJsonObjectFile(resolvedSecretsPath, `AMP secrets file '${resolvedSecretsPath}'`);
  const secretFieldName = `apiKey@${normalizedUrl}`;
  secretsState.data[secretFieldName] = normalizedApiKey;
  await writeJsonObjectFile(resolvedSecretsPath, secretsState.data);

  return {
    settingsFilePath: resolvedSettingsPath,
    secretsFilePath: resolvedSecretsPath,
    endpointUrl: normalizedUrl,
    secretFieldName,
    settingsCreated: !settingsState.existed,
    secretsCreated: !secretsState.existed
  };
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

function normalizeAmpModelMappingEntry(entry) {
  if (!entry) return null;

  if (typeof entry === "string") {
    const text = String(entry).trim();
    if (!text) return null;
    const separator = text.includes("=>") ? "=>" : (text.includes("->") ? "->" : "");
    if (!separator) {
      throw new Error(`Invalid AMP model mapping '${text}'. Use 'from => to'.`);
    }
    const separatorIndex = text.indexOf(separator);
    const from = text.slice(0, separatorIndex).trim();
    const to = text.slice(separatorIndex + separator.length).trim();
    if (!from || !to) {
      throw new Error(`Invalid AMP model mapping '${text}'. Both source and target are required.`);
    }
    return { from, to };
  }

  if (typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("AMP model mappings must be objects or 'from => to' strings.");
  }

  const from = String(entry.from ?? entry.match ?? entry.pattern ?? entry.model ?? "").trim();
  const to = String(entry.to ?? entry.target ?? entry.route ?? entry.ref ?? "").trim();
  if (!from || !to) {
    throw new Error("AMP model mapping objects must include non-empty 'from' and 'to' values.");
  }
  return { from, to };
}

function parseAmpModelMappingsArg(value, fieldName = "--amp-model-mappings") {
  if (value === undefined || value === null || value === "") return undefined;

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeAmpModelMappingEntry(entry)).filter(Boolean);
  }

  if (typeof value === "object") {
    return [normalizeAmpModelMappingEntry(value)].filter(Boolean);
  }

  const text = String(value).trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => normalizeAmpModelMappingEntry(entry)).filter(Boolean);
    }
    if (parsed && typeof parsed === "object") {
      return [normalizeAmpModelMappingEntry(parsed)].filter(Boolean);
    }
  } catch {
    // Fall through to the lightweight line-based parser below.
  }

  const entries = text
    .split(/\r?\n|,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) return [];

  try {
    return entries.map((entry) => normalizeAmpModelMappingEntry(entry)).filter(Boolean);
  } catch (error) {
    throw new Error(`${fieldName} must be JSON or a newline/comma separated list of 'from => to' mappings. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeAmpRouteIdInput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("@")) {
    return `@${text.slice(1).trim().toLowerCase().replace(/[\s_]+/g, "-")}`;
  }
  return normalizeAmpSubagentIdInput(text);
}

function normalizeAmpRouteMappingEntry(entry) {
  if (typeof entry === "string") {
    const text = String(entry).trim();
    if (!text) return null;
    const separator = text.includes("=>") ? "=>" : (text.includes("->") ? "->" : "");
    if (!separator) {
      throw new Error(`Invalid AMP route mapping '${text}'. Use 'entity-or-signature => route'.`);
    }
    const separatorIndex = text.indexOf(separator);
    const key = normalizeAmpRouteIdInput(text.slice(0, separatorIndex));
    const to = String(text.slice(separatorIndex + separator.length) || "").trim();
    if (!key || !to) {
      throw new Error(`Invalid AMP route mapping '${text}'. Both route key and target are required.`);
    }
    return { key, to };
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("AMP routes must be objects or 'entity => route' strings.");
  }

  const key = normalizeAmpRouteIdInput(entry.key ?? entry.id ?? entry.name ?? entry.agent ?? entry.subagent ?? entry.signature);
  const to = String(entry.to ?? entry.target ?? entry.route ?? entry.ref ?? "").trim();
  if (!key || !to) {
    throw new Error("AMP route objects must include non-empty route key and target values.");
  }
  return { key, to };
}

function parseAmpRoutesArg(value, fieldName = "--amp-routes") {
  if (value === undefined || value === null || value === "") return undefined;

  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((entry) => {
      const normalized = normalizeAmpRouteMappingEntry(entry);
      return [normalized.key, normalized.to];
    }));
  }

  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, to]) => [normalizeAmpRouteIdInput(key), String(to || "").trim()]).filter(([key, to]) => key && to));
  }

  const text = String(value).trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return Object.fromEntries(parsed.map((entry) => {
        const normalized = normalizeAmpRouteMappingEntry(entry);
        return [normalized.key, normalized.to];
      }));
    }
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(Object.entries(parsed).map(([key, to]) => [normalizeAmpRouteIdInput(key), String(to || "").trim()]).filter(([key, to]) => key && to));
    }
  } catch {
    // Fall through to line-based parser.
  }

  const entries = text
    .split(/\r?\n|,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  try {
    return Object.fromEntries(entries.map((entry) => {
      const normalized = normalizeAmpRouteMappingEntry(entry);
      return [normalized.key, normalized.to];
    }));
  } catch (error) {
    throw new Error(`${fieldName} must be JSON or a newline/comma separated list of 'entity-or-signature => route' mappings. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseAmpOverridesArg(value, fieldName = "--amp-overrides") {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") return value;

  const text = String(value).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("AMP overrides must be a JSON object.");
    }
    return parsed;
  } catch (error) {
    throw new Error(`${fieldName} must be a JSON object. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeAmpSubagentMappingEntry(entry) {
  if (typeof entry === "string") {
    const parts = entry.split(/=>|->|:/).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return { agent: parts[0], to: parts.slice(1).join(":") };
    }
    throw new Error("AMP subagent mappings must use the format 'subagent => route'.");
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("AMP subagent mappings must be objects or 'subagent => route' strings.");
  }

  const agent = String(entry.agent ?? entry.subagent ?? entry.name ?? entry.id ?? "").trim();
  const to = String(entry.to ?? entry.target ?? entry.route ?? entry.ref ?? "").trim();
  if (!agent || !to) {
    throw new Error("AMP subagent mapping objects must include non-empty 'agent' and 'to' values.");
  }
  return { agent, to };
}

function parseAmpSubagentMappingsArg(value, fieldName = "--amp-subagent-mappings") {
  if (value === undefined || value === null || value === "") return undefined;

  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((entry) => {
      const normalized = normalizeAmpSubagentMappingEntry(entry);
      return [normalized.agent, normalized.to];
    }));
  }

  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([agent, to]) => [agent, String(to || "").trim()]).filter(([, to]) => to));
  }

  const text = String(value).trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return Object.fromEntries(parsed.map((entry) => {
        const normalized = normalizeAmpSubagentMappingEntry(entry);
        return [normalized.agent, normalized.to];
      }));
    }
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(Object.entries(parsed).map(([agent, to]) => [agent, String(to || "").trim()]).filter(([, to]) => to));
    }
  } catch {
    // Fall through to the lightweight line-based parser below.
  }

  const entries = text
    .split(/\r?\n|,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  try {
    return Object.fromEntries(entries.map((entry) => {
      const normalized = normalizeAmpSubagentMappingEntry(entry);
      return [normalized.agent, normalized.to];
    }));
  } catch (error) {
    throw new Error(`${fieldName} must be JSON or a newline/comma separated list of 'subagent => route' mappings. ${error instanceof Error ? error.message : String(error)}`);
  }
}


function normalizeAmpSubagentDefinitionEntry(entry) {
  if (typeof entry === "string") {
    const parts = entry.split(/=>|->|:/).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return { id: parts[0], patterns: parts.slice(1).join(":").split(/[|,]/).map((part) => part.trim()).filter(Boolean) };
    }
    throw new Error("AMP subagent definitions must use the format 'subagent => model-pattern|model-pattern'.");
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("AMP subagent definitions must be objects or 'subagent => model-pattern' strings.");
  }

  const id = String(entry.id ?? entry.agent ?? entry.subagent ?? entry.name ?? entry.key ?? "").trim();
  const patterns = [];
  for (const value of [entry.patterns, entry.matches, entry.models, entry.model, entry.pattern]) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = String(item || "").trim();
        if (text) patterns.push(text);
      }
      continue;
    }
    const text = String(value || "").trim();
    if (!text) continue;
    for (const item of text.split(/[|,]/)) {
      const pattern = item.trim();
      if (pattern) patterns.push(pattern);
    }
  }

  if (!id || patterns.length === 0) {
    throw new Error("AMP subagent definition objects must include non-empty 'id' and at least one model pattern.");
  }
  return { id, patterns };
}

function parseAmpSubagentDefinitionsArg(value, fieldName = "--amp-subagent-definitions") {
  if (value === undefined || value === null || value === "") return undefined;

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeAmpSubagentDefinitionEntry(entry));
  }

  const text = typeof value === "string" ? value.trim() : "";
  if (typeof value === "object" && !Array.isArray(value)) {
    if (value && Array.isArray(value.definitions)) {
      return value.definitions.map((entry) => normalizeAmpSubagentDefinitionEntry(entry));
    }
    return Object.entries(value || {}).map(([id, patterns]) => normalizeAmpSubagentDefinitionEntry({ id, patterns }));
  }

  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => normalizeAmpSubagentDefinitionEntry(entry));
    }
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.definitions)) {
        return parsed.definitions.map((entry) => normalizeAmpSubagentDefinitionEntry(entry));
      }
      return Object.entries(parsed).map(([id, patterns]) => normalizeAmpSubagentDefinitionEntry({ id, patterns }));
    }
  } catch {
    // Fall through to line-based parser.
  }

  const entries = text
    .split(/\r?\n|,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  try {
    return entries.map((entry) => normalizeAmpSubagentDefinitionEntry(entry));
  } catch (error) {
    throw new Error(`${fieldName} must be JSON or a newline/comma separated list of 'subagent => model-pattern|pattern' definitions. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeAmpSubagentIdInput(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (["lookat", "look-at", "look_at", "look at"].includes(text)) return "look-at";
  if (["title", "titling"].includes(text)) return "title";
  return text;
}

function parseAmpPatternListInput(value) {
  const text = Array.isArray(value) ? value.join("\n") : String(value || "");
  return dedupeList(
    text
      .split(/\r?\n|[|,]/)
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
  );
}

function cloneAmpSubagentDefinitionEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      id: normalizeAmpSubagentIdInput(entry?.id),
      patterns: parseAmpPatternListInput(entry?.patterns || [])
    }))
    .filter((entry) => entry.id && entry.patterns.length > 0);
}

function getEffectiveAmpSubagentDefinitions(amp) {
  return cloneAmpSubagentDefinitionEntries(
    Array.isArray(amp?.subagentDefinitions)
      ? amp.subagentDefinitions
      : DEFAULT_AMP_SUBAGENT_DEFINITIONS
  );
}

function ensureAmpSubagentMappingsObject(amp) {
  if (!amp.subagentMappings || typeof amp.subagentMappings !== "object" || Array.isArray(amp.subagentMappings)) {
    amp.subagentMappings = {};
  }
  return amp.subagentMappings;
}

function ensureCustomAmpSubagentDefinitions(amp) {
  if (!Array.isArray(amp.subagentDefinitions)) {
    amp.subagentDefinitions = getEffectiveAmpSubagentDefinitions(amp);
  } else {
    amp.subagentDefinitions = cloneAmpSubagentDefinitionEntries(amp.subagentDefinitions);
  }
  return amp.subagentDefinitions;
}

function buildAmpModelMappingPromptOptions(mappings) {
  return (Array.isArray(mappings) ? mappings : []).map((entry, index) => ({
    value: String(index),
    label: `${entry?.from || "(match)"} -> ${entry?.to || "(route)"}`
  }));
}

function buildAmpSubagentPromptOptions(amp) {
  const mappings = amp?.subagentMappings && typeof amp.subagentMappings === "object" ? amp.subagentMappings : {};
  return getEffectiveAmpSubagentDefinitions(amp).map((entry) => ({
    value: entry.id,
    label: `${entry.id} | ${(entry.patterns || []).join(" | ")} | ${mappings[entry.id] || "defaultModel"}`
  }));
}

function buildAmpSubagentReviewRows(amp) {
  const mappings = amp?.subagentMappings && typeof amp.subagentMappings === "object" ? amp.subagentMappings : {};
  return getEffectiveAmpSubagentDefinitions(amp).map((entry) => ([
    entry.id,
    (entry.patterns || []).join(" | ") || "(not set)",
    mappings[entry.id] || "defaultModel"
  ]));
}

function buildAmpClientPatchSection(result) {
  return "AMP Client Files\n" + renderAsciiTable(["Field", "Value"], [
    ["Settings File", result?.settingsFilePath || "(not set)"],
    ["Secrets File", result?.secretsFilePath || "(not set)"],
    ["Endpoint URL", result?.endpointUrl || "(not set)"],
    ["Secret Field", result?.secretFieldName || "(not set)"],
    ["Created Settings File", formatYesNo(result?.settingsCreated === true)],
    ["Created Secrets File", formatYesNo(result?.secretsCreated === true)]
  ]);
}

function buildAmpRouteTargetPromptOptions(config, {
  includeClearOption = false,
  clearValue = "__clear__",
  clearLabel = "Clear mapping",
  clearHint = "use AMP default routing"
} = {}) {
  const options = [];
  if (includeClearOption) {
    options.push({
      value: clearValue,
      label: clearLabel,
      hint: clearHint
    });
  }

  for (const [aliasId, alias] of Object.entries(config?.modelAliases || {})) {
    options.push({
      value: aliasId,
      label: aliasId,
      hint: `alias · ${summarizeAliasPromptHint(alias)}`
    });
  }

  for (const provider of (config?.providers || [])) {
    if (!provider || provider.enabled === false) continue;
    for (const model of (provider.models || [])) {
      if (!model || model.enabled === false || !String(model.id || "").trim()) continue;
      const routeRef = `${provider.id}/${model.id}`;
      options.push({
        value: routeRef,
        label: routeRef,
        hint: summarizeProviderPromptHint(provider)
      });
    }
  }

  const seen = new Set();
  return options.filter((option) => {
    if (!option || seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

function resolvePreferredAmpRoute(config, amp) {
  return String(amp?.defaultRoute || "").trim() || resolveAmpBootstrapRouteRef(config);
}

async function promptAmpRouteTarget(context, config, {
  message,
  initialValue = "",
  includeClearOption = false,
  clearLabel = "Clear mapping",
  clearHint = "use AMP default routing",
  textPlaceholder = "chat.default"
} = {}) {
  const options = buildAmpRouteTargetPromptOptions(config, {
    includeClearOption,
    clearLabel,
    clearHint
  });
  const normalizedInitial = String(initialValue || "").trim();

  if (options.length > 0) {
    const explicitInitial = options.some((option) => option.value === normalizedInitial)
      ? normalizedInitial
      : undefined;
    const selection = await context.prompts.select({
      message,
      options,
      initialValue: explicitInitial
    });
    return selection === "__clear__" ? "" : String(selection || "").trim();
  }

  return String(await context.prompts.text({
    message,
    required: includeClearOption !== true,
    initialValue: normalizedInitial,
    placeholder: textPlaceholder,
    validate: (value) => {
      const candidate = String(value || "").trim();
      if (!candidate && includeClearOption) return undefined;
      return candidate ? undefined : "Choose a model alias or provider/model route.";
    }
  }) || "").trim();
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

function buildAmpSimpleRouteOptions(amp) {
  const configuredRoutes = amp?.routes && typeof amp.routes === "object" && !Array.isArray(amp.routes)
    ? amp.routes
    : {};
  return DEFAULT_AMP_ENTITY_DEFINITIONS.map((entry) => {
    const defaultMatch = getAmpDefaultMatchForRouteKey(entry.id);
    return {
      value: entry.id,
      label: entry.id,
      hint: configuredRoutes[entry.id]
        ? `${defaultMatch || entry.description} · ${configuredRoutes[entry.id]}`
        : `${defaultMatch || entry.description}`
    };
  });
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

function buildAmpEditableRouteEntries(amp) {
  ensureAmpRouteCollections(amp);

  const builtInRouteEntries = DEFAULT_AMP_ENTITY_DEFINITIONS.map((entry) => {
    const defaultMatch = getAmpDefaultMatchForRouteKey(entry.id);
    return {
      id: `route:${entry.id}`,
      source: "route",
      routeKey: entry.id,
      inbound: entry.id,
      editableInbound: defaultMatch || entry.id,
      outbound: String(amp.routes?.[entry.id] || "").trim(),
      label: entry.id,
      defaultMatch,
      hint: `${entry.id} · ${String(amp.routes?.[entry.id] || "").trim() || "uses default route"}`
    };
  });

  const configuredRouteEntries = Object.entries(amp.routes || {})
    .filter(([key]) => !DEFAULT_AMP_ENTITY_DEFINITIONS.some((entry) => entry.id === key))
    .map(([key, target]) => {
      const defaultMatch = getAmpDefaultMatchForRouteKey(key);
      return {
        id: `route:${key}`,
        source: "route",
        routeKey: key,
        inbound: key,
        outbound: String(target || "").trim(),
        label: defaultMatch || key,
        defaultMatch,
        hint: `${key} · ${String(target || "").trim() || "(not set)"}`
      };
    });

  const rawRouteEntries = (amp.rawModelRoutes || []).map((mapping, index) => ({
    id: `raw:${index}`,
    source: "raw",
    index,
    inbound: String(mapping?.from || "").trim(),
    outbound: String(mapping?.to || "").trim(),
    label: String(mapping?.from || "").trim() || `(route ${index + 1})`,
    hint: String(mapping?.to || "").trim() || "(not set)"
  }));

  return [...builtInRouteEntries, ...configuredRouteEntries, ...rawRouteEntries].filter((entry) => entry.inbound || entry.outbound);
}

function buildAmpEditableRouteOptions(amp) {
  return buildAmpEditableRouteEntries(amp).map((entry) => ({
    value: entry.id,
    label: entry.label,
    hint: entry.source === "raw"
      ? `wildcard/raw → ${entry.hint}`
      : `route → ${entry.hint}`
  }));
}

function findAmpEditableRouteEntry(amp, entryId) {
  return buildAmpEditableRouteEntries(amp).find((entry) => entry.id === entryId) || null;
}

function upsertAmpEditableRoute(amp, currentEntry, {
  inbound,
  outbound
} = {}) {
  ensureAmpRouteCollections(amp);

  const nextInbound = String(inbound ?? currentEntry?.inbound ?? "").trim();
  const nextOutbound = String(outbound ?? currentEntry?.outbound ?? "").trim();
  const preferredRouteKey = currentEntry?.source === "route"
    ? String(currentEntry.routeKey || "").trim()
    : "";
  const preferredDefaultMatch = preferredRouteKey
    ? String(currentEntry?.defaultMatch || "").trim()
    : "";
  const nextKnownRouteKey = isKnownAmpRouteKey(nextInbound)
    ? nextInbound
    : (preferredRouteKey && preferredDefaultMatch && nextInbound === preferredDefaultMatch ? preferredRouteKey : "");
  if (!nextInbound) {
    throw new Error("Inbound AMP model is required.");
  }
  if (!nextOutbound) {
    throw new Error("Outbound AMP route is required.");
  }

  if (currentEntry?.source === "route" && currentEntry.routeKey) {
    delete amp.routes[currentEntry.routeKey];
  }
  if (currentEntry?.source === "raw" && Number.isInteger(currentEntry.index)) {
    amp.rawModelRoutes.splice(currentEntry.index, 1);
  }

  if (nextKnownRouteKey) {
    amp.routes[nextKnownRouteKey] = nextOutbound;
    return findAmpEditableRouteEntry(amp, `route:${nextKnownRouteKey}`);
  }

  amp.rawModelRoutes.push({ from: nextInbound, to: nextOutbound });
  return findAmpEditableRouteEntry(amp, `raw:${amp.rawModelRoutes.length - 1}`);
}

function printAmpInboundModelHelp(context, entry = null) {
  const info = typeof context?.terminal?.info === "function" ? context.terminal.info.bind(context.terminal) : null;
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
  const routeKey = String(entry?.routeKey || entry?.inbound || "").trim();
  const defaultMatch = getAmpDefaultMatchForRouteKey(routeKey);
  info?.(`Inbound AMP model matches what AMP sends before ${APP_NAME} chooses a local route.`);
  line?.("Use built-in keys like smart/rush/deep/oracle or your own wildcard pattern like gpt-*-codex*.");
  if (defaultMatch) {
    line?.(`Default built-in match for '${routeKey}': ${defaultMatch}`);
  }
  line?.("Reference: https://ampcode.com/models");
}

function printAmpQuickSetupGuide(context, config) {
  const info = typeof context?.terminal?.info === "function" ? context.terminal.info.bind(context.terminal) : null;
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
  const recommendedRoute = resolveAmpBootstrapRouteRef(config);
  info?.(`Quick setup patches AMP to use your local ${APP_NAME}, then picks one default route.`);
  line?.(`Recommended default route: ${recommendedRoute || "(set a model alias like chat.default first)"}`);
  line?.("You can map smart/rush/deep/oracle later from 'Common AMP routes'.");
}

function printAmpWizardReview(context, amp, patchPlan = null) {
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
  line?.(buildAmpConfigSection(amp));
  if (patchPlan) {
    line?.(buildAmpClientPatchSection({
      ...patchPlan,
      secretFieldName: `apiKey@${patchPlan.endpointUrl}`,
      settingsCreated: false,
      secretsCreated: false
    }));
  }
}

function normalizeAmpLoopbackHost(value) {
  const host = String(value || "").trim();
  if (!host) return "127.0.0.1";
  if (["0.0.0.0", "::", "::0", "[::]", "::1", "localhost"].includes(host)) return "127.0.0.1";
  return host;
}

function formatHostForHttpUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function suggestAmpClientProxyUrl() {
  return LOCAL_ROUTER_ORIGIN;
}

async function promptAmpProxySettings(context, amp) {
  const info = typeof context?.terminal?.info === "function" ? context.terminal.info.bind(context.terminal) : null;
  const upstreamUrlInput = await context.prompts.text({
    message: "AMP upstream URL (blank disables upstream proxy)",
    required: false,
    initialValue: String(amp.upstreamUrl || "https://ampcode.com")
  });
  const normalizedUpstreamUrl = normalizeAmpClientProxyUrl(upstreamUrlInput);

  let suggestedUpstreamApiKey = String(amp.upstreamApiKey || "").trim();
  if (!suggestedUpstreamApiKey && normalizedUpstreamUrl) {
    const discoveredApiKey = await findAmpClientApiKeyForUrl(normalizedUpstreamUrl);
    if (discoveredApiKey) {
      const useDiscoveredKey = await context.prompts.confirm({
        message: `Use the API key already stored in AMP secrets for ${normalizedUpstreamUrl}? (${maskSecret(discoveredApiKey)})`,
        initialValue: true
      });
      if (useDiscoveredKey) {
        suggestedUpstreamApiKey = discoveredApiKey;
      }
    }
  }
  if (!suggestedUpstreamApiKey) {
    info?.("AMP upstream API key was not found in the local AMP config/secrets files.");
    info?.("Open https://ampcode.com/settings, copy an API key, then paste it below.");
  }

  const upstreamApiKey = await context.prompts.text({
    message: "AMP upstream API key (blank clears)",
    required: false,
    initialValue: suggestedUpstreamApiKey
  });
  const restrictManagementToLocalhost = await context.prompts.confirm({
    message: "Restrict AMP management proxying to localhost?",
    initialValue: amp.restrictManagementToLocalhost === true
  });
  const forceModelMappings = await context.prompts.confirm({
    message: "Apply AMP model mappings before local bare-model lookup?",
    initialValue: amp.forceModelMappings === true
  });

  amp.upstreamUrl = String(upstreamUrlInput || "").trim();
  amp.upstreamApiKey = String(upstreamApiKey || "").trim();
  amp.restrictManagementToLocalhost = restrictManagementToLocalhost === true;
  amp.forceModelMappings = forceModelMappings === true;
}

async function promptAmpModelMappingWizard(context, { initialMapping = null } = {}) {
  const from = await context.prompts.text({
    message: "AMP mode/model match pattern",
    required: true,
    initialValue: String(initialMapping?.from || ""),
    placeholder: "gpt-5.4*",
    validate: (value) => String(value || "").trim() ? undefined : "Match pattern is required."
  });
  const to = await context.prompts.text({
    message: "Route target alias or provider/model",
    required: true,
    initialValue: String(initialMapping?.to || ""),
    placeholder: "chat.default",
    validate: (value) => String(value || "").trim() ? undefined : "Route target is required."
  });
  const confirm = await context.prompts.confirm({
    message: initialMapping ? "Save AMP mapping changes?" : "Create this AMP mapping?",
    initialValue: true
  });
  if (!confirm) {
    return { mapping: null, cancelled: true };
  }
  return {
    mapping: {
      from: String(from || "").trim(),
      to: String(to || "").trim()
    },
    cancelled: false
  };
}

async function manageAmpModelMappingsWizard(context, amp) {
  amp.modelMappings = Array.isArray(amp.modelMappings) ? [...amp.modelMappings] : [];

  while (true) {
    const action = await context.prompts.select({
      message: "AMP mode/model mappings",
      options: [
        { value: "review", label: "Review mappings" },
        { value: "add", label: "Add mapping" },
        { value: "edit", label: "Edit mapping" },
        { value: "remove", label: "Remove mapping" },
        { value: "clear", label: "Clear all mappings" },
        { value: "back", label: "Back" }
      ]
    });

    if (action === "back") return;
    if (action === "review") {
      const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
      line?.("AMP Mode/Model Mappings\n" + renderAsciiTable(["Match", "Route"], buildAmpModelMappingRows(amp.modelMappings || []), {
        emptyMessage: "No AMP model mappings configured."
      }));
      continue;
    }
    if (action === "clear") {
      const confirm = await context.prompts.confirm({
        message: "Clear all AMP mode/model mappings?",
        initialValue: false
      });
      if (confirm) amp.modelMappings = [];
      continue;
    }

    if ((action === "edit" || action === "remove") && (amp.modelMappings || []).length === 0) {
      const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
      line?.("No AMP model mappings configured.");
      continue;
    }

    if (action === "remove") {
      const selectedIndex = Number.parseInt(await context.prompts.select({
        message: "Remove AMP mode/model mapping",
        options: buildAmpModelMappingPromptOptions(amp.modelMappings)
      }), 10);
      const selected = amp.modelMappings[selectedIndex];
      const confirm = await context.prompts.confirm({
        message: `Remove '${selected?.from || "(match)"} -> ${selected?.to || "(route)"}'?`,
        initialValue: false
      });
      if (confirm) amp.modelMappings.splice(selectedIndex, 1);
      continue;
    }

    const selectedIndex = action === "edit"
      ? Number.parseInt(await context.prompts.select({
          message: "Edit AMP mode/model mapping",
          options: buildAmpModelMappingPromptOptions(amp.modelMappings)
        }), 10)
      : -1;
    const wizard = await promptAmpModelMappingWizard(context, {
      initialMapping: action === "edit" ? amp.modelMappings[selectedIndex] : null
    });
    if (!wizard.mapping) continue;
    if (action === "edit") {
      amp.modelMappings[selectedIndex] = wizard.mapping;
    } else {
      amp.modelMappings.push(wizard.mapping);
    }
  }
}

async function promptAmpSubagentWizard(context, {
  initialDefinition = null,
  initialTarget = "",
  existingIds = []
} = {}) {
  const originalId = normalizeAmpSubagentIdInput(initialDefinition?.id || "");
  const idInput = await context.prompts.text({
    message: "AMP subagent name",
    required: true,
    initialValue: String(initialDefinition?.id || ""),
    placeholder: "oracle",
    validate: (value) => {
      const normalized = normalizeAmpSubagentIdInput(value);
      if (!normalized) return "Subagent name is required.";
      if (existingIds.includes(normalized) && normalized !== originalId) {
        return `Subagent '${normalized}' already exists.`;
      }
      return undefined;
    }
  });
  const patternsInput = await context.prompts.text({
    message: "Vendor model / mode patterns (comma, pipe, or newline separated)",
    required: true,
    initialValue: (initialDefinition?.patterns || []).join("\n"),
    placeholder: "gpt-5.4\ngpt-5.4*",
    validate: (value) => parseAmpPatternListInput(value).length > 0 ? undefined : "At least one pattern is required."
  });
  const targetInput = await context.prompts.text({
    message: "Local route target alias or provider/model (blank uses defaultModel)",
    required: false,
    initialValue: String(initialTarget || ""),
    placeholder: "chat.default"
  });
  const confirm = await context.prompts.confirm({
    message: initialDefinition ? "Save AMP subagent changes?" : "Create this AMP subagent?",
    initialValue: true
  });
  if (!confirm) {
    return { entry: null, target: "", cancelled: true };
  }

  return {
    entry: {
      id: normalizeAmpSubagentIdInput(idInput),
      patterns: parseAmpPatternListInput(patternsInput)
    },
    target: String(targetInput || "").trim(),
    cancelled: false
  };
}

async function manageAmpSubagentsWizard(context, amp) {
  ensureAmpSubagentMappingsObject(amp);

  while (true) {
    const usingBuiltins = !Array.isArray(amp.subagentDefinitions);
    const action = await context.prompts.select({
      message: usingBuiltins ? "AMP subagents (built-in definitions)" : "AMP subagents (custom definitions)",
      options: [
        { value: "review", label: "Review subagents" },
        { value: "add", label: "Add subagent" },
        { value: "edit", label: "Edit subagent" },
        { value: "remove", label: "Remove subagent" },
        { value: "reset", label: "Reset to built-in defaults" },
        { value: "back", label: "Back" }
      ]
    });

    if (action === "back") return;
    if (action === "review") {
      const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
      line?.("AMP Subagents\n" + renderAsciiTable(["Subagent", "Model Patterns", "Route"], buildAmpSubagentReviewRows(amp), {
        emptyMessage: "No AMP subagent definitions configured."
      }));
      continue;
    }
    if (action === "reset") {
      const confirm = await context.prompts.confirm({
        message: "Reset AMP subagent definitions to built-in defaults?",
        initialValue: usingBuiltins !== true
      });
      if (confirm) {
        delete amp.subagentDefinitions;
        const defaultIds = new Set(DEFAULT_AMP_SUBAGENT_DEFINITIONS.map((entry) => entry.id));
        for (const key of Object.keys(amp.subagentMappings || {})) {
          if (!defaultIds.has(key)) delete amp.subagentMappings[key];
        }
      }
      continue;
    }

    const effectiveDefinitions = getEffectiveAmpSubagentDefinitions(amp);
    if ((action === "edit" || action === "remove") && effectiveDefinitions.length === 0) {
      const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
      line?.("No AMP subagent definitions configured.");
      continue;
    }

    if (action === "remove") {
      ensureCustomAmpSubagentDefinitions(amp);
      const selectedId = await context.prompts.select({
        message: "Remove AMP subagent",
        options: buildAmpSubagentPromptOptions(amp)
      });
      const confirm = await context.prompts.confirm({
        message: `Remove AMP subagent '${selectedId}'?`,
        initialValue: false
      });
      if (!confirm) continue;
      amp.subagentDefinitions = (amp.subagentDefinitions || []).filter((entry) => entry.id !== selectedId);
      delete amp.subagentMappings[selectedId];
      continue;
    }

    const selectedId = action === "edit"
      ? await context.prompts.select({
          message: "Edit AMP subagent",
          options: buildAmpSubagentPromptOptions(amp)
        })
      : "";

    ensureCustomAmpSubagentDefinitions(amp);
    const existingDefinitions = amp.subagentDefinitions || [];
    const initialDefinition = action === "edit"
      ? existingDefinitions.find((entry) => entry.id === selectedId) || null
      : null;
    const initialTarget = action === "edit"
      ? String(amp.subagentMappings?.[selectedId] || "")
      : "";

    const wizard = await promptAmpSubagentWizard(context, {
      initialDefinition,
      initialTarget,
      existingIds: existingDefinitions
        .map((entry) => entry.id)
        .filter((id) => id !== selectedId)
    });
    if (!wizard.entry) continue;

    if (action === "edit") {
      amp.subagentDefinitions = existingDefinitions.map((entry) => entry.id === selectedId ? wizard.entry : entry);
      if (selectedId !== wizard.entry.id) {
        const priorTarget = amp.subagentMappings[selectedId];
        delete amp.subagentMappings[selectedId];
        if (priorTarget && !wizard.target) {
          amp.subagentMappings[wizard.entry.id] = priorTarget;
        }
      }
    } else {
      amp.subagentDefinitions.push(wizard.entry);
    }

    if (wizard.target) {
      amp.subagentMappings[wizard.entry.id] = wizard.target;
    } else {
      delete amp.subagentMappings[wizard.entry.id];
    }
  }
}

async function promptAmpClientPatchPlan(context, {
  config,
  currentPlan = null,
  cwd = process.cwd(),
  env = process.env
} = {}) {
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
  const scope = normalizeAmpClientSettingsScope(await context.prompts.select({
    message: `Where should AMP use ${APP_NAME}?`,
    options: [
      { value: "workspace", label: "This workspace", hint: ".amp/settings.json" },
      { value: "global", label: "All projects", hint: "~/.config/amp/settings.json" }
    ],
    initialValue: normalizeAmpClientSettingsScope(currentPlan?.scope) || "workspace"
  })) || "workspace";

  const endpointUrl = normalizeAmpClientProxyUrl(await suggestAmpClientProxyUrl());
  if (!endpointUrl) {
    throw new Error(`Could not determine a local ${APP_NAME} URL for AMP patching.`);
  }
  line?.(`AMP will send requests to ${endpointUrl}.`);

  let apiKey = String(currentPlan?.apiKey || config?.masterKey || "").trim();
  if (apiKey) {
    const useSuggestedKey = await context.prompts.confirm({
      message: `Use this ${APP_NAME} key for AMP? (${maskSecret(apiKey)})`,
      initialValue: true
    });
    if (!useSuggestedKey) apiKey = "";
  }
  if (!apiKey) {
    apiKey = await promptSecretInput(context, {
      message: `${APP_NAME} API key for AMP`,
      required: true,
      validate: (value) => String(value || "").trim() ? undefined : "API key is required."
    });
  }

  const settingsFilePath = resolveAmpClientSettingsFilePath({
    scope,
    cwd,
    env
  });
  const secretsFilePath = resolveAmpClientSecretsFilePath({ env });
  const confirm = await context.prompts.confirm({
    message: `Update AMP now? Settings: ${settingsFilePath} | Secrets: ${secretsFilePath}`,
    initialValue: true
  });
  if (!confirm) return null;

  return {
    scope,
    settingsFilePath,
    secretsFilePath,
    endpointUrl,
    apiKey: String(apiKey || "").trim()
  };
}

async function resolveAmpClientPatchPlanFromArgs(context, {
  config,
  cwd = process.cwd(),
  env = process.env
} = {}) {
  const args = context.args || {};
  const patchFlag = readArg(args, ["patch-amp-client-config", "patchAmpClientConfig"], undefined);
  const rawScope = readArg(args, ["amp-client-settings-scope", "ampClientSettingsScope"], undefined);
  const explicitSettingsFile = readArg(args, ["amp-client-settings-file", "ampClientSettingsFile"], undefined);
  const explicitSecretsFile = readArg(args, ["amp-client-secrets-file", "ampClientSecretsFile"], undefined);
  const explicitEndpointUrl = readArg(args, ["amp-client-url", "ampClientUrl"], undefined);
  const explicitApiKey = readArg(args, ["amp-client-api-key", "ampClientApiKey"], undefined);
  const patchArgsPresent = [
    rawScope,
    explicitSettingsFile,
    explicitSecretsFile,
    explicitEndpointUrl,
    explicitApiKey
  ].some((value) => value !== undefined);
  const shouldPatch = patchArgsPresent || toBoolean(patchFlag, false);
  if (!shouldPatch) return { plan: null, error: "" };

  const scope = normalizeAmpClientSettingsScope(rawScope || "global");
  if (!scope) {
    return { plan: null, error: `Invalid amp-client-settings-scope '${rawScope}'. Use global or workspace.` };
  }

  const endpointUrl = normalizeAmpClientProxyUrl(explicitEndpointUrl ?? await suggestAmpClientProxyUrl());
  if (!endpointUrl) {
    return { plan: null, error: "amp-client-url must be a valid http:// or https:// URL." };
  }

  let apiKey = String(explicitApiKey ?? config?.masterKey ?? "").trim();
  if (!apiKey && canUseInteractivePrompts(context, ["text", "confirm"])) {
    apiKey = await promptSecretInput(context, {
      message: `Local ${APP_NAME} API key to store in AMP secrets.json`,
      required: true,
      validate: (value) => String(value || "").trim() ? undefined : "API key is required."
    });
  }
  if (!String(apiKey || "").trim()) {
    return { plan: null, error: `amp-client-api-key is required (or set masterKey in config) when patching AMP client files with the local ${APP_NAME} gateway key.` };
  }

  return {
    plan: {
      scope,
      settingsFilePath: resolveAmpClientSettingsFilePath({
        scope,
        explicitPath: explicitSettingsFile || "",
        cwd,
        env
      }),
      secretsFilePath: resolveAmpClientSecretsFilePath({
        explicitPath: explicitSecretsFile || "",
        env
      }),
      endpointUrl,
      apiKey
    },
    error: ""
  };
}

function cloneAmpConfigDraft(amp) {
  const normalized = normalizeRuntimeConfig({ amp }).amp || {};
  return structuredClone(normalized);
}

async function runAmpQuickSetupWizard(context, {
  config,
  amp,
  patchPlan,
  cwd = process.cwd(),
  env = process.env
} = {}) {
  printAmpQuickSetupGuide(context, config);

  const nextPatchPlan = await promptAmpClientPatchPlan(context, {
    config,
    currentPlan: patchPlan,
    cwd,
    env
  });
  if (!nextPatchPlan) {
    return {
      patchPlan,
      errorMessage: ""
    };
  }

  const connectionDefaults = await applyAmpRecommendedAmpConnectionDefaults({
    amp,
    patchPlan: nextPatchPlan,
    env,
    homeDir: os.homedir()
  });
  if (connectionDefaults.error) {
    return {
      patchPlan: nextPatchPlan,
      errorMessage: connectionDefaults.error
    };
  }

  Object.assign(amp, connectionDefaults.amp);
  const initialRoute = resolvePreferredAmpRoute(config, amp);
  if (!initialRoute) {
    return {
      patchPlan: nextPatchPlan,
      errorMessage: "Quick setup needs at least one model alias or provider/model route. Add a provider first, or set defaultModel."
    };
  }

  const defaultRoute = await promptAmpRouteTarget(context, config, {
    message: "Default AMP route",
    initialValue: initialRoute,
    textPlaceholder: "chat.default"
  });
  if (!defaultRoute) {
    return {
      patchPlan: nextPatchPlan,
      errorMessage: "A default AMP route is required for quick setup."
    };
  }

  amp.defaultRoute = defaultRoute;
  return {
    patchPlan: nextPatchPlan,
    errorMessage: ""
  };
}

async function manageAmpRouteEntryWizard(context, config, amp, entry) {
  let currentEntry = entry;

  while (currentEntry) {
    const action = await promptSelectWithEscape(context, {
      message: `AMP route · ${currentEntry.label || currentEntry.inbound}`,
      options: [
        { value: "inbound", label: "Inbound model", hint: currentEntry.editableInbound || currentEntry.inbound },
        { value: "outbound", label: "Outbound model", hint: currentEntry.outbound || "(not set)" }
      ]
    });

    if (action === PROMPT_CANCELLED) return;

    if (action === "inbound") {
      printAmpInboundModelHelp(context, currentEntry);
      const nextInbound = await promptTextWithEscape(context, {
        message: "Inbound AMP model / route key",
        required: true,
        initialValue: currentEntry.editableInbound || currentEntry.inbound,
        placeholder: "smart or gpt-*-codex*",
        validate: (value) => String(value || "").trim() ? undefined : "Inbound model is required."
      });
      if (nextInbound === PROMPT_CANCELLED) continue;
      currentEntry = upsertAmpEditableRoute(amp, currentEntry, {
        inbound: nextInbound,
        outbound: currentEntry.outbound
      });
      continue;
    }

    const nextOutbound = await runPromptWithEscape(() => promptAmpRouteTarget(context, config, {
      message: `Outbound model for ${currentEntry.label || currentEntry.inbound}`,
      initialValue: currentEntry.outbound,
      textPlaceholder: "chat.default"
    }));
    if (nextOutbound === PROMPT_CANCELLED) continue;
    currentEntry = upsertAmpEditableRoute(amp, currentEntry, {
      inbound: currentEntry.inbound,
      outbound: nextOutbound
    });
  }
}

async function manageAmpSimpleRoutesWizard(context, config, amp) {
  ensureAmpRouteCollections(amp);

  while (true) {
    const action = await promptSelectWithEscape(context, {
      message: "AMP routing",
      options: [
        {
          value: "default-route",
          label: "Default AMP route",
          hint: resolvePreferredAmpRoute(config, amp) || "(not set)"
        },
        {
          value: "add-custom-route",
          label: "Add custom route",
          hint: "map key or wildcard"
        },
        ...buildAmpEditableRouteOptions(amp)
      ]
    });

    if (action === PROMPT_CANCELLED) return;

    if (action === "default-route") {
      const nextDefaultRoute = await runPromptWithEscape(() => promptAmpRouteTarget(context, config, {
        message: "Default AMP route",
        initialValue: resolvePreferredAmpRoute(config, amp),
        includeClearOption: true,
        clearLabel: `Use ${APP_NAME} defaultModel`,
        clearHint: config.defaultModel || "no global defaultModel set",
        textPlaceholder: "chat.default"
      }));
      if (nextDefaultRoute === PROMPT_CANCELLED) continue;
      amp.defaultRoute = nextDefaultRoute;
      continue;
    }

    if (action === "add-custom-route") {
      printAmpInboundModelHelp(context);
      const inbound = await promptTextWithEscape(context, {
        message: "Inbound AMP model / route key",
        required: true,
        placeholder: "smart or gpt-*-codex*",
        validate: (value) => String(value || "").trim() ? undefined : "Inbound model is required."
      });
      if (inbound === PROMPT_CANCELLED) continue;

      const outbound = await runPromptWithEscape(() => promptAmpRouteTarget(context, config, {
        message: `Outbound model for ${String(inbound || "").trim()}`,
        initialValue: amp.defaultRoute || resolvePreferredAmpRoute(config, amp) || "",
        textPlaceholder: "chat.default"
      }));
      if (outbound === PROMPT_CANCELLED) continue;

      upsertAmpEditableRoute(amp, null, { inbound, outbound });
      continue;
    }

    const entry = findAmpEditableRouteEntry(amp, action);
    if (!entry) continue;
    await manageAmpRouteEntryWizard(context, config, amp, entry);
  }
}

async function runAmpAdvancedWizard(context, {
  amp,
  config,
  patchPlan,
  cwd = process.cwd(),
  env = process.env
} = {}) {
  let nextPatchPlan = patchPlan;

  while (true) {
    const action = await context.prompts.select({
      message: "AMP advanced",
      options: [
        { value: "proxy", label: "Upstream / proxy", hint: "ampcode.com and upstream key" },
        { value: "mappings", label: "Legacy model-pattern mappings", hint: "advanced fallback matching" },
        { value: "subagents", label: "Legacy subagents", hint: "custom subagent patterns" },
        { value: "back", label: "Back", hint: "return to AMP setup" }
      ]
    });

    if (action === "back") {
      return { patchPlan: nextPatchPlan, errorMessage: "" };
    }
    if (action === "proxy") {
      await promptAmpProxySettings(context, amp);
      continue;
    }
    if (action === "mappings") {
      await manageAmpModelMappingsWizard(context, amp);
      continue;
    }
    if (action === "subagents") {
      await manageAmpSubagentsWizard(context, amp);
      continue;
    }
  }
}

async function runAmpConfigWizard(context, {
  config,
  currentAmp,
  cwd = process.cwd(),
  env = process.env
} = {}) {
  const amp = cloneAmpConfigDraft(currentAmp);
  let patchPlan = null;

  while (true) {
    const action = await promptSelectWithEscape(context, {
      message: "AMP setting",
      options: [
        { value: "patch-client", label: "Connect AMP", hint: "patch AMP config" },
        { value: "routing", label: "Routing", hint: "default route and custom AMP routes" },
        { value: "upstream", label: "Upstream", hint: "ampcode.com and upstream key" },
        { value: "review", label: "Review config", hint: "show current AMP draft" }
      ]
    });

    if (action === PROMPT_CANCELLED) {
      return { amp, patchPlan, cancelled: false };
    }
    if (action === "review") {
      printAmpWizardReview(context, amp, patchPlan);
      continue;
    }
    if (action === "patch-client") {
      const nextPatchPlan = await runPromptWithEscape(() => promptAmpClientPatchPlan(context, {
        config,
        currentPlan: patchPlan,
        cwd,
        env
      }));
      if (nextPatchPlan === PROMPT_CANCELLED || !nextPatchPlan) {
        continue;
      }
      patchPlan = nextPatchPlan;
      if (patchPlan) {
        const connectionDefaults = await applyAmpRecommendedAmpConnectionDefaults({
          amp,
          patchPlan,
          env,
          homeDir: os.homedir()
        });
        if (connectionDefaults.error) {
          return { amp: null, patchPlan: null, cancelled: false, errorMessage: connectionDefaults.error };
        }
        Object.assign(amp, connectionDefaults.amp);
      }
      continue;
    }
    if (action === "routing") {
      await manageAmpSimpleRoutesWizard(context, config, amp);
      continue;
    }
    const upstreamResult = await runPromptWithEscape(() => promptAmpProxySettings(context, amp));
    if (upstreamResult === PROMPT_CANCELLED) continue;
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

function normalizeProviderTypeInput(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === PROVIDER_TYPE_STANDARD) return PROVIDER_TYPE_STANDARD;
  if (normalized === PROVIDER_TYPE_SUBSCRIPTION) return PROVIDER_TYPE_SUBSCRIPTION;
  return "";
}

function normalizeSubscriptionTypeInput(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === SUBSCRIPTION_TYPE_CHATGPT_CODEX) return SUBSCRIPTION_TYPE_CHATGPT_CODEX;
  if (normalized === SUBSCRIPTION_TYPE_CLAUDE_CODE) return SUBSCRIPTION_TYPE_CLAUDE_CODE;
  return "";
}

function getSubscriptionProviderPreset(subscriptionType) {
  return SUBSCRIPTION_PROVIDER_PRESETS.find((preset) => preset.subscriptionType === subscriptionType) || null;
}

function getSupportedSubscriptionTypes() {
  return SUBSCRIPTION_PROVIDER_PRESETS.map((preset) => preset.subscriptionType);
}

function formatSupportedSubscriptionTypes() {
  return getSupportedSubscriptionTypes().join(", ");
}

function getSubscriptionTargetFormat(subscriptionType) {
  const preset = getSubscriptionProviderPreset(subscriptionType);
  return preset?.targetFormat || FORMATS.OPENAI;
}

function getDefaultSubscriptionModelListInput(
  existingProvider,
  fallbackSubscriptionType = SUBSCRIPTION_TYPE_CHATGPT_CODEX
) {
  const existingSubType = normalizeSubscriptionTypeInput(
    existingProvider?.subscriptionType || existingProvider?.subscription_type || ""
  ) || normalizeSubscriptionTypeInput(fallbackSubscriptionType) || SUBSCRIPTION_TYPE_CHATGPT_CODEX;
  const preset = getSubscriptionProviderPreset(existingSubType);
  const existingModels = dedupeList((existingProvider?.models || []).map((model) => model?.id).filter(Boolean));
  const defaults = existingModels.length > 0
    ? existingModels
    : (preset?.defaultModels || CODEX_SUBSCRIPTION_MODELS);
  return defaults.join(",");
}

function resolveLiteLlmContextLookupFn(context) {
  return typeof context?.lookupLiteLlmContextWindow === "function"
    ? context.lookupLiteLlmContextWindow
    : createLiteLlmContextLookupHelper();
}

async function maybeFillMissingModelContextWindows(context, modelIds = [], modelContextWindows = {}, {
  enabled = false
} = {}) {
  const normalizedModelIds = dedupeList(modelIds);
  const nextModelContextWindows = { ...(modelContextWindows || {}) };
  if (!enabled || normalizedModelIds.length === 0) {
    return {
      modelContextWindows: nextModelContextWindows,
      filledCount: 0
    };
  }

  const missingModelIds = normalizedModelIds.filter((modelId) => !normalizeModelContextWindowValue(nextModelContextWindows[modelId]));
  if (missingModelIds.length === 0) {
    return {
      modelContextWindows: nextModelContextWindows,
      filledCount: 0
    };
  }

  const lookupLiteLlmContextWindow = resolveLiteLlmContextLookupFn(context);
  const results = await lookupLiteLlmContextWindow({
    models: missingModelIds,
    limit: 6
  });

  let filledCount = 0;
  for (const result of (Array.isArray(results) ? results : [])) {
    const query = String(result?.query || "").trim();
    const contextWindow = normalizeModelContextWindowValue(result?.exactMatch?.contextWindow);
    if (!query || !contextWindow) continue;
    if (normalizeModelContextWindowValue(nextModelContextWindows[query])) continue;
    nextModelContextWindows[query] = contextWindow;
    filledCount += 1;
  }

  return {
    modelContextWindows: nextModelContextWindows,
    filledCount
  };
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
  const warn = typeof context?.terminal?.warn === "function" ? context.terminal.warn.bind(context.terminal) : null;
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
  const output = warn || line;
  output?.(`Compliance: using provider resources through ${APP_NAME} may violate provider terms. Continue only if you're allowed to do so.`);
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

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function validateEndpointListInput(raw, { allowEmpty = false } = {}) {
  const parsed = parseEndpointListInput(raw);
  if (parsed.length === 0) {
    return allowEmpty ? undefined : "Enter at least one valid endpoint URL (http:// or https://).";
  }
  if (!parsed.every((item) => isValidHttpUrl(item))) {
    return "One or more endpoints are invalid. Use full http:// or https:// URLs.";
  }
  return undefined;
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

function validateProviderModelListInput(raw, { allowEmpty = false } = {}) {
  const parsed = parseProviderModelListInput(raw);
  if (parsed.length === 0) {
    return allowEmpty ? undefined : "Enter at least one valid model id.";
  }
  return undefined;
}

function normalizeModelContextWindowValue(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseModelContextWindowsInput(raw) {
  if (!raw) return {};

  if (typeof raw === "object" && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw)
        .map(([modelId, value]) => [String(modelId || "").trim(), normalizeModelContextWindowValue(value)])
        .filter(([modelId, contextWindow]) => Boolean(modelId && contextWindow))
    );
  }

  const text = String(raw || "").trim();
  if (!text) return {};

  try {
    const parsedJson = JSON.parse(text);
    if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
      return parseModelContextWindowsInput(parsedJson);
    }
  } catch {
    // Fall through to entry parsing.
  }

  const entries = text
    .split(/[\n,]+/g)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const output = {};

  for (const entry of entries) {
    const separatorIndex = entry.search(/\s*(?:=|:)\s*/);
    if (separatorIndex === -1) continue;
    const match = entry.match(/^(.*?)\s*(?:=|:)\s*(.+)$/);
    if (!match) continue;
    const modelId = String(match[1] || "").trim();
    const contextWindow = normalizeModelContextWindowValue(match[2]);
    if (!modelId || !contextWindow) continue;
    output[modelId] = contextWindow;
  }

  return output;
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
    warn?.(`Could not parse any ${label} from the provided text. Use comma-separated values (for example: a,b,c).`);
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
      message: "Add unresolved models (comma-separated, optional)",
      initialValue: unresolvedModels.join(","),
      validate: (value) => validateProviderModelListInput(value, { allowEmpty: true })
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
      validate: (value) => validateEndpointListInput(value, { allowEmpty: true })
    });
    openaiBase = parseEndpointListInput(openaiInput)[0] || "";
  }

  let claudeBase = String(effectiveClaudeBaseUrl || "").trim();
  if (!claudeBase) {
    const claudeInput = await context.prompts.text({
      message: "Anthropic-compatible endpoint for unresolved items (optional)",
      initialValue: "",
      validate: (value) => validateEndpointListInput(value, { allowEmpty: true })
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
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
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

function resolveUniqueProviderId(baseId, providers, { excludeId = "" } = {}) {
  const normalizedBase = slugifyId(baseId || "provider");
  const excluded = String(excludeId || "").trim();
  const reservedIds = new Set((providers || [])
    .map((provider) => String(provider?.id || "").trim())
    .filter((id) => id && id !== excluded));
  if (!reservedIds.has(normalizedBase)) return normalizedBase;

  let suffix = 2;
  let candidate = `${normalizedBase}-${suffix}`;
  while (reservedIds.has(candidate)) {
    suffix += 1;
    candidate = `${normalizedBase}-${suffix}`;
  }
  return candidate;
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

function formatRequestFormatLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === FORMATS.OPENAI) return "OpenAI";
  if (normalized === FORMATS.CLAUDE) return "Claude";
  return normalized;
}

function formatRequestFormatList(values, fallback = "") {
  const formats = dedupeList([
    ...(Array.isArray(values) ? values : []),
    ...(fallback ? [fallback] : [])
  ]).map(formatRequestFormatLabel).filter(Boolean);
  return formats.join(", ") || "Unknown";
}

function formatProviderTypeLabel(type) {
  const normalized = normalizeProviderTypeInput(type) || PROVIDER_TYPE_STANDARD;
  return normalized === PROVIDER_TYPE_SUBSCRIPTION ? "Subscription (OAuth)" : "Standard (API Key)";
}

function formatModelAliasStrategyLabel(strategy) {
  const normalized = normalizeModelAliasStrategy(strategy) || "ordered";
  return MODEL_ROUTING_STRATEGY_OPTIONS.find((option) => option.value === normalized)?.label || normalized;
}

function formatItemCount(count, singular, plural = `${singular}s`) {
  const safeCount = Number.isFinite(Number(count)) ? Number(count) : 0;
  return `${safeCount} ${safeCount === 1 ? singular : plural}`;
}

function summarizeProviderPromptHint(provider) {
  if (!provider || typeof provider !== "object") return "";
  const parts = [];
  const providerName = String(provider.name || "").trim();
  const providerId = String(provider.id || "").trim();
  if (providerName && providerName !== providerId) parts.push(providerName);
  parts.push(normalizeProviderTypeInput(provider.type) === PROVIDER_TYPE_SUBSCRIPTION ? "OAuth" : "API key");
  parts.push(formatItemCount((provider.models || []).length, "model"));
  return parts.join(" · ");
}

function buildProviderPromptOptions(providers, { includeCreateOption = false, createLabel = "New provider", createHint = "connect API key or OAuth" } = {}) {
  return [
    ...(includeCreateOption
      ? [{ value: "__new__", label: createLabel, hint: createHint }]
      : []),
    ...(providers || []).map((provider) => ({
      value: provider.id,
      label: provider.id || provider.name || "(unknown provider)",
      hint: summarizeProviderPromptHint(provider)
    }))
  ];
}

function summarizeAliasPromptHint(alias) {
  if (!alias || typeof alias !== "object") return "";
  const targetCount = Array.isArray(alias.targets) ? alias.targets.length : 0;
  const fallbackCount = Array.isArray(alias.fallbackTargets) ? alias.fallbackTargets.length : 0;
  const parts = [
    formatModelAliasStrategyLabel(alias.strategy),
    formatItemCount(targetCount, "target")
  ];
  if (fallbackCount > 0) parts.push(formatItemCount(fallbackCount, "fallback"));
  return parts.join(" · ");
}

function buildAliasPromptOptions(aliases, {
  includeCreateOption = false,
  createLabel = "New alias",
  createHint = "group routes under one name"
} = {}) {
  const entries = Object.entries(aliases || {});
  return [
    ...(includeCreateOption
      ? [{ value: "__new__", label: createLabel, hint: createHint }]
      : []),
    ...entries.map(([aliasId, alias]) => ({
      value: aliasId,
      label: aliasId,
      hint: summarizeAliasPromptHint(alias)
    }))
  ];
}

function countConfiguredRateLimitBuckets(config) {
  return (config?.providers || []).reduce((sum, provider) => sum + (provider?.rateLimits || []).length, 0);
}

function countConfiguredFallbackRoutes(config) {
  return (config?.providers || []).reduce((sum, provider) => {
    return sum + (provider?.models || []).filter((model) => Array.isArray(model?.fallbackModels) && model.fallbackModels.length > 0).length;
  }, 0);
}

function hasConfiguredAmp(config) {
  const amp = config?.amp;
  if (!amp || typeof amp !== "object") return false;
  return Object.values(amp).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return String(value || "").trim() !== "";
  });
}

function formatReportCell(value, { fallback = "-", maxLength = 180 } = {}) {
  const compact = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return fallback;
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 3))}...`;
}

function renderAsciiTable(headers, rows, { emptyMessage = "No entries." } = {}) {
  const normalizedHeaders = (headers || []).map((header) => formatReportCell(header, { fallback: "", maxLength: 120 }));
  const normalizedRows = (rows || []).map((row) => normalizedHeaders.map((_, index) => {
    const cell = Array.isArray(row) ? row[index] : undefined;
    return formatReportCell(cell);
  }));
  if (normalizedRows.length === 0) return emptyMessage;

  const widths = normalizedHeaders.map((header, index) => Math.max(
    header.length,
    ...normalizedRows.map((row) => row[index].length)
  ));
  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const renderRow = (cells) => `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`;

  return [
    border,
    renderRow(normalizedHeaders),
    border,
    ...normalizedRows.map((row) => renderRow(row)),
    border
  ].join("\n");
}

function buildProviderEndpointRows(provider) {
  const rows = [];
  const seenUrls = new Set();
  const addRow = (label, url) => {
    const value = String(url || "").trim();
    if (!value || seenUrls.has(value)) return;
    seenUrls.add(value);
    rows.push([label, value]);
  };

  addRow("OpenAI Endpoint", provider?.baseUrlByFormat?.openai);
  addRow("Claude Endpoint", provider?.baseUrlByFormat?.claude);
  addRow("Primary Endpoint", provider?.baseUrl);

  if (rows.length === 0 && normalizeProviderTypeInput(provider?.type) === PROVIDER_TYPE_SUBSCRIPTION) {
    rows.push(["Endpoint", "Managed by OAuth subscription provider"]);
  }
  return rows;
}

function buildProviderModelRows(provider) {
  const providerFormats = dedupeList([
    ...(provider?.formats || []),
    ...(provider?.format ? [provider.format] : [])
  ]);
  return (provider?.models || []).map((model) => ([
    model?.id || "(unknown)",
    Number.isFinite(Number(model?.contextWindow)) ? String(Math.floor(Number(model.contextWindow))) : "Unknown",
    formatRequestFormatList(dedupeList([...(model?.formats || []), ...providerFormats])),
    dedupeList(model?.fallbackModels || []).join(", ") || "None"
  ]));
}

function buildRateLimitBucketRows(rateLimits) {
  return (rateLimits || []).map((bucket) => {
    const requests = Number.parseInt(String(bucket?.requests ?? ""), 10);
    const requestLimit = Number.isFinite(requests) && requests > 0
      ? `${new Intl.NumberFormat("en-US").format(requests)} requests`
      : "(unset)";
    return [
      formatRateLimitBucketLabel(bucket),
      String(bucket?.id || "(not set)").trim() || "(not set)",
      formatRateLimitBucketScopeLabel(bucket),
      requestLimit,
      formatRateLimitWindowForHuman(bucket?.window)
    ];
  });
}

function joinReportSections(...sections) {
  return sections.filter((section) => String(section || "").trim().length > 0).join("\n\n");
}

function formatYesNo(value) {
  return value ? "Yes" : "No";
}

function renderKeyValueSection(title, rows) {
  return `${title}\n${renderAsciiTable(["Field", "Value"], rows || [])}`;
}

function renderListSection(title, items, { emptyMessage = "None." } = {}) {
  const normalized = (items || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (normalized.length === 0) return `${title}\n${emptyMessage}`;
  return `${title}\n${normalized.map((item) => `- ${item}`).join("\n")}`;
}

function buildOperationReport(title, rows, extraSections = []) {
  return joinReportSections(
    title,
    renderKeyValueSection("Overview", rows),
    ...extraSections
  );
}

function buildConfigValidationReport({
  configPath,
  exists,
  normalizedConfig,
  parseError,
  validationErrors
}) {
  const providers = Array.isArray(normalizedConfig?.providers) ? normalizedConfig.providers : [];
  const aliasCount = normalizedConfig?.modelAliases && typeof normalizedConfig.modelAliases === "object" && !Array.isArray(normalizedConfig.modelAliases)
    ? Object.keys(normalizedConfig.modelAliases).length
    : 0;
  const issues = parseError
    ? [`JSON parse error: ${parseError}`]
    : validationErrors;

  return buildOperationReport(
    "Config Validation",
    [
      ["Config File", configPath],
      ["Exists", formatYesNo(Boolean(exists))],
      ["JSON Parse", parseError ? "Failed" : "Passed"],
      ["Validation", parseError ? "Blocked by parse error" : (validationErrors.length === 0 ? "Passed" : `Failed (${validationErrors.length} issue(s))`)],
      ["Schema Version", normalizedConfig?.version ? String(normalizedConfig.version) : "(unknown)"],
      ["Providers", String(providers.length)],
      ["Model Aliases", String(aliasCount)],
      ["Rate-Limit Buckets", String(countConfiguredRateLimitBuckets(normalizedConfig))],
      ["Master Key Configured", formatYesNo(Boolean(normalizedConfig?.masterKey))]
    ],
    [
      renderListSection("Issues", issues, { emptyMessage: "None." })
    ]
  );
}

function buildModelAliasTargetRows(targets) {
  return (targets || []).map((target) => ([
    target?.ref || "(invalid target)",
    Number.isFinite(target?.weight) ? String(Number(target.weight)) : "Default"
  ]));
}

function buildProviderSavedReport({
  provider,
  configPath,
  probe,
  masterKey
}) {
  const detailsRows = [
    ["Config File", configPath],
    ["Provider ID", provider?.id || "(unknown)"],
    ["Provider Name", provider?.name || provider?.id || "(unknown)"],
    ["Provider Type", formatProviderTypeLabel(provider?.type)],
    ["Request Formats", formatRequestFormatList(provider?.formats, provider?.format)],
    ["API Credential", normalizeProviderTypeInput(provider?.type) === PROVIDER_TYPE_SUBSCRIPTION
      ? "Managed by OAuth session"
      : (provider?.apiKey || "(from env/hidden)")]
  ];
  if (provider?.subscriptionType) detailsRows.push(["Subscription Type", provider.subscriptionType]);
  if (provider?.subscriptionProfile) detailsRows.push(["Subscription Profile", provider.subscriptionProfile]);
  detailsRows.push(["Master Key", masterKey || "(not set)"]);

  const probeRows = probe
    ? [
      ["Auto-detection", probe.ok ? "Completed" : "Needs review"],
      ["Preferred Request Format", formatRequestFormatLabel(probe.preferredFormat) || "(unknown)"],
      ["Working Formats", formatRequestFormatList(probe.workingFormats || [])]
    ]
    : [["Auto-detection", "Skipped"]];

  return joinReportSections(
    "Provider Saved",
    "Overview\n" + renderAsciiTable(["Field", "Value"], detailsRows),
    "Endpoint Mapping\n" + renderAsciiTable(["Endpoint Type", "URL"], buildProviderEndpointRows(provider), {
      emptyMessage: "No endpoints configured."
    }),
    "Models\n" + renderAsciiTable(["Model", "Context Window", "Request Format(s)", "Silent Fallbacks"], buildProviderModelRows(provider), {
      emptyMessage: "No models configured."
    }),
    "Rate-Limit Buckets\n" + renderAsciiTable(["Bucket", "Bucket ID", "Scope", "Request Limit", "Time Window"], buildRateLimitBucketRows(provider?.rateLimits || []), {
      emptyMessage: "No rate-limit buckets configured."
    }),
    "Detection Summary\n" + renderAsciiTable(["Check", "Result"], probeRows)
  );
}

function buildModelAliasSavedReport(aliasId, alias) {
  return joinReportSections(
    "Model Alias Saved",
    "Overview\n" + renderAsciiTable(["Field", "Value"], [
      ["Alias ID", aliasId || "(unknown)"],
      ["Routing Strategy", formatModelAliasStrategyLabel(alias?.strategy)]
    ]),
    "Primary Routes\n" + renderAsciiTable(["Model Route", "Weight"], buildModelAliasTargetRows(alias?.targets || []), {
      emptyMessage: "No primary routes configured."
    }),
    "Fallback Routes\n" + renderAsciiTable(["Model Route", "Weight"], buildModelAliasTargetRows(alias?.fallbackTargets || []), {
      emptyMessage: "No fallback routes configured."
    })
  );
}

function buildProviderRateLimitReport({
  title,
  providerId,
  rateLimits
}) {
  return joinReportSections(
    title || "Rate-Limit Buckets",
    "Overview\n" + renderAsciiTable(["Field", "Value"], [
      ["Provider ID", providerId || "(unknown)"],
      ["Total Buckets", String((rateLimits || []).length)]
    ]),
    "Buckets\n" + renderAsciiTable(["Bucket", "Bucket ID", "Scope", "Request Limit", "Time Window"], buildRateLimitBucketRows(rateLimits || []), {
      emptyMessage: "No rate-limit buckets configured."
    })
  );
}

function buildAmpModelMappingRows(mappings) {
  return (mappings || []).map((mapping) => ([
    mapping?.from || "(not set)",
    mapping?.to || "(not set)"
  ]));
}

function buildAmpSubagentMappingRows(mappings) {
  return Object.entries(mappings && typeof mappings === "object" ? mappings : {}).map(([agent, to]) => ([
    agent || "(not set)",
    to || "(not set)"
  ]));
}

function buildAmpRouteRows(mappings) {
  return Object.entries(mappings && typeof mappings === "object" ? mappings : {}).map(([key, to]) => ([
    key || "(not set)",
    to || "(not set)"
  ]));
}

function buildAmpSubagentDefinitionRows(definitions) {
  return (Array.isArray(definitions) ? definitions : []).map((entry) => ([
    entry?.id || "(not set)",
    Array.isArray(entry?.patterns) ? entry.patterns.join(" | ") : "(not set)"
  ]));
}

function buildAmpConfigSection(amp) {
  const source = amp && typeof amp === "object" && !Array.isArray(amp) ? amp : {};
  const subagentMappings = source.subagentMappings && typeof source.subagentMappings === "object" ? source.subagentMappings : {};
  const subagentDefinitions = Array.isArray(source.subagentDefinitions) ? source.subagentDefinitions : undefined;
  const routes = source.routes && typeof source.routes === "object" ? source.routes : {};
  const rawModelRoutes = Array.isArray(source.rawModelRoutes) ? source.rawModelRoutes : [];
  return joinReportSections(
    "AMP / Amp CLI\n" + renderAsciiTable(["Field", "Value"], [
      ["Upstream URL", source.upstreamUrl || "(disabled)"],
      ["Upstream API Key", source.upstreamApiKey || "(not set)"],
      ["Restrict Management To Localhost", formatYesNo(source.restrictManagementToLocalhost === true)],
      ["Force Model Mappings", formatYesNo(source.forceModelMappings === true)],
      ["Preset", source.preset || "builtin"],
      ["AMP Default Route", source.defaultRoute || "(global defaultModel)"],
      ["AMP Route Count", String(Object.keys(routes).length)],
      ["AMP Raw Model Route Count", String(rawModelRoutes.length)],
      ["AMP Overrides", source.overrides ? "configured" : "(none)"],
      ["Model Mapping Count", String((source.modelMappings || []).length)],
      ["Subagent Mapping Count", String(Object.keys(subagentMappings).length)],
      ["Subagent Definition Count", subagentDefinitions === undefined ? "default" : String(subagentDefinitions.length)]
    ]),
    "AMP Entity / Signature Routes\n" + renderAsciiTable(["Key", "Route"], buildAmpRouteRows(routes), {
      emptyMessage: "No AMP routes configured."
    }),
    "AMP Raw Model Routes\n" + renderAsciiTable(["Match", "Route"], buildAmpModelMappingRows(rawModelRoutes), {
      emptyMessage: "No AMP raw model routes configured."
    }),
    "AMP Model Mappings\n" + renderAsciiTable(["Match", "Route"], buildAmpModelMappingRows(source.modelMappings || []), {
      emptyMessage: "No AMP model mappings configured."
    }),
    "AMP Subagent Definitions\n" + renderAsciiTable(["Subagent", "Model Patterns"], buildAmpSubagentDefinitionRows(subagentDefinitions || []), {
      emptyMessage: subagentDefinitions === undefined
        ? "Using built-in AMP subagent definitions."
        : "No AMP subagent definitions configured."
    }),
    "AMP Subagent Mappings\n" + renderAsciiTable(["Subagent", "Route"], buildAmpSubagentMappingRows(subagentMappings), {
      emptyMessage: "No AMP subagent mappings configured."
    })
  );
}

function buildProviderConfigSection(provider) {
  const infoRows = [
    ["Provider ID", provider?.id || "(unknown)"],
    ["Provider Name", provider?.name || provider?.id || "(unknown)"],
    ["Provider Type", formatProviderTypeLabel(provider?.type)],
    ["Request Formats", formatRequestFormatList(provider?.formats, provider?.format)],
    ["API Credential", normalizeProviderTypeInput(provider?.type) === PROVIDER_TYPE_SUBSCRIPTION
      ? "Managed by OAuth session"
      : (provider?.apiKey || "(from env/hidden)")]
  ];
  if (provider?.subscriptionType) infoRows.push(["Subscription Type", provider.subscriptionType]);
  if (provider?.subscriptionProfile) infoRows.push(["Subscription Profile", provider.subscriptionProfile]);

  return joinReportSections(
    `Provider: ${provider?.name || provider?.id || "(unknown)"}`,
    "Provider Details\n" + renderAsciiTable(["Field", "Value"], infoRows),
    "Endpoint Mapping\n" + renderAsciiTable(["Endpoint Type", "URL"], buildProviderEndpointRows(provider), {
      emptyMessage: "No endpoints configured."
    }),
    "Models\n" + renderAsciiTable(["Model", "Context Window", "Request Format(s)", "Silent Fallbacks"], buildProviderModelRows(provider), {
      emptyMessage: "No models configured."
    }),
    "Rate-Limit Buckets\n" + renderAsciiTable(["Bucket", "Bucket ID", "Scope", "Request Limit", "Time Window"], buildRateLimitBucketRows(provider?.rateLimits || []), {
      emptyMessage: "No rate-limit buckets configured."
    })
  );
}

export function summarizeConfig(config, configPath, { includeSecrets = false } = {}) {
  const target = includeSecrets ? config : sanitizeConfigForDisplay(config);
  const providers = Array.isArray(target?.providers) ? target.providers : [];
  const aliasEntries = Object.entries(target?.modelAliases || {});

  const providerSummaryRows = providers.map((provider) => [
    provider?.id || "(unknown)",
    provider?.name || provider?.id || "(unknown)",
    formatProviderTypeLabel(provider?.type),
    formatRequestFormatList(provider?.formats, provider?.format),
    String((provider?.models || []).length),
    String((provider?.rateLimits || []).length)
  ]);

  const aliasRows = aliasEntries.map(([aliasId, alias]) => ([
    aliasId,
    formatModelAliasStrategyLabel(alias?.strategy),
    formatAliasTargetsForSummary(alias?.targets),
    formatAliasTargetsForSummary(alias?.fallbackTargets)
  ]));

  return joinReportSections(
    "Current Router Configuration",
    "Overview\n" + renderAsciiTable(["Field", "Value"], [
      ["Config File", configPath],
      ["Schema Version", String(target?.version || 1)],
      ["Default Route", target?.defaultModel || "(not set)"],
      ["Master Key", target?.masterKey || "(not set)"]
    ]),
    buildAmpConfigSection(target?.amp),
    "Providers\n" + renderAsciiTable(
      ["Provider ID", "Name", "Type", "Request Formats", "Models", "Rate-Limit Buckets"],
      providerSummaryRows,
      { emptyMessage: "No providers configured." }
    ),
    ...providers.map((provider) => buildProviderConfigSection(provider)),
    "Model Aliases\n" + renderAsciiTable(
      ["Alias ID", "Routing Strategy", "Primary Routes", "Fallback Routes"],
      aliasRows,
      { emptyMessage: "No model aliases configured." }
    )
  );
}

function pickDefaultManagedRoute(config = {}) {
  const configuredDefault = String(config?.defaultModel || "").trim();
  if (configuredDefault) return configuredDefault;

  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? Object.keys(config.modelAliases).map((aliasId) => String(aliasId || "").trim()).filter(Boolean)
    : [];
  if (aliases.length > 0) return aliases[0];

  for (const provider of Array.isArray(config?.providers) ? config.providers : []) {
    if (provider?.enabled === false) continue;
    const providerId = String(provider?.id || "").trim();
    if (!providerId) continue;
    const model = Array.isArray(provider?.models)
      ? provider.models.find((entry) => entry?.enabled !== false && String(entry?.id || "").trim())
      : null;
    if (model?.id) return `${providerId}/${model.id}`;
  }

  return "";
}

function normalizeCodexBindingState(bindings = {}) {
  const source = bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings : {};
  const defaultModel = String(source.defaultModel || "").trim();
  return {
    defaultModel: isCodexCliInheritModelBinding(defaultModel)
      ? CODEX_CLI_INHERIT_MODEL_VALUE
      : defaultModel,
    thinkingLevel: normalizeCodexCliReasoningEffort(source.thinkingLevel)
  };
}

function normalizeCodexBindingsInput(bindings = {}, config = {}) {
  const normalized = normalizeCodexBindingState(bindings);
  return {
    defaultModel: isCodexCliInheritModelBinding(normalized.defaultModel)
      ? CODEX_CLI_INHERIT_MODEL_VALUE
      : (normalized.defaultModel || pickDefaultManagedRoute(config)),
    thinkingLevel: normalized.thinkingLevel
  };
}

function normalizeClaudeBindingState(bindings = {}) {
  const source = bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings : {};
  return {
    primaryModel: String(source.primaryModel || "").trim(),
    defaultOpusModel: String(source.defaultOpusModel || "").trim(),
    defaultSonnetModel: String(source.defaultSonnetModel || "").trim(),
    defaultHaikuModel: String(source.defaultHaikuModel || "").trim(),
    subagentModel: String(source.subagentModel || "").trim(),
    thinkingLevel: normalizeClaudeCodeEffortLevel(source.thinkingLevel)
  };
}

function listManagedDirectRouteRefs(config = {}) {
  const routeRefs = new Set();

  for (const provider of Array.isArray(config?.providers) ? config.providers : []) {
    if (provider?.enabled === false) continue;
    const providerId = String(provider?.id || "").trim();
    if (!providerId) continue;
    for (const model of Array.isArray(provider?.models) ? provider.models : []) {
      if (model?.enabled === false) continue;
      const modelId = String(model?.id || "").trim();
      if (!modelId) continue;
      routeRefs.add(`${providerId}/${modelId}`);
    }
  }

  return [...routeRefs];
}

function describeManagedAlias(aliasId, alias = null) {
  const primaryTargets = dedupeList(Array.isArray(alias?.targets) ? alias.targets.map((target) => target?.ref) : []);
  const fallbackTargets = dedupeList(Array.isArray(alias?.fallbackTargets) ? alias.fallbackTargets.map((target) => target?.ref) : []);

  if (primaryTargets.length === 0 && fallbackTargets.length === 0) {
    return `LLM Router alias '${aliasId}'.`;
  }

  const parts = [];
  if (primaryTargets.length > 0) {
    parts.push(`Routes to ${primaryTargets.join(", ")}`);
  }
  if (fallbackTargets.length > 0) {
    parts.push(`fallbacks ${fallbackTargets.join(", ")}`);
  }
  return `${parts.join("; ")}.`;
}

function describeManagedDirectRoute(routeRef, config = {}) {
  const normalizedRef = String(routeRef || "").trim();
  if (!normalizedRef || !normalizedRef.includes("/")) {
    return normalizedRef ? `LLM Router route '${normalizedRef}'.` : "LLM Router route.";
  }

  const slashIndex = normalizedRef.indexOf("/");
  const providerId = normalizedRef.slice(0, slashIndex).trim();
  const modelId = normalizedRef.slice(slashIndex + 1).trim();
  const provider = Array.isArray(config?.providers)
    ? config.providers.find((entry) => String(entry?.id || "").trim() === providerId)
    : null;
  const providerName = String(provider?.name || providerId).trim() || providerId;
  const model = Array.isArray(provider?.models)
    ? provider.models.find((entry) => String(entry?.id || "").trim() === modelId)
    : null;
  const fallbackModels = dedupeList(Array.isArray(model?.fallbackModels) ? model.fallbackModels : []);

  if (fallbackModels.length > 0) {
    return `LLM Router route to ${providerName} model '${modelId}' with fallbacks ${fallbackModels.join(", ")}.`;
  }
  return `LLM Router route to ${providerName} model '${modelId}'.`;
}

function createCodexCliModelCatalogEntry(slug, description) {
  return {
    slug,
    display_name: slug,
    description,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "minimal", description: "Minimum reasoning for the fastest supported responses" },
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { effort: "high", description: "Greater reasoning depth for complex problems" },
      { effort: "xhigh", description: "Extra high reasoning depth for complex problems on supported models" }
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    upgrade: null,
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supports_reasoning_summaries: true,
    default_reasoning_summary: "auto",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    truncation_policy: {
      mode: "tokens",
      limit: 10000
    },
    supports_parallel_tool_calls: true,
    context_window: 272000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    prefer_websockets: false
  };
}

function buildCodexCliModelCatalog(config = {}, bindings = {}) {
  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};
  const boundModel = String(bindings?.defaultModel || "").trim();
  if (isCodexCliInheritModelBinding(boundModel)) {
    return { models: [] };
  }

  const catalogEntries = new Map();
  const aliasIds = new Set(
    Object.keys(aliases)
      .map((aliasId) => String(aliasId || "").trim())
      .filter((aliasId) => aliasId && aliasId !== DEFAULT_MODEL_ALIAS_ID)
  );
  const directRouteRefs = new Set(listManagedDirectRouteRefs(config));

  if (boundModel) {
    if (boundModel.includes("/")) directRouteRefs.add(boundModel);
    else aliasIds.add(boundModel);
  }

  for (const aliasId of aliasIds) {
    catalogEntries.set(aliasId, createCodexCliModelCatalogEntry(
      aliasId,
      describeManagedAlias(aliasId, aliases[aliasId])
    ));
  }
  for (const routeRef of directRouteRefs) {
    catalogEntries.set(routeRef, createCodexCliModelCatalogEntry(
      routeRef,
      describeManagedDirectRoute(routeRef, config)
    ));
  }

  const models = [...catalogEntries.values()]
    .sort((left, right) => String(left.slug).localeCompare(String(right.slug)));
  return models.length > 0 ? { models } : undefined;
}

function formatCodexBindingLabel(defaultModel = "") {
  return isCodexCliInheritModelBinding(defaultModel)
    ? "Inherit Codex CLI model"
    : (String(defaultModel || "").trim() || "No model selected");
}

async function readAmpClientRoutingStates({
  cwd = process.cwd(),
  env = process.env,
  endpointUrl = LOCAL_ROUTER_ORIGIN,
  settingsScope = "",
  settingsFilePath = ""
} = {}) {
  const scopes = settingsScope ? [normalizeAmpClientSettingsScope(settingsScope)] : ["global", "workspace"];
  const states = [];

  for (const scope of scopes.filter(Boolean)) {
    const resolvedSettingsFilePath = scope === normalizeAmpClientSettingsScope(settingsScope)
      ? String(settingsFilePath || "").trim()
      : "";
    const state = await readAmpClientRoutingStateFile({
      scope,
      settingsFilePath: resolvedSettingsFilePath,
      endpointUrl,
      cwd,
      env
    });
    states.push({
      ...state,
      secretsFilePath: resolveAmpClientSecretsFilePath({ env })
    });
  }

  return states;
}

async function buildCodingToolRoutingSnapshot({
  config,
  cwd = process.cwd(),
  env = process.env,
  args = {}
} = {}) {
  const endpointUrl = String(readArg(args, ["endpoint-url", "endpointUrl"], LOCAL_ROUTER_ORIGIN) || LOCAL_ROUTER_ORIGIN).trim();
  const ampStates = await readAmpClientRoutingStates({
    cwd,
    env,
    endpointUrl,
    settingsScope: readArg(args, ["amp-client-settings-scope", "ampClientSettingsScope"], ""),
    settingsFilePath: readArg(args, ["amp-client-settings-file", "ampClientSettingsFile"], "")
  }).catch((error) => ([{
    scope: "global",
    settingsFilePath: resolveAmpClientSettingsFilePath({ scope: "global", cwd, env }),
    secretsFilePath: resolveAmpClientSecretsFilePath({ env }),
    configuredUrl: "",
    routedViaRouter: false,
    settingsExists: false,
    error: error instanceof Error ? error.message : String(error)
  }]));
  const codexCli = await readCodexCliRoutingState({
    configFilePath: readArg(args, ["codex-config-file", "codexConfigFile"], ""),
    endpointUrl,
    env
  }).catch((error) => ({
    tool: "codex-cli",
    configFilePath: resolveCodexCliConfigFilePath({ env }),
    backupFilePath: "",
    configuredBaseUrl: "",
    configuredModelCatalogJson: "",
    bindings: {
      defaultModel: "",
      thinkingLevel: ""
    },
    routedViaRouter: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  const claudeCode = await readClaudeCodeRoutingState({
    settingsFilePath: readArg(args, ["claude-code-settings-file", "claudeCodeSettingsFile", "claude-settings-file", "claudeSettingsFile"], ""),
    endpointUrl,
    env
  }).catch((error) => ({
    tool: "claude-code",
    settingsFilePath: resolveClaudeCodeSettingsFilePath({ env }),
    backupFilePath: "",
    configuredBaseUrl: "",
    bindings: {
      primaryModel: "",
      defaultOpusModel: "",
      defaultSonnetModel: "",
      defaultHaikuModel: "",
      subagentModel: "",
      thinkingLevel: ""
    },
    routedViaRouter: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  return {
    endpointUrl,
    ampStates,
    codexCli,
    claudeCode,
    masterKeyConfigured: Boolean(String(config?.masterKey || "").trim())
  };
}

function buildAmpClientStatusSection(ampStates = []) {
  const rows = ampStates.map((state) => ([
    state.scope || "(unknown)",
    formatYesNo(state.routedViaRouter === true),
    state.configuredUrl || "(not set)",
    state.settingsFilePath || "(not found)"
  ]));

  return joinReportSections(
    "AMP Client",
    renderAsciiTable(["Scope", "Routed Via Router", "Configured URL", "Settings File"], rows, {
      emptyMessage: "No AMP client settings found."
    }),
    renderListSection("Errors", ampStates.map((state) => state.error), { emptyMessage: "None." }),
    renderListSection("Secrets", dedupeList(ampStates.map((state) => state.secretsFilePath)), {
      emptyMessage: "No AMP secrets file detected."
    })
  );
}

function buildCodexCliStatusSection(state = {}) {
  return renderKeyValueSection("Codex CLI", [
    ["Routed Via Router", formatYesNo(state.routedViaRouter === true)],
    ["Config File", state.configFilePath || resolveCodexCliConfigFilePath()],
    ["Backup File", state.backupFilePath || "(not created)"],
    ["Base URL", state.configuredBaseUrl || "(not set)"],
    ["Model Binding", formatCodexBindingLabel(state.bindings?.defaultModel)],
    ["Thinking Level", state.bindings?.thinkingLevel || "(not set)"],
    ["Model Catalog", state.configuredModelCatalogJson || "(not set)"],
    ["Error", state.error || "(none)"]
  ]);
}

function buildClaudeCodeStatusSection(state = {}) {
  return renderKeyValueSection("Claude Code", [
    ["Routed Via Router", formatYesNo(state.routedViaRouter === true)],
    ["Settings File", state.settingsFilePath || resolveClaudeCodeSettingsFilePath()],
    ["Backup File", state.backupFilePath || "(not created)"],
    ["Base URL", state.configuredBaseUrl || "(not set)"],
    ["Primary Model", state.bindings?.primaryModel || "(not set)"],
    ["Default Opus", state.bindings?.defaultOpusModel || "(not set)"],
    ["Default Sonnet", state.bindings?.defaultSonnetModel || "(not set)"],
    ["Default Haiku", state.bindings?.defaultHaikuModel || "(not set)"],
    ["Subagent Model", state.bindings?.subagentModel || "(not set)"],
    ["Thinking Level", state.bindings?.thinkingLevel || "(not set)"],
    ["Error", state.error || "(none)"]
  ]);
}

function buildProviderDiagnosticOverview(result = {}) {
  return [
    ["Working Formats", (result.workingFormats || []).join(", ") || "(none)"],
    ["Preferred Format", result.preferredFormat || "(not detected)"],
    ["OpenAI Endpoint", result.baseUrlByFormat?.openai || "(not detected)"],
    ["Claude Endpoint", result.baseUrlByFormat?.claude || "(not detected)"],
    ["Models", new Intl.NumberFormat("en-US").format((result.models || []).length)],
    ["Warnings", new Intl.NumberFormat("en-US").format((result.warnings || []).length)]
  ];
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

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return toBoolean(value, false);
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

function runNpmViewLatestVersion(packageName) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return runCommand(npmCmd, ["view", packageName, "version", "--json"]);
}

function parseNpmVersionOutput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed.trim();
    if (Array.isArray(parsed)) {
      const last = parsed.findLast?.((value) => typeof value === "string" && value.trim())
        ?? [...parsed].reverse().find((value) => typeof value === "string" && value.trim());
      return typeof last === "string" ? last.trim() : "";
    }
  } catch {
    // Fall through to raw text handling.
  }
  return trimmed.replace(/^"+|"+$/g, "");
}

async function readCurrentPackageVersion() {
  try {
    const raw = await fsPromises.readFile(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" ? parsed.version.trim() : "";
  } catch {
    return "";
  }
}

async function resolveLatestCliPath(fallbackCliPath = "") {
  const nodeBinDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeBinDir, "llr"),
    path.join(nodeBinDir, "llm-router"),
    path.join(nodeBinDir, "llm-router-route"),
    String(process.env.LLM_ROUTER_CLI_PATH || "").trim(),
    String(fallbackCliPath || "").trim(),
    String(process.argv[1] || "").trim()
  ];

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await fsPromises.access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }

  return String(fallbackCliPath || process.env.LLM_ROUTER_CLI_PATH || process.argv[1] || "").trim();
}

async function checkForPackageUpdate(packageName) {
  const currentVersion = await readCurrentPackageVersion();
  const latestResult = runNpmViewLatestVersion(packageName);
  if (!latestResult.ok) {
    return {
      ok: false,
      currentVersion,
      latestVersion: "",
      updateAvailable: false,
      errorMessage: latestResult.error
        ? String(latestResult.error)
        : (latestResult.stderr || latestResult.stdout || `Failed to check latest version for ${packageName}.`)
    };
  }

  const latestVersion = parseNpmVersionOutput(latestResult.stdout);
  if (!latestVersion) {
    return {
      ok: false,
      currentVersion,
      latestVersion: "",
      updateAvailable: false,
      errorMessage: `Unable to parse latest version for ${packageName}.`
    };
  }

  return {
    ok: true,
    currentVersion,
    latestVersion,
    updateAvailable: Boolean(currentVersion && latestVersion && currentVersion !== latestVersion)
  };
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
    const startArgs = buildStartArgsFromState(active);
    const restarted = startArgs.configPath
      ? await installStartup({
        configPath: startArgs.configPath,
        host: startArgs.host,
        port: startArgs.port,
        watchConfig: startArgs.watchConfig,
        watchBinary: startArgs.watchBinary,
        requireAuth: startArgs.requireAuth
      })
      : await restartStartup();
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
    const latestCliPath = await resolveLatestCliPath(active.cliPath || process.argv[1]);

    if (runDetachedForManual) {
      const pid = spawnDetachedStart({
        cliPath: latestCliPath,
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
      cliPathForWatch: latestCliPath || process.argv[1],
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
    reason: `No running ${APP_NAME} instance detected.`
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

function subtractValidationErrors(afterErrors, beforeErrors) {
  const counts = new Map();
  for (const error of (beforeErrors || []).map((entry) => String(entry || "").trim()).filter(Boolean)) {
    counts.set(error, (counts.get(error) || 0) + 1);
  }

  const introduced = [];
  for (const error of (afterErrors || []).map((entry) => String(entry || "").trim()).filter(Boolean)) {
    const remaining = counts.get(error) || 0;
    if (remaining > 0) {
      counts.set(error, remaining - 1);
      continue;
    }
    introduced.push(error);
  }
  return introduced;
}

function findIntroducedConfigValidationErrors(previousConfig, nextConfig) {
  const validationOptions = { requireProvider: false, requireMasterKey: false };
  const previousErrors = validateRuntimeConfig(previousConfig, validationOptions);
  const nextErrors = validateRuntimeConfig(nextConfig, validationOptions);
  return subtractValidationErrors(nextErrors, previousErrors);
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

  const validationErrors = findIntroducedConfigValidationErrors(config, next);
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
  const validationErrors = findIntroducedConfigValidationErrors(config, next);
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

function setAmpConfigInConfig(config, amp) {
  const next = normalizeRuntimeConfig({
    ...config,
    amp
  });
  const validationErrors = validateRuntimeConfig(next, { requireProvider: false, requireMasterKey: false });
  if (validationErrors.length > 0) {
    return {
      config,
      changed: false,
      reason: formatConfigValidationError(validationErrors),
      amp: config?.amp || {}
    };
  }

  return {
    config: next,
    changed: serializeStable(config?.amp || {}) !== serializeStable(next.amp || {}),
    reason: "",
    amp: next.amp || {}
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
      message: "Provider",
      options: buildProviderPromptOptions(providers, {
        includeCreateOption: true,
        createLabel: "New provider",
        createHint: "connect API key or OAuth"
      })
    });
    if (choice !== "__new__") {
      selectedExisting = providers.find((p) => p.id === choice) || null;
    }
  } else if (argProviderId) {
    selectedExisting = providers.find((p) => p.id === argProviderId) || null;
  }

  const baseProviderId = argProviderId || selectedExisting?.id || "";
  const rawNameArg = readArg(args, ["name"], undefined);
  const providedName = String(rawNameArg !== undefined ? rawNameArg : (selectedExisting?.name || "")) || "";
  const rawProviderTypeArg = readArg(args, ["type", "provider-type", "providerType"], undefined);
  const hasProviderTypeArg = rawProviderTypeArg !== undefined;
  const hasSubscriptionTypeArg = readArg(args, ["subscription-type", "subscriptionType"], undefined) !== undefined;
  const hasSubscriptionProfileArg = readArg(args, ["subscription-profile", "subscriptionProfile"], undefined) !== undefined;
  const hasModelsArg = readArg(args, ["models"], undefined) !== undefined;
  const initialProviderType = normalizeProviderTypeInput(
    rawProviderTypeArg !== undefined ? rawProviderTypeArg : (selectedExisting?.type || PROVIDER_TYPE_STANDARD)
  ) || PROVIDER_TYPE_STANDARD;
  const rawSubscriptionType = String(readArg(
    args,
    ["subscription-type", "subscriptionType"],
    selectedExisting?.subscriptionType || selectedExisting?.subscription_type || ""
  ) || "").trim();
  const normalizedRequestedSubscriptionType = normalizeSubscriptionTypeInput(rawSubscriptionType);
  const baseSubscriptionType = initialProviderType === PROVIDER_TYPE_SUBSCRIPTION
    ? (
        hasSubscriptionTypeArg
          ? (normalizedRequestedSubscriptionType || rawSubscriptionType)
          : (normalizedRequestedSubscriptionType || SUBSCRIPTION_TYPE_CHATGPT_CODEX)
      )
    : "";
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
  const baseModelContextWindows = parseModelContextWindowsInput(readArg(
    args,
    ["model-context-windows", "modelContextWindows"],
    ""
  ));
  const fillModelContextWindows = toBoolean(readArg(
    args,
    ["fill-model-context-windows", "fillModelContextWindows"],
    false
  ), false);
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
  const subscriptionDeviceCode = toBoolean(readArg(args, ["device-code", "deviceCode"], false), false);
  const parsedHeaders = applyDefaultHeaders(
    parseJsonObjectArg(baseHeaders, "--headers"),
    { force: !hasHeadersArg }
  );
  let providerType = initialProviderType;
  if (canPrompt()) {
    if (!selectedExisting) printProviderInputGuidance(context);
    if (!hasProviderTypeArg) {
      providerType = await context.prompts.select({
        message: "Auth method",
        initialValue: providerType,
        options: [
          {
            value: PROVIDER_TYPE_STANDARD,
            label: "API key",
            hint: "standard provider endpoint"
          },
          {
            value: PROVIDER_TYPE_SUBSCRIPTION,
            label: "OAuth",
            hint: "ChatGPT Codex or Claude Code"
          }
        ]
      });
    }
  }

  let subscriptionType = providerType === PROVIDER_TYPE_SUBSCRIPTION
    ? baseSubscriptionType
    : "";
  if (providerType === PROVIDER_TYPE_SUBSCRIPTION && canPrompt() && !hasSubscriptionTypeArg) {
    subscriptionType = await context.prompts.select({
      message: "Subscription",
      initialValue: subscriptionType || SUBSCRIPTION_TYPE_CHATGPT_CODEX,
      options: SUBSCRIPTION_PROVIDER_PRESETS.map((preset) => ({
        value: preset.subscriptionType,
        label: preset.label,
        hint: preset.subscriptionType === SUBSCRIPTION_TYPE_CHATGPT_CODEX ? "OpenAI account login" : "Anthropic account login"
      }))
    });
  }
  const subscriptionPreset = providerType === PROVIDER_TYPE_SUBSCRIPTION
    ? getSubscriptionProviderPreset(subscriptionType || SUBSCRIPTION_TYPE_CHATGPT_CODEX)
    : null;

  const defaultName = String(
    providedName ||
    (providerType === PROVIDER_TYPE_SUBSCRIPTION ? subscriptionPreset?.defaultName : "") ||
    ""
  ).trim();

  const name = canPrompt()
    ? await context.prompts.text({
        message: "Provider name",
        required: true,
        initialValue: defaultName,
        placeholder: providerType === PROVIDER_TYPE_SUBSCRIPTION
          ? (subscriptionPreset?.defaultName || "Subscription Sub")
          : "OpenRouter Primary",
        validate: (value) => {
          const candidate = String(value || "").trim();
          if (!candidate) return "Provider Friendly Name is required.";
          const duplicate = findProviderByFriendlyName(providers, candidate, { excludeId: selectedExisting?.id || baseProviderId });
          if (duplicate) return `Provider Friendly Name '${candidate}' already exists (provider-id: ${duplicate.id}). Use a unique name.`;
          return undefined;
        }
      })
    : defaultName;

  const generatedProviderId = resolveUniqueProviderId(
    slugifyId(name || subscriptionPreset?.defaultName || "provider"),
    providers,
    { excludeId: selectedExisting?.id || baseProviderId }
  );

  const providerId = canPrompt()
    ? (baseProviderId || await context.prompts.text({
        message: "Provider ID",
        required: true,
        initialValue: generatedProviderId,
        placeholder: providerType === PROVIDER_TYPE_SUBSCRIPTION
          ? slugifyId(subscriptionPreset?.defaultName || "subscription-sub")
          : "openrouter-primary",
        validate: (value) => {
          const candidate = String(value || "").trim();
          if (!candidate) return "Provider ID is required.";
          if (!PROVIDER_ID_PATTERN.test(candidate)) {
            return "Use lowercase letters, numbers, and dashes only (e.g. openrouter-primary).";
          }
          const duplicate = (providers || []).find((provider) =>
            provider &&
            String(provider.id || "").trim() === candidate &&
            String(provider.id || "").trim() !== String(selectedExisting?.id || baseProviderId || "").trim());
          if (duplicate) {
            return `Provider ID '${candidate}' already exists.`;
          }
          return undefined;
        }
      }))
    : (baseProviderId || generatedProviderId);

  const subscriptionProfile = providerType === PROVIDER_TYPE_SUBSCRIPTION
    ? String(readArg(
        args,
        ["subscription-profile", "subscriptionProfile"],
        selectedExisting?.subscriptionProfile || selectedExisting?.subscription_profile || providerId
      ) || "").trim() || providerId
    : "";
  const requiresSubscriptionLogin = providerType === PROVIDER_TYPE_SUBSCRIPTION && (
    !selectedExisting ||
    normalizeProviderTypeInput(selectedExisting?.type) !== PROVIDER_TYPE_SUBSCRIPTION ||
    (hasSubscriptionProfileArg && subscriptionProfile !== String(
      selectedExisting?.subscriptionProfile || selectedExisting?.subscription_profile || selectedExisting?.id || ""
    ).trim())
  );
  const subscriptionModelsInput = providerType === PROVIDER_TYPE_SUBSCRIPTION
    ? String(
        hasModelsArg
          ? readArg(args, ["models"], "")
          : getDefaultSubscriptionModelListInput(selectedExisting, subscriptionType)
      )
    : "";
  const baseIsSubscription = providerType === PROVIDER_TYPE_SUBSCRIPTION;

  if (!canPrompt()) {
    return {
      configPath,
      providerId,
      name,
      providerType,
      subscriptionType,
      subscriptionProfile,
      subscriptionDeviceCode,
      requireSubscriptionLogin: requiresSubscriptionLogin,
      hasModelsArg,
      subscriptionModelsInput,
      baseUrl,
      endpoints: baseEndpoints,
      openaiBaseUrl: baseOpenAIBaseUrl,
      claudeBaseUrl: baseClaudeBaseUrl,
      apiKey: baseIsSubscription ? "" : (baseApiKey || selectedExisting?.apiKey || ""),
      models: baseIsSubscription
        ? parseProviderModelListInput(subscriptionModelsInput)
        : parseProviderModelListInput(baseModels),
      modelContextWindows: baseModelContextWindows,
      fillModelContextWindows,
      format: baseIsSubscription ? (subscriptionPreset?.targetFormat || FORMATS.OPENAI) : baseFormat,
      formats: baseFormats,
      headers: parsedHeaders,
      probeRequestsPerMinute: baseProbeRequestsPerMinute,
      shouldProbe: baseIsSubscription ? false : shouldProbe,
      setMasterKey: setMasterKeyFlag || Boolean(providedMasterKey),
      masterKey: providedMasterKey
    };
  }

  let apiKey = "";
  let endpoints = [];
  let models = providerType === PROVIDER_TYPE_SUBSCRIPTION
    ? parseProviderModelListInput(subscriptionModelsInput)
    : parseProviderModelListInput(baseModels);
  let interactiveHeaders = parsedHeaders;
  let probe = false;
  let probeRequestsPerMinute = baseProbeRequestsPerMinute;
  let manualFormat = providerType === PROVIDER_TYPE_SUBSCRIPTION
    ? (subscriptionPreset?.targetFormat || FORMATS.OPENAI)
    : baseFormat;

  if (providerType === PROVIDER_TYPE_SUBSCRIPTION) {
    const info = typeof context?.terminal?.info === "function" ? context.terminal.info.bind(context.terminal) : null;
    info?.(`${subscriptionPreset?.label || "Subscription provider"} uses browser OAuth login. Model validation will run after authentication.`);
  } else {
    const askReplaceKey = selectedExisting?.apiKey ? await context.prompts.confirm({
      message: "Replace saved API key?",
      initialValue: false
    }) : true;

    apiKey = (baseApiKey || (!askReplaceKey ? selectedExisting?.apiKey : "")) || await promptSecretInput(context, {
      message: "Provider API key",
      required: true,
      validate: (value) => {
        const candidate = String(value || "").trim();
        if (!candidate) return "Provider API key is required.";
        return undefined;
      }
    });

    const endpointsInput = await context.prompts.text({
      message: "Provider endpoints (comma-separated URLs)",
      required: true,
      initialValue: baseEndpoints.join(","),
      validate: (value) => validateEndpointListInput(value)
    });
    endpoints = parseEndpointListInput(endpointsInput);
    maybeReportInputCleanup(context, "endpoint", endpointsInput, endpoints);

    const modelsInput = await context.prompts.text({
      message: "Provider models (comma-separated IDs)",
      required: true,
      initialValue: baseModels,
      validate: (value) => validateProviderModelListInput(value)
    });
    models = parseProviderModelListInput(modelsInput);
    maybeReportInputCleanup(context, "model", modelsInput, models);

    const headersInput = await context.prompts.text({
      message: "Custom headers JSON (optional; default User-Agent included)",
      initialValue: JSON.stringify(applyDefaultHeaders(
        parseJsonObjectArg(baseHeaders, "Custom headers"),
        { force: true }
      ))
    });
    interactiveHeaders = parseJsonObjectArg(headersInput, "Custom headers");

    probe = await context.prompts.confirm({
      message: "Auto-detect endpoint formats and model support via live probe?",
      initialValue: shouldProbe
    });
    const warn = typeof context?.terminal?.warn === "function" ? context.terminal.warn.bind(context.terminal) : null;
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

    if (!probe) {
      manualFormat = await promptProviderFormat(context, {
        message: "Primary provider format",
        initialFormat: manualFormat
      });
    }
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
    providerType,
    subscriptionType,
    subscriptionProfile,
    subscriptionDeviceCode,
    requireSubscriptionLogin: requiresSubscriptionLogin,
    hasModelsArg,
    subscriptionModelsInput,
    baseUrl,
    endpoints,
    openaiBaseUrl: baseOpenAIBaseUrl,
    claudeBaseUrl: baseClaudeBaseUrl,
    apiKey,
    models,
    modelContextWindows: baseModelContextWindows,
    fillModelContextWindows,
    format: probe ? "" : manualFormat,
    formats: baseFormats,
    headers: interactiveHeaders,
    probeRequestsPerMinute,
    shouldProbe: probe,
    setMasterKey,
    masterKey
  };
}

async function resolveSubscriptionAuthFns(context) {
  if (context?.subscriptionAuth && typeof context.subscriptionAuth === "object") {
    return context.subscriptionAuth;
  }
  return import("../runtime/subscription-auth.js");
}

async function resolveSubscriptionProviderFns(context) {
  if (context?.subscriptionProvider && typeof context.subscriptionProvider === "object") {
    return context.subscriptionProvider;
  }
  return import("../runtime/subscription-provider.js");
}

async function ensureSubscriptionAuthenticated(context, {
  profile,
  subscriptionType = SUBSCRIPTION_TYPE_CHATGPT_CODEX,
  forceLogin = false,
  deviceCode = false
}) {
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
  const authFns = await resolveSubscriptionAuthFns(context);
  const getAuthStatus = typeof authFns.getAuthStatus === "function" ? authFns.getAuthStatus : null;
  const loginWithBrowser = typeof authFns.loginWithBrowser === "function" ? authFns.loginWithBrowser : null;
  const loginWithDeviceCode = typeof authFns.loginWithDeviceCode === "function" ? authFns.loginWithDeviceCode : null;

  if (!getAuthStatus || !loginWithBrowser || !loginWithDeviceCode) {
    throw new Error("Subscription auth module is missing required login/status functions.");
  }

  if (!forceLogin) {
    const status = await getAuthStatus(profile, { subscriptionType });
    if (status?.authenticated) {
      line?.(`Subscription profile '${profile}' already authenticated.`);
      return { authenticated: true, loginAttempted: false };
    }
  }

  line?.(`Starting OAuth login for subscription profile '${profile}'...`);
  if (deviceCode) {
    await loginWithDeviceCode(profile, {
      subscriptionType,
      onCode: ({ userCode, verificationUri, expiresIn }) => {
        line?.(`Open ${verificationUri} and enter code ${userCode} (expires in ${Math.floor(Number(expiresIn || 0) / 60)} minutes).`);
      }
    });
  } else {
    await loginWithBrowser(profile, {
      subscriptionType,
      onUrl: (url, meta = {}) => {
        if (meta?.openedBrowser === true) {
          line?.("Opened browser for OAuth login. Complete authentication to continue.");
        } else {
          line?.(`Open this OAuth URL in your browser: ${url}`);
        }
      }
    });
  }

  const refreshedStatus = await getAuthStatus(profile, { subscriptionType });
  if (!refreshedStatus?.authenticated) {
    throw new Error(`OAuth login did not complete for subscription profile '${profile}'.`);
  }
  return { authenticated: true, loginAttempted: true };
}

function buildSubscriptionProbeSeed(models, targetFormat = FORMATS.OPENAI) {
  const format = targetFormat === FORMATS.CLAUDE ? FORMATS.CLAUDE : FORMATS.OPENAI;
  const modelSupport = {};
  const modelPreferredFormat = {};
  for (const model of (models || [])) {
    modelSupport[model] = [format];
    modelPreferredFormat[model] = format;
  }

  return {
    ok: true,
    preferredFormat: format,
    formats: [format],
    workingFormats: [format],
    models: [...(models || [])],
    modelSupport,
    modelPreferredFormat
  };
}

function summarizeSubscriptionProbeFailure(result, fallback = "Subscription model probe failed.") {
  if (!result || typeof result !== "object") return fallback;
  if (result.errorKind) return `${result.errorKind}: ${result.status || "unknown-status"}`;
  if (Number.isFinite(result.status)) return `status=${result.status}`;
  return fallback;
}

async function closeSubscriptionProbeResponse(result) {
  if (!(result?.response instanceof Response)) return;
  const body = result.response.body;
  if (body && typeof body.cancel === "function") {
    try {
      await body.cancel();
      return;
    } catch {
      // Fall through and try draining as a best effort.
    }
  }
  try {
    await result.response.arrayBuffer();
  } catch {
    // Ignore cleanup failure for probe responses.
  }
}

function buildSubscriptionProbeBody(modelId, subscriptionType) {
  if (subscriptionType === SUBSCRIPTION_TYPE_CLAUDE_CODE) {
    return {
      model: modelId,
      max_tokens: 16,
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Reply with exactly: pong"
            }
          ]
        }
      ]
    };
  }

  return {
    model: modelId,
    stream: true,
    store: false,
    instructions: "You are a helpful assistant. Reply concisely.",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Reply with exactly: pong"
          }
        ]
      }
    ],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false
  };
}

async function probeSubscriptionModels(context, {
  providerId,
  providerName,
  subscriptionType,
  subscriptionProfile,
  models,
  headers
}) {
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
  const providerFns = await resolveSubscriptionProviderFns(context);
  const makeSubscriptionProviderCall = typeof providerFns.makeSubscriptionProviderCall === "function"
    ? providerFns.makeSubscriptionProviderCall
    : null;
  if (!makeSubscriptionProviderCall) {
    throw new Error("Subscription provider module is missing makeSubscriptionProviderCall.");
  }

  const uniqueModels = dedupeList(models);
  const provider = {
    id: providerId,
    name: providerName,
    type: PROVIDER_TYPE_SUBSCRIPTION,
    subscriptionType,
    subscriptionProfile,
    headers: headers || {},
    models: uniqueModels.map((id) => ({ id }))
  };
  const targetFormat = getSubscriptionTargetFormat(subscriptionType);

  const failures = [];
  for (const modelId of uniqueModels) {
    line?.(`[subscription probe] Testing model ${modelId}...`);
    const probeBody = buildSubscriptionProbeBody(modelId, subscriptionType);
    const result = await makeSubscriptionProviderCall({
      provider,
      body: probeBody,
      stream: true
    });

    if (result?.ok) {
      await closeSubscriptionProbeResponse(result);
      continue;
    }

    let details = summarizeSubscriptionProbeFailure(result);
    if (result?.response instanceof Response) {
      try {
        const raw = await result.response.text();
        const compact = String(raw || "").trim().replace(/\s+/g, " ");
        if (compact) details = compact.slice(0, 300);
      } catch {
        // Ignore response parsing failure and keep fallback details.
      }
    }
    failures.push({ modelId, details });
  }

  return {
    ok: failures.length === 0,
    failures,
    probe: buildSubscriptionProbeSeed(uniqueModels, targetFormat)
  };
}

async function doUpsertProvider(context) {
  const configPath = readArg(context.args, ["config", "configPath"], getDefaultConfigPath());
  const existingConfig = await readConfigFile(configPath);
  const input = await resolveUpsertInput(context, existingConfig);
  const providerType = normalizeProviderTypeInput(input.providerType) || PROVIDER_TYPE_STANDARD;
  const isSubscriptionProvider = providerType === PROVIDER_TYPE_SUBSCRIPTION;
  const rawSubscriptionType = String(input.subscriptionType || "").trim();
  const normalizedSubscriptionType = normalizeSubscriptionTypeInput(rawSubscriptionType);
  const subscriptionType = isSubscriptionProvider
    ? (normalizedSubscriptionType || SUBSCRIPTION_TYPE_CHATGPT_CODEX)
    : "";
  const subscriptionPreset = isSubscriptionProvider
    ? getSubscriptionProviderPreset(subscriptionType || SUBSCRIPTION_TYPE_CHATGPT_CODEX)
    : null;
  const subscriptionProfile = String(input.subscriptionProfile || input.providerId || "default").trim() || input.providerId || "default";

  const endpointCandidates = parseEndpointListInput([
    ...(input.endpoints || []),
    input.openaiBaseUrl,
    input.claudeBaseUrl,
    input.baseUrl
  ].filter(Boolean).join(","));
  const hasAnyEndpoint = endpointCandidates.length > 0;
  const hasAnyModel = dedupeList(input.models || []).length > 0;
  if (!input.name) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "Provider Friendly Name is required."
    };
  }
  if (isSubscriptionProvider && rawSubscriptionType && !normalizedSubscriptionType) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `Unsupported subscription-type '${rawSubscriptionType}'. Supported: ${formatSupportedSubscriptionTypes()}.`
    };
  }
  if (!isSubscriptionProvider && (!hasAnyEndpoint || !input.apiKey)) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "Missing provider inputs: provider-id, name, api-key, and at least one endpoint."
    };
  }
  if (!isSubscriptionProvider && endpointCandidates.some((endpoint) => !isValidHttpUrl(endpoint))) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "One or more endpoints are invalid. Use full http:// or https:// URLs."
    };
  }
  if (!isSubscriptionProvider && !hasAnyModel) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "At least one valid model id is required."
    };
  }

  if (!PROVIDER_ID_PATTERN.test(input.providerId)) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `Invalid provider id '${input.providerId}'. Use lowercase letters, numbers, and dashes (e.g. openrouter-primary).`
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
  let effectiveModels = dedupeList(input.models || []);
  const shouldProbe = !isSubscriptionProvider && Boolean(input.shouldProbe);

  if (isSubscriptionProvider) {
    try {
      await ensureSubscriptionAuthenticated(context, {
        profile: subscriptionProfile,
        subscriptionType,
        forceLogin: Boolean(input.requireSubscriptionLogin),
        deviceCode: Boolean(input.subscriptionDeviceCode)
      });
    } catch (error) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_FAILURE,
        errorMessage: `Subscription OAuth login failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    if (canPrompt() && !input.hasModelsArg) {
      const modelsInput = await context.prompts.text({
        message: "Subscription models (comma-separated IDs)",
        required: true,
        initialValue: String(input.subscriptionModelsInput || "").trim(),
        validate: (value) => validateProviderModelListInput(value)
      });
      effectiveModels = parseProviderModelListInput(modelsInput);
      maybeReportInputCleanup(context, "model", modelsInput, effectiveModels);
    } else if (effectiveModels.length === 0) {
      effectiveModels = parseProviderModelListInput(input.subscriptionModelsInput || "");
    }

    if (effectiveModels.length === 0) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: "Subscription provider requires at least one model after editing."
      };
    }

    const warn = typeof context?.terminal?.warn === "function" ? context.terminal.warn.bind(context.terminal) : null;
    const formatProbeFailures = (failures = []) => [
      "Subscription model probe failed. Remove unsupported models and retry.",
      ...failures.map((entry) => `- ${entry.modelId}: ${entry.details}`)
    ].join("\n");

    while (true) {
      let subscriptionProbe = null;
      try {
        subscriptionProbe = await probeSubscriptionModels(context, {
          providerId: input.providerId,
          providerName: input.name,
          subscriptionType,
          subscriptionProfile,
          models: effectiveModels,
          headers: input.headers
        });
      } catch (error) {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_FAILURE,
          errorMessage: `Subscription model validation failed: ${error instanceof Error ? error.message : String(error)}`
        };
      }

      if (subscriptionProbe.ok) {
        probe = subscriptionProbe.probe;
        break;
      }

      if (!canPrompt()) {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_FAILURE,
          errorMessage: formatProbeFailures(subscriptionProbe.failures)
        };
      }

      warn?.(formatProbeFailures(subscriptionProbe.failures));
      const retry = await context.prompts.confirm({
        message: "Edit subscription models and retry probe?",
        initialValue: true
      });
      if (!retry) {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_FAILURE,
          errorMessage: formatProbeFailures(subscriptionProbe.failures)
        };
      }

      const modelsInput = await context.prompts.text({
        message: "Subscription models (comma-separated IDs)",
        required: true,
        initialValue: effectiveModels.join(","),
        validate: (value) => validateProviderModelListInput(value)
      });
      effectiveModels = parseProviderModelListInput(modelsInput);
      maybeReportInputCleanup(context, "model", modelsInput, effectiveModels);
      if (effectiveModels.length === 0) {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_VALIDATION,
          errorMessage: "Subscription provider requires at least one model after editing."
        };
      }
    }

    selectedFormat = subscriptionPreset?.targetFormat || getSubscriptionTargetFormat(subscriptionType);
    effectiveBaseUrl = "";
    effectiveOpenAIBaseUrl = "";
    effectiveClaudeBaseUrl = "";
  } else {
    if (shouldProbe && endpointCandidates.length > 0 && effectiveModels.length === 0) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: "Model list is required for endpoint-model probe. Provide --models=modelA,modelB."
      };
    }

    if (shouldProbe) {
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

    if (!shouldProbe) {
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
  }

  const effectiveFormat = isSubscriptionProvider
    ? FORMATS.OPENAI
    : (selectedFormat || (shouldProbe ? "" : "openai"));
  let effectiveModelContextWindows = {
    ...(input.modelContextWindows && typeof input.modelContextWindows === "object"
      ? input.modelContextWindows
      : {})
  };

  try {
    const fillResult = await maybeFillMissingModelContextWindows(context, effectiveModels, effectiveModelContextWindows, {
      enabled: Boolean(input.fillModelContextWindows)
    });
    effectiveModelContextWindows = fillResult.modelContextWindows;
    if (fillResult.filledCount > 0) {
      const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : null;
      line?.(`LiteLLM filled ${fillResult.filledCount} model context window${fillResult.filledCount === 1 ? "" : "s"}.`);
    }
  } catch (error) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: `LiteLLM model context lookup failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const provider = buildProviderFromConfigInput({
    providerId: input.providerId,
    name: input.name,
    type: isSubscriptionProvider ? PROVIDER_TYPE_SUBSCRIPTION : undefined,
    subscriptionType: isSubscriptionProvider ? subscriptionType : undefined,
    subscriptionProfile: isSubscriptionProvider ? subscriptionProfile : undefined,
    baseUrl: effectiveBaseUrl,
    openaiBaseUrl: effectiveOpenAIBaseUrl,
    claudeBaseUrl: effectiveClaudeBaseUrl,
    apiKey: isSubscriptionProvider ? undefined : input.apiKey,
    models: effectiveModels,
    modelContextWindows: effectiveModelContextWindows,
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
  const savedProvider = (nextConfig.providers || []).find((entry) => entry.id === provider.id) || provider;
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildProviderSavedReport({
      provider: savedProvider,
      configPath: input.configPath,
      probe,
      masterKey: nextConfig.masterKey ? maskSecret(nextConfig.masterKey) : "(not set)"
    })
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

async function doValidateConfig(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  let exists = true;
  let rawText = "";
  try {
    rawText = await fsPromises.readFile(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      exists = false;
      rawText = "";
    } else {
      throw error;
    }
  }

  let normalizedConfig = normalizeRuntimeConfig({}, { migrateToVersion: CONFIG_VERSION });
  let parseError = "";
  if (rawText.trim()) {
    try {
      normalizedConfig = normalizeRuntimeConfig(
        JSON.parse(rawText),
        { migrateToVersion: CONFIG_VERSION }
      );
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  const validationErrors = parseError ? [] : validateRuntimeConfig(normalizedConfig);
  const report = buildConfigValidationReport({
    configPath,
    exists,
    normalizedConfig,
    parseError,
    validationErrors
  });

  if (parseError || validationErrors.length > 0) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: report
    };
  }

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: report
  };
}

async function doListRouting(context) {
  return doListConfig(context);
}

async function resolveProviderProbeApiKey(args = {}) {
  const apiKey = String(readArg(args, ["api-key", "apiKey"], "") || "").trim();
  if (apiKey) return apiKey;

  const apiKeyEnv = String(readArg(args, ["api-key-env", "apiKeyEnv"], "") || "").trim();
  if (!apiKeyEnv) {
    throw new Error("api-key or api-key-env is required for provider diagnostics.");
  }

  const envValue = String(process.env?.[apiKeyEnv] || "").trim();
  if (!envValue) {
    throw new Error(`Environment variable '${apiKeyEnv}' is not set.`);
  }
  return envValue;
}

function collectProviderProbeEndpoints(args = {}) {
  return dedupeList([
    ...parseEndpointListInput(readArg(args, ["endpoints"], "")),
    String(readArg(args, ["base-url", "baseUrl"], "") || "").trim(),
    String(readArg(args, ["openai-base-url", "openaiBaseUrl"], "") || "").trim(),
    String(readArg(args, ["claude-base-url", "claudeBaseUrl", "anthropic-base-url", "anthropicBaseUrl"], "") || "").trim()
  ].filter(Boolean));
}

function parseOptionalHeadersArg(args = {}) {
  const headersValue = readArg(args, ["headers"], undefined);
  if (headersValue === undefined) return {};
  return parseJsonObjectArg(headersValue, "--headers");
}

async function doSnapshot(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  const runtimeState = await getActiveRuntimeState().catch(() => null);
  const startup = await startupStatus().catch((error) => ({
    manager: "unknown",
    serviceId: "llm-router",
    installed: false,
    running: false,
    detail: error instanceof Error ? error.message : String(error)
  }));
  const toolSnapshot = await buildCodingToolRoutingSnapshot({ config, args });

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: joinReportSections(
      "Router Snapshot",
      renderKeyValueSection("Runtime", [
        ["Router Endpoint", LOCAL_ROUTER_ORIGIN],
        ["Running", formatYesNo(Boolean(runtimeState))],
        ["Runtime PID", runtimeState?.pid ? String(runtimeState.pid) : "(not running)"],
        ["Config Path", runtimeState?.configPath || configPath],
        ["Watch Config", runtimeState ? formatYesNo(runtimeState.watchConfig !== false) : "(not running)"],
        ["Watch Binary", runtimeState ? formatYesNo(runtimeState.watchBinary !== false) : "(not running)"],
        ["Require Auth", runtimeState ? formatYesNo(runtimeState.requireAuth === true) : formatYesNo(Boolean(config?.masterKey))]
      ]),
      renderKeyValueSection("Startup", [
        ["Installed", formatYesNo(Boolean(startup?.installed))],
        ["Running", formatYesNo(Boolean(startup?.running))],
        ["Manager", startup?.manager || "Unknown"],
        ["Service Name", startup?.serviceId || "Unknown"],
        ["Detail", String(startup?.detail || "").trim() || "(none)"]
      ]),
      summarizeConfig(config, configPath),
      buildAmpClientStatusSection(toolSnapshot.ampStates),
      buildCodexCliStatusSection(toolSnapshot.codexCli),
      buildClaudeCodeStatusSection(toolSnapshot.claudeCode)
    )
  };
}

async function doToolStatus(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  const snapshot = await buildCodingToolRoutingSnapshot({ config, args });

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildOperationReport(
      "Coding Tool Routing Status",
      [
        ["Router Endpoint", snapshot.endpointUrl],
        ["Config File", configPath],
        ["Master Key Configured", formatYesNo(snapshot.masterKeyConfigured)]
      ],
      [
        buildAmpClientStatusSection(snapshot.ampStates),
        buildCodexCliStatusSection(snapshot.codexCli),
        buildClaudeCodeStatusSection(snapshot.claudeCode)
      ]
    )
  };
}

async function doSetAmpClientRouting(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  const enabled = parseOptionalBoolean(readArg(args, ["enabled"], undefined)) !== false;

  if (!enabled) {
    const scope = normalizeAmpClientSettingsScope(readArg(args, ["amp-client-settings-scope", "ampClientSettingsScope"], "global")) || "global";
    const settingsFilePath = resolveAmpClientSettingsFilePath({
      scope,
      explicitPath: readArg(args, ["amp-client-settings-file", "ampClientSettingsFile"], ""),
      cwd: process.cwd(),
      env: process.env
    });
    const secretsFilePath = resolveAmpClientSecretsFilePath({
      explicitPath: readArg(args, ["amp-client-secrets-file", "ampClientSecretsFile"], ""),
      env: process.env
    });
    const unpatchResult = await unpatchAmpClientConfigFilesFile({
      settingsFilePath,
      secretsFilePath,
      endpointUrl: readArg(args, ["endpoint-url", "endpointUrl", "amp-client-url", "ampClientUrl"], ""),
      env: process.env
    });
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: buildOperationReport(
        "AMP Client Routing Disabled",
        [
          ["Settings File", unpatchResult.settingsFilePath],
          ["Secrets File", unpatchResult.secretsFilePath],
          ["Settings Updated", formatYesNo(unpatchResult.settingsUpdated === true)],
          ["Removed Secrets", String((unpatchResult.secretFieldsRemoved || []).length)]
        ],
        [
          renderListSection("Removed Secret Keys", unpatchResult.secretFieldsRemoved, { emptyMessage: "None." })
        ]
      )
    };
  }

  const patchResolution = await resolveAmpClientPatchPlanFromArgs(context, {
    config,
    cwd: process.cwd(),
    env: process.env
  });
  if (patchResolution.error) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: patchResolution.error
    };
  }

  const patchPlan = patchResolution.plan;
  if (!patchPlan) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "AMP client routing needs patch args. Pass --amp-client-settings-scope plus optional --amp-client-url / --amp-client-api-key."
    };
  }

  const bootstrap = await maybeBootstrapAmpPatchDefaults({
    config,
    amp: config?.amp,
    patchPlan,
    env: process.env,
    homeDir: os.homedir()
  });
  if (bootstrap.error) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: bootstrap.error
    };
  }

  const previousAmpSignature = serializeStable(config?.amp || {});
  const nextAmpSignature = serializeStable(bootstrap.amp || {});
  if (previousAmpSignature !== nextAmpSignature) {
    await writeConfigFile({
      ...config,
      amp: bootstrap.amp
    }, configPath);
  }

  const patchResult = await patchAmpClientConfigFiles(patchPlan);
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildOperationReport(
      "AMP Client Routing Enabled",
      [
        ["Config File", configPath],
        ["Settings File", patchResult.settingsFilePath],
        ["Secrets File", patchResult.secretsFilePath],
        ["Endpoint URL", patchResult.endpointUrl],
        ["Config Bootstrapped", formatYesNo(previousAmpSignature !== nextAmpSignature)],
        ["Bootstrap Default Route", bootstrap.bootstrapRouteRef || "(none)"]
      ],
      [
        buildAmpConfigSection(bootstrap.amp),
        buildAmpClientPatchSection(patchResult)
      ]
    )
  };
}

async function doSetCodexCliRouting(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  const endpointUrl = String(readArg(args, ["endpoint-url", "endpointUrl"], LOCAL_ROUTER_ORIGIN) || LOCAL_ROUTER_ORIGIN).trim();
  const configFilePath = String(readArg(args, ["codex-config-file", "codexConfigFile"], "") || "").trim();
  const modelCatalogFilePath = String(readArg(args, ["codex-model-catalog-file", "codexModelCatalogFile"], "") || "").trim();
  const enabled = parseOptionalBoolean(readArg(args, ["enabled"], undefined)) !== false;

  if (!enabled) {
    const unpatchResult = await unpatchCodexCliConfigFile({
      configFilePath,
      env: process.env
    });
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: buildOperationReport(
        "Codex CLI Routing Disabled",
        [
          ["Config File", unpatchResult.configFilePath],
          ["Backup File", unpatchResult.backupFilePath],
          ["Backup Restored", formatYesNo(unpatchResult.backupRestored === true)]
        ]
      )
    };
  }

  const existingState = await readCodexCliRoutingState({
    configFilePath,
    endpointUrl,
    env: process.env
  });
  const apiKey = String(
    readArg(args, ["master-key", "masterKey", "api-key", "apiKey"], config?.masterKey || "") || ""
  ).trim();
  if (!apiKey) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `master-key (or config.masterKey) is required before routing Codex CLI through ${APP_NAME}.`
    };
  }

  const bindings = normalizeCodexBindingsInput({
    defaultModel: readArg(args, ["default-model", "defaultModel"], undefined) !== undefined
      ? readArg(args, ["default-model", "defaultModel"], "")
      : existingState.bindings?.defaultModel,
    thinkingLevel: readArg(args, ["thinking-level", "thinkingLevel"], undefined) !== undefined
      ? readArg(args, ["thinking-level", "thinkingLevel"], "")
      : existingState.bindings?.thinkingLevel
  }, config);
  const patchResult = await patchCodexCliConfigFile({
    configFilePath,
    modelCatalogFilePath,
    endpointUrl,
    apiKey,
    bindings,
    modelCatalog: buildCodexCliModelCatalog(config, bindings),
    captureBackup: true,
    env: process.env
  });
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildOperationReport(
      "Codex CLI Routing Enabled",
      [
        ["Config File", patchResult.configFilePath],
        ["Backup File", patchResult.backupFilePath],
        ["Catalog File", patchResult.modelCatalogFilePath || resolveCodexCliModelCatalogFilePath({
          configFilePath: patchResult.configFilePath
        })],
        ["Base URL", patchResult.baseUrl],
        ["Model Binding", formatCodexBindingLabel(patchResult.bindings?.defaultModel)],
        ["Thinking Level", patchResult.bindings?.thinkingLevel || "(not set)"]
      ]
    )
  };
}

async function doSetClaudeCodeRouting(context) {
  const args = context.args || {};
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  const endpointUrl = String(readArg(args, ["endpoint-url", "endpointUrl"], LOCAL_ROUTER_ORIGIN) || LOCAL_ROUTER_ORIGIN).trim();
  const settingsFilePath = String(readArg(args, ["claude-code-settings-file", "claudeCodeSettingsFile", "claude-settings-file", "claudeSettingsFile"], "") || "").trim();
  const enabled = parseOptionalBoolean(readArg(args, ["enabled"], undefined)) !== false;

  if (!enabled) {
    const unpatchResult = await unpatchClaudeCodeSettingsFile({
      settingsFilePath,
      env: process.env
    });
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: buildOperationReport(
        "Claude Code Routing Disabled",
        [
          ["Settings File", unpatchResult.settingsFilePath],
          ["Backup File", unpatchResult.backupFilePath],
          ["Backup Restored", formatYesNo(unpatchResult.backupRestored === true)]
        ]
      )
    };
  }

  const existingState = await readClaudeCodeRoutingState({
    settingsFilePath,
    endpointUrl,
    env: process.env
  });
  const apiKey = String(
    readArg(args, ["master-key", "masterKey", "api-key", "apiKey"], config?.masterKey || "") || ""
  ).trim();
  if (!apiKey) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `master-key (or config.masterKey) is required before routing Claude Code through ${APP_NAME}.`
    };
  }

  const existingBindings = normalizeClaudeBindingState(existingState.bindings);
  const fallbackPrimaryModel = existingBindings.primaryModel || pickDefaultManagedRoute(config);
  const bindings = normalizeClaudeBindingState({
    primaryModel: readArg(args, ["primary-model", "primaryModel"], undefined) !== undefined
      ? readArg(args, ["primary-model", "primaryModel"], "")
      : fallbackPrimaryModel,
    defaultOpusModel: readArg(args, ["default-opus-model", "defaultOpusModel"], undefined) !== undefined
      ? readArg(args, ["default-opus-model", "defaultOpusModel"], "")
      : existingBindings.defaultOpusModel,
    defaultSonnetModel: readArg(args, ["default-sonnet-model", "defaultSonnetModel"], undefined) !== undefined
      ? readArg(args, ["default-sonnet-model", "defaultSonnetModel"], "")
      : existingBindings.defaultSonnetModel,
    defaultHaikuModel: readArg(args, ["default-haiku-model", "defaultHaikuModel"], undefined) !== undefined
      ? readArg(args, ["default-haiku-model", "defaultHaikuModel"], "")
      : existingBindings.defaultHaikuModel,
    subagentModel: readArg(args, ["subagent-model", "subagentModel"], undefined) !== undefined
      ? readArg(args, ["subagent-model", "subagentModel"], "")
      : existingBindings.subagentModel,
    thinkingLevel: readArg(args, ["thinking-level", "thinkingLevel"], undefined) !== undefined
      ? readArg(args, ["thinking-level", "thinkingLevel"], "")
      : existingBindings.thinkingLevel
  });

  const patchResult = await patchClaudeCodeSettingsFile({
    settingsFilePath,
    endpointUrl,
    apiKey,
    bindings,
    captureBackup: true,
    env: process.env
  });
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildOperationReport(
      "Claude Code Routing Enabled",
      [
        ["Settings File", patchResult.settingsFilePath],
        ["Backup File", patchResult.backupFilePath],
        ["Base URL", patchResult.baseUrl],
        ["Primary Model", patchResult.bindings?.primaryModel || "(not set)"],
        ["Subagent Model", patchResult.bindings?.subagentModel || "(not set)"],
        ["Thinking Level", patchResult.bindings?.thinkingLevel || "(not set)"]
      ]
    )
  };
}

async function doSetClaudeCodeEffortLevel(context) {
  const args = context.args || {};
  const settingsFilePath = String(readArg(args, ["claude-code-settings-file", "claudeCodeSettingsFile", "claude-settings-file", "claudeSettingsFile"], "") || "").trim();
  const effortLevel = String(readArg(args, ["thinking-level", "thinkingLevel", "effort-level", "effortLevel"], "") || "").trim();

  if (effortLevel && !normalizeClaudeCodeEffortLevel(effortLevel)) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `Invalid effort level '${effortLevel}'. Valid values: low, medium, high, max.`
    };
  }

  const result = await patchClaudeCodeEffortLevel({
    settingsFilePath,
    effortLevel,
    env: process.env
  });

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildOperationReport(
      result.effortLevel ? "Claude Code Effort Level Set" : "Claude Code Effort Level Cleared",
      [
        ["Settings File", result.settingsFilePath],
        ["Effort Level", result.effortLevel || "(cleared)"],
        ["Shell Profile Updated", formatYesNo(result.shellProfileUpdated)]
      ]
    )
  };
}

async function doDiscoverProviderModels(context) {
  const args = context.args || {};
  let headers;
  try {
    headers = parseOptionalHeadersArg(args);
  } catch (error) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }

  const endpoints = collectProviderProbeEndpoints(args);
  if (endpoints.length === 0) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "At least one endpoint is required. Pass --endpoints or --base-url."
    };
  }

  let apiKey;
  try {
    apiKey = await resolveProviderProbeApiKey(args);
  } catch (error) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }

  const workingFormats = new Set();
  const discoveredModels = [];
  const discoveredModelSet = new Set();
  const baseUrlByFormat = {};
  const authByFormat = {};
  let preferredFormat = "";

  for (const endpoint of endpoints) {
    const result = await probeProvider({
      baseUrl: endpoint,
      apiKey,
      headers,
      timeoutMs: 8000
    });

    for (const format of (result.workingFormats || [])) {
      workingFormats.add(format);
    }
    for (const [format, baseUrl] of Object.entries(result.baseUrlByFormat || {})) {
      if (!baseUrlByFormat[format]) baseUrlByFormat[format] = baseUrl;
    }
    for (const [format, auth] of Object.entries(result.authByFormat || {})) {
      if (!authByFormat[format]) authByFormat[format] = auth;
    }
    if (!preferredFormat && result.preferredFormat) {
      preferredFormat = result.preferredFormat;
    }
    for (const modelId of (result.models || [])) {
      if (discoveredModelSet.has(modelId)) continue;
      discoveredModelSet.add(modelId);
      discoveredModels.push(modelId);
    }
  }

  const warnings = [];
  if (discoveredModels.length === 0) {
    warnings.push("Model list API did not return any models. Add model ids manually if needed.");
  }
  if (workingFormats.size === 0) {
    warnings.push("No working endpoint format detected yet. Run test-provider after choosing models.");
  }
  const discoveryOk = discoveredModels.length > 0 && workingFormats.size > 0;

  return {
    ok: discoveryOk,
    mode: context.mode,
    exitCode: discoveryOk ? EXIT_SUCCESS : EXIT_FAILURE,
    data: buildOperationReport(
      discoveryOk ? "Provider Model Discovery" : "Provider Model Discovery Incomplete",
      buildProviderDiagnosticOverview({
        workingFormats: [...workingFormats],
        preferredFormat: preferredFormat || null,
        baseUrlByFormat,
        models: discoveredModels,
        warnings
      }),
      [
        renderListSection("Endpoints", endpoints),
        renderListSection("Models", discoveredModels, { emptyMessage: "No models discovered." }),
        renderListSection("Warnings", warnings, { emptyMessage: "None." })
      ]
    )
  };
}

async function doTestProvider(context) {
  const args = context.args || {};
  let headers;
  try {
    headers = parseOptionalHeadersArg(args);
  } catch (error) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }

  const endpoints = collectProviderProbeEndpoints(args);
  const models = parseProviderModelListInput(readArg(args, ["models"], ""));
  if (endpoints.length === 0) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "At least one endpoint is required. Pass --endpoints or --base-url."
    };
  }
  if (models.length === 0) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "At least one model is required. Pass --models=model-a,model-b."
    };
  }

  let apiKey;
  try {
    apiKey = await resolveProviderProbeApiKey(args);
  } catch (error) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }

  const result = await probeProviderEndpointMatrix({
    endpoints,
    models,
    apiKey,
    headers,
    requestsPerMinute: toPositiveInteger(
      readArg(args, ["probe-rpm", "probe-requests-per-minute", "probeRequestsPerMinute"], DEFAULT_PROBE_REQUESTS_PER_MINUTE),
      DEFAULT_PROBE_REQUESTS_PER_MINUTE
    )
  });
  const endpointRows = (result.endpointMatrix || []).map((entry) => ([
    entry.endpoint,
    (entry.workingFormats || []).join(", ") || "(none)",
    Object.values(entry.modelsByFormat || {})
      .flat()
      .filter(Boolean)
      .length
      .toString(),
    entry.preferredFormat || "(not detected)"
  ]));

  return {
    ok: result.ok,
    mode: context.mode,
    exitCode: result.ok ? EXIT_SUCCESS : EXIT_FAILURE,
    data: buildOperationReport(
      result.ok ? "Provider Probe Passed" : "Provider Probe Completed With Gaps",
      buildProviderDiagnosticOverview(result),
      [
        "Endpoint Matrix\n" + renderAsciiTable(
          ["Endpoint", "Working Formats", "Confirmed Models", "Preferred Format"],
          endpointRows,
          { emptyMessage: "No endpoint checks completed." }
        ),
        renderListSection("Supported Models", result.models, { emptyMessage: "None." }),
        renderListSection("Unresolved Models", result.unresolvedModels, { emptyMessage: "None." }),
        renderListSection("Warnings", result.warnings, { emptyMessage: "None." })
      ]
    )
  };
}

async function doLiteLlmContextLookup(context) {
  const args = context.args || {};
  const models = parseProviderModelListInput(readArg(args, ["models", "model"], ""));
  if (models.length === 0) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: "At least one model is required. Pass --models=model-a,model-b."
    };
  }

  const lookupLiteLlmContextWindow = createLiteLlmContextLookupHelper();
  const results = await lookupLiteLlmContextWindow({ models });
  const rows = results.map((entry) => ([
    entry.query,
    entry.exactMatch?.model || "(none)",
    entry.exactMatch?.contextWindow || entry.medianContextWindow || "(unknown)",
    (entry.suggestions || []).slice(0, 3).map((item) => item.model).join(", ") || "(none)"
  ]));

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildOperationReport(
      "LiteLLM Context Lookup",
      [
        ["Queries", String(results.length)],
        ["Exact Matches", String(results.filter((entry) => entry.exactMatch).length)]
      ],
      [
        "Results\n" + renderAsciiTable(
          ["Query", "Exact Match", "Context Window", "Top Suggestions"],
          rows,
          { emptyMessage: "No lookup results." }
        )
      ]
    )
  };
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
    data: buildOperationReport(
      migration.changed ? "Config Migration Completed" : "Config Already Up To Date",
      [
        ["Config File", configPath],
        ["Previous Version", String(migration.beforeVersion)],
        ["Current Version", String(migration.afterVersion)],
        ["Backup Created", formatYesNo(Boolean(migration.backupPath))],
        ["Backup File", migration.backupPath || "(not created)"]
      ]
    )
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
      options: buildProviderPromptOptions(config.providers)
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
        message: "Provider",
        options: buildProviderPromptOptions(config.providers)
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
        message: "Remove model",
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
        message: "Provider",
        options: buildProviderPromptOptions(config.providers)
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
        message: "Source model",
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
        message: `Fallback routes for ${providerId}/${sourceModelId}`,
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
  const routeRef = `${providerId}/${updated.modelId || modelId}`;
  const fallbackRows = (updated.fallbackModels || []).map((entry) => [entry]);
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildOperationReport(
      "Model Silent Fallbacks Updated",
      [
        ["Source Model Route", routeRef],
        ["Fallback Count", String((updated.fallbackModels || []).length)]
      ],
      [
        "Fallback Routes\n" + renderAsciiTable(["Model Route"], fallbackRows, {
          emptyMessage: "No fallback routes configured."
        })
      ]
    )
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
    info?.("Aliases group multiple routes under one name; strategy controls how traffic is spread.");

    if (!aliasId) {
      const aliasIds = Object.keys(aliases);
      if (aliasIds.length > 0) {
        const selected = await context.prompts.select({
          message: "Alias",
          options: buildAliasPromptOptions(aliases, { includeCreateOption: true })
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
      message: "Strategy",
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
        message: "Primary routes (<route>@<weight>)",
        required: true,
        initialValue: defaultTargets === "(none)" ? "" : defaultTargets,
        placeholder: "openrouter/gpt-4o-mini@3,anthropic/claude-3-5-haiku@2"
      });
    }

    if (!clearFallbackTargets && !hasFallbackTargetsArg) {
      const defaultFallbacks = formatAliasTargetsForSummary(existingAlias?.fallbackTargets || []);
      fallbackTargetsInput = await context.prompts.text({
        message: "Fallback routes (optional)",
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
    const savedAliasId = updated.aliasId || aliasId;
    const savedAlias = updated.config.modelAliases?.[savedAliasId];
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: buildModelAliasSavedReport(savedAliasId, savedAlias)
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
  const savedAliasId = updated.aliasId || aliasId;
  const savedAlias = updated.config.modelAliases?.[savedAliasId];
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildModelAliasSavedReport(savedAliasId, savedAlias)
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
      message: "Remove alias",
      options: buildAliasPromptOptions(config.modelAliases || {})
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
  info?.("Buckets cap requests over time. You can stack them, for example 40/min + 600/6h.");
}

function buildProviderRateLimitReview(provider) {
  return buildProviderRateLimitReport({
    title: "Rate-Limit Bucket Review",
    providerId: provider?.id,
    rateLimits: provider?.rateLimits || []
  });
}

function buildRateLimitBucketPromptOptions(provider) {
  return (provider?.rateLimits || []).map((bucket) => ({
    value: bucket.id,
    label: formatRateLimitBucketLabel(bucket),
    hint: `${summarizeRateLimitBucketCap(bucket)} · ${formatRateLimitBucketScopeLabel(bucket)}`
  }));
}

function buildRateLimitWindowUnitOptions(initialUnit = "") {
  const options = [
    { value: "minute", label: "Minute" },
    { value: "hour", label: "Hour(s)" },
    { value: "week", label: "Week" },
    { value: "month", label: "Month" }
  ];
  if (initialUnit === "day") {
    options.push({ value: "day", label: "Day (legacy)" });
  }
  if (initialUnit === "second") {
    options.push({ value: "second", label: "Second (legacy)" });
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
        message: "Provider",
        options: buildProviderPromptOptions(config.providers)
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
        message: "Rate limits",
        options: [
          { value: "create", label: "Create", hint: "add one or more buckets" },
          { value: "edit", label: "Edit", hint: "change an existing bucket" },
          { value: "remove", label: "Remove", hint: "delete a bucket" },
          { value: "review", label: "Review", hint: "show current buckets" }
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
          return {
            ok: true,
            mode: context.mode,
            exitCode: EXIT_SUCCESS,
            data: buildProviderRateLimitReport({
              title: "Rate-Limit Bucket Review",
              providerId,
              rateLimits: provider.rateLimits || []
            })
          };
        }

        const selectedBucketId = await context.prompts.select({
          message: "Remove bucket",
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
          data: buildProviderRateLimitReport({
            title: `Rate-Limit Bucket Removed: ${formatRateLimitBucketLabel(selectedBucket, { includeId: true })}`,
            providerId,
            rateLimits: removed.rateLimits || []
          })
        };
      }

      if (action === "edit") {
        const bucketOptions = buildRateLimitBucketPromptOptions(provider);
        if (bucketOptions.length === 0) {
          return {
            ok: true,
            mode: context.mode,
            exitCode: EXIT_SUCCESS,
            data: buildProviderRateLimitReport({
              title: "Rate-Limit Bucket Review",
              providerId,
              rateLimits: provider.rateLimits || []
            })
          };
        }

        const selectedBucketId = await context.prompts.select({
          message: "Edit bucket",
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
          data: buildProviderRateLimitReport({
            title: `Rate-Limit Bucket Updated: ${formatRateLimitBucketLabel(wizard.bucket, { includeId: true })}`,
            providerId,
            rateLimits: updated.rateLimits || []
          })
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
        data: buildProviderRateLimitReport({
          title: "Rate-Limit Buckets Updated",
          providerId,
          rateLimits: updated.rateLimits || []
        })
      };
    }

    if (removeBucket) {
      if (!bucketId) {
        const bucketOptions = buildRateLimitBucketPromptOptions(provider);
        if (bucketOptions.length === 0) {
          return {
            ok: true,
            mode: context.mode,
            exitCode: EXIT_SUCCESS,
            data: buildProviderRateLimitReport({
              title: "Rate-Limit Bucket Review",
              providerId,
              rateLimits: provider.rateLimits || []
            })
          };
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
      data: buildProviderRateLimitReport({
        title: `Rate-Limit Bucket Removed: ${bucketId}`,
        providerId,
        rateLimits: removed.rateLimits || []
      })
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
    data: buildProviderRateLimitReport({
      title: "Rate-Limit Buckets Updated",
      providerId,
      rateLimits: updated.rateLimits || []
    })
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
    data: buildOperationReport(
      "Worker Master Key Updated",
      [
        ["Config File", configPath],
        ["Stored Key", maskSecret(masterKey)],
        ["Generated In This Run", formatYesNo(keyGenerated)]
      ],
      keyGenerated
        ? [renderListSection("Generated Key (Copy Now)", [masterKey])]
        : []
    )
  };
}

async function doSetAmpConfig(context) {
  const args = context.args || {};
  const cwd = context.cwd || process.cwd();
  const env = context.env || process.env;
  const configPath = readArg(args, ["config", "configPath"], getDefaultConfigPath());
  const config = await readConfigFile(configPath);
  const currentAmp = config?.amp && typeof config.amp === "object" && !Array.isArray(config.amp)
    ? config.amp
    : {};

  const clearUpstreamUrl = toBoolean(readArg(args, ["clear-amp-upstream-url", "clearAmpUpstreamUrl"], false), false);
  const clearUpstreamApiKey = toBoolean(readArg(args, ["clear-amp-upstream-api-key", "clearAmpUpstreamApiKey"], false), false);
  const clearModelMappings = toBoolean(readArg(args, ["clear-amp-model-mappings", "clearAmpModelMappings"], false), false);
  const clearSubagentMappings = toBoolean(readArg(args, ["clear-amp-subagent-mappings", "clearAmpSubagentMappings"], false), false);
  const clearSubagentDefinitions = toBoolean(readArg(args, ["clear-amp-subagent-definitions", "clearAmpSubagentDefinitions"], false), false);
  const resetSubagentDefinitions = toBoolean(readArg(args, ["reset-amp-subagent-definitions", "resetAmpSubagentDefinitions"], false), false);
  const clearDefaultRoute = toBoolean(readArg(args, ["clear-amp-default-route", "clearAmpDefaultRoute"], false), false);
  const clearRoutes = toBoolean(readArg(args, ["clear-amp-routes", "clearAmpRoutes"], false), false);
  const clearRawModelRoutes = toBoolean(readArg(args, ["clear-amp-raw-model-routes", "clearAmpRawModelRoutes"], false), false);
  const clearOverrides = toBoolean(readArg(args, ["clear-amp-overrides", "clearAmpOverrides"], false), false);

  let upstreamUrl = readArg(args, ["amp-upstream-url", "ampUpstreamUrl"], undefined);
  let upstreamApiKey = readArg(args, ["amp-upstream-api-key", "ampUpstreamApiKey"], undefined);
  let restrictManagementToLocalhost = readArg(args, ["amp-restrict-management-to-localhost", "ampRestrictManagementToLocalhost"], undefined);
  let forceModelMappings = readArg(args, ["amp-force-model-mappings", "ampForceModelMappings"], undefined);
  let modelMappingsInput = readArg(args, ["amp-model-mappings", "ampModelMappings"], undefined);
  let subagentMappingsInput = readArg(args, ["amp-subagent-mappings", "ampSubagentMappings"], undefined);
  let subagentDefinitionsInput = readArg(args, ["amp-subagent-definitions", "ampSubagentDefinitions"], undefined);
  let ampPreset = readArg(args, ["amp-preset", "ampPreset"], undefined);
  let ampDefaultRoute = readArg(args, ["amp-default-route", "ampDefaultRoute"], undefined);
  let ampRoutesInput = readArg(args, ["amp-routes", "ampRoutes"], undefined);
  let ampRawModelRoutesInput = readArg(args, ["amp-raw-model-routes", "ampRawModelRoutes"], undefined);
  let ampOverridesInput = readArg(args, ["amp-overrides", "ampOverrides"], undefined);

  const patchArgNames = [
    "patch-amp-client-config",
    "patchAmpClientConfig",
    "amp-client-settings-scope",
    "ampClientSettingsScope",
    "amp-client-settings-file",
    "ampClientSettingsFile",
    "amp-client-secrets-file",
    "ampClientSecretsFile",
    "amp-client-url",
    "ampClientUrl",
    "amp-client-api-key",
    "ampClientApiKey"
  ];
  const hasPatchArgs = patchArgNames.some((name) => args[name] !== undefined);
  const hasExplicitAmpArgs = [
    upstreamUrl,
    upstreamApiKey,
    restrictManagementToLocalhost,
    forceModelMappings,
    ampPreset,
    ampDefaultRoute,
    ampRoutesInput,
    ampRawModelRoutesInput,
    ampOverridesInput,
    modelMappingsInput,
    subagentMappingsInput,
    subagentDefinitionsInput
  ].some((value) => value !== undefined) || clearUpstreamUrl || clearUpstreamApiKey || clearModelMappings || clearSubagentMappings || clearSubagentDefinitions || resetSubagentDefinitions || clearDefaultRoute || clearRoutes || clearRawModelRoutes || clearOverrides;
  const hasExplicitArgs = hasExplicitAmpArgs || hasPatchArgs;

  let nextAmp;
  let patchPlan = null;
  let bootstrapDefaultsApplied = false;
  let bootstrapDefaultRoute = "";
  let bootstrapDiscoveredUpstreamApiKey = false;

  if (canUseInteractivePrompts(context) && !hasExplicitArgs) {
    const wizard = await runAmpConfigWizard(context, {
      config,
      currentAmp,
      cwd,
      env
    });
    if (wizard.errorMessage) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: wizard.errorMessage
      };
    }
    if (wizard.cancelled) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_FAILURE,
        errorMessage: "Cancelled."
      };
    }
    nextAmp = wizard.amp || currentAmp;
    patchPlan = wizard.patchPlan || null;
    if (patchPlan && serializeStable(currentAmp || {}) === serializeStable(nextAmp || {})) {
      const bootstrap = await maybeBootstrapAmpPatchDefaults({
        config,
        amp: nextAmp,
        patchPlan,
        env,
        homeDir: os.homedir()
      });
      if (bootstrap.error) {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_VALIDATION,
          errorMessage: bootstrap.error
        };
      }
      nextAmp = bootstrap.amp;
      bootstrapDefaultsApplied = bootstrap.changed === true;
      bootstrapDefaultRoute = bootstrap.bootstrapRouteRef || "";
      bootstrapDiscoveredUpstreamApiKey = bootstrap.discoveredUpstreamApiKey === true;
    }
  } else {
    if (!hasExplicitArgs) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: `No AMP config changes requested. Run '${CLI_COMMAND} config' for the web console or pass --amp-* flags.`
      };
    }

    nextAmp = {
      ...currentAmp,
      ...(clearUpstreamUrl ? { upstreamUrl: "" } : {}),
      ...(clearUpstreamApiKey ? { upstreamApiKey: "" } : {}),
      ...(clearDefaultRoute ? { defaultRoute: "" } : {}),
      ...(clearSubagentMappings ? { subagentMappings: {} } : {}),
      ...(clearSubagentDefinitions ? { subagentDefinitions: [] } : {}),
      ...(clearRoutes ? { routes: {} } : {}),
      ...(clearRawModelRoutes ? { rawModelRoutes: [] } : {}),
      ...(clearOverrides ? { overrides: {} } : {})
    };

    if (upstreamUrl !== undefined) {
      nextAmp.upstreamUrl = String(upstreamUrl || "").trim();
    }
    if (upstreamApiKey !== undefined) {
      nextAmp.upstreamApiKey = String(upstreamApiKey || "").trim();
    }
    if (restrictManagementToLocalhost !== undefined) {
      nextAmp.restrictManagementToLocalhost = toBoolean(
        restrictManagementToLocalhost,
        currentAmp.restrictManagementToLocalhost === true
      );
    }
    if (forceModelMappings !== undefined) {
      nextAmp.forceModelMappings = toBoolean(
        forceModelMappings,
        currentAmp.forceModelMappings === true
      );
    }
    if (ampPreset !== undefined) {
      nextAmp.preset = String(ampPreset || "").trim();
    }
    if (ampDefaultRoute !== undefined) {
      nextAmp.defaultRoute = String(ampDefaultRoute || "").trim();
    }
    if (clearRoutes) {
      nextAmp.routes = {};
    } else {
      const parsedRoutes = parseAmpRoutesArg(ampRoutesInput, "--amp-routes");
      if (parsedRoutes !== undefined) {
        nextAmp.routes = parsedRoutes;
      }
    }
    if (clearRawModelRoutes) {
      nextAmp.rawModelRoutes = [];
    } else {
      const parsedRawModelRoutes = parseAmpModelMappingsArg(ampRawModelRoutesInput, "--amp-raw-model-routes");
      if (parsedRawModelRoutes !== undefined) {
        nextAmp.rawModelRoutes = parsedRawModelRoutes;
      }
    }
    if (clearOverrides) {
      nextAmp.overrides = {};
    } else {
      const parsedOverrides = parseAmpOverridesArg(ampOverridesInput, "--amp-overrides");
      if (parsedOverrides !== undefined) {
        nextAmp.overrides = parsedOverrides;
      }
    }
    if (clearModelMappings) {
      nextAmp.modelMappings = [];
    } else {
      const parsedMappings = parseAmpModelMappingsArg(modelMappingsInput, "--amp-model-mappings");
      if (parsedMappings !== undefined) {
        nextAmp.modelMappings = parsedMappings;
      }
    }
    if (clearSubagentMappings) {
      nextAmp.subagentMappings = {};
    } else {
      const parsedSubagentMappings = parseAmpSubagentMappingsArg(subagentMappingsInput, "--amp-subagent-mappings");
      if (parsedSubagentMappings !== undefined) {
        nextAmp.subagentMappings = parsedSubagentMappings;
      }
    }
    if (resetSubagentDefinitions) {
      delete nextAmp.subagentDefinitions;
    } else if (clearSubagentDefinitions) {
      nextAmp.subagentDefinitions = [];
    } else {
      const parsedSubagentDefinitions = parseAmpSubagentDefinitionsArg(subagentDefinitionsInput, "--amp-subagent-definitions");
      if (parsedSubagentDefinitions !== undefined) {
        nextAmp.subagentDefinitions = parsedSubagentDefinitions;
      }
    }

    const patchResolution = await resolveAmpClientPatchPlanFromArgs(context, {
      config,
      cwd,
      env
    });
    if (patchResolution.error) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_VALIDATION,
        errorMessage: patchResolution.error
      };
    }
    patchPlan = patchResolution.plan;
    if (patchPlan && !hasExplicitAmpArgs) {
      const bootstrap = await maybeBootstrapAmpPatchDefaults({
        config,
        amp: nextAmp,
        patchPlan,
        env,
        homeDir: os.homedir()
      });
      if (bootstrap.error) {
        return {
          ok: false,
          mode: context.mode,
          exitCode: EXIT_VALIDATION,
          errorMessage: bootstrap.error
        };
      }
      nextAmp = bootstrap.amp;
      bootstrapDefaultsApplied = bootstrap.changed === true;
      bootstrapDefaultRoute = bootstrap.bootstrapRouteRef || "";
      bootstrapDiscoveredUpstreamApiKey = bootstrap.discoveredUpstreamApiKey === true;
    }
  }

  const updated = setAmpConfigInConfig(config, nextAmp);
  if (!updated.changed && updated.reason) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: updated.reason
    };
  }

  await writeConfigFile(updated.config, configPath);

  let patchResult = null;
  if (patchPlan) {
    try {
      patchResult = await patchAmpClientConfigFiles(patchPlan);
    } catch (error) {
      return {
        ok: false,
        mode: context.mode,
        exitCode: EXIT_FAILURE,
        errorMessage: `AMP config was saved to ${configPath}, but patching AMP client files failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  let title = updated.changed ? "AMP Config Updated" : "AMP Config Saved";
  if (patchResult) title += " + Client Patched";
  if (bootstrapDefaultsApplied) title += " + Defaults Bootstrapped";

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildOperationReport(
      title,
      [
        ["Config File", configPath],
        ["Config Changed", formatYesNo(updated.changed === true)],
        ["AMP Client Files Patched", formatYesNo(Boolean(patchResult))],
        ["AMP Defaults Bootstrapped", formatYesNo(bootstrapDefaultsApplied)],
        ["Bootstrap Default Route", bootstrapDefaultRoute || "(none)"],
        ["Upstream Key Auto-Discovered", formatYesNo(bootstrapDiscoveredUpstreamApiKey)]
      ],
      [
        buildAmpConfigSection(updated.amp),
        ...(patchResult ? [buildAmpClientPatchSection(patchResult)] : [])
      ]
    )
  };
}

async function doStartupInstall(context) {
  const configPath = readArg(context.args, ["config", "configPath"], getDefaultConfigPath());
  const host = LOCAL_ROUTER_HOST;
  const port = resolveListenPort({ explicitPort: readArg(context.args, ["port"]) });
  const watchConfig = toBoolean(readArg(context.args, ["watch-config", "watchConfig"], true), true);
  const watchBinary = toBoolean(readArg(context.args, ["watch-binary", "watchBinary"], true), true);
  const requireAuth = toBoolean(readArg(context.args, ["require-auth", "requireAuth"], false), false);

  if (!(await configFileExists(configPath))) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `Config not found at ${configPath}. Run '${CLI_COMMAND} config' first.`
    };
  }

  const config = await readConfigFile(configPath);
  if (!configHasProvider(config)) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `No providers configured in ${configPath}. Run '${CLI_COMMAND} config'.`
    };
  }
  if (requireAuth && !config.masterKey) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      errorMessage: `Local auth requires masterKey in ${configPath}. Run '${CLI_COMMAND} config --operation=set-master-key' first.`
    };
  }

  if (canPrompt()) {
    const confirm = await context.prompts.confirm({
      message: `Install ${APP_NAME} startup service on ${process.platform}?`,
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
    data: buildOperationReport(
      "OS Startup Service Installed",
      [
        ["Startup Manager", result.manager || "Unknown"],
        ["Service Name", result.serviceId || "Unknown"],
        ["Service File", result.filePath || "(not provided)"],
        ["Start Target", `http://${host}:${port}`],
        ["Config Hot Reload", watchConfig ? "Enabled" : "Disabled"],
        ["Binary Auto-Restart", watchBinary ? "Enabled" : "Disabled"],
        ["Local API Auth", requireAuth ? "Required (Master Key)" : "Disabled"]
      ]
    )
  };
}

async function doStartupUninstall(context) {
  if (canPrompt()) {
    const confirm = await context.prompts.confirm({
      message: `Uninstall ${APP_NAME} OS startup service?`,
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
    data: buildOperationReport(
      "OS Startup Service Uninstalled",
      [
        ["Startup Manager", result.manager || "Unknown"],
        ["Service Name", result.serviceId || "Unknown"],
        ["Service File", result.filePath || "(not provided)"]
      ]
    )
  };
}

async function doStartupStatus(context) {
  const status = await startupStatus();
  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildOperationReport(
      "OS Startup Service Status",
      [
        ["Startup Manager", status.manager || "Unknown"],
        ["Service Name", status.serviceId || "Unknown"],
        ["Installed", formatYesNo(Boolean(status.installed))],
        ["Running", formatYesNo(Boolean(status.running))],
        ["Service File", status.filePath || "(not provided)"],
        ["Details", status.detail ? String(status.detail).trim() : "(none)"]
      ]
    )
  };
}

async function promptSelectWithEscape(context, options) {
  return runPromptWithEscape(() => context.prompts.select(options));
}

async function promptTextWithEscape(context, options) {
  return runPromptWithEscape(() => context.prompts.text(options));
}

function listProviderModelIds(provider) {
  return dedupeList((provider?.models || []).map((model) => model?.id).filter(Boolean));
}

async function resolveConfigOperation(context) {
  const opArg = String(readArg(context.args, ["operation", "op"], "") || "").trim();
  return opArg || "list";
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
    case "set-amp-config":
    case "set-amp":
      return doSetAmpConfig(context);
    case "set-amp-client-routing":
    case "set-amp-client":
      return doSetAmpClientRouting(context);
    case "set-codex-cli-routing":
    case "set-codex-cli":
      return doSetCodexCliRouting(context);
    case "set-claude-code-routing":
    case "set-claude-code":
      return doSetClaudeCodeRouting(context);
    case "set-claude-code-effort-level":
      return doSetClaudeCodeEffortLevel(context);
    case "discover-provider-models":
      return doDiscoverProviderModels(context);
    case "test-provider":
      return doTestProvider(context);
    case "litellm-context-lookup":
      return doLiteLlmContextLookup(context);
    case "migrate-config":
      return doMigrateConfig(context);
    case "list":
      return doListConfig(context);
    case "validate":
      return doValidateConfig(context);
    case "list-routing":
      return doListRouting(context);
    case "snapshot":
      return doSnapshot(context);
    case "tool-status":
      return doToolStatus(context);
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

async function runWebAction(context) {
  const args = context.args || {};
  const result = await runWebCommand({
    configPath: readArg(args, ["config", "configPath"], getDefaultConfigPath()),
    host: String(readArg(args, ["host"], "127.0.0.1")),
    port: readArg(args, ["port"], 8788),
    open: toBoolean(readArg(args, ["open"], true), true),
    routerHost: LOCAL_ROUTER_HOST,
    routerPort: LOCAL_ROUTER_PORT,
    routerWatchConfig: toBoolean(readArg(args, ["router-watch-config", "routerWatchConfig"], true), true),
    routerWatchBinary: toBoolean(readArg(args, ["router-watch-binary", "routerWatchBinary"], true), true),
    routerRequireAuth: toBoolean(readArg(args, ["router-require-auth", "routerRequireAuth"], false), false),
    allowRemoteClients: toBoolean(readArg(args, ["allow-remote-clients", "allowRemoteClients"], false), false),
    cliPathForRouter: process.argv[1],
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

async function runStartAction(context) {
  const args = context.args || {};
  const result = await runStartCommand({
    configPath: readArg(args, ["config", "configPath"], getDefaultConfigPath()),
    host: LOCAL_ROUTER_HOST,
    port: resolveListenPort({ explicitPort: readArg(args, ["port"]) }),
    watchConfig: toBoolean(readArg(args, ["watch-config", "watchConfig"], true), true),
    watchBinary: toBoolean(readArg(args, ["watch-binary", "watchBinary"], true), true),
    requireAuth: toBoolean(readArg(args, ["require-auth", "requireAuth"], false), false),
    onStartupConflict: canPrompt() && typeof context?.prompts?.select === "function"
      ? ({ port }) => context.prompts.select({
        message: `Port ${port} is already used by the startup service`,
        options: [
          { value: "restart-startup", label: "Restart service", hint: "keep startup mode" },
          { value: "stop-and-start-here", label: "Run here instead", hint: "stop the startup service first" },
          { value: "exit", label: "Cancel" }
        ]
      })
      : undefined,
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
      errorMessage: `Failed to stop ${APP_NAME}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!stopped.ok) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: stopped.reason || `Failed to stop ${APP_NAME}.`
    };
  }

  if (stopped.mode === "startup") {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: buildOperationReport(
        "Router Stopped",
        [
          ["Stop Mode", "Startup-managed service"],
          ["Startup Manager", stopped.detail?.manager || "Unknown"],
          ["Service Name", stopped.detail?.serviceId || "Unknown"]
        ]
      )
    };
  }

  if (stopped.mode === "manual") {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: buildOperationReport(
        "Router Stopped",
        [
          ["Stop Mode", "Manual process"],
          ["Process ID", String(stopped.detail?.pid || "Unknown")],
          ["Signal", stopped.detail?.signal || "SIGTERM"]
        ]
      )
    };
  }

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: `No running ${APP_NAME} instance found.`
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
      errorMessage: `Failed to reload ${APP_NAME}: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!result.ok && result.mode !== "manual-inline") {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: result.reason || `Failed to reload ${APP_NAME}.`
    };
  }

  if (result.mode === "startup") {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: buildOperationReport(
        "Router Reloaded",
        [
          ["Reload Mode", "Startup-managed service"],
          ["Startup Manager", result.detail?.manager || "Unknown"],
          ["Service Name", result.detail?.serviceId || "Unknown"]
        ]
      )
    };
  }

  if (result.mode === "manual-inline") {
    return {
      ok: result.detail?.ok === true,
      mode: context.mode,
      exitCode: result.detail?.exitCode ?? (result.detail?.ok ? EXIT_SUCCESS : EXIT_FAILURE),
      data: result.detail?.data,
      errorMessage: result.detail?.errorMessage || (result.detail?.ok ? undefined : `Failed to restart ${APP_NAME}.`)
    };
  }

  return {
    ok: false,
    mode: context.mode,
    exitCode: EXIT_FAILURE,
    errorMessage: result.reason || `No running ${APP_NAME} instance detected.`
  };
}

async function runReclaimAction(context) {
  const terminal = context.terminal || {};
  const port = LOCAL_ROUTER_PORT;
  const listListeningPidsFn = typeof context.listListeningPids === "function"
    ? context.listListeningPids
    : (targetPort) => listListeningPids(targetPort);
  const reclaimPortFn = typeof context.reclaimPort === "function"
    ? context.reclaimPort
    : (args) => reclaimPort(args);

  const beforeProbe = listListeningPidsFn(port);
  if (beforeProbe.ok && (beforeProbe.pids || []).length === 0) {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: buildOperationReport(
        "Router Port Reclaim",
        [
          ["Port", String(port)],
          ["Busy Before", "No"],
          ["Reclaimed", "No"],
          ["Listener PID(s)", "(none)"]
        ]
      )
    };
  }

  let reclaimed;
  try {
    reclaimed = await reclaimPortFn({
      port,
      line: (message) => terminal.line?.(message),
      error: (message) => terminal.error?.(message)
    });
  } catch (error) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: `Failed to reclaim router port ${port}: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!reclaimed?.ok) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: reclaimed?.errorMessage || `Failed to reclaim router port ${port}.`
    };
  }

  const afterProbe = listListeningPidsFn(port);
  const remainingPids = afterProbe.ok ? afterProbe.pids || [] : [];
  const beforePids = beforeProbe.ok ? beforeProbe.pids || [] : [];

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildOperationReport(
      "Router Port Reclaim",
      [
        ["Port", String(port)],
        ["Busy Before", formatYesNo(beforePids.length > 0)],
        ["Reclaimed", "Yes"],
        ["Listener PID(s) Before", beforePids.length > 0 ? beforePids.join(", ") : "(none)"],
        ["Listener PID(s) After", remainingPids.length > 0 ? remainingPids.join(", ") : "(none)"]
      ]
    )
  };
}

async function runUpdateAction(context) {
  const args = context.args || {};
  const line = typeof context?.terminal?.line === "function" ? context.terminal.line.bind(context.terminal) : console.log;
  const checkOnly = toBoolean(readArg(args, ["check", "check-only", "checkOnly"], false), false);
  const installFlag = parseOptionalBoolean(readArg(args, ["install"], undefined));
  const updateCheck = await checkForPackageUpdate(NPM_PACKAGE_NAME);

  if (updateCheck.ok) {
    line(`Current version: ${updateCheck.currentVersion || "unknown"}`);
    line(`Latest version: ${updateCheck.latestVersion}`);
  } else if (checkOnly) {
    return {
      ok: false,
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      errorMessage: `Failed to check latest ${NPM_PACKAGE_NAME} version: ${updateCheck.errorMessage}`
    };
  } else {
    line(`Unable to verify latest version before install: ${updateCheck.errorMessage}`);
  }

  if (checkOnly) {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: updateCheck.ok
        ? (updateCheck.updateAvailable
          ? `Update available for ${NPM_PACKAGE_NAME}: ${updateCheck.currentVersion || "unknown"} -> ${updateCheck.latestVersion}`
          : `${NPM_PACKAGE_NAME} is already up to date (${updateCheck.currentVersion || updateCheck.latestVersion}).`)
        : `Update check failed for ${NPM_PACKAGE_NAME}: ${updateCheck.errorMessage}`
    };
  }

  if (updateCheck.ok && !updateCheck.updateAvailable && installFlag !== true) {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: `${NPM_PACKAGE_NAME} is already up to date (${updateCheck.currentVersion || updateCheck.latestVersion}).`
    };
  }

  let shouldInstall = installFlag !== false;
  if (installFlag === undefined && canPrompt()) {
    shouldInstall = await context.prompts.confirm({
      message: updateCheck.ok && updateCheck.updateAvailable
        ? `Install update ${updateCheck.currentVersion || "current"} -> ${updateCheck.latestVersion}?`
        : `Install ${NPM_PACKAGE_NAME}@latest now?`,
      initialValue: true
    });
  }

  if (!shouldInstall) {
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: updateCheck.ok && updateCheck.updateAvailable
        ? `Update available for ${NPM_PACKAGE_NAME}: ${updateCheck.currentVersion || "unknown"} -> ${updateCheck.latestVersion}. Installation skipped.`
        : `Skipped installing ${NPM_PACKAGE_NAME}@latest.`
    };
  }

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

  const postInstallCheck = await checkForPackageUpdate(NPM_PACKAGE_NAME);
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
  if (postInstallCheck.ok) {
    details.push(`Installed version: ${postInstallCheck.currentVersion || postInstallCheck.latestVersion}`);
  } else if (updateCheck.ok) {
    details.push(`Target version: ${updateCheck.latestVersion}`);
  }
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

  const portProbe = !serverRunning ? listListeningPids(LOCAL_ROUTER_PORT) : { ok: true, pids: [] };
  const portBusyPids = !serverRunning && portProbe.ok
    ? (portProbe.pids || []).filter((pid) => Number.isInteger(pid) && pid > 0)
    : [];

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
    suggestions.push(`Add first provider with at least one model. Run: ${CLI_COMMAND} config --operation=upsert-provider --provider-id=<id> --name="<name>" --base-url=<url> --api-key=<key> --models=<model1,model2>`);
    suggestions.push(`Or add OAuth-backed subscription provider. Run: ${CLI_COMMAND} config --operation=upsert-provider --provider-id=chatgpt --name="GPT Sub" --type=subscription --subscription-type=chatgpt-codex --subscription-profile=default (or use --subscription-type=claude-code).`);
  } else {
    const providersWithoutModels = providers
      .filter((provider) => (provider.models || []).filter((model) => model && model.enabled !== false).length === 0)
      .map((provider) => provider.id);
    if (providersWithoutModels.length > 0) {
      suggestions.push(`Add models to provider(s) with empty model list: ${providersWithoutModels.join(", ")}. Run: ${CLI_COMMAND} config --operation=upsert-provider --provider-id=<id> --models=<model1,model2>`);
    }
  }

  if (modelCount > 0 && aliasCount === 0) {
    suggestions.push(`Create a model alias/group for stable app routing. Run: ${CLI_COMMAND} config --operation=upsert-model-alias --alias-id=chat.default --strategy=auto --targets=<provider/model,...>`);
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
    suggestions.push(`Add at least one provider rate-limit bucket for quota safety. Run: ${CLI_COMMAND} config --operation=set-provider-rate-limits --provider-id=<id> --bucket-name="Monthly cap" --bucket-models=all --bucket-requests=<n> --bucket-window=month:1`);
  }

  if (!hasMasterKey) {
    suggestions.push(`Set master key for authenticated access. Run: ${CLI_COMMAND} config --operation=set-master-key --generate-master-key=true`);
  }

  if (!serverRunning) {
    suggestions.push(`Start local proxy server. Run: ${CLI_COMMAND} start${hasMasterKey ? " --require-auth=true" : ""}`);
    if (portBusyPids.length > 0) {
      suggestions.push(`Port ${LOCAL_ROUTER_PORT} is occupied by PID(s) ${portBusyPids.join(", ")}. Reclaim it with: ${CLI_COMMAND} reclaim`);
    }
  } else {
    suggestions.push(`Local proxy is running on http://${runtimeState.host}:${runtimeState.port}. Apply config changes with ${CLI_COMMAND} config; updates hot-reload automatically.`);
  }

  if (serverRunning && skipLiveTest) {
    suggestions.push(`Run a live ${APP_NAME} API test before patching coding-tool config. Re-run: ${CLI_COMMAND} ai-help --skip-live-test=false`);
  }

  if (liveTest.ran && claudePatchGate !== "ready") {
    suggestions.push(`Claude/OpenCode patch gate is blocked. Fix ${APP_NAME} auth/provider/model readiness, then re-run ${CLI_COMMAND} ai-help.`);
  }
  if (liveTest.ran && codexPatchGate === "blocked-responses-endpoint-missing") {
    suggestions.push(`Codex CLI requires OpenAI Responses API. Current ${APP_NAME} endpoint does not expose /openai/v1/responses; do not patch Codex until this gate is resolved.`);
  }

  if (suggestions.length === 0) {
    suggestions.push(`No blocking setup gaps detected. Review routing summary with: ${CLI_COMMAND} config --operation=list-routing`);
  }

  const runtimeConfigPathForDisplay = runtimeConfigPath ? toHomeRelativePath(runtimeConfigPath) : "";
  const gatewayBaseUrlForGuide = liveTest.baseUrl || (serverRunning ? `http://${runtimeState.host}:${runtimeState.port}` : LOCAL_ROUTER_ORIGIN);
  const authGuideHeaders = runtimeRequiresAuth ? ["Authorization: Bearer <master_key>"] : [];

  const lines = [
    "# AI-HELP",
    `ENTITY: ${APP_NAME}`,
    "MODE: cli-automation",
    "PROFILE: agent-guide-v2",
    "",
    "## INTRO",
    `Use this output as an AI-agent operating brief for ${APP_NAME}.`,
    `The agent should auto-discover commands, inspect current state, configure ${APP_NAME} on your behalf, run live API gates, and only then patch coding tool configs.`,
    "",
    `## WHAT AGENT CAN DO WITH ${APP_NAME.toUpperCase()}`,
    `- explain ${APP_NAME} capabilities and current setup readiness`,
    "- set provider, model list, model alias/group, and rate-limit buckets via CLI",
    `- validate raw ${APP_NAME} config JSON + schema before applying routing changes`,
    `- validate local ${APP_NAME} endpoint health/model-list/routes with real API probes`,
    `- reclaim the fixed local router port when another listener is blocking startup`,
    "- patch Claude Code, Codex CLI, and AMP client configs directly via CLI after pre-patch gates pass",
    "",
    "## DISCOVERY COMMANDS",
    `- ${CLI_COMMAND} -h`,
    `- ${CLI_COMMAND} config -h`,
    `- ${CLI_COMMAND} start -h`,
    `- ${CLI_COMMAND} reclaim`,
    `- ${CLI_COMMAND} deploy -h`,
    `- ${CLI_COMMAND} config --operation=validate`,
    `- ${CLI_COMMAND} config --operation=snapshot`,
    `- ${CLI_COMMAND} config --operation=tool-status`,
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
    !serverRunning && portBusyPids.length > 0 ? `- local_router_port_busy=true (pids=${portBusyPids.join(", ")})` : "",
    runtimeState ? `- local_server_require_auth=${runtimeRequiresAuth}` : "",
    runtimeConfigPathForDisplay ? `- local_server_config_path=${runtimeConfigPathForDisplay}` : "",
    "",
    "## MODEL/GROUP DECISION INPUT (REQUIRED BEFORE PATCHING TOOL CONFIG)",
    "- Ask user to choose target_tool: claude-code | codex-cli | amp-client",
    "- Ask user to choose target_model_or_group for that tool",
    `- available_alias_groups=${aliasIds.join(", ") || "(none)"}`,
    `- available_direct_models=${directModelRefs.join(", ") || "(none)"}`,
    `- decision_options_preview=${modelDecisionOptions.slice(0, 12).join(", ") || "(none)"}`,
    `- If user chooses an alias/group, keep alias id unchanged so ${APP_NAME} balancing still works.`,
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
    `## ${APP_NAME.toUpperCase()} CONFIG WORKFLOWS (CLI)`,
    "0. Validate raw config JSON + schema:",
    `   ${CLI_COMMAND} config --operation=validate`,
    "1. Snapshot current runtime + tool routing state:",
    `   ${CLI_COMMAND} config --operation=snapshot`,
    `   ${CLI_COMMAND} config --operation=tool-status`,
    "2. Upsert provider + models:",
    `   ${CLI_COMMAND} config --operation=upsert-provider --provider-id=<id> --name="<name>" --endpoints=<url1,url2> --api-key=<key> --models=<model1,model2>`,
    "2a. Run standalone provider diagnostics before saving when needed:",
    `   ${CLI_COMMAND} config --operation=discover-provider-models --endpoints=<url1,url2> --api-key=<key>`,
    `   ${CLI_COMMAND} config --operation=test-provider --endpoints=<url1,url2> --api-key=<key> --models=<model1,model2>`,
    `   ${CLI_COMMAND} config --operation=litellm-context-lookup --models=<model1,model2>`,
    "2b. Upsert subscription provider (OAuth-backed ChatGPT Codex / Claude Code):",
    `   ${CLI_COMMAND} config --operation=upsert-provider --provider-id=chatgpt --name="GPT Sub" --type=subscription --subscription-type=chatgpt-codex --subscription-profile=default`,
    `   ${CLI_COMMAND} config --operation=upsert-provider --provider-id=claude-sub --name="Claude Sub" --type=subscription --subscription-type=claude-code --subscription-profile=default`,
    `   ${CLI_COMMAND} subscription login --subscription-type=chatgpt-codex --profile=default`,
    `   ${CLI_COMMAND} subscription login --subscription-type=claude-code --profile=default`,
    "3. Upsert model alias/group:",
    `   ${CLI_COMMAND} config --operation=upsert-model-alias --alias-id=<alias> --strategy=auto --targets=<provider/model,...>`,
    "4. Set provider rate limit bucket:",
    `   ${CLI_COMMAND} config --operation=set-provider-rate-limits --provider-id=<id> --bucket-name="Monthly cap" --bucket-models=all --bucket-requests=<n> --bucket-window=month:1`,
    "5. Review final routing summary:",
    `   ${CLI_COMMAND} config --operation=list-routing`,
    "6. Reclaim the fixed local router port when startup is blocked by another listener:",
    `   ${CLI_COMMAND} reclaim`,
    "",
    "## CODING TOOL PATCH PLAYBOOK",
    "### Claude Code",
    "- required_gate=patch_gate_claude_code=ready",
    `- enable/update route: ${CLI_COMMAND} config --operation=set-claude-code-routing --enabled=true --primary-model=<target_model_or_group>`,
    `- optional bindings: --default-opus-model=<route> --default-sonnet-model=<route> --default-haiku-model=<route> --subagent-model=<route> --thinking-level=low|medium|high|max (sets CLAUDE_CODE_EFFORT_LEVEL in shell profile)`,
    `- disable route: ${CLI_COMMAND} config --operation=set-claude-code-routing --enabled=false`,
    `- standalone effort level (no router needed): ${CLI_COMMAND} config --operation=set-claude-code-effort-level --thinking-level=low|medium|high|max`,
    "",
    "### Codex CLI",
    "- required_gate=patch_gate_codex_cli=ready",
    "- hard requirement: Codex uses OpenAI Responses API; /openai/v1/responses must be reachable",
    `- managed binding mode: ${CLI_COMMAND} config --operation=set-codex-cli-routing --enabled=true --default-model=<target_model_or_group>`,
    `- inherit-cli mode: ${CLI_COMMAND} config --operation=set-codex-cli-routing --enabled=true --default-model=${CODEX_CLI_INHERIT_MODEL_VALUE}`,
    `- optional reasoning flag: --thinking-level=minimal|low|medium|high|xhigh`,
    `- disable route: ${CLI_COMMAND} config --operation=set-codex-cli-routing --enabled=false`,
    "",
    "### AMP Client",
    "- use this when AMP should globally route through the local LLM Router gateway",
    `- enable/update route: ${CLI_COMMAND} config --operation=set-amp-client-routing --enabled=true --amp-client-settings-scope=workspace`,
    `- disable route: ${CLI_COMMAND} config --operation=set-amp-client-routing --enabled=false --amp-client-settings-scope=workspace`,
    `- router-side AMP config still lives under ${CLI_COMMAND} config --operation=set-amp-config ...`,
    "",
    "### OpenCode",
    "- no first-class llr patch command currently; use manual config edits only after the same OpenAI gate checks pass",
    "",
    "## NEXT SUGGESTIONS",
    ...suggestions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## UPDATE RULE",
    `When the local server is running, ${CLI_COMMAND} config changes are hot-reloaded in memory (no manual restart required).`,
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
      const exportWarnings = [
        ...largeConfigWarningLines,
        mustConfirmLargeConfig
          ? "Manual deploy may fail on Cloudflare Free tier unless you reduce config size."
          : ""
      ].filter(Boolean);
      return {
        ok: true,
        mode: context.mode,
        exitCode: EXIT_SUCCESS,
        data: buildOperationReport(
          "Worker Config Exported",
          [
            ["Export File", resolvedOut],
            ["Payload Size (bytes)", new Intl.NumberFormat("en-US").format(payloadBytes)],
            ["Cloudflare Tier", `${formatCloudflareTierLabel(tierReport)} (${tierReport.reason || "unknown"})`],
            ["Environment", cfEnv || "(default)"]
          ],
          [
            renderListSection("Warnings", exportWarnings, { emptyMessage: "None." }),
            renderListSection("Next Command", [
              `wrangler secret put LLM_ROUTER_CONFIG_JSON${cfEnv ? ` --env ${cfEnv}` : ""} < ${resolvedOut}`
            ])
          ]
        )
      };
    }
  }

  if (dryRun) {
    const dryRunWarnings = [
      allowWeakMasterKey ? "Weak master key override is enabled." : "",
      ...largeConfigWarningLines,
      mustConfirmLargeConfig
        ? "Interactive deploy requires explicit confirmation (default: No)."
        : "",
      mustConfirmLargeConfig
        ? "Use --allow-large-config=true to bypass this check in non-interactive mode."
        : "",
      generatedDeployMasterKey ? "Generated a deploy-time master key (not written to local config)." : ""
    ].filter(Boolean);
    const dryRunCommands = [
      `wrangler${wranglerConfigPath ? ` --config ${wranglerConfigPath}` : ""} secret put LLM_ROUTER_CONFIG_JSON${cfEnv ? ` --env ${cfEnv}` : ""}`,
      `wrangler${wranglerConfigPath ? ` --config ${wranglerConfigPath}` : ""} deploy${cfEnv ? ` --env ${cfEnv}` : ""}`
    ];
    return {
      ok: true,
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: buildOperationReport(
        "Cloudflare Deploy Dry Run",
        [
          ["Project Directory", projectDir],
          ["Wrangler Config", wranglerConfigPath || "(default)"],
          ["Cloudflare API Token Source", cloudflareApiTokenSource === "none"
            ? "(not set)"
            : (cloudflareApiTokenSource === "prompt" ? "Prompt input" : `Environment (${cloudflareApiTokenSource})`)],
          ["Cloudflare Account ID", cloudflareAccountId || "(not set)"],
          ["Cloudflare Tier", `${formatCloudflareTierLabel(tierReport)} (${tierReport.reason || "unknown"})`],
          ["Environment", cfEnv || "(default)"],
          ["Payload Size (bytes)", new Intl.NumberFormat("en-US").format(payloadBytes)],
          ["Generated Deploy Key", formatYesNo(generatedDeployMasterKey)],
          ["Weak Key Override", formatYesNo(allowWeakMasterKey)]
        ],
        [
          renderListSection("Warnings", dryRunWarnings, { emptyMessage: "None." }),
          renderListSection("Commands", dryRunCommands)
        ]
      )
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
      `- Claude Code base URL: https://${deployHost}/anthropic (no local port suffix)`
    ].join("\n")
    : "";

  return {
    ok: true,
    mode: context.mode,
    exitCode: EXIT_SUCCESS,
    data: buildOperationReport(
      "Cloudflare Deployment Completed",
      [
        ["Project Directory", projectDir],
        ["Environment", cfEnv || "(default)"],
        ["Deploy Target", deployUsesWorkersDev ? "workers.dev" : (deployHost ? deployHost : "custom route")],
        ["Deploy Zone", deployZoneName || "(not set)"],
        ["Generated Deploy Key", formatYesNo(generatedDeployMasterKey)]
      ],
      [
        renderListSection(
          "Notes",
          [
            generatedDeployMasterKey
              ? `Generated a deploy-time master key. Persist it with \`${CLI_COMMAND} config --operation=set-master-key --master-key=...\` if needed.`
              : "",
            wranglerTargetMessage
          ],
          { emptyMessage: "None." }
        ),
        renderListSection("Wrangler Output", [secretResult.stdout.trim(), deployResult.stdout.trim()], { emptyMessage: "No additional output." }),
        postDeployGuide
          ? renderListSection("Post-Deploy Checks", [
            `dig +short ${deployHost} @1.1.1.1`,
            `curl -I https://${deployHost}/anthropic`,
            `Claude Code base URL: https://${deployHost}/anthropic (no local port suffix)`
          ])
          : ""
      ]
    )
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
      data: buildOperationReport(
        "Worker Key Dry Run",
        [
          ["Project Directory", projectDir],
          ["Environment", cfEnv || "(default)"],
          ["Target Secret", "LLM_ROUTER_MASTER_KEY"],
          ["Secret Exists", exists === null ? "Unknown" : formatYesNo(Boolean(exists))],
          ["Stored Key", maskSecret(masterKey)],
          ["Generated In This Run", formatYesNo(keyGenerated)],
          ["Weak Key Override", formatYesNo(allowWeakMasterKey)]
        ],
        [
          renderListSection(
            "Warnings",
            [
              allowWeakMasterKey ? "Weak master key override is enabled." : "",
              keyGenerated ? "Generated key for this operation." : ""
            ],
            { emptyMessage: "None." }
          ),
          renderListSection("Command", [
            `wrangler secret put LLM_ROUTER_MASTER_KEY${cfEnv ? ` --env ${cfEnv}` : ""}`
          ])
        ]
      )
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
    data: buildOperationReport(
      `${exists === true ? "Worker Key Updated" : "Worker Key Set"}`,
      [
        ["Target Secret", "LLM_ROUTER_MASTER_KEY"],
        ["Environment", cfEnv || "(default)"],
        ["Project Directory", projectDir],
        ["Stored Key", maskSecret(masterKey)],
        ["Generated In This Run", formatYesNo(keyGenerated)]
      ],
      [
        keyGenerated
          ? renderListSection("Generated Key (Copy Now)", [masterKey])
          : "",
        renderListSection("Wrangler Output", [putResult.stdout.trim()], { emptyMessage: "No additional output." })
      ]
    )
  };
}

// ============================================================================
// Subscription Provider Actions
// ============================================================================

/**
 * Run subscription login action.
 * Supports browser-based and device code OAuth flows.
 */
async function runSubscriptionLoginAction(context) {
  const args = context.args || {};
  const profile = String(readArg(args, ["profile", "profileId"], "default") || "default").trim();
  const deviceCode = toBoolean(readArg(args, ["device-code", "deviceCode"], false), false);
  const rawSubscriptionType = String(readArg(args, ["subscription-type", "subscriptionType"], "") || "").trim();
  const normalizedSubscriptionType = normalizeSubscriptionTypeInput(rawSubscriptionType);
  if (rawSubscriptionType && !normalizedSubscriptionType) {
    return {
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      data: `Unsupported subscription-type '${rawSubscriptionType}'. Supported: ${formatSupportedSubscriptionTypes()}.`
    };
  }
  const subscriptionType = normalizedSubscriptionType || SUBSCRIPTION_TYPE_CHATGPT_CODEX;
  const subscriptionPreset = getSubscriptionProviderPreset(subscriptionType);
  const subscriptionLabel = subscriptionPreset?.label || subscriptionType;
  if (deviceCode && subscriptionType === SUBSCRIPTION_TYPE_CLAUDE_CODE) {
    return {
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      data: "Device code flow is not supported for subscription-type=claude-code. Use browser OAuth login."
    };
  }
  
  // Import subscription auth functions
  const { loginWithBrowser, loginWithDeviceCode } = await import("../runtime/subscription-auth.js");
  
  const lines = [];
  lines.push(`Logging into subscription profile: ${profile}`);
  lines.push(`Subscription provider: ${subscriptionLabel} (${subscriptionType})`);
  lines.push("");
  
  try {
    if (deviceCode) {
      lines.push("Using device code flow (for headless environments)...");
      lines.push("");
      
      const success = await loginWithDeviceCode(profile, {
        subscriptionType,
        onCode: ({ userCode, verificationUri, expiresIn }) => {
          lines.push(`1. Go to: ${verificationUri}`);
          lines.push(`2. Enter code: ${userCode}`);
          lines.push(`   (expires in ${Math.floor(expiresIn / 60)} minutes)`);
          lines.push("");
          lines.push("Waiting for authentication...");
        }
      });
      
      if (success) {
        lines.push("");
        lines.push("✓ Successfully authenticated!");
        lines.push(`Profile '${profile}' is now logged in.`);
      }
    } else {
      lines.push("Opening browser for OAuth login...");
      lines.push("");
      
      const success = await loginWithBrowser(profile, {
        subscriptionType,
        onUrl: (url, meta = {}) => {
          if (meta?.openedBrowser === true) {
            lines.push("Opened browser for OAuth login.");
            lines.push(`Fallback URL: ${url}`);
            return;
          }
          lines.push(`Open this URL to login: ${url}`);
        }
      });
      
      if (success) {
        lines.push("");
        lines.push("✓ Successfully authenticated!");
        lines.push(`Profile '${profile}' is now logged in.`);
      }
    }
    
    return {
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: lines.join("\n")
    };
  } catch (error) {
    lines.push("");
    lines.push(`✗ Login failed: ${error instanceof Error ? error.message : String(error)}`);
    
    return {
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      data: lines.join("\n")
    };
  }
}

/**
 * Run subscription logout action.
 */
async function runSubscriptionLogoutAction(context) {
  const args = context.args || {};
  const profile = String(readArg(args, ["profile", "profileId"], "default") || "default").trim();
  const rawSubscriptionType = String(readArg(args, ["subscription-type", "subscriptionType"], "") || "").trim();
  const normalizedSubscriptionType = normalizeSubscriptionTypeInput(rawSubscriptionType);
  if (rawSubscriptionType && !normalizedSubscriptionType) {
    return {
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      data: `Unsupported subscription-type '${rawSubscriptionType}'. Supported: ${formatSupportedSubscriptionTypes()}.`
    };
  }
  const subscriptionType = normalizedSubscriptionType || SUBSCRIPTION_TYPE_CHATGPT_CODEX;
  const subscriptionPreset = getSubscriptionProviderPreset(subscriptionType);
  const subscriptionLabel = subscriptionPreset?.label || subscriptionType;
  
  // Import subscription auth functions
  const { logout } = await import("../runtime/subscription-auth.js");
  
  const lines = [];
  lines.push(`Logging out subscription profile: ${profile}`);
  lines.push(`Subscription provider: ${subscriptionLabel} (${subscriptionType})`);
  
  try {
    await logout(profile, { subscriptionType });
    lines.push("");
    lines.push(`✓ Successfully logged out profile '${profile}'.`);
    
    return {
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: lines.join("\n")
    };
  } catch (error) {
    lines.push("");
    lines.push(`✗ Logout failed: ${error instanceof Error ? error.message : String(error)}`);
    
    return {
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      data: lines.join("\n")
    };
  }
}

/**
 * Run subscription status action.
 */
async function runSubscriptionStatusAction(context) {
  const args = context.args || {};
  const profile = String(readArg(args, ["profile", "profileId"], "") || "").trim();
  const rawSubscriptionType = String(readArg(args, ["subscription-type", "subscriptionType"], "") || "").trim();
  const normalizedSubscriptionType = normalizeSubscriptionTypeInput(rawSubscriptionType);
  if (rawSubscriptionType && !normalizedSubscriptionType) {
    return {
      mode: context.mode,
      exitCode: EXIT_VALIDATION,
      data: `Unsupported subscription-type '${rawSubscriptionType}'. Supported: ${formatSupportedSubscriptionTypes()}.`
    };
  }
  const subscriptionType = normalizedSubscriptionType || SUBSCRIPTION_TYPE_CHATGPT_CODEX;
  const subscriptionPreset = getSubscriptionProviderPreset(subscriptionType);
  const subscriptionLabel = subscriptionPreset?.label || subscriptionType;
  
  // Import subscription auth functions
  const { getAuthStatus, listTokenProfiles } = await import("../runtime/subscription-auth.js");
  
  const lines = [];
  lines.push(`Subscription provider: ${subscriptionLabel} (${subscriptionType})`);
  lines.push("");
  
  try {
    if (profile) {
      // Show status for specific profile
      const status = await getAuthStatus(profile, { subscriptionType });
      
      lines.push(`Subscription Profile: ${profile}`);
      lines.push(`Status: ${status.authenticated ? "✓ Authenticated" : "✗ Not authenticated"}`);
      
      if (status.authenticated) {
        lines.push(`Expires: ${status.expiresAtIso}`);
        lines.push(`Has refresh token: ${status.hasRefreshToken ? "Yes" : "No"}`);
      } else if (status.reason) {
        lines.push(`Reason: ${status.reason}`);
      }
    } else {
      // List all profiles
      const profiles = await listTokenProfiles({ subscriptionType });
      
      lines.push("Subscription Profiles:");
      lines.push("");
      
      if (profiles.length === 0) {
        lines.push("  No authenticated profiles found.");
        lines.push("");
        lines.push(`  To login: ${CLI_COMMAND} subscription login --subscription-type=${subscriptionType} --profile=<name>`);
      } else {
        for (const p of profiles) {
          const status = await getAuthStatus(p, { subscriptionType });
          const statusIcon = status.authenticated ? "✓" : "✗";
          lines.push(`  ${statusIcon} ${p}`);
          if (status.authenticated && status.expiresAtIso) {
            lines.push(`      Expires: ${status.expiresAtIso}`);
          }
        }
      }
    }
    
    return {
      mode: context.mode,
      exitCode: EXIT_SUCCESS,
      data: lines.join("\n")
    };
  } catch (error) {
    lines.push(`✗ Status check failed: ${error instanceof Error ? error.message : String(error)}`);
    
    return {
      mode: context.mode,
      exitCode: EXIT_FAILURE,
      data: lines.join("\n")
    };
  }
}

const routerModule = {
  moduleId: "router",
  description: "LLM Router local start, config manager, and Cloudflare deploy.",
  actions: [
    {
      actionId: "start",
      description: "Start the local LLM Router gateway.",
      tui: { steps: ["cli-only"] },
      commandline: { requiredArgs: [], optionalArgs: ["config", "watch-config", "watch-binary", "require-auth"] },
      help: {
        summary: "Start the local LLM Router gateway on localhost. Hot-reloads config in memory and auto-relaunches after upgrades.",
        args: [
          { name: "config", required: false, description: "Path to config file.", example: "--config=~/.llm-router.json" },
          { name: "watch-config", required: false, description: "Hot-reload config in memory without process restart.", example: "--watch-config=true" },
          { name: "watch-binary", required: false, description: "Watch for LLM Router upgrades and relaunch the latest version.", example: "--watch-binary=true" },
          { name: "require-auth", required: false, description: "Require local API auth using config.masterKey.", example: "--require-auth=true" }
        ],
        examples: [`${CLI_COMMAND} start`, `${CLI_COMMAND} start --require-auth=true`],
        useCases: [
          {
            name: "run local route",
            description: "Serve Anthropic and OpenAI route endpoints locally.",
            command: `${CLI_COMMAND} start`
          }
        ],
        keybindings: ["Ctrl+C stop"]
      },
      run: runStartAction
    },
    {
      actionId: "web",
      description: "Open a local Claude-light web console for config editing and router control.",
      tui: { steps: ["cli-only"] },
      commandline: { requiredArgs: [], optionalArgs: ["host", "port", "config", "open", "router-watch-config", "router-watch-binary", "router-require-auth", "allow-remote-clients"] },
      help: {
        summary: "Launch the browser-based LLM Router console with a richer UI for editing config JSON, probing providers, and starting or stopping the local router.",
        args: [
          { name: "host", required: false, description: "Web console listen host.", example: "--host=127.0.0.1" },
          { name: "port", required: false, description: "Web console listen port (or use LLM_ROUTER_WEB_PORT / PORT env).", example: "--port=8788" },
          { name: "config", required: false, description: "Path to config file.", example: "--config=~/.llm-router.json" },
          { name: "open", required: false, description: "Open the browser automatically.", example: "--open=true" },
          { name: "router-watch-config", required: false, description: "Default watch-config value for the managed router.", example: "--router-watch-config=true" },
          { name: "router-watch-binary", required: false, description: "Default watch-binary value for the managed router.", example: "--router-watch-binary=true" },
          { name: "router-require-auth", required: false, description: "Default auth requirement for the managed router.", example: "--router-require-auth=false" },
          { name: "allow-remote-clients", required: false, description: "Allow non-localhost browser access to the management UI (not recommended).", example: "--allow-remote-clients=true" }
        ],
        examples: [`${CLI_COMMAND} web`, `${CLI_COMMAND} web --port=9090`, `${CLI_COMMAND} web --open=false`],
        useCases: [
          {
            name: "manage router in browser",
            description: "Use a Claude-light web UI to edit config, probe providers, and control the local route server.",
            command: `${CLI_COMMAND} web`
          }
        ],
        keybindings: ["Exit Web button", "Ctrl+C stop"]
      },
      run: runWebAction
    },
    {
      actionId: "stop",
      description: "Stop a running LLM Router instance (manual or OS startup-managed).",
      tui: { steps: ["cli-only"] },
      commandline: { requiredArgs: [], optionalArgs: [] },
      help: {
        summary: "Stop a running LLM Router instance.",
        args: [],
        examples: [`${CLI_COMMAND} stop`],
        useCases: [
          {
            name: "stop instance",
            description: "Stops startup-managed service or running terminal process.",
            command: `${CLI_COMMAND} stop`
          }
        ],
        keybindings: []
      },
      run: runStopAction
    },
    {
      actionId: "reclaim",
      description: "Force-free the fixed local router port when another listener is blocking startup.",
      tui: { steps: ["cli-only"] },
      commandline: { requiredArgs: [], optionalArgs: [] },
      help: {
        summary: "Reclaim the fixed local router port by stopping whatever process is currently listening on it.",
        args: [],
        examples: [`${CLI_COMMAND} reclaim`],
        useCases: [
          {
            name: "free blocked port",
            description: "Stops the current listener on the fixed local router port so LLM Router can start cleanly.",
            command: `${CLI_COMMAND} reclaim`
          }
        ],
        keybindings: []
      },
      run: runReclaimAction
    },
    {
      actionId: "reload",
      description: "Force restart a running LLM Router instance.",
      tui: { steps: ["cli-only"] },
      commandline: { requiredArgs: [], optionalArgs: [] },
      help: {
        summary: "Restart a running LLM Router instance: restart the startup service or restart a terminal instance in the current terminal.",
        args: [],
        examples: [`${CLI_COMMAND} reload`],
        useCases: [
          {
            name: "force restart",
            description: "Restarts the currently running LLM Router instance.",
            command: `${CLI_COMMAND} reload`
          }
        ],
        keybindings: []
      },
      run: runReloadAction
    },
    {
      actionId: "update",
      description: "Update the global LLM Router package to latest and reload the running instance.",
      tui: { steps: ["cli-only"] },
      commandline: { requiredArgs: [], optionalArgs: ["check", "check-only", "install"] },
      help: {
        summary: "Check latest npm version, optionally install it, and reload any running instance onto the latest installed build.",
        args: [
          { name: "check", required: false, description: "Check latest published version only; do not install.", example: "--check=true" },
          { name: "check-only", required: false, description: "Alias for --check=true.", example: "--check-only=true" },
          { name: "install", required: false, description: "Force install or skip install after the version check.", example: "--install=true" }
        ],
        examples: [`${CLI_COMMAND} update`, `${CLI_COMMAND} update --check=true`, `${CLI_COMMAND} update --install=true`],
        useCases: [
          {
            name: "upgrade cli",
            description: "Checks for updates, installs latest global package, and reloads startup/manual running instance.",
            command: `${CLI_COMMAND} update`
          }
        ],
        keybindings: []
      },
      run: runUpdateAction
    },
    {
      actionId: "ai-help",
      description: "Print an AI-agent guide with LLM Router setup workflows, live API gates, and coding-tool patch playbooks.",
      tui: { steps: ["cli-only"] },
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
        summary: "AI guide for setup + operation: config validation, state snapshot, provider workflows, live gateway tests, reclaim guidance, and patch rules for Claude/Codex/OpenCode.",
        args: [
          { name: "config", required: false, description: "Path to config file used for state-aware suggestions.", example: "--config=~/.llm-router.json" },
          { name: "skip-live-test", required: false, description: "Skip live LLM Router API probes in ai-help output.", example: "--skip-live-test=true" },
          { name: "live-test-timeout-ms", required: false, description: `HTTP timeout for ai-help live probes (default ${DEFAULT_AI_HELP_GATEWAY_TEST_TIMEOUT_MS}ms).`, example: "--live-test-timeout-ms=8000" },
          { name: "gateway-auth-token", required: false, description: "Override auth token for live probes when runtime config differs from selected --config.", example: "--gateway-auth-token=gw_..." }
        ],
        examples: [
          `${CLI_COMMAND} ai-help`,
          `${CLI_COMMAND} ai-help --config=~/.llm-router.json`,
          `${CLI_COMMAND} ai-help --skip-live-test=true`,
          `${CLI_COMMAND} ai-help --live-test-timeout-ms=8000`
        ],
        useCases: [
          {
            name: "agent setup brief",
            description: "Generate a machine-readable operating guide so AI agents can configure LLM Router, run pre-patch API gates, and patch tool configs safely.",
            command: `${CLI_COMMAND} ai-help`
          }
        ],
        keybindings: []
      },
      run: runAiHelpAction
    },
    {
      actionId: "config",
      description: "Config manager for providers, diagnostics, coding-tool routing, AMP, and startup service.",
      tui: { steps: ["cli-only"] },
      commandline: {
        requiredArgs: [],
        optionalArgs: [
          "operation",
          "op",
          "config",
          "provider-id",
          "name",
          "type",
          "provider-type",
          "subscription-type",
          "subscription-profile",
          "device-code",
          "endpoints",
          "base-url",
          "openai-base-url",
          "claude-base-url",
          "anthropic-base-url",
          "api-key",
          "api-key-env",
          "endpoint-url",
          "enabled",
          "models",
          "model-context-windows",
          "fill-model-context-windows",
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
          "default-model",
          "thinking-level",
          "primary-model",
          "default-opus-model",
          "default-sonnet-model",
          "default-haiku-model",
          "subagent-model",
          "codex-config-file",
          "codex-model-catalog-file",
          "claude-code-settings-file",
          "amp-upstream-url",
          "amp-upstream-api-key",
          "amp-restrict-management-to-localhost",
          "amp-force-model-mappings",
          "amp-preset",
          "amp-default-route",
          "amp-routes",
          "amp-raw-model-routes",
          "amp-overrides",
          "amp-model-mappings",
          "amp-subagent-definitions",
          "amp-subagent-mappings",
          "patch-amp-client-config",
          "amp-client-settings-scope",
          "amp-client-settings-file",
          "amp-client-secrets-file",
          "amp-client-url",
          "amp-client-api-key",
          "clear-amp-upstream-url",
          "clear-amp-upstream-api-key",
          "clear-amp-default-route",
          "clear-amp-routes",
          "clear-amp-raw-model-routes",
          "clear-amp-overrides",
          "clear-amp-model-mappings",
          "clear-amp-subagent-definitions",
          "reset-amp-subagent-definitions",
          "clear-amp-subagent-mappings",
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
        summary: `Manage providers, diagnostics, config validation, coding-tool routing, model aliases, rate-limit buckets, AMP proxy settings, master key, and OS startup. \`${CLI_COMMAND} config\` opens the web console by default; use \`--operation\` for direct CLI actions.`,
        args: [
          { name: "operation", required: false, description: "Config operation (optional; defaults to a config summary when omitted in direct CLI mode).", example: "--operation=upsert-provider" },
          { name: "provider-id", required: false, description: "Provider id (lowercase letters/numbers/dashes).", example: "--provider-id=openrouter-primary" },
          { name: "name", required: false, description: "Provider Friendly Name (must be unique; shown in management screen).", example: "--name=OpenRouter Primary" },
          { name: "type", required: false, description: "Provider type: standard (API key) | subscription (OAuth).", example: "--type=subscription" },
          { name: "subscription-type", required: false, description: "For --type=subscription. Supported: chatgpt-codex | claude-code. Defaults to chatgpt-codex.", example: "--subscription-type=claude-code" },
          { name: "subscription-profile", required: false, description: "OAuth token profile for subscription provider (defaults to provider-id).", example: "--subscription-profile=personal" },
          { name: "device-code", required: false, description: "For subscription OAuth login during upsert: use device-code flow instead of browser (chatgpt-codex only).", example: "--device-code=true" },
          { name: "endpoints", required: false, description: "For standard provider: endpoint candidates for auto-probe (comma-separated URLs).", example: "--endpoints=https://ramclouds.me,https://ramclouds.me/v1" },
          { name: "base-url", required: false, description: "For standard provider: provider base URL.", example: "--base-url=https://openrouter.ai/api/v1" },
          { name: "openai-base-url", required: false, description: "For standard provider: OpenAI endpoint base URL (format-specific override).", example: "--openai-base-url=https://ramclouds.me/v1" },
          { name: "claude-base-url", required: false, description: "For standard provider: Anthropic endpoint base URL (format-specific override).", example: "--claude-base-url=https://ramclouds.me" },
          { name: "api-key", required: false, description: "For standard provider: API key.", example: "--api-key=sk-or-v1-..." },
          { name: "api-key-env", required: false, description: "For provider diagnostics: environment variable that contains the API key.", example: "--api-key-env=OPENAI_API_KEY" },
          { name: "endpoint-url", required: false, description: `For coding-tool routing operations: local ${APP_NAME} gateway origin (defaults to ${LOCAL_ROUTER_ORIGIN}).`, example: `--endpoint-url=${LOCAL_ROUTER_ORIGIN}` },
          { name: "enabled", required: false, description: "For coding-tool routing operations: enable routing when true, restore direct config when false.", example: "--enabled=false" },
          { name: "models", required: false, description: "Model list (comma-separated IDs; strips common log/error noise). Subscription defaults are prefilled by subscription-type and all selected models are live-validated before save.", example: "--models=claude-sonnet-4-6,claude-opus-4-6" },
          { name: "model-context-windows", required: false, description: "Optional model context window map for upsert-provider. Accepts JSON or `model=value` entries.", example: "--model-context-windows='{\"gpt-4o-mini\":128000,\"gpt-4o\":128000}'" },
          { name: "fill-model-context-windows", required: false, description: "For upsert-provider: auto-fill missing model context windows from LiteLLM exact matches before save.", example: "--fill-model-context-windows=true" },
          { name: "model", required: false, description: "Single model id (used by remove-model).", example: "--model=gpt-4o" },
          { name: "fallback-models", required: false, description: "Qualified fallback models for set-model-fallbacks (comma-separated).", example: "--fallback-models=openrouter/gpt-4o,anthropic/claude-3-7-sonnet" },
          { name: "clear-fallbacks", required: false, description: "Clear all fallback models for set-model-fallbacks.", example: "--clear-fallbacks=true" },
          { name: "alias-id", required: false, description: "Model alias id for upsert/remove alias operations.", example: "--alias-id=chat.default" },
          { name: "strategy", required: false, description: "Model alias routing strategy: auto | ordered | round-robin | weighted-rr | quota-aware-weighted-rr.", example: "--strategy=auto" },
          { name: "targets", required: false, description: "Model alias target list syntax: <ref>@<weight> (comma-separated).", example: "--targets=openrouter/gpt-4o-mini@3,anthropic/claude-3-5-haiku@2" },
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
          { name: "default-model", required: false, description: `For set-codex-cli-routing: managed route binding, or ${CODEX_CLI_INHERIT_MODEL_VALUE} to keep Codex's own model selection.`, example: "--default-model=chat.default" },
          { name: "thinking-level", required: false, description: "For set-codex-cli-routing / set-claude-code-routing / set-claude-code-effort-level: reasoning level.", example: "--thinking-level=medium" },
          { name: "primary-model", required: false, description: "For set-claude-code-routing: primary ANTHROPIC_MODEL route.", example: "--primary-model=chat.default" },
          { name: "default-opus-model", required: false, description: "For set-claude-code-routing: ANTHROPIC_DEFAULT_OPUS_MODEL route.", example: "--default-opus-model=chat.deep" },
          { name: "default-sonnet-model", required: false, description: "For set-claude-code-routing: ANTHROPIC_DEFAULT_SONNET_MODEL route.", example: "--default-sonnet-model=chat.default" },
          { name: "default-haiku-model", required: false, description: "For set-claude-code-routing: ANTHROPIC_DEFAULT_HAIKU_MODEL route.", example: "--default-haiku-model=chat.fast" },
          { name: "subagent-model", required: false, description: "For set-claude-code-routing: CLAUDE_CODE_SUBAGENT_MODEL route.", example: "--subagent-model=chat.review" },
          { name: "codex-config-file", required: false, description: "Explicit Codex CLI config.toml path for routing/status operations.", example: "--codex-config-file=./.codex/config.toml" },
          { name: "codex-model-catalog-file", required: false, description: "Explicit Codex model catalog JSON path for routing operations.", example: "--codex-model-catalog-file=./.codex/llm-router-model-catalog.json" },
          { name: "claude-code-settings-file", required: false, description: "Explicit Claude Code settings.json path for routing/status operations.", example: "--claude-code-settings-file=./.claude/settings.local.json" },
          { name: "amp-upstream-url", required: false, description: "AMP upstream base URL for management proxying and unresolved fallback routing.", example: "--amp-upstream-url=https://ampcode.com" },
          { name: "amp-upstream-api-key", required: false, description: "AMP upstream API key used when LLM Router proxies AMP management routes.", example: "--amp-upstream-api-key=amp_..." },
          { name: "amp-restrict-management-to-localhost", required: false, description: "Restrict AMP management proxy routes to localhost clients.", example: "--amp-restrict-management-to-localhost=true" },
          { name: "amp-force-model-mappings", required: false, description: "Apply AMP model mappings before local bare-model lookup.", example: "--amp-force-model-mappings=true" },
          { name: "amp-preset", required: false, description: "New AMP schema preset: builtin (default) or none.", example: "--amp-preset=builtin" },
          { name: "amp-default-route", required: false, description: "New AMP schema fallback route ref used before global defaultModel.", example: "--amp-default-route=chat.default" },
          { name: "amp-routes", required: false, description: "New AMP schema entity/signature routes as JSON object or 'key => route' entries.", example: "--amp-routes=\"smart => chat.smart, @google-gemini-flash-shared => chat.tools\"" },
          { name: "amp-raw-model-routes", required: false, description: "New AMP schema raw model routes as JSON or 'match => route' entries.", example: "--amp-raw-model-routes=\"gpt-*-codex* => chat.deep\"" },
          { name: "amp-overrides", required: false, description: "New AMP schema override catalog JSON object with entities/signatures arrays.", example: "--amp-overrides='{\"entities\":[{\"id\":\"reviewer\",\"type\":\"feature\",\"match\":[\"gemini-4-pro*\"],\"route\":\"chat.review\"}]}'" },
          { name: "amp-model-mappings", required: false, description: "AMP model mappings as JSON or 'from => to' entries separated by newlines/commas.", example: "--amp-model-mappings=\"* => rc/gpt-5.3-codex\"" },
          { name: "amp-subagent-definitions", required: false, description: "AMP subagent definitions as JSON or 'agent => model-pattern|pattern' entries separated by newlines/commas.", example: "--amp-subagent-definitions=\"oracle => gpt-5.4|gpt-5.4*, planner => gpt-6*\"" },
          { name: "amp-subagent-mappings", required: false, description: "AMP subagent mappings as JSON object or 'agent => route' entries separated by newlines/commas.", example: "--amp-subagent-mappings=\"oracle => rc/gpt-5.3-codex, librarian => rc/gpt-5.3-codex\"" },
          { name: "patch-amp-client-config", required: false, description: "Patch AMP local settings/secrets so only amp.url and apiKey@<url> point to this LLM Router gateway.", example: "--patch-amp-client-config=true" },
          { name: "amp-client-settings-scope", required: false, description: "AMP settings scope when patching: global or workspace.", example: "--amp-client-settings-scope=workspace" },
          { name: "amp-client-settings-file", required: false, description: "Explicit AMP settings.json path override for patching.", example: "--amp-client-settings-file=./.amp/settings.json" },
          { name: "amp-client-secrets-file", required: false, description: "Explicit AMP secrets.json path override for patching.", example: "--amp-client-secrets-file=~/.local/share/amp/secrets.json" },
          { name: "amp-client-url", required: false, description: "Local LLM Router URL written to AMP settings as amp.url when patching.", example: `--amp-client-url=${LOCAL_ROUTER_ORIGIN}` },
          { name: "amp-client-api-key", required: false, description: "Local LLM Router gateway key written to AMP secrets as apiKey@<url> when patching.", example: "--amp-client-api-key=gw_..." },
          { name: "clear-amp-upstream-url", required: false, description: "Clear the AMP upstream URL.", example: "--clear-amp-upstream-url=true" },
          { name: "clear-amp-upstream-api-key", required: false, description: "Clear the AMP upstream API key.", example: "--clear-amp-upstream-api-key=true" },
          { name: "clear-amp-default-route", required: false, description: "Clear the new AMP schema defaultRoute.", example: "--clear-amp-default-route=true" },
          { name: "clear-amp-routes", required: false, description: "Clear all new AMP schema entity/signature routes.", example: "--clear-amp-routes=true" },
          { name: "clear-amp-raw-model-routes", required: false, description: "Clear all new AMP schema raw model routes.", example: "--clear-amp-raw-model-routes=true" },
          { name: "clear-amp-overrides", required: false, description: "Clear all new AMP schema override entries.", example: "--clear-amp-overrides=true" },
          { name: "clear-amp-model-mappings", required: false, description: "Clear all AMP model mappings.", example: "--clear-amp-model-mappings=true" },
          { name: "clear-amp-subagent-definitions", required: false, description: "Clear all custom AMP subagent definitions so unmatched AMP models fall back to defaultModel.", example: "--clear-amp-subagent-definitions=true" },
          { name: "reset-amp-subagent-definitions", required: false, description: "Reset AMP subagent definitions back to the built-in LLM Router defaults.", example: "--reset-amp-subagent-definitions=true" },
          { name: "clear-amp-subagent-mappings", required: false, description: "Clear all AMP subagent mappings.", example: "--clear-amp-subagent-mappings=true" },
          { name: "target-version", required: false, description: "For migrate-config: target schema version.", example: "--target-version=2" },
          { name: "create-backup", required: false, description: "For migrate-config: create backup before write.", example: "--create-backup=true" },
          { name: "watch-config", required: false, description: "For startup-install/start: enable in-memory config hot reload.", example: "--watch-config=true" },
          { name: "watch-binary", required: false, description: "For startup-install: detect LLM Router upgrades and auto-relaunch under OS startup.", example: "--watch-binary=true" },
          { name: "require-auth", required: false, description: "Require masterKey auth for local start/startup-install.", example: "--require-auth=true" },
          { name: "config", required: false, description: "Path to config file.", example: "--config=~/.llm-router.json" }
        ],
        examples: [
          `${CLI_COMMAND} config`,
          `${CLI_COMMAND} config --operation=validate`,
          `${CLI_COMMAND} config --operation=snapshot`,
          `${CLI_COMMAND} config --operation=tool-status`,
          `${CLI_COMMAND} config --operation=discover-provider-models --endpoints=https://openrouter.ai/api/v1 --api-key=sk-...`,
          `${CLI_COMMAND} config --operation=test-provider --endpoints=https://openrouter.ai/api/v1 --api-key=sk-... --models=gpt-4o-mini,gpt-4o`,
          `${CLI_COMMAND} config --operation=litellm-context-lookup --models=gpt-4o-mini,gpt-4o`,
          `${CLI_COMMAND} config --operation=upsert-provider --provider-id=ramclouds --name=RamClouds --api-key=sk-... --endpoints=https://ramclouds.me,https://ramclouds.me/v1 --models=claude-opus-4-6-thinking,gpt-5.3-codex`,
          `${CLI_COMMAND} config --operation=upsert-provider --provider-id=openrouter --name=OpenRouter --api-key=sk-... --base-url=https://openrouter.ai/api/v1 --models=gpt-4o-mini,gpt-4o --fill-model-context-windows=true`,
          `${CLI_COMMAND} config --operation=upsert-provider --provider-id=chatgpt --name="GPT Sub" --type=subscription --subscription-type=chatgpt-codex --subscription-profile=default`,
          `${CLI_COMMAND} config --operation=upsert-provider --provider-id=claude-sub --name="Claude Sub" --type=subscription --subscription-type=claude-code --subscription-profile=default`,
          `${CLI_COMMAND} subscription login --subscription-type=chatgpt-codex --profile=default`,
          `${CLI_COMMAND} subscription login --subscription-type=claude-code --profile=default`,
          `${CLI_COMMAND} config --operation=upsert-model-alias --alias-id=chat.default --strategy=auto --targets=openrouter/gpt-4o-mini@3,anthropic/claude-3-5-haiku@2 --fallback-targets=openrouter/gpt-4o`,
          `${CLI_COMMAND} config --operation=set-provider-rate-limits --provider-id=openrouter --bucket-id=openrouter-all-month --bucket-models=all --bucket-requests=20000 --bucket-window=month:1`,
          `${CLI_COMMAND} config --operation=set-provider-rate-limits --provider-id=openrouter --bucket-name="6-hours cap" --bucket-models=all --bucket-requests=600 --bucket-window=hour:6`,
          `${CLI_COMMAND} config --operation=migrate-config --target-version=2 --create-backup=true`,
          `${CLI_COMMAND} config --operation=set-model-fallbacks --provider-id=openrouter --model=gpt-4o --fallback-models=anthropic/claude-3-7-sonnet,openrouter/gpt-4.1-mini`,
          `${CLI_COMMAND} config --operation=remove-model --provider-id=openrouter --model=gpt-4o`,
          `${CLI_COMMAND} config --operation=set-amp-config --patch-amp-client-config=true --amp-client-settings-scope=workspace --amp-client-url=${LOCAL_ROUTER_ORIGIN}`,
          `${CLI_COMMAND} config --operation=set-amp-config --amp-default-route=chat.default --amp-routes="smart => chat.smart, rush => chat.fast, @google-gemini-flash-shared => chat.tools"`,
          `${CLI_COMMAND} config --operation=set-amp-config --amp-preset=builtin --amp-raw-model-routes="gpt-*-codex* => chat.deep" --amp-overrides='{"entities":[{"id":"reviewer","type":"feature","match":["gemini-4-pro*"],"route":"chat.review"}]}'`,
          `${CLI_COMMAND} config --operation=set-amp-config --amp-upstream-url=https://ampcode.com --amp-upstream-api-key=amp_... --amp-force-model-mappings=true --amp-model-mappings="* => rc/gpt-5.3-codex"`,
          `${CLI_COMMAND} config --operation=set-amp-config --amp-subagent-mappings="oracle => rc/gpt-5.3-codex, librarian => rc/gpt-5.3-codex, search => rc/gpt-5.3-codex, look-at => rc/gpt-5.3-codex"`,
          `${CLI_COMMAND} config --operation=set-codex-cli-routing --enabled=true --default-model=chat.default`,
          `${CLI_COMMAND} config --operation=set-claude-code-routing --enabled=true --primary-model=chat.default --default-haiku-model=chat.fast`,
          `${CLI_COMMAND} config --operation=set-claude-code-effort-level --thinking-level=high`,
          `${CLI_COMMAND} config --operation=set-amp-client-routing --enabled=true --amp-client-settings-scope=workspace`,
          `${CLI_COMMAND} config --operation=set-amp-config --patch-amp-client-config=true --amp-client-settings-scope=workspace --amp-client-url=${LOCAL_ROUTER_ORIGIN} --amp-client-api-key=gw_...`,
          `${CLI_COMMAND} config --operation=list-routing`,
          `${CLI_COMMAND} config --operation=startup-install`
        ],
        useCases: [
          {
            name: "web-first config",
            description: "Open the web console or run direct config operations.",
            command: `${CLI_COMMAND} config`
          }
        ],
        keybindings: []
      },
      run: runConfigAction
    },
    {
      actionId: "deploy",
      description: "Guide/deploy current config to Cloudflare Worker.",
      tui: { steps: ["cli-only"] },
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
          `${CLI_COMMAND} deploy`,
          `${CLI_COMMAND} deploy --dry-run=true`,
          `${CLI_COMMAND} deploy --account-id=03819f97b5cb3101faecbbcb6019c4cc`,
          `${CLI_COMMAND} deploy --workers-dev=true`,
          `${CLI_COMMAND} deploy --route-pattern=router.example.com/* --zone-name=example.com`,
          `${CLI_COMMAND} deploy --generate-master-key=true`,
          `${CLI_COMMAND} deploy --export-only=true --out=.llm-router.worker.json`,
          `${CLI_COMMAND} deploy --allow-large-config=true`,
          `${CLI_COMMAND} deploy --env=production`
        ],
        useCases: [
          {
            name: "cloudflare deploy",
            description: "Push LLM_ROUTER_CONFIG_JSON secret and deploy worker.",
            command: `${CLI_COMMAND} deploy`
          }
        ],
        keybindings: []
      },
      run: runDeployAction
    },
    {
      actionId: "worker-key",
      description: "Quickly create/update the LLM_ROUTER_MASTER_KEY Worker secret.",
      tui: { steps: ["cli-only"] },
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
          `${CLI_COMMAND} worker-key --master-key=prod-token-v2`,
          `${CLI_COMMAND} worker-key --generate-master-key=true`,
          `${CLI_COMMAND} worker-key --env=production --master-key=rotated-key`,
          `${CLI_COMMAND} worker-key --use-config-key=true`
        ],
        useCases: [
          {
            name: "rotate leaked key",
            description: "Set LLM_ROUTER_MASTER_KEY quickly without rebuilding the full worker config secret.",
            command: `${CLI_COMMAND} worker-key --master-key=new-secret`
          }
        ],
        keybindings: []
      },
      run: runWorkerKeyAction
    },
    {
      actionId: "subscription",
      description: "Manage subscription provider authentication (login, logout, status).",
      tui: { steps: ["cli-only"] },
      commandline: {
        requiredArgs: [],
        optionalArgs: ["profile", "device-code", "subscription-type"]
      },
      help: {
        summary: "Manage OAuth authentication for subscription providers (ChatGPT Codex and Claude Code).",
        args: [
          { name: "profile", required: false, description: "Subscription profile ID (defaults to 'default').", example: "--profile=personal" },
          { name: "subscription-type", required: false, description: "Subscription provider type: chatgpt-codex | claude-code (defaults to chatgpt-codex).", example: "--subscription-type=claude-code" },
          { name: "device-code", required: false, description: "Use device code flow instead of browser (headless environments; chatgpt-codex only).", example: "--device-code=true" }
        ],
        examples: [
          `${CLI_COMMAND} subscription login`,
          `${CLI_COMMAND} subscription login --subscription-type=chatgpt-codex --profile=personal`,
          `${CLI_COMMAND} subscription login --subscription-type=claude-code --profile=work`,
          `${CLI_COMMAND} subscription login --subscription-type=chatgpt-codex --device-code=true`,
          `${CLI_COMMAND} subscription logout --profile=personal`,
          `${CLI_COMMAND} subscription status`,
          `${CLI_COMMAND} subscription status --subscription-type=claude-code --profile=personal`
        ],
        useCases: [
          {
            name: "browser login",
            description: "Login to subscription provider via browser OAuth.",
            command: `${CLI_COMMAND} subscription login --subscription-type=claude-code --profile=personal`
          },
          {
            name: "device code login",
            description: "Login on headless server using device code flow (chatgpt-codex only).",
            command: `${CLI_COMMAND} subscription login --subscription-type=chatgpt-codex --device-code=true --profile=server`
          },
          {
            name: "check status",
            description: "Check authentication status for all profiles.",
            command: `${CLI_COMMAND} subscription status`
          }
        ],
        keybindings: []
      },
      subcommands: [
        {
          actionId: "login",
          description: "Login to a subscription provider.",
          run: runSubscriptionLoginAction
        },
        {
          actionId: "logout",
          description: "Logout from a subscription provider.",
          run: runSubscriptionLogoutAction
        },
        {
          actionId: "status",
          description: "Check subscription authentication status.",
          run: runSubscriptionStatusAction
        }
      ],
      run: runSubscriptionStatusAction
    }
  ]
};

export default routerModule;
