import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs, readFileSync, watch as fsWatch } from "node:fs";
import { getDefaultConfigPath, writeConfigFile } from "./config-store.js";
import { clearRuntimeState, getActiveRuntimeState, startDetachedRouterService, stopProcessByPid, waitForRuntimeMatch } from "./instance-state.js";
import {
  FIXED_LOCAL_ROUTER_HOST,
  FIXED_LOCAL_ROUTER_PORT,
  applyLocalServerSettings,
  areLocalServerSettingsEqual,
  formatStartupDetail,
  formatStartupLabel,
  getFixedLocalRouterOrigin,
  readLocalServerSettings
} from "./local-server-settings.js";
import { appendActivityLogEntry, clearActivityLogFile, createActivityLogEntry, readActivityLogEntries, resolveActivityLogPath } from "./activity-log.js";
import { listListeningPids, reclaimPort } from "./port-reclaim.js";
import { probeProvider, probeProviderEndpointMatrix, probeFreeTierModels } from "./provider-probe.js";
import { installStartup, startupStatus, stopStartup, uninstallStartup } from "./startup-manager.js";
import { WEB_CONSOLE_CSS, renderWebConsoleHtml } from "./web-console-assets.js";
import {
  buildAmpClientPatchPlan,
  maybeBootstrapAmpConfig,
  patchAmpClientConfigFiles,
  readAmpClientRoutingState,
  resolveAmpClientSecretsFilePath,
  resolveAmpClientSettingsFilePath,
  unpatchAmpClientConfigFiles
} from "./amp-client-config.js";
import {
  ensureClaudeCodeSettingsFileExists,
  ensureCodexCliConfigFileExists,
  ensureFactoryDroidSettingsFileExists,
  patchClaudeCodeEffortLevel,
  patchClaudeCodeSettingsFile,
  patchCodexCliConfigFile,
  patchFactoryDroidSettingsFile,
  readClaudeCodeRoutingState,
  readCodexCliRoutingState,
  readFactoryDroidRoutingState,
  resolveClaudeCodeSettingsFilePath,
  resolveCodexCliConfigFilePath,
  resolveFactoryDroidSettingsFilePath,
  unpatchClaudeCodeSettingsFile,
  unpatchCodexCliConfigFile,
  unpatchFactoryDroidSettingsFile
} from "./coding-tool-config.js";
import { loginSubscription } from "../runtime/subscription-provider.js";
import {
  ollamaCheckConnection,
  ollamaListModels,
  ollamaListRunning,
  ollamaShowModel,
  ollamaLoadModel,
  ollamaUnloadModel,
  ollamaPinModel,
  ollamaSetKeepAlive,
  ollamaPullModel,
  ollamaDeleteModel
} from "./ollama-client.js";
import { estimateMaxContext, estimateModelVram, formatBytes } from "./ollama-hardware.js";
import { detectOllamaInstallation, installOllama, startOllamaServer, stopOllamaServer, isOllamaRunning } from "./ollama-install.js";
import {
  CONFIG_VERSION,
  DEFAULT_MODEL_ALIAS_ID,
  DEFAULT_PROVIDER_USER_AGENT,
  OLLAMA_KEEP_ALIVE_PATTERN,
  OLLAMA_PROVIDER_TYPE,
  configHasProvider,
  normalizeOllamaConfig,
  normalizeRuntimeConfig,
  resolveProviderApiKey,
  validateRuntimeConfig
} from "../runtime/config.js";
import {
  buildAmpWebSearchSnapshot,
  testHostedWebSearchProviderRoute
} from "../runtime/handler/amp-web-search.js";
import { resolveRuntimeFlags, resolveStateStoreOptions } from "../runtime/handler/runtime-policy.js";
import { createStateStore } from "../runtime/state-store.js";
import {
  CODEX_CLI_INHERIT_MODEL_VALUE,
  isCodexCliInheritModelBinding,
  normalizeClaudeCodeEffortLevel,
  normalizeCodexCliReasoningEffort,
  normalizeFactoryDroidReasoningEffort
} from "../shared/coding-tool-bindings.js";
import { applyActivityLogSettings, readActivityLogSettings } from "../shared/local-router-defaults.js";
import {
  createLiteLlmContextLookupHelper,
  LITELLM_CONTEXT_CATALOG_URL
} from "./litellm-context-catalog.js";

const JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_LOG_ENTRIES = 150;
const WEB_CONSOLE_APP_JS = readFileSync(fileURLToPath(new URL("./web-console-client.js", import.meta.url)), "utf8");

function createLogStateSignature(entries = []) {
  return JSON.stringify((entries || []).map((entry) => `${entry?.id || ""}:${entry?.time || ""}`));
}

async function loadWebConsoleDevAssets() {
  const module = await import("./web-console-dev-assets.js");
  return module.startWebConsoleDevAssets;
}

function buildDefaultConfigObject() {
  return normalizeRuntimeConfig({}, { migrateToVersion: CONFIG_VERSION });
}

function buildDefaultConfigRawText() {
  return `${JSON.stringify(buildDefaultConfigObject(), null, 2)}\n`;
}

function countRateLimitBuckets(config) {
  return (config?.providers || []).reduce((sum, provider) => sum + ((provider?.rateLimits || []).length || 0), 0);
}

function dedupeTrimmedStrings(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeManagedRouteLookup(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.startsWith("alias:") ? text.slice("alias:".length).trim() : text;
}

function collectManagedRouteRefs(config = {}) {
  const refs = new Set();

  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};
  for (const aliasId of Object.keys(aliases)) {
    const normalizedAliasId = String(aliasId || "").trim();
    if (normalizedAliasId) refs.add(normalizedAliasId);
  }

  for (const provider of Array.isArray(config?.providers) ? config.providers : []) {
    const providerId = String(provider?.id || "").trim();
    if (!providerId) continue;
    for (const model of Array.isArray(provider?.models) ? provider.models : []) {
      const modelId = String(model?.id || "").trim();
      if (!modelId) continue;
      refs.add(`${providerId}/${modelId}`);
    }
  }

  return refs;
}

function hasManagedRouteRef(routeRefs, ref) {
  const lookup = normalizeManagedRouteLookup(ref);
  return Boolean(lookup && routeRefs instanceof Set && routeRefs.has(lookup));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, sortJsonValue(value[key])])
  );
}

function createJsonSignature(value) {
  return JSON.stringify(sortJsonValue(value));
}

function inferRenamePairs(previousItems = [], nextItems = [], {
  getId = (item) => item?.id,
  getSignature = () => "",
  allowPositionalFallback = false
} = {}) {
  const previousEntries = previousItems
    .map((item, index) => ({
      item,
      index,
      id: String(getId(item) || "").trim()
    }))
    .filter((entry) => entry.id);
  const nextEntries = nextItems
    .map((item, index) => ({
      item,
      index,
      id: String(getId(item) || "").trim()
    }))
    .filter((entry) => entry.id);
  const nextIds = new Set(nextEntries.map((entry) => entry.id));
  const matchedIds = new Set(previousEntries.filter((entry) => nextIds.has(entry.id)).map((entry) => entry.id));
  const previousRemaining = previousEntries.filter((entry) => !matchedIds.has(entry.id));
  const nextRemaining = nextEntries.filter((entry) => !matchedIds.has(entry.id));
  const mapping = new Map();
  const previousBySignature = new Map();
  const nextBySignature = new Map();

  for (const entry of previousRemaining) {
    const signature = String(getSignature(entry.item) || "");
    const bucket = previousBySignature.get(signature) || [];
    bucket.push(entry);
    previousBySignature.set(signature, bucket);
  }
  for (const entry of nextRemaining) {
    const signature = String(getSignature(entry.item) || "");
    const bucket = nextBySignature.get(signature) || [];
    bucket.push(entry);
    nextBySignature.set(signature, bucket);
  }

  for (const [signature, previousBucket] of previousBySignature.entries()) {
    const nextBucket = nextBySignature.get(signature) || [];
    if (previousBucket.length !== 1 || nextBucket.length !== 1) continue;
    const previousEntry = previousBucket[0];
    const nextEntry = nextBucket[0];
    if (previousEntry.id !== nextEntry.id) {
      mapping.set(previousEntry.id, nextEntry.id);
    }
  }

  const remainingPrevious = previousRemaining.filter((entry) => !mapping.has(entry.id));
  const mappedNextIds = new Set(mapping.values());
  const remainingNext = nextRemaining.filter((entry) => !mappedNextIds.has(entry.id));

  if (remainingPrevious.length === 1 && remainingNext.length === 1) {
    if (remainingPrevious[0].id !== remainingNext[0].id) {
      mapping.set(remainingPrevious[0].id, remainingNext[0].id);
    }
    return mapping;
  }

  if (allowPositionalFallback && remainingPrevious.length > 0 && remainingPrevious.length === remainingNext.length) {
    for (let index = 0; index < remainingPrevious.length; index += 1) {
      const previousEntry = remainingPrevious[index];
      const nextEntry = remainingNext[index];
      if (previousEntry.id !== nextEntry.id) {
        mapping.set(previousEntry.id, nextEntry.id);
      }
    }
  }

  return mapping;
}

function createModelComparable(model = {}) {
  const comparable = {};
  for (const [key, value] of Object.entries(model && typeof model === "object" && !Array.isArray(model) ? model : {})) {
    if (key === "id" || key === "fallbackModels") continue;
    comparable[key] = sortJsonValue(value);
  }
  return comparable;
}

function createProviderComparable(provider = {}) {
  const comparable = {};
  for (const [key, value] of Object.entries(provider && typeof provider === "object" && !Array.isArray(provider) ? provider : {})) {
    if (key === "id" || key === "name") continue;
    if (key === "models") {
      comparable.models = (Array.isArray(value) ? value : []).map((model) => createModelComparable(model));
      continue;
    }
    comparable[key] = sortJsonValue(value);
  }
  return comparable;
}

function createAliasComparable(alias = {}, rewriteRef) {
  const normalizeTargets = (targets = []) => (Array.isArray(targets) ? targets : [])
    .map((target) => {
      const currentRef = String(target?.ref || "").trim();
      if (!currentRef) return null;
      const nextRef = String(typeof rewriteRef === "function" ? rewriteRef(currentRef) : currentRef).trim();
      if (!nextRef) return null;
      const nextTarget = { ref: nextRef };
      if (target?.weight !== undefined) nextTarget.weight = target.weight;
      return nextTarget;
    })
    .filter(Boolean);

  return {
    strategy: String(alias?.strategy || "ordered").trim() || "ordered",
    targets: normalizeTargets(alias?.targets),
    fallbackTargets: normalizeTargets(alias?.fallbackTargets)
  };
}

function inferProviderRenameMap(previousConfig = {}, nextConfig = {}) {
  return inferRenamePairs(
    Array.isArray(previousConfig?.providers) ? previousConfig.providers : [],
    Array.isArray(nextConfig?.providers) ? nextConfig.providers : [],
    {
      getId: (provider) => provider?.id,
      getSignature: (provider) => createJsonSignature(createProviderComparable(provider))
    }
  );
}

function inferModelRenameMaps(previousConfig = {}, nextConfig = {}, providerRenameMap = new Map()) {
  const previousProviders = Array.isArray(previousConfig?.providers) ? previousConfig.providers : [];
  const nextProviders = Array.isArray(nextConfig?.providers) ? nextConfig.providers : [];
  const nextProvidersById = new Map(
    nextProviders
      .map((provider) => [String(provider?.id || "").trim(), provider])
      .filter(([providerId]) => providerId)
  );
  const modelRenameMaps = new Map();

  for (const previousProvider of previousProviders) {
    const previousProviderId = String(previousProvider?.id || "").trim();
    if (!previousProviderId) continue;
    const nextProviderId = String(providerRenameMap.get(previousProviderId) || previousProviderId).trim();
    const nextProvider = nextProvidersById.get(nextProviderId);
    if (!nextProvider) continue;

    const renameMap = inferRenamePairs(
      Array.isArray(previousProvider?.models) ? previousProvider.models : [],
      Array.isArray(nextProvider?.models) ? nextProvider.models : [],
      {
        getId: (model) => model?.id,
        getSignature: (model) => createJsonSignature(createModelComparable(model)),
        allowPositionalFallback: true
      }
    );

    if (renameMap.size > 0) {
      modelRenameMaps.set(previousProviderId, renameMap);
    }
  }

  return modelRenameMaps;
}

function rewriteManagedRouteRef(ref, {
  previousValidRouteRefs,
  nextValidRouteRefs,
  providerRenameMap = new Map(),
  modelRenameMaps = new Map(),
  aliasRenameMap = new Map(),
  preserveUnknown = true
} = {}) {
  const text = String(ref || "").trim();
  if (!text) return "";
  if (hasManagedRouteRef(nextValidRouteRefs, text)) return text;

  const knownInPreviousConfig = hasManagedRouteRef(previousValidRouteRefs, text);
  if (!knownInPreviousConfig) return preserveUnknown ? text : "";

  const lookup = normalizeManagedRouteLookup(text);
  const aliasPrefixed = text.startsWith("alias:");

  if (aliasPrefixed || !lookup.includes("/")) {
    const nextAliasId = String(aliasRenameMap.get(lookup) || lookup).trim();
    if (!nextAliasId) return "";
    return hasManagedRouteRef(nextValidRouteRefs, nextAliasId)
      ? (aliasPrefixed ? `alias:${nextAliasId}` : nextAliasId)
      : "";
  }

  const slashIndex = lookup.indexOf("/");
  const previousProviderId = lookup.slice(0, slashIndex);
  const previousModelId = lookup.slice(slashIndex + 1);
  const nextProviderId = String(providerRenameMap.get(previousProviderId) || previousProviderId).trim();
  const nextModelId = String((modelRenameMaps.get(previousProviderId) || new Map()).get(previousModelId) || previousModelId).trim();
  const nextRef = nextProviderId && nextModelId ? `${nextProviderId}/${nextModelId}` : "";
  return nextRef && hasManagedRouteRef(nextValidRouteRefs, nextRef) ? nextRef : "";
}

function inferAliasRenameMap(previousConfig = {}, nextConfig = {}, routeRewriteContext = {}) {
  const previousAliases = Object.entries(
    previousConfig?.modelAliases && typeof previousConfig.modelAliases === "object" && !Array.isArray(previousConfig.modelAliases)
      ? previousConfig.modelAliases
      : {}
  )
    .filter(([aliasId]) => {
      const normalizedAliasId = String(aliasId || "").trim();
      return normalizedAliasId && normalizedAliasId !== DEFAULT_MODEL_ALIAS_ID;
    })
    .map(([aliasId, alias]) => ({
      id: String(aliasId || "").trim(),
      alias
    }));
  const nextAliases = Object.entries(
    nextConfig?.modelAliases && typeof nextConfig.modelAliases === "object" && !Array.isArray(nextConfig.modelAliases)
      ? nextConfig.modelAliases
      : {}
  )
    .filter(([aliasId]) => {
      const normalizedAliasId = String(aliasId || "").trim();
      return normalizedAliasId && normalizedAliasId !== DEFAULT_MODEL_ALIAS_ID;
    })
    .map(([aliasId, alias]) => ({
      id: String(aliasId || "").trim(),
      alias
    }));
  const aliasRenameMap = new Map();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nextPairs = inferRenamePairs(previousAliases, nextAliases, {
      getId: (entry) => entry.id,
      getSignature: (entry) => createJsonSignature(createAliasComparable(entry.alias, (routeRef) => rewriteManagedRouteRef(routeRef, {
        ...routeRewriteContext,
        aliasRenameMap
      }))),
      allowPositionalFallback: true
    });
    let changed = false;
    for (const [previousAliasId, nextAliasId] of nextPairs.entries()) {
      if (aliasRenameMap.get(previousAliasId) === nextAliasId) continue;
      aliasRenameMap.set(previousAliasId, nextAliasId);
      changed = true;
    }
    if (!changed) break;
  }

  return aliasRenameMap;
}

function buildManagedRouteRewriteContext(previousConfig = {}, nextConfig = {}) {
  const previousValidRouteRefs = collectManagedRouteRefs(previousConfig);
  const nextValidRouteRefs = collectManagedRouteRefs(nextConfig);
  const providerRenameMap = inferProviderRenameMap(previousConfig, nextConfig);
  const modelRenameMaps = inferModelRenameMaps(previousConfig, nextConfig, providerRenameMap);
  const routeRewriteContext = {
    previousValidRouteRefs,
    nextValidRouteRefs,
    providerRenameMap,
    modelRenameMaps
  };
  return {
    ...routeRewriteContext,
    aliasRenameMap: inferAliasRenameMap(previousConfig, nextConfig, routeRewriteContext)
  };
}

function formatHostForUrl(host, port) {
  const value = String(host || "127.0.0.1").trim();
  if (!value.includes(":")) return `${value}:${port}`;
  if (value.startsWith("[") && value.endsWith("]")) return `${value}:${port}`;
  return `[${value}]:${port}`;
}

function buildAmpClientEndpointUrl(settings = {}) {
  return getFixedLocalRouterOrigin();
}

function buildCodexCliEndpointUrl(settings = {}) {
  const origin = buildAmpClientEndpointUrl(settings);
  return origin ? `${origin}/openai/v1` : "";
}

function buildClaudeCodeEndpointUrl(settings = {}) {
  const origin = buildAmpClientEndpointUrl(settings);
  return origin ? `${origin}/anthropic` : "";
}

function buildFactoryDroidEndpointUrl(settings = {}) {
  const origin = buildAmpClientEndpointUrl(settings);
  return origin ? `${origin}/openai/v1` : "";
}

