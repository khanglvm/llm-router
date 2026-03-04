/**
 * Codex API request transformer.
 * Transforms OpenAI-format requests to ChatGPT Codex backend format.
 */

/**
 * Codex backend endpoint.
 */
export const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_CODEX_INSTRUCTIONS = 'You are a helpful assistant.';
const CODEX_REASONING_INCLUDE = 'reasoning.encrypted_content';

/**
 * Transform a request body for Codex backend.
 * 
 * Codex requires:
 * - store: false
 * - Responses API payload shape (`input`, not top-level `messages`)
 * - stream: true
 * - No chat-completions token fields (`max_tokens`, `max_output_tokens`, etc)
 * 
 * @param {Object} body - OpenAI-format request body
 * @returns {Object} Transformed body for Codex backend
 */
export function transformRequestForCodex(body) {
  const transformed = (body && typeof body === 'object' && !Array.isArray(body))
    ? { ...body }
    : {};

  const instructions = typeof transformed.instructions === 'string'
    ? transformed.instructions.trim()
    : '';
  const reasoning = normalizeReasoningConfig(transformed.reasoning, transformed.reasoning_effort);
  const include = normalizeIncludeList(transformed.include, reasoning);
  const input = resolveResponseInput(transformed);
  const tools = Array.isArray(transformed.tools)
    ? transformed.tools.map(normalizeToolDefinitionForResponses).filter(Boolean)
    : [];

  const output = {
    model: transformed.model,
    instructions: instructions || DEFAULT_CODEX_INSTRUCTIONS,
    input,
    tools,
    tool_choice: normalizeToolChoiceForResponses(transformed.tool_choice),
    parallel_tool_calls: Boolean(transformed.parallel_tool_calls),
    store: false,
    stream: true,
    include
  };

  if (reasoning) {
    output.reasoning = reasoning;
  }
  if (typeof transformed.service_tier === 'string' && transformed.service_tier.trim()) {
    output.service_tier = transformed.service_tier.trim();
  }
  if (typeof transformed.prompt_cache_key === 'string' && transformed.prompt_cache_key.trim()) {
    output.prompt_cache_key = transformed.prompt_cache_key.trim();
  }
  if (transformed.text && typeof transformed.text === 'object' && !Array.isArray(transformed.text)) {
    output.text = transformed.text;
  }
  return output;
}

function hasUsableInput(input) {
  return Array.isArray(input) && input.length > 0;
}

function resolveResponseInput(transformed) {
  if (hasUsableInput(transformed.input)) return transformed.input;
  if (typeof transformed.input === 'string' && transformed.input.trim()) {
    return [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: transformed.input.trim() }]
    }];
  }
  if (Array.isArray(transformed.messages)) {
    return convertMessagesToResponseInput(transformed.messages);
  }
  return [];
}

function normalizeIncludeList(rawInclude, reasoning) {
  const include = Array.isArray(rawInclude)
    ? rawInclude.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (reasoning && !include.includes(CODEX_REASONING_INCLUDE)) {
    include.push(CODEX_REASONING_INCLUDE);
  }
  return [...new Set(include)];
}

function normalizeReasoningConfig(reasoning, reasoningEffort) {
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const effort = typeof reasoning.effort === 'string' ? reasoning.effort.trim() : '';
    const next = {
      ...reasoning
    };
    if (effort) {
      next.effort = effort;
    }
    return next;
  }

  if (typeof reasoningEffort === 'string' && reasoningEffort.trim()) {
    return {
      effort: reasoningEffort.trim()
    };
  }
  return undefined;
}

function safeStringify(value, fallback = '') {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return safeStringify(value, '');
}

function normalizeMessageContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if ((part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
        textParts.push(part.text);
      }
    }
    if (textParts.length > 0) return textParts.join('\n');
    return safeStringify(content, '');
  }
  return normalizeText(content);
}

function normalizeMessageRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'assistant' || normalized === 'system' || normalized === 'developer' || normalized === 'user') {
    return normalized;
  }
  return 'user';
}

