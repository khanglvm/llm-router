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
  estimateRequestContextTokens,
  inferAmpContextRequirement,
  isAmpManagementPath,
  isJsonRequest,
  isStreamingEnabled,
  normalizePath,
  parseJsonBodyWithLimit,
  resolveApiRoute,
  resolveMaxRequestBodyBytes
} from "./handler/request.js";
import {
  isAmpManagementAllowed,
  isAmpProxyEnabled,
  proxyAmpUpstreamRequest
} from "./handler/amp.js";
import {
  adaptOpenAIResponseToAmpGeminiResponse,
  buildAmpGeminiModelPayload,
  buildAmpGeminiModelsPayload,
  convertAmpGeminiRequestToOpenAI,
  hasGeminiWebSearchTool
} from "./handler/amp-gemini.js";
import { shouldInterceptAmpWebSearch } from "./handler/amp-web-search.js";
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
import { parseJsonSafely, sleep } from "./handler/utils.js";
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
  setRouteContextDebug,
  setRouteSelectedCandidate,
  setRouteToolDebug,
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

function extractBuiltInToolTypes(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const seen = new Set();
  const types = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const type = String(tool.type || "").trim();
    if (!type) continue;
    if (type === "function") continue;
    if (seen.has(type)) continue;
    seen.add(type);
    types.push(type);
  }

  return types;
}

function isWebSearchToolType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith("web_search");
}

function hasWebSearchTool(toolTypes) {
  return Array.isArray(toolTypes) && toolTypes.some((type) => isWebSearchToolType(type));
}

function hasAmpUpstreamApiKey(config) {
  return Boolean(String(config?.amp?.upstreamApiKey || "").trim());
}

function shouldProxyAmpWebSearchRequest(clientType, toolTypes, config) {
  return clientType === "amp"
    && hasWebSearchTool(toolTypes)
    && config?.amp?.proxyWebSearchToUpstream === true
    && isAmpProxyEnabled(config)
    && hasAmpUpstreamApiKey(config);
}

function buildAmpWebSearchProxyDebugState(env, requestedModel, toolTypes) {
  const routeDebug = buildRouteDebugState(isRoutingDebugEnabled(env), {
    requestedModel,
    routeType: "amp-proxy",
    routeRef: "amp.upstream",
    routeStrategy: "ordered"
  });
  setRouteToolDebug(routeDebug, toolTypes, "amp-web-search:proxy-upstream");
  return routeDebug;
}

function isChatGPTCodexCandidate(candidate) {
  const provider = candidate?.provider;
  if (!provider || provider.type !== "subscription") return false;
  const subscriptionType = String(provider.subscriptionType || provider.subscription_type || "").trim().toLowerCase();
  return subscriptionType === "chatgpt-codex";
}

