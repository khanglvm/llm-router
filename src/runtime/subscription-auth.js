/**
 * OAuth authentication for ChatGPT Codex subscription providers.
 * Implements browser-based login and device code flow.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { CODEX_OAUTH_CONFIG, TOKEN_STORAGE_DIR } from './subscription-constants.js';
import { saveTokens, loadTokens, isTokenExpired, deleteTokens } from './subscription-tokens.js';

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

/**
 * Refresh an access token using refresh token.
 * @param {string} refreshToken - OAuth refresh token
 * @returns {Promise<Object>} New token data
 */
export async function refreshAccessToken(refreshToken) {
  const response = await fetch(CODEX_OAUTH_CONFIG.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_OAUTH_CONFIG.clientId
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + (data.expires_in * 1000),
    tokenType: data.token_type || 'Bearer',
    scope: data.scope
  };
}

/**
 * Get valid access token for a profile, refreshing if needed.
 * @param {string} profileId - Provider profile ID
 * @returns {Promise<string|null>} Valid access token or null
 */
export async function getValidAccessToken(profileId) {
  const tokens = await loadTokens(profileId);
  if (!tokens) return null;

  // Check if token needs refresh
  if (isTokenExpired(tokens, CODEX_OAUTH_CONFIG.tokenRefreshBufferMs)) {
    if (!tokens.refreshToken) {
      return null; // Cannot refresh without refresh token
    }

    try {
      const newTokens = await refreshAccessToken(tokens.refreshToken);
      await saveTokens(profileId, newTokens);
      return newTokens.accessToken;
    } catch {
      // Refresh failed, tokens are invalid
      await deleteTokens(profileId);
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
 * @returns {Promise<Object>} Token data
 */
async function exchangeCodeForTokens(code, codeVerifier, redirectUri) {
  const response = await fetch(CODEX_OAUTH_CONFIG.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: CODEX_OAUTH_CONFIG.clientId
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    tokenType: data.token_type || 'Bearer',
    scope: data.scope
  };
}

/**
 * Start browser-based OAuth login.
 * @param {string} profileId - Provider profile ID
 * @param {Object} [options] - Options
 * @param {number} [options.port] - Callback server port
 * @param {function} [options.onUrl] - Callback when auth URL is ready
 * @returns {Promise<boolean>} Success status
 */
export async function loginWithBrowser(profileId, options = {}) {
  const port = options.port || CODEX_OAUTH_CONFIG.callbackPort;
  const redirectUri = `http://localhost:${port}${CODEX_OAUTH_CONFIG.callbackPath}`;
  
  const pkce = generatePKCE();
  const state = generateState();
  
  const authUrl = new URL(CODEX_OAUTH_CONFIG.authorizeUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CODEX_OAUTH_CONFIG.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', CODEX_OAUTH_CONFIG.scopes);
  authUrl.searchParams.set('audience', CODEX_OAUTH_CONFIG.audience);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        
        if (url.pathname !== CODEX_OAUTH_CONFIG.callbackPath) {
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
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Invalid callback</h1><p>Missing or invalid state/code</p>');
          server.close();
          reject(new Error('Invalid OAuth callback'));
          return;
        }

        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(code, pkce.verifier, redirectUri);
        await saveTokens(profileId, tokens);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Success!</h1><p>You can close this window and return to the terminal.</p>');
        
        server.close();
        resolve(true);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error</h1><p>${err.message}</p>`);
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      const authUrlStr = authUrl.toString();
      if (options.onUrl) {
        options.onUrl(authUrlStr);
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Login timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

/**
 * Start device code OAuth login (for headless environments).
 * @param {string} profileId - Provider profile ID
 * @param {function} [options.onCode] - Callback when device code is ready
 * @returns {Promise<boolean>} Success status
 */
export async function loginWithDeviceCode(profileId, options = {}) {
  // Request device code
  const response = await fetch(CODEX_OAUTH_CONFIG.deviceCodeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: CODEX_OAUTH_CONFIG.clientId,
      scope: CODEX_OAUTH_CONFIG.scopes,
      audience: CODEX_OAUTH_CONFIG.audience
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

  // Notify user
  if (options.onCode) {
    options.onCode({ userCode, verificationUri, expiresIn });
  }

  // Poll for token
  const startTime = Date.now();
  while (Date.now() - startTime < expiresIn * 1000) {
    await new Promise(r => setTimeout(r, interval * 1000));

    try {
      const tokenResponse = await fetch(CODEX_OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: CODEX_OAUTH_CONFIG.clientId
        })
      });

      if (tokenResponse.ok) {
        const tokenData = await tokenResponse.json();
        const tokens = {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: Date.now() + (tokenData.expires_in * 1000),
          tokenType: tokenData.token_type || 'Bearer',
          scope: tokenData.scope
        };
        await saveTokens(profileId, tokens);
        return true;
      }

      const errorData = await tokenResponse.json();
      if (errorData.error === 'authorization_pending') {
        continue; // Keep polling
      }
      if (errorData.error === 'slow_down') {
        await new Promise(r => setTimeout(r, interval * 1000));
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
 */
export async function logout(profileId) {
  await deleteTokens(profileId);
}

/**
 * Check authentication status for a profile.
 * @param {string} profileId - Provider profile ID
 * @returns {Promise<Object>} Status object
 */
export async function getAuthStatus(profileId) {
  const tokens = await loadTokens(profileId);
  
  if (!tokens) {
    return {
      authenticated: false,
      profileId,
      reason: 'No tokens found'
    };
  }

  const expired = isTokenExpired(tokens, CODEX_OAUTH_CONFIG.tokenRefreshBufferMs);
  
  return {
    authenticated: !expired,
    profileId,
    expiresAt: tokens.expiresAt,
    expiresAtIso: new Date(tokens.expiresAt).toISOString(),
    expired,
    hasRefreshToken: !!tokens.refreshToken
  };
}
