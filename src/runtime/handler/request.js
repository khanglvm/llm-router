import { FORMATS } from "../../translator/index.js";
import { toNonNegativeInteger } from "./utils.js";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const MIN_MAX_REQUEST_BODY_BYTES = 4 * 1024;
const MAX_MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;
const MIN_UPSTREAM_TIMEOUT_MS = 1_000;
const MAX_UPSTREAM_TIMEOUT_MS = 300_000;

export function resolveMaxRequestBodyBytes(env = {}) {
  const configured = toNonNegativeInteger(
    env?.LLM_ROUTER_MAX_REQUEST_BODY_BYTES,
    DEFAULT_MAX_REQUEST_BODY_BYTES
  );
  return Math.min(
    MAX_MAX_REQUEST_BODY_BYTES,
    Math.max(configured, MIN_MAX_REQUEST_BODY_BYTES)
  );
}

export function resolveUpstreamTimeoutMs(env = {}) {
  const configured = toNonNegativeInteger(
    env?.LLM_ROUTER_UPSTREAM_TIMEOUT_MS,
    DEFAULT_UPSTREAM_TIMEOUT_MS
  );
  return Math.min(
    MAX_UPSTREAM_TIMEOUT_MS,
    Math.max(configured, MIN_UPSTREAM_TIMEOUT_MS)
  );
}

function parseContentLength(value) {
  if (value === undefined || value === null || value === "") return -1;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return -1;
  return parsed;
}

function createRequestBodyTooLargeError(maxBytes) {
  const error = new Error(`Request body exceeds ${maxBytes} bytes.`);
  error.code = "REQUEST_BODY_TOO_LARGE";
  return error;
}

async function readRequestBodyWithLimit(request, maxBytes) {
  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength > maxBytes) {
    throw createRequestBodyTooLargeError(maxBytes);
  }

  if (!request.body || typeof request.body.getReader !== "function") {
    const raw = await request.text();
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (bytes > maxBytes) {
      throw createRequestBodyTooLargeError(maxBytes);
    }
    return raw;
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxBytes) {
      throw createRequestBodyTooLargeError(maxBytes);
    }
    body += decoder.decode(value, { stream: true });
  }

  body += decoder.decode();
  return body;
}

export async function parseJsonBodyWithLimit(request, maxBytes) {
  const raw = await readRequestBodyWithLimit(request, maxBytes);
  if (!raw || !raw.trim()) return {};
  return JSON.parse(raw);
}

export function isJsonRequest(request) {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  return contentType.includes("application/json") || contentType.includes("+json");
}

export function normalizePath(pathname) {
  if (!pathname) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function resolveApiRoute(pathname, method) {
  const path = normalizePath(pathname);
  const isGet = method === "GET";
  const isPost = method === "POST";

  if (isGet && ["/anthropic/v1/models", "/anthropic/models"].includes(path)) {
    return { type: "models", sourceFormat: FORMATS.CLAUDE };
  }

  if (isGet && ["/openai/v1/models", "/openai/models"].includes(path)) {
    return { type: "models", sourceFormat: FORMATS.OPENAI };
  }

  if (isGet && ["/v1/models", "/models"].includes(path)) {
    return { type: "models", sourceFormat: "auto" };
  }

  if (isPost && ["/v1/messages", "/messages", "/anthropic", "/anthropic/v1/messages", "/anthropic/messages"].includes(path)) {
    return { type: "route", sourceFormat: FORMATS.CLAUDE };
  }

  if (isPost && ["/v1/chat/completions", "/chat/completions", "/openai", "/openai/v1/chat/completions", "/openai/chat/completions"].includes(path)) {
    return { type: "route", sourceFormat: FORMATS.OPENAI };
  }

  // Unified root endpoint: infer user format from request payload/headers.
  if (isPost && ["/", "/v1", "/route", "/router"].includes(path)) {
    return { type: "route", sourceFormat: "auto" };
  }

  return null;
}

export function detectUserRequestFormat(request, body, fallback = FORMATS.CLAUDE) {
  const anthropicHeader = request.headers.get("anthropic-version") || request.headers.get("Anthropic-Version");
  if (anthropicHeader) return FORMATS.CLAUDE;

  if (!body || typeof body !== "object") return fallback;

  if (body.anthropic_version || body.anthropicVersion) return FORMATS.CLAUDE;
  if (body.max_completion_tokens !== undefined || body.response_format !== undefined || body.n !== undefined) {
    return FORMATS.OPENAI;
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object") continue;
      if (tool.input_schema) return FORMATS.CLAUDE;
      if (tool.type === "function" || tool.function) return FORMATS.OPENAI;
    }
  }

  if (body.tool_choice) {
    if (typeof body.tool_choice === "string") {
      if (["required", "none"].includes(body.tool_choice)) return FORMATS.OPENAI;
    } else if (typeof body.tool_choice === "object") {
      if (body.tool_choice.type === "function") return FORMATS.OPENAI;
      if (body.tool_choice.type === "any" || body.tool_choice.type === "tool") return FORMATS.CLAUDE;
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== "object") continue;
      if (msg.role === "tool" || msg.tool_call_id || Array.isArray(msg.tool_calls)) {
        return FORMATS.OPENAI;
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          if (["tool_use", "tool_result", "thinking", "redacted_thinking"].includes(block.type)) {
            return FORMATS.CLAUDE;
          }
          if (["image_url", "input_text", "input_image"].includes(block.type)) {
            return FORMATS.OPENAI;
          }
        }
      }
    }
  }

  if (body.system !== undefined) return FORMATS.CLAUDE;

  return fallback;
}

export function isStreamingEnabled(sourceFormat, body) {
  if (sourceFormat === FORMATS.OPENAI) {
    return Boolean(body?.stream);
  }
  // Follow Anthropic-compatible semantics: stream only when explicitly true.
  // Some clients omit `stream` on follow-up/tool turns and expect JSON responses.
  return body?.stream === true;
}
