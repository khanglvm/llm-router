import { FORMATS } from "../../translator/index.js";
import { extractAmpGeminiRouteInfo } from "./amp-gemini.js";
import { toNonNegativeInteger } from "./utils.js";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const DEFAULT_RESPONSES_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const MIN_MAX_REQUEST_BODY_BYTES = 4 * 1024;
const MAX_MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;
const MIN_UPSTREAM_TIMEOUT_MS = 1_000;
const MAX_UPSTREAM_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_TOKEN_RESERVE = 1_024;
const AMP_ANTHROPIC_CONTEXT_BASELINE_TOKENS = 200_000;
const AMP_ANTHROPIC_CONTEXT_1M_TOKENS = 1_000_000;
const AMP_ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";
const AMP_CONTEXT_HINTS_BY_MODEL = new Map([
  ["free", { minimumContextTokens: 136_000, source: "amp:model:free" }],
  ["rush", { minimumContextTokens: 136_000, source: "amp:model:rush" }],
  ["smart", { minimumContextTokens: 168_000, source: "amp:model:smart" }],
  ["deep", { minimumContextTokens: 272_000, source: "amp:model:deep" }],
  ["large", { minimumContextTokens: 936_000, source: "amp:model:large" }],
  ["claude-haiku-4-5-20251001", { minimumContextTokens: 136_000, source: "amp:model:claude-haiku-4-5-20251001" }],
  ["claude-opus-4-6", { minimumContextTokens: 168_000, source: "amp:model:claude-opus-4-6" }],
  ["openai/gpt-5.3-codex", { minimumContextTokens: 272_000, source: "amp:model:openai/gpt-5.3-codex" }],
  ["claude-sonnet-4-6", { minimumContextTokens: 936_000, source: "amp:model:claude-sonnet-4-6" }],
  ["gpt-5.3-codex", { minimumContextTokens: 968_000, source: "amp:model:gpt-5.3-codex" }]
]);
const AMP_API_PROVIDER_PREFIX = "/api/provider/";
const AMP_MANAGEMENT_ROOT_PREFIXES = [
  "/auth",
  "/threads",
  "/docs",
  "/settings"
];
const AMP_MANAGEMENT_ROOT_EXACT_PATHS = new Set([
  "/threads.rss",
  "/news.rss"
]);
const AMP_MANAGEMENT_API_PREFIXES = [
  "/api/auth",
  "/api/user",
  "/api/threads",
  "/api/meta",
  "/api/internal",
  "/api/otel",
  "/api/tab",
  "/api/docs",
  "/api/settings"
];

function hasPathPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function resolveAmpProviderRoute(path, method) {
  const isGet = method === "GET";
  const isPost = method === "POST";

  const geminiRoute = extractAmpGeminiRouteInfo(path);
  if (geminiRoute) {
    if (geminiRoute.type === "models" && isGet) {
      return { type: "amp-gemini-models", clientType: "amp", providerHint: "google", requestKind: "gemini-models" };
    }
    if (geminiRoute.type === "model" && isGet) {
      return { type: "amp-gemini-model", clientType: "amp", providerHint: "google", requestKind: "gemini-model", modelHint: geminiRoute.model };
    }
    if (geminiRoute.type === "request" && isPost) {
      return {
        type: "amp-gemini",
        clientType: "amp",
        providerHint: "google",
        requestKind: "gemini",
        modelHint: geminiRoute.model,
        methodHint: geminiRoute.method,
        streamHint: geminiRoute.stream
      };
    }
  }

  if (!path.startsWith(AMP_API_PROVIDER_PREFIX)) return null;

  const suffix = path.slice(AMP_API_PROVIDER_PREFIX.length);
  const slashIndex = suffix.indexOf("/");
  if (slashIndex <= 0) return null;

  const providerHint = suffix.slice(0, slashIndex).trim().toLowerCase();
  const providerPath = `/${suffix.slice(slashIndex + 1)}`;

  if (isGet && ["/models", "/v1/models"].includes(providerPath)) {
    return {
      type: "models",
      sourceFormat: providerHint === "anthropic" ? FORMATS.CLAUDE : FORMATS.OPENAI,
      clientType: "amp",
      providerHint,
      requestKind: "models"
    };
  }

  if (providerHint === "google") {
    return {
      type: "amp-proxy",
      clientType: "amp",
      providerHint,
      requestKind: "gemini-upstream-fallback"
    };
  }

  if (!isPost) return null;

  if (["/messages", "/v1/messages"].includes(providerPath)) {
    return {
      type: "route",
      sourceFormat: FORMATS.CLAUDE,
      clientType: "amp",
      providerHint,
      requestKind: "messages"
    };
  }

  if (["/chat/completions", "/v1/chat/completions"].includes(providerPath)) {
    return {
      type: "route",
      sourceFormat: FORMATS.OPENAI,
      clientType: "amp",
      providerHint,
      requestKind: "chat-completions"
    };
  }

  if (["/completions", "/v1/completions"].includes(providerPath)) {
    return {
      type: "route",
      sourceFormat: FORMATS.OPENAI,
      clientType: "amp",
      providerHint,
      requestKind: "completions"
    };
  }

  if (["/responses", "/v1/responses"].includes(providerPath)) {
    return {
      type: "route",
      sourceFormat: FORMATS.OPENAI,
      clientType: "amp",
      providerHint,
      requestKind: "responses"
    };
  }

  return null;
}

