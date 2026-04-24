import { FORMATS } from "../../translator/index.js";

const REASONING_EFFORT_HEADERS = [
  "x-claude-code-reasoning-effort",
  "x-claude-code-thinking-effort",
  "x-claude-code-thinking-mode",
  "x-claude-thinking-mode",
  "x-openai-reasoning-effort",
  "x-reasoning-effort",
  "reasoning-effort"
];

const EFFORT_HEADER_PATTERNS = [
  /reasoning[-_]?effort/i,
  /thinking[-_]?mode/i,
  /thinking[-_]?effort/i
];

const ORDERED_EFFORT_LEVELS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

function readHeaderValue(headers, name) {
  if (!headers || !name) return "";
  if (typeof headers.get === "function") {
    return String(headers.get(name) || "").trim();
  }

  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() !== String(name).toLowerCase()) continue;
      return String(value || "").trim();
    }
  }

  return "";
}

function eachHeader(headers, callback) {
  if (!headers || typeof callback !== "function") return;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, name) => {
      callback(String(name), String(value || ""));
    });
    return;
  }

  if (typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) {
      callback(String(name), String(value || ""));
    }
  }
}

function normalizeEffort(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) return "";

  const compact = value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!compact) return "";
  if (["none", "off", "disabled", "disable"].includes(compact)) return "none";
  if (compact === "minimal") return "minimal";
  if (compact === "low") return "low";
  if (["medium", "normal", "standard", "default"].includes(compact)) return "medium";
  if (compact === "high") return "high";
  if (["xhigh", "extra high"].includes(compact)) return "xhigh";
  if (["max", "maximum"].includes(compact)) return "max";

  if (compact.includes("ultra")) return "xhigh";
  if (compact.includes("think hard") || compact.includes("harder")) return "high";
  if (compact === "think") return "medium";
  return "";
}

function getEffortRank(effort) {
  return ORDERED_EFFORT_LEVELS.indexOf(normalizeEffort(effort));
}

function normalizeModelMatcherValue(value) {
  let text = String(value || "").trim().toLowerCase();
  if (!text) return "";

  const slashIndex = Math.max(text.lastIndexOf("/"), text.lastIndexOf(":"));
  if (slashIndex >= 0) {
    text = text.slice(slashIndex + 1);
  }

  return text
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function matchesModelPattern(targetModel, pattern) {
  const normalizedModel = normalizeModelMatcherValue(targetModel);
  if (!normalizedModel) return false;
  return new RegExp(`(?:^|-)${pattern}(?:-|$)`).test(normalizedModel);
}

function resolveSupportedEffort(requestedEffort, supportedEfforts = []) {
  const normalizedRequested = normalizeEffort(requestedEffort);
  if (!normalizedRequested) return "";

  const normalizedSupported = [...new Set(
    (Array.isArray(supportedEfforts) ? supportedEfforts : [supportedEfforts])
      .map((effort) => normalizeEffort(effort))
      .filter(Boolean)
  )];
  if (normalizedSupported.length === 0) return normalizedRequested;
  if (normalizedSupported.includes(normalizedRequested)) return normalizedRequested;

  const requestedRank = getEffortRank(normalizedRequested);
  let bestAtOrBelow = "";
  let bestAtOrBelowRank = -1;
  for (const supported of normalizedSupported) {
    const supportedRank = getEffortRank(supported);
    if (supportedRank <= requestedRank && supportedRank > bestAtOrBelowRank) {
      bestAtOrBelow = supported;
      bestAtOrBelowRank = supportedRank;
    }
  }
  if (bestAtOrBelow) return bestAtOrBelow;

  return normalizedSupported.reduce((lowest, supported) => (
    getEffortRank(supported) < getEffortRank(lowest) ? supported : lowest
  ), normalizedSupported[0]);
}

function parseNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function extractEffortFromBody(body) {
  if (!body || typeof body !== "object") return "";

  const directCandidates = [
    body.output_config?.effort,
    body.reasoning_effort,
    body.reasoningEffort,
    body["reasoning-effort"],
    body.effort
  ];
  for (const candidate of directCandidates) {
    const normalized = normalizeEffort(candidate);
    if (normalized) return normalized;
  }

  if (body.reasoning && typeof body.reasoning === "object") {
    const nested = normalizeEffort(body.reasoning.effort);
    if (nested) return nested;
  }

  return "";
}

function inferEffortFromClaudeThinking(body) {
  if (!body || typeof body !== "object") return "";
  if (!body.thinking || typeof body.thinking !== "object") return "";

  const explicit = normalizeEffort(
    body.thinking.effort ||
    body.thinking.level ||
    body.thinking.mode
  );
  if (explicit) return explicit;

  const thinkingType = String(body.thinking.type || "").toLowerCase();
  const budgetTokens = parseNumber(body.thinking.budget_tokens);
  const maxTokens = parseNumber(body.max_tokens);
  if (thinkingType !== "enabled" && !Number.isFinite(budgetTokens)) return "";

  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    return "medium";
  }

  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    const ratio = budgetTokens / maxTokens;
    if (ratio >= 0.97) return "max";
    if (ratio >= 0.82) return "xhigh";
    if (ratio >= 0.65) return "high";
    if (ratio >= 0.3) return "medium";
    return "low";
  }

  if (budgetTokens >= 31999) return "max";
  if (budgetTokens >= 28000) return "xhigh";
  if (budgetTokens >= 24000) return "high";
  if (budgetTokens >= 6000) return "medium";
  return "low";
}

