/**
 * Codex Responses API -> OpenAI Chat Completions response transformer.
 */

import { withCorsHeaders } from './handler/http.js';

function ensureChatCompletionId(value) {
  const raw = String(value || '').trim();
  if (!raw) return `chatcmpl_${Date.now()}`;
  if (raw.startsWith('chatcmpl_')) return raw;
  return `chatcmpl_${raw}`;
}

function toOpenAIUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const promptTokens = Number.isFinite(usage.input_tokens) ? Number(usage.input_tokens) : 0;
  const completionTokens = Number.isFinite(usage.output_tokens) ? Number(usage.output_tokens) : 0;
  const totalTokens = Number.isFinite(usage.total_tokens)
    ? Number(usage.total_tokens)
    : (promptTokens + completionTokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens
  };
}

function inferFinishReason({ response, hasToolCalls = false } = {}) {
  if (hasToolCalls) return 'tool_calls';
  const reason = String(response?.incomplete_details?.reason || '').trim().toLowerCase();
  if (reason === 'max_output_tokens' || reason === 'max_tokens') return 'length';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

function extractAssistantMessage(response) {
  const outputItems = Array.isArray(response?.output) ? response.output : [];
  const textParts = [];
  const toolCalls = [];

  for (let index = 0; index < outputItems.length; index += 1) {
    const item = outputItems[index];
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
      for (const contentPart of item.content) {
        if (!contentPart || typeof contentPart !== 'object') continue;
        if (contentPart.type === 'output_text' && typeof contentPart.text === 'string') {
          textParts.push(contentPart.text);
          continue;
        }
        if (contentPart.type === 'refusal' && typeof contentPart.refusal === 'string') {
          textParts.push(contentPart.refusal);
        }
      }
      continue;
    }

    if (item.type === 'function_call') {
      toolCalls.push({
        id: String(item.call_id || item.id || `call_${index}`),
        type: 'function',
        function: {
          name: String(item.name || 'tool'),
          arguments: typeof item.arguments === 'string' ? item.arguments : ''
        }
      });
    }
  }

  const fallbackOutputText = typeof response?.output_text === 'string' ? response.output_text : '';
  const text = textParts.length > 0 ? textParts.join('') : fallbackOutputText;
  return {
    text,
    toolCalls
  };
}

export function convertCodexResponseToOpenAIChatCompletion(response, { fallbackModel = 'unknown' } = {}) {
  const assistant = extractAssistantMessage(response);
  const finishReason = inferFinishReason({
    response,
    hasToolCalls: assistant.toolCalls.length > 0
  });

  const message = {
    role: 'assistant',
    content: assistant.text.length > 0 ? assistant.text : null
  };
  if (assistant.toolCalls.length > 0) {
    message.tool_calls = assistant.toolCalls;
  }

  return {
    id: ensureChatCompletionId(response?.id),
    object: 'chat.completion',
    created: Number.isFinite(response?.created_at)
      ? Number(response.created_at)
      : Math.floor(Date.now() / 1000),
    model: response?.model || fallbackModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason
      }
    ],
    usage: toOpenAIUsage(response?.usage)
  };
}

