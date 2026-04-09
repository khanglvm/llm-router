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
import {
  convertClaudeNonStreamToOpenAIResponses,
  convertOpenAINonStreamToClaude,
  handleClaudeStreamToOpenAI,
  handleClaudeStreamToOpenAIResponses,
  handleOpenAIStreamToClaude,
  normalizeClaudePassthroughStream
} from "./provider-translation.js";
import { maybeRewriteAmpClientResponse } from "./amp-response.js";
import { applyCachingMapping, mergeCachingHeaders } from "./cache-mapping.js";
import { applyReasoningEffortMapping } from "./reasoning-effort.js";
import { stripUnsupportedFields } from "./field-filter.js";
import { resolveUpstreamTimeoutMs } from "./request.js";
import { parseJsonSafely } from "./utils.js";
import { buildTimeoutSignal } from "../../shared/timeout-signal.js";
import {
  convertCodexResponseToOpenAIChatCompletion,
  extractCodexFinalResponse,
  handleCodexStreamToOpenAI
} from "../codex-response-transformer.js";
import { toBoolean } from "./utils.js";
import {
  maybeInterceptAmpWebSearch,
  rewriteProviderBodyForAmpWebSearch,
  shouldInterceptAmpWebSearch
} from "./amp-web-search.js";

function isSubscriptionProvider(provider) {
  return provider?.type === "subscription";
}

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

async function adaptProviderResponse({
  response,
  stream,
  translate,
  sourceFormat,
  targetFormat,
  fallbackModel,
  requestKind,
  requestBody,
  clientType,
  env,
  responsesDowngraded
}) {
  const buildSuccessResponse = async (resultResponse) => ({
    ok: true,
    status: 200,
    retryable: false,
    response: await maybeRewriteAmpClientResponse(resultResponse, {
      clientType,
      requestBody,
      stream,
      env
    })
  });

  // Responses API was downgraded to Chat Completions for provider compatibility.
  // Convert response back: Chat Completions → Claude → Responses API.
  if (responsesDowngraded) {
    if (stream) {
      const claudeStream = handleOpenAIStreamToClaude(response);
      return buildSuccessResponse(handleClaudeStreamToOpenAIResponses(claudeStream, requestBody, fallbackModel));
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
          error: { type: "api_error", message: "Provider returned invalid JSON." }
        }, 502)
      };
    }
    const claudeMessage = convertOpenAINonStreamToClaude(parsed, fallbackModel);
    return buildSuccessResponse(jsonResponse(convertClaudeNonStreamToOpenAIResponses(claudeMessage, requestBody, fallbackModel)));
  }

  if (stream) {
    if (!translate) {
      return buildSuccessResponse(
        sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.CLAUDE
          ? normalizeClaudePassthroughStream(response)
          : passthroughResponseWithCors(response, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          })
      );
    }

    if (sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.OPENAI) {
      return buildSuccessResponse(handleOpenAIStreamToClaude(response));
    }

    if (sourceFormat === FORMATS.OPENAI && targetFormat === FORMATS.CLAUDE) {
      return buildSuccessResponse(
        requestKind === "responses"
          ? handleClaudeStreamToOpenAIResponses(response, requestBody, fallbackModel)
          : handleClaudeStreamToOpenAI(response)
      );
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
    return buildSuccessResponse(passthroughResponseWithCors(response));
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
    return buildSuccessResponse(jsonResponse(convertOpenAINonStreamToClaude(parsed, fallbackModel)));
  }

  if (sourceFormat === FORMATS.OPENAI && targetFormat === FORMATS.CLAUDE) {
    return buildSuccessResponse(
      requestKind === "responses"
        ? jsonResponse(convertClaudeNonStreamToOpenAIResponses(parsed, requestBody, fallbackModel))
        : jsonResponse(claudeToOpenAINonStreamResponse(parsed))
    );
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

function isProviderDebugEnabled(env = {}) {
  return toBoolean(
    env?.LLM_ROUTER_DEBUG_ROUTING,
    toBoolean(env?.LLM_ROUTER_DEBUG, false)
  );
}

function extractToolTypes(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return [...new Set(
    tools
      .map((tool) => String(tool?.type || "").trim())
      .filter(Boolean)
  )];
}

function hasToolDefinitions(body) {
  return Array.isArray(body?.tools) && body.tools.some((tool) => tool && typeof tool === "object");
}

function getProviderFormats(provider) {
  return [...new Set(
    [provider?.format, ...(Array.isArray(provider?.formats) ? provider.formats : [])]
      .map((value) => String(value || "").trim())
      .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE)
  )];
}

