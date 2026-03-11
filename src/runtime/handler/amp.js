import { jsonResponse, passthroughResponseWithCors } from "./http.js";

const AMP_PROXY_SCRUBBED_HEADERS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "host",
  "content-length",
  "accept-encoding",
  "proxy-authorization",
  "proxy-authenticate",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "cf-connecting-ip",
  "true-client-ip",
  "x-real-ip",
  "x-client-ip",
  "cf-ray",
  "cf-ipcountry",
  "x-client-data",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-user",
  "sec-fetch-dest"
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLoopbackAddress(value) {
  const ip = String(value || "").trim().toLowerCase();
  if (!ip) return false;
  if (["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(ip)) return true;
  return ip.startsWith("127.");
}

function readClientIp(request) {
  const direct = request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip");
  if (direct) return String(direct).trim();
  const forwardedFor = String(request.headers.get("x-forwarded-for") || "").trim();
  if (!forwardedFor) return "";
  const firstHop = forwardedFor.split(",")[0]?.trim();
  return firstHop || "";
}

export function isAmpProxyEnabled(config) {
  return Boolean(String(config?.amp?.upstreamUrl || "").trim());
}

export function isAmpManagementAllowed(request, config) {
  if (config?.amp?.restrictManagementToLocalhost !== true) return true;
  return isLoopbackAddress(readClientIp(request));
}

function readClientAuthToken(request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7).trim();
  if (authHeader) return authHeader.trim();

  for (const headerName of ["x-api-key", "x-goog-api-key"]) {
    const headerValue = request.headers.get(headerName);
    if (headerValue) return String(headerValue).trim();
  }

  try {
    const requestUrl = new URL(request.url);
    for (const key of ["key", "api_key", "auth_token"]) {
      const value = requestUrl.searchParams.get(key);
      if (value) return value.trim();
    }
  } catch {
    // Ignore malformed request URLs and continue with empty token.
  }

  return "";
}

function removeQueryValuesMatching(url, key, match) {
  if (!(url instanceof URL) || !match) return;
  const values = url.searchParams.getAll(key);
  if (values.length === 0) return;

  url.searchParams.delete(key);
  for (const value of values) {
    if (value === match) continue;
    url.searchParams.append(key, value);
  }
}

function stripClientCredentialsFromAmpUpstreamUrl(upstreamUrl, request) {
  const clientToken = readClientAuthToken(request);
  if (!clientToken) return;

  for (const key of ["key", "api_key", "auth_token"]) {
    removeQueryValuesMatching(upstreamUrl, key, clientToken);
  }
}

function buildAmpProxyHeaders(request, config) {
  const headers = new Headers(request.headers);
  const upstreamApiKey = String(config?.amp?.upstreamApiKey || "").trim();

  for (const name of AMP_PROXY_SCRUBBED_HEADERS) {
    headers.delete(name);
  }

  if (upstreamApiKey) {
    headers.set("authorization", `Bearer ${upstreamApiKey}`);
    headers.set("x-api-key", upstreamApiKey);
  }

  return headers;
}

function normalizeAmpUserPayload(payload) {
  if (!isPlainObject(payload)) return null;
  return {
    ...payload,
    freeTierEligibleIfWorkspaceAllows: true,
    dailyGrantEnabledIfWorkspaceAllows: false
  };
}

function normalizeAmpInternalPayload(requestUrl, payload) {
  if (!isPlainObject(payload)) return null;

  if (requestUrl.searchParams.has("getUserFreeTierStatus")) {
    return {
      ...payload,
      result: {
        ...(isPlainObject(payload.result) ? payload.result : {}),
        canUseAmpFree: true,
        isDailyGrantEnabled: false
      }
    };
  }

  if (requestUrl.searchParams.has("getUserInfo")) {
    return {
      ...payload,
      result: normalizeAmpUserPayload(payload.result) || payload.result
    };
  }

  return null;
}

function normalizeAmpManagementPayload(requestUrl, payload) {
  if (requestUrl.pathname === "/api/user") {
    return normalizeAmpUserPayload(payload);
  }

  if (requestUrl.pathname === "/api/internal") {
    return normalizeAmpInternalPayload(requestUrl, payload);
  }

  return null;
}

function shouldNormalizeAmpManagementResponse(requestUrl) {
  if (requestUrl.pathname === "/api/user") return true;
  if (requestUrl.pathname !== "/api/internal") return false;
  return requestUrl.searchParams.has("getUserFreeTierStatus") || requestUrl.searchParams.has("getUserInfo");
}

function isJsonLikeResponse(response) {
  const contentType = String(response?.headers?.get("content-type") || "").toLowerCase();
  return contentType.includes("application/json") || contentType.includes("+json");
}

function isAmpStreamingResponse(response) {
  const contentType = String(response?.headers?.get("content-type") || "").toLowerCase();
  return contentType.includes("text/event-stream");
}

async function gunzipBytes(bytes) {
  if (typeof DecompressionStream !== "function") return null;
  try {
    const gzipStream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const decompressed = await new Response(gzipStream).arrayBuffer();
    return new Uint8Array(decompressed);
  } catch {
    return null;
  }
}

async function maybeDecompressAmpProxyResponse(response) {
  if (!(response instanceof Response) || !response.ok) return response;
  if (response.headers.get("content-encoding")) return response;
  if (isAmpStreamingResponse(response)) return response;

  let bytes;
  try {
    bytes = new Uint8Array(await response.clone().arrayBuffer());
  } catch {
    return response;
  }

  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return response;
  }

  const decompressed = await gunzipBytes(bytes);
  if (!(decompressed instanceof Uint8Array)) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(decompressed.byteLength));

  return new Response(decompressed, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function maybeNormalizeAmpManagementResponse(requestUrl, response) {
  if (!shouldNormalizeAmpManagementResponse(requestUrl) || !response?.ok || !isJsonLikeResponse(response)) {
    return null;
  }

  try {
    const payload = await response.clone().json();
    const normalizedPayload = normalizeAmpManagementPayload(requestUrl, payload);
    if (!normalizedPayload) return null;
    return passthroughResponseWithCors(new Response(JSON.stringify(normalizedPayload), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }));
  } catch {
    return null;
  }
}

export async function proxyAmpUpstreamRequest({ request, config, bodyOverride } = {}) {
  const upstreamBase = String(config?.amp?.upstreamUrl || "").trim();
  if (!upstreamBase) {
    return jsonResponse({
      type: "error",
      error: {
        type: "configuration_error",
        message: "AMP upstream proxy is not configured. Set config.amp.upstreamUrl to enable AMP management and fallback proxying."
      }
    }, 503);
  }

  const requestUrl = new URL(request.url);
  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, upstreamBase);
  stripClientCredentialsFromAmpUpstreamUrl(upstreamUrl, request);
  const headers = buildAmpProxyHeaders(request, config);
  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    if (bodyOverride !== undefined) {
      init.body = bodyOverride;
    } else {
      const rawBody = await request.arrayBuffer();
      if (rawBody.byteLength > 0) init.body = rawBody;
    }
  }

  try {
    const response = await fetch(upstreamUrl, init);
    const preparedResponse = await maybeDecompressAmpProxyResponse(response);
    const normalizedResponse = await maybeNormalizeAmpManagementResponse(requestUrl, preparedResponse);
    if (normalizedResponse) return normalizedResponse;
    return passthroughResponseWithCors(preparedResponse);
  } catch (error) {
    return jsonResponse({
      type: "error",
      error: {
        type: "api_error",
        message: `AMP upstream proxy failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }, 503);
  }
}
