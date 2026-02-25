/**
 * Generic route request handler (Cloudflare Worker + local Node server).
 */

import {
  buildProviderHeaders,
  configHasProvider,
  listConfiguredModels,
  normalizeRuntimeConfig,
  resolveProviderUrl,
  resolveRequestModel
} from "./config.js";
import { FORMATS, initState, needsTranslation, translateRequest, translateResponse } from "../translator/index.js";
import {
  claudeEventToOpenAIChunks,
  claudeToOpenAINonStreamResponse,
  initClaudeToOpenAIState
} from "../translator/response/claude-to-openai.js";

function withCorsHeaders(headers = {}) {
  return {
    ...headers,
    "Access-Control-Allow-Origin": "*"
  };
}

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
];

const DEFAULT_FALLBACK_CIRCUIT_FAILURES = 2;
const DEFAULT_FALLBACK_CIRCUIT_COOLDOWN_MS = 30_000;
const fallbackCircuitState = new Map();

function sanitizePassthroughHeaders(headers) {
  // Node fetch/undici transparently decodes compressed upstream responses
  // but keeps content-encoding/content-length headers, which breaks clients
  // that attempt to decompress the forwarded payload again.
  headers.delete("content-encoding");
  headers.delete("content-length");
  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withCorsHeaders({
      "Content-Type": "application/json"
    })
  });
}

function corsResponse() {
  return new Response(null, {
    headers: withCorsHeaders({
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version"
    })
  });
}

