import { createMemoryStateStore } from "./state-store.memory.js";

function sanitizeKeyPart(value, fallback = "unknown") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return encodeURIComponent(text);
}

function hasStateStoreShape(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.getRouteCursor === "function" &&
    typeof value.setRouteCursor === "function" &&
    typeof value.getCandidateState === "function" &&
    typeof value.setCandidateState === "function" &&
    typeof value.readBucketUsage === "function" &&
    typeof value.incrementBucketUsage === "function" &&
    typeof value.pruneExpired === "function"
  );
}

export function normalizeStateStoreBackend(value, fallback = "memory") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "file") return "file";
  return fallback;
}

export function buildRouteKey(route, { sourceFormat } = {}) {
  if (typeof route === "string") {
    return `route:${sanitizeKeyPart(route)}`;
  }

  const routeType = sanitizeKeyPart(route?.routeType || "direct", "direct");
  const routeRef = sanitizeKeyPart(
    route?.routeRef || route?.resolvedModel || route?.requestedModel || "smart",
    "smart"
  );
  const format = sanitizeKeyPart(
    sourceFormat || route?.sourceFormat || route?.targetFormat || "auto",
    "auto"
  );
  return `route:${routeType}:${routeRef}@${format}`;
}

export function buildCandidateKey(candidate, { sourceFormat } = {}) {
  const modelRef = candidate?.requestModelId ||
    (candidate?.providerId && candidate?.modelId
      ? `${candidate.providerId}/${candidate.modelId}`
      : candidate?.backend || "unknown/unknown");
  const format = sourceFormat || candidate?.targetFormat || "auto";
  return `candidate:${sanitizeKeyPart(modelRef)}@${sanitizeKeyPart(format, "auto")}`;
}

export function buildBucketUsageKey(providerId, bucketId) {
  const provider = sanitizeKeyPart(providerId || "provider");
  const bucket = sanitizeKeyPart(bucketId || "bucket");
  return `bucket:${provider}:${bucket}`;
}

export async function createStateStore(options = {}) {
  if (hasStateStoreShape(options)) {
    return options;
  }

  const backend = normalizeStateStoreBackend(options.backend || options.type);
  if (backend === "file") {
    const { createFileStateStore } = await import("./state-store.file.js");
    return createFileStateStore(options);
  }

  return createMemoryStateStore(options);
}