function makeOpenAIChunk(state, delta = {}, finishReason = null, usage = undefined) {
  const chunk = {
    id: state.chatId,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model || 'unknown',
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

function ensureAssistantRoleChunk(state, chunks) {
  if (state.roleSent) return;
  state.roleSent = true;
  chunks.push(makeOpenAIChunk(state, { role: 'assistant' }, null));
}

function commonPrefixLength(left, right) {
  const leftText = typeof left === 'string' ? left : '';
  const rightText = typeof right === 'string' ? right : '';
  const limit = Math.min(leftText.length, rightText.length);
  let index = 0;

  while (index < limit && leftText[index] === rightText[index]) {
    index += 1;
  }

  return index;
}

function getMissingSuffix(emittedText, finalText) {
  const emitted = typeof emittedText === 'string' ? emittedText : '';
  const finalValue = typeof finalText === 'string' ? finalText : '';

  if (!finalValue) return '';
  if (!emitted) return finalValue;
  if (finalValue.startsWith(emitted)) {
    return finalValue.slice(emitted.length);
  }
  if (emitted.startsWith(finalValue)) {
    return '';
  }

  const prefixLength = commonPrefixLength(emitted, finalValue);
  if (prefixLength <= 0) return '';
  return finalValue.slice(prefixLength);
}

function parseStreamBlock(block) {
  const normalized = String(block || '').trim();
  if (!normalized) return null;
  if (!normalized.includes('data:') && !normalized.includes('event:')) {
    return {
      eventType: '',
      data: normalized
    };
  }
  return parseSseBlock(normalized);
}

function parseSseBlock(block) {
  let eventType = '';
  const dataLines = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return {
    eventType,
    data: dataLines.join('\n').trim()
  };
}

function extractCodexResponseFromEventPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.object === 'response') return payload;
  const eventType = String(payload.type || '').trim();
  if (
    (eventType === 'response.completed' || eventType === 'response.failed' || eventType === 'response.incomplete')
    && payload.response
    && typeof payload.response === 'object'
  ) {
    return payload.response;
  }
  return null;
}

export function extractCodexFinalResponseFromText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  try {
    const asJson = JSON.parse(text);
    const direct = extractCodexResponseFromEventPayload(asJson);
    if (direct) return direct;
  } catch {
    // Not plain JSON; continue as SSE.
  }

  const normalized = text.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  let latestResponse = null;

  for (const block of blocks) {
    if (!block || !block.trim()) continue;
    const parsedBlock = parseStreamBlock(block);
    if (!parsedBlock.data || parsedBlock.data === '[DONE]') continue;

    let payload;
    try {
      payload = JSON.parse(parsedBlock.data);
    } catch {
      continue;
    }
    const response = extractCodexResponseFromEventPayload(payload);
    if (response) {
      latestResponse = response;
    }
  }

  return latestResponse;
}

export async function extractCodexFinalResponse(response) {
  const raw = await response.text();
  return extractCodexFinalResponseFromText(raw);
}

function resolveToolIndex(state, event) {
  if (Number.isFinite(event?.output_index)) {
    const fromOutputIndex = state.toolCallByOutputIndex.get(Number(event.output_index));
    if (fromOutputIndex !== undefined) return fromOutputIndex;
  }
  if (typeof event?.item_id === 'string' && event.item_id.trim()) {
    const fromItemId = state.toolCallByItemId.get(event.item_id.trim());
    if (fromItemId !== undefined) return fromItemId;
  }
  const toolIndex = state.nextToolCallIndex;
  state.nextToolCallIndex += 1;
  if (Number.isFinite(event?.output_index)) {
    state.toolCallByOutputIndex.set(Number(event.output_index), toolIndex);
  }
  if (typeof event?.item_id === 'string' && event.item_id.trim()) {
    state.toolCallByItemId.set(event.item_id.trim(), toolIndex);
  }
  return toolIndex;
}

function updateStateFromResponse(state, response, fallbackModel) {
  if (!response || typeof response !== 'object') return;
  state.chatId = ensureChatCompletionId(response.id || state.chatId);
  if (Number.isFinite(response.created_at)) {
    state.created = Number(response.created_at);
  }
  if (typeof response.model === 'string' && response.model.trim()) {
    state.model = response.model;
  } else if (!state.model) {
    state.model = fallbackModel;
  }
}

function extractAssistantOutputText(item) {
  if (!item || item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) {
    return '';
  }

  const textParts = [];
  for (const contentPart of item.content) {
    if (!contentPart || typeof contentPart !== 'object') continue;
    if (contentPart.type === 'output_text' && typeof contentPart.text === 'string') {
      textParts.push(contentPart.text);
      continue;
    }
    if (contentPart.type === 'refusal' && typeof contentPart.refusal === 'string') {
      textParts.push(contentPart.refusal);
    }
  }

  return textParts.join('');
}

