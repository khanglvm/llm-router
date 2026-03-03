/**
 * Codex API request transformer.
 * Transforms OpenAI-format requests to ChatGPT Codex backend format.
 */

/**
 * Codex backend endpoint.
 */
export const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

/**
 * Transform a request body for Codex backend.
 * 
 * Codex requires:
 * - store: false
 * - No message IDs (strip id fields from messages)
 * - include: ["reasoning.encrypted_content"]
 * 
 * @param {Object} body - OpenAI-format request body
 * @returns {Object} Transformed body for Codex backend
 */
export function transformRequestForCodex(body) {
  const transformed = { ...body };
  
  // Set store: false (Codex doesn't support storage)
  transformed.store = false;
  
  // Add include for encrypted reasoning content
  transformed.include = ['reasoning.encrypted_content'];
  
  // Strip message IDs from messages array
  if (Array.isArray(transformed.messages)) {
    transformed.messages = transformed.messages.map(stripMessageIds);
  }
  
  // Handle tools - strip IDs from tool calls in messages
  if (Array.isArray(transformed.messages)) {
    transformed.messages = transformed.messages.map(message => {
      if (Array.isArray(message.tool_calls)) {
        return {
          ...message,
          tool_calls: message.tool_calls.map(toolCall => ({
            id: toolCall.id,
            type: toolCall.type || 'function',
            function: toolCall.function
          }))
        };
      }
      return message;
    });
  }
  
  return transformed;
}

/**
 * Strip ID fields from a message object.
 * Preserves role, content, and other essential fields.
 * 
 * @param {Object} message - Message object
 * @returns {Object} Message without ID fields
 */
function stripMessageIds(message) {
  if (!message || typeof message !== 'object') {
    return message;
  }
  
  const { id, _id, ...rest } = message;
  return rest;
}

/**
 * Build headers for Codex API request.
 * 
 * @param {string} accessToken - OAuth access token
 * @param {Object} [customHeaders={}] - Additional headers to include
 * @returns {Object} Headers object
 */
export function buildCodexHeaders(accessToken, customHeaders = {}) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    ...customHeaders
  };
}

/**
 * Check if a model ID is a Codex subscription model.
 * 
 * @param {string} modelId - Model ID to check
 * @param {string[]} codexModels - List of known Codex models
 * @returns {boolean} True if model is a Codex model
 */
export function isCodexModel(modelId, codexModels = []) {
  if (!modelId) return false;
  
  // Check against known Codex models
  if (codexModels.includes(modelId)) return true;
  
  // Also check for -codex suffix pattern
  if (modelId.endsWith('-codex')) return true;
  
  return false;
}

/**
 * Map variant to Codex model parameters.
 * 
 * @param {string} variant - Variant name (e.g., 'high', 'low')
 * @returns {Object} Variant parameters
 */
export function mapCodexVariant(variant) {
  const variantMap = {
    'high': { reasoning_effort: 'high' },
    'medium': { reasoning_effort: 'medium' },
    'low': { reasoning_effort: 'low' }
  };
  
  return variantMap[variant?.toLowerCase()] || {};
}
