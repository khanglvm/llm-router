/**
 * Local config persistence for ~/.llm-router.json.
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { normalizeRuntimeConfig } from "../runtime/config.js";

export const DEFAULT_CONFIG_FILENAME = ".llm-router.json";

export function getDefaultConfigPath() {
  return path.join(os.homedir(), DEFAULT_CONFIG_FILENAME);
}

export async function readConfigFile(filePath = getDefaultConfigPath()) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeRuntimeConfig(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return normalizeRuntimeConfig({});
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

export async function writeConfigFile(config, filePath = getDefaultConfigPath()) {
  const normalized = normalizeRuntimeConfig(config);
  const folder = path.dirname(filePath);
  await fs.mkdir(folder, { recursive: true });
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  await fs.writeFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  return normalized;
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
