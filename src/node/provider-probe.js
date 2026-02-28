/**
 * Provider probing utilities (Node CLI config/update flow).
 * Detects supported request/response format(s) and attempts model discovery.
 */

import { FORMATS } from "../translator/index.js";
import { resolveProviderUrl } from "../runtime/config.js";

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_PROBE_REQUESTS_PER_MINUTE = 30;
const DEFAULT_RATE_LIMIT_MAX_RETRIES = 3;
const MIN_RATE_LIMIT_WAIT_MS = 250;

function normalizePositiveInteger(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function sleep(ms) {
  const waitMs = Number(ms);
  if (!Number.isFinite(waitMs) || waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

function makeProviderShell(baseUrl) {
  return {
    baseUrl,
    formats: [FORMATS.OPENAI, FORMATS.CLAUDE],
    format: FORMATS.OPENAI
  };
}

function normalizeProbeBaseUrlByFormat(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const openai = typeof value.openai === "string" ? value.openai.trim() : "";
  const claude = typeof value.claude === "string"
    ? value.claude.trim()
    : (typeof value.anthropic === "string" ? value.anthropic.trim() : "");
  const out = {};
  if (openai) out[FORMATS.OPENAI] = openai;
  if (claude) out[FORMATS.CLAUDE] = claude;
  return Object.keys(out).length > 0 ? out : undefined;
}

function cloneHeaders(headers) {
  return { ...(headers || {}) };
}

function makeProgressEmitter(callback) {
  if (typeof callback !== "function") return () => {};
  return (event) => {
    try {
      callback(event);
    } catch {
      // ignore probe progress callback failures
    }
  };
}

function makeAuthVariants(format, apiKey) {
  if (!apiKey) return [];

  if (format === FORMATS.CLAUDE) {
    return [
      { type: "x-api-key", headers: { "x-api-key": apiKey } },
      { type: "bearer", headers: { Authorization: `Bearer ${apiKey}` } }
    ];
  }

  return [
    { type: "bearer", headers: { Authorization: `Bearer ${apiKey}` } },
    { type: "x-api-key", headers: { "x-api-key": apiKey } }
  ];
}

function resolveModelsUrl(baseUrl, format) {
  const clean = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!clean) return "";
  const isVersionedApiRoot = /\/v\d+(?:\.\d+)?$/i.test(clean);

  if (format === FORMATS.OPENAI) {
    if (clean.endsWith("/chat/completions")) {
      return clean.replace(/\/chat\/completions$/, "/models");
    }
    if (clean.endsWith("/v1") || isVersionedApiRoot) return `${clean}/models`;
    return `${clean}/v1/models`;
  }

  if (clean.endsWith("/v1/messages")) {
    return clean.replace(/\/messages$/, "/models");
  }
  if (clean.endsWith("/messages")) {
    const parent = clean.replace(/\/messages$/, "");
    if (parent.endsWith("/v1") || /\/v\d+(?:\.\d+)?$/i.test(parent)) return `${parent}/models`;
    return `${parent}/v1/models`;
  }
  if (clean.endsWith("/v1") || isVersionedApiRoot) return `${clean}/models`;
  return `${clean}/v1/models`;
}

async function safeFetchJson(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const headers = cloneHeaders(init.headers);
  let response;
  let text = "";
  let json = null;
  let error = null;

  try {
    response = await fetch(url, {
      ...init,
      headers,
      signal: init.signal || AbortSignal.timeout(timeoutMs)
    });
    text = await response.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
  } catch (fetchError) {
    error = fetchError instanceof Error ? fetchError.message : String(fetchError);
  }

  return {
    ok: Boolean(response?.ok),
    status: response?.status ?? 0,
    statusText: response?.statusText || "",
    headers: response ? Object.fromEntries(response.headers.entries()) : {},
    text,
    json,
    error
  };
}

function getErrorMessage(body, fallbackText = "") {
  if (!body) return fallbackText;
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error.message === "string") return body.error.message;
  if (typeof body.message === "string") return body.message;
  return fallbackText;
}

function looksOpenAI(result) {
  const body = result.json;
  if (!body || typeof body !== "object") return false;
  if (Array.isArray(body.choices)) return true;
  if (body.object === "list" && Array.isArray(body.data)) return true;
  if (body.type === "error" && body.error && typeof body.error === "object") {
    return false;
  }
  if (body.error && (typeof body.error === "string" || typeof body.error.message === "string")) {
    return true;
  }
  return false;
}

function looksClaude(result) {
  const body = result.json;
  if (!body || typeof body !== "object") return false;
  if (body.type === "message") return true;
  if (body.type === "error" && body.error) return true;
  return false;
}

function authLooksValid(result) {
  if (result.ok) return true;
  const msg = (getErrorMessage(result.json, result.text) || "").toLowerCase();

  if (!msg) {
    // A 400 with empty body still means the endpoint exists and the key was accepted often enough to parse body.
    return result.status >= 400 && result.status < 500 && result.status !== 401 && result.status !== 403;
  }

  if (msg.includes("api key") && (msg.includes("invalid") || msg.includes("missing"))) return false;
  if (msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("authentication")) return false;

  // Common signal for valid auth but bad model/payload.
  if (msg.includes("model") || msg.includes("messages") || msg.includes("max_tokens") || msg.includes("invalid request")) {
    return true;
  }

  return result.status !== 401 && result.status !== 403;
}

function extractModelIds(result) {
  const body = result.json;
  if (!body || !Array.isArray(body.data)) return [];
  const ids = [];
  for (const item of body.data) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id : (typeof item.name === "string" ? item.name : null);
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

function dedupeStrings(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function normalizeUrlPathForScoring(endpoint) {
  try {
    return new URL(String(endpoint)).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return String(endpoint || "").trim().replace(/^https?:\/\/[^/]+/i, "").replace(/\/+$/, "") || "/";
  }
}

function orderAuthVariants(authVariants, preferredAuth) {
  if (!preferredAuth || !Array.isArray(authVariants) || authVariants.length <= 1) return authVariants;
  const normalized = String(preferredAuth).trim().toLowerCase();
  const preferred = authVariants.find((item) => item.type === normalized);
  if (!preferred) return authVariants;
  return [preferred, ...authVariants.filter((item) => item !== preferred)];
}

function getResultMessage(result) {
  return String(getErrorMessage(result.json, result.text) || "").trim();
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[name];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const target = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key || "").toLowerCase() !== target) continue;
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function parseRetryAfterMs(headers) {
  const retryAfter = readHeader(headers, "retry-after");
  if (!retryAfter) return 0;

  const asNumber = Number(retryAfter);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.round(asNumber * 1000);
  }

  const asDate = Date.parse(retryAfter);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return 0;
}

function truncateMessage(value, max = 220) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function isUnsupportedModelMessage(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  const patterns = [
    /model .*not found/,
    /unknown model/,
    /unsupported model/,
    /invalid model/,
    /no such model/,
    /model .*does not exist/,
    /model .*not available/,
    /unrecognized model/,
    /model .*is not supported/,
    /not enabled for this model/,
    /not available for this api/,
    /not available in this api/,
    /does not support .*api/,
    /must use .*endpoint/,
    /use .*\/v1/,
    /only available via/
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function isTransientModelRuntimeError(result, message) {
  const status = Number(result?.status || 0);
  if ([408, 409, 429, 500, 502, 503, 504].includes(status)) return true;

  const text = String(message || "").toLowerCase();
  if (!text) return false;
  const patterns = [
    /rate limit/,
    /too many requests/,
    /quota/,
    /overloaded/,
    /try again/,
    /temporar/,
    /service unavailable/,
    /gateway timeout/,
    /upstream/,
    /timeout/
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function isRateLimitResult(result, message) {
  const status = Number(result?.status || 0);
  if (status === 429) return true;

  const text = String(message || "").toLowerCase();
  if (!text) return false;
  const patterns = [
    /rate limit/,
    /too many requests/,
    /requests per minute/,
    /rpm/,
    /quota.*exceeded/,
    /retry-after/,
    /retry after/
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function classifyModelProbeResult(format, result) {
  const message = getResultMessage(result);

  if (result.error) {
    return {
      supported: false,
      confirmed: false,
      outcome: "network-error",
      message: result.error
    };
  }

  if (result.ok) {
    return {
      supported: true,
      confirmed: true,
      outcome: "ok",
      message: "ok"
    };
  }

  if (isRateLimitResult(result, message)) {
    return {
      supported: false,
      confirmed: false,
      outcome: "rate-limit",
      message: message || "Rate limit reached for this endpoint.",
      retryAfterMs: parseRetryAfterMs(result.headers)
    };
  }

  if (!looksExpectedFormat(format, result)) {
    return {
      supported: false,
      confirmed: false,
      outcome: "format-mismatch",
      message: message || "Endpoint response does not match expected format."
    };
  }

  if (!authLooksValid(result)) {
    return {
      supported: false,
      confirmed: false,
      outcome: "auth-error",
      message: message || "Authentication failed for this format."
    };
  }

  if (isUnsupportedModelMessage(message)) {
    return {
      supported: false,
      confirmed: false,
      outcome: "model-unsupported",
      message: message || "Model is not supported on this endpoint."
    };
  }

  if (isTransientModelRuntimeError(result, message)) {
    return {
      supported: false,
      confirmed: false,
      outcome: "runtime-error",
      message: message || "Request reached endpoint but failed with transient runtime error."
    };
  }

  return {
    supported: false,
    confirmed: false,
    outcome: "unconfirmed",
    message: message || "Could not confirm model support for this endpoint/format."
  };
}

function looksExpectedFormat(format, result) {
  if (format === FORMATS.CLAUDE) return looksClaude(result);
  return looksOpenAI(result);
}

function buildProbeRequest(format, modelId) {
  if (format === FORMATS.CLAUDE) {
    return {
      model: modelId,
      max_tokens: 1,
      stream: false,
      messages: [{ role: "user", content: "ping" }]
    };
  }

  return {
    model: modelId,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false
  };
}

function makeProbeHeaders(format, extraHeaders, authHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...extraHeaders,
    ...authHeaders
  };
  if (format === FORMATS.CLAUDE) {
    if (!headers["anthropic-version"] && !headers["Anthropic-Version"]) {
      headers["anthropic-version"] = "2023-06-01";
    }
  }
  return headers;
}

async function probeModelForFormat({
  baseUrl,
  format,
  apiKey,
  modelId,
  timeoutMs,
  extraHeaders,
  preferredAuthType
}) {
  const url = resolveProviderUrl(makeProviderShell(baseUrl), format);
  const authVariants = orderAuthVariants(makeAuthVariants(format, apiKey), preferredAuthType);
  let requestCount = 0;

  for (const variant of authVariants) {
    requestCount += 1;
    const headers = makeProbeHeaders(format, extraHeaders, variant.headers);
    const result = await safeFetchJson(url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildProbeRequest(format, modelId))
    }, timeoutMs);

    const classified = classifyModelProbeResult(format, result);
    if (classified.supported) {
      return {
        supported: true,
        confirmed: classified.confirmed,
        outcome: classified.outcome,
        authType: variant.type,
        status: result.status,
        message: classified.outcome === "ok"
          ? "ok"
          : truncateMessage(classified.message || getResultMessage(result)),
        error: result.error || null,
        retryAfterMs: Number(classified.retryAfterMs || 0),
        requestCount
      };
    }

    if (classified.outcome === "auth-error") {
      continue;
    }

    if (classified.outcome === "format-mismatch" || classified.outcome === "model-unsupported" || classified.outcome === "network-error") {
      return {
        supported: false,
        confirmed: false,
        outcome: classified.outcome,
        authType: variant.type,
        status: result.status,
        message: truncateMessage(classified.message),
        error: result.error || null,
        retryAfterMs: Number(classified.retryAfterMs || 0),
        requestCount
      };
    }

    if (classified.outcome === "rate-limit" || classified.outcome === "runtime-error" || classified.outcome === "unconfirmed") {
      return {
        supported: false,
        confirmed: false,
        outcome: classified.outcome,
        authType: variant.type,
        status: result.status,
        message: truncateMessage(classified.message),
        error: result.error || null,
        retryAfterMs: Number(classified.retryAfterMs || 0),
        requestCount
      };
    }
  }

  return {
    supported: false,
    confirmed: false,
    outcome: "unknown",
    authType: null,
    status: 0,
    message: "Could not validate model support for this endpoint/format.",
    error: null,
    retryAfterMs: 0,
    requestCount
  };
}

async function probeOpenAI(baseUrl, apiKey, timeoutMs, extraHeaders = {}) {
  const authVariants = makeAuthVariants(FORMATS.OPENAI, apiKey);
  const modelsUrl = resolveModelsUrl(baseUrl, FORMATS.OPENAI);
  const messagesUrl = resolveProviderUrl(makeProviderShell(baseUrl), FORMATS.OPENAI);

  const details = {
    format: FORMATS.OPENAI,
    supported: false,
    working: false,
    models: [],
    auth: null,
    checks: []
  };

  for (const variant of authVariants) {
    const commonHeaders = { "Content-Type": "application/json", ...extraHeaders, ...variant.headers };

    const modelsResult = await safeFetchJson(modelsUrl, {
      method: "GET",
      headers: commonHeaders
    }, timeoutMs);
    details.checks.push({ step: "models", auth: variant.type, status: modelsResult.status, error: modelsResult.error || null });

    const chatResult = await safeFetchJson(messagesUrl, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({
        model: "__llm_router_probe__",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false
      })
    }, timeoutMs);
    details.checks.push({ step: "chat", auth: variant.type, status: chatResult.status, error: chatResult.error || null });

    if (looksOpenAI(chatResult)) {
      details.supported = true;
      if (authLooksValid(chatResult)) {
        details.working = true;
        details.auth = { type: variant.type === "x-api-key" ? "x-api-key" : "bearer" };
        if (looksOpenAI(modelsResult) && authLooksValid(modelsResult)) {
          details.models = extractModelIds(modelsResult);
        }
        return details;
      }
    }
  }

  return details;
}

async function probeClaude(baseUrl, apiKey, timeoutMs, extraHeaders = {}) {
  const authVariants = makeAuthVariants(FORMATS.CLAUDE, apiKey);
  const modelsUrl = resolveModelsUrl(baseUrl, FORMATS.CLAUDE);
  const messagesUrl = resolveProviderUrl(makeProviderShell(baseUrl), FORMATS.CLAUDE);

  const details = {
    format: FORMATS.CLAUDE,
    supported: false,
    working: false,
    models: [],
    auth: null,
    checks: []
  };

  for (const variant of authVariants) {
    const commonHeaders = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...extraHeaders,
      ...variant.headers
    };

    const modelsResult = await safeFetchJson(modelsUrl, {
      method: "GET",
      headers: commonHeaders
    }, timeoutMs);
    details.checks.push({ step: "models", auth: variant.type, status: modelsResult.status, error: modelsResult.error || null });

    const messagesResult = await safeFetchJson(messagesUrl, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({
        model: "__llm_router_probe__",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }]
      })
    }, timeoutMs);
    details.checks.push({ step: "messages", auth: variant.type, status: messagesResult.status, error: messagesResult.error || null });

    if (looksClaude(messagesResult)) {
      details.supported = true;
      if (authLooksValid(messagesResult)) {
        details.working = true;
        details.auth = { type: variant.type === "x-api-key" ? "x-api-key" : "bearer" };
        if (looksClaude(modelsResult) && authLooksValid(modelsResult)) {
          details.models = extractModelIds(modelsResult);
        }
        return details;
      }
    }
  }

  return details;
}

