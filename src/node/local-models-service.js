import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { normalizeLocalModelsMetadata } from "../runtime/local-models.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneConfig(config) {
  return isPlainObject(config) ? structuredClone(config) : {};
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeManagedMetadata(metadata) {
  return isPlainObject(metadata) ? metadata : {};
}

function ensureLocalModelsState(config) {
  const next = cloneConfig(config);
  next.metadata = isPlainObject(next.metadata) ? next.metadata : {};
  next.metadata.localModels = normalizeLocalModelsMetadata(next.metadata.localModels);
  return next;
}

async function defaultPathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function getManagedLocalModelsDir({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, ".llm-router", "local-models");
}

export async function registerAttachedLlamacppModel(config, {
  id,
  displayName,
  filePath,
  metadata = {}
} = {}) {
  const baseModelId = normalizeString(id);
  const modelPath = normalizeString(filePath);
  const label = normalizeString(displayName);

  if (!baseModelId) throw new Error("Attached local model id is required.");
  if (!modelPath) throw new Error("Attached local model path is required.");

  const next = ensureLocalModelsState(config);
  next.metadata.localModels.library[baseModelId] = {
    id: baseModelId,
    source: "llamacpp-attached",
    displayName: label || baseModelId,
    path: modelPath,
    availability: "available",
    metadata: isPlainObject(metadata) ? metadata : {},
    managed: false
  };

  return next;
}

export async function registerManagedLlamacppModel(config, {
  id,
  displayName,
  filePath,
  repo = "",
  file = "",
  sizeBytes = undefined,
  metadata = {}
} = {}) {
  const baseModelId = normalizeString(id);
  const modelPath = normalizeString(filePath);
  const label = normalizeString(displayName);

  if (!baseModelId) throw new Error("Managed local model id is required.");
  if (!modelPath) throw new Error("Managed local model path is required.");

  const next = ensureLocalModelsState(config);
  next.metadata.localModels.library[baseModelId] = {
    id: baseModelId,
    source: "llamacpp-managed",
    displayName: label || baseModelId,
    path: modelPath,
    availability: "available",
    metadata: {
      ...normalizeManagedMetadata(metadata),
      repo: normalizeString(repo),
      file: normalizeString(file),
      ...(Number.isFinite(Number(sizeBytes)) ? { sizeBytes: Number(sizeBytes) } : {})
    },
    managed: true
  };

  return next;
}

export async function reconcileLocalModelPaths(config, {
  pathExists = defaultPathExists
} = {}) {
  const next = ensureLocalModelsState(config);
  const { library, variants } = next.metadata.localModels;

  for (const baseModel of Object.values(library)) {
    const baseModelPath = normalizeString(baseModel?.path);
    if (!baseModelPath) {
      baseModel.availability = "stale";
      continue;
    }

    const exists = await pathExists(baseModelPath);
    baseModel.availability = exists ? "available" : "stale";
  }

  for (const variant of Object.values(variants)) {
    const baseModel = library[variant?.baseModelId];
    variant.availability = baseModel?.availability || "stale";
  }

  return next;
}

export async function removeLocalBaseModel(config, baseModelId) {
  const targetId = normalizeString(baseModelId);
  const next = ensureLocalModelsState(config);

  if (!targetId) return next;

  delete next.metadata.localModels.library[targetId];
  for (const [variantKey, variant] of Object.entries(next.metadata.localModels.variants)) {
    if (variant?.baseModelId === targetId) {
      delete next.metadata.localModels.variants[variantKey];
    }
  }

  return next;
}
