/**
 * Token storage for subscription providers.
 * Stores OAuth tokens in ~/.llm-router/oauth/<profile-id>.json
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TOKEN_STORAGE_DIR } from './subscription-constants.js';

/**
 * Get the token file path for a profile.
 */
export function getTokenFilePath(profileId) {
  const dir = path.join(os.homedir(), TOKEN_STORAGE_DIR);
  return path.join(dir, `${profileId}.json`);
}

/**
 * Ensure the token storage directory exists.
 */
async function ensureTokenDir() {
  const dir = path.join(os.homedir(), TOKEN_STORAGE_DIR);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // Directory exists, ignore
  }
}

/**
 * Token data structure.
 * @typedef {Object} TokenData
 * @property {string} accessToken - OAuth access token
 * @property {string} refreshToken - OAuth refresh token
 * @property {number} expiresAt - Expiration timestamp (ms since epoch)
 * @property {string} [tokenType] - Token type (usually "Bearer")
 * @property {string} [scope] - Granted scopes
 */

/**
 * Save tokens for a profile.
 * @param {string} profileId - Provider profile ID
 * @param {TokenData} tokenData - Token data to save
 */
export async function saveTokens(profileId, tokenData) {
  await ensureTokenDir();
  const filePath = getTokenFilePath(profileId);
  
  const data = {
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken,
    expiresAt: tokenData.expiresAt,
    tokenType: tokenData.tokenType || 'Bearer',
    scope: tokenData.scope,
    savedAt: Date.now()
  };
  
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Load tokens for a profile.
 * @param {string} profileId - Provider profile ID
 * @returns {Promise<TokenData|null>} Token data or null if not found
 */
export async function loadTokens(profileId) {
  try {
    const filePath = getTokenFilePath(profileId);
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: data.expiresAt,
      tokenType: data.tokenType || 'Bearer',
      scope: data.scope
    };
  } catch {
    return null;
  }
}

/**
 * Delete tokens for a profile.
 * @param {string} profileId - Provider profile ID
 */
export async function deleteTokens(profileId) {
  try {
    const filePath = getTokenFilePath(profileId);
    await fs.unlink(filePath);
  } catch {
    // File doesn't exist, ignore
  }
}

/**
 * Check if tokens exist for a profile.
 * @param {string} profileId - Provider profile ID
 */
export async function hasTokens(profileId) {
  const tokens = await loadTokens(profileId);
  return tokens !== null;
}

/**
 * Check if tokens are expired or expiring soon.
 * @param {TokenData} tokens - Token data
 * @param {number} [bufferMs] - Buffer time before expiration (default 5 min)
 */
export function isTokenExpired(tokens, bufferMs = 5 * 60 * 1000) {
  if (!tokens || !tokens.expiresAt) return true;
  return Date.now() >= (tokens.expiresAt - bufferMs);
}

/**
 * List all profiles with stored tokens.
 * @returns {Promise<string[]>} Array of profile IDs
 */
export async function listTokenProfiles() {
  try {
    const dir = path.join(os.homedir(), TOKEN_STORAGE_DIR);
    const files = await fs.readdir(dir);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5)); // Remove .json extension
  } catch {
    return [];
  }
}
