const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
];

export function withCorsHeaders(headers = {}) {
  return { ...headers };
}

function sanitizePassthroughHeaders(headers) {
  // Node fetch/undici transparently decodes compressed upstream responses
  // but keeps content-encoding/content-length headers, which breaks clients
  // that attempt to decompress the forwarded payload again.
  headers.delete("content-encoding");
  headers.delete("content-length");
  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withCorsHeaders({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    })
  });
}

export function corsResponse() {
  return new Response(null, {
    headers: withCorsHeaders({
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version"
    })
  });
}

export function passthroughResponseWithCors(response, overrideHeaders = undefined) {
  const headers = new Headers(response.headers);
  sanitizePassthroughHeaders(headers);

  if (overrideHeaders && typeof overrideHeaders === "object") {
    for (const [name, value] of Object.entries(overrideHeaders)) {
      if (value === undefined || value === null) continue;
      headers.set(name, String(value));
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function appendVaryHeader(existingValue, entry) {
  const value = String(existingValue || "").trim();
  if (!value) return entry;
  const rows = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (rows.some((item) => item.toLowerCase() === entry.toLowerCase())) return value;
  return `${value}, ${entry}`;
}
