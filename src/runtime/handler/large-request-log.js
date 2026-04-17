const DEFAULT_TEXT_ENCODER = new TextEncoder();

export const LARGE_REQUEST_LOG_ENABLED_ENV = "LLM_ROUTER_LOG_LARGE_REQUESTS";
export const LARGE_REQUEST_LOG_THRESHOLD_ENV = "LLM_ROUTER_LARGE_REQUEST_LOG_THRESHOLD_BYTES";
export const LARGE_REQUEST_LOG_PATH_ENV = "LLM_ROUTER_LARGE_REQUEST_LOG_PATH";
export const DEFAULT_LARGE_REQUEST_LOG_THRESHOLD_BYTES = 20 * 1024 * 1024;
const LARGE_STRING_HINT_THRESHOLD_BYTES = 256 * 1024;
const MAX_LARGE_STRING_HINTS = 8;
const MAX_SUMMARY_NODES = 50_000;

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function toPositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function appendToolType(target, value) {
  const normalized = String(value || "").trim();
  if (!normalized || target.includes(normalized)) return;
  target.push(normalized);
}

function classifyContentType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "image" || normalized === "image_url" || normalized === "input_image") return "image";
  if (normalized === "document" || normalized === "input_document") return "document";
  if (normalized === "audio" || normalized === "input_audio") return "audio";
  if (normalized === "file" || normalized === "input_file") return "file";
  if (normalized.includes("attachment")) return "attachment";
  return "";
}

function maybeRecordLargeString(summary, value, path, hintType = "string") {
  if (typeof value !== "string" || value.length === 0) return;
  const bytes = DEFAULT_TEXT_ENCODER.encode(value).byteLength;
  if (bytes > summary.largestStringBytes) {
    summary.largestStringBytes = bytes;
  }
  if (bytes < LARGE_STRING_HINT_THRESHOLD_BYTES) return;

  summary.largeStringCount += 1;
  summary.largeStringHints.push({
    path,
    bytes,
    type: hintType
  });
  summary.largeStringHints.sort((left, right) => right.bytes - left.bytes);
  if (summary.largeStringHints.length > MAX_LARGE_STRING_HINTS) {
    summary.largeStringHints.length = MAX_LARGE_STRING_HINTS;
  }
}

function summarizeProviderBody(body) {
  const toolTypes = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    appendToolType(toolTypes, tool?.type);
  }

  const summary = {
    topLevelKeys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort() : [],
    messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    inputCount: Array.isArray(body?.input) ? body.input.length : 0,
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    toolTypes,
    contentPartCount: 0,
    attachmentLikeParts: 0,
    imageParts: 0,
    documentParts: 0,
    audioParts: 0,
    fileParts: 0,
    dataUrlStrings: 0,
    base64SourceParts: 0,
    largeStringCount: 0,
    largestStringBytes: 0,
    largeStringHints: [],
    traversalTruncated: false
  };

  const stack = [{ value: body, path: "body" }];
  const seen = new WeakSet();
  let visited = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    visited += 1;
    if (visited > MAX_SUMMARY_NODES) {
      summary.traversalTruncated = true;
      break;
    }

    const value = current?.value;
    if (typeof value === "string") {
      const isDataUrl = value.startsWith("data:");
      if (isDataUrl) {
        summary.dataUrlStrings += 1;
      }
      maybeRecordLargeString(summary, value, current.path, isDataUrl ? "data-url" : "string");
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: value[index],
          path: `${current.path}[${index}]`
        });
      }
      continue;
    }

    const contentType = classifyContentType(value.type);
    if (contentType) {
      summary.attachmentLikeParts += 1;
      if (contentType === "image") summary.imageParts += 1;
      if (contentType === "document") summary.documentParts += 1;
      if (contentType === "audio") summary.audioParts += 1;
      if (contentType === "file" || contentType === "attachment") summary.fileParts += 1;
    }
    if (value?.source && typeof value.source === "object") {
      const sourceType = String(value.source.type || "").trim().toLowerCase();
      if (sourceType === "base64") {
        summary.base64SourceParts += 1;
        maybeRecordLargeString(summary, value.source.data, `${current.path}.source.data`, "base64");
      }
    }

    for (const [key, child] of Object.entries(value)) {
      const childPath = `${current.path}.${key}`;
      if (typeof child === "string") {
        const hintType = key === "data"
          ? "data"
          : (key === "text" ? "text" : "string");
        const isDataUrl = child.startsWith("data:");
        if (isDataUrl) {
          summary.dataUrlStrings += 1;
        }
        maybeRecordLargeString(summary, child, childPath, isDataUrl ? "data-url" : hintType);
        continue;
      }
      if (key === "content" && Array.isArray(child)) {
        summary.contentPartCount += child.length;
      }
      stack.push({
        value: child,
        path: childPath
      });
    }
  }

  return summary;
}

export function isLargeRequestLoggingEnabled(env = {}) {
  return toBoolean(env?.[LARGE_REQUEST_LOG_ENABLED_ENV], false);
}

export function resolveLargeRequestLogThresholdBytes(env = {}) {
  return toPositiveInteger(
    env?.[LARGE_REQUEST_LOG_THRESHOLD_ENV],
    DEFAULT_LARGE_REQUEST_LOG_THRESHOLD_BYTES
  );
}

export function measureSerializedRequestBytes(serializedBody = "") {
  return DEFAULT_TEXT_ENCODER.encode(String(serializedBody || "")).byteLength;
}

export function buildLargeRequestLogEntry({
  providerBody,
  requestBytes,
  thresholdBytes,
  providerUrl,
  candidate,
  sourceFormat,
  targetFormat,
  requestKind,
  clientType,
  stream,
  providerType = "http"
} = {}) {
  return {
    kind: "large-provider-request",
    providerType: String(providerType || "http").trim() || "http",
    requestBytes: Number.isFinite(Number(requestBytes)) ? Number(requestBytes) : 0,
    thresholdBytes: Number.isFinite(Number(thresholdBytes)) ? Number(thresholdBytes) : DEFAULT_LARGE_REQUEST_LOG_THRESHOLD_BYTES,
    providerUrl: String(providerUrl || "").trim(),
    clientType: String(clientType || "").trim(),
    stream: Boolean(stream),
    sourceFormat: String(sourceFormat || "").trim(),
    targetFormat: String(targetFormat || "").trim(),
    requestKind: String(requestKind || "").trim(),
    requestedModel: String(candidate?.requestModelId || "").trim(),
    providerId: String(candidate?.providerId || candidate?.provider?.id || "").trim(),
    backendModel: String(candidate?.backend || candidate?.modelId || providerBody?.model || "").trim(),
    bodySummary: summarizeProviderBody(providerBody)
  };
}