function resolveCandidateContextWindow(candidate) {
  const raw = candidate?.contextWindow ?? candidate?.model?.contextWindow;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function resolveSelectedContextRisk(candidate, estimatedRequiredTokens) {
  const requiredTokens = Number(estimatedRequiredTokens);
  if (!candidate || !Number.isFinite(requiredTokens) || requiredTokens <= 0) return "";

  const contextWindow = resolveCandidateContextWindow(candidate);
  if (!contextWindow) {
    return "selected-context-window-unknown";
  }
  if (contextWindow < requiredTokens) {
    return `selected-context-window-below-required:${contextWindow}<${requiredTokens}`;
  }
  return "";
}

const WEB_SEARCH_UNAVAILABLE_HINTS = [
  "web search credits are unavailable in this session",
  "web access unavailable (out of credits)",
  "web access unavailable"
];
const ACTIVITY_LOG_ERROR_DETAIL_MAX_CHARS = 240;

function queueActivityEvent(onActivityLog, payload) {
  if (typeof onActivityLog !== "function") return;
  try {
    const result = onActivityLog(payload);
    if (result && typeof result.then === "function") {
      result.catch(() => {});
    }
  } catch {
  }
}

function getNextEligibleCandidateEntry(entries, startIndex) {
  for (let index = startIndex + 1; index < (entries || []).length; index += 1) {
    if (entries[index]?.eligible) return entries[index];
  }
  return null;
}

function formatActivityCandidateLabel(candidate) {
  const providerId = String(candidate?.providerId || "unknown").trim() || "unknown";
  const modelId = String(candidate?.modelId || candidate?.backend || "unknown").trim() || "unknown";
  return `${providerId}/${modelId}`;
}

function formatActivityRouteLabel(requestedModel, resolved) {
  const requested = String(requestedModel || "").trim() || "smart";
  const routeRef = String(resolved?.routeRef || "").trim();
  return routeRef && routeRef !== requested ? `${requested} -> ${routeRef}` : (routeRef || requested);
}

function formatFailureCategory(category) {
  return String(category || "")
    .trim()
    .replace(/_/g, " ");
}

function buildFailureSummary(result, classification) {
  const parts = [];
  const status = Number.isFinite(result?.status) ? Number(result.status) : 0;
  if (status > 0) parts.push(`status ${status}`);
  const category = formatFailureCategory(classification?.category);
  if (category) parts.push(category);
  return parts.join(" · ") || "request failed";
}

function buildActivityDetail(baseMessage, providerMessage = "") {
  const detail = String(providerMessage || "").trim();
  if (!detail) return baseMessage;
  return `${baseMessage} Provider said: ${detail}`;
}

async function readActivityErrorDetail(result) {
  const response = result?.upstreamResponse instanceof Response
    ? result.upstreamResponse
    : (result?.response instanceof Response ? result.response : null);
  if (!(response instanceof Response)) return "";

  try {
    const raw = (await response.clone().text()).trim();
    if (!raw) return "";
    const parsed = parseJsonSafely(raw, null);
    const message = parsed?.error?.message
      || parsed?.error?.code
      || parsed?.error?.type
      || parsed?.error
      || parsed?.code
      || parsed?.type
      || parsed?.message
      || raw;
    const compact = String(message || "").replace(/\s+/g, " ").trim();
    if (!compact) return "";
    if (compact.length <= ACTIVITY_LOG_ERROR_DETAIL_MAX_CHARS) return compact;
    return `${compact.slice(0, ACTIVITY_LOG_ERROR_DETAIL_MAX_CHARS - 1)}…`;
  } catch {
    return "";
  }
}

function extractAssistantTextFragments(payload) {
  const fragments = [];
  if (!payload || typeof payload !== "object") return fragments;

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    fragments.push(payload.output_text.trim());
  }

  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      const content = choice?.message?.content;
      if (typeof content === "string" && content.trim()) {
        fragments.push(content.trim());
      }
    }
  }

  if (payload.type === "message" && Array.isArray(payload.content)) {
    for (const block of payload.content) {
      if (typeof block?.text === "string" && block.text.trim()) {
        fragments.push(block.text.trim());
      }
    }
  }

  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (item?.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) continue;
      for (const block of item.content) {
        if (typeof block?.text === "string" && block.text.trim()) {
          fragments.push(block.text.trim());
          continue;
        }
        if (typeof block?.refusal === "string" && block.refusal.trim()) {
          fragments.push(block.refusal.trim());
        }
      }
    }
  }

  return fragments;
}

async function detectSemanticWebSearchFailure(response, toolTypes, stream = false) {
  if (stream) return "";
  if (!(response instanceof Response)) return "";
  if (!Array.isArray(toolTypes) || !toolTypes.some((type) => isWebSearchToolType(type))) return "";

  let fragments = [];
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("json")) {
    try {
      const payload = await response.clone().json();
      fragments = extractAssistantTextFragments(payload);
    } catch {
      fragments = [];
    }
  }

  if (fragments.length === 0) {
    try {
      const raw = await response.clone().text();
      if (raw.trim()) fragments = [raw.trim()];
    } catch {
      fragments = [];
    }
  }

  const normalized = fragments.join("\n").toLowerCase();
  if (!normalized) return "";

  for (const hint of WEB_SEARCH_UNAVAILABLE_HINTS) {
    if (normalized.includes(hint)) return hint;
  }
  return "";
}

function createSemanticWebSearchFailureResult(response) {
  return {
    ok: false,
    status: response instanceof Response ? response.status : 200,
    retryable: false,
    errorKind: "search_unavailable",
    response
  };
}

function createSemanticWebSearchFailureClassification() {
  return {
    category: "search_unavailable",
    retryable: false,
    retryOrigin: false,
    allowFallback: true,
    originCooldownMs: 0
  };
}