function normalizeProviderRequestKind(targetFormat, requestKind) {
  if (targetFormat === FORMATS.OPENAI && requestKind === "messages") {
    return undefined;
  }
  return requestKind;
}

function shouldPreferOpenAIForClaudeToolCalls({
  provider,
  sourceFormat,
  targetFormat,
  requestKind,
  body
} = {}) {
  if (sourceFormat !== FORMATS.CLAUDE || targetFormat !== FORMATS.CLAUDE) return false;
  if (!hasToolDefinitions(body)) return false;
  if (!getProviderFormats(provider).includes(FORMATS.OPENAI)) return false;
  return Boolean(resolveProviderUrl(provider, FORMATS.OPENAI, normalizeProviderRequestKind(FORMATS.OPENAI, requestKind)));
}

function isOpenAIHostedWebSearchRequest(targetFormat, requestKind) {
  return targetFormat === FORMATS.OPENAI && requestKind === "responses";
}

function normalizeOpenAIHostedWebSearchType(value) {
  return String(value || "").trim().toLowerCase();
}

function isOpenAIHostedWebSearchToolType(type) {
  const normalized = normalizeOpenAIHostedWebSearchType(type);
  return normalized === "web_search" || normalized.startsWith("web_search_preview");
}

function isOpenAINativeWebSearchToolType(type) {
  const normalized = normalizeOpenAIHostedWebSearchType(type);
  return normalized === "web_search"
    || (normalized.startsWith("web_search_") && !normalized.startsWith("web_search_preview"));
}

function hasOpenAIHostedWebSearchTool(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.some((tool) =>
    isOpenAIHostedWebSearchToolType(tool?.type) || isOpenAINativeWebSearchToolType(tool?.type)
  );
}

function normalizeOpenAIHostedWebSearchToolChoice(toolChoice, toolType) {
  if (typeof toolChoice === "string") {
    const normalized = normalizeOpenAIHostedWebSearchType(toolChoice);
    if (isOpenAIHostedWebSearchToolType(normalized) || isOpenAINativeWebSearchToolType(normalized)) {
      return "required";
    }
    return toolChoice;
  }
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return toolChoice;
  }

  const normalizedType = normalizeOpenAIHostedWebSearchType(toolChoice.type);
  if (normalizedType === "none" || normalizedType === "auto") {
    return normalizedType;
  }
  if (!isOpenAIHostedWebSearchToolType(normalizedType) && !isOpenAINativeWebSearchToolType(normalizedType)) {
    return toolChoice;
  }

  void toolType;
  return "required";
}

function rewriteProviderBodyForOpenAIHostedWebSearch(providerBody, toolType) {
  if (!toolType || !isOpenAINativeWebSearchToolType(toolType)) {
    return {
      providerBody,
      rewritten: false
    };
  }

  const tools = Array.isArray(providerBody?.tools) ? providerBody.tools : null;
  let rewritten = false;
  const nextTools = tools
    ? tools.map((tool) => {
      if (!tool || typeof tool !== "object" || !isOpenAIHostedWebSearchToolType(tool.type)) {
        return tool;
      }
      if (normalizeOpenAIHostedWebSearchType(tool.type) === toolType) {
        return tool;
      }
      rewritten = true;
      return {
        ...tool,
        type: toolType
      };
    })
    : tools;

  const nextToolChoice = normalizeOpenAIHostedWebSearchToolChoice(providerBody?.tool_choice, toolType);
  if (nextToolChoice !== providerBody?.tool_choice) {
    rewritten = true;
  }

  if (!rewritten) {
    return {
      providerBody,
      rewritten: false
    };
  }

  return {
    rewritten: true,
    providerBody: {
      ...providerBody,
      ...(nextTools ? { tools: nextTools } : {}),
      ...(nextToolChoice !== undefined ? { tool_choice: nextToolChoice } : {})
    }
  };
}

