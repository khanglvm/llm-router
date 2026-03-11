function parseAuthToken(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7).trim();
  if (authHeader && !authHeader.startsWith("Bearer ")) return authHeader.trim();

  for (const headerName of ["x-api-key", "x-goog-api-key"]) {
    const headerValue = request.headers.get(headerName);
    if (headerValue) return headerValue.trim();
  }

  try {
    const url = new URL(request.url);
    for (const key of ["key", "api_key", "auth_token"]) {
      const value = url.searchParams.get(key);
      if (value) return value.trim();
    }
  } catch {
    // Ignore malformed request URLs and continue with empty token.
  }

  return "";
}

function timingSafeStringEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < max; index += 1) {
    const aCode = index < a.length ? a.charCodeAt(index) : 0;
    const bCode = index < b.length ? b.charCodeAt(index) : 0;
    diff |= aCode ^ bCode;
  }
  return diff === 0;
}

export function validateAuth(request, config, options = {}) {
  if (options.ignoreAuth === true) return true;
  const requiredToken = config.masterKey;
  if (!requiredToken) return true;
  const providedToken = parseAuthToken(request);
  return timingSafeStringEqual(providedToken, requiredToken);
}

export function shouldEnforceWorkerAuth(options = {}) {
  return options.ignoreAuth !== true;
}