export async function probeProvider(options) {
  const emitProgress = makeProgressEmitter(options?.onProgress);
  const baseUrl = String(options?.baseUrl || "").trim();
  const baseUrlByFormat = normalizeProbeBaseUrlByFormat(options?.baseUrlByFormat);
  const apiKey = String(options?.apiKey || "").trim();
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const extraHeaders = options?.headers && typeof options.headers === "object" && !Array.isArray(options.headers)
    ? options.headers
    : {};
  const openaiProbeBaseUrl = String(baseUrlByFormat?.[FORMATS.OPENAI] || baseUrl || "").trim();
  const claudeProbeBaseUrl = String(baseUrlByFormat?.[FORMATS.CLAUDE] || baseUrl || "").trim();

  if (!openaiProbeBaseUrl && !claudeProbeBaseUrl) {
    throw new Error("Provider baseUrl is required for probing.");
  }
  if (!apiKey) {
    throw new Error("Provider apiKey is required for probing.");
  }

  emitProgress({ phase: "provider-probe-start", baseUrl: baseUrl || openaiProbeBaseUrl || claudeProbeBaseUrl });

  const [openai, claude] = await Promise.all([
    openaiProbeBaseUrl
      ? probeOpenAI(openaiProbeBaseUrl, apiKey, timeoutMs, extraHeaders)
      : Promise.resolve({ format: FORMATS.OPENAI, supported: false, working: false, models: [], auth: null, checks: [] }),
    claudeProbeBaseUrl
      ? probeClaude(claudeProbeBaseUrl, apiKey, timeoutMs, extraHeaders)
      : Promise.resolve({ format: FORMATS.CLAUDE, supported: false, working: false, models: [], auth: null, checks: [] })
  ]);

  const supportedFormats = [claude, openai]
    .filter((entry) => entry.supported)
    .map((entry) => entry.format);

  const workingFormats = [claude, openai]
    .filter((entry) => entry.working)
    .map((entry) => entry.format);

  const preferredFormat =
    (claude.working && FORMATS.CLAUDE) ||
    (openai.working && FORMATS.OPENAI) ||
    (claude.supported && FORMATS.CLAUDE) ||
    (openai.supported && FORMATS.OPENAI) ||
    null;

  const authByFormat = {};
  if (openai.auth) authByFormat[FORMATS.OPENAI] = openai.auth;
  if (claude.auth) authByFormat[FORMATS.CLAUDE] = claude.auth;

  const models = [...new Set([...(claude.models || []), ...(openai.models || [])])];

  emitProgress({
    phase: "provider-probe-done",
    baseUrl: baseUrl || openaiProbeBaseUrl || claudeProbeBaseUrl,
    supportedFormats,
    workingFormats
  });

  return {
    ok: workingFormats.length > 0,
    baseUrl: baseUrl || openaiProbeBaseUrl || claudeProbeBaseUrl,
    baseUrlByFormat,
    formats: supportedFormats,
    workingFormats,
    preferredFormat,
    authByFormat,
    auth: preferredFormat ? authByFormat[preferredFormat] : null,
    models,
    details: {
      openai,
      claude
    }
  };
}

