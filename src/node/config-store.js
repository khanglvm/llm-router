/**
 * Local config persistence for the default and development config files.
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  CONFIG_VERSION,
  detectRuntimeConfigVersion,
  migrateRuntimeConfig,
  normalizeRuntimeConfig
} from "../runtime/config.js";
import { sanitizePersistedLocalServerConfig } from "./local-server-settings.js";

export const DEFAULT_CONFIG_FILENAME = ".llm-router.json";
export const DEFAULT_DEV_CONFIG_FILENAME = ".llm-router-dev.json";

export function getDefaultConfigPath() {
  return path.join(os.homedir(), DEFAULT_CONFIG_FILENAME);
}

export function getDefaultDevConfigPath() {
  return path.join(os.homedir(), DEFAULT_DEV_CONFIG_FILENAME);
}

function normalizePersistedConfig(config, normalizeOptions = undefined) {
  return sanitizePersistedLocalServerConfig(
    normalizeRuntimeConfig(config, normalizeOptions)
  );
}

export async function readConfigFileState(filePath = getDefaultConfigPath(), options = {}) {
  const autoMigrate = options.autoMigrate !== false;
  const persistMigrated = options.persistMigrated !== false;
  const migrateToVersion = options && Object.prototype.hasOwnProperty.call(options, "migrateToVersion")
    ? options.migrateToVersion
    : CONFIG_VERSION;
  const normalizeOptions = autoMigrate ? { migrateToVersion } : undefined;

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsedRaw = raw.trim() ? JSON.parse(raw) : {};
    const normalized = normalizePersistedConfig(parsedRaw, normalizeOptions);
    const payload = `${JSON.stringify(normalized, null, 2)}\n`;
    const changed = payload !== raw;
    let persisted = false;
    let persistError;

    if (autoMigrate && persistMigrated && changed) {
      try {
        await fs.writeFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
        await fs.chmod(filePath, 0o600);
        persisted = true;
      } catch (error) {
        persistError = error;
      }
    }

    return {
      config: normalized,
      exists: true,
      changed,
      persisted,
      persistError,
      beforeVersion: detectRuntimeConfigVersion(parsedRaw),
      afterVersion: normalized.version
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      const normalized = normalizePersistedConfig({}, normalizeOptions);
      return {
        config: normalized,
        exists: false,
        changed: false,
        persisted: false,
        persistError: undefined,
        beforeVersion: undefined,
        afterVersion: normalized.version
      };
    }
    throw error;
  }
}

export async function readConfigFile(filePath = getDefaultConfigPath(), options = {}) {
  const result = await readConfigFileState(filePath, options);
  return result.config;
}

export async function configFileExists(filePath = getDefaultConfigPath()) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function writeConfigFile(config, filePath = getDefaultConfigPath(), options = {}) {
  const normalizeOptions = options && Object.prototype.hasOwnProperty.call(options, "migrateToVersion")
    ? { migrateToVersion: options.migrateToVersion }
    : undefined;
  const normalized = normalizePersistedConfig(config, normalizeOptions);
  const folder = path.dirname(filePath);
  await fs.mkdir(folder, { recursive: true });
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  await fs.writeFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  return normalized;
}

function buildMigrationBackupPath(filePath, timestamp = new Date()) {
  const iso = timestamp.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `${filePath}.bak.${iso}`;
}

export async function migrateConfigFile(filePath = getDefaultConfigPath(), {
  targetVersion = CONFIG_VERSION,
  createBackup = true
} = {}) {
  const rawText = await fs.readFile(filePath, "utf8");
  const rawConfig = rawText.trim() ? JSON.parse(rawText) : {};
  const beforeVersion = detectRuntimeConfigVersion(rawConfig);
  const migratedRaw = migrateRuntimeConfig(rawConfig, { targetVersion });
  const normalized = normalizePersistedConfig(migratedRaw, { migrateToVersion: targetVersion });
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  const changed = payload !== rawText;

  let backupPath = "";
  if (changed && createBackup) {
    backupPath = buildMigrationBackupPath(filePath);
    await fs.writeFile(backupPath, rawText, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(backupPath, 0o600);
  }

  if (changed) {
    await fs.writeFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(filePath, 0o600);
  }

  return {
    beforeVersion,
    afterVersion: normalized.version,
    changed,
    backupPath: backupPath || undefined,
    config: normalized
  };
}

export function upsertProvider(config, provider) {
  const normalized = normalizeRuntimeConfig(config);
  const idx = normalized.providers.findIndex((item) => item.id === provider.id);
  if (idx >= 0) {
    normalized.providers[idx] = {
      ...normalized.providers[idx],
      ...provider
    };
  } else {
    normalized.providers.push(provider);
  }
  return normalizeRuntimeConfig(normalized);
}

export function setMasterKey(config, masterKey) {
  const normalized = normalizeRuntimeConfig(config);
  normalized.masterKey = masterKey;
  return normalized;
}

export function removeProvider(config, providerId) {
  const normalized = normalizeRuntimeConfig(config);
  normalized.providers = normalized.providers.filter((provider) => provider.id !== providerId);
  return normalizeRuntimeConfig(normalized);
}
