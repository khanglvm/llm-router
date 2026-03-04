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
 * Token storage directory relative to home.
 */
export const TOKEN_STORAGE_DIR = '.llm-router/oauth';
