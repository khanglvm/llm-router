/**
 * Generic route request handler (Cloudflare Worker + local Node server).
 */

import { commitRouteSelection, rankRouteCandidates } from "./balancer.js";
import {
  configHasProvider,
  normalizeRuntimeConfig,
  resolveRequestModel
} from "./config.js";
import { consumeCandidateRateLimits } from "./rate-limits.js";
import {
  buildRouteKey,
  createStateStore
} from "./state-store.js";
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
  resolveFallbackCircuitPolicy,
  resolveRetryPolicy
} from "./handler/fallback.js";
import { sleep } from "./handler/utils.js";
import {
  applyCandidateFailureState,
  applyRuntimeRetryPolicyGuards,
  clearCandidateRoutingState,
  resolveRuntimeFlags,
  resolveStateStoreOptions
} from "./handler/runtime-policy.js";
import {
  buildRouteDebugState,
  isRoutingDebugEnabled,
  recordRouteAttempt,
  recordRouteSkip,
  setRouteSelectedCandidate,
  withRouteDebugHeaders
} from "./handler/route-debug.js";

function shouldConsumeQuotaFromResult(result) {
  return Boolean(result?.ok || result?.upstreamResponse instanceof Response);
}

function filterCandidatesByFormat(candidates) {
  const eligible = [];
  const skipped = [];

  for (const candidate of (candidates || [])) {
    if (!candidate) continue;
    if (candidate.targetFormat === FORMATS.OPENAI || candidate.targetFormat === FORMATS.CLAUDE) {
      eligible.push(candidate);
      continue;
    }
    skipped.push({
      candidate,
      reason: "format-incompatible"
    });
  }

  return { eligible, skipped };
}

function hasNextEligibleCandidate(entries, startIndex) {
  for (let index = startIndex + 1; index < (entries || []).length; index += 1) {
    if (entries[index]?.eligible) return true;
  }
  return false;
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

  const runtimeFlags = options.runtimeFlags || resolveRuntimeFlags(options, env);
  const fallbackCircuitPolicy = resolveFallbackCircuitPolicy(env);
  const retryPolicy = applyRuntimeRetryPolicyGuards(resolveRetryPolicy(env), runtimeFlags);
  const stateStore = runtimeFlags.statefulRoutingEnabled
    ? (options.stateStore || null)
    : null;
  const routeDebug = buildRouteDebugState(isRoutingDebugEnabled(env), resolved);
  const now = Date.now();

  if (stateStore) {
    try {
      await stateStore.pruneExpired(now);
    } catch {
      // Best effort only. Routing can continue with stale-but-safe state.
    }
  }

  const routePlan = {
    ...resolved,
    sourceFormat
  };
  const routeCandidates = [resolved.primary, ...resolved.fallbacks];
  const formatFiltered = filterCandidatesByFormat(routeCandidates);
  for (const skipped of formatFiltered.skipped) {
    recordRouteSkip(routeDebug, skipped.candidate, skipped.reason);
  }

  if (formatFiltered.eligible.length === 0) {
    return withRouteDebugHeaders(jsonResponse({
      type: "error",
      error: {
        type: "configuration_error",
        message: `Route '${resolved.routeRef || requestedModel}' has no format-compatible candidates.`
      }
    }, 400), routeDebug);
  }

  let ranking;
  try {
    ranking = await rankRouteCandidates({
      route: routePlan,
      routeKey: buildRouteKey(routePlan, { sourceFormat }),
      strategy: runtimeFlags.statefulRoutingEnabled && resolved.routeType === "alias"
        ? resolved.routeStrategy
        : "ordered",
      candidates: formatFiltered.eligible,
      stateStore,
      config,
      now
    });
  } catch (error) {
    return withRouteDebugHeaders(jsonResponse({
      type: "error",
      error: {
        type: "api_error",
        message: `Failed ranking route candidates: ${error instanceof Error ? error.message : String(error)}`
      }
    }, 500), routeDebug);
  }

  routeDebug.strategy = ranking.strategy;
  setRouteSelectedCandidate(routeDebug, ranking.selectedEntry?.candidate);
  for (const skippedEntry of (ranking.skippedEntries || [])) {
    recordRouteSkip(routeDebug, skippedEntry.candidate, skippedEntry.skipReasons);
  }

  if (!ranking.selectedEntry) {
    return withRouteDebugHeaders(jsonResponse({
      type: "error",
      error: {
        type: "api_error",
        message: `No eligible providers remain for route '${resolved.routeRef || requestedModel}'.`
      }
    }, 503), routeDebug);
  }

  let lastErrorResult = null;
  let lastErrorMessage = "Unknown error";
  let routeSelectionCommitted = false;

  for (let index = 0; index < ranking.entries.length; index += 1) {
    const entry = ranking.entries[index];
    if (!entry?.eligible) continue;

    const candidate = entry.candidate;
    const isOriginCandidate = entry.candidateKey === ranking.selectedEntry.candidateKey;
    const maxAttempts = isOriginCandidate ? retryPolicy.originRetryAttempts : 1;

    if (isOriginCandidate && !routeSelectionCommitted) {
      await commitRouteSelection(stateStore, ranking, {
        amount: 0,
        now: Date.now()
      });
      routeSelectionCommitted = true;
    }

    let result = null;
    let classification = null;
    let attempt = 0;
    let quotaConsumed = false;

    while (attempt < maxAttempts) {
      attempt += 1;
      result = await makeProviderCall({
        body,
        sourceFormat,
        stream,
        candidate,
        requestHeaders: request.headers,
        env
      });

      if (!quotaConsumed && shouldConsumeQuotaFromResult(result)) {
        await consumeCandidateRateLimits(stateStore, entry.rateLimitEvaluation, {
          amount: 1,
          now: Date.now()
        });
        quotaConsumed = true;
      }

      if (result.ok) {
        await clearCandidateRoutingState(stateStore, entry.candidateKey);
        setRouteSelectedCandidate(routeDebug, candidate, { overwrite: true });
        recordRouteAttempt(routeDebug, candidate, result.status, null, attempt);
        return withRouteDebugHeaders(result.response, routeDebug);
      }

      classification = await classifyFailureResult(result, retryPolicy);
      recordRouteAttempt(routeDebug, candidate, result?.status, classification, attempt);

      const canRetryOrigin = isOriginCandidate &&
        classification.retryOrigin &&
        attempt < maxAttempts;
      if (!canRetryOrigin) break;

      const delayMs = computeRetryDelayMs(attempt, retryPolicy);
      await sleep(delayMs);
    }

    await applyCandidateFailureState(
      stateStore,
      entry.candidateKey,
      classification,
      fallbackCircuitPolicy,
      result?.status,
      Date.now()
    );

    lastErrorResult = result;
    const isFallbackAttempt = !isOriginCandidate;
    lastErrorMessage = enrichErrorMessage(
      `status=${result?.status} category=${classification?.category || "unknown"}`,
      candidate,
      isFallbackAttempt
    );

    const hasNextCandidate = hasNextEligibleCandidate(ranking.entries, index);
    if (!hasNextCandidate || classification?.allowFallback === false) {
      return withRouteDebugHeaders(await buildFailureResponse(result), routeDebug);
    }
  }

  if (lastErrorResult) {
    return withRouteDebugHeaders(await buildFailureResponse(lastErrorResult), routeDebug);
  }

  return withRouteDebugHeaders(jsonResponse({
    type: "error",
    error: {
      type: "api_error",
      message: `All providers failed. ${lastErrorMessage}`
    }
  }, 503), routeDebug);
}

