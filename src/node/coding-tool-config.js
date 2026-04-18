import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  CODEX_CLI_INHERIT_MODEL_VALUE,
  CLAUDE_CODE_EFFORT_LEVEL_SETTINGS_JSON_VALUE,
  buildFactoryDroidRouterDisplayName,
  buildFactoryDroidRouterModelId,
  isCodexCliInheritModelBinding,
  isFactoryDroidRouterModelId,
  mapClaudeCodeThinkingLevelToTokens,
  mapClaudeCodeThinkingTokensToLevel,
  normalizeClaudeCodeThinkingLevel,
  normalizeClaudeCodeEffortLevel,
  migrateLegacyThinkingTokensToEffortLevel,
  normalizeCodexCliReasoningEffort,
  normalizeFactoryDroidReasoningEffort,
  resolveFactoryDroidRouterModelRef
} from "../shared/coding-tool-bindings.js";

const BACKUP_SUFFIX = ".llm_router_backup";
const CODEX_PROVIDER_ID = "llm-router";
const CODEX_MODEL_CATALOG_FILENAME = "llm-router-model-catalog.json";
const CLAUDE_MANAGED_ENV_KEYS = Object.freeze([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL"
]);
const CLAUDE_BACKUP_ENV_KEYS = Object.freeze([
  ...CLAUDE_MANAGED_ENV_KEYS,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_SMALL_FAST_MODEL"
]);

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHttpUrl(value) {
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

  if ([
    "localhost",
    "0.0.0.0",
    "::",
    "[::]",
    "::0",
    "[::0]",
    "::1",
    "[::1]"
  ].includes(parsed.hostname.toLowerCase())) {
    parsed.hostname = "127.0.0.1";
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";

  const out = parsed.toString();
  return parsed.pathname === "/" && out.endsWith("/") ? out.slice(0, -1) : out;
}

function normalizeModelBinding(value) {
  return String(value || "").trim();
}

function areResolvedFilePathsEqual(left, right) {
  const leftText = String(left || "").trim();
  const rightText = String(right || "").trim();
  if (!leftText || !rightText) return false;
  return path.resolve(leftText) === path.resolve(rightText);
}

function backupHasData(backup) {
  return Boolean(backup && typeof backup === "object" && !Array.isArray(backup) && Object.keys(backup).length > 0);
}

async function readTextFile(filePath) {
  try {
    return {
      text: await fs.readFile(filePath, "utf8"),
      existed: true
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        text: "",
        existed: false
      };
    }
    throw error;
  }
}

async function writeTextFile(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, String(text || ""), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

async function readJsonObjectFile(filePath, label) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

function splitLinesPreserveNewline(text = "") {
  const matches = String(text || "").match(/[^\n]*\n|[^\n]+/g);
  return matches ? [...matches] : [];
}

function splitTomlDocument(text = "") {
  const lines = splitLinesPreserveNewline(text);
  const preamble = [];
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\r?\n)?$/);
    if (headerMatch) {
      currentSection = {
        name: String(headerMatch[1] || "").trim(),
        headerLine: line.endsWith("\n") ? line : `${line}\n`,
        lines: []
      };
      sections.push(currentSection);
      continue;
    }

    if (currentSection) currentSection.lines.push(line);
    else preamble.push(line);
  }

  return { preamble, sections };
}

function serializeTomlDocument(document) {
  const parts = [];
  const preambleText = (document?.preamble || []).join("").trimEnd();
  if (preambleText) parts.push(preambleText);

  for (const section of (document?.sections || [])) {
    const headerLine = String(section?.headerLine || `[${String(section?.name || "").trim()}]`).trimEnd();
    const bodyText = (section?.lines || []).join("").trimEnd();
    parts.push(bodyText ? `${headerLine}\n${bodyText}` : headerLine);
  }

  return `${parts.join("\n\n").trimEnd()}\n`;
}

function parseTomlStringValue(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return "";
  if (text.startsWith("\"")) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1);
  }
  return text;
}

function encodeTomlString(value) {
  return JSON.stringify(String(value || ""));
}

function findTopLevelAssignmentIndex(lines, key) {
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  return (lines || []).findIndex((line) => pattern.test(line));
}