function buildRouterEndpoints({ host, port, running }) {
  if (!running) return [];
  const origin = getFixedLocalRouterOrigin();
  return [
    { label: "Unified", url: `${origin}/route` },
    { label: "Anthropic", url: `${origin}/anthropic` },
    { label: "OpenAI", url: `${origin}/openai` },
    { label: "OpenAI Responses", url: `${origin}/openai/v1/responses` },
    { label: "AMP OpenAI", url: `${origin}/api/provider/openai/v1/chat/completions` },
    { label: "AMP Anthropic", url: `${origin}/api/provider/anthropic/v1/messages` }
  ];
}

function normalizeRuntimeHost(value) {
  return String(value || "127.0.0.1").trim() || "127.0.0.1";
}

function isWildcardRuntimeHost(value) {
  const host = normalizeRuntimeHost(value).toLowerCase();
  return host === "0.0.0.0" || host === "::" || host === "::0" || host === "[::]";
}

function isLoopbackRuntimeHost(value) {
  const host = normalizeRuntimeHost(value).toLowerCase();
  return host === "127.0.0.1"
    || host === "localhost"
    || host === "::1"
    || host === "::ffff:127.0.0.1";
}

function runtimeHostMatchesTarget(runtimeHost, targetHost) {
  const runtimeValue = normalizeRuntimeHost(runtimeHost).toLowerCase();
  const targetValue = normalizeRuntimeHost(targetHost).toLowerCase();
  if (runtimeValue === targetValue) return true;
  if (isWildcardRuntimeHost(runtimeValue) || isWildcardRuntimeHost(targetValue)) return true;
  return isLoopbackRuntimeHost(runtimeValue) && isLoopbackRuntimeHost(targetValue);
}

function runtimeMatchesEndpoint(runtime, settings = {}) {
  if (!runtime || typeof runtime !== "object") return false;
  return runtimeHostMatchesTarget(runtime.host, settings.host)
    && Number(runtime.port) === Number(settings.port);
}

function endpointsConflict({ host: leftHost, port: leftPort }, { host: rightHost, port: rightPort }) {
  return Number(leftPort) === Number(rightPort)
    && runtimeHostMatchesTarget(leftHost, rightHost);
}

function runtimeMatchesSettings(runtime, settings = {}, configPath = "") {
  if (!runtime || typeof runtime !== "object") return false;
  return runtimeMatchesEndpoint(runtime, settings)
    && Boolean(runtime.watchConfig !== false) === Boolean(settings.watchConfig !== false)
    && Boolean(runtime.watchBinary !== false) === Boolean(settings.watchBinary !== false)
    && Boolean(runtime.requireAuth === true) === Boolean(settings.requireAuth === true)
    && String(runtime.configPath || "").trim() === String(configPath || "").trim();
}

function buildRouterSnapshot(runtime, settings = {}, lastError = "") {
  const source = runtime || settings || {};
  const host = normalizeRuntimeHost(source.host);
  const port = Number.isInteger(Number(source.port)) ? Number(source.port) : FIXED_LOCAL_ROUTER_PORT;
  const running = Boolean(runtime);
  return {
    running,
    host,
    port,
    watchConfig: runtime ? runtime.watchConfig !== false : settings.watchConfig !== false,
    watchBinary: runtime ? runtime.watchBinary !== false : settings.watchBinary !== false,
    requireAuth: runtime ? runtime.requireAuth === true : settings.requireAuth === true,
    startedAt: running ? String(runtime.startedAt || "") : "",
    url: running ? `http://${formatHostForUrl(host, port)}` : "",
    endpoints: buildRouterEndpoints({ host, port, running }),
    lastError
  };
}

function isLoopbackAddress(address) {
  const value = String(address || "").trim();
  return value === "::1"
    || value === "::ffff:127.0.0.1"
    || value.startsWith("127.")
    || value.startsWith("::ffff:127.");
}

function commandExists(command, platform = process.platform) {
  const binary = platform === "win32" ? "where" : "which";
  const result = spawnSync(binary, [command], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"]
  });
  return result.status === 0;
}

export function detectAvailableEditors({ platform = process.platform, exists = commandExists } = {}) {
  const editors = [
    {
      id: "default",
      label: platform === "darwin" ? "Default App" : platform === "win32" ? "Default Editor" : "Default App",
      description: "Open with the OS default app"
    }
  ];

  if (exists("code", platform)) {
    editors.push({ id: "vscode", label: "VS Code", description: "Open in Visual Studio Code" });
  }
  if (exists("cursor", platform)) {
    editors.push({ id: "cursor", label: "Cursor", description: "Open in Cursor" });
  }
  if (exists("subl", platform)) {
    editors.push({ id: "sublime", label: "Sublime", description: "Open in Sublime Text" });
  }
  if (exists("zed", platform)) {
    editors.push({ id: "zed", label: "Zed", description: "Open in Zed" });
  }

  if (platform === "darwin") {
    editors.push({ id: "textedit", label: "TextEdit", description: "Open in TextEdit" });
  } else if (platform === "win32") {
    editors.push({ id: "notepad", label: "Notepad", description: "Open in Notepad" });
  } else {
    if (exists("gedit", platform)) {
      editors.push({ id: "gedit", label: "Gedit", description: "Open in Gedit" });
    }
    if (exists("kate", platform)) {
      editors.push({ id: "kate", label: "Kate", description: "Open in Kate" });
    }
  }

  return editors;
}

function spawnDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

async function ensureConfigFileExists(configPath) {
  try {
    await fs.access(configPath);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
    await writeConfigFile(buildDefaultConfigObject(), configPath, { migrateToVersion: CONFIG_VERSION });
  }
}

async function ensureJsonObjectFileExists(filePath, initialValue = {}) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(initialValue, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(filePath, 0o600);
  }
}

async function ensureTextFileExists(filePath, initialValue = "") {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, String(initialValue || ""), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(filePath, 0o600);
  }
}

export async function openFileInEditor(editorId, filePath, platform = process.platform) {
  const targetPath = path.resolve(filePath);

  if (platform === "darwin") {
    if (editorId === "vscode") return spawnDetached("code", [targetPath]);
    if (editorId === "cursor") return spawnDetached("cursor", [targetPath]);
    if (editorId === "sublime") return spawnDetached("subl", [targetPath]);
    if (editorId === "zed") return spawnDetached("zed", [targetPath]);
    if (editorId === "textedit") return spawnDetached("open", ["-a", "TextEdit", targetPath]);
    return spawnDetached("open", [targetPath]);
  }

  if (platform === "win32") {
    if (editorId === "vscode") return spawnDetached("code", [targetPath]);
    if (editorId === "cursor") return spawnDetached("cursor", [targetPath]);
    if (editorId === "sublime") return spawnDetached("subl", [targetPath]);
    if (editorId === "zed") return spawnDetached("zed", [targetPath]);
    if (editorId === "notepad") return spawnDetached("notepad", [targetPath]);
    return spawnDetached("cmd", ["/c", "start", "", targetPath]);
  }

  if (editorId === "vscode") return spawnDetached("code", [targetPath]);
  if (editorId === "cursor") return spawnDetached("cursor", [targetPath]);
  if (editorId === "sublime") return spawnDetached("subl", [targetPath]);
  if (editorId === "zed") return spawnDetached("zed", [targetPath]);
  if (editorId === "gedit") return spawnDetached("gedit", [targetPath]);
  if (editorId === "kate") return spawnDetached("kate", [targetPath]);
  return spawnDetached("xdg-open", [targetPath]);
}

export async function openConfigInEditor(editorId, configPath, platform = process.platform) {
  await ensureConfigFileExists(configPath);
  return openFileInEditor(editorId, configPath, platform);
}

function createValidationMessages(parseError, validationErrors = []) {
  if (parseError) {
    return [{ kind: "error", message: `JSON parse error: ${parseError}` }];
  }
  return validationErrors.map((message) => ({ kind: "error", message }));
}

function createConfigSummary({ configPath, exists, rawText, parseError, normalizedConfig }) {
  const providerCount = Array.isArray(normalizedConfig?.providers) ? normalizedConfig.providers.length : 0;
  const aliasCount = normalizedConfig?.modelAliases && typeof normalizedConfig.modelAliases === "object"
    ? Object.keys(normalizedConfig.modelAliases).length
    : 0;
  const rateLimitBucketCount = normalizedConfig ? countRateLimitBuckets(normalizedConfig) : 0;
  const validationErrors = normalizedConfig ? validateRuntimeConfig(normalizedConfig) : [];
  const validationMessages = createValidationMessages(parseError, validationErrors);

  return {
    path: configPath,
    exists,
    rawText,
    parseError,
    providerCount,
    aliasCount,
    rateLimitBucketCount,
    hasMasterKey: Boolean(normalizedConfig?.masterKey),
    validationErrors,
    validationMessages,
    validationSummary: parseError
      ? "Config file contains invalid JSON."
      : validationErrors.length > 0
        ? `${validationErrors.length} validation issue(s) need review.`
        : "Config is ready."
  };
}

