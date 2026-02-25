/**
 * Claude (Anthropic) -> OpenAI response translator (stream + non-stream helpers).
 */

function mapStopReason(reason) {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "end_turn":
    case "stop_sequence":
    default:
      return "stop";
  }
}

function toOpenAIUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = usage.input_tokens || 0;
  const completion = usage.output_tokens || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion
  };
}

function stringifyToolInput(input) {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input || {});
  } catch {
    return "{}";
  }
}

export function claudeToOpenAINonStreamResponse(message) {
  const contentBlocks = Array.isArray(message?.content) ? message.content : [];
  const textParts = [];
  const toolCalls = [];

  for (let i = 0; i < contentBlocks.length; i += 1) {
    const block = contentBlocks[i];
    if (!block || typeof block !== "object") continue;

    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || `call_${i}`,
        type: "function",
        function: {
          name: block.name || "tool",
          arguments: stringifyToolInput(block.input)
        }
      });
    }
  }

  const text = textParts.join("");
  const responseMessage = {
    role: "assistant",
    content: text.length > 0 ? text : null
  };

  if (toolCalls.length > 0) {
    responseMessage.tool_calls = toolCalls;
  }

  return {
    id: message?.id?.startsWith("chatcmpl_") ? message.id : `chatcmpl_${message?.id || Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: message?.model || "unknown",
    choices: [
      {
        index: 0,
        message: responseMessage,
        finish_reason: mapStopReason(message?.stop_reason)
      }
    ],
    usage: toOpenAIUsage(message?.usage)
  };
}

export function initClaudeToOpenAIState() {
  return {
    chatId: `chatcmpl_${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: "unknown",
    toolCallByBlockIndex: new Map(),
    nextToolCallIndex: 0,
    usage: undefined
  };
}

function makeChunk(state, delta = {}, finishReason = null, usage = undefined) {
  const chunk = {
    id: state.chatId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model || "unknown",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  };

  if (usage) {
    chunk.usage = usage;
  }

  return chunk;
}

export function claudeEventToOpenAIChunks(eventType, event, state) {
  if (!event || typeof event !== "object") {
    if (eventType === "message_stop") return ["[DONE]"];
    return [];
  }

  switch (eventType) {
    case "message_start": {
      const message = event.message || {};
      state.chatId = message.id?.startsWith("chatcmpl_") ? message.id : `chatcmpl_${message.id || Date.now()}`;
      state.model = message.model || state.model || "unknown";
      state.usage = toOpenAIUsage(message.usage);
      return [makeChunk(state, { role: "assistant" }, null)];
    }

    case "content_block_start": {
      const block = event.content_block || {};
      if (block.type !== "tool_use") return [];

      const toolIndex = state.nextToolCallIndex++;
      state.toolCallByBlockIndex.set(event.index, toolIndex);

      return [
        makeChunk(state, {
          tool_calls: [
            {
              index: toolIndex,
              id: block.id || `call_${toolIndex}`,
              type: "function",
              function: {
                name: block.name || "tool",
                arguments: ""
              }
            }
          ]
        }, null)
      ];
    }

    case "content_block_delta": {
      const delta = event.delta || {};
      if (delta.type === "text_delta") {
        return [makeChunk(state, { content: delta.text || "" }, null)];
      }

      if (delta.type === "input_json_delta") {
        const toolIndex = state.toolCallByBlockIndex.get(event.index);
        if (toolIndex === undefined) return [];
        return [
          makeChunk(state, {
            tool_calls: [
              {
                index: toolIndex,
                function: {
                  arguments: delta.partial_json || ""
                }
              }
            ]
          }, null)
        ];
      }

      // thinking_delta and other Anthropic-specific blocks are ignored for OpenAI chat compat.
      return [];
    }

    case "message_delta": {
      const usage = toOpenAIUsage(event.usage);
      if (usage) state.usage = usage;
      const stopReason = event.delta?.stop_reason ? mapStopReason(event.delta.stop_reason) : null;
      if (!stopReason && !usage) return [];
      return [makeChunk(state, {}, stopReason, usage)];
    }

    case "message_stop":
      return ["[DONE]"];

    default:
      return [];
  }
}