function getTopLevelTomlStringField(document, key) {
  const index = findTopLevelAssignmentIndex(document?.preamble || [], key);
  if (index === -1) {
    return { exists: false, value: "" };
  }

  const match = String(document.preamble[index] || "").match(/^\s*[^=]+\s*=\s*(.*?)\s*(?:#.*)?(?:\r?\n)?$/);
  return {
    exists: true,
    value: parseTomlStringValue(match?.[1] || "")
  };
}

function setTopLevelTomlStringField(document, key, value) {
  const lines = [...(document?.preamble || [])];
  const encoded = `${key} = ${encodeTomlString(value)}\n`;
  const index = findTopLevelAssignmentIndex(lines, key);
  if (index >= 0) lines[index] = encoded;
  else lines.push(encoded);
  document.preamble = lines;
}

function deleteTopLevelTomlField(document, key) {
  const lines = [...(document?.preamble || [])];
  const index = findTopLevelAssignmentIndex(lines, key);
  if (index >= 0) lines.splice(index, 1);
  document.preamble = lines;
}

function findTomlSectionIndex(document, name) {
  return (document?.sections || []).findIndex((section) => String(section?.name || "").trim() === String(name || "").trim());
}

function getTomlSection(document, name) {
  const index = findTomlSectionIndex(document, name);
  return index >= 0 ? document.sections[index] : null;
}

function deleteTomlSection(document, name) {
  const index = findTomlSectionIndex(document, name);
  if (index >= 0) document.sections.splice(index, 1);
}

function setTomlSection(document, name, bodyText = "") {
  const normalizedBody = String(bodyText || "").trim();
  const section = {
    name: String(name || "").trim(),
    headerLine: `[${String(name || "").trim()}]\n`,
    lines: normalizedBody ? splitLinesPreserveNewline(`${normalizedBody}\n`) : []
  };
  const index = findTomlSectionIndex(document, name);
  if (index >= 0) document.sections[index] = section;
  else document.sections.push(section);
}

function parseTomlSectionKeyValues(section) {
  const values = {};
  for (const line of section?.lines || []) {
    const match = String(line || "").match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*(?:#.*)?(?:\r?\n)?$/);
    if (!match) continue;
    values[match[1]] = parseTomlStringValue(match[2]);
  }
  return values;
}

function createCodexProviderSection({ baseUrl, apiKey }) {
  return [
    `name = ${encodeTomlString("LLM Router")}`,
    `base_url = ${encodeTomlString(baseUrl)}`,
    `wire_api = ${encodeTomlString("responses")}`,
    `experimental_bearer_token = ${encodeTomlString(apiKey)}`
  ].join("\n");
}

function buildCodexProviderBaseUrl(endpointUrl) {
  const normalized = normalizeHttpUrl(endpointUrl);
  return normalized ? `${normalized}/openai/v1` : "";
}

function buildClaudeCodeBaseUrl(endpointUrl) {
  const normalized = normalizeHttpUrl(endpointUrl);
  return normalized ? `${normalized}/anthropic` : "";
}

function normalizeCodexModelCatalog(modelCatalog) {
  if (!modelCatalog || typeof modelCatalog !== "object" || Array.isArray(modelCatalog)) {
    return null;
  }

  const models = Array.isArray(modelCatalog.models)
    ? modelCatalog.models.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    : [];
  if (models.length === 0) return { models: [] };

  const next = {
    ...modelCatalog,
    models
  };

  if (!next.fetched_at) {
    next.fetched_at = new Date().toISOString();
  }

  return next;
}

function getBackupValue(value) {
  return {
    exists: value !== undefined,
    value: value === undefined ? "" : String(value || "")
  };
}

function applyBackupValue(target, key, snapshot) {
  if (!snapshot?.exists) {
    delete target[key];
    return;
  }
  target[key] = String(snapshot.value || "");
}

function normalizeClaudeBindings(bindings = {}) {
  const source = bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings : {};
  return {
    primaryModel: normalizeModelBinding(source.primaryModel),
    defaultOpusModel: normalizeModelBinding(source.defaultOpusModel),
    defaultSonnetModel: normalizeModelBinding(source.defaultSonnetModel),
    defaultHaikuModel: normalizeModelBinding(source.defaultHaikuModel),
    subagentModel: normalizeModelBinding(source.subagentModel),
    thinkingLevel: normalizeClaudeCodeEffortLevel(source.thinkingLevel)
  };
}

function normalizeCodexBindings(bindings = {}) {
  const source = bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings : {};
  const defaultModel = normalizeModelBinding(source.defaultModel);
  return {
    defaultModel: isCodexCliInheritModelBinding(defaultModel)
      ? CODEX_CLI_INHERIT_MODEL_VALUE
      : defaultModel,
    thinkingLevel: normalizeCodexCliReasoningEffort(source.thinkingLevel)
  };
}

function captureCodexBackup(document) {
  const providerSection = getTomlSection(document, `model_providers.${CODEX_PROVIDER_ID}`);
  return {
    tool: "codex-cli",
    version: 1,
    modelProvider: getTopLevelTomlStringField(document, "model_provider"),
    model: getTopLevelTomlStringField(document, "model"),
    modelReasoningEffort: getTopLevelTomlStringField(document, "model_reasoning_effort"),
    modelCatalogJson: getTopLevelTomlStringField(document, "model_catalog_json"),
    providerSection: {
      exists: Boolean(providerSection),
      body: providerSection ? (providerSection.lines || []).join("").trimEnd() : ""
    }
  };
}

function applyCodexBackup(document, backup = {}) {
  if (backup?.modelProvider?.exists) setTopLevelTomlStringField(document, "model_provider", backup.modelProvider.value);
  else deleteTopLevelTomlField(document, "model_provider");

  if (backup?.model?.exists) setTopLevelTomlStringField(document, "model", backup.model.value);
  else deleteTopLevelTomlField(document, "model");

  if (backup?.modelReasoningEffort?.exists) setTopLevelTomlStringField(document, "model_reasoning_effort", backup.modelReasoningEffort.value);
  else deleteTopLevelTomlField(document, "model_reasoning_effort");

  if (backup?.modelCatalogJson?.exists) setTopLevelTomlStringField(document, "model_catalog_json", backup.modelCatalogJson.value);
  else deleteTopLevelTomlField(document, "model_catalog_json");

  if (backup?.providerSection?.exists) {
    setTomlSection(document, `model_providers.${CODEX_PROVIDER_ID}`, backup.providerSection.body || "");
  } else {
    deleteTomlSection(document, `model_providers.${CODEX_PROVIDER_ID}`);
  }
}

function captureClaudeBackup(config) {
  const env = config?.env && typeof config.env === "object" && !Array.isArray(config.env) ? config.env : {};
  const backupEnv = {};
  for (const key of [...CLAUDE_BACKUP_ENV_KEYS, "MAX_THINKING_TOKENS"]) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      backupEnv[key] = getBackupValue(env[key]);
    }
  }
  const backup = {
    tool: "claude-code",
    version: 1,
    env: backupEnv
  };
  if (config && typeof config === "object" && config.effortLevel !== undefined) {
    backup.effortLevel = getBackupValue(config.effortLevel);
  }
  return backup;
}

function applyClaudeBackup(config, backup = {}) {
  const next = config && typeof config === "object" && !Array.isArray(config)
    ? structuredClone(config)
    : {};
  const env = next.env && typeof next.env === "object" && !Array.isArray(next.env)
    ? { ...next.env }
    : {};

  for (const key of [...CLAUDE_BACKUP_ENV_KEYS, "MAX_THINKING_TOKENS"]) {
    if (backup?.env && Object.prototype.hasOwnProperty.call(backup.env, key)) {
      applyBackupValue(env, key, backup.env[key]);
    } else {
      delete env[key];
    }
  }

  if (backup?.effortLevel?.exists) {
    next.effortLevel = backup.effortLevel.value;
  } else {
    delete next.effortLevel;
  }

  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  return next;
}

const SHELL_EFFORT_MARKER_START = "# >>> llm-router effort-level >>>";
const SHELL_EFFORT_MARKER_END = "# <<< llm-router effort-level <<<";

function resolveShellProfilePath(homeDir) {
  const shell = String(process.env.SHELL || "").trim();
  const profileName = shell.endsWith("/zsh") || shell.endsWith("/zsh5") ? ".zshrc" : ".bashrc";
  return path.join(homeDir, profileName);
}

async function patchShellProfileEffortLevel(effortLevel, homeDir) {
  const profilePath = resolveShellProfilePath(homeDir);
  const markerPattern = new RegExp(
    `${escapeRegex(SHELL_EFFORT_MARKER_START)}[\\s\\S]*?${escapeRegex(SHELL_EFFORT_MARKER_END)}\\n?`,
    "g"
  );

  let text;
  try {
    text = await fs.readFile(profilePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      if (!effortLevel) return false;
      text = "";
    } else {
      return false;
    }
  }

  const cleaned = text.replace(markerPattern, "");
  if (!effortLevel) {
    if (cleaned !== text) {
      await fs.writeFile(profilePath, cleaned, "utf8");
    }
    return true;
  }

  const block = [
    SHELL_EFFORT_MARKER_START,
    `export CLAUDE_CODE_EFFORT_LEVEL="${effortLevel}"`,
    SHELL_EFFORT_MARKER_END,
    ""
  ].join("\n");

  const separator = cleaned.length > 0 && !cleaned.endsWith("\n") ? "\n" : "";
  await fs.writeFile(profilePath, `${cleaned}${separator}${block}`, "utf8");
  return true;
}

async function ensureToolBackupFileExists(backupFilePath) {
  const backupState = await readJsonObjectFile(backupFilePath, `Backup file '${backupFilePath}'`);
  if (!backupState.existed) {
    await writeJsonObjectFile(backupFilePath, {});
  }
  return backupState;
}

function sanitizeBackup(backup, tool) {
  if (!backup || typeof backup !== "object" || Array.isArray(backup)) return {};
  if (String(backup.tool || "").trim() && String(backup.tool || "").trim() !== tool) return {};
  return backup;
}

export function resolveCodingToolBackupFilePath(configFilePath = "") {
  const resolvedPath = path.resolve(String(configFilePath || "").trim());
  const parsed = path.parse(resolvedPath);
  if (!parsed.ext) return `${resolvedPath}${BACKUP_SUFFIX}`;
  return path.join(parsed.dir, `${parsed.name}${BACKUP_SUFFIX}${parsed.ext}`);
}

export function resolveCodexCliConfigFilePath({
  explicitPath = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const direct = String(explicitPath || "").trim();
  if (direct) return path.resolve(direct);
  const codexHome = String(env?.CODEX_HOME || "").trim() || path.join(homeDir, ".codex");
  return path.join(codexHome, "config.toml");
}

export function resolveCodexCliModelCatalogFilePath({
  configFilePath = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const resolvedConfigPath = path.resolve(String(configFilePath || resolveCodexCliConfigFilePath({ env, homeDir })).trim());
  return path.join(path.dirname(resolvedConfigPath), CODEX_MODEL_CATALOG_FILENAME);
}

export function resolveClaudeCodeSettingsFilePath({
  explicitPath = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const direct = String(explicitPath || "").trim();
  if (direct) return path.resolve(direct);
  const configDir = String(env?.CLAUDE_CONFIG_DIR || "").trim() || path.join(homeDir, ".claude");
  return path.join(configDir, "settings.json");
}

export async function ensureCodexCliConfigFileExists({
  configFilePath = "",
  backupFilePath = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const resolvedConfigPath = path.resolve(String(configFilePath || resolveCodexCliConfigFilePath({ env, homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedConfigPath)).trim());
  const configState = await readTextFile(resolvedConfigPath);
  if (!configState.existed) {
    await writeTextFile(resolvedConfigPath, "");
  }
  await ensureToolBackupFileExists(resolvedBackupPath);
  return {
    configFilePath: resolvedConfigPath,
    backupFilePath: resolvedBackupPath,
    configCreated: !configState.existed
  };
}

export async function ensureClaudeCodeSettingsFileExists({
  settingsFilePath = "",
  backupFilePath = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveClaudeCodeSettingsFilePath({ env, homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedSettingsPath)).trim());
  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `Claude Code settings file '${resolvedSettingsPath}'`);
  if (!settingsState.existed) {
    await writeJsonObjectFile(resolvedSettingsPath, {});
  }
  await ensureToolBackupFileExists(resolvedBackupPath);
  return {
    settingsFilePath: resolvedSettingsPath,
    backupFilePath: resolvedBackupPath,
    settingsCreated: !settingsState.existed
  };
}

export async function readCodexCliRoutingState({
  configFilePath = "",
  backupFilePath = "",
  endpointUrl = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const resolvedConfigPath = path.resolve(String(configFilePath || resolveCodexCliConfigFilePath({ env, homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedConfigPath)).trim());
  const expectedBaseUrl = buildCodexProviderBaseUrl(endpointUrl);
  const configState = await readTextFile(resolvedConfigPath);
  const backupState = await readJsonObjectFile(resolvedBackupPath, `Backup file '${resolvedBackupPath}'`);
  const document = splitTomlDocument(configState.text);
  const modelProvider = getTopLevelTomlStringField(document, "model_provider");
  const model = getTopLevelTomlStringField(document, "model");
  const modelReasoningEffort = getTopLevelTomlStringField(document, "model_reasoning_effort");
  const modelCatalogJson = getTopLevelTomlStringField(document, "model_catalog_json");
  const providerSection = parseTomlSectionKeyValues(getTomlSection(document, `model_providers.${CODEX_PROVIDER_ID}`));
  const configuredBaseUrl = String(providerSection.base_url || "").trim();
  const configuredBearerToken = String(providerSection.experimental_bearer_token || "").trim();
  const routedViaRouter = Boolean(
    expectedBaseUrl
      && modelProvider.value === CODEX_PROVIDER_ID
      && configuredBaseUrl === expectedBaseUrl
  );
  const routerCatalogPath = resolveCodexCliModelCatalogFilePath({
    configFilePath: resolvedConfigPath,
    env,
    homeDir
  });
  const usingRouterManagedCatalog = areResolvedFilePathsEqual(modelCatalogJson.value, routerCatalogPath);

  return {
    tool: "codex-cli",
    configFilePath: resolvedConfigPath,
    backupFilePath: resolvedBackupPath,
    configExists: configState.existed,
    backupExists: backupState.existed,
    routedViaRouter,
    configuredBaseUrl,
    modelProvider: modelProvider.value,
    configuredModel: model.value,
    configuredThinkingLevel: modelReasoningEffort.value,
    configuredModelCatalogJson: modelCatalogJson.value,
    inheritCliModel: routedViaRouter && !usingRouterManagedCatalog,
    bindings: {
      defaultModel: routedViaRouter && !usingRouterManagedCatalog
        ? CODEX_CLI_INHERIT_MODEL_VALUE
        : model.value,
      thinkingLevel: modelReasoningEffort.value
    }
  };
}

export async function patchCodexCliConfigFile({
  configFilePath = "",
  backupFilePath = "",
  modelCatalogFilePath = "",
  endpointUrl = "",
  apiKey = "",
  bindings = {},
  modelCatalog = undefined,
  captureBackup = true,
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const resolvedConfigPath = path.resolve(String(configFilePath || resolveCodexCliConfigFilePath({ env, homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedConfigPath)).trim());
  const resolvedCatalogPath = path.resolve(String(modelCatalogFilePath || resolveCodexCliModelCatalogFilePath({
    configFilePath: resolvedConfigPath,
    env,
    homeDir
  })).trim());
  const baseUrl = buildCodexProviderBaseUrl(endpointUrl);
  const normalizedApiKey = String(apiKey || "").trim();
  const normalizedBindings = normalizeCodexBindings(bindings);
  const normalizedModelCatalog = normalizeCodexModelCatalog(modelCatalog);

  if (!baseUrl) {
    throw new Error("Codex CLI endpoint URL must be a valid http:// or https:// URL.");
  }
  if (!normalizedApiKey) {
    throw new Error("Codex CLI API key is required.");
  }

  const configState = await readTextFile(resolvedConfigPath);
  const document = splitTomlDocument(configState.text);
  const backupState = await ensureToolBackupFileExists(resolvedBackupPath);
  const existingBackup = sanitizeBackup(backupState.data, "codex-cli");
  const currentModelCatalogJson = getTopLevelTomlStringField(document, "model_catalog_json");
  const currentlyUsingRouterManagedCatalog = areResolvedFilePathsEqual(currentModelCatalogJson.value, resolvedCatalogPath);

  if (captureBackup && !backupHasData(existingBackup)) {
    const backup = configState.existed ? captureCodexBackup(document) : {};
    await writeJsonObjectFile(resolvedBackupPath, backup);
  }

  setTopLevelTomlStringField(document, "model_provider", CODEX_PROVIDER_ID);
  if (isCodexCliInheritModelBinding(normalizedBindings.defaultModel)) {
    if (currentlyUsingRouterManagedCatalog) {
      if (existingBackup?.model?.exists) setTopLevelTomlStringField(document, "model", existingBackup.model.value);
      else deleteTopLevelTomlField(document, "model");

      if (existingBackup?.modelCatalogJson?.exists) {
        setTopLevelTomlStringField(document, "model_catalog_json", existingBackup.modelCatalogJson.value);
      } else {
        deleteTopLevelTomlField(document, "model_catalog_json");
      }
    }
  } else if (normalizedBindings.defaultModel) {
    setTopLevelTomlStringField(document, "model", normalizedBindings.defaultModel);
  } else {
    deleteTopLevelTomlField(document, "model");
  }
  if (normalizedBindings.thinkingLevel) {
    setTopLevelTomlStringField(document, "model_reasoning_effort", normalizedBindings.thinkingLevel);
  } else {
    deleteTopLevelTomlField(document, "model_reasoning_effort");
  }
  setTomlSection(document, `model_providers.${CODEX_PROVIDER_ID}`, createCodexProviderSection({
    baseUrl,
    apiKey: normalizedApiKey
  }));
  if (!isCodexCliInheritModelBinding(normalizedBindings.defaultModel)) {
    if (normalizedModelCatalog?.models?.length > 0) {
      await writeJsonObjectFile(resolvedCatalogPath, normalizedModelCatalog);
      setTopLevelTomlStringField(document, "model_catalog_json", resolvedCatalogPath);
    } else {
      deleteTopLevelTomlField(document, "model_catalog_json");
    }
  }

  await writeTextFile(resolvedConfigPath, serializeTomlDocument(document));
  const finalModelCatalogJson = getTopLevelTomlStringField(document, "model_catalog_json");
  const usingRouterManagedCatalog = areResolvedFilePathsEqual(finalModelCatalogJson.value, resolvedCatalogPath);
  if (!usingRouterManagedCatalog) {
    await fs.rm(resolvedCatalogPath, { force: true });
  }
  return {
    configFilePath: resolvedConfigPath,
    backupFilePath: resolvedBackupPath,
    modelCatalogFilePath: usingRouterManagedCatalog ? resolvedCatalogPath : "",
    configCreated: !configState.existed,
    baseUrl,
    bindings: normalizedBindings
  };
}

export async function unpatchCodexCliConfigFile({
  configFilePath = "",
  backupFilePath = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const resolvedConfigPath = path.resolve(String(configFilePath || resolveCodexCliConfigFilePath({ env, homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedConfigPath)).trim());
  const resolvedCatalogPath = resolveCodexCliModelCatalogFilePath({
    configFilePath: resolvedConfigPath,
    env,
    homeDir
  });
  const configState = await readTextFile(resolvedConfigPath);
  const document = splitTomlDocument(configState.text);
  const backupState = await readJsonObjectFile(resolvedBackupPath, `Backup file '${resolvedBackupPath}'`);
  const backup = sanitizeBackup(backupState.data, "codex-cli");

  applyCodexBackup(document, backup);
  await writeTextFile(resolvedConfigPath, serializeTomlDocument(document));
  if (String(backup?.modelCatalogJson?.value || "").trim() !== resolvedCatalogPath) {
    await fs.rm(resolvedCatalogPath, { force: true });
  }
  await writeJsonObjectFile(resolvedBackupPath, {});

  return {
    configFilePath: resolvedConfigPath,
    backupFilePath: resolvedBackupPath,
    configExisted: configState.existed,
    backupRestored: backupHasData(backup)
  };
}

export async function readClaudeCodeRoutingState({
  settingsFilePath = "",
  backupFilePath = "",
  endpointUrl = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveClaudeCodeSettingsFilePath({ env, homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedSettingsPath)).trim());
  const expectedBaseUrl = buildClaudeCodeBaseUrl(endpointUrl);
  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `Claude Code settings file '${resolvedSettingsPath}'`);
  const backupState = await readJsonObjectFile(resolvedBackupPath, `Backup file '${resolvedBackupPath}'`);
  const envConfig = settingsState.data?.env && typeof settingsState.data.env === "object" && !Array.isArray(settingsState.data.env)
    ? settingsState.data.env
    : {};
  const configuredBaseUrl = normalizeHttpUrl(envConfig.ANTHROPIC_BASE_URL || "");
  const routedViaRouter = Boolean(
    expectedBaseUrl
      && configuredBaseUrl === expectedBaseUrl
  );

  return {
    tool: "claude-code",
    settingsFilePath: resolvedSettingsPath,
    backupFilePath: resolvedBackupPath,
    settingsExists: settingsState.existed,
    backupExists: backupState.existed,
    routedViaRouter,
    configuredBaseUrl,
    bindings: normalizeClaudeBindings({
      primaryModel: envConfig.ANTHROPIC_MODEL,
      defaultOpusModel: envConfig.ANTHROPIC_DEFAULT_OPUS_MODEL,
      defaultSonnetModel: envConfig.ANTHROPIC_DEFAULT_SONNET_MODEL,
      defaultHaikuModel: envConfig.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      subagentModel: envConfig.CLAUDE_CODE_SUBAGENT_MODEL,
      thinkingLevel: normalizeClaudeCodeEffortLevel(envConfig.CLAUDE_CODE_EFFORT_LEVEL)
        || normalizeClaudeCodeEffortLevel(settingsState.data?.effortLevel)
        || migrateLegacyThinkingTokensToEffortLevel(envConfig.MAX_THINKING_TOKENS)
    })
  };
}

export async function patchClaudeCodeSettingsFile({
  settingsFilePath = "",
  backupFilePath = "",
  endpointUrl = "",
  apiKey = "",
  bindings = {},
  captureBackup = true,
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveClaudeCodeSettingsFilePath({ env, homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedSettingsPath)).trim());
  const baseUrl = buildClaudeCodeBaseUrl(endpointUrl);
  const normalizedApiKey = String(apiKey || "").trim();
  const normalizedBindings = normalizeClaudeBindings(bindings);

  if (!baseUrl) {
    throw new Error("Claude Code endpoint URL must be a valid http:// or https:// URL.");
  }
  if (!normalizedApiKey) {
    throw new Error("Claude Code API key is required.");
  }

  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `Claude Code settings file '${resolvedSettingsPath}'`);
  const backupState = await ensureToolBackupFileExists(resolvedBackupPath);
  const existingBackup = sanitizeBackup(backupState.data, "claude-code");
  const nextSettings = settingsState.data && typeof settingsState.data === "object" && !Array.isArray(settingsState.data)
    ? structuredClone(settingsState.data)
    : {};

  if (captureBackup && !backupHasData(existingBackup)) {
    const backup = settingsState.existed ? captureClaudeBackup(nextSettings) : {};
    await writeJsonObjectFile(resolvedBackupPath, backup);
  }

  if (!nextSettings.env || typeof nextSettings.env !== "object" || Array.isArray(nextSettings.env)) {
    nextSettings.env = {};
  }

  nextSettings.env.ANTHROPIC_BASE_URL = baseUrl;
  nextSettings.env.ANTHROPIC_AUTH_TOKEN = normalizedApiKey;
  delete nextSettings.env.ANTHROPIC_API_KEY;

  if (normalizedBindings.primaryModel) nextSettings.env.ANTHROPIC_MODEL = normalizedBindings.primaryModel;
  else delete nextSettings.env.ANTHROPIC_MODEL;

  if (normalizedBindings.defaultOpusModel) nextSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = normalizedBindings.defaultOpusModel;
  else delete nextSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL;

  if (normalizedBindings.defaultSonnetModel) nextSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = normalizedBindings.defaultSonnetModel;
  else delete nextSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

  if (normalizedBindings.defaultHaikuModel) nextSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = normalizedBindings.defaultHaikuModel;
  else delete nextSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;

  delete nextSettings.env.ANTHROPIC_SMALL_FAST_MODEL;

  if (normalizedBindings.subagentModel) nextSettings.env.CLAUDE_CODE_SUBAGENT_MODEL = normalizedBindings.subagentModel;
  else delete nextSettings.env.CLAUDE_CODE_SUBAGENT_MODEL;

  delete nextSettings.env.MAX_THINKING_TOKENS;

  const effortLevel = normalizeClaudeCodeEffortLevel(normalizedBindings.thinkingLevel);
  let shellProfileUpdated = false;
  if (effortLevel) {
    nextSettings.env.CLAUDE_CODE_EFFORT_LEVEL = effortLevel;
    if (effortLevel === CLAUDE_CODE_EFFORT_LEVEL_SETTINGS_JSON_VALUE) {
      nextSettings.effortLevel = effortLevel;
    } else {
      delete nextSettings.effortLevel;
    }
    shellProfileUpdated = await patchShellProfileEffortLevel(effortLevel, homeDir);
    if (!shellProfileUpdated) {
      nextSettings.effortLevel = CLAUDE_CODE_EFFORT_LEVEL_SETTINGS_JSON_VALUE;
    }
  } else {
    delete nextSettings.env.CLAUDE_CODE_EFFORT_LEVEL;
    delete nextSettings.effortLevel;
    shellProfileUpdated = await patchShellProfileEffortLevel("", homeDir);
  }

  await writeJsonObjectFile(resolvedSettingsPath, nextSettings);
  return {
    settingsFilePath: resolvedSettingsPath,
    backupFilePath: resolvedBackupPath,
    settingsCreated: !settingsState.existed,
    shellProfileUpdated,
    baseUrl,
    bindings: normalizedBindings
  };
}

export async function unpatchClaudeCodeSettingsFile({
  settingsFilePath = "",
  backupFilePath = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveClaudeCodeSettingsFilePath({ env, homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedSettingsPath)).trim());
  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `Claude Code settings file '${resolvedSettingsPath}'`);
  const backupState = await readJsonObjectFile(resolvedBackupPath, `Backup file '${resolvedBackupPath}'`);
  const backup = sanitizeBackup(backupState.data, "claude-code");
  const restoredSettings = applyClaudeBackup(settingsState.data, backup);
  delete restoredSettings.effortLevel;

  await writeJsonObjectFile(resolvedSettingsPath, restoredSettings);
  await writeJsonObjectFile(resolvedBackupPath, {});
  await patchShellProfileEffortLevel("", homeDir);

  return {
    settingsFilePath: resolvedSettingsPath,
    backupFilePath: resolvedBackupPath,
    settingsExisted: settingsState.existed,
    backupRestored: backupHasData(backup)
  };
}

export async function patchClaudeCodeEffortLevel({
  settingsFilePath = "",
  effortLevel = "",
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveClaudeCodeSettingsFilePath({ env, homeDir })).trim());
  const normalizedLevel = normalizeClaudeCodeEffortLevel(effortLevel);

  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `Claude Code settings file '${resolvedSettingsPath}'`);
  const nextSettings = settingsState.data && typeof settingsState.data === "object" && !Array.isArray(settingsState.data)
    ? structuredClone(settingsState.data)
    : {};

  if (!nextSettings.env || typeof nextSettings.env !== "object" || Array.isArray(nextSettings.env)) {
    nextSettings.env = {};
  }

  let shellProfileUpdated = false;
  if (normalizedLevel) {
    nextSettings.env.CLAUDE_CODE_EFFORT_LEVEL = normalizedLevel;
    if (normalizedLevel === CLAUDE_CODE_EFFORT_LEVEL_SETTINGS_JSON_VALUE) {
      nextSettings.effortLevel = normalizedLevel;
    } else {
      delete nextSettings.effortLevel;
    }
    shellProfileUpdated = await patchShellProfileEffortLevel(normalizedLevel, homeDir);
    if (!shellProfileUpdated) {
      nextSettings.effortLevel = CLAUDE_CODE_EFFORT_LEVEL_SETTINGS_JSON_VALUE;
    }
  } else {
    delete nextSettings.env.CLAUDE_CODE_EFFORT_LEVEL;
    delete nextSettings.effortLevel;
    shellProfileUpdated = await patchShellProfileEffortLevel("", homeDir);
  }

  if (Object.keys(nextSettings.env).length === 0) delete nextSettings.env;
  await writeJsonObjectFile(resolvedSettingsPath, nextSettings);
  return {
    settingsFilePath: resolvedSettingsPath,
    effortLevel: normalizedLevel,
    shellProfileUpdated
  };
}

const FACTORY_DROID_ROUTER_MARKER = "_llmRouterManaged";
const FACTORY_DROID_OPENAI_PROVIDER = "openai";
const FACTORY_DROID_ANTHROPIC_PROVIDER = "anthropic";
const FACTORY_DROID_ROUTER_PROVIDERS = Object.freeze([
  FACTORY_DROID_OPENAI_PROVIDER,
  FACTORY_DROID_ANTHROPIC_PROVIDER
]);

function dedupeStrings(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeFactoryDroidFormat(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "openai") return "openai";
  if (normalized === "claude" || normalized === "anthropic") return "claude";
  return "";
}

function mapFactoryDroidFormatToProvider(format) {
  const normalized = normalizeFactoryDroidFormat(format);
  if (normalized === "claude") return FACTORY_DROID_ANTHROPIC_PROVIDER;
  if (normalized === "openai") return FACTORY_DROID_OPENAI_PROVIDER;
  return "";
}

function normalizeFactoryDroidBindings(bindings = {}) {
  const source = bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings : {};
  const legacyMissionModel = normalizeModelBinding(source.missionModel);
  return {
    defaultModel: normalizeModelBinding(source.defaultModel),
    missionOrchestratorModel: normalizeModelBinding(source.missionOrchestratorModel) || legacyMissionModel,
    missionWorkerModel: normalizeModelBinding(source.missionWorkerModel) || legacyMissionModel,
    missionValidatorModel: normalizeModelBinding(source.missionValidatorModel) || legacyMissionModel,
    reasoningEffort: normalizeFactoryDroidReasoningEffort(source.reasoningEffort)
  };
}

function buildFactoryDroidBaseUrl(endpointUrl, provider = FACTORY_DROID_OPENAI_PROVIDER) {
  const normalized = normalizeHttpUrl(endpointUrl);
  const resolvedProvider = String(provider || "").trim().toLowerCase() || FACTORY_DROID_OPENAI_PROVIDER;
  if (!normalized) return "";
  return resolvedProvider === FACTORY_DROID_ANTHROPIC_PROVIDER
    ? `${normalized}/anthropic`
    : `${normalized}/openai/v1`;
}

function inferFactoryDroidFormatFromModelId(modelId) {
  const normalized = String(modelId || "").trim().toLowerCase();
  if (!normalized) return "";
  if (/^(?:claude|opus|sonnet|haiku)(?=[-./\s]|$)/i.test(normalized)) return "claude";
  if (/^gpt(?=[-./\s]|$)/i.test(normalized)) return "openai";
  return "";
}

function inferFactoryDroidFormatFromProviderId(providerId) {
  const normalized = String(providerId || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "anthropic") return "claude";
  if (normalized === "openai") return "openai";
  return "";
}

function getFactoryDroidProviderModelFormats(provider, model, modelId = "") {
  const resolvedModelId = String(modelId || model?.id || "").trim();
  const preferredFormat = normalizeFactoryDroidFormat(provider?.lastProbe?.modelPreferredFormat?.[resolvedModelId]);
  if (preferredFormat) return [preferredFormat];

  return dedupeStrings([
    ...(provider?.lastProbe?.modelSupport?.[resolvedModelId] || []),
    ...(model?.formats || []),
    model?.format
  ])
    .map(normalizeFactoryDroidFormat)
    .filter(Boolean);
}

function getFactoryDroidProviderFormats(provider) {
  return dedupeStrings([
    ...(provider?.formats || []),
    provider?.format
  ])
    .map(normalizeFactoryDroidFormat)
    .filter(Boolean);
}

function getFactoryDroidAliasTargetRefs(alias) {
  const refs = [];
  const push = (entry) => {
    const ref = String(
      typeof entry === "string"
        ? entry
        : (entry?.ref || entry?.sourceRef || "")
    ).trim();
    if (ref) refs.push(ref);
  };

  for (const entry of Array.isArray(alias?.targets) ? alias.targets : []) push(entry);
  for (const entry of Array.isArray(alias?.fallbackTargets) ? alias.fallbackTargets : []) push(entry);

  return refs;
}

function resolveFactoryDroidRouteFormat(modelRef, config = {}, seen = new Set()) {
  const normalizedModelRef = String(modelRef || "").trim();
  if (!normalizedModelRef || seen.has(normalizedModelRef)) return "";

  if (normalizedModelRef.includes("/")) {
    const separatorIndex = normalizedModelRef.indexOf("/");
    const providerId = normalizedModelRef.slice(0, separatorIndex).trim();
    const modelId = normalizedModelRef.slice(separatorIndex + 1).trim();
    const provider = (Array.isArray(config?.providers) ? config.providers : [])
      .find((entry) => String(entry?.id || "").trim() === providerId);
    const model = Array.isArray(provider?.models)
      ? provider.models.find((entry) => String(entry?.id || "").trim() === modelId)
      : null;
    return getFactoryDroidProviderModelFormats(provider, model, modelId)[0]
      || inferFactoryDroidFormatFromModelId(modelId)
      || getFactoryDroidProviderFormats(provider)[0]
      || inferFactoryDroidFormatFromProviderId(providerId)
      || "";
  }

  seen.add(normalizedModelRef);
  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};
  const alias = aliases[normalizedModelRef];
  if (!alias || typeof alias !== "object" || Array.isArray(alias)) return "";

  for (const targetRef of getFactoryDroidAliasTargetRefs(alias)) {
    const resolved = resolveFactoryDroidRouteFormat(targetRef, config, new Set(seen));
    if (resolved) return resolved;
  }

  return "";
}

function resolveFactoryDroidCustomModelProvider(modelRef, config = {}) {
  return mapFactoryDroidFormatToProvider(resolveFactoryDroidRouteFormat(modelRef, config))
    || FACTORY_DROID_OPENAI_PROVIDER;
}

function resolveFactoryDroidProviderDisplayName(modelRef, config = {}) {
  const normalizedModelRef = String(modelRef || "").trim();
  if (!normalizedModelRef.includes("/")) return "";
  const separatorIndex = normalizedModelRef.indexOf("/");
  const providerId = normalizedModelRef.slice(0, separatorIndex).trim();
  const provider = (Array.isArray(config?.providers) ? config.providers : [])
    .find((entry) => String(entry?.id || "").trim() === providerId);
  return String(provider?.name || providerId || "").trim();
}

function collectFactoryDroidAvailableModels(config = {}, bindings = {}) {
  const refs = [];
  const seen = new Set();
  const push = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    refs.push(normalized);
  };

  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};
  for (const aliasId of Object.keys(aliases)) {
    push(aliasId);
  }

  push(bindings?.defaultModel);
  push(bindings?.missionOrchestratorModel);
  push(bindings?.missionWorkerModel);
  push(bindings?.missionValidatorModel);

  for (const provider of Array.isArray(config?.providers) ? config.providers : []) {
    if (provider?.enabled === false) continue;
    const providerId = String(provider?.id || "").trim();
    if (!providerId) continue;
    for (const model of Array.isArray(provider?.models) ? provider.models : []) {
      if (model?.enabled === false) continue;
      const modelId = String(model?.id || "").trim();
      if (!modelId) continue;
      push(`${providerId}/${modelId}`);
    }
  }

  return refs;
}

function buildFactoryDroidAvailableModelDescriptors(config = {}, bindings = {}) {
  return collectFactoryDroidAvailableModels(config, bindings)
    .map((modelRef) => {
      const kind = modelRef.includes("/") ? "model" : "alias";
      return {
        modelRef,
        kind,
        id: buildFactoryDroidRouterModelId(modelRef, { kind }),
        displayName: buildFactoryDroidRouterDisplayName(modelRef, {
          kind,
          providerName: kind === "model" ? resolveFactoryDroidProviderDisplayName(modelRef, config) : ""
        })
      };
    })
    .filter((entry) => String(entry.id || "").trim() && String(entry.modelRef || "").trim());
}

function buildFactoryDroidRouteLookup(config = {}, bindings = {}) {
  const descriptors = buildFactoryDroidAvailableModelDescriptors(config, bindings);
  const byId = new Map();
  const byDisplayName = new Map();

  for (const descriptor of descriptors) {
    if (descriptor.id) byId.set(descriptor.id, descriptor.modelRef);
    if (descriptor.displayName) byDisplayName.set(descriptor.displayName, descriptor.modelRef);
  }

  return {
    descriptors,
    byId,
    byDisplayName
  };
}

function resolveFactoryDroidRouteRefFromLookup(value, routeLookup) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue || !routeLookup || typeof routeLookup !== "object") return "";
  if (routeLookup.byId instanceof Map && routeLookup.byId.has(normalizedValue)) {
    return String(routeLookup.byId.get(normalizedValue) || "").trim();
  }
  if (routeLookup.byDisplayName instanceof Map && routeLookup.byDisplayName.has(normalizedValue)) {
    return String(routeLookup.byDisplayName.get(normalizedValue) || "").trim();
  }
  return "";
}

function getFactoryDroidCustomModelEntryByValue(customModels, value, { preferRouterManaged = false } = {}) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue || !Array.isArray(customModels)) return null;

  const entries = preferRouterManaged
    ? [
      ...customModels.filter((entry) => isFactoryDroidRouterManagedEntry(entry)),
      ...customModels.filter((entry) => !isFactoryDroidRouterManagedEntry(entry))
    ]
    : customModels;

  return entries.find((entry) => entry && typeof entry === "object" && (
    String(entry.id || "").trim() === normalizedValue
    || String(entry.model || "").trim() === normalizedValue
    || String(entry.displayName || "").trim() === normalizedValue
  )) || null;
}

