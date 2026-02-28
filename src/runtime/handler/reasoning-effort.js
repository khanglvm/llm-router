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
  if (["xhigh", "extra high", "max", "maximum"].includes(compact)) return "xhigh";

  if (compact.includes("ultra")) return "xhigh";
  if (compact.includes("think hard") || compact.includes("harder")) return "high";
  if (compact === "think") return "medium";
  return "";
}

function parseNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function extractEffortFromBody(body) {
  if (!body || typeof body !== "object") return "";

  const directCandidates = [
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
    if (ratio >= 0.9) return "max";
    if (ratio >= 0.65) return "high";
    if (ratio >= 0.3) return "medium";
    return "low";
  }

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

function supportsOpenAIXHighEffort(targetModel) {
  const model = String(targetModel || "").trim().toLowerCase();
  if (!model) return false;
  if (model.startsWith("gpt-5.2")) return true;
  if (model.startsWith("gpt-5.3-codex")) return true;
  return false;
}

function supportsOpenAINoneEffort(targetModel) {
  const model = String(targetModel || "").trim().toLowerCase();
  if (!model) return false;
  if (model.startsWith("gpt-5.1") && !model.includes("codex")) return true;
  if (model.startsWith("gpt-5.2") && !model.includes("codex") && !model.includes("pro")) return true;
  return false;
}

function mapEffortToOpenAI(effort, targetModel) {
  switch (effort) {
    case "none":
      return supportsOpenAINoneEffort(targetModel) ? "none" : "low";
    case "minimal":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return supportsOpenAIXHighEffort(targetModel) ? "xhigh" : "high";
    default:
      return "";
  }
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
    case "max":
      return maxBudget;
    default:
      return undefined;
  }
}

function applyClaudeEffort(providerBody, effort, { sourceFormat, originalBody } = {}) {
  const nextBody = { ...(providerBody || {}) };

  if (effort === "none" || effort === "minimal") {
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

  const budgetTokens = toClaudeThinkingBudget(effort, maxTokens);
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
  requestHeaders
}) {
  const effort = resolveRequestedEffort(originalBody, requestHeaders);
  if (!effort) return providerBody;

  if (targetFormat === FORMATS.OPENAI) {
    return applyOpenAIEffort(providerBody, effort, targetModel);
  }
  if (targetFormat === FORMATS.CLAUDE) {
    return applyClaudeEffort(providerBody, effort, {
      sourceFormat,
      originalBody
    });
  }
  return providerBody;
}