function getProviderOpenAIHostedWebSearchToolType(provider, { targetFormat, requestKind } = {}) {
  if (!isOpenAIHostedWebSearchRequest(targetFormat, requestKind)) return "";

  const subscriptionType = String(provider?.subscriptionType || provider?.subscription_type || "").trim().toLowerCase();
  if (subscriptionType === "chatgpt-codex") {
    return "web_search";
  }

  const candidates = [
    provider?.lastProbe?.openaiResponses?.webSearchToolType,
    provider?.lastProbe?.toolSupport?.openaiResponses?.webSearchToolType,
    provider?.metadata?.openaiResponses?.webSearchToolType,
    provider?.metadata?.toolSupport?.openaiResponses?.webSearchToolType
  ];

  for (const candidate of candidates) {
    const normalized = normalizeOpenAIHostedWebSearchType(candidate);
    if (isOpenAINativeWebSearchToolType(normalized)) {
      return normalized;
    }
  }

  return "";
}

async function readProviderErrorHint(response) {
  if (!(response instanceof Response)) return "";
  try {
    const raw = await response.clone().text();
    if (!raw) return "";
    const parsed = parseJsonSafely(raw);
    return [
      parsed?.error?.code,
      parsed?.error?.type,
      parsed?.error?.message,
      parsed?.error,
      parsed?.code,
      parsed?.type,
      parsed?.message,
      raw
    ]
      .filter((entry) => entry !== undefined && entry !== null)
      .map((entry) => String(entry).toLowerCase())
      .join(" ");
  } catch {
    return "";
  }
}

function isUnsupportedOpenAIHostedWebSearchHint(hint) {
  const normalized = String(hint || "").toLowerCase();
  if (!normalized || !normalized.includes("web_search")) return false;
  return normalized.includes("unsupported tool type")
    || normalized.includes("tool type is not supported")
    || normalized.includes("tool is not supported")
    || normalized.includes("does not support tool")
    || normalized.includes("unsupported tool");
}

async function maybeRetryOpenAIHostedWebSearchProviderRequest({
  response,
  executeProviderRequest,
  providerBody,
  targetFormat,
  requestKind
} = {}) {
  if (!(response instanceof Response) || typeof executeProviderRequest !== "function") {
    return {
      response,
      providerBody,
      retried: false
    };
  }
  if (!isOpenAIHostedWebSearchRequest(targetFormat, requestKind) || !hasOpenAIHostedWebSearchTool(providerBody)) {
    return {
      response,
      providerBody,
      retried: false
    };
  }

  const rewritten = rewriteProviderBodyForOpenAIHostedWebSearch(providerBody, "web_search");
  if (!rewritten.rewritten) {
    return {
      response,
      providerBody,
      retried: false
    };
  }

  const errorHint = await readProviderErrorHint(response);
  if (!errorHint.includes("web_search_preview") || !isUnsupportedOpenAIHostedWebSearchHint(errorHint)) {
    return {
      response,
      providerBody,
      retried: false
    };
  }

  try {
    const retriedResponse = await executeProviderRequest(rewritten.providerBody);
    return {
      response: retriedResponse instanceof Response ? retriedResponse : response,
      providerBody: rewritten.providerBody,
      retried: retriedResponse instanceof Response
    };
  } catch {
    return {
      response,
      providerBody,
      retried: false
    };
  }
}