function resolveFactoryDroidBindingModelRef(value, customModels, routeLookup = null) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return "";
  const matchedEntry = getFactoryDroidCustomModelEntryByValue(customModels, normalizedValue, { preferRouterManaged: true });
  if (!matchedEntry) {
    return resolveFactoryDroidRouteRefFromLookup(normalizedValue, routeLookup)
      || resolveFactoryDroidRouterModelRef(normalizedValue);
  }
  return resolveFactoryDroidRouterModelRef(
    String(matchedEntry.model || matchedEntry.displayName || matchedEntry.id || normalizedValue).trim()
  );
}

function getNextFactoryDroidCustomModelIndex(customModels) {
  if (!Array.isArray(customModels) || customModels.length === 0) return 0;
  let maxIndex = -1;
  for (const entry of customModels) {
    const parsed = Number(entry?.index);
    if (Number.isFinite(parsed)) maxIndex = Math.max(maxIndex, parsed);
  }
  return maxIndex >= 0 ? (maxIndex + 1) : customModels.length;
}

function buildFactoryDroidCustomModelId(modelRef, index) {
  return buildFactoryDroidRouterModelId(modelRef) || `custom:llm-alias-llm-router-${Number(index)}`;
}

function resolveFactoryDroidBindingSelectionValue(value, customModels, routeLookup = null) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return "";
  const matchedEntry = getFactoryDroidCustomModelEntryByValue(customModels, normalizedValue, { preferRouterManaged: true });
  if (matchedEntry) {
    const matchedId = String(matchedEntry.id || "").trim();
    const preferredId = buildFactoryDroidCustomModelId(
      resolveFactoryDroidBindingModelRef(normalizedValue, customModels, routeLookup),
      Number(matchedEntry.index) || 0
    );
    if (matchedEntry[FACTORY_DROID_ROUTER_MARKER] === true || isFactoryDroidRouterModelId(matchedId)) {
      return preferredId || matchedId || normalizedValue;
    }
    return matchedId || preferredId || normalizedValue;
  }
  const resolvedRouteRef = resolveFactoryDroidRouteRefFromLookup(normalizedValue, routeLookup);
  if (resolvedRouteRef) return buildFactoryDroidCustomModelId(resolvedRouteRef, 0) || normalizedValue;
  return buildFactoryDroidCustomModelId(
    resolveFactoryDroidBindingModelRef(normalizedValue, customModels, routeLookup),
    0
  ) || normalizedValue;
}

