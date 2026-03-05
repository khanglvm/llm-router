/**
 * Hardcoded Codex subscription models.
 * These are used as the default seed list for ChatGPT subscription providers.
 * Users can still customize the final saved model list.
 */
export const CODEX_SUBSCRIPTION_MODELS = Object.freeze([
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.1-codex-mini'
]);

/**
 * Hardcoded Claude Code subscription models.
 * These defaults mirror current Claude Code model naming.
 * Users can still customize the final saved model list.
 */
export const CLAUDE_CODE_SUBSCRIPTION_MODELS = Object.freeze([
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5'
]);

/**
 * OAuth configuration for ChatGPT Codex subscription.
 */
export const CODEX_OAUTH_CONFIG = Object.freeze({
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  deviceCodeUrl: 'https://auth.openai.com/oauth/device/code',
  callbackPort: 1455,
  callbackPath: '/auth/callback',
  scopes: 'openid profile email offline_access',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', // Matches current codex-cli browser login flow
  authorizeParams: Object.freeze({
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs'
  }),
  tokenRefreshBufferMs: 5 * 60 * 1000 // 5 minutes before expiration
});

/**
 * OAuth configuration for Claude Code subscription.
 * Values align with the current Claude Code CLI runtime.
 */
export const CLAUDE_CODE_OAUTH_CONFIG = Object.freeze({
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  callbackPort: 1456,
  callbackPath: '/callback',
  manualRedirectUrl: 'https://platform.claude.com/oauth/code/callback',
  scopes: 'user:profile user:inference user:sessions:claude_code user:mcp_servers',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeParams: Object.freeze({
    code: 'true'
  }),
  oauthBeta: 'oauth-2025-04-20',
  apiBaseUrl: 'https://api.anthropic.com',
  messagesPath: '/v1/messages?beta=true',
  tokenRefreshBufferMs: 5 * 60 * 1000
});

/**
 * Token storage directory relative to home.
 */
export const TOKEN_STORAGE_DIR = '.llm-router/oauth';