function emitFallbackTextChunk(state, item, chunks) {
  const text = extractAssistantOutputText(item);
  if (!text) return;

  const itemId = typeof item?.id === 'string' ? item.id.trim() : '';
  const missingText = itemId
    ? getMissingSuffix(state.textOutputByItemId.get(itemId) || '', text)
    : (state.hasTextOutput ? '' : text);
  if (!missingText) return;

  ensureAssistantRoleChunk(state, chunks);
  chunks.push(makeOpenAIChunk(state, { content: missingText }, null));
  if (itemId) {
    state.textOutputItemIds.add(itemId);
    state.textOutputByItemId.set(itemId, `${state.textOutputByItemId.get(itemId) || ''}${missingText}`);
  }
  state.hasTextOutput = true;
}

function emitFallbackToolCallChunks(state, item, outputIndex, chunks) {
  if (!item || item.type !== 'function_call') return;

  ensureAssistantRoleChunk(state, chunks);
  state.hasToolCalls = true;

  const toolIndex = resolveToolIndex(state, {
    output_index: outputIndex,
    item_id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined
  });

  if (!state.toolCallStartSentByIndex.has(toolIndex)) {
    chunks.push(makeOpenAIChunk(state, {
      tool_calls: [
        {
          index: toolIndex,
          id: String(item.call_id || item.id || `call_${toolIndex}`),
          type: 'function',
          function: {
            name: String(item.name || 'tool'),
            arguments: ''
          }
        }
      ]
    }, null));
    state.toolCallStartSentByIndex.add(toolIndex);
  }

  const argumentsText = typeof item.arguments === 'string' ? item.arguments : '';
  const missingArguments = getMissingSuffix(state.toolCallArgumentsByIndex.get(toolIndex) || '', argumentsText);
  if (missingArguments) {
    chunks.push(makeOpenAIChunk(state, {
      tool_calls: [
        {
          index: toolIndex,
          function: {
            arguments: missingArguments
          }
        }
      ]
    }, null));
    state.toolCallArgumentsSeenByIndex.add(toolIndex);
    state.toolCallArgumentsByIndex.set(toolIndex, `${state.toolCallArgumentsByIndex.get(toolIndex) || ''}${missingArguments}`);
  }
}

function emitResponseOutputFallbacks(state, response, chunks) {
  const outputItems = Array.isArray(response?.output) ? response.output : [];
  for (let index = 0; index < outputItems.length; index += 1) {
    const item = outputItems[index];
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message' && item.role === 'assistant') {
      emitFallbackTextChunk(state, item, chunks);
      continue;
    }

    if (item.type === 'function_call') {
      emitFallbackToolCallChunks(state, item, index, chunks);
    }
  }
}