function findRouterManagedCustomModelIndex(customModels) {
  if (!Array.isArray(customModels)) return -1;
  return customModels.findIndex(
    (entry) => isFactoryDroidRouterManagedEntry(entry)
  );
}

function getRouterManagedCustomModel(customModels) {
  const routerIndex = findRouterManagedCustomModelIndex(customModels);
  return routerIndex >= 0 ? customModels[routerIndex] : null;
}

function isFactoryDroidRouterManagedEntry(entry, { baseUrl = "" } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (entry[FACTORY_DROID_ROUTER_MARKER] === true) return true;

  const entryId = String(entry.id || "").trim();
  if (isFactoryDroidRouterModelId(entryId)) return true;

  const provider = String(entry.provider || "").trim().toLowerCase();
  if (!FACTORY_DROID_ROUTER_PROVIDERS.includes(provider)) return false;

  const entryBaseUrl = String(entry.baseUrl || "").trim();
  if (baseUrl && entryBaseUrl === String(baseUrl || "").trim()) return true;

  const apiKey = String(entry.apiKey || "").trim();
  return apiKey.startsWith("gw_") && (
    entryBaseUrl.includes("/openai/v1")
    || entryBaseUrl.includes("/anthropic")
  );
}

function stripRouterManagedCustomModels(customModels, { baseUrl = "" } = {}) {
  if (!Array.isArray(customModels)) return [];
  return customModels.filter(
    (entry) => !isFactoryDroidRouterManagedEntry(entry, { baseUrl })
  );
}