function normalizeInputMessageContent(content) {
  if (typeof content === 'string') {
    return content
      ? [{ type: 'input_text', text: content }]
      : [];
  }

  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;

    if ((part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
      parts.push({
        type: 'input_text',
        text: part.text
      });
      continue;
    }

    if (part.type === 'image_url' || part.type === 'input_image') {
      const rawUrl = typeof part.image_url === 'string'
        ? part.image_url
        : part.image_url?.url;
      if (typeof rawUrl === 'string' && rawUrl.trim()) {
        parts.push({
          type: 'input_image',
          image_url: rawUrl
        });
      }
      continue;
    }
  }

  return parts;
}

function normalizeToolCallArguments(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '{}';
  return safeStringify(value, '{}');
}

function convertToolMessageToResponseInput(message) {
  const callId = typeof message?.tool_call_id === 'string'
    ? message.tool_call_id.trim()
    : '';
  if (!callId) return null;
  return {
    type: 'function_call_output',
    call_id: callId,
    output: normalizeMessageContentToText(message.content)
  };
}

function convertToolCallsToResponseInputItems(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const items = [];

  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = toolCalls[index];
    if (!toolCall || typeof toolCall !== 'object') continue;
    const functionName = String(toolCall.function?.name || toolCall.name || `tool_${index + 1}`).trim();
    if (!functionName) continue;
    const callId = String(toolCall.id || `call_${index + 1}`).trim();
    const args = toolCall.function?.arguments ?? toolCall.arguments;
    items.push({
      type: 'function_call',
      call_id: callId,
      name: functionName,
      arguments: normalizeToolCallArguments(args)
    });
  }

  return items;
}

function convertMessagesToResponseInput(messages) {
  const items = [];

  for (const message of messages) {
    const normalizedMessage = stripMessageIds(message);
    if (!normalizedMessage || typeof normalizedMessage !== 'object') continue;

    if (normalizedMessage.role === 'tool') {
      const toolOutput = convertToolMessageToResponseInput(normalizedMessage);
      if (toolOutput) items.push(toolOutput);
      continue;
    }

    const contentParts = normalizeInputMessageContent(normalizedMessage.content);
    if (contentParts.length > 0) {
      items.push({
        type: 'message',
        role: normalizeMessageRole(normalizedMessage.role),
        content: contentParts
      });
    } else {
      const fallbackText = normalizeMessageContentToText(normalizedMessage.content);
      if (fallbackText) {
        items.push({
          type: 'message',
          role: normalizeMessageRole(normalizedMessage.role),
          content: [{ type: 'input_text', text: fallbackText }]
        });
      }
    }

    const toolCallItems = convertToolCallsToResponseInputItems(normalizedMessage.tool_calls);
    if (toolCallItems.length > 0) {
      items.push(...toolCallItems);
    }
  }

  return items;
}

function normalizeToolChoiceForResponses(toolChoice) {
  if (typeof toolChoice === 'string') {
    const normalized = toolChoice.trim().toLowerCase();
    if (normalized === 'none' || normalized === 'required' || normalized === 'auto') {
      return normalized;
    }
    return 'auto';
  }

  if (toolChoice && typeof toolChoice === 'object') {
    const normalizedType = String(toolChoice.type || '').trim().toLowerCase();
    if (normalizedType === 'none') return 'none';
    if (normalizedType === 'required' || normalizedType === 'any' || normalizedType === 'tool') {
      return 'required';
    }
  }

  return 'auto';
}

function normalizeToolDefinitionForResponses(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (tool.type !== 'function' || !tool.function || typeof tool.function !== 'object') {
    return tool;
  }

  const next = {
    type: 'function',
    name: String(tool.function.name || '').trim(),
    description: tool.function.description,
    parameters: tool.function.parameters
  };
  if (tool.function.strict !== undefined) {
    next.strict = tool.function.strict;
  }
  return next.name ? next : null;
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
    Accept: 'text/event-stream',
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