function eventToOpenAIChunks(event, state, { fallbackModel = 'unknown' } = {}) {
  if (!event || typeof event !== 'object') return [];
  const type = String(event.type || '').trim();
  const chunks = [];

  if (type === 'response.created' || type === 'response.in_progress') {
    updateStateFromResponse(state, event.response, fallbackModel);
    return chunks;
  }

  if (type === 'response.output_item.added') {
    updateStateFromResponse(state, event.response, fallbackModel);
    const item = event.item;
    if (!item || typeof item !== 'object') return chunks;
    if (item.type === 'function_call') {
      ensureAssistantRoleChunk(state, chunks);
      const toolIndex = resolveToolIndex(state, event);
      state.hasToolCalls = true;
      state.toolCallStartSentByIndex.add(toolIndex);
      chunks.push(makeOpenAIChunk(state, {
        tool_calls: [
          {
            index: toolIndex,
            id: String(item.call_id || item.id || `call_${toolIndex}`),
            type: 'function',
            function: {
              name: String(item.name || 'tool'),
              arguments: ''
            }
          }
        ]
      }, null));
      return chunks;
    }
    if (item.type === 'message') {
      ensureAssistantRoleChunk(state, chunks);
    }
    return chunks;
  }

  if (type === 'response.reasoning_summary_text.delta') {
    ensureAssistantRoleChunk(state, chunks);
    chunks.push(makeOpenAIChunk(state, { reasoning_content: String(event.delta || '') }, null));
    return chunks;
  }

  if (type === 'response.reasoning_summary_text.done') {
    if (typeof event.text === 'string' && event.text) {
      ensureAssistantRoleChunk(state, chunks);
      chunks.push(makeOpenAIChunk(state, { reasoning_content: event.text }, null));
    }
    return chunks;
  }

  if (type === 'response.output_text.delta') {
    const deltaText = String(event.delta || '');
    if (!deltaText) return chunks;
    ensureAssistantRoleChunk(state, chunks);
    if (typeof event.item_id === 'string' && event.item_id.trim()) {
      const itemId = event.item_id.trim();
      state.textOutputItemIds.add(itemId);
      state.textOutputByItemId.set(itemId, `${state.textOutputByItemId.get(itemId) || ''}${deltaText}`);
    }
    state.hasTextOutput = true;
    chunks.push(makeOpenAIChunk(state, { content: deltaText }, null));
    return chunks;
  }

  if (type === 'response.output_text.done') {
    const itemId = typeof event.item_id === 'string' ? event.item_id.trim() : '';
    const finalText = typeof event.text === 'string' ? event.text : '';
    const missingText = itemId
      ? getMissingSuffix(state.textOutputByItemId.get(itemId) || '', finalText)
      : (state.hasTextOutput ? '' : finalText);
    if (missingText) {
      ensureAssistantRoleChunk(state, chunks);
      chunks.push(makeOpenAIChunk(state, { content: missingText }, null));
      if (itemId) {
        state.textOutputItemIds.add(itemId);
        state.textOutputByItemId.set(itemId, `${state.textOutputByItemId.get(itemId) || ''}${missingText}`);
      }
      state.hasTextOutput = true;
    }
    return chunks;
  }

  if (type === 'response.content_part.done') {
    const itemId = typeof event.item_id === 'string' ? event.item_id.trim() : '';
    const finalText = event.part?.type === 'output_text' && typeof event.part?.text === 'string'
      ? event.part.text
      : '';
    const missingText = itemId
      ? getMissingSuffix(state.textOutputByItemId.get(itemId) || '', finalText)
      : (state.hasTextOutput ? '' : finalText);
    if (!missingText) return chunks;
    ensureAssistantRoleChunk(state, chunks);
    chunks.push(makeOpenAIChunk(state, { content: missingText }, null));
    if (itemId) {
      state.textOutputItemIds.add(itemId);
      state.textOutputByItemId.set(itemId, `${state.textOutputByItemId.get(itemId) || ''}${missingText}`);
    }
    state.hasTextOutput = true;
    return chunks;
  }

  if (type === 'response.function_call_arguments.delta') {
    const deltaArguments = String(event.delta || '');
    if (!deltaArguments) return chunks;
    ensureAssistantRoleChunk(state, chunks);
    const toolIndex = resolveToolIndex(state, event);
    state.hasToolCalls = true;
    state.toolCallArgumentsSeenByIndex.add(toolIndex);
    state.toolCallArgumentsByIndex.set(toolIndex, `${state.toolCallArgumentsByIndex.get(toolIndex) || ''}${deltaArguments}`);
    chunks.push(makeOpenAIChunk(state, {
      tool_calls: [
        {
          index: toolIndex,
          function: {
            arguments: deltaArguments
          }
        }
      ]
    }, null));
    return chunks;
  }

  if (type === 'response.function_call_arguments.done') {
    const toolIndex = resolveToolIndex(state, event);
    const finalArguments = String(event.arguments || '');
    const missingArguments = getMissingSuffix(state.toolCallArgumentsByIndex.get(toolIndex) || '', finalArguments);
    if (!missingArguments) return chunks;
    ensureAssistantRoleChunk(state, chunks);
    state.hasToolCalls = true;
    state.toolCallArgumentsSeenByIndex.add(toolIndex);
    state.toolCallArgumentsByIndex.set(toolIndex, `${state.toolCallArgumentsByIndex.get(toolIndex) || ''}${missingArguments}`);
    chunks.push(makeOpenAIChunk(state, {
      tool_calls: [
        {
          index: toolIndex,
          function: {
            arguments: missingArguments
          }
        }
      ]
    }, null));
    return chunks;
  }

  if (type === 'response.output_item.done') {
    updateStateFromResponse(state, event.response, fallbackModel);
    const item = event.item;
    if (!item || typeof item !== 'object') return chunks;

    if (item.type === 'message' && item.role === 'assistant') {
      emitFallbackTextChunk(state, item, chunks);
      return chunks;
    }

    if (item.type === 'function_call') {
      emitFallbackToolCallChunks(state, item, Number.isFinite(event.output_index) ? Number(event.output_index) : 0, chunks);
    }

    return chunks;
  }

  if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
    updateStateFromResponse(state, event.response, fallbackModel);
    emitResponseOutputFallbacks(state, event.response, chunks);
    ensureAssistantRoleChunk(state, chunks);
    const responseUsage = toOpenAIUsage(event.response?.usage);
    const hasResponseToolCalls = Array.isArray(event.response?.output)
      ? event.response.output.some((item) => item?.type === 'function_call')
      : false;
    const finishReason = inferFinishReason({
      response: event.response,
      hasToolCalls: state.hasToolCalls || hasResponseToolCalls
    });
    chunks.push(makeOpenAIChunk(state, {}, finishReason, responseUsage));
    chunks.push('[DONE]');
    state.doneSent = true;
    return chunks;
  }

  return chunks;
}

