/**
 * Subscription provider handler.
 * Integrates OAuth-based subscription accounts into the provider system.
 */

import { getValidAccessToken, loginWithBrowser, loginWithDeviceCode, logout, getAuthStatus } from './subscription-auth.js';
import {
  transformRequestForCodex,
  buildCodexHeaders,
  CODEX_ENDPOINT,
  mapCodexVariant
} from './codex-request-transformer.js';
import {
  CLAUDE_CODE_OAUTH_CONFIG
} from './subscription-constants.js';
import { FORMATS } from '../translator/index.js';

const UNSUPPORTED_PARAMETER_PATTERN = /Unsupported parameter:\s*([A-Za-z0-9_.-]+)/gi;
const MAX_UNSUPPORTED_PARAMETER_RETRIES = 6;

/**
 * Subscription provider types.
 */
export const SUBSCRIPTION_TYPES = {
  CHATGPT_CODEX: 'chatgpt-codex',
  CLAUDE_CODE: 'claude-code'
};

/**
 * Check if a provider is a subscription provider.
 * 
 * @param {Object} provider - Provider config object
 * @returns {boolean} True if provider is a subscription type
 */
export function isSubscriptionProvider(provider) {
  return provider?.type === 'subscription';
}

/**
 * Get subscription profile ID from provider.
 * Falls back to provider ID if not explicitly set.
 * 
 * @param {Object} provider - Provider config object
 * @returns {string} Profile ID for token storage
 */
export function getSubscriptionProfileId(provider) {
  return provider?.subscriptionProfile || provider?.subscription_profile || provider?.id || 'default';
}

/**
 * Validate subscription provider configuration.
 * 
 * @param {Object} provider - Provider config object
 * @returns {{ valid: boolean, error?: string }} Validation result
 */
export function validateSubscriptionProvider(provider) {
  if (!isSubscriptionProvider(provider)) {
    return { valid: false, error: 'Not a subscription provider' };
  }
  
  const subType = provider.subscriptionType || provider.subscription_type;
  
  if (!subType) {
    return { valid: false, error: 'Subscription provider missing subscriptionType' };
  }
  
  if (!Object.values(SUBSCRIPTION_TYPES).includes(subType)) {
    return { valid: false, error: `Unknown subscription type: ${subType}` };
  }
  
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return { valid: false, error: 'Subscription provider must have at least one model' };
  }
  
  return { valid: true };
}

/**
 * Make a subscription provider API call.
 * Handles token loading, refresh, and request transformation.
 * 
 * @param {Object} options - Call options
 * @param {Object} options.provider - Provider config
 * @param {Object} options.body - OpenAI-format provider request body
 * @param {boolean} options.stream - Whether streaming is enabled
 * @returns {Promise<Object>} Call result with ok, status, response
 */
export async function makeSubscriptionProviderCall({ provider, body, stream }) {
  const validation = validateSubscriptionProvider(provider);
  if (!validation.valid) {
    return {
      ok: false,
      status: 400,
      retryable: false,
      errorKind: 'configuration_error',
      response: new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'configuration_error',
          message: validation.error
        }
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    };
  }
  
  const profileId = getSubscriptionProfileId(provider);
  const subType = provider.subscriptionType || provider.subscription_type;
  
  // Get valid access token (auto-refreshes if expired)
  let accessToken;
  try {
    accessToken = await getValidAccessToken(profileId, { subscriptionType: subType });
  } catch (error) {
    return {
      ok: false,
      status: 401,
      retryable: false,
      errorKind: 'auth_error',
      response: new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: `Failed to get access token: ${error instanceof Error ? error.message : String(error)}`
        }
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    };
  }
  
  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      retryable: false,
      errorKind: 'auth_error',
      response: new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: `Not authenticated for subscription profile '${profileId}'. Run 'llm-router subscription login --profile=${profileId}' first.`
        }
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    };
  }
  
  // Route to appropriate handler based on subscription type
  if (subType === SUBSCRIPTION_TYPES.CHATGPT_CODEX) {
    return makeCodexProviderCall({ provider, body, stream, accessToken });
  }
  if (subType === SUBSCRIPTION_TYPES.CLAUDE_CODE) {
    return makeClaudeCodeProviderCall({ provider, body, stream, accessToken });
  }
  
  return {
    ok: false,
    status: 501,
    retryable: false,
    errorKind: 'not_supported_error',
    response: new Response(JSON.stringify({
      type: 'error',
      error: {
        type: 'not_supported_error',
        message: `Subscription type '${subType}' is not implemented`
      }
    }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' }
    })
  };
}

