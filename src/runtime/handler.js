/**
 * Generic route request handler (Cloudflare Worker + local Node server).
 */

import {
  configHasProvider,
  normalizeRuntimeConfig,
  resolveRequestModel
} from "./config.js";
import { FORMATS } from "../translator/index.js";
import { shouldEnforceWorkerAuth, validateAuth } from "./handler/auth.js";
import { loadRuntimeConfig, getCachedModelList } from "./handler/config-loading.js";
import {
  buildFailureResponse,
  makeProviderCall
} from "./handler/provider-call.js";
import { corsResponse, jsonResponse } from "./handler/http.js";
import {
  detectUserRequestFormat,
  isJsonRequest,
  isStreamingEnabled,
  normalizePath,
  parseJsonBodyWithLimit,
  resolveApiRoute,
  resolveMaxRequestBodyBytes
} from "./handler/request.js";
import {
  isRequestFromAllowedIp,
  resolveAllowedOrigin,
  withRequestCors
} from "./handler/network-guards.js";
import {
  classifyFailureResult,
  computeRetryDelayMs,
  enrichErrorMessage,
  markCandidateFailure,
  markCandidateSuccess,
  orderCandidatesByCircuit,
  resolveFallbackCircuitPolicy,
  resolveRetryPolicy,
  setCandidateCooldown
} from "./handler/fallback.js";
import { sleep } from "./handler/utils.js";

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

  if (options.authValidated !== true && !validateAuth(request, config, options)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const hasContentType = Boolean(request.headers.get("content-type"));
  if (hasContentType && !isJsonRequest(request)) {
    return jsonResponse({ error: "Unsupported Media Type. Use application/json." }, 415);
  }

  const maxRequestBodyBytes = resolveMaxRequestBodyBytes(env);
  let body;
  try {
    body = await parseJsonBodyWithLimit(request, maxRequestBodyBytes);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "REQUEST_BODY_TOO_LARGE") {
      return jsonResponse({ error: "Request body too large" }, 413);
    }
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
  const retryPolicy = resolveRetryPolicy(env);
  const orderedCandidates = orderCandidatesByCircuit(candidates, fallbackCircuitPolicy);
  let lastErrorResult = null;
  let lastErrorMessage = "Unknown error";

  for (let index = 0; index < orderedCandidates.length; index += 1) {
    const { candidate } = orderedCandidates[index];
    const isOriginCandidate = candidate.requestModelId === resolved.primary.requestModelId;
    const maxAttempts = isOriginCandidate ? retryPolicy.originRetryAttempts : 1;

    let result = null;
    let classification = null;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;
      result = await makeProviderCall({
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

      classification = await classifyFailureResult(result, retryPolicy);
      const canRetryOrigin = isOriginCandidate &&
        classification.retryOrigin &&
        attempt < maxAttempts;
      if (!canRetryOrigin) break;

      const delayMs = computeRetryDelayMs(attempt, retryPolicy);
      await sleep(delayMs);
    }

    markCandidateFailure(
      candidate,
      { status: result?.status, retryable: classification?.retryable },
      fallbackCircuitPolicy,
      { trackFailure: isOriginCandidate }
    );

    if (isOriginCandidate) {
      const hasNextCandidate = index < orderedCandidates.length - 1;
      const fallbackPenaltyMs = hasNextCandidate && classification?.allowFallback
        ? retryPolicy.originFallbackCooldownMs
        : 0;
      const originCooldownMs = Math.max(
        classification?.originCooldownMs || 0,
        fallbackPenaltyMs
      );
      if (originCooldownMs > 0) {
        setCandidateCooldown(
          candidate,
          originCooldownMs,
          fallbackCircuitPolicy,
          result?.status
        );
      }
    }

    lastErrorResult = result;
    const isFallbackAttempt = candidate.requestModelId !== resolved.primary.requestModelId;
    lastErrorMessage = enrichErrorMessage(
      `status=${result?.status} category=${classification?.category || "unknown"}`,
      candidate,
      isFallbackAttempt
    );

    const hasNextCandidate = index < orderedCandidates.length - 1;
    if (!hasNextCandidate || classification?.allowFallback === false) {
      return buildFailureResponse(result);
    }
  }

  if (lastErrorResult) return buildFailureResponse(lastErrorResult);

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
    const respond = (response, corsOptions = {}) => withRequestCors(response, request, env, corsOptions);
    let preloadedConfig = null;
    let authValidated = false;

    if (!isRequestFromAllowedIp(request, env)) {
      return respond(jsonResponse({ error: "Forbidden" }, 403));
    }

    if (request.method === "OPTIONS") {
      const allowedOrigin = resolveAllowedOrigin(request, env);
      if (request.headers.get("origin") && !allowedOrigin) {
        return new Response(null, { status: 403 });
      }
      return respond(corsResponse(), { isPreflight: true, allowedOrigin });
    }

    if (shouldEnforceWorkerAuth(options)) {
      try {
        preloadedConfig = await loadRuntimeConfig(options.getConfig, env);
      } catch (error) {
        return respond(jsonResponse({
          type: "error",
          error: {
            type: "configuration_error",
            message: `Failed reading runtime config: ${error instanceof Error ? error.message : String(error)}`
          }
        }, 500));
      }

      if (!preloadedConfig.masterKey) {
        return respond(jsonResponse({
          type: "error",
          error: {
            type: "configuration_error",
            message: "Worker masterKey is required. Set config.masterKey or LLM_ROUTER_MASTER_KEY."
          }
        }, 503));
      }

      if (!validateAuth(request, preloadedConfig, options)) {
        return respond(jsonResponse({ error: "Unauthorized" }, 401));
      }
      authValidated = true;
    }

    if (url.pathname === "/health") {
      let config;
      try {
        config = preloadedConfig || await loadRuntimeConfig(options.getConfig, env);
      } catch {
        config = normalizeRuntimeConfig({});
      }

      return respond(jsonResponse({
        status: "ok",
        timestamp: new Date().toISOString(),
        providers: (config.providers || []).length
      }));
    }

    if (request.method === "GET" && normalizePath(url.pathname) === "/") {
      return respond(jsonResponse({
        name: "llm-router",
        status: "ok",
        endpoints: {
          unified: ["/", "/v1", "/route", "/v1/messages", "/v1/chat/completions"],
          anthropic: ["/anthropic", "/anthropic/v1/messages"],
          openai: ["/openai", "/openai/v1/chat/completions"]
        }
      }));
    }

    const route = resolveApiRoute(url.pathname, request.method);
    if (route?.type === "models") {
      const config = preloadedConfig || await loadRuntimeConfig(options.getConfig, env);
      return respond(jsonResponse({
        object: "list",
        data: getCachedModelList(
          config,
          route.sourceFormat === "auto" ? undefined : route.sourceFormat
        )
      }));
    }

    if (route?.type === "route") {
      const routeResponse = await handleRouteRequest(request, env, options.getConfig, route.sourceFormat, {
        ...options,
        preloadedConfig,
        authValidated
      });
      return respond(routeResponse);
    }

    return respond(jsonResponse({ error: "Not found" }, 404));
  };
}
