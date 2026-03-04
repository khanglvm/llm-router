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
    const parsedBlock = parseSseBlock(block);
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

function eventToOpenAIChunks(event, state, { fallbackModel = 'unknown' } = {}) {
  if (!event || typeof event !== 'object') return [];
  const type = String(event.type || '').trim();
  const chunks = [];

  if (type === 'response.created' || type === 'response.in_progress' || type === 'response.output_item.done') {
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

  if (type === 'response.output_text.delta') {
    ensureAssistantRoleChunk(state, chunks);
    if (typeof event.item_id === 'string' && event.item_id.trim()) {
      state.textDeltaItemIds.add(event.item_id.trim());
    }
    chunks.push(makeOpenAIChunk(state, { content: String(event.delta || '') }, null));
    return chunks;
  }

  if (type === 'response.output_text.done') {
    const itemId = typeof event.item_id === 'string' ? event.item_id.trim() : '';
    if (itemId && !state.textDeltaItemIds.has(itemId) && typeof event.text === 'string' && event.text) {
      ensureAssistantRoleChunk(state, chunks);
      chunks.push(makeOpenAIChunk(state, { content: event.text }, null));
    }
    return chunks;
  }

  if (type === 'response.function_call_arguments.delta') {
    ensureAssistantRoleChunk(state, chunks);
    const toolIndex = resolveToolIndex(state, event);
    state.hasToolCalls = true;
    chunks.push(makeOpenAIChunk(state, {
      tool_calls: [
        {
          index: toolIndex,
          function: {
            arguments: String(event.delta || '')
          }
        }
      ]
    }, null));
    return chunks;
  }

  if (type === 'response.function_call_arguments.done') {
    ensureAssistantRoleChunk(state, chunks);
    const toolIndex = resolveToolIndex(state, event);
    state.hasToolCalls = true;
    chunks.push(makeOpenAIChunk(state, {
      tool_calls: [
        {
          index: toolIndex,
          function: {
            arguments: String(event.arguments || '')
          }
        }
      ]
    }, null));
    return chunks;
  }

  if (type === 'response.completed' || type === 'response.failed') {
    updateStateFromResponse(state, event.response, fallbackModel);
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
    textDeltaItemIds: new Set()
  };

  let buffer = '';

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');

      let boundaryIndex;
      while ((boundaryIndex = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        if (!block.trim()) continue;

        const parsedBlock = parseSseBlock(block);
        if (!parsedBlock.data) continue;

        if (parsedBlock.data === '[DONE]') {
          if (!state.doneSent) {
            state.doneSent = true;
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          }
          continue;
        }

        let payload;
        try {
          payload = JSON.parse(parsedBlock.data);
        } catch {
          continue;
        }

        const chunks = eventToOpenAIChunks(payload, state, { fallbackModel });
        for (const translated of chunks) {
          controller.enqueue(encoder.encode(serializeOpenAIChunk(translated)));
        }
      }
    },

    flush(controller) {
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