async function readConfigState(configPath) {
  let exists = true;
  let rawText = "";
  try {
    rawText = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      exists = false;
      rawText = buildDefaultConfigRawText();
    } else {
      throw error;
    }
  }

  if (!rawText.trim()) rawText = buildDefaultConfigRawText();

  let parseError = "";
  let rawConfig = null;
  let normalizedConfig = null;
  try {
    rawConfig = rawText.trim() ? JSON.parse(rawText) : {};
    normalizedConfig = normalizeRuntimeConfig(rawConfig, { migrateToVersion: CONFIG_VERSION });
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  const summary = createConfigSummary({
    configPath,
    exists,
    rawText,
    parseError,
    normalizedConfig
  });

  return {
    rawText,
    rawConfig,
    normalizedConfig,
    parseError,
    summary
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_BODY_LIMIT_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : String(error));
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendText(res, statusCode, contentType, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function startJsonLineStream(res) {
  res.statusCode = 200;
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-accel-buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

function writeJsonLine(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function resolveRouterOptions(current, body) {
  return {
    host: FIXED_LOCAL_ROUTER_HOST,
    port: FIXED_LOCAL_ROUTER_PORT,
    watchConfig: body?.watchConfig === undefined ? current.watchConfig : body.watchConfig === true,
    requireAuth: body?.requireAuth === undefined ? current.requireAuth : body.requireAuth === true,
    watchBinary: body?.watchBinary === undefined ? current.watchBinary : body.watchBinary === true
  };
}

function getRouterStateSettings(routerState) {
  return {
    host: FIXED_LOCAL_ROUTER_HOST,
    port: FIXED_LOCAL_ROUTER_PORT,
    watchConfig: routerState?.watchConfig !== false,
    watchBinary: routerState?.watchBinary !== false,
    requireAuth: routerState?.requireAuth === true
  };
}

function isMissingStartupServiceText(value) {
  const text = String(value || "").toLowerCase();
  return text.includes("could not find service")
    || text.includes("service could not be found")
    || text.includes("does not exist as a service")
    || text.includes("could not be found");
}

function routeSnapshotDocument(configState) {
  return configState.parseError ? null : (configState.normalizedConfig || buildDefaultConfigObject());
}

export async function startWebConsoleServer(options = {}, deps = {}) {
  const {
    host = "127.0.0.1",
    port = 8788,
    configPath = getDefaultConfigPath(),
    activityLogPath = "",
    routerHost = FIXED_LOCAL_ROUTER_HOST,
    routerPort = FIXED_LOCAL_ROUTER_PORT,
    routerWatchConfig = true,
    routerRequireAuth = false,
    routerWatchBinary = true,
    allowRemoteClients = false,
    cliPathForRouter = "",
    devMode = false
  } = options;

  const installStartupFn = typeof deps.installStartup === "function" ? deps.installStartup : installStartup;
  const uninstallStartupFn = typeof deps.uninstallStartup === "function" ? deps.uninstallStartup : uninstallStartup;
  const startupStatusFn = typeof deps.startupStatus === "function" ? deps.startupStatus : startupStatus;
  const stopStartupFn = typeof deps.stopStartup === "function" ? deps.stopStartup : stopStartup;
  const stopProcessByPidFn = typeof deps.stopProcessByPid === "function" ? deps.stopProcessByPid : stopProcessByPid;
  const openConfigInEditorFn = typeof deps.openConfigInEditor === "function" ? deps.openConfigInEditor : openConfigInEditor;
  const openFileInEditorFn = typeof deps.openFileInEditor === "function" ? deps.openFileInEditor : openFileInEditor;
  const detectAvailableEditorsFn = typeof deps.detectAvailableEditors === "function" ? deps.detectAvailableEditors : detectAvailableEditors;
  const getActiveRuntimeStateFn = typeof deps.getActiveRuntimeState === "function" ? deps.getActiveRuntimeState : getActiveRuntimeState;
  const clearRuntimeStateFn = typeof deps.clearRuntimeState === "function" ? deps.clearRuntimeState : clearRuntimeState;
  const startDetachedRouterServiceFn = typeof deps.startDetachedRouterService === "function" ? deps.startDetachedRouterService : startDetachedRouterService;
  const listListeningPidsFn = typeof deps.listListeningPids === "function"
    ? deps.listListeningPids
    : (targetPort) => listListeningPids(targetPort, deps);
  const reclaimPortFn = typeof deps.reclaimPort === "function"
    ? deps.reclaimPort
    : (args) => reclaimPort(args, deps);
  const waitForRuntimeMatchFn = typeof deps.waitForRuntimeMatch === "function"
    ? deps.waitForRuntimeMatch
    : (startOptions, waitOptions = {}) => waitForRuntimeMatch(startOptions, waitOptions);
  const loginSubscriptionFn = typeof deps.loginSubscription === "function" ? deps.loginSubscription : loginSubscription;
  const ampClientEnv = deps.ampClientEnv && typeof deps.ampClientEnv === "object" ? deps.ampClientEnv : process.env;
  const ampClientCwd = typeof deps.ampClientCwd === "string" && deps.ampClientCwd.trim() ? deps.ampClientCwd : process.cwd();
  const codexCliEnv = deps.codexCliEnv && typeof deps.codexCliEnv === "object" ? deps.codexCliEnv : process.env;
  const claudeCodeEnv = deps.claudeCodeEnv && typeof deps.claudeCodeEnv === "object" ? deps.claudeCodeEnv : process.env;
  const runtimeEnv = deps.runtimeEnv && typeof deps.runtimeEnv === "object" ? deps.runtimeEnv : process.env;
  const loadWebConsoleDevAssetsFn = typeof deps.loadWebConsoleDevAssets === "function"
    ? deps.loadWebConsoleDevAssets
    : loadWebConsoleDevAssets;
  const resolvedRouterCliPath = String(cliPathForRouter || process.env.LLM_ROUTER_CLI_PATH || process.argv[1] || "").trim();
  const resolvedActivityLogPath = resolveActivityLogPath(configPath, activityLogPath);

  async function readWebSearchState(config = null) {
    if (!config || typeof config !== "object") return null;
    const runtimeFlags = resolveRuntimeFlags({ runtime: "node" }, runtimeEnv);
    const stateStore = await createStateStore(resolveStateStoreOptions({
      runtime: "node",
      defaultStateStoreBackend: "file"
    }, runtimeEnv, runtimeFlags));

    try {
      return await buildAmpWebSearchSnapshot(config, {
        env: runtimeEnv,
        stateStore
      });
    } finally {
      if (typeof stateStore?.close === "function") {
        await stateStore.close();
      }
    }
  }

  async function resolvePreferredAmpSettingsTarget() {
    const envOverride = String(ampClientEnv?.AMP_SETTINGS_FILE || "").trim();
    if (envOverride) {
      return {
        scope: "global",
        settingsFilePath: path.resolve(envOverride)
      };
    }

    const workspaceSettingsPath = resolveAmpClientSettingsFilePath({
      scope: "workspace",
      cwd: ampClientCwd,
      env: ampClientEnv
    });
    try {
      await fs.access(workspaceSettingsPath);
      return {
        scope: "workspace",
        settingsFilePath: workspaceSettingsPath
      };
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) {
        throw error;
      }
    }

    return {
      scope: "global",
      settingsFilePath: resolveAmpClientSettingsFilePath({
        scope: "global",
        cwd: ampClientCwd,
        env: ampClientEnv
      })
    };
  }

  async function readAmpGlobalRoutingState(settings = {}) {
    const endpointUrl = buildAmpClientEndpointUrl(settings);
    try {
      const settingsTarget = await resolvePreferredAmpSettingsTarget();
      const secretsFilePath = resolveAmpClientSecretsFilePath({
        env: ampClientEnv
      });
      const state = await readAmpClientRoutingState({
        scope: settingsTarget.scope,
        settingsFilePath: settingsTarget.settingsFilePath,
        endpointUrl,
        cwd: ampClientCwd,
        env: ampClientEnv
      });
      return {
        ...state,
        secretsFilePath,
        endpointUrl,
        error: ""
      };
    } catch (error) {
      return {
        scope: "global",
        settingsFilePath: "",
        secretsFilePath: resolveAmpClientSecretsFilePath({
          env: ampClientEnv
        }),
        configuredUrl: "",
        routedViaRouter: false,
        settingsExists: false,
        endpointUrl,
        error: error instanceof Error ? error.message : String(error)
      };
    }
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
        ? provider.models.find((entry) => String(entry?.id || "").trim())
        : null;
      if (model?.id) return `${providerId}/${model.id}`;
    }

    return "";
  }

  function normalizeCodexBindingsInput(bindings = {}, config = {}) {
    const source = bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings : {};
    const defaultModel = String(source.defaultModel || "").trim();
    return {
      defaultModel: isCodexCliInheritModelBinding(defaultModel)
        ? CODEX_CLI_INHERIT_MODEL_VALUE
        : String(defaultModel || pickDefaultManagedRoute(config) || "").trim(),
      thinkingLevel: normalizeCodexCliReasoningEffort(source.thinkingLevel)
    };
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

  function describeManagedAlias(aliasId, alias = null) {
    const primaryTargets = dedupeTrimmedStrings(Array.isArray(alias?.targets) ? alias.targets.map((target) => target?.ref) : []);
    const fallbackTargets = dedupeTrimmedStrings(Array.isArray(alias?.fallbackTargets) ? alias.fallbackTargets.map((target) => target?.ref) : []);

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
    const fallbackModels = dedupeTrimmedStrings(Array.isArray(model?.fallbackModels) ? model.fallbackModels : []);

    if (fallbackModels.length > 0) {
      return `LLM Router route to ${providerName} model '${modelId}' with fallbacks ${fallbackModels.join(", ")}.`;
    }
    return `LLM Router route to ${providerName} model '${modelId}'.`;
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

  function normalizeClaudeBindingsInput(bindings = {}) {
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

  function normalizeClaudeBindingState(bindings = {}) {
    return normalizeClaudeBindingsInput(bindings);
  }

  function areCodexBindingsEqual(left = {}, right = {}) {
    const normalizedLeft = normalizeCodexBindingState(left);
    const normalizedRight = normalizeCodexBindingState(right);
    return (
      normalizedLeft.defaultModel === normalizedRight.defaultModel
      && normalizedLeft.thinkingLevel === normalizedRight.thinkingLevel
    );
  }

  function areClaudeBindingsEqual(left = {}, right = {}) {
    return (
      String(left?.primaryModel || "").trim() === String(right?.primaryModel || "").trim()
      && String(left?.defaultOpusModel || "").trim() === String(right?.defaultOpusModel || "").trim()
      && String(left?.defaultSonnetModel || "").trim() === String(right?.defaultSonnetModel || "").trim()
      && String(left?.defaultHaikuModel || "").trim() === String(right?.defaultHaikuModel || "").trim()
      && String(left?.subagentModel || "").trim() === String(right?.subagentModel || "").trim()
      && normalizeClaudeCodeEffortLevel(left?.thinkingLevel) === normalizeClaudeCodeEffortLevel(right?.thinkingLevel)
    );
  }

  function reconcileManagedRouteBinding(ref, rewriteContext) {
    return rewriteManagedRouteRef(ref, rewriteContext);
  }

  function reconcileCodexBindingsForConfig(bindings = {}, previousConfig = {}, nextConfig = {}) {
    const currentBindings = normalizeCodexBindingState(bindings);
    if (isCodexCliInheritModelBinding(currentBindings.defaultModel)) {
      return {
        defaultModel: CODEX_CLI_INHERIT_MODEL_VALUE,
        thinkingLevel: currentBindings.thinkingLevel
      };
    }
    const rewriteContext = buildManagedRouteRewriteContext(previousConfig, nextConfig);
    const nextDefaultModel = reconcileManagedRouteBinding(currentBindings.defaultModel, rewriteContext);
    return {
      defaultModel: nextDefaultModel || pickDefaultManagedRoute(nextConfig),
      thinkingLevel: currentBindings.thinkingLevel
    };
  }

  function formatCodexBindingLabel(defaultModel = "") {
    return isCodexCliInheritModelBinding(defaultModel)
      ? "Inherit Codex CLI model"
      : (String(defaultModel || "").trim() || "No model selected");
  }

  function reconcileClaudeBindingsForConfig(bindings = {}, previousConfig = {}, nextConfig = {}) {
    const currentBindings = normalizeClaudeBindingState(bindings);
    const rewriteContext = buildManagedRouteRewriteContext(previousConfig, nextConfig);
    return {
      primaryModel: reconcileManagedRouteBinding(currentBindings.primaryModel, rewriteContext),
      defaultOpusModel: reconcileManagedRouteBinding(currentBindings.defaultOpusModel, rewriteContext),
      defaultSonnetModel: reconcileManagedRouteBinding(currentBindings.defaultSonnetModel, rewriteContext),
      defaultHaikuModel: reconcileManagedRouteBinding(currentBindings.defaultHaikuModel, rewriteContext),
      subagentModel: reconcileManagedRouteBinding(currentBindings.subagentModel, rewriteContext),
      thinkingLevel: currentBindings.thinkingLevel
    };
  }

  async function readCodexCliGlobalRoutingState(settings = {}, config = null) {
    const endpointUrl = buildAmpClientEndpointUrl(settings);
    const apiKey = String(config?.masterKey || "").trim();
    try {
      const state = await readCodexCliRoutingState({
        endpointUrl,
        apiKey,
        env: codexCliEnv
      });
      return {
        ...state,
        endpointUrl,
        error: ""
      };
    } catch (error) {
      return {
        tool: "codex-cli",
        configFilePath: resolveCodexCliConfigFilePath({ env: codexCliEnv }),
        backupFilePath: "",
        configExists: false,
        backupExists: false,
        routedViaRouter: false,
        configuredBaseUrl: "",
        bindings: {
          defaultModel: "",
          thinkingLevel: ""
        },
        endpointUrl,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async function readClaudeCodeGlobalRoutingState(settings = {}, config = null) {
    const endpointUrl = buildAmpClientEndpointUrl(settings);
    const apiKey = String(config?.masterKey || "").trim();
    try {
      const state = await readClaudeCodeRoutingState({
        endpointUrl,
        apiKey,
        env: claudeCodeEnv
      });
      return {
        ...state,
        endpointUrl,
        error: ""
      };
    } catch (error) {
      return {
        tool: "claude-code",
        settingsFilePath: resolveClaudeCodeSettingsFilePath({ env: claudeCodeEnv }),
        backupFilePath: "",
        settingsExists: false,
        backupExists: false,
        routedViaRouter: false,
        configuredBaseUrl: "",
        bindings: {
          primaryModel: "",
          defaultOpusModel: "",
          defaultSonnetModel: "",
          defaultHaikuModel: "",
          subagentModel: "",
          thinkingLevel: ""
        },
        endpointUrl,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async function syncAmpGlobalRoutingIfNeeded({
    previousConfig = null,
    nextConfig = null,
    previousSettings = {},
    nextSettings = {}
  } = {}) {
    const previousEndpointUrl = buildAmpClientEndpointUrl(previousSettings);
    const nextEndpointUrl = buildAmpClientEndpointUrl(nextSettings);
    const previousMasterKey = String(previousConfig?.masterKey || previousConfig?.normalizedConfig?.masterKey || "").trim();
    const nextMasterKey = String(nextConfig?.masterKey || "").trim();

    if (!previousEndpointUrl || !nextEndpointUrl) return false;
    if (previousEndpointUrl === nextEndpointUrl && previousMasterKey === nextMasterKey) return false;

    const routingState = await readAmpGlobalRoutingState(previousSettings);
    if (routingState.error) {
      addLog("warn", "AMP global route check failed.", routingState.error);
      return false;
    }
    if (!routingState.routedViaRouter) return false;

    const settingsTarget = await resolvePreferredAmpSettingsTarget();
    const patchPlan = buildAmpClientPatchPlan({
      scope: settingsTarget.scope,
      settingsFilePath: settingsTarget.settingsFilePath,
      endpointUrl: nextEndpointUrl,
      apiKey: nextMasterKey,
      cwd: ampClientCwd,
      env: ampClientEnv
    });
    if (!patchPlan) return false;

    try {
      await patchAmpClientConfigFiles(patchPlan);
      addLog("info", "Updated AMP global route to match the local router.", nextEndpointUrl);
      return true;
    } catch (error) {
      addLog("warn", "AMP global route update failed.", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function syncCodexCliRoutingIfNeeded({
    previousConfig = null,
    nextConfig = null,
    previousSettings = {},
    nextSettings = {}
  } = {}) {
    const previousEndpointUrl = buildAmpClientEndpointUrl(previousSettings);
    const nextEndpointUrl = buildAmpClientEndpointUrl(nextSettings);
    const previousMasterKey = String(previousConfig?.masterKey || "").trim();
    const nextMasterKey = String(nextConfig?.masterKey || "").trim();
    const endpointOrKeyChanged = Boolean(
      previousEndpointUrl
      && nextEndpointUrl
      && (previousEndpointUrl !== nextEndpointUrl || previousMasterKey !== nextMasterKey)
    );

    const routingState = await readCodexCliGlobalRoutingState(previousSettings, previousConfig);
    if (routingState.error) {
      addLog("warn", "Codex CLI route check failed.", routingState.error);
      return false;
    }
    if (!routingState.routedViaRouter) return false;

    try {
      const currentBindings = normalizeCodexBindingState(routingState.bindings);
      const bindings = reconcileCodexBindingsForConfig(currentBindings, previousConfig, nextConfig);
      const bindingsChanged = !areCodexBindingsEqual(currentBindings, bindings);
      const previousCatalog = buildCodexCliModelCatalog(previousConfig, currentBindings) || {};
      const nextCatalog = buildCodexCliModelCatalog(nextConfig, bindings) || {};
      const catalogChanged = createJsonSignature(previousCatalog) !== createJsonSignature(nextCatalog);
      if (!endpointOrKeyChanged && !bindingsChanged && !catalogChanged) return false;

      await patchCodexCliConfigFile({
        endpointUrl: nextEndpointUrl,
        apiKey: nextMasterKey,
        bindings,
        modelCatalog: Object.keys(nextCatalog).length > 0 ? nextCatalog : undefined,
        captureBackup: false,
        env: codexCliEnv
      });
      if (endpointOrKeyChanged) {
        addLog("info", "Updated Codex CLI route to match the local router.", buildCodexCliEndpointUrl(nextSettings));
      } else {
        addLog("info", "Updated Codex CLI bindings to match the saved router config.", formatCodexBindingLabel(bindings.defaultModel));
      }
      return true;
    } catch (error) {
      addLog("warn", "Codex CLI route update failed.", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function syncClaudeCodeRoutingIfNeeded({
    previousConfig = null,
    nextConfig = null,
    previousSettings = {},
    nextSettings = {}
  } = {}) {
    const previousEndpointUrl = buildAmpClientEndpointUrl(previousSettings);
    const nextEndpointUrl = buildAmpClientEndpointUrl(nextSettings);
    const previousMasterKey = String(previousConfig?.masterKey || "").trim();
    const nextMasterKey = String(nextConfig?.masterKey || "").trim();
    const endpointOrKeyChanged = Boolean(
      previousEndpointUrl
      && nextEndpointUrl
      && (previousEndpointUrl !== nextEndpointUrl || previousMasterKey !== nextMasterKey)
    );

    const routingState = await readClaudeCodeGlobalRoutingState(previousSettings, previousConfig);
    if (routingState.error) {
      addLog("warn", "Claude Code route check failed.", routingState.error);
      return false;
    }
    if (!routingState.routedViaRouter) return false;

    try {
      const currentBindings = normalizeClaudeBindingState(routingState.bindings);
      const bindings = reconcileClaudeBindingsForConfig(currentBindings, previousConfig, nextConfig);
      const bindingsChanged = !areClaudeBindingsEqual(currentBindings, bindings);
      if (!endpointOrKeyChanged && !bindingsChanged) return false;

      await patchClaudeCodeSettingsFile({
        endpointUrl: nextEndpointUrl,
        apiKey: nextMasterKey,
        bindings,
        captureBackup: false,
        env: claudeCodeEnv
      });
      if (endpointOrKeyChanged) {
        addLog("info", "Updated Claude Code route to match the local router.", buildClaudeCodeEndpointUrl(nextSettings));
      } else {
        addLog("info", "Updated Claude Code bindings to match the saved router config.", bindings.primaryModel || "Default");
      }
      return true;
    } catch (error) {
      addLog("warn", "Claude Code route update failed.", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function readFactoryDroidGlobalRoutingState(settings = {}, config = null) {
    const endpointUrl = buildAmpClientEndpointUrl(settings);
    try {
      const state = await readFactoryDroidRoutingState({
        endpointUrl
      });
      return {
        ...state,
        endpointUrl,
        error: ""
      };
    } catch (error) {
      return {
        tool: "factory-droid",
        settingsFilePath: resolveFactoryDroidSettingsFilePath({}),
        backupFilePath: "",
        settingsExists: false,
        backupExists: false,
        routedViaRouter: false,
        configuredBaseUrl: "",
        bindings: {
          defaultModel: "",
          reasoningEffort: ""
        },
        endpointUrl,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async function syncFactoryDroidRoutingIfNeeded({
    previousConfig = null,
    nextConfig = null,
    previousSettings = {},
    nextSettings = {}
  } = {}) {
    const previousEndpointUrl = buildAmpClientEndpointUrl(previousSettings);
    const nextEndpointUrl = buildAmpClientEndpointUrl(nextSettings);
    const previousMasterKey = String(previousConfig?.masterKey || "").trim();
    const nextMasterKey = String(nextConfig?.masterKey || "").trim();
    const endpointOrKeyChanged = Boolean(
      previousEndpointUrl
      && nextEndpointUrl
      && (previousEndpointUrl !== nextEndpointUrl || previousMasterKey !== nextMasterKey)
    );

    if (!endpointOrKeyChanged) return false;

    const routingState = await readFactoryDroidGlobalRoutingState(previousSettings, previousConfig);
    if (routingState.error) {
      addLog("warn", "Factory Droid route check failed.", routingState.error);
      return false;
    }
    if (!routingState.routedViaRouter) return false;

    try {
      await patchFactoryDroidSettingsFile({
        endpointUrl: nextEndpointUrl,
        apiKey: nextMasterKey,
        bindings: routingState.bindings,
        captureBackup: false
      });
      addLog("info", "Updated Factory Droid route to match the local router.", buildFactoryDroidEndpointUrl(nextSettings));
      return true;
    } catch (error) {
      addLog("warn", "Factory Droid route update failed.", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function resolveProbeApiKey(apiKeyEnv, apiKey, { context = "testing config" } = {}) {
    const resolvedApiKeyEnv = String(apiKeyEnv || "").trim();
    const resolvedApiKey = String(apiKey || "").trim();
    if (!resolvedApiKeyEnv && !resolvedApiKey) {
      const error = new Error(`API key or env is required before ${context}.`);
      error.statusCode = 400;
      throw error;
    }

    const finalApiKey = resolvedApiKey || String(process.env[resolvedApiKeyEnv] || "").trim();
    if (!finalApiKey) {
      const error = new Error(`Environment variable '${resolvedApiKeyEnv}' is not set.`);
      error.statusCode = 400;
      throw error;
    }

    return finalApiKey;
  }

  const discoverProviderModelsFn = typeof deps.discoverProviderModels === "function" ? deps.discoverProviderModels : async ({ endpoints, apiKeyEnv, apiKey, headers }) => {
    const finalApiKey = await resolveProbeApiKey(apiKeyEnv, apiKey, { context: "discovering models" });
    const endpointList = dedupeTrimmedStrings(endpoints);
    const workingFormats = new Set();
    const discoveredModels = [];
    const discoveredModelSet = new Set();
    const baseUrlByFormat = {};
    const authByFormat = {};
    let preferredFormat = "";

    for (const endpoint of endpointList) {
      const result = await probeProvider({
        baseUrl: endpoint,
        apiKey: finalApiKey,
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
      warnings.push("No working endpoint format detected yet. Run Test config after choosing models.");
    }

    const resolvedWorkingFormats = [...workingFormats];
    const resolvedPreferredFormat = preferredFormat || resolvedWorkingFormats[0] || "";

    return {
      ok: discoveredModels.length > 0,
      endpoints: endpointList,
      models: discoveredModels,
      workingFormats: resolvedWorkingFormats,
      preferredFormat: resolvedPreferredFormat || null,
      baseUrlByFormat,
      authByFormat,
      warnings
    };
  };

  const testProviderConfigFn = typeof deps.testProviderConfig === "function" ? deps.testProviderConfig : async ({ endpoints, models, apiKeyEnv, apiKey, headers, onProgress }) => {
    const finalApiKey = await resolveProbeApiKey(apiKeyEnv, apiKey, { context: "testing config" });

    return probeProviderEndpointMatrix({
      endpoints,
      models,
      apiKey: finalApiKey,
      headers,
      requestsPerMinute: 30,
      onProgress
    });
  };
  const testHostedWebSearchProviderFn = typeof deps.testHostedWebSearchProvider === "function"
    ? deps.testHostedWebSearchProvider
    : async ({ runtimeConfig, providerId, modelId }) => {
      const resolvedProviderId = String(providerId || "").trim();
      const resolvedModelId = String(modelId || "").trim();
      if (!resolvedProviderId || !resolvedModelId) {
        const error = new Error("Provider id and model id are required before testing hosted web search.");
        error.statusCode = 400;
        throw error;
      }

      try {
        return await testHostedWebSearchProviderRoute({
          runtimeConfig,
          routeId: `${resolvedProviderId}/${resolvedModelId}`,
          env: runtimeEnv
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error && typeof error === "object" && Number.isFinite(error.statusCode)) {
          throw error;
        }
        const wrapped = new Error(message);
        wrapped.statusCode = (
          message.includes("not configured")
          || message.includes("not OpenAI-compatible")
          || message.includes("is required")
        ) ? 400 : 502;
        throw wrapped;
      }
    };
  const lookupLiteLlmContextWindowFn = typeof deps.lookupLiteLlmContextWindow === "function"
    ? deps.lookupLiteLlmContextWindow
    : createLiteLlmContextLookupHelper();

  const eventClients = new Set();
  const devEventClients = new Set();
  const logs = [];
  let logStateSignature = createLogStateSignature(logs);
  let webServer = null;
  let closing = false;
  let resolveDone;
  let doneResolved = false;
  let closePromise = null;
  let actualWebPort = Number(port);
  let configWatcher = null;
  let configWatchTimer = null;
  let activityLogWatcher = null;
  let activityLogWatchTimer = null;
  let ignoreConfigWatchUntil = 0;
  let activityLogEnabled = true;

  const routerState = {
    host: FIXED_LOCAL_ROUTER_HOST,
    port: FIXED_LOCAL_ROUTER_PORT,
    watchConfig: routerWatchConfig,
    watchBinary: routerWatchBinary,
    requireAuth: routerRequireAuth,
    lastError: ""
  };

  const done = new Promise((resolve) => {
    resolveDone = (value) => {
      if (doneResolved) return;
      doneResolved = true;
      resolve(value);
    };
  });

  function pushEvent(name, payload) {
    const serialized = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of eventClients) {
      client.write(serialized);
    }
  }

  function pushDevReload(payload) {
    const serialized = `event: reload\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of devEventClients) {
      client.write(serialized);
    }
  }

  function replaceLogs(nextEntries = []) {
    logs.splice(0, logs.length, ...nextEntries);
    logStateSignature = createLogStateSignature(logs);
  }

  function resolveActivityLogSnapshot(config = undefined) {
    if (config !== undefined) {
      const settings = readActivityLogSettings(config);
      activityLogEnabled = settings.enabled;
      return settings;
    }
    return { enabled: activityLogEnabled };
  }

  function emitLogState(config = undefined) {
    pushEvent("logs", {
      logs,
      activityLog: resolveActivityLogSnapshot(config)
    });
  }

  async function syncLogsFromFile({ config = undefined, broadcast = false } = {}) {
    const nextEntries = await readActivityLogEntries(resolvedActivityLogPath, {
      limit: MAX_LOG_ENTRIES
    });
    const nextSignature = createLogStateSignature(nextEntries);
    if (nextSignature === logStateSignature) return false;
    replaceLogs(nextEntries);
    if (broadcast) {
      emitLogState(config);
    }
    return true;
  }

  function scheduleActivityLogRefresh(reason = "change") {
    if (activityLogWatchTimer) clearTimeout(activityLogWatchTimer);
    activityLogWatchTimer = setTimeout(() => {
      activityLogWatchTimer = null;
      if (closing) return;
      void syncLogsFromFile({ broadcast: true }).catch(() => {});
    }, reason === "clear" ? 0 : 80);
  }

  function startActivityLogWatcher() {
    const activityLogDir = path.dirname(resolvedActivityLogPath);
    const activityLogFile = path.basename(resolvedActivityLogPath);
    try {
      activityLogWatcher = fsWatch(activityLogDir, (_eventType, filename) => {
        if (closing) return;
        if (filename && String(filename) !== activityLogFile) return;
        scheduleActivityLogRefresh("watch");
      });
    } catch {
      activityLogWatcher = null;
    }
  }

  function addLog(level, message, detail = "") {
    if (!activityLogEnabled) return null;
    const entry = createActivityLogEntry({
      level,
      message,
      detail,
      source: "web-console",
      category: "router",
      kind: "router-event"
    });
    logs.unshift(entry);
    logs.splice(MAX_LOG_ENTRIES);
    logStateSignature = createLogStateSignature(logs);
    pushEvent("log", entry);
    void appendActivityLogEntry(resolvedActivityLogPath, entry).catch(() => {});
    return entry;
  }

  try {
    const initialConfigState = await readConfigState(configPath);
    resolveActivityLogSnapshot(initialConfigState.normalizedConfig);
    await syncLogsFromFile({ config: initialConfigState.normalizedConfig });
  } catch {
    activityLogEnabled = true;
  }

  const devReloadScript = devMode ? String.raw`<script>
    (() => {
      const source = new EventSource("/__dev/events");
      source.addEventListener("reload", () => {
        window.location.reload();
      });
      source.onerror = () => {
        source.close();
        setTimeout(() => window.location.reload(), 500);
      };
    })();
  </script>` : "";

  let devAssets = null;
  if (devMode) {
    const startWebConsoleDevAssets = await loadWebConsoleDevAssetsFn();
    devAssets = await startWebConsoleDevAssets({
      onChange: (payload) => pushDevReload(payload),
      onError: (message) => addLog("warn", "Web console dev asset issue.", message)
    });
  }

  if (devMode) {
    addLog("info", "Web console dev asset watcher enabled.");
  }

  async function readActiveRuntime() {
    return getActiveRuntimeStateFn().catch(() => null);
  }

  function getWebConsoleConflictMessage(settings = getRouterStateSettings(routerState)) {
    if (!endpointsConflict(
      { host: settings.host, port: settings.port },
      { host, port: actualWebPort || port }
    )) {
      return "";
    }

    return `Fixed router port ${settings.port} conflicts with the web console on http://${formatHostForUrl(host, actualWebPort || port)}. Relaunch the web console on another port.`;
  }

  async function readManagedRuntime(settings = getRouterStateSettings(routerState)) {
    const activeRuntime = await readActiveRuntime();
    return runtimeMatchesEndpoint(activeRuntime, settings) ? activeRuntime : null;
  }

  async function readExternalRuntime(settings = getRouterStateSettings(routerState)) {
    const activeRuntime = await readActiveRuntime();
    if (!activeRuntime) return null;
    return runtimeMatchesEndpoint(activeRuntime, settings) ? null : activeRuntime;
  }

  function probeRouterPort(settings = getRouterStateSettings(routerState)) {
    const webConsoleConflict = getWebConsoleConflictMessage(settings);
    if (webConsoleConflict) {
      return {
        occupied: true,
        listenerPids: [],
        tool: "web-console",
        error: "",
        occupiedBySelf: true,
        reason: webConsoleConflict
      };
    }

    const probe = listListeningPidsFn(settings.port);
    if (!probe?.ok) {
      return {
        occupied: false,
        listenerPids: [],
        tool: String(probe?.tool || ""),
        error: probe?.error instanceof Error ? probe.error.message : String(probe?.error || ""),
        occupiedBySelf: false,
        reason: ""
      };
    }

    return {
      occupied: probe.pids.some((pid) => pid !== process.pid),
      listenerPids: probe.pids.filter((pid) => pid !== process.pid),
      tool: String(probe.tool || ""),
      error: "",
      occupiedBySelf: false,
      reason: ""
    };
  }

  async function reclaimRouterPortIfNeeded(settings = getRouterStateSettings(routerState), {
    reason = "Reclaiming router port from web console."
  } = {}) {
    const probe = probeRouterPort(settings);
    if (!probe.occupied) {
      return {
        ok: true,
        attempted: false,
        listenerPids: probe.listenerPids,
        errorMessage: probe.error
      };
    }

    addLog("warn", reason, `Port ${settings.port} is occupied by PID${probe.listenerPids.length === 1 ? "" : "s"}: ${probe.listenerPids.join(", ")}`);
    const reclaimed = await reclaimPortFn({
      port: settings.port,
      line: (message) => addLog("warn", message),
      error: (message) => addLog("error", message)
    });
    if (!reclaimed.ok) {
      return {
        ok: false,
        attempted: true,
        errorMessage: reclaimed.errorMessage || `Failed to reclaim port ${settings.port}.`
      };
    }

    const activeRuntime = await readActiveRuntime();
    if (activeRuntime && Number(activeRuntime.port) === Number(settings.port)) {
      if (activeRuntime.managedByStartup) {
        await clearRuntimeStateFn();
      } else {
        await clearRuntimeStateFn({ pid: activeRuntime.pid });
      }
    }

    routerState.lastError = "";
    addLog("success", `Port ${settings.port} reclaimed.`);
    return {
      ok: true,
      attempted: true,
      listenerPids: probe.listenerPids
    };
  }

  async function stopExternalRuntime(runtime, { reason = "Stopped another LLM Router instance." } = {}) {
    if (!runtime || Number(runtime.pid) === Number(process.pid)) return false;

    const runtimeUrl = `http://${formatHostForUrl(runtime.host, runtime.port)}`;
    if (runtime.managedByStartup) {
      await stopStartupFn();
      await clearRuntimeStateFn();
      addLog("warn", reason, runtimeUrl);
      return true;
    }

    const stopped = await stopProcessByPidFn(runtime.pid);
    if (!stopped?.ok) {
      const error = new Error(stopped?.reason || `Failed stopping LLM Router pid ${runtime.pid}.`);
      error.statusCode = 409;
      throw error;
    }

    await clearRuntimeStateFn({ pid: runtime.pid });
    addLog("warn", reason, runtimeUrl);
    return true;
  }

  async function stopUntrackedStartupRuntime({ reason = "Stopped startup-managed LLM Router." } = {}) {
    const startup = await startupStatusFn().catch(() => null);
    if (!startup?.running) return false;
    await stopStartupFn();
    await clearRuntimeStateFn();
    addLog("warn", reason, formatStartupDetail({ ...startup, installed: true, running: true }));
    return true;
  }

  async function startStartupOwnedRouter(settings, { restart = false } = {}) {
    await clearRuntimeStateFn();
    const detail = await installStartupFn({
      configPath,
      host: settings.host,
      port: settings.port,
      watchConfig: settings.watchConfig,
      watchBinary: settings.watchBinary,
      requireAuth: settings.requireAuth,
      cliPath: resolvedRouterCliPath
    });
    let runtime = await waitForRuntimeMatchFn({
      configPath,
      host: settings.host,
      port: settings.port,
      watchConfig: settings.watchConfig,
      watchBinary: settings.watchBinary,
      requireAuth: settings.requireAuth
    }, {
      getActiveRuntimeState: getActiveRuntimeStateFn,
      requireManagedByStartup: true
    });

    if (!runtime) {
      runtime = await readManagedRuntime(settings);
    }

    if (!runtime) {
      const startError = new Error(`Startup-managed LLM Router did not become ready on http://${settings.host}:${settings.port}.`);
      startError.statusCode = 500;
      throw startError;
    }

    syncRouterDefaults(runtime);
    routerState.lastError = "";
    const routerSnapshot = buildRouterSnapshot(runtime, settings, routerState.lastError);
    addLog("success", `${restart ? "Router restarted" : "Router started"} on ${routerSnapshot.url}`, formatStartupDetail({
      ...detail,
      manager: detail?.manager || "startup",
      installed: true,
      running: true
    }));
    return {
      message: restart ? "Router restarted." : "Router started.",
      snapshot: await buildSnapshot()
    };
  }

  async function reconcileManagedRouterWithConfig({ reason = "sync", configStateOverride = null } = {}) {
    const configState = configStateOverride || await readConfigState(configPath);
    const configLocalServer = getConfigLocalServer(configState);
    syncRouterDefaults(configLocalServer);

    if (configState.parseError || !configHasProvider(configState.normalizedConfig)) {
      return {
        ok: false,
        skipped: true,
        reason,
        configState,
        settings: configLocalServer
      };
    }

    const startup = await startupStatusFn().catch(() => null);
    const activeRuntime = await readManagedRuntime(configLocalServer);
    if (activeRuntime) {
      return {
        ok: true,
        alreadyRunning: true,
        reason,
        configState,
        settings: configLocalServer
      };
    }

    const externalRuntime = await readExternalRuntime(configLocalServer);
    if (externalRuntime) {
      await stopExternalRuntime(externalRuntime, {
        reason: `Stopped an existing LLM Router instance so the web console can manage ${configLocalServer.host}:${configLocalServer.port} during ${reason}.`
      });
    } else {
      await stopUntrackedStartupRuntime({
        reason: `Stopped the startup-managed LLM Router instance so the web console can manage ${configLocalServer.host}:${configLocalServer.port} during ${reason}.`
      });
    }

    const configStateForStart = {
      normalizedConfig: configState.normalizedConfig,
      parseError: configState.parseError
    };

    await startManagedRouter(configLocalServer, {
      skipPersist: true,
      configStateOverride: configStateForStart
    });
    return {
      ok: true,
      started: true,
      reason,
      configState,
      settings: configLocalServer
    };
  }

  function getConfigLocalServer(configState) {
    return readLocalServerSettings(configState?.normalizedConfig, getRouterStateSettings(routerState));
  }

  function syncRouterDefaults(settings) {
    routerState.host = settings.host;
    routerState.port = settings.port;
    routerState.watchConfig = settings.watchConfig;
    routerState.watchBinary = settings.watchBinary;
    routerState.requireAuth = settings.requireAuth;
  }

  async function persistLocalServerConfig(settings) {
    const currentConfigState = await readConfigState(configPath);
    if (currentConfigState.parseError) {
      const error = new Error(`Config JSON must parse before saving local server settings: ${currentConfigState.parseError}`);
      error.statusCode = 400;
      throw error;
    }

    const previousSettings = getConfigLocalServer(currentConfigState);
    const nextConfig = applyLocalServerSettings(currentConfigState.normalizedConfig || buildDefaultConfigObject(), settings);
    ignoreConfigWatchUntil = Date.now() + 800;
    const savedConfig = await writeConfigFile(nextConfig, configPath, { migrateToVersion: CONFIG_VERSION });
    const savedSettings = readLocalServerSettings(savedConfig, settings);

    const managedRuntime = await readManagedRuntime(previousSettings);
    if (!managedRuntime) {
      syncRouterDefaults(savedSettings);
    }

    return {
      previousConfig: currentConfigState.normalizedConfig,
      previousSettings,
      savedConfig,
      savedSettings
    };
  }

  async function persistActivityLogConfig(enabled) {
    const currentConfigState = await readConfigState(configPath);
    if (currentConfigState.parseError) {
      const error = new Error(`Config JSON must parse before saving activity log settings: ${currentConfigState.parseError}`);
      error.statusCode = 400;
      throw error;
    }

    const nextConfig = applyActivityLogSettings(
      currentConfigState.normalizedConfig || buildDefaultConfigObject(),
      { enabled: enabled === true }
    );
    ignoreConfigWatchUntil = Date.now() + 800;
    const savedConfig = await writeConfigFile(nextConfig, configPath, { migrateToVersion: CONFIG_VERSION });
    resolveActivityLogSnapshot(savedConfig);
    return savedConfig;
  }

  async function writeAndBroadcastConfig(parsed, { source = "" } = {}) {
    const previousConfigState = await readConfigState(configPath);
    const previousConfig = previousConfigState.normalizedConfig || buildDefaultConfigObject();
    const previousLocalServer = getConfigLocalServer(previousConfigState);
    ignoreConfigWatchUntil = Date.now() + 800;
    const savedConfig = await writeConfigFile(parsed, configPath, { migrateToVersion: CONFIG_VERSION });
    resolveActivityLogSnapshot(savedConfig);
    const nextLocalServer = readLocalServerSettings(savedConfig, previousLocalServer);

    if (source !== "autosave") {
      addLog("success", `Config saved to ${path.basename(configPath)}.`);
    }

    const managedRuntime = await readManagedRuntime(previousLocalServer);

    if (managedRuntime && !areLocalServerSettingsEqual(previousLocalServer, nextLocalServer)) {
      try {
        await restartManagedRouterWithSettings(nextLocalServer, {
          reason: "Restarting managed router to apply saved local server settings.",
          configStateOverride: {
            normalizedConfig: savedConfig,
            parseError: ""
          }
        });
      } catch (restartError) {
        addLog("warn", "Managed router restart skipped.", restartError instanceof Error ? restartError.message : String(restartError));
      }
    } else if (!managedRuntime) {
      syncRouterDefaults(nextLocalServer);
      try {
        await reconcileManagedRouterWithConfig({
          reason: "config-save",
          configStateOverride: {
            normalizedConfig: savedConfig,
            parseError: ""
          }
        });
      } catch (reconcileError) {
        addLog("warn", "Managed router auto-start skipped.", reconcileError instanceof Error ? reconcileError.message : String(reconcileError));
      }
    }

    await syncAmpGlobalRoutingIfNeeded({
      previousConfig,
      nextConfig: savedConfig,
      previousSettings: previousLocalServer,
      nextSettings: nextLocalServer
    });
    await syncCodexCliRoutingIfNeeded({
      previousConfig,
      nextConfig: savedConfig,
      previousSettings: previousLocalServer,
      nextSettings: nextLocalServer
    });
    await syncClaudeCodeRoutingIfNeeded({
      previousConfig,
      nextConfig: savedConfig,
      previousSettings: previousLocalServer,
      nextSettings: nextLocalServer
    });
    await syncFactoryDroidRoutingIfNeeded({
      previousConfig,
      nextConfig: savedConfig,
      previousSettings: previousLocalServer,
      nextSettings: nextLocalServer
    });

    const snapshot = await broadcastState();
    return {
      snapshot,
      savedConfig,
      nextLocalServer
    };
  }

  let routerRestartPromise = null;

  async function restartManagedRouterWithSettings(settings, {
    reason = "Restarting managed router.",
    configStateOverride = null
  } = {}) {
    if (routerRestartPromise) return routerRestartPromise;
    routerRestartPromise = (async () => {
      try {
        return await startManagedRouter(settings, {
          restart: true,
          skipPersist: true,
          configStateOverride,
          restartReason: reason
        });
      } finally {
        routerRestartPromise = null;
      }
    })();
    return routerRestartPromise;
  }

  async function buildSnapshot() {
    const configState = await readConfigState(configPath);
    const configLocalServer = getConfigLocalServer(configState);
    const activityLog = resolveActivityLogSnapshot(configState.normalizedConfig);
    const startup = await startupStatusFn().catch((error) => ({
      manager: "unknown",
      serviceId: "llm-router",
      installed: false,
      running: false,
      detail: error instanceof Error ? error.message : String(error)
    }));
    const managedRuntime = await readManagedRuntime(configLocalServer);
    const externalRuntime = managedRuntime ? null : await readExternalRuntime(configLocalServer);
    const portProbe = probeRouterPort(configLocalServer);
    const routerSnapshot = {
      ...buildRouterSnapshot(managedRuntime, configLocalServer, routerState.lastError),
      portBusy: !managedRuntime && portProbe.occupied,
      portBusySelf: !managedRuntime && portProbe.occupiedBySelf === true,
      portBusyReason: !managedRuntime ? String(portProbe.reason || "") : "",
      listenerPids: !managedRuntime ? portProbe.listenerPids : [],
      portProbeError: !managedRuntime ? portProbe.error : ""
    };
    const ampClientGlobal = await readAmpGlobalRoutingState(configLocalServer);
    const codexCliGlobal = await readCodexCliGlobalRoutingState(configLocalServer, configState.normalizedConfig);
    const claudeCodeGlobal = await readClaudeCodeGlobalRoutingState(configLocalServer, configState.normalizedConfig);
    const factoryDroidGlobal = await readFactoryDroidGlobalRoutingState(configLocalServer, configState.normalizedConfig);
    const webSearch = await readWebSearchState(configState.normalizedConfig).catch(() => null);
    const ollamaConfig = configState.normalizedConfig?.ollama;
    const ollamaBaseUrl = ollamaConfig?.baseUrl || "http://localhost:11434";
    const ollamaInstallation = detectOllamaInstallation();
    const ollamaState = ollamaInstallation.installed
      ? await ollamaCheckConnection(ollamaBaseUrl).catch(() => ({ ok: false }))
      : { ok: false };

    return {
      web: {
        host,
        port: actualWebPort,
        url: `http://${formatHostForUrl(host, actualWebPort)}`,
        localOnly: !allowRemoteClients
      },
      config: {
        ...configState.summary,
        document: routeSnapshotDocument(configState),
        localServer: configLocalServer
      },
      router: routerSnapshot,
      startup: {
        ...startup,
        label: formatStartupLabel(startup),
        friendlyDetail: formatStartupDetail(startup),
        defaults: configLocalServer
      },
      ampClient: {
        global: ampClientGlobal
      },
      webSearch,
      ampWebSearch: webSearch,
      codingTools: {
        codexCli: codexCliGlobal,
        claudeCode: claudeCodeGlobal,
        factoryDroid: factoryDroidGlobal
      },
      ollama: {
        installed: ollamaInstallation.installed,
        connected: ollamaState.ok === true,
        baseUrl: ollamaBaseUrl,
        enabled: ollamaConfig?.enabled === true,
        version: ollamaInstallation.version || null,
        path: ollamaInstallation.path || null
      },
      defaults: {
        providerUserAgent: DEFAULT_PROVIDER_USER_AGENT
      },
      editors: detectAvailableEditorsFn(),
      externalRuntime,
      activityLog,
      logs
    };
  }

  async function broadcastState() {
    const snapshot = await buildSnapshot();
    pushEvent("state", { snapshot });
    return snapshot;
  }

  function scheduleConfigRefresh(reason = "change") {
    if (configWatchTimer) clearTimeout(configWatchTimer);
    configWatchTimer = setTimeout(() => {
      configWatchTimer = null;
      if (closing) return;
      if (Date.now() < ignoreConfigWatchUntil) return;
      void (async () => {
        let latestConfigState = null;
        try {
          latestConfigState = await readConfigState(configPath);
          resolveActivityLogSnapshot(latestConfigState.normalizedConfig);
        } catch {
          latestConfigState = null;
        }
        addLog("info", `Config file changed on disk (${reason}).`);
        try {
          await reconcileManagedRouterWithConfig({ reason: `config-watch:${reason}` });
        } catch (reconcileError) {
          addLog("warn", "Managed router auto-start skipped.", reconcileError instanceof Error ? reconcileError.message : String(reconcileError));
        } finally {
          await broadcastState().catch(() => {});
        }
      })();
    }, 150);
  }

  function startConfigWatcher() {
    const configDir = path.dirname(configPath);
    const configFile = path.basename(configPath);
    try {
      configWatcher = fsWatch(configDir, (eventType, filename) => {
        if (closing) return;
        if (filename && String(filename) !== configFile) return;
        if (Date.now() < ignoreConfigWatchUntil) return;
        scheduleConfigRefresh(eventType || "change");
      });
    } catch (error) {
      addLog("warn", "Could not start config watcher.", error instanceof Error ? error.message : String(error));
    }
  }

  async function stopManagedRouter({
    reason = "Stopped from web console.",
    settings = getRouterStateSettings(routerState),
    reclaimPortIfStopped = false
  } = {}) {
    const activeRuntime = await readManagedRuntime(settings);
    if (!activeRuntime) {
      if (reclaimPortIfStopped) {
        const reclaimed = await reclaimRouterPortIfNeeded(settings, { reason });
        if (!reclaimed.ok) {
          const stopError = new Error(reclaimed.errorMessage || `Failed reclaiming port ${settings.port}.`);
          stopError.statusCode = 409;
          throw stopError;
        }
        if (reclaimed.attempted) return true;
      }
      routerState.lastError = "";
      return false;
    }

    if (activeRuntime.managedByStartup) {
      await stopStartupFn();
      await clearRuntimeStateFn();
      routerState.lastError = "";
      addLog("info", reason);
      return true;
    }

    const stopped = await stopProcessByPidFn(activeRuntime.pid);
    if (!stopped?.ok) {
      const stopError = new Error(stopped?.reason || `Failed stopping LLM Router pid ${activeRuntime.pid}.`);
      stopError.statusCode = 409;
      throw stopError;
    }

    await clearRuntimeStateFn({ pid: activeRuntime.pid });
    routerState.lastError = "";
    addLog("info", reason);
    return true;
  }

  async function startManagedRouter(body = {}, {
    restart = false,
    skipPersist = false,
    configStateOverride = null,
    restartReason = "Restarting managed router from web console."
  } = {}) {
    let configState = configStateOverride || await readConfigState(configPath);
    let persistedLocalServer = null;
    if (configState.parseError) {
      const error = new Error(`Config JSON must parse before starting the router: ${configState.parseError}`);
      error.statusCode = 400;
      throw error;
    }
    if (!configHasProvider(configState.normalizedConfig)) {
      const error = new Error("At least one enabled provider is required before starting the router.");
      error.statusCode = 400;
      throw error;
    }

    const currentDefaults = getConfigLocalServer(configState);
    let nextOptions = resolveRouterOptions(currentDefaults, body);

    if (nextOptions.requireAuth && !configState.normalizedConfig.masterKey) {
      const error = new Error("masterKey is required when enabling auth for the managed router.");
      error.statusCode = 400;
      throw error;
    }

    if (!skipPersist) {
      const persisted = await persistLocalServerConfig(nextOptions);
      persistedLocalServer = persisted;
      configState = {
        ...configState,
        normalizedConfig: persisted.savedConfig
      };
      nextOptions = persisted.savedSettings;
    }

    const startup = await startupStatusFn().catch(() => null);
    const preferStartupOwnership = Boolean(startup?.installed);
    const runningRuntime = await readManagedRuntime(nextOptions);
    const webConsoleConflict = getWebConsoleConflictMessage(nextOptions);

    if (webConsoleConflict) {
      routerState.lastError = webConsoleConflict;
      addLog("error", "Failed to start router.", webConsoleConflict);
      await broadcastState().catch(() => {});
      const conflictError = new Error(webConsoleConflict);
      conflictError.statusCode = 409;
      throw conflictError;
    }

    if (restart) {
      await stopManagedRouter({ reason: restartReason, settings: nextOptions });
    } else if (runningRuntime) {
      return {
        message: "Router is already running.",
        snapshot: await buildSnapshot()
      };
    }

    const externalRuntime = await readExternalRuntime(nextOptions);
    if (externalRuntime) {
      await stopExternalRuntime(externalRuntime, {
        reason: "Stopped another LLM Router instance before starting the managed router."
      });
    } else {
      await stopUntrackedStartupRuntime({
        reason: "Stopped the startup-managed LLM Router instance before starting the managed router."
      });
    }

    const reclaimed = await reclaimRouterPortIfNeeded(nextOptions, {
      reason: "Stopping the existing listener so the web console can take over the router port."
    });
    if (!reclaimed.ok) {
      const reclaimError = new Error(reclaimed.errorMessage || `Failed reclaiming port ${nextOptions.port}.`);
      reclaimError.statusCode = 409;
      throw reclaimError;
    }

    try {
      if (preferStartupOwnership) {
        const result = await startStartupOwnedRouter(nextOptions, { restart });
        if (persistedLocalServer) {
          await syncAmpGlobalRoutingIfNeeded({
            previousConfig: persistedLocalServer.previousConfig,
            nextConfig: persistedLocalServer.savedConfig,
            previousSettings: persistedLocalServer.previousSettings,
            nextSettings: persistedLocalServer.savedSettings
          });
          await syncCodexCliRoutingIfNeeded({
            previousConfig: persistedLocalServer.previousConfig,
            nextConfig: persistedLocalServer.savedConfig,
            previousSettings: persistedLocalServer.previousSettings,
            nextSettings: persistedLocalServer.savedSettings
          });
          await syncClaudeCodeRoutingIfNeeded({
            previousConfig: persistedLocalServer.previousConfig,
            nextConfig: persistedLocalServer.savedConfig,
            previousSettings: persistedLocalServer.previousSettings,
            nextSettings: persistedLocalServer.savedSettings
          });
          await syncFactoryDroidRoutingIfNeeded({
            previousConfig: persistedLocalServer.previousConfig,
            nextConfig: persistedLocalServer.savedConfig,
            previousSettings: persistedLocalServer.previousSettings,
            nextSettings: persistedLocalServer.savedSettings
          });
          result.snapshot = await buildSnapshot();
        }
        return result;
      }

      const started = await startDetachedRouterServiceFn({
        cliPath: resolvedRouterCliPath,
        configPath,
        host: nextOptions.host,
        port: nextOptions.port,
        watchConfig: nextOptions.watchConfig,
        watchBinary: nextOptions.watchBinary,
        requireAuth: nextOptions.requireAuth
      });
      if (!started?.ok) {
        const startError = new Error(started?.errorMessage || `Failed to start LLM Router on http://${nextOptions.host}:${nextOptions.port}.`);
        startError.statusCode = 500;
        throw startError;
      }

      const runtime = started.runtime || await readManagedRuntime(nextOptions);
      syncRouterDefaults(runtime || nextOptions);
      routerState.lastError = "";
      const routerSnapshot = buildRouterSnapshot(runtime, nextOptions, routerState.lastError);
      addLog("success", `Router started on ${routerSnapshot.url}`);
      if (persistedLocalServer) {
        await syncAmpGlobalRoutingIfNeeded({
          previousConfig: persistedLocalServer.previousConfig,
          nextConfig: persistedLocalServer.savedConfig,
          previousSettings: persistedLocalServer.previousSettings,
          nextSettings: persistedLocalServer.savedSettings
        });
        await syncCodexCliRoutingIfNeeded({
          previousConfig: persistedLocalServer.previousConfig,
          nextConfig: persistedLocalServer.savedConfig,
          previousSettings: persistedLocalServer.previousSettings,
          nextSettings: persistedLocalServer.savedSettings
        });
        await syncClaudeCodeRoutingIfNeeded({
          previousConfig: persistedLocalServer.previousConfig,
          nextConfig: persistedLocalServer.savedConfig,
          previousSettings: persistedLocalServer.previousSettings,
          nextSettings: persistedLocalServer.savedSettings
        });
        await syncFactoryDroidRoutingIfNeeded({
          previousConfig: persistedLocalServer.previousConfig,
          nextConfig: persistedLocalServer.savedConfig,
          previousSettings: persistedLocalServer.previousSettings,
          nextSettings: persistedLocalServer.savedSettings
        });
      }
      // Non-blocking: preload Ollama models after router start
      preloadOllamaModels(configState.normalizedConfig).catch(() => {});
      return {
        message: restart ? "Router restarted." : "Router started.",
        snapshot: await buildSnapshot()
      };
    } catch (error) {
      routerState.lastError = error instanceof Error ? error.message : String(error);
      addLog("error", "Failed to start router.", routerState.lastError);
      await broadcastState().catch(() => {});
      throw error;
    }
  }

  async function preloadOllamaModels(config) {
    const ollamaConfig = config?.ollama;
    if (!ollamaConfig?.enabled) return;
    const autoLoadModels = ollamaConfig.autoLoadModels || [];
    if (!autoLoadModels.length) return;
    const baseUrl = ollamaConfig.baseUrl || "http://localhost:11434";
    const connected = await ollamaCheckConnection(baseUrl);
    if (!connected.ok) {
      addLog("info", "Ollama not reachable, skipping model preload.");
      return;
    }
    for (const modelId of autoLoadModels) {
      const keepAlive = ollamaConfig.managedModels?.[modelId]?.keepAlive
        || ollamaConfig.defaultKeepAlive || "5m";
      const result = await ollamaLoadModel(baseUrl, modelId, keepAlive).catch(() => ({ ok: false }));
      if (result.ok) {
        addLog("info", `Ollama: Preloaded ${modelId} (${Math.round(result.loadDurationMs || 0)}ms).`);
      } else {
        addLog("warn", `Ollama: Failed to preload ${modelId}.`);
      }
    }
  }

  async function shutdown(reason = "web-console-closed") {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (configWatchTimer) {
        clearTimeout(configWatchTimer);
        configWatchTimer = null;
      }
      if (configWatcher) {
        configWatcher.close();
        configWatcher = null;
      }
      if (activityLogWatchTimer) {
        clearTimeout(activityLogWatchTimer);
        activityLogWatchTimer = null;
      }
      if (activityLogWatcher) {
        activityLogWatcher.close();
        activityLogWatcher = null;
      }

      for (const client of eventClients) {
        client.end();
      }
      eventClients.clear();
      for (const client of devEventClients) {
        client.end();
      }
      devEventClients.clear();

      if (devAssets) {
        await devAssets.close();
      }

      if (webServer) {
        await new Promise((resolve) => webServer.close(() => resolve()));
        webServer = null;
      }

      resolveDone({ reason });
      return { ok: true, reason };
    })();
    return closePromise;
  }

  webServer = http.createServer(async (req, res) => {
    if (!allowRemoteClients && !isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { error: "The web console only accepts local requests." });
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://${formatHostForUrl(host, actualWebPort || port || 8788)}`);
    const method = req.method || "GET";

    try {
      if (method === "GET" && requestUrl.pathname === "/") {
        sendText(res, 200, "text/html; charset=utf-8", renderWebConsoleHtml({ bodyHtml: devReloadScript }));
        return;
      }

      if (devMode && method === "GET" && requestUrl.pathname === "/__dev/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive"
        });
        res.write(": connected\n\n");
        devEventClients.add(res);
        req.on("close", () => {
          devEventClients.delete(res);
        });
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/styles.css") {
        sendText(res, 200, "text/css; charset=utf-8", devAssets ? devAssets.getStylesCss() : WEB_CONSOLE_CSS);
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/app.js") {
        sendText(res, 200, "application/javascript; charset=utf-8", devAssets ? devAssets.getAppJs() : WEB_CONSOLE_APP_JS);
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/state") {
        sendJson(res, 200, await buildSnapshot());
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive"
        });
        res.write(": connected\n\n");
        eventClients.add(res);
        req.on("close", () => {
          eventClients.delete(res);
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/activity-log/settings") {
        const body = await readJsonBody(req);
        const enabled = body?.enabled === false ? false : true;
        const savedConfig = await persistActivityLogConfig(enabled);
        await syncLogsFromFile({ config: savedConfig });
        if (enabled) {
          addLog("info", "Activity logging enabled.");
        }
        const snapshot = await broadcastState();
        sendJson(res, 200, {
          ...snapshot,
          message: enabled ? "Activity log enabled." : "Activity log disabled."
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/activity-log/clear") {
        await clearActivityLogFile(resolvedActivityLogPath);
        replaceLogs([]);
        emitLogState();
        sendJson(res, 200, {
          ...(await buildSnapshot()),
          message: "Activity log cleared."
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/config/validate") {
        const body = await readJsonBody(req);
        const rawText = body?.rawText !== undefined
          ? String(body.rawText || "")
          : `${JSON.stringify(body?.config || {}, null, 2)}\n`;
        let normalizedConfig = null;
        let parseError = "";
        try {
          const parsed = body?.config && typeof body.config === "object" && !Array.isArray(body.config)
            ? body.config
            : (rawText.trim() ? JSON.parse(rawText) : {});
          normalizedConfig = normalizeRuntimeConfig(parsed, { migrateToVersion: CONFIG_VERSION });
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
        const summary = createConfigSummary({
          configPath,
          exists: true,
          rawText,
          parseError,
          normalizedConfig
        });
        sendJson(res, 200, {
          summary,
          validationMessages: summary.validationMessages
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/config/test-provider") {
        const body = await readJsonBody(req);
        const endpoints = Array.isArray(body?.endpoints) ? body.endpoints.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
        const models = Array.isArray(body?.models) ? body.models.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
        const apiKeyEnv = String(body?.apiKeyEnv || "").trim();
        const apiKey = String(body?.apiKey || "").trim();
        const headers = body?.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
          ? body.headers
          : undefined;

        if (endpoints.length === 0) {
          sendJson(res, 400, { error: "At least one endpoint is required before testing config." });
          return;
        }
        if (models.length === 0) {
          sendJson(res, 400, { error: "At least one model id is required before testing config." });
          return;
        }
        if (!apiKeyEnv && !apiKey) {
          sendJson(res, 400, { error: "API key or env is required before testing config." });
          return;
        }

        addLog("info", "Testing provider config.", `${endpoints.length} endpoint(s) · ${models.length} model(s)`);
        const result = await testProviderConfigFn({ endpoints, models, apiKeyEnv, apiKey, headers });
        addLog(result.ok ? "success" : "warn", "Config test finished.", result.ok
          ? `${(result.workingFormats || []).join(", ") || "No working formats"} · ${(result.models || []).length} model(s) confirmed`
          : (result.warnings || []).join(" ") || "Could not confirm a working endpoint/model combination.");
        sendJson(res, 200, { result });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/config/test-web-search-provider") {
        const body = await readJsonBody(req);
        const providerId = String(body?.providerId || "").trim();
        const modelId = String(body?.modelId || "").trim();
        const rawText = body?.rawText !== undefined
          ? String(body.rawText || "")
          : `${JSON.stringify(body?.config || {}, null, 2)}\n`;

        if (!providerId || !modelId) {
          sendJson(res, 400, { error: "Provider id and model id are required before testing hosted web search." });
          return;
        }

        let normalizedConfig = null;
        try {
          const parsed = body?.config && typeof body.config === "object" && !Array.isArray(body.config)
            ? body.config
            : (rawText.trim() ? JSON.parse(rawText) : {});
          normalizedConfig = normalizeRuntimeConfig(parsed, { migrateToVersion: CONFIG_VERSION });
        } catch (error) {
          sendJson(res, 400, { error: `Current config draft is invalid JSON: ${error instanceof Error ? error.message : String(error)}` });
          return;
        }

        addLog("info", "Testing hosted web search route.", `${providerId}/${modelId}`);
        try {
          const result = await testHostedWebSearchProviderFn({
            runtimeConfig: normalizedConfig,
            providerId,
            modelId
          });
          addLog("success", "Hosted web search route is ready.", `${providerId}/${modelId}`);
          sendJson(res, 200, { result });
        } catch (error) {
          addLog("warn", "Hosted web search route test failed.", error instanceof Error ? error.message : String(error));
          sendJson(res, Number(error?.statusCode) || 502, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/config/test-provider-stream") {
        const body = await readJsonBody(req);
        const endpoints = Array.isArray(body?.endpoints) ? body.endpoints.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
        const models = Array.isArray(body?.models) ? body.models.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
        const apiKeyEnv = String(body?.apiKeyEnv || "").trim();
        const apiKey = String(body?.apiKey || "").trim();
        const headers = body?.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
          ? body.headers
          : undefined;

        if (endpoints.length === 0) {
          sendJson(res, 400, { error: "At least one endpoint is required before testing config." });
          return;
        }
        if (models.length === 0) {
          sendJson(res, 400, { error: "At least one model id is required before testing config." });
          return;
        }
        if (!apiKeyEnv && !apiKey) {
          sendJson(res, 400, { error: "API key or env is required before testing config." });
          return;
        }

        addLog("info", "Testing provider config.", `${endpoints.length} endpoint(s) · ${models.length} model(s)`);
        startJsonLineStream(res);
        writeJsonLine(res, { type: "start", modelCount: models.length, endpointCount: endpoints.length });
        try {
          const result = await testProviderConfigFn({
            endpoints,
            models,
            apiKeyEnv,
            apiKey,
            headers,
            onProgress: (event) => writeJsonLine(res, { type: "progress", event })
          });
          addLog(result.ok ? "success" : "warn", "Config test finished.", result.ok
            ? `${(result.workingFormats || []).join(", ") || "No working formats"} · ${(result.models || []).length} model(s) confirmed`
            : (result.warnings || []).join(" ") || "Could not confirm a working endpoint/model combination.");
          writeJsonLine(res, { type: "result", result });
        } catch (error) {
          writeJsonLine(res, {
            type: "error",
            error: error instanceof Error ? error.message : String(error),
            statusCode: error && typeof error === "object" ? error.statusCode || 500 : 500
          });
        } finally {
          res.end();
        }
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/config/discover-provider-models") {
        const body = await readJsonBody(req);
        const endpoints = Array.isArray(body?.endpoints) ? body.endpoints.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
        const apiKeyEnv = String(body?.apiKeyEnv || "").trim();
        const apiKey = String(body?.apiKey || "").trim();
        const headers = body?.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
          ? body.headers
          : undefined;

        if (endpoints.length === 0) {
          sendJson(res, 400, { error: "At least one endpoint is required before discovering models." });
          return;
        }
        if (!apiKeyEnv && !apiKey) {
          sendJson(res, 400, { error: "API key or env is required before discovering models." });
          return;
        }

        addLog("info", "Discovering provider models.", `${endpoints.length} endpoint(s)`);
        const result = await discoverProviderModelsFn({ endpoints, apiKeyEnv, apiKey, headers });
        addLog(result.ok ? "success" : "warn", "Model discovery finished.", result.ok
          ? `${(result.models || []).length} model(s) discovered`
          : (result.warnings || []).join(" ") || "Could not discover models from the provider model list API.");
        sendJson(res, 200, { result });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/config/probe-free-tier-models") {
        const body = await readJsonBody(req);
        const baseUrl = String(body?.baseUrl || "").trim();
        const apiKeyEnv = String(body?.apiKeyEnv || "").trim();
        const apiKey = String(body?.apiKey || "").trim();
        const modelIds = Array.isArray(body?.modelIds) ? body.modelIds.map((id) => String(id || "").trim()).filter(Boolean) : [];

        if (!baseUrl || modelIds.length === 0) {
          sendJson(res, 400, { error: "baseUrl and at least one modelId are required." });
          return;
        }

        try {
          const finalApiKey = await resolveProbeApiKey(apiKeyEnv, apiKey, { context: "probing free-tier models" });
          addLog("info", "Probing free-tier model availability.", `${modelIds.length} model(s)`);
          const result = await probeFreeTierModels({ baseUrl, apiKey: finalApiKey, modelIds, timeoutMs: 6000 });
          const freeCount = Object.values(result).filter((r) => r?.freeTier === true).length;
          addLog("success", "Free-tier probe finished.", `${freeCount}/${modelIds.length} model(s) on free tier`);
          sendJson(res, 200, { result });
        } catch (error) {
          sendJson(res, error?.statusCode || 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/config/litellm-context-lookup") {
        const body = await readJsonBody(req);
        const models = Array.isArray(body?.models) ? body.models.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
        if (models.length === 0) {
          sendJson(res, 400, { error: "At least one model id is required before looking up context windows." });
          return;
        }

        try {
          const result = await lookupLiteLlmContextWindowFn({
            models,
            limit: body?.limit
          });
          sendJson(res, 200, {
            result,
            source: {
              provider: "litellm",
              url: LITELLM_CONTEXT_CATALOG_URL
            }
          });
        } catch (error) {
          sendJson(res, Number(error?.statusCode) || 502, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/config/save") {
        const body = await readJsonBody(req);
        let parsed;
        try {
          if (body?.config && typeof body.config === "object" && !Array.isArray(body.config)) {
            parsed = body.config;
          } else {
            const rawText = String(body?.rawText || "");
            parsed = rawText.trim() ? JSON.parse(rawText) : {};
          }
        } catch (error) {
          sendJson(res, 400, {
            error: `Config JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
          });
          return;
        }

        const source = String(body?.source || "").trim();
        const { snapshot } = await writeAndBroadcastConfig(parsed, { source });
        sendJson(res, 200, snapshot);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/amp/apply") {
        const body = await readJsonBody(req);
        let parsed;
        try {
          if (body?.config && typeof body.config === "object" && !Array.isArray(body.config)) {
            parsed = body.config;
          } else {
            const rawText = String(body?.rawText || "");
            parsed = rawText.trim() ? JSON.parse(rawText) : {};
          }
        } catch (error) {
          sendJson(res, 400, {
            error: `Config JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
          });
          return;
        }

        const patchPlan = buildAmpClientPatchPlan({
          scope: body?.patchScope,
          settingsFilePath: body?.settingsFilePath,
          secretsFilePath: body?.secretsFilePath,
          endpointUrl: body?.endpointUrl,
          apiKey: body?.apiKey || parsed?.masterKey,
          cwd: ampClientCwd,
          env: ampClientEnv
        });

        const bootstrap = await maybeBootstrapAmpConfig({
          config: parsed,
          amp: parsed?.amp,
          patchPlan,
          env: ampClientEnv
        });
        if (bootstrap.error) {
          sendJson(res, 400, { error: bootstrap.error });
          return;
        }

        const nextConfig = {
          ...(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}),
          amp: bootstrap.amp
        };
        const source = String(body?.source || "autosave").trim() || "autosave";
        const { snapshot } = await writeAndBroadcastConfig(nextConfig, { source });

        let patchResult = null;
        let patchError = "";
        if (patchPlan) {
          try {
            patchResult = await patchAmpClientConfigFiles(patchPlan);
          } catch (error) {
            patchError = error instanceof Error ? error.message : String(error);
            addLog("warn", "AMP client patch failed.", patchError);
          }
        }

        sendJson(res, 200, {
          ...snapshot,
          amp: {
            patchResult,
            patchError,
            bootstrapDefaultRoute: bootstrap.bootstrapRouteRef || "",
            defaultsBootstrapped: bootstrap.changed === true,
            upstreamKeyAutoDiscovered: bootstrap.discoveredUpstreamApiKey === true
          }
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/amp/global-route") {
        const body = await readJsonBody(req);
        const enabled = body?.enabled !== false;

        if (!enabled) {
          const currentConfigState = await readConfigState(configPath).catch(() => null);
          const currentSettings = getConfigLocalServer(currentConfigState);
          const routingState = await readAmpGlobalRoutingState(currentSettings);
          if (routingState.error) {
            sendJson(res, 400, { error: routingState.error });
            return;
          }

          if (!routingState.configuredUrl) {
            const snapshot = await broadcastState();
            sendJson(res, 200, { ...snapshot, message: "AMP already routes directly." });
            return;
          }

          const unpatchResult = await unpatchAmpClientConfigFiles({
            settingsFilePath: routingState.settingsFilePath,
            endpointUrl: routingState.configuredUrl,
            env: ampClientEnv
          });
          addLog("info", "AMP global routing disabled.", routingState.configuredUrl);
          const snapshot = await broadcastState();
          sendJson(res, 200, {
            ...snapshot,
            message: "AMP now routes directly.",
            ampClient: {
              ...(snapshot.ampClient || {}),
              unpatchResult
            }
          });
          return;
        }

        let parsed;
        try {
          if (body?.config && typeof body.config === "object" && !Array.isArray(body.config)) {
            parsed = body.config;
          } else {
            const rawText = String(body?.rawText || "");
            parsed = rawText.trim() ? JSON.parse(rawText) : {};
          }
        } catch (error) {
          sendJson(res, 400, {
            error: `Config JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
          });
          return;
        }

        const configState = {
          normalizedConfig: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
          parseError: ""
        };
        const endpointUrl = String(body?.endpointUrl || buildAmpClientEndpointUrl(getConfigLocalServer(configState))).trim();
        const settingsTarget = await resolvePreferredAmpSettingsTarget();
        const patchPlan = buildAmpClientPatchPlan({
          scope: settingsTarget.scope,
          settingsFilePath: body?.settingsFilePath || settingsTarget.settingsFilePath,
          secretsFilePath: body?.secretsFilePath,
          endpointUrl,
          apiKey: body?.apiKey || parsed?.masterKey,
          cwd: ampClientCwd,
          env: ampClientEnv
        });
        if (!patchPlan) {
          sendJson(res, 400, { error: "AMP global route needs a valid local router URL and gateway key." });
          return;
        }

        const bootstrap = await maybeBootstrapAmpConfig({
          config: parsed,
          amp: parsed?.amp,
          patchPlan,
          env: ampClientEnv
        });
        if (bootstrap.error) {
          sendJson(res, 400, { error: bootstrap.error });
          return;
        }

        const nextConfig = {
          ...(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}),
          amp: bootstrap.amp
        };

        await writeAndBroadcastConfig(nextConfig, { source: "amp-global-route" });
        const patchResult = await patchAmpClientConfigFiles(patchPlan);
        addLog("success", "AMP global routing enabled.", patchPlan.endpointUrl);
        const snapshot = await broadcastState();
        sendJson(res, 200, {
          ...snapshot,
          message: "AMP now routes via LLM Router.",
          amp: {
            patchResult,
            bootstrapDefaultRoute: bootstrap.bootstrapRouteRef || "",
            defaultsBootstrapped: bootstrap.changed === true,
            upstreamKeyAutoDiscovered: bootstrap.discoveredUpstreamApiKey === true
          }
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/codex-cli/global-route") {
        const body = await readJsonBody(req);
        const enabled = body?.enabled !== false;

        if (!enabled) {
          const unpatchResult = await unpatchCodexCliConfigFile({
            env: codexCliEnv
          });
          addLog("info", "Codex CLI routing disabled.");
          const snapshot = await broadcastState();
          sendJson(res, 200, {
            ...snapshot,
            message: "Codex CLI now routes directly.",
            codingTools: {
              ...(snapshot.codingTools || {}),
              codexCli: {
                ...(snapshot.codingTools?.codexCli || {}),
                unpatchResult
              }
            }
          });
          return;
        }

        let parsed;
        try {
          if (body?.config && typeof body.config === "object" && !Array.isArray(body.config)) {
            parsed = body.config;
          } else {
            const rawText = String(body?.rawText || "");
            parsed = rawText.trim() ? JSON.parse(rawText) : {};
          }
        } catch (error) {
          sendJson(res, 400, {
            error: `Config JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
          });
          return;
        }

        const nextConfig = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        const endpointUrl = String(body?.endpointUrl || buildAmpClientEndpointUrl(getConfigLocalServer({
          normalizedConfig: nextConfig,
          parseError: ""
        }))).trim();
        const apiKey = String(body?.apiKey || nextConfig?.masterKey || "").trim();
        if (!endpointUrl || !apiKey) {
          sendJson(res, 400, { error: "Codex CLI routing needs a valid local router URL and gateway key." });
          return;
        }

        const bindings = normalizeCodexBindingsInput(body?.bindings, nextConfig);
        const patchResult = await patchCodexCliConfigFile({
          endpointUrl,
          apiKey,
          bindings,
          modelCatalog: buildCodexCliModelCatalog(nextConfig, bindings),
          captureBackup: true,
          env: codexCliEnv
        });
        addLog("success", "Codex CLI routing enabled.", patchResult.baseUrl);
        const snapshot = await broadcastState();
        sendJson(res, 200, {
          ...snapshot,
          message: "Codex CLI now routes via LLM Router.",
          codingTools: {
            ...(snapshot.codingTools || {}),
            codexCli: {
              ...(snapshot.codingTools?.codexCli || {}),
              patchResult
            }
          }
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/codex-cli/model-bindings") {
        const body = await readJsonBody(req);
        const configState = await readConfigState(configPath);
        const configLocalServer = getConfigLocalServer(configState);
        const endpointUrl = buildAmpClientEndpointUrl(configLocalServer);
        const apiKey = String(configState.normalizedConfig?.masterKey || "").trim();
        if (!endpointUrl || !apiKey) {
          sendJson(res, 400, { error: "Codex CLI bindings need a running local router URL and gateway key." });
          return;
        }

        const routingState = await readCodexCliGlobalRoutingState(configLocalServer, configState.normalizedConfig);
        if (routingState.error) {
          sendJson(res, 400, { error: routingState.error });
          return;
        }
        if (!routingState.routedViaRouter) {
          sendJson(res, 400, { error: "Connect Codex CLI to LLM Router before updating model bindings." });
          return;
        }

        const bindings = normalizeCodexBindingsInput(body?.bindings, configState.normalizedConfig);
        const patchResult = await patchCodexCliConfigFile({
          endpointUrl,
          apiKey,
          bindings,
          modelCatalog: buildCodexCliModelCatalog(configState.normalizedConfig, bindings),
          captureBackup: false,
          env: codexCliEnv
        });
        addLog("success", "Codex CLI model binding updated.", formatCodexBindingLabel(patchResult.bindings.defaultModel));
        const snapshot = await broadcastState();
        sendJson(res, 200, {
          ...snapshot,
          message: "Codex CLI model bindings updated."
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/claude-code/global-route") {
        const body = await readJsonBody(req);
        const enabled = body?.enabled !== false;

        if (!enabled) {
          const unpatchResult = await unpatchClaudeCodeSettingsFile({
            env: claudeCodeEnv
          });
          addLog("info", "Claude Code routing disabled.");
          const snapshot = await broadcastState();
          sendJson(res, 200, {
            ...snapshot,
            message: "Claude Code now routes directly.",
            codingTools: {
              ...(snapshot.codingTools || {}),
              claudeCode: {
                ...(snapshot.codingTools?.claudeCode || {}),
                unpatchResult
              }
            }
          });
          return;
        }

        let parsed;
        try {
          if (body?.config && typeof body.config === "object" && !Array.isArray(body.config)) {
            parsed = body.config;
          } else {
            const rawText = String(body?.rawText || "");
            parsed = rawText.trim() ? JSON.parse(rawText) : {};
          }
        } catch (error) {
          sendJson(res, 400, {
            error: `Config JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
          });
          return;
        }

        const nextConfig = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        const endpointUrl = String(body?.endpointUrl || buildAmpClientEndpointUrl(getConfigLocalServer({
          normalizedConfig: nextConfig,
          parseError: ""
        }))).trim();
        const apiKey = String(body?.apiKey || nextConfig?.masterKey || "").trim();
        if (!endpointUrl || !apiKey) {
          sendJson(res, 400, { error: "Claude Code routing needs a valid local router URL and gateway key." });
          return;
        }

        const bindings = normalizeClaudeBindingsInput(body?.bindings, nextConfig);
        const patchResult = await patchClaudeCodeSettingsFile({
          endpointUrl,
          apiKey,
          bindings,
          captureBackup: true,
          env: claudeCodeEnv
        });
        addLog("success", "Claude Code routing enabled.", patchResult.baseUrl);
        const snapshot = await broadcastState();
        sendJson(res, 200, {
          ...snapshot,
          message: "Claude Code now routes via LLM Router.",
          codingTools: {
            ...(snapshot.codingTools || {}),
            claudeCode: {
              ...(snapshot.codingTools?.claudeCode || {}),
              patchResult
            }
          }
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/claude-code/model-bindings") {
        const body = await readJsonBody(req);
        const configState = await readConfigState(configPath);
        const configLocalServer = getConfigLocalServer(configState);
        const endpointUrl = buildAmpClientEndpointUrl(configLocalServer);
        const apiKey = String(configState.normalizedConfig?.masterKey || "").trim();
        if (!endpointUrl || !apiKey) {
          sendJson(res, 400, { error: "Claude Code bindings need a running local router URL and gateway key." });
          return;
        }

        const routingState = await readClaudeCodeGlobalRoutingState(configLocalServer, configState.normalizedConfig);
        if (routingState.error) {
          sendJson(res, 400, { error: routingState.error });
          return;
        }
        if (!routingState.routedViaRouter) {
          sendJson(res, 400, { error: "Connect Claude Code to LLM Router before updating model bindings." });
          return;
        }

        const patchResult = await patchClaudeCodeSettingsFile({
          endpointUrl,
          apiKey,
          bindings: normalizeClaudeBindingsInput(body?.bindings, configState.normalizedConfig),
          captureBackup: false,
          env: claudeCodeEnv
        });
        addLog("success", "Claude Code model bindings updated.", patchResult.bindings.primaryModel || "Default");
        const snapshot = await broadcastState();
        sendJson(res, 200, {
          ...snapshot,
          message: "Claude Code model bindings updated."
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/claude-code/effort-level") {
        const body = await readJsonBody(req);
        const effortLevel = String(body?.effortLevel || body?.thinkingLevel || "").trim();
        if (effortLevel && !normalizeClaudeCodeEffortLevel(effortLevel)) {
          sendJson(res, 400, { error: `Invalid effort level '${effortLevel}'. Valid values: low, medium, high, max.` });
          return;
        }
        const result = await patchClaudeCodeEffortLevel({
          effortLevel,
          env: claudeCodeEnv
        });
        addLog("success", result.effortLevel ? `Claude Code effort level set to ${result.effortLevel}.` : "Claude Code effort level cleared.");
        const snapshot = await broadcastState();
        sendJson(res, 200, {
          ...snapshot,
          message: result.effortLevel ? `Effort level set to ${result.effortLevel}.` : "Effort level cleared."
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/factory-droid/global-route") {
        const body = await readJsonBody(req);
        const enabled = body?.enabled !== false;
        if (!enabled) {
          const unpatchResult = await unpatchFactoryDroidSettingsFile({});
          addLog("info", "Factory Droid routing disabled.");
          const snapshot = await broadcastState();
          sendJson(res, 200, {
            ...snapshot,
            message: "Factory Droid now routes directly.",
            codingTools: {
              ...(snapshot.codingTools || {}),
              factoryDroid: {
                ...(snapshot.codingTools?.factoryDroid || {}),
                unpatchResult
              }
            }
          });
          return;
        }

        let parsed;
        try {
          if (body?.config && typeof body.config === "object" && !Array.isArray(body.config)) {
            parsed = body.config;
          } else {
            const rawText = String(body?.rawText || "");
            parsed = rawText.trim() ? JSON.parse(rawText) : {};
          }
        } catch (error) {
          sendJson(res, 400, {
            error: `Config JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
          });
          return;
        }

        const nextConfig = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        const endpointUrl = String(body?.endpointUrl || buildAmpClientEndpointUrl(getConfigLocalServer({
          normalizedConfig: nextConfig,
          parseError: ""
        }))).trim();
        const apiKey = String(body?.apiKey || nextConfig?.masterKey || "").trim();
        if (!endpointUrl || !apiKey) {
          sendJson(res, 400, { error: "Factory Droid routing needs a valid local router URL and gateway key." });
          return;
        }

        const bindings = {
          defaultModel: String(body?.bindings?.defaultModel || "").trim(),
          reasoningEffort: normalizeFactoryDroidReasoningEffort(body?.bindings?.reasoningEffort)
        };
        const patchResult = await patchFactoryDroidSettingsFile({
          endpointUrl,
          apiKey,
          bindings,
          captureBackup: true
        });
        addLog("success", "Factory Droid routing enabled.", patchResult.baseUrl);
        const snapshot = await broadcastState();
        sendJson(res, 200, {
          ...snapshot,
          message: "Factory Droid now routes via LLM Router.",
          codingTools: {
            ...(snapshot.codingTools || {}),
            factoryDroid: {
              ...(snapshot.codingTools?.factoryDroid || {}),
              patchResult
            }
          }
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/factory-droid/model-bindings") {
        const body = await readJsonBody(req);
        const configState = await readConfigState(configPath);
        const configLocalServer = getConfigLocalServer(configState);
        const endpointUrl = buildAmpClientEndpointUrl(configLocalServer);
        const apiKey = String(configState.normalizedConfig?.masterKey || "").trim();
        if (!endpointUrl || !apiKey) {
          sendJson(res, 400, { error: "Factory Droid bindings need a running local router URL and gateway key." });
          return;
        }

        const routingState = await readFactoryDroidGlobalRoutingState(configLocalServer, configState.normalizedConfig);
        if (routingState.error) {
          sendJson(res, 400, { error: routingState.error });
          return;
        }
        if (!routingState.routedViaRouter) {
          sendJson(res, 400, { error: "Connect Factory Droid to LLM Router before updating model bindings." });
          return;
        }

        const bindings = {
          defaultModel: String(body?.bindings?.defaultModel || "").trim(),
          reasoningEffort: normalizeFactoryDroidReasoningEffort(body?.bindings?.reasoningEffort)
        };
        const patchResult = await patchFactoryDroidSettingsFile({
          endpointUrl,
          apiKey,
          bindings,
          captureBackup: false
        });
        addLog("success", "Factory Droid model bindings updated.", patchResult.bindings.defaultModel || "Default");
        const snapshot = await broadcastState();
        sendJson(res, 200, {
          ...snapshot,
          message: "Factory Droid model bindings updated."
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/config/open") {
        const body = await readJsonBody(req);
        const editorId = String(body?.editorId || "default").trim() || "default";
        await openConfigInEditorFn(editorId, configPath);
        addLog("info", `Opened config file in ${editorId}.`);
        sendJson(res, 200, { ok: true, editorId });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/file/open") {
        const body = await readJsonBody(req);
        const editorId = String(body?.editorId || "default").trim() || "default";
        const rawFilePath = String(body?.filePath || "").trim();
        const ensureMode = String(body?.ensureMode || "none").trim() || "none";
        if (!rawFilePath) {
          sendJson(res, 400, { error: "A file path is required." });
          return;
        }
        if (!["none", "text", "jsonObject"].includes(ensureMode)) {
          sendJson(res, 400, { error: "Unsupported file ensure mode." });
          return;
        }

        const filePath = path.resolve(rawFilePath);
        if (ensureMode === "jsonObject") {
          await ensureJsonObjectFileExists(filePath, {});
        } else if (ensureMode === "text") {
          await ensureTextFileExists(filePath, "");
        } else {
          try {
            await fs.access(filePath);
          } catch (error) {
            if (error && typeof error === "object" && error.code === "ENOENT") {
              const missingFileError = new Error(`File does not exist yet: ${filePath}`);
              missingFileError.statusCode = 404;
              throw missingFileError;
            }
            throw error;
          }
        }

        await openFileInEditorFn(editorId, filePath);
        addLog("info", `Opened file in ${editorId}.`, filePath);
        sendJson(res, 200, {
          ok: true,
          editorId,
          filePath,
          ensureMode
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/amp/config/open") {
        const body = await readJsonBody(req);
        const editorId = String(body?.editorId || "default").trim() || "default";
        const settingsTarget = await resolvePreferredAmpSettingsTarget();
        const secretsFilePath = resolveAmpClientSecretsFilePath({
          env: ampClientEnv
        });
        await ensureJsonObjectFileExists(settingsTarget.settingsFilePath, {});
        await ensureJsonObjectFileExists(secretsFilePath, {});
        await openFileInEditorFn(editorId, settingsTarget.settingsFilePath);
        addLog("info", `Opened AMP config file in ${editorId}.`, settingsTarget.settingsFilePath);
        sendJson(res, 200, {
          ok: true,
          editorId,
          filePath: settingsTarget.settingsFilePath,
          secretsFilePath,
          scope: settingsTarget.scope
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/codex-cli/config/open") {
        const body = await readJsonBody(req);
        const editorId = String(body?.editorId || "default").trim() || "default";
        const ensured = await ensureCodexCliConfigFileExists({
          env: codexCliEnv
        });
        await openFileInEditorFn(editorId, ensured.configFilePath);
        addLog("info", `Opened Codex CLI config file in ${editorId}.`, ensured.configFilePath);
        sendJson(res, 200, {
          ok: true,
          editorId,
          filePath: ensured.configFilePath,
          backupFilePath: ensured.backupFilePath
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/claude-code/config/open") {
        const body = await readJsonBody(req);
        const editorId = String(body?.editorId || "default").trim() || "default";
        const ensured = await ensureClaudeCodeSettingsFileExists({
          env: claudeCodeEnv
        });
        await openFileInEditorFn(editorId, ensured.settingsFilePath);
        addLog("info", `Opened Claude Code config file in ${editorId}.`, ensured.settingsFilePath);
        sendJson(res, 200, {
          ok: true,
          editorId,
          filePath: ensured.settingsFilePath,
          backupFilePath: ensured.backupFilePath
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/factory-droid/config/open") {
        const body = await readJsonBody(req);
        const editorId = String(body?.editorId || "default").trim() || "default";
        const ensured = await ensureFactoryDroidSettingsFileExists({});
        await openFileInEditorFn(editorId, ensured.settingsFilePath);
        addLog("info", `Opened Factory Droid config file in ${editorId}.`, ensured.settingsFilePath);
        sendJson(res, 200, {
          ok: true,
          editorId,
          filePath: ensured.settingsFilePath,
          backupFilePath: ensured.backupFilePath
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/router/start") {
        const body = await readJsonBody(req);
        const { message, snapshot } = await startManagedRouter(body);
        await broadcastState();
        sendJson(res, 200, { ...snapshot, message });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/router/restart") {
        const body = await readJsonBody(req);
        const { message, snapshot } = await startManagedRouter(body, { restart: true });
        await broadcastState();
        sendJson(res, 200, { ...snapshot, message });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/router/stop") {
        const body = await readJsonBody(req);
        const configState = await readConfigState(configPath);
        const stopSettings = resolveRouterOptions(getConfigLocalServer(configState), body);
        await stopManagedRouter({
          settings: stopSettings,
          reclaimPortIfStopped: body?.reclaimPort === true
        });
        const snapshot = await broadcastState();
        sendJson(res, 200, { ...snapshot, message: "Router stopped." });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/router/reclaim") {
        const body = await readJsonBody(req);
        const configState = await readConfigState(configPath);
        const reclaimSettings = resolveRouterOptions(getConfigLocalServer(configState), body);
        const reclaimed = await reclaimRouterPortIfNeeded(reclaimSettings, {
          reason: "Reclaiming router port from the web console."
        });
        if (!reclaimed.ok) {
          const reclaimError = new Error(reclaimed.errorMessage || `Failed reclaiming port ${reclaimSettings.port}.`);
          reclaimError.statusCode = 409;
          throw reclaimError;
        }
        const snapshot = await broadcastState();
        sendJson(res, 200, {
          ...snapshot,
          message: reclaimed.attempted
            ? `Port ${reclaimSettings.port} reclaimed.`
            : `Port ${reclaimSettings.port} is already free.`
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/startup/enable") {
        const body = await readJsonBody(req);
        const configState = await readConfigState(configPath);
        if (configState.parseError) {
          sendJson(res, 400, { error: `Config JSON must parse before enabling startup: ${configState.parseError}` });
          return;
        }
        if (!configHasProvider(configState.normalizedConfig)) {
          sendJson(res, 400, { error: "At least one enabled provider is required before enabling startup." });
          return;
        }

        const externalRuntime = await readExternalRuntime();
        if (externalRuntime) {
          await stopExternalRuntime(externalRuntime, {
            reason: "Stopped another LLM Router instance before enabling startup."
          });
        }

        let startupOptions = resolveRouterOptions(getConfigLocalServer(configState), body);
        if (startupOptions.requireAuth && !configState.normalizedConfig.masterKey) {
          sendJson(res, 400, { error: "masterKey is required when enabling startup with auth." });
          return;
        }

        const persisted = await persistLocalServerConfig(startupOptions);
        startupOptions = persisted.savedSettings;

        const activeRuntime = await readActiveRuntime();
        if (activeRuntime) {
          await stopManagedRouter({ reason: "Stopped managed router before enabling startup." });
        }

        const webConsoleConflict = getWebConsoleConflictMessage(startupOptions);
        if (webConsoleConflict) {
          const conflictError = new Error(webConsoleConflict);
          conflictError.statusCode = 409;
          throw conflictError;
        }

        const detail = await installStartupFn({
          configPath,
          host: startupOptions.host,
          port: startupOptions.port,
          watchConfig: startupOptions.watchConfig,
          watchBinary: startupOptions.watchBinary,
          requireAuth: startupOptions.requireAuth,
          cliPath: resolvedRouterCliPath
        });
        await syncAmpGlobalRoutingIfNeeded({
          previousConfig: persisted.previousConfig,
          nextConfig: persisted.savedConfig,
          previousSettings: persisted.previousSettings,
          nextSettings: persisted.savedSettings
        });
        syncRouterDefaults(startupOptions);
        addLog("success", "Startup enabled.", formatStartupDetail({ ...detail, manager: detail.manager || "startup", installed: true, running: true }));
        const snapshot = await broadcastState();
        sendJson(res, 200, { ...snapshot, message: "Startup enabled." });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/startup/disable") {
        await readJsonBody(req);
        const statusBefore = await startupStatusFn().catch(() => null);
        if (!statusBefore?.installed) {
          addLog("info", "Startup already disabled.");
          const snapshot = await broadcastState();
          sendJson(res, 200, { ...snapshot, message: "Startup already disabled." });
          return;
        }

        try {
          await uninstallStartupFn();
        } catch (startupError) {
          const message = startupError instanceof Error ? startupError.message : String(startupError);
          if (!isMissingStartupServiceText(message)) {
            throw startupError;
          }
        }

        addLog("info", "Startup disabled.", formatStartupDetail({ ...statusBefore, installed: false, running: false }));
        const snapshot = await broadcastState();
        sendJson(res, 200, { ...snapshot, message: "Startup disabled." });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/subscription/login") {
        const body = await readJsonBody(req);
        const requestedProfileId = String(body?.profileId || "").trim();
        const fallbackProfileId = String(body?.providerId || "default").trim() || "default";
        const profileId = requestedProfileId || fallbackProfileId;
        const subscriptionType = String(body?.subscriptionType || "").trim();

        if (!["chatgpt-codex", "claude-code"].includes(subscriptionType)) {
          sendJson(res, 400, { error: "Unsupported subscription type." });
          return;
        }

        let authUrl = "";
        let openedBrowser = false;
        addLog("info", `Opening ${subscriptionType} sign-in for profile '${profileId}'…`);
        await loginSubscriptionFn(profileId, {
          subscriptionType,
          onUrl: (url, meta = {}) => {
            authUrl = String(url || "");
            openedBrowser = meta?.openedBrowser === true;
            addLog(
              openedBrowser ? "info" : "warn",
              openedBrowser
                ? `Opened browser sign-in for profile '${profileId}'.`
                : `Open the sign-in page manually for profile '${profileId}'.`,
              authUrl
            );
          }
        });

        addLog("success", `Subscription login completed for profile '${profileId}'.`);
        const snapshot = await broadcastState();
        sendJson(res, 200, {
          ...snapshot,
          ok: true,
          authUrl,
          openedBrowser,
          message: "Subscription login completed."
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/provider/probe") {
        const body = await readJsonBody(req);
        const providerId = String(body?.providerId || "").trim();
        const configState = await readConfigState(configPath);
        if (configState.parseError) {
          sendJson(res, 400, { error: `Config JSON must parse before probing providers: ${configState.parseError}` });
          return;
        }
        const provider = (configState.normalizedConfig?.providers || []).find((entry) => entry.id === providerId);
        if (!provider) {
          sendJson(res, 404, { error: `Provider '${providerId}' was not found.` });
          return;
        }
        const apiKey = resolveProviderApiKey(provider, process.env);
        if (!apiKey) {
          sendJson(res, 400, { error: `Provider '${providerId}' does not have an API key configured for probing.` });
          return;
        }
        if (!provider.baseUrl && !provider.baseUrlByFormat) {
          sendJson(res, 400, { error: `Provider '${providerId}' does not have a probeable endpoint configured.` });
          return;
        }

        addLog("info", `Probing provider ${providerId}…`);
        const result = await probeProvider({
          baseUrl: provider.baseUrl,
          baseUrlByFormat: provider.baseUrlByFormat,
          apiKey,
          headers: provider.headers,
          timeoutMs: 8000
        });
        addLog(result.ok ? "success" : "warn", `Probe finished for ${providerId}.`, result.workingFormats?.join(", ") || "No working formats detected.");
        sendJson(res, 200, { result });
        return;
      }

      // ── Ollama API routes ──────────────────────────────────────────────
      function resolveOllamaBaseUrl(bodyBaseUrl, configBaseUrl) {
        const raw = String(bodyBaseUrl || configBaseUrl || "http://localhost:11434").trim().replace(/\/+$/, "");
        try { const u = new URL(raw); if (u.protocol !== "http:" && u.protocol !== "https:") return null; if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1" && u.hostname !== "::1" && !u.hostname.endsWith(".local")) return null; return u.origin; } catch { return null; }
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/status") {
        const body = await readJsonBody(req);
        const configState = await readConfigState(configPath);
        const ollamaConfig = configState.normalizedConfig?.ollama || {};
        const baseUrl = resolveOllamaBaseUrl(body?.baseUrl, ollamaConfig.baseUrl);
        if (!baseUrl) { sendJson(res, 400, { error: "Invalid Ollama base URL" }); return; }
        const installation = detectOllamaInstallation();
        const connection = installation.installed
          ? await ollamaCheckConnection(baseUrl)
          : { ok: false, error: "Ollama not installed" };
        const running = connection.ok ? await ollamaListRunning(baseUrl) : { ok: false, models: [] };
        sendJson(res, 200, {
          installed: installation.installed,
          version: installation.version,
          path: installation.path,
          connected: connection.ok,
          running: running.models || [],
          baseUrl
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/models") {
        const body = await readJsonBody(req);
        const configState = await readConfigState(configPath);
        const ollamaConfig = configState.normalizedConfig?.ollama || {};
        const baseUrl = resolveOllamaBaseUrl(body?.baseUrl, ollamaConfig.baseUrl);
        if (!baseUrl) { sendJson(res, 400, { error: "Invalid Ollama base URL" }); return; }
        const modelsResult = await ollamaListModels(baseUrl);
        if (!modelsResult.ok) {
          sendJson(res, 502, { error: modelsResult.error || "Failed to list Ollama models" });
          return;
        }
        const runningResult = await ollamaListRunning(baseUrl);
        const runningMap = new Map((runningResult.models || []).map((m) => [m.name, m]));
        const ollamaProvider = (configState.normalizedConfig?.providers || []).find((p) => p.type === OLLAMA_PROVIDER_TYPE);
        const routedModelIds = new Set((ollamaProvider?.models || []).map((m) => m.id));
        const enriched = modelsResult.models.map((model) => {
          const running = runningMap.get(model.name);
          const managed = ollamaConfig.managedModels?.[model.name];
          const hwEstimate = model.contextLength && model.parameterSize
            ? estimateModelVram(model.parameterSize, model.quantizationLevel, model.contextLength)
            : null;
          return {
            ...model,
            loaded: !!running,
            sizeVram: running?.sizeVram || 0,
            sizeVramFormatted: running?.sizeVram ? formatBytes(running.sizeVram) : "",
            expiresAt: running?.expiresAt || "",
            isPinned: running?.isPinned || managed?.pinned || false,
            processor: running?.processor || "",
            keepAlive: managed?.keepAlive || ollamaConfig.defaultKeepAlive || "5m",
            autoLoad: managed?.autoLoad || false,
            inRouter: routedModelIds.has(model.name),
            estimatedVram: hwEstimate ? formatBytes(hwEstimate.totalBytes) : "",
            estimatedVramBytes: hwEstimate?.totalBytes || 0
          };
        });
        sendJson(res, 200, { models: enriched });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/load") {
        const body = await readJsonBody(req);
        const model = String(body?.model || "").trim();
        if (!model) { sendJson(res, 400, { error: "model is required" }); return; }
        const configState = await readConfigState(configPath);
        const ollamaConfig = configState.normalizedConfig?.ollama || {};
        const baseUrl = resolveOllamaBaseUrl(body?.baseUrl, ollamaConfig.baseUrl);
        if (!baseUrl) { sendJson(res, 400, { error: "Invalid Ollama base URL" }); return; }
        const keepAlive = body?.keepAlive || ollamaConfig.managedModels?.[model]?.keepAlive || ollamaConfig.defaultKeepAlive || "5m";
        addLog("info", `Ollama: Loading ${model}…`);
        const result = await ollamaLoadModel(baseUrl, model, keepAlive);
        if (result.ok) addLog("success", `Ollama: Loaded ${model} (${Math.round(result.loadDurationMs || 0)}ms).`);
        else addLog("warn", `Ollama: Failed to load ${model}.`, result.error || "");
        sendJson(res, result.ok ? 200 : 502, result);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/unload") {
        const body = await readJsonBody(req);
        const model = String(body?.model || "").trim();
        if (!model) { sendJson(res, 400, { error: "model is required" }); return; }
        const configState = await readConfigState(configPath);
        const ollamaConfig = configState.normalizedConfig?.ollama || {};
        const baseUrl = resolveOllamaBaseUrl(body?.baseUrl, ollamaConfig.baseUrl);
        if (!baseUrl) { sendJson(res, 400, { error: "Invalid Ollama base URL" }); return; }
        addLog("info", `Ollama: Unloading ${model}…`);
        const result = await ollamaUnloadModel(baseUrl, model);
        if (result.ok) addLog("success", `Ollama: Unloaded ${model}.`);
        sendJson(res, result.ok ? 200 : 502, result);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/pin") {
        const body = await readJsonBody(req);
        const model = String(body?.model || "").trim();
        if (!model) { sendJson(res, 400, { error: "model is required" }); return; }
        const pinned = body?.pinned === true;
        const configState = await readConfigState(configPath);
        const rawConfig = configState.rawConfig || {};
        const ollamaConfig = configState.normalizedConfig?.ollama || {};
        const baseUrl = resolveOllamaBaseUrl(body?.baseUrl, ollamaConfig.baseUrl);
        if (!baseUrl) { sendJson(res, 400, { error: "Invalid Ollama base URL" }); return; }
        const pinResult = pinned
          ? await ollamaPinModel(baseUrl, model)
          : await ollamaSetKeepAlive(baseUrl, model, ollamaConfig.managedModels?.[model]?.keepAlive || ollamaConfig.defaultKeepAlive || "5m");
        if (!pinResult.ok) { sendJson(res, 502, { error: pinResult.error || "Failed to update model pin state" }); return; }
        const nextOllama = { ...(rawConfig.ollama || {}), managedModels: { ...(rawConfig.ollama?.managedModels || {}) } };
        nextOllama.managedModels[model] = { ...(nextOllama.managedModels[model] || {}), pinned };
        await writeAndBroadcastConfig({ ...rawConfig, ollama: nextOllama }, { source: "ollama-pin" });
        sendJson(res, 200, { ok: true, pinned });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/keep-alive") {
        const body = await readJsonBody(req);
        const model = String(body?.model || "").trim();
        const keepAlive = String(body?.keepAlive || "").trim();
        if (!model) { sendJson(res, 400, { error: "model is required" }); return; }
        if (!OLLAMA_KEEP_ALIVE_PATTERN.test(keepAlive)) { sendJson(res, 400, { error: "Invalid keep_alive value" }); return; }
        const configState = await readConfigState(configPath);
        const rawConfig = configState.rawConfig || {};
        const ollamaConfig = configState.normalizedConfig?.ollama || {};
        const baseUrl = resolveOllamaBaseUrl(body?.baseUrl, ollamaConfig.baseUrl);
        if (!baseUrl) { sendJson(res, 400, { error: "Invalid Ollama base URL" }); return; }
        const kaResult = await ollamaSetKeepAlive(baseUrl, model, keepAlive);
        if (!kaResult.ok) { sendJson(res, 502, { error: kaResult.error || "Failed to update keep-alive" }); return; }
        const nextOllama = { ...(rawConfig.ollama || {}), managedModels: { ...(rawConfig.ollama?.managedModels || {}) } };
        nextOllama.managedModels[model] = { ...(nextOllama.managedModels[model] || {}), keepAlive };
        await writeAndBroadcastConfig({ ...rawConfig, ollama: nextOllama }, { source: "ollama-keep-alive" });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/sync-router") {
        const body = await readJsonBody(req);
        const configState = await readConfigState(configPath);
        const rawConfig = configState.rawConfig || {};
        const ollamaConfig = configState.normalizedConfig?.ollama || {};
        const baseUrl = resolveOllamaBaseUrl(body?.baseUrl, ollamaConfig.baseUrl);
        if (!baseUrl) { sendJson(res, 400, { error: "Invalid Ollama base URL" }); return; }
        const modelsResult = await ollamaListModels(baseUrl);
        if (!modelsResult.ok) { sendJson(res, 502, { error: modelsResult.error || "Failed to list Ollama models" }); return; }
        const modelIds = modelsResult.models.map((m) => m.name);
        const providers = [...(rawConfig.providers || [])];
        let ollamaProvider = providers.find((p) => p.type === OLLAMA_PROVIDER_TYPE);
        const previousModelIds = new Set((ollamaProvider?.models || []).map((m) => typeof m === "string" ? m : m?.id));
        if (!ollamaProvider) {
          ollamaProvider = { id: "ollama", name: "Ollama", type: OLLAMA_PROVIDER_TYPE, baseUrl: baseUrl + "/v1", models: [] };
          providers.push(ollamaProvider);
        }
        ollamaProvider.baseUrl = baseUrl + "/v1";
        ollamaProvider.models = modelIds.map((id) => {
          const existing = (ollamaProvider.models || []).find((m) => (typeof m === "string" ? m : m?.id) === id);
          if (existing && typeof existing === "object") return existing;
          const details = modelsResult.models.find((m) => m.name === id);
          return { id, contextWindow: details?.contextLength || undefined };
        });
        const nextConfig = { ...rawConfig, providers };
        const { snapshot } = await writeAndBroadcastConfig(nextConfig, { source: "ollama-sync" });
        const addedCount = modelIds.filter((id) => !previousModelIds.has(id)).length;
        const removedCount = [...previousModelIds].filter((id) => !modelIds.includes(id)).length;
        addLog("info", `Ollama: Synced ${modelIds.length} models (${addedCount} added, ${removedCount} removed).`);
        sendJson(res, 200, { ok: true, modelCount: modelIds.length, addedCount, removedCount });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/add-model") {
        const body = await readJsonBody(req);
        const model = String(body?.model || "").trim();
        if (!model) { sendJson(res, 400, { error: "model is required" }); return; }
        const configState = await readConfigState(configPath);
        const rawConfig = configState.rawConfig || {};
        const ollamaConfig = configState.normalizedConfig?.ollama || {};
        const baseUrl = (ollamaConfig.baseUrl || "http://localhost:11434").replace(/\/+$/, "");
        const providers = [...(rawConfig.providers || [])];
        let ollamaProvider = providers.find((p) => p.type === OLLAMA_PROVIDER_TYPE);
        if (!ollamaProvider) {
          ollamaProvider = { id: "ollama", name: "Ollama", type: OLLAMA_PROVIDER_TYPE, baseUrl: baseUrl + "/v1", models: [] };
          providers.push(ollamaProvider);
        }
        const existing = (ollamaProvider.models || []).find((m) => (typeof m === "string" ? m : m?.id) === model);
        if (existing) { sendJson(res, 200, { ok: true, added: false, reason: "already exists" }); return; }
        const contextLength = body?.contextLength || undefined;
        ollamaProvider.models = [...(ollamaProvider.models || []), { id: model, ...(contextLength ? { contextWindow: contextLength } : {}) }];
        await writeAndBroadcastConfig({ ...rawConfig, providers }, { source: "ollama-add-model" });
        addLog("info", `Ollama: Added ${model} to router.`);
        sendJson(res, 200, { ok: true, added: true });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/remove-model") {
        const body = await readJsonBody(req);
        const model = String(body?.model || "").trim();
        if (!model) { sendJson(res, 400, { error: "model is required" }); return; }
        const configState = await readConfigState(configPath);
        const rawConfig = configState.rawConfig || {};
        const providers = [...(rawConfig.providers || [])];
        const ollamaProvider = providers.find((p) => p.type === OLLAMA_PROVIDER_TYPE);
        if (!ollamaProvider) { sendJson(res, 200, { ok: true, removed: false }); return; }
        const before = (ollamaProvider.models || []).length;
        ollamaProvider.models = (ollamaProvider.models || []).filter((m) => (typeof m === "string" ? m : m?.id) !== model);
        const removed = ollamaProvider.models.length < before;
        if (removed) {
          await writeAndBroadcastConfig({ ...rawConfig, providers }, { source: "ollama-remove-model" });
          addLog("info", `Ollama: Removed ${model} from router.`);
        }
        sendJson(res, 200, { ok: true, removed });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/save-settings") {
        const body = await readJsonBody(req);
        const configState = await readConfigState(configPath);
        const rawConfig = configState.rawConfig || {};
        const nextOllama = { ...(rawConfig.ollama || {}) };
        if (body?.baseUrl !== undefined) nextOllama.baseUrl = String(body.baseUrl).trim();
        if (body?.enabled !== undefined) nextOllama.enabled = body.enabled !== false;
        if (body?.autoConnect !== undefined) nextOllama.autoConnect = body.autoConnect !== false;
        if (body?.defaultKeepAlive !== undefined && OLLAMA_KEEP_ALIVE_PATTERN.test(String(body.defaultKeepAlive))) {
          nextOllama.defaultKeepAlive = String(body.defaultKeepAlive);
        }
        await writeAndBroadcastConfig({ ...rawConfig, ollama: nextOllama }, { source: "ollama-settings" });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/auto-load") {
        const body = await readJsonBody(req);
        const model = String(body?.model || "").trim();
        const autoLoad = body?.autoLoad === true;
        if (!model) { sendJson(res, 400, { error: "model is required" }); return; }
        const configState = await readConfigState(configPath);
        const rawConfig = configState.rawConfig || {};
        const nextOllama = { ...(rawConfig.ollama || {}), managedModels: { ...(rawConfig.ollama?.managedModels || {}) } };
        nextOllama.managedModels[model] = { ...(nextOllama.managedModels[model] || {}), autoLoad };
        const autoLoadModels = Object.entries(nextOllama.managedModels)
          .filter(([, v]) => v?.autoLoad).map(([k]) => k);
        nextOllama.autoLoadModels = autoLoadModels;
        await writeAndBroadcastConfig({ ...rawConfig, ollama: nextOllama }, { source: "ollama-auto-load" });
        sendJson(res, 200, { ok: true, autoLoad });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/install") {
        const installation = detectOllamaInstallation();
        if (installation.installed) {
          sendJson(res, 200, { ok: true, alreadyInstalled: true, version: installation.version });
          return;
        }
        addLog("info", "Ollama: Starting installation…");
        const result = await installOllama({
          onProgress: (event) => pushEvent("ollama-install-progress", event)
        });
        if (result.ok && !result.alreadyInstalled) {
          addLog("success", `Ollama: Installed (${result.version || "unknown"}).`);
          const started = await startOllamaServer();
          sendJson(res, 200, { ...result, serverStarted: started.ok });
          broadcastState();
        } else if (result.ok) {
          sendJson(res, 200, result);
        } else {
          addLog("error", "Ollama: Installation failed.", result.error || "");
          sendJson(res, 500, result);
        }
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/start-server") {
        const result = await startOllamaServer();
        if (result.ok) addLog("success", "Ollama: Server started.");
        else addLog("warn", "Ollama: Failed to start server.", result.error || "");
        sendJson(res, result.ok ? 200 : 502, result);
        broadcastState();
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/stop-server") {
        const result = stopOllamaServer();
        if (result.ok) addLog("info", "Ollama: Server stopped.");
        sendJson(res, 200, result);
        broadcastState();
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/ollama/context-length") {
        const body = await readJsonBody(req);
        const model = String(body?.model || "").trim();
        const contextLength = Number(body?.contextLength);
        if (!model) { sendJson(res, 400, { error: "model is required" }); return; }
        if (!Number.isFinite(contextLength) || contextLength <= 0) { sendJson(res, 400, { error: "contextLength must be a positive number" }); return; }
        const configState = await readConfigState(configPath);
        const rawConfig = configState.rawConfig || {};
        const nextOllama = { ...(rawConfig.ollama || {}), managedModels: { ...(rawConfig.ollama?.managedModels || {}) } };
        nextOllama.managedModels[model] = { ...(nextOllama.managedModels[model] || {}), contextLength: Math.round(contextLength) };
        // Also update the provider model entry contextWindow
        const providers = [...(rawConfig.providers || [])];
        const ollamaProvider = providers.find((p) => p.type === OLLAMA_PROVIDER_TYPE);
        if (ollamaProvider) {
          ollamaProvider.models = (ollamaProvider.models || []).map((m) => {
            const mid = typeof m === "string" ? m : m?.id;
            if (mid === model) return { ...(typeof m === "object" ? m : { id: m }), contextWindow: Math.round(contextLength) };
            return m;
          });
        }
        await writeAndBroadcastConfig({ ...rawConfig, ollama: nextOllama, providers }, { source: "ollama-context-length" });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/exit") {
        sendJson(res, 200, { ok: true, message: "Closing web console." });
        setTimeout(() => {
          void shutdown("user-exit");
        }, 25);
        return;
      }

      sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      sendJson(res, statusCode, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise((resolve, reject) => {
    webServer.once("error", reject);
    webServer.listen(port, host, () => {
      webServer.off("error", reject);
      const address = webServer.address();
      if (typeof address === "object" && address) {
        actualWebPort = Number(address.port);
      }
      resolve();
    });
  });

  addLog("info", `Web console listening on http://${formatHostForUrl(host, actualWebPort)}`);
  if (devMode) addLog("info", "Development mode enabled for web assets.");
  startConfigWatcher();
  startActivityLogWatcher();

  try {
    await reconcileManagedRouterWithConfig({ reason: "web-console-startup" });
  } catch (reconcileError) {
    addLog("warn", "Managed router auto-start skipped.", reconcileError instanceof Error ? reconcileError.message : String(reconcileError));
  }

  return {
    host,
    port: actualWebPort,
    url: `http://${formatHostForUrl(host, actualWebPort)}`,
    done,
    close: (reason) => shutdown(reason),
    getSnapshot: buildSnapshot,
    startRouter: (body) => startManagedRouter(body),
    restartRouter: (body) => startManagedRouter(body, { restart: true }),
    stopRouter: (reason) => stopManagedRouter(typeof reason === "string" ? { reason } : reason)
  };
}
