import { FORMATS } from "../../translator/index.js";

const PROMPT_CACHE_KEY_HEADERS = [
  "x-prompt-cache-key",
  "prompt-cache-key",
  "x-openai-prompt-cache-key",
  "openai-prompt-cache-key"
];

const PROMPT_CACHE_RETENTION_HEADERS = [
  "x-prompt-cache-retention",
  "prompt-cache-retention",
  "x-openai-prompt-cache-retention",
  "openai-prompt-cache-retention"
];

function readHeaderValue(headers, name) {
  if (!headers || !name) return "";
  if (typeof headers.get === "function") {
    return String(headers.get(name) || "").trim();
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() !== String(name).toLowerCase()) continue;
      return String(value || "").trim();
    }
  }
  return "";
}

function readFirstHeaderValue(headers, names = []) {
  for (const name of names) {
    const value = readHeaderValue(headers, name);
    if (value) return value;
  }
  return "";
}

function normalizePromptCacheRetention(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return "";
  if (normalized === "24h" || normalized === "extended") return "24h";
  if (["in_memory", "memory", "default", "5m", "1h"].includes(normalized)) {
    return "in_memory";
  }
  return "";
}

function normalizeClaudeCacheControl(cacheControl) {
  if (!cacheControl || typeof cacheControl !== "object" || Array.isArray(cacheControl)) return null;
  const type = String(cacheControl.type || "").trim().toLowerCase();
  if (type && type !== "ephemeral") return null;

  const ttlRaw = String(cacheControl.ttl || "").trim().toLowerCase();
  let ttl = "";
  if (ttlRaw === "1h" || ttlRaw === "60m") ttl = "1h";
  if (ttlRaw === "5m" || ttlRaw === "300s") ttl = "5m";

  return ttl
    ? { type: "ephemeral", ttl }
    : { type: "ephemeral" };
}

function eachContentBlock(body, callback) {
  if (!body || typeof body !== "object" || typeof callback !== "function") return;

  const visitBlockArray = (blocks, context) => {
    if (!Array.isArray(blocks)) return;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (!block || typeof block !== "object") continue;
      callback(block, { ...context, index });
    }
  };

  if (Array.isArray(body.system)) {
    visitBlockArray(body.system, { container: "system" });
  }

  if (Array.isArray(body.messages)) {
    for (let messageIndex = 0; messageIndex < body.messages.length; messageIndex += 1) {
      const message = body.messages[messageIndex];
      if (!message || typeof message !== "object") continue;
      if (Array.isArray(message.content)) {
        visitBlockArray(message.content, {
          container: "messages",
          messageIndex,
          role: message.role || ""
        });
      }
    }
  }
}

function eachTool(body, callback) {
  if (!body || typeof body !== "object" || typeof callback !== "function") return;
  if (!Array.isArray(body.tools)) return;
  for (let index = 0; index < body.tools.length; index += 1) {
    const tool = body.tools[index];
    if (!tool || typeof tool !== "object") continue;
    callback(tool, index);
  }
}

function detectClaudeCacheControl(body) {
  const topLevel = normalizeClaudeCacheControl(body?.cache_control);
  if (topLevel) return topLevel;

  let found = null;
  eachContentBlock(body, (block) => {
    if (found) return;
    const normalized = normalizeClaudeCacheControl(block.cache_control);
    if (normalized) found = normalized;
  });
  if (found) return found;

  eachTool(body, (tool) => {
    if (found) return;
    const normalized = normalizeClaudeCacheControl(tool.cache_control);
    if (normalized) found = normalized;
  });
  return found;
}

function hasClaudeCacheMarkers(body) {
  return Boolean(detectClaudeCacheControl(body));
}

function resolvePromptCacheKey(originalBody, requestHeaders) {
  const bodyValue = typeof originalBody?.prompt_cache_key === "string"
    ? originalBody.prompt_cache_key.trim()
    : "";
  if (bodyValue) return bodyValue;
  return readFirstHeaderValue(requestHeaders, PROMPT_CACHE_KEY_HEADERS);
}

function resolvePromptCacheRetention(originalBody, requestHeaders) {
  const bodyValue = normalizePromptCacheRetention(originalBody?.prompt_cache_retention);
  if (bodyValue) return bodyValue;
  const headerValue = readFirstHeaderValue(requestHeaders, PROMPT_CACHE_RETENTION_HEADERS);
  return normalizePromptCacheRetention(headerValue);
}

function mapOpenAIRetentionToClaudeCacheControl(retention) {
  const normalized = normalizePromptCacheRetention(retention);
  if (normalized === "24h") {
    return { type: "ephemeral", ttl: "1h" };
  }
  if (normalized === "in_memory") {
    return { type: "ephemeral" };
  }
  return null;
}