function getNestedObjectValue(source, keys = []) {
  let current = source;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function setNestedObjectValue(target, keys = [], value) {
  if (!target || typeof target !== "object" || Array.isArray(target) || !Array.isArray(keys) || keys.length === 0) {
    return;
  }

  let current = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    const nextValue = current[key];
    if (!nextValue || typeof nextValue !== "object" || Array.isArray(nextValue)) {
      current[key] = {};
    }
    current = current[key];
  }

  current[keys[keys.length - 1]] = value;
}

function deleteNestedObjectValue(target, keys = []) {
  if (!target || typeof target !== "object" || Array.isArray(target) || !Array.isArray(keys) || keys.length === 0) {
    return;
  }

  const parents = [];
  let current = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) {
      return;
    }
    parents.push([current, key]);
    current = current[key];
  }

  delete current[keys[keys.length - 1]];

  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const [parent, key] = parents[index];
    const value = parent[key];
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
      delete parent[key];
      continue;
    }
    break;
  }
}

function applyNestedBackupValue(target, keys = [], snapshot) {
  if (snapshot?.exists) {
    setNestedObjectValue(target, keys, String(snapshot.value || ""));
    return;
  }
  deleteNestedObjectValue(target, keys);
}

function captureFactoryDroidBackup(config) {
  const customModels = Array.isArray(config?.customModels) ? config.customModels : [];
  return {
    tool: "factory-droid",
    version: 2,
    model: getBackupValue(config?.model),
    sessionDefaultModel: getBackupValue(getNestedObjectValue(config, ["sessionDefaultSettings", "model"])),
    missionOrchestratorModel: getBackupValue(config?.missionOrchestratorModel),
    missionWorkerModel: getBackupValue(getNestedObjectValue(config, ["missionModelSettings", "workerModel"])),
    missionValidationWorkerModel: getBackupValue(getNestedObjectValue(config, ["missionModelSettings", "validationWorkerModel"])),
    reasoningEffort: getBackupValue(config?.reasoningEffort),
    hadCustomModels: customModels.length > 0
  };
}

