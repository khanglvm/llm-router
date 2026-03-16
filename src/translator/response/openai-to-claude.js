/**
 * OpenAI -> Claude (Anthropic) Response Translator
 */

import { FORMATS } from "../formats.js";

/**
 * Convert OpenAI stream chunk to Claude format
 */
export function openaiToClaudeResponse(chunk, state) {
  if (!chunk || !chunk.choices?.[0]) return null;

  const results = [];
  const choice = chunk.choices[0];
  const delta = choice.delta;

  // Track usage
  if (chunk.usage && typeof chunk.usage === "object") {
    const promptTokens = chunk.usage.prompt_tokens || 0;
    const outputTokens = chunk.usage.completion_tokens || 0;
    
    state.usage = {
      input_tokens: promptTokens,
      output_tokens: outputTokens
    };
  }

  // First chunk - send message_start
  ensureMessageStart(state, results, chunk);

  // Handle thinking/reasoning content
  const reasoningContent = delta?.reasoning_content || delta?.reasoning;
  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: "thinking", thinking: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent }
    });
  }

  // Handle regular content
  const textDelta = normalizeTextDelta(delta?.content);
  if (textDelta && (state.textBlockStarted || hasRenderableText(textDelta))) {
    stopThinkingBlock(state, results);

    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: "text", text: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: textDelta }
    });
  }

  // Tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      const toolInfo = ensureToolUseBlock(state, results, idx, {
        id: tc.id,
        name: tc.function?.name
      });

      if (tc.function?.arguments) {
        if (toolInfo) {
          results.push({
            type: "content_block_delta",
            index: toolInfo.blockIndex,
            delta: { type: "input_json_delta", partial_json: tc.function.arguments }
          });
        }
      }
    }
  }

  if (delta?.function_call && typeof delta.function_call === "object") {
    const toolInfo = ensureToolUseBlock(state, results, 0, {
      id: delta.function_call.id,
      name: delta.function_call.name
    });
    if (toolInfo && delta.function_call.arguments) {
      results.push({
        type: "content_block_delta",
        index: toolInfo.blockIndex,
        delta: { type: "input_json_delta", partial_json: delta.function_call.arguments }
      });
    }
  }

  emitFinalChoiceMessageFallback(choice?.message, state, results);

  // Finish
  if (choice.finish_reason) {
    state.finishReason = choice.finish_reason;
    results.push(...finalizeOpenAIToClaudeStream(state));
  }

  return results.length > 0 ? results : null;
}

function hasRenderableText(text) {
  return typeof text === "string" && /\S/.test(text);
}

