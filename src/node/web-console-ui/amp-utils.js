import { DEFAULT_AMP_ENTITY_DEFINITIONS, DEFAULT_AMP_SIGNATURE_DEFINITIONS } from "../../runtime/config.js";
import { LOCAL_ROUTER_ORIGIN } from "../../shared/local-router-defaults.js";
import { safeClone } from "./utils.js";
import { pickFallbackDefaultModel } from "./quick-start-utils.js";

export function formatAmpEntityLabel(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

export function getAmpDefaultMatchForRouteKey(routeKey) {
  const key = String(routeKey || "").trim();
  if (!key) return "";

  const signatureMatch = DEFAULT_AMP_SIGNATURE_DEFINITIONS.find((entry) => entry?.id === key);
  if (signatureMatch?.defaultMatch) return String(signatureMatch.defaultMatch).trim();

  const entityMatch = DEFAULT_AMP_ENTITY_DEFINITIONS.find((entry) => entry?.id === key);
  if (!entityMatch) return "";

  const defaultMatches = [...new Set((entityMatch.signatures || [])
    .map((signatureId) => DEFAULT_AMP_SIGNATURE_DEFINITIONS.find((entry) => entry?.id === signatureId)?.defaultMatch)
    .map((value) => String(value || "").trim())
    .filter(Boolean))];

  return defaultMatches.length === 1 ? defaultMatches[0] : defaultMatches.join(" | ");
}

export function buildAmpClientUrl() {
  return LOCAL_ROUTER_ORIGIN;
}

export function maskShortSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= 10) return `${text.slice(0, 2)}…${text.slice(-2)}`;
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export function ensureAmpDraftConfigShape(config = {}) {
  const next = safeClone(config && typeof config === "object" && !Array.isArray(config) ? config : {});
  if (!next.amp || typeof next.amp !== "object" || Array.isArray(next.amp)) next.amp = {};
  if (!next.amp.routes || typeof next.amp.routes !== "object" || Array.isArray(next.amp.routes)) next.amp.routes = {};
  if (!Array.isArray(next.amp.rawModelRoutes)) next.amp.rawModelRoutes = [];
  if (!next.amp.overrides || typeof next.amp.overrides !== "object" || Array.isArray(next.amp.overrides)) next.amp.overrides = {};
  if (!Array.isArray(next.amp.overrides.entities)) next.amp.overrides.entities = [];
  if (next.amp.restrictManagementToLocalhost === undefined) next.amp.restrictManagementToLocalhost = true;
  if (!String(next.amp.preset || "").trim()) next.amp.preset = "builtin";
  if (!String(next.amp.defaultRoute || "").trim()) {
    next.amp.defaultRoute = String(next.defaultModel || pickFallbackDefaultModel(next) || "").trim();
  }
  return next;
}

