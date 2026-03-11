/**
 * OAuth authentication for subscription providers.
 * Supports ChatGPT Codex and Claude Code OAuth flows.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  CODEX_OAUTH_CONFIG,
  CLAUDE_CODE_OAUTH_CONFIG
} from './subscription-constants.js';
import {
  saveTokens,
  loadTokens,
  isTokenExpired,
  deleteTokens,
  listTokenProfiles as listTokenProfilesFromStore
} from './subscription-tokens.js';

const SUBSCRIPTION_TYPE_CHATGPT_CODEX = 'chatgpt-codex';
const SUBSCRIPTION_TYPE_CLAUDE_CODE = 'claude-code';
const CLAUDE_PROFILE_PREFIX = `${SUBSCRIPTION_TYPE_CLAUDE_CODE}__`;

function normalizeSubscriptionType(value, { allowEmpty = false } = {}) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return allowEmpty ? '' : SUBSCRIPTION_TYPE_CHATGPT_CODEX;
  }
  if (normalized === SUBSCRIPTION_TYPE_CHATGPT_CODEX) return SUBSCRIPTION_TYPE_CHATGPT_CODEX;
  if (normalized === SUBSCRIPTION_TYPE_CLAUDE_CODE) return SUBSCRIPTION_TYPE_CLAUDE_CODE;
  throw new Error(`Unsupported subscription type '${value}'.`);
}

function resolveOAuthConfig(subscriptionType) {
  const normalized = normalizeSubscriptionType(subscriptionType);
  if (normalized === SUBSCRIPTION_TYPE_CLAUDE_CODE) {
    return CLAUDE_CODE_OAUTH_CONFIG;
  }
  return CODEX_OAUTH_CONFIG;
}

function toTokenProfileKey(profileId, subscriptionType) {
  const normalizedProfile = String(profileId || 'default').trim() || 'default';
  const normalizedType = normalizeSubscriptionType(subscriptionType);
  if (normalizedType === SUBSCRIPTION_TYPE_CLAUDE_CODE) {
    return `${CLAUDE_PROFILE_PREFIX}${normalizedProfile}`;
  }
  return normalizedProfile;
}

function fromTokenProfileKey(profileKey) {
  const value = String(profileKey || '').trim();
  if (value.startsWith(CLAUDE_PROFILE_PREFIX)) {
    return {
      profileId: value.slice(CLAUDE_PROFILE_PREFIX.length) || 'default',
      subscriptionType: SUBSCRIPTION_TYPE_CLAUDE_CODE
    };
  }
  return {
    profileId: value || 'default',
    subscriptionType: SUBSCRIPTION_TYPE_CHATGPT_CODEX
  };
}

/**
 * Generate PKCE code verifier and challenge.
 */
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
}

/**
 * Generate random state for CSRF protection.
 */
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

function tryOpenBrowser(url) {
  const target = String(url || '').trim();
  if (!target) return false;

  try {
    let child;
    if (process.platform === 'darwin') {
      child = spawn('open', [target], { stdio: 'ignore', detached: true });
    } else if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', target], { stdio: 'ignore', detached: true });
    } else {
      child = spawn('xdg-open', [target], { stdio: 'ignore', detached: true });
    }
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function normalizeTokenData(data, fallbackRefreshToken = undefined) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefreshToken,
    expiresAt: Date.now() + (Number(data.expires_in || 0) * 1000),
    tokenType: data.token_type || 'Bearer',
    scope: data.scope
  };
}

/**
 * Refresh an access token using refresh token.
 * @param {string} refreshToken - OAuth refresh token
 * @param {Object} [options] - Options
 * @param {string} [options.subscriptionType] - Subscription type
 * @returns {Promise<Object>} New token data
 */
export async function refreshAccessToken(refreshToken, options = {}) {
  const config = resolveOAuthConfig(options.subscriptionType);
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId
  };
  if (typeof config.scopes === 'string' && config.scopes.trim()) {
    body.scope = config.scopes;
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  return normalizeTokenData(data, refreshToken);
}