function normalizeEndpointList(rawEndpoints, fallbackBaseUrl = "") {
  const values = [];
  if (Array.isArray(rawEndpoints)) {
    values.push(...rawEndpoints);
  } else if (typeof rawEndpoints === "string") {
    values.push(...rawEndpoints.split(/[,\n;\s]+/g));
  }
  if (fallbackBaseUrl) values.push(fallbackBaseUrl);
  return dedupeStrings(values);
}

function endpointPreferenceScore(endpoint, format) {
  const path = normalizeUrlPathForScoring(endpoint);
  const looksVersioned = /\/v\d+(?:\.\d+)?$/i.test(path);
  const hasOpenAIHint = /\/openai(?:\/|$)/i.test(path);
  const hasAnthropicHint = /\/anthropic(?:\/|$)|\/claude(?:\/|$)/i.test(path);

  if (format === FORMATS.OPENAI) {
    if (hasOpenAIHint) return 100;
    if (looksVersioned) return 90;
    if (path === "/" || path === "") return 10;
    return 50;
  }
  if (format === FORMATS.CLAUDE) {
    if (hasAnthropicHint) return 100;
    if (path === "/" || path === "") return 90;
    if (looksVersioned) return 10;
    return 50;
  }
  return 0;
}

function pickBestEndpointForFormat(endpointRows, format) {
  const candidates = endpointRows
    .filter((row) => (row.workingFormats || []).includes(format))
    .map((row) => ({
      row,
      score: (row.modelsByFormat?.[format] || []).length,
      pref: endpointPreferenceScore(row.endpoint, format)
    }))
    .sort((a, b) => {
      if (b.pref !== a.pref) return b.pref - a.pref;
      if (b.score !== a.score) return b.score - a.score;
      return 0;
    });
  return candidates[0]?.row || null;
}