function stableSerialize(value, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return "\"[depth-limit]\"";
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item, depth + 1, maxDepth)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${stableSerialize(value[key], depth + 1, maxDepth)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function buildDeterministicPromptCacheKey(originalBody = {}) {
  const keyBasis = {
    model: originalBody.model || "",
    cache_control: originalBody.cache_control || null,
    system: originalBody.system || null,
    tools: originalBody.tools || null,
    messages: originalBody.messages || null
  };
  const serialized = stableSerialize(keyBasis).slice(0, 20_000);
  return `llm-router:${fnv1a32(serialized)}`;
}

function mergeCsvHeaderValue(current, incoming) {
  const currentItems = String(current || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const incomingItems = String(incoming || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = [...new Set([...currentItems, ...incomingItems])];
  return merged.join(", ");
}

function setHeaderValue(headers, name, value, { append = false } = {}) {
  if (!headers || !name || value === undefined || value === null || value === "") return;
  if (append) {
    const existing = headers[name];
    headers[name] = existing ? mergeCsvHeaderValue(existing, value) : String(value);
    return;
  }
  headers[name] = String(value);
}

export function mergeCachingHeaders(providerHeaders, requestHeaders, targetFormat) {
  const headers = { ...(providerHeaders || {}) };
  if (!requestHeaders) return headers;

  const cacheKeyHeader = readFirstHeaderValue(requestHeaders, PROMPT_CACHE_KEY_HEADERS);
  if (cacheKeyHeader && !headers["x-prompt-cache-key"] && !headers["X-Prompt-Cache-Key"]) {
    setHeaderValue(headers, "x-prompt-cache-key", cacheKeyHeader);
  }

  const cacheRetentionHeader = readFirstHeaderValue(requestHeaders, PROMPT_CACHE_RETENTION_HEADERS);
  if (cacheRetentionHeader && !headers["x-prompt-cache-retention"] && !headers["X-Prompt-Cache-Retention"]) {
    setHeaderValue(headers, "x-prompt-cache-retention", cacheRetentionHeader);
  }

  if (targetFormat === FORMATS.CLAUDE) {
    const anthropicBeta = readHeaderValue(requestHeaders, "anthropic-beta");
    if (anthropicBeta) {
      setHeaderValue(headers, "anthropic-beta", anthropicBeta, { append: true });
    }

    const anthropicVersion = readFirstHeaderValue(requestHeaders, ["anthropic-version", "Anthropic-Version"]);
    if (anthropicVersion) {
      setHeaderValue(headers, "anthropic-version", anthropicVersion);
    }
  }

  return headers;
}

export function applyCachingMapping({
  originalBody,
  providerBody,
  sourceFormat,
  targetFormat,
  requestHeaders
}) {
  const nextBody = { ...(providerBody || {}) };

  if (targetFormat === FORMATS.CLAUDE) {
    const normalizedProviderCacheControl = normalizeClaudeCacheControl(nextBody.cache_control);
    if (normalizedProviderCacheControl) {
      nextBody.cache_control = normalizedProviderCacheControl;
      return nextBody;
    }

    const sourceCacheControl = normalizeClaudeCacheControl(originalBody?.cache_control);
    if (sourceCacheControl) {
      nextBody.cache_control = sourceCacheControl;
      return nextBody;
    }

    if (sourceFormat === FORMATS.OPENAI) {
      const retention = resolvePromptCacheRetention(originalBody, requestHeaders);
      const promptCacheKey = resolvePromptCacheKey(originalBody, requestHeaders);
      const mapped = mapOpenAIRetentionToClaudeCacheControl(retention);
      if (mapped) {
        nextBody.cache_control = mapped;
      } else if (promptCacheKey) {
        nextBody.cache_control = { type: "ephemeral" };
      }
    }

    return nextBody;
  }

  if (targetFormat === FORMATS.OPENAI) {
    if (!nextBody.prompt_cache_key) {
      const promptCacheKey = resolvePromptCacheKey(originalBody, requestHeaders);
      if (promptCacheKey) {
        nextBody.prompt_cache_key = promptCacheKey;
      } else if (sourceFormat === FORMATS.CLAUDE && hasClaudeCacheMarkers(originalBody)) {
        nextBody.prompt_cache_key = buildDeterministicPromptCacheKey(originalBody);
      }
    }

    if (!nextBody.prompt_cache_retention) {
      const retention = resolvePromptCacheRetention(originalBody, requestHeaders);
      if (retention) {
        nextBody.prompt_cache_retention = retention;
      } else if (sourceFormat === FORMATS.CLAUDE && hasClaudeCacheMarkers(originalBody)) {
        nextBody.prompt_cache_retention = "in_memory";
      }
    }

    return nextBody;
  }

  return nextBody;
}