function extractEffortFromHeaders(headers) {
  for (const name of REASONING_EFFORT_HEADERS) {
    const normalized = normalizeEffort(readHeaderValue(headers, name));
    if (normalized) return normalized;
  }

  let discovered = "";
  eachHeader(headers, (name, value) => {
    if (discovered) return;
    if (!EFFORT_HEADER_PATTERNS.some((pattern) => pattern.test(name))) return;
    discovered = normalizeEffort(value);
  });
  return discovered;
}

function prefersNestedOpenAIReasoning(targetModel) {
  const model = String(targetModel || "").trim().toLowerCase();
  if (!model) return false;
  return model.startsWith("gpt-5");
}

function resolveOpenAISupportedEfforts(targetModel) {
  if (matchesModelPattern(targetModel, "gpt-5-4-pro")) return ["medium", "high", "xhigh"];
  if (matchesModelPattern(targetModel, "gpt-5-pro")) return ["high"];
  if (matchesModelPattern(targetModel, "gpt-5-4")) return ["none", "low", "medium", "high", "xhigh"];
  if (matchesModelPattern(targetModel, "gpt-5-3-codex")) return ["low", "medium", "high", "xhigh"];
  if (matchesModelPattern(targetModel, "gpt-5-2-codex")) return ["low", "medium", "high", "xhigh"];
  if (matchesModelPattern(targetModel, "gpt-5-2-pro")) return ["medium", "high", "xhigh"];
  if (matchesModelPattern(targetModel, "gpt-5-2")) return ["none", "low", "medium", "high", "xhigh"];
  if (matchesModelPattern(targetModel, "gpt-5-1-codex")) return ["low", "medium", "high"];
  if (matchesModelPattern(targetModel, "gpt-5-1")) return ["none", "low", "medium", "high"];
  if (matchesModelPattern(targetModel, "gpt-5")) return ["minimal", "low", "medium", "high"];
  return ["low", "medium", "high"];
}

function resolveClaudeEffortProfile(targetModel) {
  if (matchesModelPattern(targetModel, "opus-4-7")) {
    return {
      supportsEffortApi: true,
      requiresAdaptiveThinking: true,
      preserveManualBudgetThinking: false,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"]
    };
  }
  if (matchesModelPattern(targetModel, "opus-4-6") || matchesModelPattern(targetModel, "sonnet-4-6")) {
    return {
      supportsEffortApi: true,
      requiresAdaptiveThinking: true,
      preserveManualBudgetThinking: true,
      supportedEfforts: ["low", "medium", "high", "max"]
    };
  }
  if (matchesModelPattern(targetModel, "opus-4-5")) {
    return {
      supportsEffortApi: false,
      requiresAdaptiveThinking: false,
      preserveManualBudgetThinking: true,
      supportedEfforts: ["low", "medium", "high", "max"]
    };
  }
  return {
    supportsEffortApi: false,
    requiresAdaptiveThinking: false,
    preserveManualBudgetThinking: true,
    supportedEfforts: ["low", "medium", "high"]
  };
}

function mapEffortToOpenAI(effort, targetModel) {
  return resolveSupportedEffort(effort, resolveOpenAISupportedEfforts(targetModel));
}

function applyOpenAIEffort(providerBody, effort, targetModel) {
  const mapped = mapEffortToOpenAI(effort, targetModel);
  if (!mapped) return providerBody;

  const nextBody = { ...(providerBody || {}) };
  if (
    (nextBody.reasoning && typeof nextBody.reasoning === "object") ||
    prefersNestedOpenAIReasoning(targetModel)
  ) {
    nextBody.reasoning = {
      ...(nextBody.reasoning && typeof nextBody.reasoning === "object" ? nextBody.reasoning : {}),
      effort: mapped
    };
    delete nextBody.reasoning_effort;
    return nextBody;
  }

  nextBody.reasoning_effort = mapped;
  return nextBody;
}