/**
 * Get valid access token for a profile, refreshing if needed.
 * @param {string} profileId - Provider profile ID
 * @param {Object} [options] - Options
 * @param {string} [options.subscriptionType] - Subscription type
 * @returns {Promise<string|null>} Valid access token or null
 */
export async function getValidAccessToken(profileId, options = {}) {
  const config = resolveOAuthConfig(options.subscriptionType);
  const tokenProfileKey = toTokenProfileKey(profileId, options.subscriptionType);
  const tokens = await loadTokens(tokenProfileKey);
  if (!tokens) return null;

  // Check if token needs refresh
  if (isTokenExpired(tokens, config.tokenRefreshBufferMs)) {
    if (!tokens.refreshToken) {
      return null;
    }

    try {
      const newTokens = await refreshAccessToken(tokens.refreshToken, {
        subscriptionType: options.subscriptionType
      });
      await saveTokens(tokenProfileKey, newTokens);
      return newTokens.accessToken;
    } catch {
      await deleteTokens(tokenProfileKey);
      return null;
    }
  }

  return tokens.accessToken;
}

/**
 * Exchange authorization code for tokens.
 * @param {string} code - Authorization code
 * @param {string} codeVerifier - PKCE code verifier
 * @param {string} redirectUri - Redirect URI used in auth request
 * @param {Object} [options] - Options
 * @param {string} [options.subscriptionType] - Subscription type
 * @returns {Promise<Object>} Token data
 */
async function exchangeCodeForTokens(code, codeVerifier, redirectUri, options = {}) {
  const config = resolveOAuthConfig(options.subscriptionType);
  const body = {
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    client_id: config.clientId
  };

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  return normalizeTokenData(data);
}

/**
 * Start browser-based OAuth login.
 * @param {string} profileId - Provider profile ID
 * @param {Object} [options] - Options
 * @param {string} [options.subscriptionType] - Subscription type
 * @param {number} [options.port] - Callback server port
 * @param {function} [options.onUrl] - Callback when auth URL is ready
 * @returns {Promise<boolean>} Success status
 */