function guessModelProbePreferredFormat(modelId) {
  const id = String(modelId || "").trim().toLowerCase();
  if (!id) return null;
  if (id.includes("claude")) return FORMATS.CLAUDE;
  if (id.includes("gpt")) return FORMATS.OPENAI;
  return null;
}

function buildModelProbeCandidates(modelId, endpointRows) {
  const preferredFormat = guessModelProbePreferredFormat(modelId);
  const candidates = [];
  for (const row of (endpointRows || [])) {
    for (const format of (row.formatsToTest || [])) {
      const preferredScore = preferredFormat && preferredFormat === format ? 1000 : 0;
      candidates.push({
        row,
        format,
        score: preferredScore + endpointPreferenceScore(row.endpoint, format)
      });
    }
  }
  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.row.rowIndex !== b.row.rowIndex) return a.row.rowIndex - b.row.rowIndex;
    return a.format.localeCompare(b.format);
  });
}

function guessNativeModelFormat(modelId) {
  const id = String(modelId || "").trim().toLowerCase();
  if (!id) return null;

  // High-confidence Anthropic family.
  if (id.startsWith("claude")) return FORMATS.CLAUDE;

  // Default most aggregator/coding endpoints expose native OpenAI-compatible format
  // for many model families (gpt, gemini, glm, qwen, deepseek, etc).
  return FORMATS.OPENAI;
}

