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
  createStateStore,
  normalizeStateStoreBackend
} from "./state-store.js";
import { FORMATS } from "../translator/index.js";
import { shouldEnforceWorkerAuth, validateAuth } from "./handler/auth.js";
import { loadRuntimeConfig, getCachedModelList } from "./handler/config-loading.js";
import {
  buildFailureResponse,
  makeProviderCall
} from "./handler/provider-call.js";
import {
  convertAmpGeminiRequestToOpenAI,
  convertRouteResponseToAmpGemini
} from "./handler/amp-gemini-bridge.js";
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
import { buildAmpContext, resolveAmpRequestedModel } from "./handler/amp-routing.js";
import { sleep, toBoolean, toNonNegativeInteger } from "./handler/utils.js";

const ROUTE_DEBUG_MAX_LIST_ITEMS = 8;
const ROUTE_DEBUG_MAX_HEADER_VALUE_LENGTH = 512;
const AMP_CAPTURE_MAX_BODY_FIELDS = 40;
const AMP_CAPTURE_MAX_BODY_VALUE_LENGTH = 160;
const AMP_CAPTURE_MAX_MESSAGE_ROLES = 8;
const AMP_CAPTURE_MAX_INPUT_ITEM_TYPES = 12;
const AMP_CAPTURE_MAX_RAW_BODY_BYTES = 64 * 1024;
const SENSITIVE_HEADER_PATTERN = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
const SENSITIVE_FIELD_PATTERN = /(api[_-]?key|auth|authorization|cookie|password|secret|token)/i;
const AMP_CAPTURE_INTERESTING_PATH_PATTERN = /(^|\.)(agent|client|metadata|mode|source|tool|user[-_]?agent|thread|review|amp)(\.|$)/i;

function readRuntimeEnvValue(env = {}, name) {
  if (env && env[name] !== undefined && env[name] !== null && env[name] !== "") {
    return env[name];
  }
  if (typeof process !== "undefined" && process?.env && process.env[name] !== undefined) {
    return process.env[name];
  }
  return undefined;
}