function prioritizeAmpToolAwareCandidates(candidates, toolTypes, options = {}) {
  const toolTypeList = Array.isArray(toolTypes) ? toolTypes : [];
  if (options?.clientType !== "amp") {
    return {
      candidates,
      routingHint: ""
    };
  }
  if (!toolTypeList.some((type) => isWebSearchToolType(type))) {
    return {
      candidates,
      routingHint: ""
    };
  }
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return {
      candidates,
      routingHint: "amp-web-search-request"
    };
  }

  const prioritized = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      penalty: isChatGPTCodexCandidate(candidate) ? 1 : 0
    }))
    .sort((left, right) => left.penalty - right.penalty || left.index - right.index)
    .map((entry) => entry.candidate);

  const changed = prioritized.some((candidate, index) => candidate !== candidates[index]);
  return {
    candidates: prioritized,
    routingHint: changed
      ? "amp-web-search:prefer-non-codex"
      : "amp-web-search-request"
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
    if (options.clientType === "amp" && isAmpProxyEnabled(config)) {
      return proxyAmpUpstreamRequest({ request, config });
    }
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
  const builtInToolTypes = extractBuiltInToolTypes(body);

  const requestedModel = body?.model || "smart";
  const stream = isStreamingEnabled(sourceFormat, body);

  const interceptAmpWebSearch = shouldInterceptAmpWebSearch({
    clientType: options.clientType,
    originalBody: body,
    runtimeConfig: config,
    env
  });

  if (!interceptAmpWebSearch && shouldProxyAmpWebSearchRequest(options.clientType, builtInToolTypes, config)) {
    const routeDebug = buildAmpWebSearchProxyDebugState(env, requestedModel, builtInToolTypes);
    if (routeDebug.enabled) {
      console.warn(
        `[llm-router] tool routing request=${requestedModel} tools=${builtInToolTypes.join(",")} hint=${routeDebug.toolRouting || "none"}`
      );
    }
    return withRouteDebugHeaders(await proxyAmpUpstreamRequest({
      request,
      config,
      bodyOverride: JSON.stringify(body || {})
    }), routeDebug);
  }

  const resolved = resolveRequestModel(config, requestedModel, sourceFormat, {
    clientType: options.clientType,
    providerHint: options.providerHint
  });
  if (!resolved.primary) {
    if (options.clientType === "amp" && resolved.allowAmpProxy !== false && isAmpProxyEnabled(config)) {
      return proxyAmpUpstreamRequest({
        request,
        config,
        bodyOverride: JSON.stringify(body || {})
      });
    }
    return jsonResponse({
      type: "error",
      error: {
        type: "configuration_error",
        message: resolved.error || `No matching model found for "${requestedModel}" and no default provider/model configured.`
      }
    }, Number.isInteger(resolved?.statusCode) ? resolved.statusCode : 400);
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
  const routeLabel = formatActivityRouteLabel(requestedModel, resolved);
  const requestContext = estimateRequestContextTokens(body);
  const ampContextRequirement = inferAmpContextRequirement(request, body, options);
  const effectiveRequiredTokens = Math.max(
    Number(requestContext?.estimatedRequiredTokens) || 0,
    Number(ampContextRequirement?.minimumContextTokens) || 0
  );
  const effectiveRequestContext = {
    ...requestContext,
    ampMinimumContextTokens: Number(ampContextRequirement?.minimumContextTokens) || 0,
    ampContextSource: String(ampContextRequirement?.source || "").trim(),
    estimatedRequiredTokens: effectiveRequiredTokens
  };
  setRouteContextDebug(routeDebug, {
    requiredTokens: effectiveRequiredTokens,
    hintSource: effectiveRequiredTokens > (Number(requestContext?.estimatedRequiredTokens) || 0)
      ? ampContextRequirement?.source || "request-context-hint"
      : (effectiveRequiredTokens > 0 ? "request-body-estimate" : "")
  });
  if (routeDebug.enabled && effectiveRequestContext.ampContextSource) {
    console.warn(
      `[llm-router] context hint request=${requestedModel} source=${effectiveRequestContext.ampContextSource} required=${effectiveRequiredTokens}`
    );
  }
  const routeCandidates = [resolved.primary, ...resolved.fallbacks];
  const formatFiltered = filterCandidatesByFormat(routeCandidates);
  for (const skipped of formatFiltered.skipped) {
    recordRouteSkip(routeDebug, skipped.candidate, skipped.reason);
  }
  const prioritizedCandidates = prioritizeAmpToolAwareCandidates(formatFiltered.eligible, builtInToolTypes, options);
  setRouteToolDebug(routeDebug, builtInToolTypes, prioritizedCandidates.routingHint);
  if (routeDebug.enabled && builtInToolTypes.length > 0) {
    console.warn(
      `[llm-router] tool routing request=${requestedModel} tools=${builtInToolTypes.join(",")} hint=${prioritizedCandidates.routingHint || "none"}`
    );
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
      candidates: prioritizedCandidates.candidates,
      stateStore,
      config,
      requestContext: effectiveRequestContext,
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
  setRouteContextDebug(routeDebug, {
    risk: resolveSelectedContextRisk(
      ranking.selectedEntry?.candidate,
      effectiveRequestContext.estimatedRequiredTokens
    )
  });
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
  let pendingFallbackContext = null;

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
        requestKind: options.requestKind,
        candidate,
        requestHeaders: request.headers,
        env,
        clientType: options.clientType,
        runtimeConfig: config,
        stateStore
      });

      if (!quotaConsumed && shouldConsumeQuotaFromResult(result)) {
        await consumeCandidateRateLimits(stateStore, entry.rateLimitEvaluation, {
          amount: 1,
          now: Date.now()
        });
        quotaConsumed = true;
      }

      if (result.ok) {
        const semanticSearchFailure = await detectSemanticWebSearchFailure(result.response, builtInToolTypes, stream);
        if (semanticSearchFailure) {
          classification = createSemanticWebSearchFailureClassification();
          result = createSemanticWebSearchFailureResult(result.response);
          recordRouteAttempt(routeDebug, candidate, result.status, classification, attempt);
          if (routeDebug.enabled) {
            console.warn(
              `[llm-router] semantic web-search failure request=${requestedModel} candidate=${candidate.requestModelId} hint=${semanticSearchFailure}`
            );
          }
          break;
        }
        await clearCandidateRoutingState(stateStore, entry.candidateKey);
        setRouteSelectedCandidate(routeDebug, candidate, { overwrite: true });
        setRouteContextDebug(routeDebug, {
          risk: resolveSelectedContextRisk(candidate, effectiveRequestContext.estimatedRequiredTokens)
        });
        recordRouteAttempt(routeDebug, candidate, result.status, null, attempt);
        if (pendingFallbackContext) {
          queueActivityEvent(options.onActivityLog, {
            level: "success",
            message: `Fallback request succeeded for ${routeLabel}.`,
            detail: `${formatActivityCandidateLabel(candidate)} completed the request after ${pendingFallbackContext.failedCandidate} failed (${pendingFallbackContext.failureSummary}).`,
            source: "runtime",
            category: "usage",
            kind: "fallback-succeeded",
            route: routeLabel
          });
          pendingFallbackContext = null;
        }
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

    const nextCandidateEntry = getNextEligibleCandidateEntry(ranking.entries, index);
    const hasNextCandidate = Boolean(nextCandidateEntry);
    const failureSummary = buildFailureSummary(result, classification);
    const providerMessage = await readActivityErrorDetail(result);
    if (hasNextCandidate && classification?.allowFallback !== false) {
      queueActivityEvent(options.onActivityLog, {
        level: "warn",
        message: `Request fallback triggered for ${routeLabel}.`,
        detail: buildActivityDetail(
          `${formatActivityCandidateLabel(candidate)} failed (${failureSummary}). Trying ${formatActivityCandidateLabel(nextCandidateEntry?.candidate)} next.`,
          providerMessage
        ),
        source: "runtime",
        category: "usage",
        kind: "fallback-triggered",
        route: routeLabel
      });
      pendingFallbackContext = {
        failedCandidate: formatActivityCandidateLabel(candidate),
        failureSummary
      };
    }
    if (!hasNextCandidate || classification?.allowFallback === false) {
      queueActivityEvent(options.onActivityLog, {
        level: "error",
        message: `Request failed for ${routeLabel}.`,
        detail: buildActivityDetail(
          `${formatActivityCandidateLabel(candidate)} failed (${failureSummary})${classification?.allowFallback === false ? ". Fallback stopped for this error." : ". No more fallbacks are available."}`,
          providerMessage
        ),
        source: "runtime",
        category: "usage",
        kind: "request-failed",
        route: routeLabel
      });
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

    if (isAmpManagementPath(url.pathname)) {
      let config;
      try {
        config = preloadedConfig || await loadRuntimeConfig(options.getConfig, env);
      } catch (error) {
        return respond(jsonResponse({
          type: "error",
          error: {
            type: "configuration_error",
            message: `Failed reading runtime config: ${error instanceof Error ? error.message : String(error)}`
          }
        }, 500));
      }

      if (authValidated !== true && !validateAuth(request, config, options)) {
        return respond(jsonResponse({ error: "Unauthorized" }, 401));
      }

      if (!isAmpManagementAllowed(request, config)) {
        return respond(jsonResponse({ error: "Forbidden" }, 403));
      }

      return respond(await proxyAmpUpstreamRequest({ request, config }));
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

    if (["amp-gemini-models", "amp-gemini-model", "amp-gemini"].includes(route?.type)) {
      let config;
      try {
        config = preloadedConfig || await loadRuntimeConfig(options.getConfig, env);
      } catch (error) {
        return respond(jsonResponse({
          type: "error",
          error: {
            type: "configuration_error",
            message: `Failed reading runtime config: ${error instanceof Error ? error.message : String(error)}`
          }
        }, 500));
      }

      if (authValidated !== true && !validateAuth(request, config, options)) {
        return respond(jsonResponse({ error: "Unauthorized" }, 401));
      }

      if (route.type === "amp-gemini-models") {
        return respond(jsonResponse(buildAmpGeminiModelsPayload(config)));
      }

      if (route.type === "amp-gemini-model") {
        const modelPayload = buildAmpGeminiModelPayload(config, route.modelHint);
        if (modelPayload) {
          return respond(jsonResponse(modelPayload));
        }
        if (isAmpProxyEnabled(config)) {
          return respond(await proxyAmpUpstreamRequest({ request, config }));
        }
        return respond(jsonResponse({
          error: {
            code: 404,
            message: `AMP Gemini model '${route.modelHint}' not found.`,
            status: "NOT_FOUND"
          }
        }, 404));
      }

      const hasContentType = Boolean(request.headers.get("content-type"));
      if (hasContentType && !isJsonRequest(request)) {
        return respond(jsonResponse({ error: "Unsupported Media Type. Use application/json." }, 415));
      }

      let body;
      try {
        body = await parseJsonBodyWithLimit(request, resolveMaxRequestBodyBytes(env));
      } catch (error) {
        if (error && typeof error === "object" && error.code === "REQUEST_BODY_TOO_LARGE") {
          return respond(jsonResponse({ error: "Request body too large" }, 413));
        }
        return respond(jsonResponse({ error: "Invalid JSON" }, 400));
      }

      const geminiToolTypes = hasGeminiWebSearchTool(body?.tools) ? ["web_search"] : [];
      const requestedModel = route.modelHint || body?.model || "smart";
      if (shouldProxyAmpWebSearchRequest("amp", geminiToolTypes, config)) {
        const routeDebug = buildAmpWebSearchProxyDebugState(env, requestedModel, geminiToolTypes);
        if (routeDebug.enabled) {
          console.warn(
            `[llm-router] tool routing request=${requestedModel} tools=${geminiToolTypes.join(",")} hint=${routeDebug.toolRouting || "none"}`
          );
        }
        return respond(withRouteDebugHeaders(await proxyAmpUpstreamRequest({
          request,
          config,
          bodyOverride: JSON.stringify(body || {})
        }), routeDebug));
      }

      const translatedBody = convertAmpGeminiRequestToOpenAI(body, {
        model: route.modelHint || body?.model,
        method: route.methodHint,
        stream: route.streamHint
      });

      const resolved = resolveRequestModel(config, translatedBody.model, FORMATS.OPENAI, {
        clientType: "amp",
        providerHint: "google"
      });
      if (!resolved.primary) {
        if (isAmpProxyEnabled(config)) {
          return respond(await proxyAmpUpstreamRequest({
            request,
            config,
            bodyOverride: JSON.stringify(body || {})
          }));
        }
        return respond(jsonResponse({
          error: {
            code: Number.isInteger(resolved?.statusCode) ? resolved.statusCode : 400,
            message: resolved.error || `No matching model found for AMP Gemini request '${translatedBody.model}'.`,
            status: "INVALID_ARGUMENT"
          }
        }, Number.isInteger(resolved?.statusCode) ? resolved.statusCode : 400));
      }

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

      const translatedHeaders = new Headers(request.headers);
      translatedHeaders.set("content-type", "application/json");
      const translatedRequest = new Request(request.url, {
        method: "POST",
        headers: translatedHeaders,
        body: JSON.stringify(translatedBody)
      });

      const routeResponse = await handleRouteRequest(translatedRequest, env, options.getConfig, FORMATS.OPENAI, {
        ...options,
        preloadedConfig: config,
        authValidated: true,
        clientType: "amp",
        providerHint: "google",
        requestKind: "chat-completions",
        stateStore,
        runtimeFlags
      });

      if (routeResponse.status >= 400) {
        return respond(routeResponse);
      }

      return respond(await adaptOpenAIResponseToAmpGeminiResponse(routeResponse, {
        stream: route.streamHint === true
      }));
    }

    if (route?.type === "amp-proxy") {
      const config = preloadedConfig || await loadRuntimeConfig(options.getConfig, env);
      if (authValidated !== true && !validateAuth(request, config, options)) {
        return respond(jsonResponse({ error: "Unauthorized" }, 401));
      }
      return respond(await proxyAmpUpstreamRequest({ request, config }));
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
        clientType: route.clientType,
        providerHint: route.providerHint,
        requestKind: route.requestKind,
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
