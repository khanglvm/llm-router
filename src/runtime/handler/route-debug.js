import { toBoolean } from "./utils.js";

const ROUTE_DEBUG_MAX_LIST_ITEMS = 8;
const ROUTE_DEBUG_MAX_HEADER_VALUE_LENGTH = 512;

function candidateRef(candidate) {
  return candidate?.requestModelId ||
    (candidate?.providerId && candidate?.modelId
      ? `${candidate.providerId}/${candidate.modelId}`
      : candidate?.backend || "unknown/unknown");
}

function pushBounded(list, value, maxItems = ROUTE_DEBUG_MAX_LIST_ITEMS) {
  if (!Array.isArray(list) || !value) return;
  if (list.length >= maxItems) return;
  list.push(value);
}

function toSafeHeaderValue(value) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  if (!text) return "";
  return text.length > ROUTE_DEBUG_MAX_HEADER_VALUE_LENGTH
    ? text.slice(0, ROUTE_DEBUG_MAX_HEADER_VALUE_LENGTH)
    : text;
}

export function isRoutingDebugEnabled(env = {}) {
  return toBoolean(
    env?.LLM_ROUTER_DEBUG_ROUTING,
    toBoolean(env?.LLM_ROUTER_DEBUG, false)
  );
}

export function buildRouteDebugState(enabled, resolved) {
  return {
    enabled,
    requestedModel: resolved?.requestedModel || "smart",
    routeType: resolved?.routeType || "direct",
    routeRef: resolved?.routeRef || resolved?.resolvedModel || resolved?.requestedModel || "smart",
    strategy: resolved?.routeStrategy || "ordered",
    selectedCandidate: "",
    skippedCandidates: [],
    attempts: []
  };
}

export function recordRouteSkip(debugState, candidate, reasons) {
  if (!debugState?.enabled) return;
  const reasonText = Array.isArray(reasons)
    ? reasons.filter(Boolean).join("+")
    : String(reasons || "").trim();
  pushBounded(
    debugState.skippedCandidates,
    `${candidateRef(candidate)}:${reasonText || "skipped"}`
  );
}

export function recordRouteAttempt(debugState, candidate, status, classification, attempt) {
  if (!debugState?.enabled) return;
  const category = classification?.category || (status && status < 400 ? "ok" : "unknown");
  pushBounded(
    debugState.attempts,
    `${candidateRef(candidate)}:${Number.isFinite(status) ? status : "error"}/${category}#${attempt}`
  );
}

export function setRouteSelectedCandidate(debugState, candidate, { overwrite = false } = {}) {
  if (!debugState?.enabled || !candidate) return;
  if (debugState.selectedCandidate && !overwrite) return;
  debugState.selectedCandidate = candidateRef(candidate);
}

export function withRouteDebugHeaders(response, debugState) {
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

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
