/**
 * Hardcoded Codex subscription models.
 * These are official ChatGPT Codex models that users cannot edit.
 * Updated via llm-router version releases to reflect OpenAI changes.
 */
export const CODEX_SUBSCRIPTION_MODELS = Object.freeze([
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.1-codex-mini'
]);

/**
 * OAuth configuration for ChatGPT Codex subscription.
 */
export const CODEX_OAUTH_CONFIG = Object.freeze({
  authorizeUrl: 'https://auth.openai.com/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  deviceCodeUrl: 'https://auth.openai.com/oauth/device/code',
  callbackPort: 1455,
  callbackPath: '/callback',
  scopes: 'openid profile email offline_access',
  clientId: 'pdlLIX2Y72MIl2rhLhTE9VV9bN905kBh', // Public Codex CLI client ID
  audience: 'https://api.openai.com/v1',
  tokenRefreshBufferMs: 5 * 60 * 1000 // 5 minutes before expiration
});

/**
 * Token storage directory relative to home.
 */
export const TOKEN_STORAGE_DIR = '.llm-router/oauth';
