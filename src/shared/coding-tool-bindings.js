export const CODEX_CLI_INHERIT_MODEL_VALUE = "__codex_cli_inherit__";
export const CODEX_CLI_REASONING_EFFORT_VALUES = Object.freeze([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);
export const CLAUDE_CODE_THINKING_LEVEL_VALUES = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
export const CLAUDE_CODE_THINKING_TOKENS_BY_LEVEL = Object.freeze({
  low: 4096,
  medium: 12000,
  high: 24000,
  xhigh: 28000,
  max: 31999
});
export const CLAUDE_CODE_EFFORT_LEVEL_VALUES = CLAUDE_CODE_THINKING_LEVEL_VALUES;
export const CLAUDE_CODE_EFFORT_LEVEL_SETTINGS_JSON_VALUE = "high";

export function isCodexCliInheritModelBinding(value) {
  return String(value || "").trim() === CODEX_CLI_INHERIT_MODEL_VALUE;
}

export function normalizeCodexCliReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return CODEX_CLI_REASONING_EFFORT_VALUES.includes(normalized) ? normalized : "";
}

export function normalizeClaudeCodeThinkingLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return CLAUDE_CODE_THINKING_LEVEL_VALUES.includes(normalized) ? normalized : "";
}

export function mapClaudeCodeThinkingLevelToTokens(level) {
  const normalizedLevel = normalizeClaudeCodeThinkingLevel(level);
  if (!normalizedLevel) return "";
  return String(CLAUDE_CODE_THINKING_TOKENS_BY_LEVEL[normalizedLevel] || "");
}

export function mapClaudeCodeThinkingTokensToLevel(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "";
  if (parsed >= CLAUDE_CODE_THINKING_TOKENS_BY_LEVEL.max) return "max";
  if (parsed >= CLAUDE_CODE_THINKING_TOKENS_BY_LEVEL.xhigh) return "xhigh";
  if (parsed >= CLAUDE_CODE_THINKING_TOKENS_BY_LEVEL.high) return "high";
  if (parsed >= 6000) return "medium";
  return "low";
}

export const normalizeClaudeCodeEffortLevel = normalizeClaudeCodeThinkingLevel;
export const migrateLegacyThinkingTokensToEffortLevel = mapClaudeCodeThinkingTokensToLevel;

export const FACTORY_DROID_REASONING_EFFORT_VALUES = Object.freeze([
  "off",
  "none",
  "low",
  "medium",
  "high"
]);

function stripFactoryDroidRouterModelIdPrefix(value) {
  const normalized = String(value || "").trim();
  if (normalized.startsWith("custom:")) return normalized.slice("custom:".length).trim();
  return normalized;
}