function applyFactoryDroidBackup(config, backup = {}) {
  const next = config && typeof config === "object" && !Array.isArray(config)
    ? structuredClone(config)
    : {};

  const customModels = stripRouterManagedCustomModels(next.customModels);
  if (customModels.length > 0) next.customModels = customModels;
  else delete next.customModels;

  applyBackupValue(next, "model", backup?.model);
  applyNestedBackupValue(next, ["sessionDefaultSettings", "model"], backup?.sessionDefaultModel);
  applyBackupValue(next, "missionOrchestratorModel", backup?.missionOrchestratorModel);
  applyNestedBackupValue(next, ["missionModelSettings", "workerModel"], backup?.missionWorkerModel);
  applyNestedBackupValue(next, ["missionModelSettings", "validationWorkerModel"], backup?.missionValidationWorkerModel);
  applyBackupValue(next, "reasoningEffort", backup?.reasoningEffort);

  return next;
}

export function resolveFactoryDroidSettingsFilePath({
  explicitPath = "",
  homeDir = os.homedir()
} = {}) {
  const direct = String(explicitPath || "").trim();
  if (direct) return path.resolve(direct);
  return path.join(homeDir, ".factory", "settings.json");
}

export async function ensureFactoryDroidSettingsFileExists({
  settingsFilePath = "",
  backupFilePath = "",
  homeDir = os.homedir()
} = {}) {
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveFactoryDroidSettingsFilePath({ homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedSettingsPath)).trim());
  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `Factory Droid settings file '${resolvedSettingsPath}'`);
  if (!settingsState.existed) {
    await writeJsonObjectFile(resolvedSettingsPath, {});
  }
  await ensureToolBackupFileExists(resolvedBackupPath);
  return {
    settingsFilePath: resolvedSettingsPath,
    backupFilePath: resolvedBackupPath,
    settingsCreated: !settingsState.existed
  };
}

