const KNOWN_AMP_MODES = new Set(["smart", "rush", "deep", "free"]);

function readHeader(headers, name) {
  if (!headers || typeof headers.get !== "function") return "";
  return String(headers.get(name) || "").trim();
}

function normalizeLookupKey(value) {
  return String(value || "").trim().toLowerCase();
}

function firstNonEmptyString(values) {
  for (const value of (values || [])) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function extractModeFromBody(body) {
  if (!body || typeof body !== "object") return "";
  const direct = firstNonEmptyString([
    body.mode,
    body.agentMode,
    body?.metadata?.mode,
    body?.metadata?.agentMode,
    body?.params?.mode,
    body?.params?.agentMode
  ]);
  if (!direct) return "";
  const normalized = normalizeLookupKey(direct);
  return KNOWN_AMP_MODES.has(normalized) ? normalized : "";
}

function extractAgentFromBody(body) {
  if (!body || typeof body !== "object") return "";
  return firstNonEmptyString([
    body.agent,
    body.agentType,
    body?.metadata?.agent,
    body?.metadata?.agentType,
    body?.params?.agent,
    body?.params?.agentType
  ]);
}

function extractModeFromHeaders(request) {
  const headers = request?.headers;
  const direct = firstNonEmptyString([
    readHeader(headers, "x-amp-mode"),
    readHeader(headers, "x-amp-agent-mode")
  ]);
  if (!direct) return "";
  const normalized = normalizeLookupKey(direct);
  return KNOWN_AMP_MODES.has(normalized) ? normalized : "";
}

function extractAgentFromHeaders(request) {
  const headers = request?.headers;
  return firstNonEmptyString([
    readHeader(headers, "x-amp-agent"),
    readHeader(headers, "x-amp-agent-type")
  ]);
}

export function detectAmpRequest(request, route) {
  if (
    route?.type === "amp-provider-route" ||
    route?.type === "amp-provider-gemini-route" ||
    route?.type === "amp-internal"
  ) {
    return true;
  }

  const headers = request?.headers;
  const ampClientType = readHeader(headers, "x-amp-client-type");
  const ampClientBundle = readHeader(headers, "x-amp-client-bundle");
  const ampClientApplication = readHeader(headers, "x-amp-client-application");
  const ampInstallId = readHeader(headers, "x-amp-installation-id");

  if (ampClientType || ampClientBundle || ampClientApplication || ampInstallId) {
    return true;
  }

  const userAgent = readHeader(headers, "user-agent").toLowerCase();
  return userAgent.includes("amp");
}

export function buildAmpContext(request, body, route = null) {
  const mode = extractModeFromBody(body) || extractModeFromHeaders(request);
  const agent = firstNonEmptyString([
    extractAgentFromBody(body),
    extractAgentFromHeaders(request)
  ]);
  const application = readHeader(request?.headers, "x-amp-client-application");
  const requestedModel = typeof body?.model === "string" && body.model.trim()
    ? body.model.trim()
    : (typeof route?.ampModelId === "string" && route.ampModelId.trim()
        ? route.ampModelId.trim()
        : "");

  return {
    isAmp: detectAmpRequest(request, route),
    mode: mode || "",
    agent: agent || "",
    application: application || "",
    provider: typeof route?.ampProvider === "string" ? route.ampProvider : "",
    requestedModel
  };
}

function lookupMapRef(map, key, { caseInsensitive = true } = {}) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return "";
  const directKey = String(key || "").trim();
  if (!directKey) return "";
  if (typeof map[directKey] === "string" && map[directKey].trim()) return map[directKey].trim();
  if (!caseInsensitive) return "";
  const normalized = normalizeLookupKey(directKey);
  for (const [candidateKey, value] of Object.entries(map)) {
    if (normalizeLookupKey(candidateKey) !== normalized) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    return value.trim();
  }
  return "";
}

function lookupAgentModeRef(agentModeMap, agent, mode) {
  if (!agentModeMap || typeof agentModeMap !== "object" || Array.isArray(agentModeMap)) return "";
  const agentKey = normalizeLookupKey(agent);
  const modeKey = normalizeLookupKey(mode);
  if (!agentKey || !modeKey) return "";
  const modeMap = agentModeMap[agentKey];
  if (!modeMap || typeof modeMap !== "object" || Array.isArray(modeMap)) return "";
  return lookupMapRef(modeMap, modeKey, { caseInsensitive: false });
}

export function resolveAmpRequestedModel(config, requestedModel, ampContext) {
  const originalRequested = typeof requestedModel === "string" && requestedModel.trim()
    ? requestedModel.trim()
    : "smart";

  if (!ampContext?.isAmp) {
    return {
      requestedModel: originalRequested,
      ampMatchedBy: "",
      ampMatchedRef: ""
    };
  }

  const ampRouting = config?.ampRouting && typeof config.ampRouting === "object"
    ? config.ampRouting
    : {};
  if (ampRouting.enabled === false) {
    return {
      requestedModel: originalRequested,
      ampMatchedBy: "",
      ampMatchedRef: ""
    };
  }

  const mode = normalizeLookupKey(ampContext.mode);
  const agent = normalizeLookupKey(ampContext.agent);
  const application = normalizeLookupKey(ampContext.application);
  const model = String(ampContext.requestedModel || originalRequested || "").trim();
  const provider = normalizeLookupKey(ampContext.provider);

  const matches = [];
  const pushMatch = (matchedBy, ref) => {
    const value = String(ref || "").trim();
    if (!value) return;
    matches.push({ matchedBy, ref: value });
  };

  if (agent && mode) {
    pushMatch("agent-mode", lookupAgentModeRef(ampRouting.agentModeMap, agent, mode));
  }
  if (mode) {
    pushMatch("mode", lookupMapRef(ampRouting.modeMap, mode, { caseInsensitive: false }));
  }
  if (agent) {
    pushMatch("agent", lookupMapRef(ampRouting.agentMap, agent, { caseInsensitive: false }));
  }
  if (application) {
    pushMatch("application", lookupMapRef(ampRouting.applicationMap, application, { caseInsensitive: false }));
  }
  if (model) {
    pushMatch("model", lookupMapRef(ampRouting.modelMap, model));
  }
  if (provider && model) {
    pushMatch("provider-model", lookupMapRef(ampRouting.modelMap, `${provider}/${model}`));
  }

  if (matches.length > 0) {
    return {
      requestedModel: matches[0].ref,
      ampMatchedBy: matches[0].matchedBy,
      ampMatchedRef: matches[0].ref
    };
  }

  const fallbackRoute = typeof ampRouting.fallbackRoute === "string" && ampRouting.fallbackRoute.trim()
    ? ampRouting.fallbackRoute.trim()
    : "smart";
  return {
    requestedModel: fallbackRoute,
    ampMatchedBy: "fallback",
    ampMatchedRef: fallbackRoute
  };
}
