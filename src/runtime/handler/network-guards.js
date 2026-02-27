import { appendVaryHeader } from "./http.js";
import { toBoolean } from "./utils.js";

const csvSetCache = new Map();
const csvLowerSetCache = new Map();

function putBoundedCache(cache, key, value, maxEntries = 64) {
  if (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
  return value;
}

function parseCsvSetCached(rawValue) {
  const key = String(rawValue ?? "");
  const cached = csvSetCache.get(key);
  if (cached) return cached;
  const parsed = [...new Set(
    key
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )];
  return putBoundedCache(csvSetCache, key, parsed);
}

function parseCsvLowerSetCached(rawValue) {
  const key = String(rawValue ?? "");
  const cached = csvLowerSetCache.get(key);
  if (cached) return cached;
  const parsed = [...new Set(
    key
      .split(",")
      .map((item) => normalizeIpCandidate(item))
      .filter(Boolean)
  )];
  return putBoundedCache(csvLowerSetCache, key, parsed);
}

function parseAllowedOrigins(env = {}) {
  const raw =
    env?.LLM_ROUTER_CORS_ALLOWED_ORIGINS ??
    env?.LLM_ROUTER_ALLOWED_ORIGINS ??
    "";
  return parseCsvSetCached(raw);
}

function parseAllowedIps(env = {}) {
  const raw =
    env?.LLM_ROUTER_ALLOWED_IPS ??
    env?.LLM_ROUTER_IP_ALLOWLIST ??
    "";
  return parseCsvLowerSetCached(raw);
}

export function normalizeIpCandidate(value) {
  let ip = String(value || "").trim().toLowerCase();
  if (!ip) return "";

  if (ip.startsWith("[") && ip.includes("]")) {
    const end = ip.indexOf("]");
    ip = ip.slice(1, end);
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    // IPv4 with port suffix in forwarded headers.
    ip = ip.replace(/:\d+$/, "");
  }

  if (ip.startsWith("::ffff:") && ip.includes(".")) {
    ip = ip.slice("::ffff:".length);
  }

  const zoneIndex = ip.indexOf("%");
  if (zoneIndex > -1) {
    ip = ip.slice(0, zoneIndex);
  }

  return ip;
}

function getClientIp(request) {
  const cfIp = normalizeIpCandidate(request.headers.get("cf-connecting-ip"));
  if (cfIp) return cfIp;

  const xRealIp = normalizeIpCandidate(request.headers.get("x-real-ip"));
  if (xRealIp) return xRealIp;

  const xff = String(request.headers.get("x-forwarded-for") || "").trim();
  if (!xff) return "";
  const first = xff.split(",")[0];
  return normalizeIpCandidate(first);
}

export function isRequestFromAllowedIp(request, env = {}) {
  const allowedIps = parseAllowedIps(env);
  if (allowedIps.length === 0 || allowedIps.includes("*")) return true;
  const clientIp = getClientIp(request);
  if (!clientIp) return false;
  return allowedIps.includes(clientIp);
}

export function resolveAllowedOrigin(request, env = {}) {
  const origin = request.headers.get("origin");
  if (!origin) return "";
  const allowAll = toBoolean(env?.LLM_ROUTER_CORS_ALLOW_ALL, false);
  if (allowAll) return "*";
  const allowedOrigins = parseAllowedOrigins(env);
  if (allowedOrigins.includes("*")) return "*";
  return allowedOrigins.includes(origin) ? origin : "";
}

export function withRequestCors(response, request, env = {}, { isPreflight = false, allowedOrigin } = {}) {
  const resolvedOrigin = allowedOrigin === undefined
    ? resolveAllowedOrigin(request, env)
    : allowedOrigin;
  const allowed = resolvedOrigin || "";
  if (!allowed) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowed);
  if (allowed !== "*") {
    headers.set("Vary", appendVaryHeader(headers.get("Vary"), "Origin"));
  }

  if (isPreflight) {
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version");
    headers.set("Access-Control-Max-Age", "600");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
