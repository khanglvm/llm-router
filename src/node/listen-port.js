const DEFAULT_LISTEN_PORT = 8787;
const MIN_LISTEN_PORT = 1;
const MAX_LISTEN_PORT = 65535;

function parsePortValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return null;

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < MIN_LISTEN_PORT || parsed > MAX_LISTEN_PORT) return null;
  return parsed;
}

/**
 * Resolve the local listen port using this precedence:
 * 1) explicit CLI/API input
 * 2) LLM_ROUTER_PORT env
 * 3) PORT env (for generic hosting environments)
 * 4) fallback (default 8787)
 */
export function resolveListenPort({
  explicitPort,
  env = process.env,
  fallbackPort = DEFAULT_LISTEN_PORT
} = {}) {
  const candidates = [
    explicitPort,
    env?.LLM_ROUTER_PORT,
    env?.PORT,
    fallbackPort,
    DEFAULT_LISTEN_PORT
  ];

  for (const candidate of candidates) {
    const parsed = parsePortValue(candidate);
    if (parsed !== null) return parsed;
  }

  return DEFAULT_LISTEN_PORT;
}