function passthroughResponseWithCors(response, overrideHeaders = undefined) {
  const headers = new Headers(response.headers);
  sanitizePassthroughHeaders(headers);
  headers.set("Access-Control-Allow-Origin", "*");

  if (overrideHeaders && typeof overrideHeaders === "object") {
    for (const [name, value] of Object.entries(overrideHeaders)) {
      if (value === undefined || value === null) continue;
      headers.set(name, String(value));
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function parseAuthToken(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  if (authHeader && !authHeader.startsWith("Bearer ")) return authHeader;
  return request.headers.get("x-api-key");
}

function validateAuth(request, config, options = {}) {
  if (options.ignoreAuth === true) return true;
  const requiredToken = config.masterKey;
  if (!requiredToken) return true;
  const providedToken = parseAuthToken(request);
  return providedToken === requiredToken;
}

function shouldEnforceWorkerAuth(options = {}) {
  return options.ignoreAuth !== true;
}

function looksNormalizedConfig(config) {
  return Boolean(
    config &&
    typeof config === "object" &&
    Array.isArray(config.providers) &&
    Number.isFinite(config.version)
  );
}

async function loadRuntimeConfig(getConfig, env) {
  const raw = await getConfig(env);
  return looksNormalizedConfig(raw) ? raw : normalizeRuntimeConfig(raw);
}

function shouldRetryStatus(status) {
  return status === 429 || status === 408 || status >= 500;
}

function toNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function resolveFallbackCircuitPolicy(env = {}) {
  return {
    failureThreshold: toNonNegativeInteger(
      env?.LLM_ROUTER_FALLBACK_CIRCUIT_FAILURES,
      DEFAULT_FALLBACK_CIRCUIT_FAILURES
    ),
    cooldownMs: toNonNegativeInteger(
      env?.LLM_ROUTER_FALLBACK_CIRCUIT_COOLDOWN_MS,
      DEFAULT_FALLBACK_CIRCUIT_COOLDOWN_MS
    )
  };
}

function isFallbackCircuitEnabled(policy) {
  return Number.isFinite(policy?.failureThreshold) &&
    Number.isFinite(policy?.cooldownMs) &&
    policy.failureThreshold > 0 &&
    policy.cooldownMs > 0;
}

function candidateCircuitKey(candidate) {
  const model = candidate?.requestModelId || `${candidate?.providerId || "unknown"}/${candidate?.modelId || "unknown"}`;
  const format = candidate?.targetFormat || "unknown";
  return `${model}@${format}`;
}

function getCandidateCircuitSnapshot(candidate, now = Date.now()) {
  const key = candidateCircuitKey(candidate);
  const state = fallbackCircuitState.get(key);
  if (!state) {
    return { key, isOpen: false, openUntil: 0 };
  }
  const openUntil = Number.isFinite(state.openUntil) ? Number(state.openUntil) : 0;
  return {
    key,
    isOpen: openUntil > now,
    openUntil
  };
}

function orderCandidatesByCircuit(candidates, policy, now = Date.now()) {
  const ranked = (candidates || []).map((candidate, originalIndex) => ({
    candidate,
    originalIndex,
    circuit: getCandidateCircuitSnapshot(candidate, now)
  }));

  if (!isFallbackCircuitEnabled(policy) || ranked.length <= 1) {
    return ranked;
  }

  ranked.sort((left, right) => {
    if (left.circuit.isOpen !== right.circuit.isOpen) {
      return left.circuit.isOpen ? 1 : -1;
    }
    if (left.circuit.isOpen && right.circuit.isOpen && left.circuit.openUntil !== right.circuit.openUntil) {
      return left.circuit.openUntil - right.circuit.openUntil;
    }
    return left.originalIndex - right.originalIndex;
  });
  return ranked;
}

function markCandidateSuccess(candidate) {
  fallbackCircuitState.delete(candidateCircuitKey(candidate));
}

function markCandidateFailure(candidate, result, policy, now = Date.now()) {
  const key = candidateCircuitKey(candidate);
  if (!isFallbackCircuitEnabled(policy)) {
    fallbackCircuitState.delete(key);
    return;
  }

  if (!result?.retryable) {
    fallbackCircuitState.delete(key);
    return;
  }

  const prior = fallbackCircuitState.get(key);
  const resetAfterCooldown = prior && Number.isFinite(prior.openUntil) && prior.openUntil <= now;
  const previousFailures = resetAfterCooldown ? 0 : (prior?.consecutiveRetryableFailures || 0);
  const consecutiveRetryableFailures = previousFailures + 1;

  fallbackCircuitState.set(key, {
    consecutiveRetryableFailures,
    openUntil: consecutiveRetryableFailures >= policy.failureThreshold
      ? now + policy.cooldownMs
      : 0,
    lastFailureAt: now,
    lastFailureStatus: result.status
  });
}

function parseJsonSafely(rawText) {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

function normalizeOpenAIContent(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        if (item.type === "text" && typeof item.text === "string") {
          return { type: "text", text: item.text };
        }
        if (item.type === "input_text" && typeof item.text === "string") {
          return { type: "text", text: item.text };
        }
        return null;
      })
      .filter(Boolean);
  }

  return [];
}

function safeParseToolArguments(rawArguments) {
  if (!rawArguments || typeof rawArguments !== "string") return {};
  try {
    return JSON.parse(rawArguments);
  } catch {
    return {};
  }
}

function convertOpenAINonStreamToClaude(result, fallbackModel = "unknown") {
  const choice = result?.choices?.[0];
  const message = choice?.message || {};
  const content = [
    ...normalizeOpenAIContent(message.content)
  ];

  if (Array.isArray(message.tool_calls)) {
    for (let index = 0; index < message.tool_calls.length; index += 1) {
      const call = message.tool_calls[index];
      if (!call || typeof call !== "object") continue;
      content.push({
        type: "tool_use",
        id: call.id || `tool_${index}`,
        name: call.function?.name || "tool",
        input: safeParseToolArguments(call.function?.arguments)
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: result?.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: result?.model || fallbackModel,
    content,
    stop_reason: convertOpenAIFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: result?.usage?.prompt_tokens || 0,
      output_tokens: result?.usage?.completion_tokens || 0
    }
  };
}

function convertOpenAIFinishReason(reason) {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    default:
      return "end_turn";
  }
}

function formatClaudeEvent(event) {
  const eventType = event.type || "message";
  return `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

function handleOpenAIStreamToClaude(response) {
  const state = initState(FORMATS.CLAUDE);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = "";

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();

        if (data === "[DONE]") {
          controller.enqueue(encoder.encode("event: message_stop\ndata: {}\n\n"));
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const translated = translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, parsed, state);
          for (const event of translated) {
            controller.enqueue(encoder.encode(formatClaudeEvent(event)));
          }
        } catch (error) {
          console.error("[Stream] Failed parsing OpenAI chunk:", error instanceof Error ? error.message : String(error));
        }
      }
    }
  });

  return new Response(response.body.pipeThrough(transformStream), {
    headers: withCorsHeaders({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    })
  });
}

function formatOpenAIChunkSse(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function parseSseBlock(block) {
  let eventType = "message";
  const dataLines = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    eventType,
    data: dataLines.join("\n").trim()
  };
}

function handleClaudeStreamToOpenAI(response) {
  const state = initClaudeToOpenAIState();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = "";
  let doneSent = false;

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

      let boundaryIndex;
      while ((boundaryIndex = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        if (!block.trim()) continue;

        const parsedBlock = parseSseBlock(block);
        if (!parsedBlock.data) continue;

        if (parsedBlock.data === "[DONE]") {
          if (!doneSent) {
            doneSent = true;
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
          continue;
        }

        let payload;
        try {
          payload = JSON.parse(parsedBlock.data);
        } catch (error) {
          console.error("[Stream] Failed parsing Claude chunk:", error instanceof Error ? error.message : String(error));
          continue;
        }

        const translatedChunks = claudeEventToOpenAIChunks(parsedBlock.eventType, payload, state);
        for (const translated of translatedChunks) {
          if (translated === "[DONE]") {
            if (!doneSent) {
              doneSent = true;
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            continue;
          }
          controller.enqueue(encoder.encode(formatOpenAIChunkSse(translated)));
        }
      }
    },

    flush(controller) {
      if (!doneSent) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    }
  });

  return new Response(response.body.pipeThrough(transformStream), {
    headers: withCorsHeaders({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    })
  });
}

async function toProviderError(response) {
  const raw = await response.text();
  const parsed = parseJsonSafely(raw);
  const message =
    parsed?.error?.message ||
    parsed?.error ||
    parsed?.message ||
    raw ||
    `Provider request failed with status ${response.status}`;

  return {
    raw,
    payload: {
      type: "error",
      error: {
        type: "api_error",
        message
      }
    }
  };
}

function normalizePath(pathname) {
  if (!pathname) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function resolveApiRoute(pathname, method) {
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

function detectUserRequestFormat(request, body, fallback = FORMATS.CLAUDE) {
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

function isStreamingEnabled(sourceFormat, body) {
  if (sourceFormat === FORMATS.OPENAI) {
    return Boolean(body?.stream);
  }
  // Follow Anthropic-compatible semantics: stream only when explicitly true.
  // Some clients omit `stream` on follow-up/tool turns and expect JSON responses.
  return body?.stream === true;
}

function enrichErrorMessage(error, candidate, isFallback) {
  const prefix = `${candidate.providerId}/${candidate.modelId}`;
  if (isFallback) {
    return `[fallback ${prefix}] ${error}`;
  }
  return `[${prefix}] ${error}`;
}

async function makeProviderCall({
  body,
  sourceFormat,
  stream,
  candidate,
  env
}) {
  const provider = candidate.provider;
  const targetFormat = candidate.targetFormat;
  const translate = needsTranslation(sourceFormat, targetFormat);

  let providerBody = { ...body };
  if (translate) {
    providerBody = translateRequest(sourceFormat, targetFormat, candidate.backend, body, stream);
  }
  providerBody.model = candidate.backend;

  const providerUrl = resolveProviderUrl(provider, targetFormat);
  const headers = buildProviderHeaders(provider, env, targetFormat);

  if (!providerUrl) {
    return {
      ok: false,
      status: 500,
      retryable: false,
      response: jsonResponse({
        type: "error",
        error: {
          type: "configuration_error",
          message: `Provider ${provider.id} has invalid baseUrl.`
        }
      }, 500)
    };
  }

  let response;
  try {
    response = await fetch(providerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(providerBody)
    });
  } catch (error) {
    return {
      ok: false,
      status: 503,
      retryable: true,
      response: jsonResponse({
        type: "error",
        error: {
          type: "api_error",
          message: `Provider network error: ${error instanceof Error ? error.message : String(error)}`
        }
      }, 503)
    };
  }

  if (!response.ok) {
    if (!translate) {
      return {
        ok: false,
        status: response.status,
        retryable: shouldRetryStatus(response.status),
        response: passthroughResponseWithCors(response)
      };
    }

    const providerError = await toProviderError(response);
    return {
      ok: false,
      status: response.status,
      retryable: shouldRetryStatus(response.status),
      response: jsonResponse(providerError.payload, response.status)
    };
  }

  if (stream) {
    if (!translate) {
      return {
        ok: true,
        status: 200,
        retryable: false,
        response: passthroughResponseWithCors(response, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        })
      };
    }

    if (sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.OPENAI) {
      return {
        ok: true,
        status: 200,
        retryable: false,
        response: handleOpenAIStreamToClaude(response)
      };
    }

    if (sourceFormat === FORMATS.OPENAI && targetFormat === FORMATS.CLAUDE) {
      return {
        ok: true,
        status: 200,
        retryable: false,
        response: handleClaudeStreamToOpenAI(response)
      };
    }

    return {
      ok: false,
      status: 501,
      retryable: false,
      response: jsonResponse({
        type: "error",
        error: {
          type: "not_supported_error",
          message: `Streaming translation from ${targetFormat} to ${sourceFormat} is not implemented.`
        }
      }, 501)
    };
  }

  if (!translate) {
    return {
      ok: true,
      status: 200,
      retryable: false,
      response: passthroughResponseWithCors(response)
    };
  }

  const raw = await response.text();
  const parsed = parseJsonSafely(raw);
  if (!parsed) {
    return {
      ok: false,
      status: 502,
      retryable: false,
      response: jsonResponse({
        type: "error",
        error: {
          type: "api_error",
          message: "Provider returned invalid JSON."
        }
      }, 502)
    };
  }

  if (sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.OPENAI) {
    return {
      ok: true,
      status: 200,
      retryable: false,
      response: jsonResponse(convertOpenAINonStreamToClaude(parsed, candidate.backend))
    };
  }

  if (sourceFormat === FORMATS.OPENAI && targetFormat === FORMATS.CLAUDE) {
    return {
      ok: true,
      status: 200,
      retryable: false,
      response: jsonResponse(claudeToOpenAINonStreamResponse(parsed))
    };
  }

  return {
    ok: false,
    status: 501,
    retryable: false,
    response: jsonResponse({
      type: "error",
      error: {
        type: "not_supported_error",
        message: `Non-stream translation from ${targetFormat} to ${sourceFormat} is not implemented.`
      }
    }, 501)
  };
}

async function handleRouteRequest(request, env, getConfig, sourceFormatHint, options = {}) {
  let config;
  try {
    config = options.preloadedConfig || await loadRuntimeConfig(getConfig, env);
  } catch (error) {
    return jsonResponse({
      type: "error",
      error: {
        type: "configuration_error",
        message: `Failed reading runtime config: ${error instanceof Error ? error.message : String(error)}`
      }
    }, 500);
  }

  if (!configHasProvider(config)) {
    return jsonResponse({
      type: "error",
      error: {
        type: "configuration_error",
        message: "No providers configured. Run config to create ~/.llm-router.json (local) or set LLM_ROUTER_CONFIG_JSON (worker)."
      }
    }, 503);
  }

  if (!validateAuth(request, config, options)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const sourceFormat = sourceFormatHint === "auto"
    ? detectUserRequestFormat(request, body, FORMATS.CLAUDE)
    : sourceFormatHint;

  const requestedModel = body?.model || "smart";
  const stream = isStreamingEnabled(sourceFormat, body);

  const resolved = resolveRequestModel(config, requestedModel, sourceFormat);
  if (!resolved.primary) {
    return jsonResponse({
      type: "error",
      error: {
        type: "configuration_error",
        message: resolved.error || `No matching model found for "${requestedModel}" and no default provider/model configured.`
      }
    }, 400);
  }

  const candidates = [resolved.primary, ...resolved.fallbacks];
  const fallbackCircuitPolicy = resolveFallbackCircuitPolicy(env);
  const orderedCandidates = orderCandidatesByCircuit(candidates, fallbackCircuitPolicy);
  let lastErrorResponse = null;
  let lastErrorMessage = "Unknown error";

  for (let index = 0; index < orderedCandidates.length; index += 1) {
    const { candidate } = orderedCandidates[index];
    const result = await makeProviderCall({
      body,
      sourceFormat,
      stream,
      candidate,
      env
    });

    if (result.ok) {
      markCandidateSuccess(candidate);
      return result.response;
    }

    markCandidateFailure(candidate, result, fallbackCircuitPolicy);
    lastErrorResponse = result.response;
    const isFallbackAttempt = candidate.requestModelId !== resolved.primary.requestModelId;
    lastErrorMessage = enrichErrorMessage(
      `status=${result.status}`,
      candidate,
      isFallbackAttempt
    );

    const hasNextCandidate = index < orderedCandidates.length - 1;
    if (!result.retryable && !hasNextCandidate) {
      return result.response;
    }
  }

  if (lastErrorResponse) return lastErrorResponse;

  return jsonResponse({
    type: "error",
    error: {
      type: "api_error",
      message: `All providers failed. ${lastErrorMessage}`
    }
  }, 503);
}

export function createFetchHandler(options) {
  if (!options || typeof options.getConfig !== "function") {
    throw new Error("createFetchHandler requires a getConfig(env) function.");
  }

  return async function fetchHandler(request, env = {}, ctx) {
    const url = new URL(request.url);
    let preloadedConfig = null;

    if (request.method === "OPTIONS") {
      return corsResponse();
    }

    if (shouldEnforceWorkerAuth(options)) {
      try {
        preloadedConfig = await loadRuntimeConfig(options.getConfig, env);
      } catch (error) {
        return jsonResponse({
          type: "error",
          error: {
            type: "configuration_error",
            message: `Failed reading runtime config: ${error instanceof Error ? error.message : String(error)}`
          }
        }, 500);
      }

      if (!preloadedConfig.masterKey) {
        return jsonResponse({
          type: "error",
          error: {
            type: "configuration_error",
            message: "Worker masterKey is required. Set config.masterKey or LLM_ROUTER_MASTER_KEY."
          }
        }, 503);
      }

      if (!validateAuth(request, preloadedConfig, options)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
    }

    if (url.pathname === "/health") {
      let config;
      try {
        config = preloadedConfig || await loadRuntimeConfig(options.getConfig, env);
      } catch {
        config = normalizeRuntimeConfig({});
      }

      return jsonResponse({
        status: "ok",
        timestamp: new Date().toISOString(),
        providers: (config.providers || []).length
      });
    }

    if (request.method === "GET" && normalizePath(url.pathname) === "/") {
      return jsonResponse({
        name: "llm-router",
        status: "ok",
        endpoints: {
          unified: ["/", "/v1", "/route", "/v1/messages", "/v1/chat/completions"],
          anthropic: ["/anthropic", "/anthropic/v1/messages"],
          openai: ["/openai", "/openai/v1/chat/completions"]
        }
      });
    }

    const route = resolveApiRoute(url.pathname, request.method);
    if (route?.type === "models") {
      const config = preloadedConfig || await loadRuntimeConfig(options.getConfig, env);
      return jsonResponse({
        object: "list",
        data: listConfiguredModels(config, {
          endpointFormat: route.sourceFormat === "auto" ? undefined : route.sourceFormat
        })
      });
    }

    if (route?.type === "route") {
      return handleRouteRequest(request, env, options.getConfig, route.sourceFormat, {
        ...options,
        preloadedConfig
      });
    }

    return jsonResponse({ error: "Not found" }, 404);
  };
}
