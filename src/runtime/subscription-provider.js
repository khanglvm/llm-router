/**
 * Subscription provider handler.
 * Integrates OAuth-based subscription accounts into the provider system.
 */

import { getValidAccessToken, loginWithBrowser, loginWithDeviceCode, logout, getAuthStatus } from './subscription-auth.js';
import { CODEX_SUBSCRIPTION_MODELS, CODEX_OAUTH_CONFIG } from './subscription-constants.js';
import {
  transformRequestForCodex,
  buildCodexHeaders,
  CODEX_ENDPOINT,
  isCodexModel,
  mapCodexVariant
} from './codex-request-transformer.js';
import { FORMATS } from '../translator/index.js';

/**
 * Subscription provider types.
 */
export const SUBSCRIPTION_TYPES = {
  CHATGPT_CODEX: 'chatgpt-codex'
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
 * @param {Object} options.body - Request body
 * @param {string} options.sourceFormat - Source format (openai/claude)
 * @param {boolean} options.stream - Whether streaming is enabled
 * @param {Object} [options.env] - Environment variables
 * @returns {Promise<Object>} Call result with ok, status, response
 */
export async function makeSubscriptionProviderCall({ provider, body, sourceFormat, stream, env }) {
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
    accessToken = await getValidAccessToken(profileId);
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
    return makeCodexProviderCall({ provider, body, sourceFormat, stream, accessToken, env });
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
async function makeCodexProviderCall({ provider, body, sourceFormat, stream, accessToken, env }) {
  // Transform request for Codex backend
  const codexBody = transformRequestForCodex(body);
  
  // Apply variant settings if specified in model config
  const modelConfig = (provider.models || []).find(m => m.id === body.model);
  if (modelConfig?.variant) {
    Object.assign(codexBody, mapCodexVariant(modelConfig.variant));
  }
  
  // Build headers
  const headers = buildCodexHeaders(accessToken, provider.headers || {});
  
  // Make the request
  try {
    const response = await fetch(CODEX_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(codexBody),
      signal: stream ? null : AbortSignal.timeout(120000) // 2 min timeout for non-streaming
    });
    
    if (!response.ok) {
      const errorText = await response.text();
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
 * Check if an HTTP status is retryable.
 * 
 * @param {number} status - HTTP status code
 * @returns {boolean} True if status is retryable
 */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
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
      onCode: options.onCode
    });
  }
  
  return loginWithBrowser(profileId, {
    onUrl: options.onUrl
  });
}

/**
 * Logout from a subscription provider.
 * 
 * @param {string} profileId - Profile ID
 */
export async function logoutSubscription(profileId) {
  await logout(profileId);
}

/**
 * Get authentication status for a subscription profile.
 * 
 * @param {string} profileId - Profile ID
 * @returns {Promise<Object>} Status object
 */
export async function getSubscriptionStatus(profileId) {
  return getAuthStatus(profileId);
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
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    ...(provider.headers || {})
  };
}

/**
 * Get the target format for a subscription provider.
 * Subscription providers always use OpenAI format.
 * 
 * @param {Object} provider - Provider config
 * @param {string} sourceFormat - Source format
 * @returns {string} Target format
 */
export function resolveSubscriptionProviderFormat(provider, sourceFormat) {
  // Subscription providers use OpenAI format internally
  return FORMATS.OPENAI;
}

// Re-export for convenience
export { CODEX_SUBSCRIPTION_MODELS, CODEX_OAUTH_CONFIG } from './subscription-constants.js';