function sanitizeFactoryDroidRouterModelIdPart(value) {
  return String(value || "")
    .trim()
    .replace(/[/:]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatFactoryDroidDisplayNameBase(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  let next = normalized;
  if (/^gpt(?=[-\s.]|$)/i.test(next)) next = `GPT${next.slice(3)}`;
  else if (/^glm(?=[-\s.]|$)/i.test(next)) next = `GLM${next.slice(3)}`;
  else if (/^claude(?=[-\s.]|$)/i.test(next)) next = `Claude${next.slice(6)}`;

  return next
    .replace(/(\d)-(\d)(?=(?:-|$))/g, "$1.$2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatFactoryDroidProviderLabel(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "Provider";
  if (normalized.toLowerCase() === "openrouter") return "OpenRouter";
  if (normalized.toLowerCase() === "deepseek") return "DeepSeek";
  if (/^[A-Za-z]{2,5}$/.test(normalized)) return normalized.toUpperCase();
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export function isFactoryDroidRouterModelId(value) {
  const normalized = stripFactoryDroidRouterModelIdPrefix(value);
  return normalized.startsWith("llm-");
}

export function parseFactoryDroidRouterModelId(value) {
  const normalized = stripFactoryDroidRouterModelIdPrefix(value);
  if (!normalized.startsWith("llm-")) return null;

  if (normalized.startsWith("llm-alias:")) {
    const aliasId = normalized.slice("llm-alias:".length).trim();
    return aliasId
      ? {
          kind: "alias",
          aliasId,
          routeRef: aliasId
        }
      : null;
  }

  if (normalized.startsWith("llm-alias-")) {
    const aliasId = normalized.slice("llm-alias-".length).trim();
    return aliasId
      ? {
          kind: "alias",
          aliasId,
          routeRef: ""
        }
      : null;
  }

  const body = normalized.slice("llm-".length);
  const separatorIndex = body.indexOf(":");
  if (separatorIndex <= 0) return null;

  const providerId = body.slice(0, separatorIndex).trim();
  const modelId = body.slice(separatorIndex + 1).trim();
  if (!providerId || !modelId) return null;

  return {
    kind: "model",
    providerId,
    modelId,
    routeRef: `${providerId}/${modelId}`
  };
}

export function resolveFactoryDroidRouterModelRef(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return parseFactoryDroidRouterModelId(normalized)?.routeRef || normalized;
}

export function buildFactoryDroidRouterModelId(modelRef, { kind = "" } = {}) {
  const normalizedModelRef = String(modelRef || "").trim();
  if (!normalizedModelRef) return "";
  if (normalizedModelRef.startsWith("custom:llm-")) {
    const parsed = parseFactoryDroidRouterModelId(normalizedModelRef);
    return parsed?.routeRef
      ? buildFactoryDroidRouterModelId(parsed.routeRef, { kind: parsed.kind })
      : normalizedModelRef;
  }
  if (normalizedModelRef.startsWith("llm-")) {
    const parsed = parseFactoryDroidRouterModelId(normalizedModelRef);
    return parsed?.routeRef
      ? buildFactoryDroidRouterModelId(parsed.routeRef, { kind: parsed.kind })
      : `custom:${normalizedModelRef}`;
  }

  const explicitKind = String(kind || "").trim().toLowerCase();
  if (explicitKind === "alias") {
    const aliasId = sanitizeFactoryDroidRouterModelIdPart(normalizedModelRef);
    return aliasId ? `custom:llm-alias-${aliasId}` : "";
  }

  if (explicitKind === "model") {
    const separatorIndex = normalizedModelRef.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex >= normalizedModelRef.length - 1) return "";
    const providerId = normalizedModelRef.slice(0, separatorIndex).trim();
    const modelId = normalizedModelRef.slice(separatorIndex + 1).trim();
    const providerSlug = sanitizeFactoryDroidRouterModelIdPart(providerId);
    const modelSlug = sanitizeFactoryDroidRouterModelIdPart(modelId);
    return providerSlug && modelSlug ? `custom:llm-${providerSlug}-${modelSlug}` : "";
  }

  if (!normalizedModelRef.includes("/")) {
    return buildFactoryDroidRouterModelId(normalizedModelRef, { kind: "alias" });
  }

  return buildFactoryDroidRouterModelId(normalizedModelRef, { kind: "model" });
}

export function buildFactoryDroidRouterDisplayName(modelRef, { kind = "", providerName = "" } = {}) {
  const normalizedModelRef = String(modelRef || "").trim();
  if (!normalizedModelRef) return "";

  const explicitKind = String(kind || "").trim().toLowerCase();
  const inferredKind = explicitKind || (normalizedModelRef.includes("/") ? "model" : "alias");
  if (inferredKind === "alias") {
    return `${formatFactoryDroidDisplayNameBase(normalizedModelRef)} - LLM Router (Alias)`;
  }

  const modelName = normalizedModelRef.includes("/")
    ? normalizedModelRef.slice(normalizedModelRef.indexOf("/") + 1).trim()
    : normalizedModelRef;
  return `${formatFactoryDroidDisplayNameBase(modelName)} - LLM Router (${formatFactoryDroidProviderLabel(providerName)})`;
}

export function normalizeFactoryDroidReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return FACTORY_DROID_REASONING_EFFORT_VALUES.includes(normalized) ? normalized : "";
}