async function resolveHostedWebSearchErrorKind(response, providerBody, { targetFormat, requestKind } = {}) {
  if (!isOpenAIHostedWebSearchRequest(targetFormat, requestKind) || !hasOpenAIHostedWebSearchTool(providerBody)) {
    return "";
  }

  const errorHint = await readProviderErrorHint(response);
  return isUnsupportedOpenAIHostedWebSearchHint(errorHint) ? "not_supported_error" : "";
}

function logToolRouting({ env, clientType, candidate, originalBody, providerBody, sourceFormat, targetFormat } = {}) {
  if (!isProviderDebugEnabled(env)) return;

  const originalToolTypes = extractToolTypes(originalBody);
  const providerToolTypes = extractToolTypes(providerBody);
  if (originalToolTypes.length === 0 && providerToolTypes.length === 0) return;

  console.warn(
    `[llm-router] provider tool routing client=${clientType || "default"} candidate=${candidate?.providerId || "unknown"}/${candidate?.modelId || "unknown"} source=${sourceFormat} target=${targetFormat} original=${originalToolTypes.join(",") || "none"} upstream=${providerToolTypes.join(",") || "none"}`
  );
}

function buildProviderRequestPlan({
  body,
  sourceFormat,
  targetFormat,
  candidate,
  requestKind,
  requestHeaders,
  interceptAmpWebSearch,
  stream,
  forceResponsesDowngrade = false
}) {
  const normalizedRequestKind = normalizeProviderRequestKind(targetFormat, requestKind);
  const translate = needsTranslation(sourceFormat, targetFormat);

  let providerBody = { ...body };
  let responsesDowngraded = false;
  if (translate) {
    providerBody = translateRequest(sourceFormat, targetFormat, candidate.backend, body, stream);
  } else if (forceResponsesDowngrade) {
    // Provider confirmed to not support Responses API — downgrade to Chat Completions
    // via double-hop: Responses API → Claude → Chat Completions.
    const intermediateBody = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, candidate.backend, body, stream);
    providerBody = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, candidate.backend, intermediateBody, stream);
    responsesDowngraded = true;
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
    requestHeaders,
    capabilities: candidate.model?.capabilities
  });

  if (responsesDowngraded) {
    // Strip Responses-API-only fields that Chat Completions providers reject.
    delete providerBody.prompt_cache_key;
    delete providerBody.store;
    delete providerBody.include;
    delete providerBody.text;
    delete providerBody.service_tier;
  }

  const declaredOpenAIHostedWebSearchToolType = getProviderOpenAIHostedWebSearchToolType(candidate.provider, {
    targetFormat,
    requestKind: normalizedRequestKind
  });
  const declaredOpenAIHostedWebSearchRewrite = rewriteProviderBodyForOpenAIHostedWebSearch(
    providerBody,
    declaredOpenAIHostedWebSearchToolType
  );
  if (declaredOpenAIHostedWebSearchRewrite.rewritten) {
    providerBody = declaredOpenAIHostedWebSearchRewrite.providerBody;
  }

  if (interceptAmpWebSearch) {
    providerBody = rewriteProviderBodyForAmpWebSearch(providerBody, targetFormat, requestKind).providerBody;
  }

  providerBody = stripUnsupportedFields(providerBody, candidate.model?.capabilities);

  return {
    targetFormat,
    requestKind: responsesDowngraded ? undefined : normalizedRequestKind,
    translate,
    providerBody,
    responsesDowngraded
  };
}