function normalizeTextDelta(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if ((part.type === "text" || part.type === "output_text") && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function ensureToolUseBlock(state, results, index, { id, name } = {}) {
  if (!state?.toolCalls || !(state.toolCalls instanceof Map)) return null;
  const normalizedIndex = Number.isFinite(index) ? Number(index) : 0;
  const existing = state.toolCalls.get(normalizedIndex);
  if (existing) return existing;

  const toolName = typeof name === "string" && name.trim() ? name.trim() : "tool";
  const toolId = typeof id === "string" && id.trim()
    ? id.trim()
    : `tool_${state.messageId || "call"}_${normalizedIndex}`;

  stopThinkingBlock(state, results);
  stopTextBlock(state, results);

  const toolBlockIndex = state.nextBlockIndex++;
  const toolInfo = {
    id: toolId,
    name: toolName,
    blockIndex: toolBlockIndex,
    closed: false
  };
  state.toolCalls.set(normalizedIndex, toolInfo);

  results.push({
    type: "content_block_start",
    index: toolBlockIndex,
    content_block: {
      type: "tool_use",
      id: toolId,
      name: toolName,
      input: {}
    }
  });

  return toolInfo;
}

function normalizeMessageToolCalls(message) {
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.filter((call) => call && typeof call === "object")
    : [];

  if (message?.function_call && typeof message.function_call === "object") {
    toolCalls.push({
      id: message.function_call.id,
      function: {
        name: message.function_call.name,
        arguments: message.function_call.arguments
      }
    });
  }

  return toolCalls;
}

function emitTextDelta(text, state, results) {
  if (!text) return;
  if (!state.textBlockStarted && !hasRenderableText(text)) return;
  stopThinkingBlock(state, results);

  if (!state.textBlockStarted) {
    state.textBlockIndex = state.nextBlockIndex++;
    state.textBlockStarted = true;
    state.textBlockClosed = false;
    results.push({
      type: "content_block_start",
      index: state.textBlockIndex,
      content_block: { type: "text", text: "" }
    });
  }

  results.push({
    type: "content_block_delta",
    index: state.textBlockIndex,
    delta: { type: "text_delta", text }
  });
}

function emitFinalChoiceMessageFallback(message, state, results) {
  if (!message || typeof message !== "object") return;

  const hasTextOutput = state.textBlockStarted || state.textBlockClosed;
  if (!hasTextOutput) {
    const fallbackText = normalizeTextDelta(message.content)
      || (typeof message.refusal === "string" ? message.refusal : "");
    emitTextDelta(fallbackText, state, results);
  }

  const hasToolOutput = state.toolCalls instanceof Map && state.toolCalls.size > 0;
  if (hasToolOutput) return;

  const toolCalls = normalizeMessageToolCalls(message);
  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = toolCalls[index];
    if (!toolCall || typeof toolCall !== "object") continue;
    const toolInfo = ensureToolUseBlock(state, results, toolCall.index ?? index, {
      id: toolCall.id,
      name: toolCall.function?.name
    });
    if (toolInfo && toolCall.function?.arguments) {
      results.push({
        type: "content_block_delta",
        index: toolInfo.blockIndex,
        delta: { type: "input_json_delta", partial_json: toolCall.function.arguments }
      });
    }
  }
}

function ensureMessageStart(state, results, chunk = undefined) {
  if (state.messageStartSent) return;
  state.messageStartSent = true;
  state.messageId = chunk?.id?.replace("chatcmpl-", "") || state.messageId || `msg_${Date.now()}`;
  state.model = chunk?.model || state.model || "unknown";
  state.nextBlockIndex = Number.isFinite(state.nextBlockIndex) ? state.nextBlockIndex : 0;

  results.push({
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      model: state.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
}

export function finalizeOpenAIToClaudeStream(state, { force = false } = {}) {
  const results = [];
  if (!state || (!state.messageStartSent && !force)) return results;

  if (!state.messageStartSent) {
    ensureMessageStart(state, results);
  }

  stopThinkingBlock(state, results);
  stopTextBlock(state, results);

  for (const [, toolInfo] of state.toolCalls) {
    if (toolInfo?.closed) continue;
    results.push({
      type: "content_block_stop",
      index: toolInfo.blockIndex
    });
    toolInfo.closed = true;
  }

  if (!state.messageDeltaSent) {
    const hasToolCalls = state.toolCalls instanceof Map && state.toolCalls.size > 0;
    const normalizedFinishReason = hasToolCalls && (!state.finishReason || state.finishReason === "stop")
      ? "tool_calls"
      : (state.finishReason || "stop");
    results.push({
      type: "message_delta",
      delta: { stop_reason: convertFinishReason(normalizedFinishReason) },
      usage: state.usage || { input_tokens: 0, output_tokens: 0 }
    });
    state.messageDeltaSent = true;
  }

  if (!state.messageStopSent) {
    results.push({ type: "message_stop" });
    state.messageStopSent = true;
  }

  return results;
}

/**
 * Stop thinking block
 */
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex
  });
  state.thinkingBlockStarted = false;
  state.thinkingBlockIndex = null;
}

/**
 * Stop text block
 */
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex
  });
  state.textBlockStarted = false;
}

/**
 * Convert finish reason
 */
function convertFinishReason(reason) {
  switch (reason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "function_call": return "tool_use";
    case "tool_calls": return "tool_use";
    default: return "end_turn";
  }
}