/**
 * Make a Codex API call.
 * 
 * @param {Object} options - Call options
 * @returns {Promise<Object>} Call result
 */
async function makeCodexProviderCall({ provider, body, stream, accessToken }) {
  // Transform request for Codex backend
  const codexBody = transformRequestForCodex(body);
  stripCodexTokenLimitFields(codexBody);
  
  // Apply variant settings if specified in model config
  const modelConfig = (provider.models || []).find(m => m.id === body.model);
  if (modelConfig?.variant) {
    Object.assign(codexBody, mapCodexVariant(modelConfig.variant));
  }
  
  // Build headers
  const headers = buildCodexHeaders(accessToken, provider.headers || {});
  
  // Make the request
  try {
    const removedUnsupportedParameters = new Set();
    for (let attempt = 0; attempt <= MAX_UNSUPPORTED_PARAMETER_RETRIES; attempt += 1) {
      const response = await fetch(CODEX_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(codexBody),
        signal: stream ? undefined : AbortSignal.timeout(120000) // 2 min timeout for non-streaming
      });

      if (response.ok) {
        // For streaming, pass through the response
        if (stream) {
          return {
            ok: true,
            status: 200,
            retryable: false,
            response: new Response(response.body, {
              status: 200,
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
              }
            })
          };
        }

        // For non-streaming, pass through
        const responseText = await response.text();
        return {
          ok: true,
          status: 200,
          retryable: false,
          response: new Response(responseText, {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        };
      }

      const errorText = await response.text();
      const unsupportedParameters = extractUnsupportedParameters(errorText);
      let removedAnyUnsupportedParameter = false;
      for (const parameter of unsupportedParameters) {
        const normalized = parameter.toLowerCase();
        if (removedUnsupportedParameters.has(normalized)) continue;
        if (!removeUnsupportedParameter(codexBody, parameter)) continue;
        removedUnsupportedParameters.add(normalized);
        removedAnyUnsupportedParameter = true;
      }
      if (removedAnyUnsupportedParameter) {
        continue;
      }

      return {
        ok: false,
        status: response.status,
        retryable: isRetryableStatus(response.status),
        errorKind: 'provider_error',
        response: new Response(errorText, {
          status: response.status,
          headers: { 'Content-Type': 'application/json' }
        })
      };
    }

    return {
      ok: false,
      status: 400,
      retryable: false,
      errorKind: 'provider_error',
      response: new Response(JSON.stringify({
        detail: 'Codex request failed after removing unsupported parameters.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    };
  } catch (error) {
    // Handle timeout or network errors
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return {
        ok: false,
        status: 504,
        retryable: true,
        errorKind: 'timeout_error',
        response: new Response(JSON.stringify({
          type: 'error',
          error: {
            type: 'timeout_error',
            message: 'Codex API request timed out'
          }
        }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' }
        })
      };
    }
    
    return {
      ok: false,
      status: 503,
      retryable: true,
      errorKind: 'network_error',
      response: new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Codex API network error: ${error instanceof Error ? error.message : String(error)}`
        }
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      })
    };
  }
}

/**
 * Make a Claude Code OAuth API call.
 *
 * @param {Object} options - Call options
 * @returns {Promise<Object>} Call result
 */
async function makeClaudeCodeProviderCall({ provider, body, stream, accessToken }) {
  const apiBaseUrl = String(CLAUDE_CODE_OAUTH_CONFIG.apiBaseUrl || '').replace(/\/+$/, '');
  const messagesPath = String(CLAUDE_CODE_OAUTH_CONFIG.messagesPath || '/v1/messages?beta=true');
  const endpoint = `${apiBaseUrl}${messagesPath.startsWith('/') ? messagesPath : `/${messagesPath}`}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'anthropic-beta': CLAUDE_CODE_OAUTH_CONFIG.oauthBeta,
    'anthropic-version': provider?.anthropicVersion || '2023-06-01',
    ...(provider.headers || {})
  };
  const claudeBody = {
    ...(body || {}),
    stream: Boolean(stream)
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(claudeBody),
      signal: stream ? undefined : AbortSignal.timeout(120000)
    });

    if (response.ok) {
      if (stream) {
        return {
          ok: true,
          status: 200,
          retryable: false,
          subscriptionType: SUBSCRIPTION_TYPES.CLAUDE_CODE,
          response: new Response(response.body, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            }
          })
        };
      }

      const responseText = await response.text();
      return {
        ok: true,
        status: 200,
        retryable: false,
        subscriptionType: SUBSCRIPTION_TYPES.CLAUDE_CODE,
        response: new Response(responseText, {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      };
    }

    const errorText = await response.text();
    return {
      ok: false,
      status: response.status,
      retryable: isRetryableStatus(response.status),
      errorKind: 'provider_error',
      subscriptionType: SUBSCRIPTION_TYPES.CLAUDE_CODE,
      response: new Response(errorText, {
        status: response.status,
        headers: { 'Content-Type': 'application/json' }
      })
    };
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return {
        ok: false,
        status: 504,
        retryable: true,
        errorKind: 'timeout_error',
        subscriptionType: SUBSCRIPTION_TYPES.CLAUDE_CODE,
        response: new Response(JSON.stringify({
          type: 'error',
          error: {
            type: 'timeout_error',
            message: 'Claude Code OAuth API request timed out'
          }
        }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' }
        })
      };
    }

    return {
      ok: false,
      status: 503,
      retryable: true,
      errorKind: 'network_error',
      subscriptionType: SUBSCRIPTION_TYPES.CLAUDE_CODE,
      response: new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Claude Code OAuth API network error: ${error instanceof Error ? error.message : String(error)}`
        }
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      })
    };
  }
}

/**
 * Check if an HTTP status is retryable.
 * 
 * @param {number} status - HTTP status code
 * @returns {boolean} True if status is retryable
 */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

function stripCodexTokenLimitFields(body) {
  if (!body || typeof body !== 'object') return;
  delete body.max_tokens;
  delete body.max_output_tokens;
  delete body.max_completion_tokens;
}

function extractUnsupportedParameters(errorText) {
  const detail = extractErrorDetail(errorText);
  if (!detail) return [];
  const matches = [];
  let match = UNSUPPORTED_PARAMETER_PATTERN.exec(detail);
  while (match) {
    const name = String(match[1] || '').trim();
    if (name) matches.push(name);
    match = UNSUPPORTED_PARAMETER_PATTERN.exec(detail);
  }
  UNSUPPORTED_PARAMETER_PATTERN.lastIndex = 0;
  return [...new Set(matches)];
}

function extractErrorDetail(errorText) {
  const raw = String(errorText || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim();
    if (typeof parsed?.error?.message === 'string' && parsed.error.message.trim()) return parsed.error.message.trim();
    if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // keep raw payload if not JSON
  }
  return raw;
}

function removeUnsupportedParameter(body, parameterPath) {
  const normalizedPath = String(parameterPath || '').trim();
  if (!normalizedPath || !body || typeof body !== 'object') return false;

  if (Object.prototype.hasOwnProperty.call(body, normalizedPath)) {
    delete body[normalizedPath];
    return true;
  }

  const parts = normalizedPath
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  if (parts.length < 2) {
    return removeKeysRecursively(body, normalizedPath);
  }

  let node = body;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const segment = parts[index];
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, segment)) {
      return false;
    }
    node = node[segment];
  }

  const leaf = parts[parts.length - 1];
  if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, leaf)) {
    return removeKeysRecursively(body, leaf);
  }
  delete node[leaf];
  return true;
}

function removeKeysRecursively(node, targetKey) {
  if (!node || typeof node !== 'object') return false;
  let removed = false;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (removeKeysRecursively(item, targetKey)) {
        removed = true;
      }
    }
    return removed;
  }

  for (const key of Object.keys(node)) {
    if (key === targetKey) {
      delete node[key];
      removed = true;
      continue;
    }
    if (removeKeysRecursively(node[key], targetKey)) {
      removed = true;
    }
  }
  return removed;
}

/**
 * Login to a subscription provider.
 * 
 * @param {string} profileId - Profile ID
 * @param {Object} options - Login options
 * @param {boolean} [options.deviceCode=false] - Use device code flow
 * @param {function} [options.onUrl] - Callback for browser URL
 * @param {function} [options.onCode] - Callback for device code
 * @returns {Promise<boolean>} Success status
 */
export async function loginSubscription(profileId, options = {}) {
  if (options.deviceCode) {
    return loginWithDeviceCode(profileId, {
      subscriptionType: options.subscriptionType,
      onCode: options.onCode
    });
  }
  
  return loginWithBrowser(profileId, {
    subscriptionType: options.subscriptionType,
    onUrl: options.onUrl
  });
}

/**
 * Logout from a subscription provider.
 * 
 * @param {string} profileId - Profile ID
 * @param {Object} [options] - Options
 * @param {string} [options.subscriptionType] - Subscription type
 */
export async function logoutSubscription(profileId, options = {}) {
  await logout(profileId, {
    subscriptionType: options.subscriptionType || SUBSCRIPTION_TYPES.CHATGPT_CODEX
  });
}

/**
 * Get authentication status for a subscription profile.
 * 
 * @param {string} profileId - Profile ID
 * @param {Object} [options] - Options
 * @param {string} [options.subscriptionType] - Subscription type
 * @returns {Promise<Object>} Status object
 */
export async function getSubscriptionStatus(profileId, options = {}) {
  return getAuthStatus(profileId, {
    subscriptionType: options.subscriptionType || SUBSCRIPTION_TYPES.CHATGPT_CODEX
  });
}

/**
 * Build headers for subscription provider (used by config.js).
 * Subscription providers use Bearer token auth.
 * 
 * @param {Object} provider - Provider config
 * @param {string} accessToken - OAuth access token
 * @returns {Object} Headers object
 */
export function buildSubscriptionProviderHeaders(provider, accessToken) {
  const subType = provider?.subscriptionType || provider?.subscription_type;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    ...(provider.headers || {})
  };
  if (subType === SUBSCRIPTION_TYPES.CLAUDE_CODE) {
    headers['anthropic-beta'] = CLAUDE_CODE_OAUTH_CONFIG.oauthBeta;
    headers['anthropic-version'] = provider?.anthropicVersion || '2023-06-01';
  }
  return headers;
}

/**
 * Get the target format for a subscription provider.
 * Target format depends on subscription provider type.
 * 
 * @param {Object} provider - Provider config
 * @param {string} sourceFormat - Source format
 * @returns {string} Target format
 */
export function resolveSubscriptionProviderFormat(provider, sourceFormat) {
  void sourceFormat;
  const subType = provider?.subscriptionType || provider?.subscription_type;
  if (subType === SUBSCRIPTION_TYPES.CLAUDE_CODE) {
    return FORMATS.CLAUDE;
  }
  return FORMATS.OPENAI;
}

// Re-export for convenience
export {
  CODEX_SUBSCRIPTION_MODELS,
  CODEX_OAUTH_CONFIG,
  CLAUDE_CODE_SUBSCRIPTION_MODELS,
  CLAUDE_CODE_OAUTH_CONFIG
} from './subscription-constants.js';