export async function makeProviderCall({
  body,
  sourceFormat,
  stream,
  candidate,
  requestKind,
  requestHeaders,
  env,
  clientType,
  runtimeConfig,
  stateStore,
  ampContext,
  runtimeFlags
}) {
  const provider = candidate.provider;
  const targetFormat = candidate.targetFormat;
  const interceptAmpWebSearch = shouldInterceptAmpWebSearch({
    clientType,
    originalBody: body,
    runtimeConfig,
    env
  });

  const preferOpenAIToolRouting = !isSubscriptionProvider(provider) && shouldPreferOpenAIForClaudeToolCalls({
    provider,
    sourceFormat,
    targetFormat,
    requestKind,
    body
  });

  let effectiveBody = body;
  if (ampContext?.presets?.reasoningEffort && !body?.reasoning_effort && !body?.reasoning?.effort) {
    effectiveBody = { ...body, reasoning_effort: ampContext.presets.reasoningEffort };
  }

  // For Responses API requests to OpenAI-format providers, try the native endpoint first.
  // If the provider doesn't support /v1/responses (returns 404/400), fall back to a
  // downgraded Chat Completions plan with double-hop translation.
  const needsResponsesDowngradeFallback = !isSubscriptionProvider(provider)
    && sourceFormat === FORMATS.OPENAI
    && targetFormat === FORMATS.OPENAI
    && requestKind === "responses";

  let activePlan;
  let fallbackPlan = null;
  let responsesDowngradedPlan = null;
  try {
    activePlan = buildProviderRequestPlan({
      body: effectiveBody,
      sourceFormat,
      targetFormat: preferOpenAIToolRouting ? FORMATS.OPENAI : targetFormat,
      candidate,
      requestKind,
      requestHeaders,
      interceptAmpWebSearch,
      stream
    });
    if (preferOpenAIToolRouting) {
      fallbackPlan = buildProviderRequestPlan({
        body: effectiveBody,
        sourceFormat,
        targetFormat,
        candidate,
        requestKind,
        requestHeaders,
        interceptAmpWebSearch,
        stream
      });
    }
    if (needsResponsesDowngradeFallback) {
      responsesDowngradedPlan = buildProviderRequestPlan({
        body: effectiveBody,
        sourceFormat,
        targetFormat,
        candidate,
        requestKind,
        requestHeaders,
        interceptAmpWebSearch,
        stream,
        forceResponsesDowngrade: true
      });
    }
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

  logToolRouting({
    env,
    clientType,
    candidate,
    originalBody: body,
    providerBody: activePlan.providerBody,
    sourceFormat,
    targetFormat: activePlan.targetFormat
  });

  if (isSubscriptionProvider(provider)) {
    if (runtimeFlags?.workerRuntime) {
      return {
        ok: false,
        status: 501,
        retryable: false,
        errorKind: "not_supported",
        response: jsonResponse({
          type: "error",
          error: {
            type: "not_supported_error",
            message: "Subscription providers are not available in Worker mode."
          }
        }, 501)
      };
    }
    const { makeSubscriptionProviderCall } = await import("../subscription-provider.js");
    const subscriptionType = String(provider?.subscriptionType || provider?.subscription_type || "").trim().toLowerCase();
    if (subscriptionType === "chatgpt-codex" && ampContext?.threadId) {
      activePlan.providerBody = {
        ...activePlan.providerBody,
        prompt_cache_key: activePlan.providerBody.prompt_cache_key || ampContext.threadId
      };
    }
    const executeSubscriptionRequest = async (requestBody) => makeSubscriptionProviderCall({
      provider,
      body: requestBody,
      // ChatGPT Codex backend expects stream=true; non-stream responses are reconstructed from SSE.
      stream: subscriptionType === "chatgpt-codex" ? true : Boolean(stream),
      env
    });
    const subscriptionResult = await executeSubscriptionRequest(activePlan.providerBody);

    if (!subscriptionResult?.ok) {
      return subscriptionResult;
    }

    if (!(subscriptionResult.response instanceof Response)) {
      return {
        ok: false,
        status: 502,
        retryable: true,
        response: jsonResponse({
          type: "error",
          error: {
            type: "api_error",
            message: "Subscription provider returned an invalid response."
          }
        }, 502)
      };
    }

    const fallbackModel = candidate?.backend || activePlan.providerBody?.model || "unknown";
    let upstreamResponse = subscriptionResult.response;
    if (interceptAmpWebSearch) {
      const intercepted = await maybeInterceptAmpWebSearch({
        response: upstreamResponse,
        providerBody: activePlan.providerBody,
        targetFormat: activePlan.targetFormat,
        requestKind: activePlan.requestKind,
        stream,
        runtimeConfig,
        env,
        stateStore,
        executeProviderRequest: async (followUpBody) => {
          const followUpResult = await executeSubscriptionRequest(followUpBody);
          return followUpResult?.response instanceof Response ? followUpResult.response : null;
        }
      });
      upstreamResponse = intercepted.response;
    }
    if (subscriptionType !== "chatgpt-codex") {
      return adaptProviderResponse({
        response: upstreamResponse,
        stream,
        translate: activePlan.translate,
        sourceFormat,
        targetFormat: activePlan.targetFormat,
        fallbackModel,
        requestKind: activePlan.requestKind,
        requestBody: body,
        clientType,
        env
      });
    }

    if (requestKind === "responses") {
      if (stream) {
        return {
          ok: true,
          status: 200,
          retryable: false,
          response: await maybeRewriteAmpClientResponse(
            passthroughResponseWithCors(upstreamResponse, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive"
            }),
            {
              clientType,
              requestBody: body,
              stream,
              env
            }
          )
        };
      }

      const parsedSubscriptionResponse = await extractCodexFinalResponse(upstreamResponse);
      if (!parsedSubscriptionResponse) {
        return {
          ok: false,
          status: 502,
          retryable: true,
          response: jsonResponse({
            type: "error",
            error: {
              type: "api_error",
              message: "Subscription provider stream did not contain a completed response payload."
            }
          }, 502)
        };
      }

      return {
        ok: true,
        status: 200,
        retryable: false,
        response: await maybeRewriteAmpClientResponse(jsonResponse(parsedSubscriptionResponse), {
          clientType,
          requestBody: body,
          stream,
          env
        })
      };
    }

    if (stream) {
      const openAIStreamResponse = handleCodexStreamToOpenAI(upstreamResponse, {
        fallbackModel
      });
      if (sourceFormat === FORMATS.CLAUDE) {
        return {
          ok: true,
          status: 200,
          retryable: false,
          response: await maybeRewriteAmpClientResponse(handleOpenAIStreamToClaude(openAIStreamResponse), {
            clientType,
            requestBody: body,
            stream,
            env
          })
        };
      }
      return {
        ok: true,
        status: 200,
        retryable: false,
        response: await maybeRewriteAmpClientResponse(openAIStreamResponse, {
          clientType,
          requestBody: body,
          stream,
          env
        })
      };
    }

    const parsedSubscriptionResponse = await extractCodexFinalResponse(upstreamResponse);
    if (!parsedSubscriptionResponse) {
      return {
        ok: false,
        status: 502,
        retryable: true,
        response: jsonResponse({
          type: "error",
          error: {
            type: "api_error",
            message: "Subscription provider stream did not contain a completed response payload."
          }
        }, 502)
      };
    }

    const openAINonStreamResponse = convertCodexResponseToOpenAIChatCompletion(parsedSubscriptionResponse, {
      fallbackModel
    });
    if (sourceFormat === FORMATS.CLAUDE) {
      return {
        ok: true,
        status: 200,
        retryable: false,
        response: await maybeRewriteAmpClientResponse(
          jsonResponse(convertOpenAINonStreamToClaude(openAINonStreamResponse, fallbackModel)),
          {
            clientType,
            requestBody: body,
            stream,
            env
          }
        )
      };
    }

    return {
      ok: true,
      status: 200,
      retryable: false,
      response: await maybeRewriteAmpClientResponse(jsonResponse(openAINonStreamResponse), {
        clientType,
        requestBody: body,
        stream,
        env
      })
    };
  }

  const executeHttpProviderRequest = async (plan) => {
    const providerUrl = resolveProviderUrl(provider, plan.targetFormat, plan.requestKind);
    if (!providerUrl) return null;
    const headers = mergeCachingHeaders(
      buildProviderHeaders(provider, env, plan.targetFormat),
      requestHeaders,
      plan.targetFormat
    );
    const timeoutMs = resolveUpstreamTimeoutMs(env);
    const timeoutControl = buildTimeoutSignal(timeoutMs);
    try {
      const init = {
        method: "POST",
        headers,
        body: JSON.stringify(plan.providerBody)
      };
      if (timeoutControl.signal) {
        init.signal = timeoutControl.signal;
      }

      return await fetch(providerUrl, init);
    } finally {
      timeoutControl.cleanup();
    }
  };

  if (!resolveProviderUrl(provider, activePlan.targetFormat, activePlan.requestKind)) {
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
    response = await executeHttpProviderRequest(activePlan);
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

  if ((!response || !response.ok) && fallbackPlan) {
    try {
      const fallbackResponse = await executeHttpProviderRequest(fallbackPlan);
      if (fallbackResponse instanceof Response && fallbackResponse.ok) {
        response = fallbackResponse;
        activePlan = fallbackPlan;
      }
    } catch {
      // Keep the original failure if the fallback request also fails.
    }
  }

  // Provider doesn't support native /v1/responses — retry with Chat Completions downgrade.
  if ((!response || !response.ok) && responsesDowngradedPlan) {
    try {
      const downgradedResponse = await executeHttpProviderRequest(responsesDowngradedPlan);
      if (downgradedResponse instanceof Response && downgradedResponse.ok) {
        response = downgradedResponse;
        activePlan = responsesDowngradedPlan;
      }
    } catch {
      // Keep the original failure if the downgraded request also fails.
    }
  }

  if (!response.ok) {
    const retriedOpenAIHostedWebSearch = await maybeRetryOpenAIHostedWebSearchProviderRequest({
      response,
      executeProviderRequest: async (nextProviderBody) => executeHttpProviderRequest({
        ...activePlan,
        providerBody: nextProviderBody
      }),
      providerBody: activePlan.providerBody,
      targetFormat: activePlan.targetFormat,
      requestKind: activePlan.requestKind
    });
    response = retriedOpenAIHostedWebSearch.response;
    activePlan = {
      ...activePlan,
      providerBody: retriedOpenAIHostedWebSearch.providerBody
    };
  }

  if (!response.ok) {
    const hostedWebSearchErrorKind = await resolveHostedWebSearchErrorKind(response, activePlan.providerBody, {
      targetFormat: activePlan.targetFormat,
      requestKind: activePlan.requestKind
    });
    return {
      ok: false,
      status: response.status,
      retryable: shouldRetryStatus(response.status),
      ...(hostedWebSearchErrorKind ? { errorKind: hostedWebSearchErrorKind } : {}),
      upstreamResponse: response,
      translateError: activePlan.translate
    };
  }

  if (interceptAmpWebSearch) {
    const intercepted = await maybeInterceptAmpWebSearch({
      response,
      providerBody: activePlan.providerBody,
      targetFormat: activePlan.targetFormat,
      requestKind: activePlan.requestKind,
      stream,
      runtimeConfig,
      env,
      stateStore,
      executeProviderRequest: async (followUpBody) => {
        try {
          return await executeHttpProviderRequest({
            ...activePlan,
            providerBody: followUpBody
          });
        } catch {
          return null;
        }
      }
    });
    response = intercepted.response;
  }

  return adaptProviderResponse({
    response,
    stream,
    translate: activePlan.translate,
    sourceFormat,
    targetFormat: activePlan.targetFormat,
    fallbackModel: candidate.backend,
    requestKind: activePlan.requestKind,
    requestBody: body,
    clientType,
    env,
    responsesDowngraded: activePlan.responsesDowngraded
  });
}
