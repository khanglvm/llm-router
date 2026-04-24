/**
 * Pure helper functions for resolving values from arbitrary JSON responses
 * and coercing them to expected types. No IO, no side effects.
 */

/**
 * Resolves a dot-path from a JSON object.
 * Supports `$.foo.bar` syntax (leading `$` or `$.` is stripped).
 * Supports array indices: `$.data[0].amount`.
 * Returns undefined for missing paths or null/undefined intermediates.
 * @param {any} obj
 * @param {string} pathStr
 * @returns {any}
 */
export function resolvePath(obj, pathStr) {
  if (obj == null || typeof pathStr !== "string") return undefined;

  // Strip leading $ or $.
  let cleaned = pathStr;
  if (cleaned.startsWith("$.")) cleaned = cleaned.slice(2);
  else if (cleaned.startsWith("$")) cleaned = cleaned.slice(1);

  if (!cleaned) return obj;

  // Tokenize: split on dots, then expand array indices.
  // "data[0].amount" → ["data", "0", "amount"]
  const segments = [];
  for (const part of cleaned.split(".")) {
    if (!part) continue;
    // Handle array indices like "data[0]" or just "[0]"
    const bracketRe = /([^\[]*)\[(\d+)\]/g;
    let match;
    let lastIndex = 0;
    let hasMatch = false;
    while ((match = bracketRe.exec(part)) !== null) {
      hasMatch = true;
      if (match[1]) segments.push(match[1]);
      segments.push(match[2]);
      lastIndex = bracketRe.lastIndex;
    }
    if (!hasMatch) {
      segments.push(part);
    } else if (lastIndex < part.length) {
      segments.push(part.slice(lastIndex));
    }
  }

  let current = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      current = current[idx];
    } else if (typeof current === "object") {
      current = current[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

const FALSE_SET = new Set([0, "0", "false", "no", null, undefined, false, ""]);

const DURATION_RE = /^PT?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i;
const SHORT_DURATION_RE = /^(\d+(?:\.\d+)?)\s*(h|m|s)$/i;

/**
 * @param {string} str
 * @returns {number|undefined} duration in milliseconds
 */
function parseDuration(str) {
  // Try short form: "2h", "30m", "45s"
  let m = SHORT_DURATION_RE.exec(str);
  if (m) {
    const val = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === "h") return val * 3600_000;
    if (unit === "m") return val * 60_000;
    if (unit === "s") return val * 1000;
  }
  // Try ISO 8601 duration: "PT2H", "PT30M", "PT2H30M"
  m = DURATION_RE.exec(str);
  if (m && (m[1] || m[2] || m[3])) {
    const hours = parseFloat(m[1] || "0");
    const minutes = parseFloat(m[2] || "0");
    const seconds = parseFloat(m[3] || "0");
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }
  return undefined;
}

/**
 * Type coercion for mapped values.
 * @param {any} value
 * @param {string} as - "number" | "dollars-from-cents" | "boolean" | "datetime" | "raw"
 * @param {{ now?: number }} [opts]
 * @returns {any}
 */
export function coerceValue(value, as, { now } = {}) {
  switch (as) {
    case "number": {
      if (value == null) return undefined;
      const n = Number(value);
      return Number.isNaN(n) ? undefined : n;
    }
    case "dollars-from-cents": {
      if (value == null) return undefined;
      const n = Number(value);
      return Number.isNaN(n) ? undefined : n / 100;
    }
    case "boolean": {
      return !FALSE_SET.has(value);
    }
    case "datetime": {
      if (value == null) return undefined;
      if (typeof value === "string") {
        // Try duration first
        const dur = parseDuration(value.trim());
        if (dur !== undefined) {
          return (now ?? Date.now()) + dur;
        }
        // Try ISO-8601
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d.getTime();
        return undefined;
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) return undefined;
        // Epoch seconds vs ms heuristic
        return value < 1e12 ? value * 1000 : value;
      }
      return undefined;
    }
    case "raw":
    default:
      return value;
  }
}

const SHORTCODE_RE = /\{\{([^}]+)\}\}/g;

const KNOWN_CTX_KEYS = new Set([
  "providerApiKey",
  "providerBaseUrl",
  "providerId"
]);

/**
 * Replace `{{shortcode}}` placeholders in a template string.
 * @param {any} template
 * @param {Record<string, string>} ctx
 * @param {Record<string, string>} [env]
 * @returns {any}
 */
export function interpolateShortcodes(template, ctx, env = {}) {
  if (typeof template !== "string") return template;
  return template.replace(SHORTCODE_RE, (_, key) => {
    const trimmed = key.trim();
    if (KNOWN_CTX_KEYS.has(trimmed)) return ctx[trimmed] ?? "";
    const envMatch = trimmed.match(/^env\.(.+)$/);
    if (envMatch) return env[envMatch[1]] ?? "";
    return "";
  });
}

const MAPPED_FIELDS = ["used", "limit", "remaining", "resetAt", "isUnlimited"];

/**
 * Extract normalized fields from a raw API response using a mapping config.
 * @param {any} rawResponse
 * @param {Record<string, any>} mapping
 * @returns {Record<string, any>}
 */
export function extractMappedSnapshot(rawResponse, mapping) {
  const result = {};
  const now = Date.now();

  for (const field of MAPPED_FIELDS) {
    let value;

    // Try primary path
    const fieldMapping = mapping[field];
    if (fieldMapping && fieldMapping.path) {
      const raw = resolvePath(rawResponse, fieldMapping.path);
      if (raw != null) {
        value = coerceValue(raw, fieldMapping.as || "raw", { now });
      }
    }

    // For "limit" field: try limitFallbacks chain if still null/undefined
    if (value == null && field === "limit" && Array.isArray(mapping.limitFallbacks)) {
      for (const fallbackPath of mapping.limitFallbacks) {
        const raw = resolvePath(rawResponse, fallbackPath);
        if (raw != null) {
          const as = fieldMapping?.as || "number";
          value = coerceValue(raw, as, { now });
          if (value != null) break;
        }
      }
    }

    // Try constants as final fallback
    if (value == null && mapping.constants && mapping.constants[field] != null) {
      value = mapping.constants[field];
    }

    if (value !== undefined) {
      result[field] = value;
    }
  }

  return result;
}
