import {
  buildProviderHeaders,
  resolveProviderUrl
} from "../config.js";
import {
  FORMATS,
  needsTranslation,
  translateRequest
} from "../../translator/index.js";
import { claudeToOpenAINonStreamResponse } from "../../translator/response/claude-to-openai.js";
import { shouldRetryStatus } from "./fallback.js";
import { jsonResponse, passthroughResponseWithCors } from "./http.js";
import { convertOpenAINonStreamToClaude, handleClaudeStreamToOpenAI, handleOpenAIStreamToClaude } from "./provider-translation.js";
import { applyCachingMapping, mergeCachingHeaders } from "./cache-mapping.js";
import { applyReasoningEffortMapping } from "./reasoning-effort.js";
import { resolveUpstreamTimeoutMs } from "./request.js";
import { parseJsonSafely } from "./utils.js";

async function toProviderError(response) {
  const raw = await response.text();
  const parsed = parseJsonSafely(raw);
  const message =
    parsed?.error?.message ||
    parsed?.error?.code ||
    parsed?.error?.type ||
    parsed?.error ||
    parsed?.code ||
    parsed?.type ||
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

export async function buildFailureResponse(result) {
  if (result?.response instanceof Response) return result.response;

  if (result?.upstreamResponse instanceof Response) {
    if (!result.translateError) {
      return passthroughResponseWithCors(result.upstreamResponse);
    }
    const providerError = await toProviderError(result.upstreamResponse);
    return jsonResponse(providerError.payload, result.upstreamResponse.status);
  }

  const fallbackStatus = Number.isFinite(result?.status) ? Number(result.status) : 503;
  return jsonResponse({
    type: "error",
    error: {
      type: "api_error",
      message: `Provider request failed with status ${fallbackStatus}.`
    }
  }, fallbackStatus);
}

export async function makeProviderCall({
  body,
  sourceFormat,
  stream,
  candidate,
  requestHeaders,
  env
}) {
  const provider = candidate.provider;
  const targetFormat = candidate.targetFormat;
  const translate = needsTranslation(sourceFormat, targetFormat);

  let providerBody = { ...body };
  if (translate) {
    try {
      providerBody = translateRequest(sourceFormat, targetFormat, candidate.backend, body, stream);
    } catch (error) {
      return {
        ok: false,
        status: 400,
        retryable: false,
        errorKind: "translation_error",
        response: jsonResponse({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `Request translation failed: ${error instanceof Error ? error.message : String(error)}`
          }
        }, 400)
      };
    }
  }
  providerBody.model = candidate.backend;
  providerBody = applyCachingMapping({
    originalBody: body,
    providerBody,
    sourceFormat,
    targetFormat,
    requestHeaders
  });
  providerBody = applyReasoningEffortMapping({
    originalBody: body,
    providerBody,
    sourceFormat,
    targetFormat,
    targetModel: candidate.backend,
    requestHeaders
  });

  const providerUrl = resolveProviderUrl(provider, targetFormat);
  const headers = mergeCachingHeaders(
    buildProviderHeaders(provider, env, targetFormat),
    requestHeaders,
    targetFormat
  );

  if (!providerUrl) {
    return {
      ok: false,
      status: 500,
      retryable: false,
      errorKind: "configuration_error",
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
    const timeoutMs = resolveUpstreamTimeoutMs(env);
    const init = {
      method: "POST",
      headers,
      body: JSON.stringify(providerBody)
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(timeoutMs);
    }

    response = await fetch(providerUrl, {
      ...init
    });
  } catch (error) {
    return {
      ok: false,
      status: 503,
      retryable: true,
      errorKind: "network_error",
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
    return {
      ok: false,
      status: response.status,
      retryable: shouldRetryStatus(response.status),
      upstreamResponse: response,
      translateError: translate
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
      errorKind: "not_supported_error",
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
      retryable: true,
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
    errorKind: "not_supported_error",
    response: jsonResponse({
      type: "error",
      error: {
        type: "not_supported_error",
        message: `Non-stream translation from ${targetFormat} to ${sourceFormat} is not implemented.`
      }
    }, 501)
  };
}