function serializeOpenAIChunk(chunk) {
  if (chunk === '[DONE]') return 'data: [DONE]\n\n';
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function handleCodexStreamToOpenAI(response, { fallbackModel = 'unknown' } = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = {
    chatId: ensureChatCompletionId(''),
    created: Math.floor(Date.now() / 1000),
    model: fallbackModel || 'unknown',
    roleSent: false,
    doneSent: false,
    hasToolCalls: false,
    toolCallByOutputIndex: new Map(),
    toolCallByItemId: new Map(),
    nextToolCallIndex: 0,
    toolCallStartSentByIndex: new Set(),
    toolCallArgumentsSeenByIndex: new Set(),
    toolCallArgumentsByIndex: new Map(),
    textOutputItemIds: new Set(),
    textOutputByItemId: new Map(),
    hasTextOutput: false
  };

  let buffer = '';

  function processBlock(block, controller) {
    if (!block || !block.trim()) return;

    const parsedBlock = parseStreamBlock(block);
    if (!parsedBlock.data) return;

    if (parsedBlock.data === '[DONE]') {
      if (!state.doneSent) {
        state.doneSent = true;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      }
      return;
    }

    let payload;
    try {
      payload = JSON.parse(parsedBlock.data);
    } catch {
      return;
    }

    const chunks = eventToOpenAIChunks(payload, state, { fallbackModel });
    for (const translated of chunks) {
      controller.enqueue(encoder.encode(serializeOpenAIChunk(translated)));
    }
  }

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');

      let boundaryIndex;
      while ((boundaryIndex = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        processBlock(block, controller);
      }
    },

    flush(controller) {
      const remainder = buffer.trim();
      if (remainder) {
        processBlock(remainder, controller);
      }
      if (state.doneSent) return;
      if (!state.roleSent) {
        controller.enqueue(encoder.encode(serializeOpenAIChunk(makeOpenAIChunk(state, { role: 'assistant' }, null))));
      }
      const finishReason = state.hasToolCalls ? 'tool_calls' : 'stop';
      controller.enqueue(encoder.encode(serializeOpenAIChunk(makeOpenAIChunk(state, {}, finishReason))));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      state.doneSent = true;
    }
  });

  return new Response(response.body.pipeThrough(transformStream), {
    status: 200,
    headers: withCorsHeaders({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
  });
}
