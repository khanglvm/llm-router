/**
 * Local config persistence for ~/.llm-router.json.
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

export const DEFAULT_CONFIG_FILENAME = ".llm-router.json";

export function getDefaultConfigPath() {
  return path.join(os.homedir(), DEFAULT_CONFIG_FILENAME);
}

export async function readConfigFile(filePath = getDefaultConfigPath(), options = {}) {
  const autoMigrate = options.autoMigrate !== false;
  const persistMigrated = options.persistMigrated !== false;
  const migrateToVersion = options && Object.prototype.hasOwnProperty.call(options, "migrateToVersion")
    ? options.migrateToVersion
    : CONFIG_VERSION;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsedRaw = raw.trim() ? JSON.parse(raw) : {};
    const normalizeOptions = autoMigrate ? { migrateToVersion } : undefined;
    const normalized = normalizeRuntimeConfig(parsedRaw, normalizeOptions);

    if (autoMigrate && persistMigrated) {
      const payload = `${JSON.stringify(normalized, null, 2)}\n`;
      if (payload !== raw) {
        try {
          await fs.writeFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
          await fs.chmod(filePath, 0o600);
        } catch {
          // Silent best-effort persistence: keep migrated config in memory even if disk write fails.
        }
      }
    }

    return normalized;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      const normalizeOptions = autoMigrate ? { migrateToVersion } : undefined;
      return normalizeRuntimeConfig({}, normalizeOptions);
    }
    throw error;
  }
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
  const normalized = normalizeRuntimeConfig(config, normalizeOptions);
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
  const normalized = normalizeRuntimeConfig(migratedRaw, { migrateToVersion: targetVersion });
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