function pickPreferredFormatForModel(modelId, formats, { providerPreferredFormat } = {}) {
  const supported = dedupeStrings(formats).filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
  if (supported.length === 0) return null;
  if (supported.length === 1) return supported[0];

  const guessed = guessNativeModelFormat(modelId);
  if (guessed && supported.includes(guessed)) return guessed;
  if (providerPreferredFormat && supported.includes(providerPreferredFormat)) return providerPreferredFormat;
  if (supported.includes(FORMATS.OPENAI)) return FORMATS.OPENAI;
  return supported[0];
}

export async function probeProviderEndpointMatrix(options) {
  const emitProgress = makeProgressEmitter(options?.onProgress);
  const apiKey = String(options?.apiKey || "").trim();
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const requestsPerMinute = normalizePositiveInteger(
    options?.requestsPerMinute ?? options?.probeRequestsPerMinute,
    DEFAULT_PROBE_REQUESTS_PER_MINUTE
  );
  const maxRateLimitRetries = normalizePositiveInteger(
    options?.maxRateLimitRetries,
    DEFAULT_RATE_LIMIT_MAX_RETRIES,
    { min: 0, max: 10 }
  );
  const now = typeof options?.now === "function" ? options.now : () => Date.now();
  const delay = typeof options?.sleep === "function" ? options.sleep : sleep;
  const minProbeIntervalMs = Math.max(1, Math.ceil(60000 / Math.max(1, requestsPerMinute)));
  const extraHeaders = options?.headers && typeof options.headers === "object" && !Array.isArray(options.headers)
    ? options.headers
    : {};
  const endpoints = normalizeEndpointList(options?.endpoints, options?.baseUrl);
  const models = dedupeStrings(options?.models || []);

  if (!apiKey) throw new Error("Provider apiKey is required for probing.");
  if (endpoints.length === 0) throw new Error("At least one endpoint is required for probing.");
  if (models.length === 0) throw new Error("At least one model is required for endpoint-model probing.");

  emitProgress({
    phase: "matrix-start",
    endpointCount: endpoints.length,
    modelCount: models.length
  });

  const endpointRows = [];
  const modelFormatsMap = {};
  const modelOwnerById = new Map();
  const unresolvedModelSet = new Set(models);
  const rateLimitFailures = [];
  const warnings = [];
  let nextAllowedModelProbeAt = 0;

  for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex += 1) {
    const endpoint = endpoints[endpointIndex];
    emitProgress({
      phase: "endpoint-start",
      endpoint,
      endpointIndex: endpointIndex + 1,
      endpointCount: endpoints.length
    });

    const endpointProbe = await probeProvider({
      baseUrl: endpoint,
      apiKey,
      timeoutMs,
      headers: extraHeaders,
      onProgress: (event) => emitProgress({
        ...event,
        endpoint,
        endpointIndex: endpointIndex + 1,
        endpointCount: endpoints.length
      })
    });
    const rowAuthByFormat = { ...(endpointProbe.authByFormat || {}) };
    const initialWorkingFormats = endpointProbe.workingFormats || [];
    const initialSupportedFormats = endpointProbe.formats || [];
    const formatsToTest = dedupeStrings([
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
      ...initialWorkingFormats,
      ...initialSupportedFormats
    ]).filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
    const modelsByFormat = {};
    const modelChecks = [];

    if (formatsToTest.length === 0) {
      warnings.push(`No supported format detected for endpoint ${endpoint}.`);
    }
    emitProgress({
      phase: "endpoint-formats",
      endpoint,
      endpointIndex: endpointIndex + 1,
      endpointCount: endpoints.length,
      formatsToTest
    });

    for (const format of formatsToTest) {
      modelsByFormat[format] = [];
    }

    endpointRows.push({
      endpoint,
      rowIndex: endpointIndex,
      supportedFormats: dedupeStrings(initialSupportedFormats),
      workingFormats: dedupeStrings(initialWorkingFormats),
      preferredFormat: endpointProbe.preferredFormat,
      authByFormat: rowAuthByFormat,
      modelsByFormat,
      modelChecks,
      details: endpointProbe.details,
      formatsToTest
    });
  }

  const totalChecks = models.length * endpointRows.reduce((sum, row) => sum + (row.formatsToTest?.length || 0), 0);
  let completedChecks = 0;

  for (const modelId of models) {
    const candidates = buildModelProbeCandidates(modelId, endpointRows);
    for (const candidate of candidates) {
      const row = candidate.row;
      const endpoint = row.endpoint;
      const format = candidate.format;
      const preferredAuthType = row.authByFormat?.[format]?.type;

      let check = null;
      let retriesUsed = 0;
      while (true) {
        const beforeCallMs = now();
        const pacingWaitMs = Math.max(0, nextAllowedModelProbeAt - beforeCallMs);
        if (pacingWaitMs > 0) {
          emitProgress({
            phase: "rate-limit-wait",
            reason: "pacing",
            endpoint,
            format,
            model: modelId,
            waitMs: pacingWaitMs,
            retryAttempt: retriesUsed,
            maxRetries: maxRateLimitRetries
          });
          await delay(pacingWaitMs);
        }

        check = await probeModelForFormat({
          baseUrl: endpoint,
          format,
          apiKey,
          modelId,
          timeoutMs,
          extraHeaders,
          preferredAuthType
        });

        const requestCount = Math.max(1, Number(check.requestCount || 1));
        const anchor = Math.max(nextAllowedModelProbeAt, beforeCallMs);
        nextAllowedModelProbeAt = anchor + (minProbeIntervalMs * requestCount);

        if (check.outcome !== "rate-limit") break;

        if (retriesUsed >= maxRateLimitRetries) {
          check = {
            ...check,
            supported: false,
            confirmed: false,
            outcome: "rate-limit-max-retries",
            message: `Rate limit persisted after ${maxRateLimitRetries} retries.`,
            maxRateLimitRetriesExceeded: true
          };
          rateLimitFailures.push({
            endpoint,
            format,
            model: modelId,
            retries: retriesUsed,
            status: check.status,
            message: check.message
          });
          break;
        }

        retriesUsed += 1;
        const retryWaitMs = Math.max(
          minProbeIntervalMs,
          Number(check.retryAfterMs || 0),
          MIN_RATE_LIMIT_WAIT_MS
        );
        emitProgress({
          phase: "rate-limit-wait",
          reason: "rate-limit",
          endpoint,
          format,
          model: modelId,
          waitMs: retryWaitMs,
          retryAttempt: retriesUsed,
          maxRetries: maxRateLimitRetries,
          status: check.status,
          message: check.message
        });
        await delay(retryWaitMs);
      }

      if (!check) {
        check = {
          supported: false,
          confirmed: false,
          outcome: "unknown",
          status: 0,
          authType: null,
          message: "Could not validate model support for this endpoint/format.",
          error: null
        };
      }

      row.modelChecks.push({
        endpoint,
        format,
        model: modelId,
        supported: check.supported,
        confirmed: check.confirmed,
        outcome: check.outcome,
        status: check.status,
        authType: check.authType,
        message: check.message,
        error: check.error
      });
      completedChecks += 1;
      emitProgress({
        phase: "model-check",
        endpoint,
        format,
        model: modelId,
        supported: check.supported,
        confirmed: check.confirmed,
        outcome: check.outcome,
        status: check.status,
        message: check.message,
        error: check.error,
        completedChecks,
        totalChecks
      });

      if (!check.supported || !check.confirmed) continue;
      row.modelsByFormat[format].push(modelId);
      if (!row.authByFormat[format] && check.authType) {
        row.authByFormat[format] = { type: check.authType === "x-api-key" ? "x-api-key" : "bearer" };
      }
      if (!modelFormatsMap[modelId]) modelFormatsMap[modelId] = new Set();
      modelFormatsMap[modelId].add(format);
      modelOwnerById.set(modelId, { endpoint, format, source: check.outcome || "probe-response" });
      unresolvedModelSet.delete(modelId);
      break;
    }
  }

  for (const row of endpointRows) {
    const inferredWorkingFormats = dedupeStrings([
      ...(row.workingFormats || []),
      ...(row.formatsToTest || []).filter((format) => (row.modelsByFormat?.[format] || []).length > 0)
    ]);
    const inferredSupportedFormats = dedupeStrings([
      ...(row.supportedFormats || []),
      ...inferredWorkingFormats
    ]);
    row.workingFormats = inferredWorkingFormats;
    row.supportedFormats = inferredSupportedFormats;

    emitProgress({
      phase: "endpoint-done",
      endpoint: row.endpoint,
      endpointIndex: Number(row.rowIndex || 0) + 1,
      endpointCount: endpoints.length,
      workingFormats: inferredWorkingFormats,
      modelsByFormat: row.modelsByFormat
    });
  }

  const resultRows = endpointRows.map(({ formatsToTest, rowIndex, ...row }) => row);

  const openaiEndpoint = pickBestEndpointForFormat(resultRows, FORMATS.OPENAI);
  const claudeEndpoint = pickBestEndpointForFormat(resultRows, FORMATS.CLAUDE);

  const baseUrlByFormat = {};
  if (openaiEndpoint) baseUrlByFormat[FORMATS.OPENAI] = openaiEndpoint.endpoint;
  if (claudeEndpoint) baseUrlByFormat[FORMATS.CLAUDE] = claudeEndpoint.endpoint;

  const authByFormat = {};
  if (openaiEndpoint?.authByFormat?.[FORMATS.OPENAI]) {
    authByFormat[FORMATS.OPENAI] = openaiEndpoint.authByFormat[FORMATS.OPENAI];
  }
  if (claudeEndpoint?.authByFormat?.[FORMATS.CLAUDE]) {
    authByFormat[FORMATS.CLAUDE] = claudeEndpoint.authByFormat[FORMATS.CLAUDE];
  }

  const workingFormats = Object.keys(baseUrlByFormat);
  const formats = dedupeStrings(resultRows.flatMap((row) => row.supportedFormats || []));
  const selectedEndpointByFormat = {};
  if (openaiEndpoint) selectedEndpointByFormat[FORMATS.OPENAI] = openaiEndpoint.endpoint;
  if (claudeEndpoint) selectedEndpointByFormat[FORMATS.CLAUDE] = claudeEndpoint.endpoint;
  const confirmedModelSupportEntries = [];
  for (const [modelId, owner] of modelOwnerById.entries()) {
    const selectedEndpoint = selectedEndpointByFormat[owner.format];
    if (!selectedEndpoint || owner.endpoint !== selectedEndpoint) continue;
    confirmedModelSupportEntries.push([modelId, [owner.format]]);
  }
  const modelSupport = Object.fromEntries(confirmedModelSupportEntries);
  const preferredFormat =
    (workingFormats.includes(FORMATS.CLAUDE) && FORMATS.CLAUDE) ||
    (workingFormats.includes(FORMATS.OPENAI) && FORMATS.OPENAI) ||
    null;
  const modelPreferredFormat = Object.fromEntries(
    Object.entries(modelSupport)
      .map(([modelId, supportedFormats]) => [
        modelId,
        pickPreferredFormatForModel(modelId, supportedFormats, { providerPreferredFormat: preferredFormat })
      ])
      .filter(([, preferred]) => Boolean(preferred))
  );
  const supportedModels = dedupeStrings(Object.keys(modelSupport));
  const unresolvedModels = dedupeStrings([
    ...unresolvedModelSet,
    ...models.filter((modelId) => !supportedModels.includes(modelId))
  ]);
  const manualFallbackRecommended =
    rateLimitFailures.length > 0 ||
    workingFormats.length === 0 ||
    supportedModels.length === 0 ||
    unresolvedModels.length > 0;
  const failureScope = manualFallbackRecommended
    ? (workingFormats.length > 0 ? "partial" : "full")
    : "none";

  if (workingFormats.length === 0) {
    warnings.push("No working endpoint format detected with provided API key.");
  }
  if (supportedModels.length === 0) {
    warnings.push("No provided model was confirmed as working on the detected endpoints.");
  }
  if (rateLimitFailures.length > 0) {
    warnings.push(`Rate limit retries were exhausted for ${rateLimitFailures.length} endpoint-model check(s).`);
  }
  if (unresolvedModels.length > 0) {
    warnings.push(`${unresolvedModels.length} model(s) were not fully auto-discovered and require manual confirmation.`);
  }

  emitProgress({
    phase: "matrix-done",
    workingFormats,
    baseUrlByFormat,
    supportedModelCount: supportedModels.length
  });

  return {
    ok: workingFormats.length > 0 && supportedModels.length > 0,
    endpoints,
    formats,
    workingFormats,
    preferredFormat,
    baseUrlByFormat,
    authByFormat,
    auth: preferredFormat ? authByFormat[preferredFormat] || null : null,
    models: supportedModels,
    modelSupport,
    modelPreferredFormat,
    endpointMatrix: resultRows,
    warnings,
    unresolvedModels,
    rateLimitFailures,
    requestsPerMinute,
    maxRateLimitRetries,
    manualFallbackRecommended,
    failureScope
  };
}