export function resolveMaxRequestBodyBytes(env = {}, options = {}) {
  const requestKind = String(options?.requestKind || "").trim().toLowerCase();
  const fallbackLimit = requestKind === "responses"
    ? DEFAULT_RESPONSES_MAX_REQUEST_BODY_BYTES
    : DEFAULT_MAX_REQUEST_BODY_BYTES;
  const configured = toNonNegativeInteger(
    env?.LLM_ROUTER_MAX_REQUEST_BODY_BYTES,
    fallbackLimit
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

function parseNonNegativeNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseHeaderTokenList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function lookupAmpContextHint(model) {
  const key = String(model || "").trim().toLowerCase();
  if (!key) return null;
  return AMP_CONTEXT_HINTS_BY_MODEL.get(key) || null;
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

export function estimateRequestContextTokens(body = {}) {
  if (!body || typeof body !== "object") {
    return {
      estimatedInputTokens: 0,
      requestedOutputTokens: 0,
      safetyPaddingTokens: 0,
      estimatedRequiredTokens: 0
    };
  }

  let serialized = "";
  try {
    serialized = JSON.stringify(body) || "";
  } catch {
    serialized = "";
  }

  const charLength = serialized.length;
  const byteLength = serialized
    ? new TextEncoder().encode(serialized).byteLength
    : 0;
  const estimatedInputTokens = Math.max(
    Math.ceil(charLength / 4),
    Math.ceil(byteLength / 3)
  );

  const explicitOutputTokens = Math.max(
    parseNonNegativeNumber(body?.max_output_tokens),
    parseNonNegativeNumber(body?.max_completion_tokens),
    parseNonNegativeNumber(body?.max_tokens)
  );
  const requestedOutputTokens = explicitOutputTokens > 0
    ? explicitOutputTokens
    : DEFAULT_OUTPUT_TOKEN_RESERVE;
  const safetyPaddingTokens = estimatedInputTokens > 0
    ? Math.max(256, Math.ceil(estimatedInputTokens * 0.1))
    : 0;

  return {
    estimatedInputTokens,
    requestedOutputTokens,
    safetyPaddingTokens,
    estimatedRequiredTokens: estimatedInputTokens + requestedOutputTokens + safetyPaddingTokens
  };
}

export function inferAmpContextRequirement(request, body = {}, options = {}) {
  if (String(options?.clientType || "").trim().toLowerCase() !== "amp") {
    return {
      minimumContextTokens: 0,
      source: ""
    };
  }

  const providerHint = String(options?.providerHint || "").trim().toLowerCase();
  const requestKind = String(options?.requestKind || "").trim().toLowerCase();
  const requestedModelHint = lookupAmpContextHint(body?.model);
  const anthropicBetaFlags = parseHeaderTokenList(
    request?.headers?.get("anthropic-beta") || request?.headers?.get("Anthropic-Beta")
  );

  if (anthropicBetaFlags.includes(AMP_ANTHROPIC_CONTEXT_1M_BETA)) {
    return {
      minimumContextTokens: AMP_ANTHROPIC_CONTEXT_1M_TOKENS,
      source: `amp:anthropic-beta:${AMP_ANTHROPIC_CONTEXT_1M_BETA}`
    };
  }

  if (requestedModelHint) {
    return requestedModelHint;
  }

  if (providerHint === "anthropic" || requestKind === "messages") {
    return {
      minimumContextTokens: AMP_ANTHROPIC_CONTEXT_BASELINE_TOKENS,
      source: "amp:anthropic-route:200k-baseline"
    };
  }

  return {
    minimumContextTokens: 0,
    source: ""
  };
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

export function isAmpManagementPath(pathname) {
  const path = normalizePath(pathname);
  if (AMP_MANAGEMENT_ROOT_EXACT_PATHS.has(path)) return true;
  if (AMP_MANAGEMENT_ROOT_PREFIXES.some((prefix) => hasPathPrefix(path, prefix))) return true;
  return AMP_MANAGEMENT_API_PREFIXES.some((prefix) => hasPathPrefix(path, prefix));
}

export function resolveApiRoute(pathname, method) {
  const path = normalizePath(pathname);
  const isGet = method === "GET";
  const isPost = method === "POST";

  const ampRoute = resolveAmpProviderRoute(path, method);
  if (ampRoute) return ampRoute;

  if (isGet && ["/anthropic/v1/models", "/anthropic/models"].includes(path)) {
    return { type: "models", sourceFormat: FORMATS.CLAUDE, requestKind: "models" };
  }

  if (isGet && ["/openai/v1/models", "/openai/models"].includes(path)) {
    return { type: "models", sourceFormat: FORMATS.OPENAI, requestKind: "models" };
  }

  if (isGet && ["/v1/models", "/models"].includes(path)) {
    return { type: "models", sourceFormat: "auto", requestKind: "models" };
  }

  if (isPost && ["/v1/messages", "/messages", "/anthropic", "/anthropic/v1/messages", "/anthropic/messages"].includes(path)) {
    return { type: "route", sourceFormat: FORMATS.CLAUDE, requestKind: "messages" };
  }

  if (isPost && ["/v1/chat/completions", "/chat/completions", "/openai", "/openai/v1/chat/completions", "/openai/chat/completions"].includes(path)) {
    return { type: "route", sourceFormat: FORMATS.OPENAI, requestKind: "chat-completions" };
  }

  if (isPost && ["/v1/completions", "/completions", "/openai/v1/completions", "/openai/completions"].includes(path)) {
    return { type: "route", sourceFormat: FORMATS.OPENAI, requestKind: "completions" };
  }

  if (isPost && ["/v1/responses", "/responses", "/openai/v1/responses", "/openai/responses"].includes(path)) {
    return { type: "route", sourceFormat: FORMATS.OPENAI, requestKind: "responses" };
  }

  // Unified root endpoint: infer user format from request payload/headers.
  if (isPost && ["/", "/v1", "/route", "/router"].includes(path)) {
    return { type: "route", sourceFormat: "auto", requestKind: "unified" };
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

const AMP_MODE_PRESETS = new Map([
  ["smart", { reasoningEffort: "", toolChoice: "" }],
  ["free",  { reasoningEffort: "", toolChoice: "" }],
  ["rush",  { reasoningEffort: "low", toolChoice: "" }],
  ["deep",  { reasoningEffort: "high", toolChoice: "" }],
  ["large", { reasoningEffort: "", toolChoice: "" }],
  ["bombadil", { reasoningEffort: "", toolChoice: "" }]
]);

export function extractAmpContext(request) {
  const headers = request?.headers;
  if (!headers || typeof headers.get !== "function") {
    return { threadId: "", mode: "", overrideProvider: "", feature: "", messageId: "", presets: null };
  }

  const threadId = String(headers.get("x-amp-thread-id") || "").trim();
  const mode = String(headers.get("x-amp-mode") || "").trim().toLowerCase();
  const overrideProvider = String(headers.get("x-amp-override-provider") || "").trim().toLowerCase();
  const feature = String(headers.get("x-amp-feature") || "").trim();
  const messageId = String(headers.get("x-amp-message-id") || "").trim();
  const presets = AMP_MODE_PRESETS.get(mode) || null;

  return { threadId, mode, overrideProvider, feature, messageId, presets };
}
