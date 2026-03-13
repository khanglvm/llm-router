import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

export const DEFAULT_ACTIVITY_LOG_FILENAME = ".llm-router.activity.jsonl";
export const ACTIVITY_LOG_CATEGORIES = Object.freeze({
  USAGE: "usage",
  ROUTER: "router"
});

function normalizeLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["info", "success", "warn", "error"].includes(normalized)) return normalized;
  return "info";
}

function normalizeText(value, fallback = "") {
  const text = String(value ?? fallback).trim();
  return text || fallback;
}

function normalizeCategory(value, source = "", kind = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === ACTIVITY_LOG_CATEGORIES.USAGE || normalized === ACTIVITY_LOG_CATEGORIES.ROUTER) {
    return normalized;
  }

  const normalizedSource = String(source || "").trim().toLowerCase();
  const normalizedKind = String(kind || "").trim().toLowerCase();
  if (normalizedSource === "runtime" || normalizedKind.startsWith("request") || normalizedKind.startsWith("fallback")) {
    return ACTIVITY_LOG_CATEGORIES.USAGE;
  }
  return ACTIVITY_LOG_CATEGORIES.ROUTER;
}

export function resolveActivityLogPath(configPath = "", explicitPath = "") {
  const override = String(explicitPath || "").trim();
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
    return path.join(configDir, `.${stem || "llm-router"}.activity.jsonl`);
  }

  return path.join(os.homedir(), DEFAULT_ACTIVITY_LOG_FILENAME);
}

export function createActivityLogEntry({
  id = "",
  time = "",
  level = "info",
  message = "",
  detail = "",
  source = "web-console",
  kind = "",
  category = ""
} = {}) {
  const entryId = normalizeText(id) || `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const entryTime = normalizeText(time) || new Date().toISOString();
  const normalizedSource = normalizeText(source, "web-console");
  const normalizedKind = normalizeText(kind);

  return {
    id: entryId,
    time: entryTime,
    level: normalizeLevel(level),
    message: normalizeText(message),
    detail: normalizeText(detail),
    source: normalizedSource,
    kind: normalizedKind,
    category: normalizeCategory(category, normalizedSource, normalizedKind)
  };
}

export async function appendActivityLogEntry(filePath, entry) {
  const targetPath = resolveActivityLogPath("", filePath);
  const normalized = createActivityLogEntry(entry);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.appendFile(targetPath, `${JSON.stringify(normalized)}\n`, { encoding: "utf8", mode: 0o600 });
  return normalized;
}

export async function readActivityLogEntries(filePath, { limit = 150 } = {}) {
  const targetPath = resolveActivityLogPath("", filePath);
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    const entries = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return createActivityLogEntry(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return entries.slice(-Math.max(1, limit)).reverse();
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function clearActivityLogFile(filePath) {
  const targetPath = resolveActivityLogPath("", filePath);
  await fs.rm(targetPath, { force: true });
}