function clampBudget(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function hasExplicitMaxTokens(originalBody, sourceFormat) {
  if (!originalBody || typeof originalBody !== "object") return false;
  if (sourceFormat === FORMATS.CLAUDE) {
    return originalBody.max_tokens !== undefined;
  }
  return originalBody.max_tokens !== undefined || originalBody.max_completion_tokens !== undefined;
}

function toClaudeThinkingBudget(effort, maxTokens) {
  if (!Number.isFinite(maxTokens)) return undefined;
  const safeMaxTokens = Math.floor(maxTokens);
  const maxBudget = safeMaxTokens - 1;
  if (maxBudget < 1024) return undefined;

  switch (effort) {
    case "low":
      return clampBudget(Math.round(safeMaxTokens * 0.2), 1024, maxBudget);
    case "medium":
      return clampBudget(Math.round(safeMaxTokens * 0.45), 1024, maxBudget);
    case "high":
      return clampBudget(Math.round(safeMaxTokens * 0.75), 1024, maxBudget);
    case "xhigh":
      return clampBudget(Math.round(safeMaxTokens * 0.9), 1024, maxBudget);
    case "max":
      return maxBudget;
    default:
      return undefined;
  }
}

function applyClaudeEffort(providerBody, effort, { sourceFormat, originalBody, targetModel } = {}) {
  const nextBody = { ...(providerBody || {}) };
  const requestedEffort = normalizeEffort(effort);
  const profile = resolveClaudeEffortProfile(targetModel);
  const mappedEffort = resolveSupportedEffort(requestedEffort, profile.supportedEfforts);

  if (profile.supportsEffortApi && mappedEffort) {
    nextBody.output_config = {
      ...(nextBody.output_config && typeof nextBody.output_config === "object" && !Array.isArray(nextBody.output_config)
        ? nextBody.output_config
        : {}),
      effort: mappedEffort
    };

    const explicitBudgetTokens = parseNumber(nextBody?.thinking?.budget_tokens);
    const explicitThinkingType = String(nextBody?.thinking?.type || "").trim().toLowerCase();
    if (profile.preserveManualBudgetThinking && Number.isFinite(explicitBudgetTokens)) {
      return nextBody;
    }

    if (profile.requiresAdaptiveThinking) {
      if (explicitThinkingType === "disabled") {
        nextBody.thinking = { type: "disabled" };
      } else {
        nextBody.thinking = { type: "adaptive" };
      }
    }
    return nextBody;
  }

  if (requestedEffort === "none" || requestedEffort === "minimal") {
    delete nextBody.thinking;
    return nextBody;
  }

  // Preserve explicit Claude thinking budgets from user requests.
  if (
    sourceFormat === FORMATS.CLAUDE &&
    nextBody.thinking &&
    typeof nextBody.thinking === "object" &&
    Number.isFinite(parseNumber(nextBody.thinking.budget_tokens))
  ) {
    return nextBody;
  }

  let maxTokens = parseNumber(nextBody.max_tokens);
  if ((!Number.isFinite(maxTokens) || maxTokens <= 1024) && !hasExplicitMaxTokens(originalBody, sourceFormat)) {
    maxTokens = 2048;
    nextBody.max_tokens = maxTokens;
  }

  const budgetTokens = toClaudeThinkingBudget(mappedEffort || requestedEffort, maxTokens);
  if (!Number.isFinite(budgetTokens)) {
    return nextBody;
  }

  nextBody.thinking = {
    type: "enabled",
    budget_tokens: budgetTokens
  };
  return nextBody;
}

function resolveRequestedEffort(originalBody, requestHeaders) {
  const fromBody = extractEffortFromBody(originalBody);
  if (fromBody) return fromBody;

  const fromHeaders = extractEffortFromHeaders(requestHeaders);
  if (fromHeaders) return fromHeaders;

  return inferEffortFromClaudeThinking(originalBody);
}

export function applyReasoningEffortMapping({
  originalBody,
  providerBody,
  sourceFormat,
  targetFormat,
  targetModel,
  requestHeaders,
  capabilities
}) {
  if (capabilities) {
    if (targetFormat === FORMATS.OPENAI && capabilities.supportsReasoning === false) {
      return providerBody;
    }
    if (targetFormat === FORMATS.CLAUDE && capabilities.supportsThinking === false) {
      return providerBody;
    }
  }

  const effort = resolveRequestedEffort(originalBody, requestHeaders);
  if (!effort) return providerBody;

  if (targetFormat === FORMATS.OPENAI) {
    return applyOpenAIEffort(providerBody, effort, targetModel);
  }
  if (targetFormat === FORMATS.CLAUDE) {
    return applyClaudeEffort(providerBody, effort, {
      sourceFormat,
      originalBody,
      targetModel
    });
  }
  return providerBody;
}
