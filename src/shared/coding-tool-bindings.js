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
  "max"
]);
export const CLAUDE_CODE_THINKING_TOKENS_BY_LEVEL = Object.freeze({
  low: 4096,
  medium: 12000,
  high: 24000,
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

export function normalizeFactoryDroidReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return FACTORY_DROID_REASONING_EFFORT_VALUES.includes(normalized) ? normalized : "";
}