export async function loginWithBrowser(profileId, options = {}) {
  const config = resolveOAuthConfig(options.subscriptionType);
  const tokenProfileKey = toTokenProfileKey(profileId, options.subscriptionType);
  const port = options.port || config.callbackPort;
  const redirectUri = `http://localhost:${port}${config.callbackPath}`;

  const pkce = generatePKCE();
  const state = generateState();

  const authUrl = new URL(config.authorizeUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', config.scopes);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (config.authorizeParams && typeof config.authorizeParams === 'object') {
    for (const [key, value] of Object.entries(config.authorizeParams)) {
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        authUrl.searchParams.set(key, String(value));
      }
    }
  }

  return new Promise((resolve, reject) => {
    let completed = false;
    const finish = (fn) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      fn();
    };

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${port}`);

        if (url.pathname !== config.callbackPath) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Authentication failed</h1><p>${error}</p>`);
          server.close();
          finish(() => reject(new Error(`OAuth error: ${error}`)));
          return;
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Invalid callback</h1><p>Missing or invalid state/code</p>');
          server.close();
          finish(() => reject(new Error('Invalid OAuth callback')));
          return;
        }

        const tokens = await exchangeCodeForTokens(code, pkce.verifier, redirectUri, {
          subscriptionType: options.subscriptionType
        });
        await saveTokens(tokenProfileKey, tokens);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Success!</h1><p>You can close this window and return to the terminal.</p>');
        server.close();
        finish(() => resolve(true));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error</h1><p>${err.message}</p>`);
        server.close();
        finish(() => reject(err));
      }
    });

    server.listen(port, () => {
      const authUrlStr = authUrl.toString();
      const openedBrowser = options.autoOpen !== false ? tryOpenBrowser(authUrlStr) : false;
      if (options.onUrl) {
        options.onUrl(authUrlStr, { openedBrowser });
      }
    });

    const timeout = setTimeout(() => {
      server.close();
      finish(() => reject(new Error('Login timed out after 5 minutes')));
    }, 5 * 60 * 1000);
  });
}

/**
 * Start device code OAuth login (for headless environments).
 * @param {string} profileId - Provider profile ID
 * @param {Object} [options] - Options
 * @param {string} [options.subscriptionType] - Subscription type
 * @param {function} [options.onCode] - Callback when device code is ready
 * @returns {Promise<boolean>} Success status
 */
export async function loginWithDeviceCode(profileId, options = {}) {
  const config = resolveOAuthConfig(options.subscriptionType);
  if (!config.deviceCodeUrl) {
    throw new Error(`Device code OAuth flow is not supported for subscription type '${normalizeSubscriptionType(options.subscriptionType)}'.`);
  }

  const tokenProfileKey = toTokenProfileKey(profileId, options.subscriptionType);
  const response = await fetch(config.deviceCodeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      scope: config.scopes
    }).toString()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Device code request failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  const deviceCode = data.device_code;
  const userCode = data.user_code;
  const verificationUri = data.verification_uri;
  const expiresIn = data.expires_in;
  const interval = data.interval || 5;

  if (options.onCode) {
    options.onCode({ userCode, verificationUri, expiresIn });
  }

  const startTime = Date.now();
  while (Date.now() - startTime < expiresIn * 1000) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    try {
      const tokenResponse = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: config.clientId
        })
      });

      if (tokenResponse.ok) {
        const tokenData = await tokenResponse.json();
        await saveTokens(tokenProfileKey, normalizeTokenData(tokenData));
        return true;
      }

      const errorData = await tokenResponse.json();
      if (errorData.error === 'authorization_pending') {
        continue;
      }
      if (errorData.error === 'slow_down') {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        continue;
      }
      throw new Error(`Token polling error: ${errorData.error}`);
    } catch (err) {
      if (err.message.includes('authorization_pending')) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Device code login timed out');
}

/**
 * Logout (delete tokens) for a profile.
 * @param {string} profileId - Provider profile ID
 * @param {Object} [options] - Options
 * @param {string} [options.subscriptionType] - Subscription type
 */
export async function logout(profileId, options = {}) {
  const tokenProfileKey = toTokenProfileKey(profileId, options.subscriptionType);
  await deleteTokens(tokenProfileKey);
}

/**
 * Check authentication status for a profile.
 * @param {string} profileId - Provider profile ID
 * @param {Object} [options] - Options
 * @param {string} [options.subscriptionType] - Subscription type
 * @returns {Promise<Object>} Status object
 */
export async function getAuthStatus(profileId, options = {}) {
  const config = resolveOAuthConfig(options.subscriptionType);
  const tokenProfileKey = toTokenProfileKey(profileId, options.subscriptionType);
  const tokens = await loadTokens(tokenProfileKey);

  if (!tokens) {
    return {
      authenticated: false,
      profileId,
      subscriptionType: normalizeSubscriptionType(options.subscriptionType),
      reason: 'No tokens found'
    };
  }

  const expired = isTokenExpired(tokens, config.tokenRefreshBufferMs);

  return {
    authenticated: !expired,
    profileId,
    subscriptionType: normalizeSubscriptionType(options.subscriptionType),
    expiresAt: tokens.expiresAt,
    expiresAtIso: new Date(tokens.expiresAt).toISOString(),
    expired,
    hasRefreshToken: !!tokens.refreshToken
  };
}

/**
 * List all token profiles with stored subscription credentials.
 * When subscriptionType is provided, returns only profiles for that type.
 * @param {Object} [options] - Options
 * @param {string} [options.subscriptionType] - Subscription type filter
 * @returns {Promise<string[]>} Profile IDs
 */
export async function listTokenProfiles(options = {}) {
  const requestedType = normalizeSubscriptionType(options.subscriptionType, { allowEmpty: true });
  const profileKeys = await listTokenProfilesFromStore();
  const visibleProfiles = [];
  const seen = new Set();

  for (const profileKey of profileKeys) {
    const parsed = fromTokenProfileKey(profileKey);
    if (requestedType && parsed.subscriptionType !== requestedType) continue;
    if (seen.has(parsed.profileId)) continue;
    seen.add(parsed.profileId);
    visibleProfiles.push(parsed.profileId);
  }

  return visibleProfiles;
}