export function parseAmpWebSearchInteger(value, fallback = 0, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function buildAmpKnownRouteKeySet() {
  return new Set([
    ...DEFAULT_AMP_ENTITY_DEFINITIONS.map((entry) => entry.id),
    ...DEFAULT_AMP_SIGNATURE_DEFINITIONS.map((entry) => entry.id)
  ].map((value) => String(value || "").trim()).filter(Boolean));
}

export const KNOWN_AMP_ROUTE_KEYS = buildAmpKnownRouteKeySet();

export function isKnownAmpRouteKey(value) {
  return KNOWN_AMP_ROUTE_KEYS.has(String(value || "").trim());
}

export function ensureAmpRouteCollections(amp) {
  if (!amp.routes || typeof amp.routes !== "object" || Array.isArray(amp.routes)) {
    amp.routes = {};
  }
  if (!Array.isArray(amp.rawModelRoutes)) {
    amp.rawModelRoutes = [];
  }
}

export function getAmpAnchoredRouteKey(mapping = {}) {
  return String(mapping?.sourceRouteKey || "").trim();
}

export function buildAmpEntityRows(config = {}) {
  const nextConfig = ensureAmpDraftConfigShape(config);
  const amp = nextConfig.amp;
  ensureAmpRouteCollections(amp);

  const anchoredRawRoutes = new Map();
  const rawRouteEntries = [];
  for (const [index, mapping] of (amp.rawModelRoutes || []).entries()) {
    const sourceRouteKey = getAmpAnchoredRouteKey(mapping);
    if (sourceRouteKey && isKnownAmpRouteKey(sourceRouteKey)) {
      anchoredRawRoutes.set(sourceRouteKey, { mapping, index });
      continue;
    }

    rawRouteEntries.push({
      id: `raw:${index}`,
      source: "raw",
      index,
      routeKey: "",
      inbound: String(mapping?.from || "").trim(),
      outbound: String(mapping?.to || "").trim(),
      label: "Custom mapping",
      description: `Wildcard/raw match: ${String(mapping?.from || "").trim() || "(empty)"}`,
      defaultMatch: "",
      isCustom: true,
      removable: true
    });
  }

  const builtInRouteEntries = DEFAULT_AMP_ENTITY_DEFINITIONS.map((entry) => {
    const routeKey = String(entry.id || "").trim();
    const defaultMatch = getAmpDefaultMatchForRouteKey(routeKey);
    const anchoredRawRoute = anchoredRawRoutes.get(routeKey)?.mapping || null;
    return {
      id: `route:${routeKey}`,
      source: "route",
      routeKey,
      inbound: String(anchoredRawRoute?.from || defaultMatch || routeKey).trim(),
      outbound: String(anchoredRawRoute?.to || amp.routes?.[routeKey] || "").trim(),
      label: formatAmpEntityLabel(routeKey),
      description: entry.description || "",
      defaultMatch,
      isCustom: false,
      removable: false
    };
  });

  const configuredRouteEntries = Object.entries(amp.routes || {})
    .filter(([key]) => !DEFAULT_AMP_ENTITY_DEFINITIONS.some((entry) => entry.id === key))
    .map(([key, target]) => {
      const routeKey = String(key || "").trim();
      const defaultMatch = getAmpDefaultMatchForRouteKey(routeKey);
      const isKnownKey = isKnownAmpRouteKey(routeKey);
      return {
        id: `route:${routeKey}`,
        source: "route",
        routeKey,
        inbound: routeKey,
        outbound: String(target || "").trim(),
        label: isKnownKey ? (defaultMatch || routeKey) : formatAmpEntityLabel(routeKey),
        description: isKnownKey ? `Route key: ${routeKey}` : `Custom route key: ${routeKey}`,
        defaultMatch,
        isCustom: true,
        removable: true
      };
    });

  return [...builtInRouteEntries, ...configuredRouteEntries, ...rawRouteEntries];
}

export function findAmpEditableRouteEntry(config, entryId) {
  return buildAmpEntityRows(config).find((entry) => entry.id === entryId) || null;
}

export function updateAmpEditableRouteConfig(config = {}, entryId, {
  inbound,
  outbound
} = {}) {
  const next = ensureAmpDraftConfigShape(config);
  const amp = next.amp;
  ensureAmpRouteCollections(amp);

  const currentEntry = findAmpEditableRouteEntry(next, entryId);
  if (!currentEntry) return next;

  const nextInbound = String(inbound ?? currentEntry.inbound ?? "").trim();
  const nextOutbound = String(outbound ?? currentEntry.outbound ?? "").trim();
  const preferredRouteKey = currentEntry.source === "route"
    ? String(currentEntry.routeKey || "").trim()
    : "";
  const preferredDefaultMatch = preferredRouteKey
    ? String(currentEntry.defaultMatch || "").trim()
    : "";
  const anchoredRawRouteIndex = preferredRouteKey
    ? amp.rawModelRoutes.findIndex((mapping) => getAmpAnchoredRouteKey(mapping) === preferredRouteKey)
    : -1;
  const usesAnchoredBuiltInRoute = preferredRouteKey && isKnownAmpRouteKey(preferredRouteKey);
  const nextKnownRouteKey = isKnownAmpRouteKey(nextInbound)
    ? nextInbound
    : (preferredRouteKey && preferredDefaultMatch && nextInbound === preferredDefaultMatch ? preferredRouteKey : "");

  if (currentEntry.source === "route" && currentEntry.routeKey) {
    delete amp.routes[currentEntry.routeKey];
  }
  if (currentEntry.source === "raw" && Number.isInteger(currentEntry.index)) {
    amp.rawModelRoutes.splice(currentEntry.index, 1);
  }
  if (anchoredRawRouteIndex >= 0) {
    amp.rawModelRoutes.splice(anchoredRawRouteIndex, 1);
  }

  if (nextKnownRouteKey) {
    if (nextOutbound) {
      amp.routes[nextKnownRouteKey] = nextOutbound;
    }
    return next;
  }

  if (usesAnchoredBuiltInRoute) {
    const defaultInbound = preferredDefaultMatch || preferredRouteKey;
    if (nextOutbound) {
      amp.routes[preferredRouteKey] = nextOutbound;
    }
    if (nextInbound && nextInbound !== defaultInbound) {
      amp.rawModelRoutes.push({
        from: nextInbound,
        sourceRouteKey: preferredRouteKey
      });
    }
    return next;
  }

  if (nextInbound && nextOutbound) {
    amp.rawModelRoutes.push({ from: nextInbound, to: nextOutbound });
  }

  return next;
}

export function createAmpEditableRoute(config = {}, {
  inbound,
  outbound
} = {}) {
  const next = ensureAmpDraftConfigShape(config);
  const amp = next.amp;
  ensureAmpRouteCollections(amp);

  const nextInbound = String(inbound || "").trim();
  const nextOutbound = String(outbound || "").trim();
  const nextKnownRouteKey = isKnownAmpRouteKey(nextInbound) ? nextInbound : "";

  if (!nextInbound || !nextOutbound) return next;

  if (nextKnownRouteKey) {
    amp.routes[nextKnownRouteKey] = nextOutbound;
    return next;
  }

  amp.rawModelRoutes.push({ from: nextInbound, to: nextOutbound });
  return next;
}

export function removeAmpEditableRoute(config = {}, entryId) {
  const next = ensureAmpDraftConfigShape(config);
  const amp = next.amp;
  ensureAmpRouteCollections(amp);

  const currentEntry = findAmpEditableRouteEntry(next, entryId);
  if (!currentEntry?.removable) return next;

  if (currentEntry.source === "route" && currentEntry.routeKey) {
    delete amp.routes[currentEntry.routeKey];
  }
  if (currentEntry.source === "raw" && Number.isInteger(currentEntry.index)) {
    amp.rawModelRoutes.splice(currentEntry.index, 1);
  }

  return next;
}

// ── Internal dependencies (still in app.jsx, referenced here for extraction completeness) ──
// safeClone, pickFallbackDefaultModel are used by ensureAmpDraftConfigShape above.
// When app.jsx imports from this module, those will resolve from app.jsx scope.