export async function readFactoryDroidRoutingState({
  settingsFilePath = "",
  backupFilePath = "",
  endpointUrl = "",
  config = {},
  homeDir = os.homedir()
} = {}) {
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveFactoryDroidSettingsFilePath({ homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedSettingsPath)).trim());
  const routeLookup = buildFactoryDroidRouteLookup(config);
  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `Factory Droid settings file '${resolvedSettingsPath}'`);
  const backupState = await readJsonObjectFile(resolvedBackupPath, `Backup file '${resolvedBackupPath}'`);
  const customModels = Array.isArray(settingsState.data?.customModels) ? settingsState.data.customModels : [];
  const resolvedDefaultModelValue = getNestedObjectValue(settingsState.data, ["sessionDefaultSettings", "model"])
    || settingsState.data?.model
    || "";
  const resolvedMissionOrchestratorValue = settingsState.data?.missionOrchestratorModel || "";
  const resolvedMissionWorkerValue = getNestedObjectValue(settingsState.data, ["missionModelSettings", "workerModel"]) || "";
  const resolvedMissionValidatorValue = getNestedObjectValue(settingsState.data, ["missionModelSettings", "validationWorkerModel"]) || "";
  const routerEntry = getFactoryDroidCustomModelEntryByValue(customModels, resolvedDefaultModelValue, { preferRouterManaged: true })
    || getRouterManagedCustomModel(customModels);
  const configuredBaseUrl = routerEntry ? String(routerEntry.baseUrl || "").trim() : "";
  const configuredProvider = routerEntry ? String(routerEntry.provider || "").trim() : "";
  const expectedBaseUrls = new Set(
    FACTORY_DROID_ROUTER_PROVIDERS
      .map((provider) => buildFactoryDroidBaseUrl(endpointUrl, provider))
      .filter(Boolean)
  );
  const routedViaRouter = Boolean(
    configuredBaseUrl
      && routerEntry
      && expectedBaseUrls.has(configuredBaseUrl)
  );

  return {
    tool: "factory-droid",
    settingsFilePath: resolvedSettingsPath,
    backupFilePath: resolvedBackupPath,
    settingsExists: settingsState.existed,
    backupExists: backupState.existed,
    routedViaRouter,
    configuredBaseUrl,
    configuredProvider,
    bindings: normalizeFactoryDroidBindings({
      defaultModel: resolveFactoryDroidBindingModelRef(resolvedDefaultModelValue, customModels, routeLookup),
      missionOrchestratorModel: resolveFactoryDroidBindingModelRef(resolvedMissionOrchestratorValue, customModels, routeLookup),
      missionWorkerModel: resolveFactoryDroidBindingModelRef(resolvedMissionWorkerValue, customModels, routeLookup),
      missionValidatorModel: resolveFactoryDroidBindingModelRef(resolvedMissionValidatorValue, customModels, routeLookup),
      reasoningEffort: normalizeFactoryDroidReasoningEffort(settingsState.data?.reasoningEffort)
    }),
    bindingIds: normalizeFactoryDroidBindings({
      defaultModel: resolveFactoryDroidBindingSelectionValue(resolvedDefaultModelValue, customModels, routeLookup),
      missionOrchestratorModel: resolveFactoryDroidBindingSelectionValue(resolvedMissionOrchestratorValue, customModels, routeLookup),
      missionWorkerModel: resolveFactoryDroidBindingSelectionValue(resolvedMissionWorkerValue, customModels, routeLookup),
      missionValidatorModel: resolveFactoryDroidBindingSelectionValue(resolvedMissionValidatorValue, customModels, routeLookup),
      reasoningEffort: normalizeFactoryDroidReasoningEffort(settingsState.data?.reasoningEffort)
    })
  };
}