export function createFetchHandler(options) {
  if (!options || typeof options.getConfig !== "function") {
    throw new Error("createFetchHandler requires a getConfig(env) function.");
  }

  let stateStoreRef = options.stateStore || null;
  let stateStorePromise = null;

  async function ensureStateStore(env = {}, runtimeFlags = {}) {
    if (stateStoreRef) return stateStoreRef;
    if (!stateStorePromise) {
      stateStorePromise = createStateStore(resolveStateStoreOptions(options, env, runtimeFlags))
        .then((store) => {
          stateStoreRef = store;
          return store;
        })
        .catch((error) => {
          stateStorePromise = null;
          throw error;
        });
    }
    return stateStorePromise;
  }

  async function closeStateStore() {
    const stateStore = stateStoreRef || (stateStorePromise ? await stateStorePromise : null);
    if (stateStore && typeof stateStore.close === "function") {
      await stateStore.close();
    }
  }

  const fetchHandler = async function fetchHandler(request, env = {}, ctx) {
    const url = new URL(request.url);
    const respond = (response, corsOptions = {}) => withRequestCors(response, request, env, corsOptions);
    const runtimeFlags = resolveRuntimeFlags(options, env);
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
      let stateStore = null;
      if (runtimeFlags.statefulRoutingEnabled) {
        try {
          stateStore = await ensureStateStore(env, runtimeFlags);
        } catch (error) {
          return respond(jsonResponse({
            type: "error",
            error: {
              type: "configuration_error",
              message: `Failed initializing routing state: ${error instanceof Error ? error.message : String(error)}`
            }
          }, 500));
        }
      }

      const routeResponse = await handleRouteRequest(request, env, options.getConfig, route.sourceFormat, {
        ...options,
        preloadedConfig,
        authValidated,
        stateStore,
        runtimeFlags
      });
      return respond(routeResponse);
    }

    return respond(jsonResponse({ error: "Not found" }, 404));
  };

  fetchHandler.close = closeStateStore;
  return fetchHandler;
}
