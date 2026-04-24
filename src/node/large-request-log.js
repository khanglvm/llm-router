import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  LARGE_REQUEST_LOG_PATH_ENV
} from "../runtime/handler/large-request-log.js";

export const DEFAULT_LARGE_REQUEST_LOG_FILENAME = ".llm-router.large-requests.jsonl";

function normalizeText(value, fallback = "") {
  const text = String(value ?? fallback).trim();
  return text || fallback;
}

function createEntryId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function resolveLargeRequestLogPath(configPath = "", explicitPath = "", env = process.env) {
  const envOverride = String(env?.[LARGE_REQUEST_LOG_PATH_ENV] || "").trim();
  const override = String(explicitPath || envOverride).trim();
  if (override) return path.resolve(override);

  const resolvedConfigPath = String(configPath || "").trim();
  if (resolvedConfigPath) {
    const absoluteConfigPath = path.resolve(resolvedConfigPath);
    const configDir = path.dirname(absoluteConfigPath);
    const configName = path.basename(absoluteConfigPath);
    const stem = configName
      .replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return path.join(configDir, `.${stem || "llm-router"}.large-requests.jsonl`);
  }

  return path.join(os.homedir(), DEFAULT_LARGE_REQUEST_LOG_FILENAME);
}

export function createLargeRequestLogEntry(entry = {}) {
  return {
    id: normalizeText(entry.id) || createEntryId(),
    time: normalizeText(entry.time) || new Date().toISOString(),
    ...entry
  };
}

export async function appendLargeRequestLogEntry(filePath, entry) {
  const targetPath = resolveLargeRequestLogPath("", filePath);
  const normalized = createLargeRequestLogEntry(entry);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.appendFile(targetPath, `${JSON.stringify(normalized)}\n`, { encoding: "utf8", mode: 0o600 });
  return normalized;
}