export async function patchFactoryDroidSettingsFile({
  settingsFilePath = "",
  backupFilePath = "",
  endpointUrl = "",
  apiKey = "",
  bindings = {},
  config = {},
  captureBackup = true,
  homeDir = os.homedir()
} = {}) {
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveFactoryDroidSettingsFilePath({ homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedSettingsPath)).trim());
  const baseUrl = buildFactoryDroidBaseUrl(endpointUrl, FACTORY_DROID_OPENAI_PROVIDER);
  const normalizedApiKey = String(apiKey || "").trim();
  const normalizedBindings = normalizeFactoryDroidBindings(bindings);
  const routeLookup = buildFactoryDroidRouteLookup(config);

  if (!baseUrl) {
    throw new Error("Factory Droid endpoint URL must be a valid http:// or https:// URL.");
  }
  if (!normalizedApiKey) {
    throw new Error("Factory Droid API key is required.");
  }

  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `Factory Droid settings file '${resolvedSettingsPath}'`);
  const backupState = await ensureToolBackupFileExists(resolvedBackupPath);
  const existingBackup = sanitizeBackup(backupState.data, "factory-droid");
  const nextSettings = settingsState.data && typeof settingsState.data === "object" && !Array.isArray(settingsState.data)
    ? structuredClone(settingsState.data)
    : {};
  const existingCustomModels = Array.isArray(nextSettings.customModels) ? nextSettings.customModels : [];

  if (captureBackup && !backupHasData(existingBackup)) {
    const backup = settingsState.existed ? captureFactoryDroidBackup(nextSettings) : {};
    await writeJsonObjectFile(resolvedBackupPath, backup);
  }

  const resolvedBindings = normalizeFactoryDroidBindings({
    defaultModel: resolveFactoryDroidBindingModelRef(normalizedBindings.defaultModel, existingCustomModels, routeLookup),
    missionOrchestratorModel: resolveFactoryDroidBindingModelRef(normalizedBindings.missionOrchestratorModel, existingCustomModels, routeLookup),
    missionWorkerModel: resolveFactoryDroidBindingModelRef(normalizedBindings.missionWorkerModel, existingCustomModels, routeLookup),
    missionValidatorModel: resolveFactoryDroidBindingModelRef(normalizedBindings.missionValidatorModel, existingCustomModels, routeLookup),
    reasoningEffort: normalizedBindings.reasoningEffort
  });

  const customModels = stripRouterManagedCustomModels(existingCustomModels, { baseUrl });
  const availableModels = buildFactoryDroidAvailableModelDescriptors(config, resolvedBindings);
  const routerEntryStartIndex = getNextFactoryDroidCustomModelIndex(customModels);
  const routerEntries = availableModels.length > 0
    ? availableModels.map((descriptor, index) => {
      const entryIndex = routerEntryStartIndex + index;
      const modelId = buildFactoryDroidCustomModelId(descriptor.modelRef, entryIndex);
      const provider = resolveFactoryDroidCustomModelProvider(descriptor.modelRef, config);
      return {
        [FACTORY_DROID_ROUTER_MARKER]: true,
        model: descriptor.modelRef,
        id: modelId,
        index: entryIndex,
        displayName: descriptor.displayName,
        baseUrl: buildFactoryDroidBaseUrl(endpointUrl, provider),
        apiKey: normalizedApiKey,
        provider
      };
    })
    : [{
      [FACTORY_DROID_ROUTER_MARKER]: true,
      model: "llm-router",
      id: buildFactoryDroidCustomModelId("llm-router", routerEntryStartIndex),
      index: routerEntryStartIndex,
      displayName: buildFactoryDroidRouterDisplayName("llm-router", { kind: "alias" }),
      baseUrl,
      apiKey: normalizedApiKey,
      provider: FACTORY_DROID_OPENAI_PROVIDER
    }];

  customModels.push(...routerEntries);
  nextSettings.customModels = customModels;
  const allCustomModels = nextSettings.customModels;

  if (normalizedBindings.defaultModel) {
    const selectedModel = resolveFactoryDroidBindingSelectionValue(normalizedBindings.defaultModel, allCustomModels, routeLookup);
    nextSettings.model = selectedModel;
    setNestedObjectValue(nextSettings, ["sessionDefaultSettings", "model"], selectedModel);
  } else {
    delete nextSettings.model;
    deleteNestedObjectValue(nextSettings, ["sessionDefaultSettings", "model"]);
  }

  if (normalizedBindings.missionOrchestratorModel) {
    nextSettings.missionOrchestratorModel = resolveFactoryDroidBindingSelectionValue(
      normalizedBindings.missionOrchestratorModel,
      allCustomModels,
      routeLookup
    );
  } else {
    delete nextSettings.missionOrchestratorModel;
  }

  if (normalizedBindings.missionWorkerModel) {
    setNestedObjectValue(
      nextSettings,
      ["missionModelSettings", "workerModel"],
      resolveFactoryDroidBindingSelectionValue(normalizedBindings.missionWorkerModel, allCustomModels, routeLookup)
    );
  } else {
    deleteNestedObjectValue(nextSettings, ["missionModelSettings", "workerModel"]);
  }

  if (normalizedBindings.missionValidatorModel) {
    setNestedObjectValue(
      nextSettings,
      ["missionModelSettings", "validationWorkerModel"],
      resolveFactoryDroidBindingSelectionValue(normalizedBindings.missionValidatorModel, allCustomModels, routeLookup)
    );
  } else {
    deleteNestedObjectValue(nextSettings, ["missionModelSettings", "validationWorkerModel"]);
  }

  if (normalizedBindings.reasoningEffort) {
    nextSettings.reasoningEffort = normalizedBindings.reasoningEffort;
  } else {
    delete nextSettings.reasoningEffort;
  }

  await writeJsonObjectFile(resolvedSettingsPath, nextSettings);
  const primaryEntry = resolvedBindings.defaultModel
    ? getFactoryDroidCustomModelEntryByValue(allCustomModels, resolvedBindings.defaultModel, { preferRouterManaged: true })
    : null;
  const configuredEntry = primaryEntry || getRouterManagedCustomModel(allCustomModels);
  return {
    settingsFilePath: resolvedSettingsPath,
    backupFilePath: resolvedBackupPath,
    settingsCreated: !settingsState.existed,
    baseUrl: String(configuredEntry?.baseUrl || baseUrl).trim(),
    configuredProvider: String(configuredEntry?.provider || FACTORY_DROID_OPENAI_PROVIDER).trim(),
    bindings: resolvedBindings,
    bindingIds: normalizeFactoryDroidBindings({
      defaultModel: normalizedBindings.defaultModel
        ? resolveFactoryDroidBindingSelectionValue(normalizedBindings.defaultModel, allCustomModels, routeLookup)
        : "",
      missionOrchestratorModel: normalizedBindings.missionOrchestratorModel
        ? resolveFactoryDroidBindingSelectionValue(normalizedBindings.missionOrchestratorModel, allCustomModels, routeLookup)
        : "",
      missionWorkerModel: normalizedBindings.missionWorkerModel
        ? resolveFactoryDroidBindingSelectionValue(normalizedBindings.missionWorkerModel, allCustomModels, routeLookup)
        : "",
      missionValidatorModel: normalizedBindings.missionValidatorModel
        ? resolveFactoryDroidBindingSelectionValue(normalizedBindings.missionValidatorModel, allCustomModels, routeLookup)
        : "",
      reasoningEffort: normalizedBindings.reasoningEffort
    })
  };
}

export async function unpatchFactoryDroidSettingsFile({
  settingsFilePath = "",
  backupFilePath = "",
  homeDir = os.homedir()
} = {}) {
  const resolvedSettingsPath = path.resolve(String(settingsFilePath || resolveFactoryDroidSettingsFilePath({ homeDir })).trim());
  const resolvedBackupPath = path.resolve(String(backupFilePath || resolveCodingToolBackupFilePath(resolvedSettingsPath)).trim());
  const settingsState = await readJsonObjectFile(resolvedSettingsPath, `Factory Droid settings file '${resolvedSettingsPath}'`);
  const backupState = await readJsonObjectFile(resolvedBackupPath, `Backup file '${resolvedBackupPath}'`);
  const backup = sanitizeBackup(backupState.data, "factory-droid");
  const restoredSettings = applyFactoryDroidBackup(settingsState.data, backup);

  await writeJsonObjectFile(resolvedSettingsPath, restoredSettings);
  await writeJsonObjectFile(resolvedBackupPath, {});

  return {
    settingsFilePath: resolvedSettingsPath,
    backupFilePath: resolvedBackupPath,
    settingsExisted: settingsState.existed,
    backupRestored: backupHasData(backup)
  };
}
