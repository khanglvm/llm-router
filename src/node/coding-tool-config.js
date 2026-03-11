import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

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
  "CLAUDE_CODE_SUBAGENT_MODEL"
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
    subagentModel: normalizeModelBinding(source.subagentModel)
  };
}

function normalizeCodexBindings(bindings = {}) {
  const source = bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings : {};
  return {
    defaultModel: normalizeModelBinding(source.defaultModel)
  };
}

function captureCodexBackup(document) {
  const providerSection = getTomlSection(document, `model_providers.${CODEX_PROVIDER_ID}`);
  return {
    tool: "codex-cli",
    version: 1,
    modelProvider: getTopLevelTomlStringField(document, "model_provider"),
    model: getTopLevelTomlStringField(document, "model"),
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
  for (const key of CLAUDE_BACKUP_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      backupEnv[key] = getBackupValue(env[key]);
    }
  }
  return {
    tool: "claude-code",
    version: 1,
    env: backupEnv
  };
}

function applyClaudeBackup(config, backup = {}) {
  const next = config && typeof config === "object" && !Array.isArray(config)
    ? structuredClone(config)
    : {};
  const env = next.env && typeof next.env === "object" && !Array.isArray(next.env)
    ? { ...next.env }
    : {};

  for (const key of CLAUDE_BACKUP_ENV_KEYS) {
    if (backup?.env && Object.prototype.hasOwnProperty.call(backup.env, key)) {
      applyBackupValue(env, key, backup.env[key]);
    } else {
      delete env[key];
    }
  }

  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  return next;
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
  return `${path.resolve(String(configFilePath || "").trim())}${BACKUP_SUFFIX}`;
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
  const providerSection = parseTomlSectionKeyValues(getTomlSection(document, `model_providers.${CODEX_PROVIDER_ID}`));
  const configuredBaseUrl = String(providerSection.base_url || "").trim();
  const configuredBearerToken = String(providerSection.experimental_bearer_token || "").trim();
  const routedViaRouter = Boolean(
    expectedBaseUrl
      && modelProvider.value === CODEX_PROVIDER_ID
      && configuredBaseUrl === expectedBaseUrl
  );

  return {
    tool: "codex-cli",
    configFilePath: resolvedConfigPath,
    backupFilePath: resolvedBackupPath,
    configExists: configState.existed,
    backupExists: backupState.existed,
    routedViaRouter,
    configuredBaseUrl,
    modelProvider: modelProvider.value,
    bindings: {
      defaultModel: model.value
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

  if (captureBackup && !backupHasData(existingBackup)) {
    const backup = configState.existed ? captureCodexBackup(document) : {};
    await writeJsonObjectFile(resolvedBackupPath, backup);
  }

  setTopLevelTomlStringField(document, "model_provider", CODEX_PROVIDER_ID);
  if (normalizedBindings.defaultModel) setTopLevelTomlStringField(document, "model", normalizedBindings.defaultModel);
  setTomlSection(document, `model_providers.${CODEX_PROVIDER_ID}`, createCodexProviderSection({
    baseUrl,
    apiKey: normalizedApiKey
  }));
  if (normalizedModelCatalog) {
    if (normalizedModelCatalog.models.length > 0) {
      await writeJsonObjectFile(resolvedCatalogPath, normalizedModelCatalog);
      setTopLevelTomlStringField(document, "model_catalog_json", resolvedCatalogPath);
    } else {
      deleteTopLevelTomlField(document, "model_catalog_json");
      await fs.rm(resolvedCatalogPath, { force: true });
    }
  }

  await writeTextFile(resolvedConfigPath, serializeTomlDocument(document));
  return {
    configFilePath: resolvedConfigPath,
    backupFilePath: resolvedBackupPath,
    modelCatalogFilePath: normalizedModelCatalog?.models?.length > 0 ? resolvedCatalogPath : "",
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
      subagentModel: envConfig.CLAUDE_CODE_SUBAGENT_MODEL
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

  await writeJsonObjectFile(resolvedSettingsPath, nextSettings);
  return {
    settingsFilePath: resolvedSettingsPath,
    backupFilePath: resolvedBackupPath,
    settingsCreated: !settingsState.existed,
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

  await writeJsonObjectFile(resolvedSettingsPath, restoredSettings);
  await writeJsonObjectFile(resolvedBackupPath, {});

  return {
    settingsFilePath: resolvedSettingsPath,
    backupFilePath: resolvedBackupPath,
    settingsExisted: settingsState.existed,
    backupRestored: backupHasData(backup)
  };
}