function normalizeTimestamp(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function normalizeCount(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function isFallbackCircuitTrackingEnabled(policy) {
  return Number.isFinite(policy?.failureThreshold) &&
    Number.isFinite(policy?.cooldownMs) &&
    policy.failureThreshold > 0 &&
    policy.cooldownMs > 0;
}

function shouldTrackCandidateFailure(classification) {
  if (!classification) return false;
  if (classification.category === "invalid_request" || classification.category === "client_error") {
    return false;
  }
  if (classification.category === "not_supported_error") {
    return false;
  }
  return Boolean(classification.retryable || normalizeTimestamp(classification.originCooldownMs) > 0);
}

function shouldConsumeQuotaFromResult(result) {
  return Boolean(result?.ok || result?.upstreamResponse instanceof Response);
}

function candidateRef(candidate) {
  return candidate?.requestModelId ||
    (candidate?.providerId && candidate?.modelId
      ? `${candidate.providerId}/${candidate.modelId}`
      : candidate?.backend || "unknown/unknown");
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

function isRoutingDebugEnabled(env = {}) {
  return toBoolean(
    readRuntimeEnvValue(env, "LLM_ROUTER_DEBUG_ROUTING"),
    toBoolean(readRuntimeEnvValue(env, "LLM_ROUTER_DEBUG"), false)
  );
}

function isAmpCaptureEnabled(env = {}) {
  return toBoolean(readRuntimeEnvValue(env, "LLM_ROUTER_DEBUG_AMP_CAPTURE"), false);
}

function pushBounded(list, value, maxItems = ROUTE_DEBUG_MAX_LIST_ITEMS) {
  if (!Array.isArray(list) || !value) return;
  if (list.length >= maxItems) return;
  list.push(value);
}

function buildRouteDebugState(enabled, resolved, ampDebug = {}) {
  return {
    enabled,
    requestedModel: resolved?.requestedModel || "smart",
    routeType: resolved?.routeType || "direct",
    routeRef: resolved?.routeRef || resolved?.resolvedModel || resolved?.requestedModel || "smart",
    strategy: resolved?.routeStrategy || "ordered",
    selectedCandidate: "",
    skippedCandidates: [],
    attempts: [],
    ampDetected: toBoolean(ampDebug?.ampDetected, false),
    ampMode: String(ampDebug?.ampMode || ""),
    ampAgent: String(ampDebug?.ampAgent || ""),
    ampApplication: String(ampDebug?.ampApplication || ""),
    ampRequestedModel: String(ampDebug?.ampRequestedModel || ""),
    ampMatchedBy: String(ampDebug?.ampMatchedBy || ""),
    ampMatchedRef: String(ampDebug?.ampMatchedRef || "")
  };
}

function recordRouteSkip(debugState, candidate, reasons) {
  if (!debugState?.enabled) return;
  const reasonText = Array.isArray(reasons)
    ? reasons.filter(Boolean).join("+")
    : String(reasons || "").trim();
  pushBounded(
    debugState.skippedCandidates,
    `${candidateRef(candidate)}:${reasonText || "skipped"}`
  );
}

function recordRouteAttempt(debugState, candidate, status, classification, attempt) {
  if (!debugState?.enabled) return;
  const category = classification?.category || (status && status < 400 ? "ok" : "unknown");
  pushBounded(
    debugState.attempts,
    `${candidateRef(candidate)}:${Number.isFinite(status) ? status : "error"}/${category}#${attempt}`
  );
}

function setRouteSelectedCandidate(debugState, candidate, { overwrite = false } = {}) {
  if (!debugState?.enabled || !candidate) return;
  if (debugState.selectedCandidate && !overwrite) return;
  debugState.selectedCandidate = candidateRef(candidate);
}

function toSafeHeaderValue(value) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  if (!text) return "";
  return text.length > ROUTE_DEBUG_MAX_HEADER_VALUE_LENGTH
    ? text.slice(0, ROUTE_DEBUG_MAX_HEADER_VALUE_LENGTH)
    : text;
}

function summarizeScalarValue(value) {
  if (typeof value === "string") {
    const trimmed = value.replace(/[\r\n]+/g, " ").trim();
    if (!trimmed) return "";
    return trimmed.length > AMP_CAPTURE_MAX_BODY_VALUE_LENGTH
      ? trimmed.slice(0, AMP_CAPTURE_MAX_BODY_VALUE_LENGTH)
      : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null) return null;
  return undefined;
}

function sanitizeHeaderMap(headers) {
  const result = {};
  if (!headers || typeof headers.forEach !== "function") return result;

  headers.forEach((value, name) => {
    if (!name) return;
    const normalizedName = String(name).trim().toLowerCase();
    if (!normalizedName || SENSITIVE_HEADER_PATTERN.test(normalizedName)) return;
    if (SENSITIVE_FIELD_PATTERN.test(normalizedName)) return;
    const safeValue = toSafeHeaderValue(value);
    if (!safeValue) return;
    result[normalizedName] = safeValue;
  });

  return result;
}

function collectInterestingBodyFields(value, result, path = "", depth = 0) {
  if (!value || depth > 4 || result.length >= AMP_CAPTURE_MAX_BODY_FIELDS) return;

  if (Array.isArray(value)) {
    if (path && AMP_CAPTURE_INTERESTING_PATH_PATTERN.test(path)) {
      result.push({
        path,
        type: "array",
        length: value.length
      });
    }

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      const nextPath = path ? `${path}[${index}]` : `[${index}]`;
      if (typeof item === "object" && item) {
        collectInterestingBodyFields(item, result, nextPath, depth + 1);
        if (result.length >= AMP_CAPTURE_MAX_BODY_FIELDS) return;
        continue;
      }

      if (!AMP_CAPTURE_INTERESTING_PATH_PATTERN.test(nextPath)) continue;
      const safeValue = summarizeScalarValue(item);
      if (safeValue === undefined || safeValue === "") continue;
      result.push({ path: nextPath, value: safeValue });
      if (result.length >= AMP_CAPTURE_MAX_BODY_FIELDS) return;
    }
    return;
  }

  if (typeof value !== "object") {
    if (!AMP_CAPTURE_INTERESTING_PATH_PATTERN.test(path)) return;
    const safeValue = summarizeScalarValue(value);
    if (safeValue === undefined || safeValue === "") return;
    result.push({ path, value: safeValue });
    return;
  }

  for (const [rawKey, child] of Object.entries(value)) {
    const key = String(rawKey || "").trim();
    if (!key) continue;
    if (SENSITIVE_FIELD_PATTERN.test(key)) continue;
    const nextPath = path ? `${path}.${key}` : key;

    if (child && typeof child === "object") {
      if (AMP_CAPTURE_INTERESTING_PATH_PATTERN.test(nextPath)) {
        result.push({
          path: nextPath,
          type: Array.isArray(child) ? "array" : "object"
        });
        if (result.length >= AMP_CAPTURE_MAX_BODY_FIELDS) return;
      }
      collectInterestingBodyFields(child, result, nextPath, depth + 1);
      if (result.length >= AMP_CAPTURE_MAX_BODY_FIELDS) return;
      continue;
    }

    if (!AMP_CAPTURE_INTERESTING_PATH_PATTERN.test(nextPath)) continue;
    const safeValue = summarizeScalarValue(child);
    if (safeValue === undefined || safeValue === "") continue;
    result.push({ path: nextPath, value: safeValue });
    if (result.length >= AMP_CAPTURE_MAX_BODY_FIELDS) return;
  }
}

function summarizeRequestBody(body) {
  const topLevelKeys = body && typeof body === "object" && !Array.isArray(body)
    ? Object.keys(body)
    : [];
  const interestingFields = [];
  collectInterestingBodyFields(body, interestingFields);

  const summary = {
    topLevelKeys,
    interestingFields
  };

  if (Array.isArray(body?.messages)) {
    summary.messageCount = body.messages.length;
    summary.messageRoles = body.messages
      .map((message) => message?.role)
      .filter(Boolean)
      .slice(0, AMP_CAPTURE_MAX_MESSAGE_ROLES);
  }

  if (Array.isArray(body?.input)) {
    summary.inputItemCount = body.input.length;
    summary.inputItemTypes = body.input
      .map((item) => item?.type)
      .filter(Boolean)
      .slice(0, AMP_CAPTURE_MAX_INPUT_ITEM_TYPES);
  }

  if (typeof body?.model === "string" && body.model.trim()) {
    summary.model = body.model.trim();
  }

  if (typeof body?.stream === "boolean") {
    summary.stream = body.stream;
  }

  if (typeof body?.method === "string" && body.method.trim()) {
    summary.method = body.method.trim();
  }

  if (Array.isArray(body?.params)) {
    summary.paramsCount = body.params.length;
    const firstParam = body.params[0];
    if (firstParam && typeof firstParam === "object" && !Array.isArray(firstParam)) {
      summary.firstParamKeys = Object.keys(firstParam).slice(0, 24);
      if (typeof firstParam.mode === "string" && firstParam.mode.trim()) {
        summary.mode = firstParam.mode.trim();
      }
      if (typeof firstParam.agent === "string" && firstParam.agent.trim()) {
        summary.agent = firstParam.agent.trim();
      }
      if (typeof firstParam.type === "string" && firstParam.type.trim()) {
        summary.paramType = firstParam.type.trim();
      }
    }
  } else if (body?.params && typeof body.params === "object") {
    summary.paramsKeys = Object.keys(body.params).slice(0, 24);
    if (typeof body.params.mode === "string" && body.params.mode.trim()) {
      summary.mode = body.params.mode.trim();
    }
    if (typeof body.params.agent === "string" && body.params.agent.trim()) {
      summary.agent = body.params.agent.trim();
    }
  }

  return summary;
}

function buildRequestCorrelationId(request) {
  const headerValue = request?.headers?.get?.("x-request-id") || request?.headers?.get?.("x-correlation-id");
  if (headerValue) return toSafeHeaderValue(headerValue);
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildAmpCaptureLogPayload(request, body, context = {}) {
  const payload = {
    type: "amp-capture",
    stage: context.stage || "route",
    timestamp: new Date().toISOString(),
    requestId: context.requestId || buildRequestCorrelationId(request),
    method: String(request?.method || "POST").toUpperCase(),
    path: (() => {
      try {
        return new URL(String(request?.url || "")).pathname || "/";
      } catch {
        return "/";
      }
    })(),
    contentType: toSafeHeaderValue(request?.headers?.get?.("content-type")),
    userAgent: toSafeHeaderValue(request?.headers?.get?.("user-agent")),
    sourceFormatHint: context.sourceFormatHint || "auto",
    sourceFormat: context.sourceFormat || "unknown",
    requestedModel: context.requestedModel || "",
    headers: sanitizeHeaderMap(request?.headers),
    body: summarizeRequestBody(body)
  };

  if (context.routeDetected) payload.routeDetected = context.routeDetected;
  if (context.ampMode) payload.ampMode = context.ampMode;
  if (context.ampAgent) payload.ampAgent = context.ampAgent;
  if (context.ampApplication) payload.ampApplication = context.ampApplication;
  if (context.ampMatchedBy) payload.ampMatchedBy = context.ampMatchedBy;
  if (context.ampMatchedRef) payload.ampMatchedRef = context.ampMatchedRef;
  if (context.ampResolvedRequestedModel) payload.ampResolvedRequestedModel = context.ampResolvedRequestedModel;
  return payload;
}

function emitAmpCaptureLog(request, body, context = {}) {
  const payload = buildAmpCaptureLogPayload(request, body, context);
  console.error(`[llm-router][amp-capture] ${JSON.stringify(payload)}`);
}

async function parseCaptureBodyFromRequest(request) {
  if (!(request instanceof Request)) return null;
  const method = String(request.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) return null;

  try {
    const cloned = request.clone();
    const raw = await cloned.text();
    if (!raw || !raw.trim()) return null;
    if (raw.length > AMP_CAPTURE_MAX_RAW_BODY_BYTES) {
      return { _captureTruncated: true, _rawBytes: raw.length };
    }
    return JSON.parse(raw);
  } catch {
    return { _captureParseError: true };
  }
}

async function emitIncomingAmpCaptureLog(request, context = {}) {
  const body = await parseCaptureBodyFromRequest(request);
  const payload = {
    ...buildAmpCaptureLogPayload(request, body, {
      ...context,
      stage: context.stage || "incoming"
    }),
    routeDetected: context.routeDetected || "unknown"
  };

  console.error(`[llm-router][amp-capture] ${JSON.stringify(payload)}`);
}

function withRouteDebugHeaders(response, debugState) {
  if (!debugState?.enabled || !(response instanceof Response)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("x-llm-router-requested-model", toSafeHeaderValue(debugState.requestedModel));
  headers.set("x-llm-router-route-type", toSafeHeaderValue(debugState.routeType));
  headers.set("x-llm-router-route-ref", toSafeHeaderValue(debugState.routeRef));
  headers.set("x-llm-router-route-strategy", toSafeHeaderValue(debugState.strategy));

  const selectedCandidate = toSafeHeaderValue(debugState.selectedCandidate);
  if (selectedCandidate) {
    headers.set("x-llm-router-selected-candidate", selectedCandidate);
  }

  const skippedCandidates = toSafeHeaderValue(debugState.skippedCandidates.join(","));
  if (skippedCandidates) {
    headers.set("x-llm-router-skipped-candidates", skippedCandidates);
  }

  const attempts = toSafeHeaderValue(debugState.attempts.join(","));
  if (attempts) {
    headers.set("x-llm-router-attempts", attempts);
  }

  if (debugState.ampDetected) {
    headers.set("x-llm-router-amp-detected", "true");
  }
  const ampMode = toSafeHeaderValue(debugState.ampMode);
  if (ampMode) headers.set("x-llm-router-amp-mode", ampMode);
  const ampAgent = toSafeHeaderValue(debugState.ampAgent);
  if (ampAgent) headers.set("x-llm-router-amp-agent", ampAgent);
  const ampApplication = toSafeHeaderValue(debugState.ampApplication);
  if (ampApplication) headers.set("x-llm-router-amp-application", ampApplication);
  const ampRequestedModel = toSafeHeaderValue(debugState.ampRequestedModel);
  if (ampRequestedModel) headers.set("x-llm-router-amp-requested-model", ampRequestedModel);
  const ampMatchedBy = toSafeHeaderValue(debugState.ampMatchedBy);
  if (ampMatchedBy) headers.set("x-llm-router-amp-matched-by", ampMatchedBy);
  const ampMatchedRef = toSafeHeaderValue(debugState.ampMatchedRef);
  if (ampMatchedRef) headers.set("x-llm-router-amp-matched-ref", ampMatchedRef);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function handleAmpInternalRequest(request, env = {}) {
  const hasContentType = Boolean(request.headers.get("content-type"));
  if (hasContentType && !isJsonRequest(request)) {
    return jsonResponse({ error: "Unsupported Media Type. Use application/json." }, 415);
  }

  const maxRequestBodyBytes = resolveMaxRequestBodyBytes(env);
  let body = {};
  try {
    body = await parseJsonBodyWithLimit(request, maxRequestBodyBytes);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "REQUEST_BODY_TOO_LARGE") {
      return jsonResponse({ error: "Request body too large" }, 413);
    }
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const rpcId = body?.id ?? null;
  const wantsJsonRpc = body && typeof body === "object" && !Array.isArray(body)
    && (Object.prototype.hasOwnProperty.call(body, "id") || Object.prototype.hasOwnProperty.call(body, "jsonrpc"));
  const method = typeof body?.method === "string" ? body.method.trim() : "";
  const params = body?.params && typeof body.params === "object" && !Array.isArray(body.params)
    ? body.params
    : {};

  const makeRpcResponse = (result) => {
    const payload = wantsJsonRpc
      ? {
          jsonrpc: "2.0",
          id: rpcId,
          result
        }
      : {
          ok: true,
          result
        };
    if (isAmpCaptureEnabled(env)) {
      console.error(`[llm-router][amp-capture] ${JSON.stringify({
        type: "amp-capture",
        stage: "amp-internal-response",
        timestamp: new Date().toISOString(),
        method: method || "getUserInfo",
        payloadKeys: Object.keys(payload),
        resultKeys: Object.keys(result || {}),
        ok: payload.ok === true
      })}`);
    }
    return jsonResponse(payload);
  };

  if (!method || method === "getUserInfo") {
    const result = {
      id: "llm-router-local",
      name: "llm-router",
      email: "local@llm-router",
      plan: "local",
      authenticated: true,
      isAuthenticated: true,
      apiKeyValid: true,
      hasApiKey: true,
      features: [],
      user: {
        id: "llm-router-local",
        email: "local@llm-router",
        name: "llm-router"
      },
      mode: params?.mode || null
    };
    return makeRpcResponse(result);
  }

  if (method === "getUserFreeTierStatus") {
    return makeRpcResponse({
      canUseAmpFree: false,
      isDailyGrantEnabled: false,
      features: []
    });
  }

  if (method === "uploadThread") {
    const thread = params?.thread && typeof params.thread === "object" && !Array.isArray(params.thread)
      ? params.thread
      : null;
    const parsedVersion = Number(thread?.v);
    return makeRpcResponse({
      uploaded: true,
      threadId: typeof thread?.id === "string" ? thread.id : null,
      version: Number.isFinite(parsedVersion) ? parsedVersion : null
    });
  }

  if (method === "setThreadMeta") {
    return makeRpcResponse({
      updated: true,
      threadId: typeof params?.thread === "string" ? params.thread : null
    });
  }

  if (method === "getThreadLinkInfo") {
    return makeRpcResponse({
      creatorUserID: "llm-router-local"
    });
  }

  return makeRpcResponse({});
}

async function clearCandidateRoutingState(stateStore, candidateKey) {
  if (!stateStore || !candidateKey) return;
  await stateStore.setCandidateState(candidateKey, null);
}

async function applyCandidateFailureState(
  stateStore,
  candidateKey,
  classification,
  fallbackCircuitPolicy,
  status,
  now = Date.now()
) {
  if (!stateStore || !candidateKey || !shouldTrackCandidateFailure(classification)) {
    return;
  }

  const prior = await stateStore.getCandidateState(candidateKey) || {};
  const priorCooldownUntil = normalizeTimestamp(prior.cooldownUntil);
  const priorOpenUntil = normalizeTimestamp(prior.openUntil);
  const priorFailures = normalizeCount(
    prior.consecutiveRetryableFailures ?? prior.consecutiveFailures
  );

  const consecutiveRetryableFailures = classification.retryable
    ? priorFailures + 1
    : 0;

  let openUntil = priorOpenUntil > now ? priorOpenUntil : 0;
  if (
    classification.retryable &&
    isFallbackCircuitTrackingEnabled(fallbackCircuitPolicy) &&
    consecutiveRetryableFailures >= fallbackCircuitPolicy.failureThreshold
  ) {
    openUntil = Math.max(openUntil, now + fallbackCircuitPolicy.cooldownMs);
  }

  const cooldownMs = normalizeTimestamp(classification.originCooldownMs);
  const cooldownUntil = cooldownMs > 0
    ? Math.max(priorCooldownUntil, now + cooldownMs)
    : (priorCooldownUntil > now ? priorCooldownUntil : 0);

  await stateStore.setCandidateState(candidateKey, {
    ...prior,
    cooldownUntil,
    openUntil,
    consecutiveRetryableFailures,
    lastFailureAt: now,
    lastFailureStatus: Number.isFinite(status) ? Number(status) : 0,
    lastFailureCategory: classification.category,
    updatedAt: now
  });
}

function resolveStateStoreOptions(options = {}, env = {}) {
  const baseOptions = options.stateStoreOptions && typeof options.stateStoreOptions === "object"
    ? { ...options.stateStoreOptions }
    : {};
  const defaultBackend = normalizeStateStoreBackend(
    options.defaultStateStoreBackend || baseOptions.backend,
    "memory"
  );
  const backend = normalizeStateStoreBackend(
    options.stateStoreBackend || env?.LLM_ROUTER_STATE_BACKEND || baseOptions.backend,
    defaultBackend
  );
  const candidateStateTtlMs = toNonNegativeInteger(
    env?.LLM_ROUTER_CANDIDATE_STATE_TTL_MS,
    toNonNegativeInteger(options.stateStoreCandidateStateTtlMs, baseOptions.candidateStateTtlMs)
  );
  const rawFilePath = options.stateStoreFilePath || env?.LLM_ROUTER_STATE_FILE_PATH || baseOptions.filePath;
  const filePath = typeof rawFilePath === "string" && rawFilePath.trim()
    ? rawFilePath.trim()
    : undefined;

  return {
    ...baseOptions,
    backend,
    ...(candidateStateTtlMs !== undefined ? { candidateStateTtlMs } : {}),
    ...(backend === "file" && filePath ? { filePath } : {})
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

  const route = options.route || null;
  if (route?.type === "amp-provider-gemini-route") {
    const converted = convertAmpGeminiRequestToOpenAI(body, route);
    if (converted.error) {
      return jsonResponse({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: converted.error
        }
      }, 400);
    }
    body = converted.body;
  }

  let sourceFormat = sourceFormatHint === "auto"
    ? detectUserRequestFormat(request, body, FORMATS.CLAUDE)
    : sourceFormatHint;
  if (route?.type === "amp-provider-gemini-route") {
    sourceFormat = FORMATS.OPENAI;
  }
  const originalRequestedModel = body?.model || route?.ampModelId || "smart";
  const requestId = buildRequestCorrelationId(request);
  const stream = isStreamingEnabled(sourceFormat, body);

  const ampContext = buildAmpContext(request, body, route);
  const ampResolved = resolveAmpRequestedModel(config, originalRequestedModel, ampContext);
  const requestedModel = ampResolved.requestedModel || originalRequestedModel || "smart";

  if (isAmpCaptureEnabled(env)) {
    emitAmpCaptureLog(request, body, {
      requestId,
      stage: "route",
      sourceFormatHint,
      sourceFormat,
      requestedModel: originalRequestedModel,
      routeDetected: route?.type || "route",
      ampMode: ampContext.mode || "",
      ampAgent: ampContext.agent || "",
      ampApplication: ampContext.application || "",
      ampMatchedBy: ampResolved.ampMatchedBy || "",
      ampMatchedRef: ampResolved.ampMatchedRef || "",
      ampResolvedRequestedModel: requestedModel
    });
  }

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

  const fallbackCircuitPolicy = resolveFallbackCircuitPolicy(env);
  const retryPolicy = resolveRetryPolicy(env);
  const stateStore = options.stateStore || null;
  const routeDebug = buildRouteDebugState(isRoutingDebugEnabled(env), resolved, {
    ampDetected: ampContext.isAmp,
    ampMode: ampContext.mode,
    ampAgent: ampContext.agent,
    ampApplication: ampContext.application,
    ampRequestedModel: originalRequestedModel,
    ampMatchedBy: ampResolved.ampMatchedBy,
    ampMatchedRef: ampResolved.ampMatchedRef
  });
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
      strategy: resolved.routeType === "alias" ? resolved.routeStrategy : "ordered",
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
        providerOperation: options?.route?.providerOperation,
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

  async function ensureStateStore(env = {}) {
    if (stateStoreRef) return stateStoreRef;
    if (!stateStorePromise) {
      stateStorePromise = createStateStore(resolveStateStoreOptions(options, env))
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
    let preloadedConfig = null;
    let authValidated = false;
    const route = resolveApiRoute(url.pathname, request.method);

    if (isAmpCaptureEnabled(env)) {
      await emitIncomingAmpCaptureLog(request, {
        requestId: buildRequestCorrelationId(request),
        routeDetected: route?.type || "none"
      });
    }

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

    if (
      route?.type === "route" ||
      route?.type === "amp-provider-route" ||
      route?.type === "amp-provider-gemini-route"
    ) {
      let stateStore;
      try {
        stateStore = await ensureStateStore(env);
      } catch (error) {
        return respond(jsonResponse({
          type: "error",
          error: {
            type: "configuration_error",
            message: `Failed initializing routing state: ${error instanceof Error ? error.message : String(error)}`
          }
        }, 500));
      }

      const routeResponse = await handleRouteRequest(request, env, options.getConfig, route.sourceFormat, {
        ...options,
        route,
        preloadedConfig,
        authValidated,
        stateStore
      });
      const finalResponse = route?.type === "amp-provider-gemini-route"
        ? await convertRouteResponseToAmpGemini(routeResponse)
        : routeResponse;
      return respond(finalResponse);
    }

    if (route?.type === "amp-internal") {
      const internalResponse = await handleAmpInternalRequest(request, env);
      return respond(internalResponse);
    }

    return respond(jsonResponse({ error: "Not found" }, 404));
  };

  fetchHandler.close = closeStateStore;
  return fetchHandler;
}
