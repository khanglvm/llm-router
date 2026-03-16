import { FORMATS, initState, translateResponse } from "../../translator/index.js";
import {
  claudeEventToOpenAIChunks,
  initClaudeToOpenAIState
} from "../../translator/response/claude-to-openai.js";
import { finalizeOpenAIToClaudeStream } from "../../translator/response/openai-to-claude.js";
import { passthroughResponseWithCors, withCorsHeaders } from "./http.js";

function normalizeOpenAIContent(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        if (item.type === "text" && typeof item.text === "string") {
          return { type: "text", text: item.text };
        }
        if (item.type === "input_text" && typeof item.text === "string") {
          return { type: "text", text: item.text };
        }
        return null;
      })
      .filter(Boolean);
  }

  return [];
}

function safeParseToolArguments(rawArguments) {
  if (!rawArguments || typeof rawArguments !== "string") return {};
  try {
    return JSON.parse(rawArguments);
  } catch {
    return {};
  }
}

function convertOpenAIFinishReason(reason) {
  switch (reason) {
    case "function_call":
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    default:
      return "end_turn";
  }
}

function resolveOpenAINonStreamFinishReason(choice) {
  const rawReason = String(choice?.finish_reason || "").trim();
  if (rawReason && rawReason !== "stop") {
    return rawReason;
  }

  if (normalizeOpenAIToolCalls(choice?.message).length > 0) {
    return "tool_calls";
  }

  return rawReason || "stop";
}

function normalizeOpenAIToolCalls(message) {
  const normalizedToolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.filter((call) => call && typeof call === "object")
    : [];

  const legacyFunctionCall = message?.function_call;
  if (!legacyFunctionCall || typeof legacyFunctionCall !== "object") {
    return normalizedToolCalls;
  }

  return [
    ...normalizedToolCalls,
    {
      id: String(message?.tool_call_id || message?.tool_use_id || "tool_0"),
      type: "function",
      function: {
        name: String(legacyFunctionCall.name || "tool"),
        arguments: typeof legacyFunctionCall.arguments === "string" ? legacyFunctionCall.arguments : ""
      }
    }
  ];
}

export function convertOpenAINonStreamToClaude(result, fallbackModel = "unknown") {
  const choice = result?.choices?.[0];
  const message = choice?.message || {};
  const content = [
    ...normalizeOpenAIContent(message.content)
  ];

  const toolCalls = normalizeOpenAIToolCalls(message);
  if (toolCalls.length > 0) {
    for (let index = 0; index < toolCalls.length; index += 1) {
      const call = toolCalls[index];
      if (!call || typeof call !== "object") continue;
      content.push({
        type: "tool_use",
        id: call.id || `tool_${index}`,
        name: call.function?.name || "tool",
        input: safeParseToolArguments(call.function?.arguments)
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: result?.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: result?.model || fallbackModel,
    content,
    stop_reason: convertOpenAIFinishReason(resolveOpenAINonStreamFinishReason(choice)),
    stop_sequence: null,
    usage: {
      input_tokens: result?.usage?.prompt_tokens || 0,
      output_tokens: result?.usage?.completion_tokens || 0
    }
  };
}

const OPENAI_RESPONSES_ECHO_FIELDS = [
  "instructions",
  "max_output_tokens",
  "max_tool_calls",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "reasoning",
  "safety_identifier",
  "service_tier",
  "store",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "metadata"
];

function normalizeOpenAIResponseId(value) {
  const raw = String(value || "").trim();
  if (!raw) return `resp_${Date.now()}`;
  return raw.startsWith("resp_") ? raw : `resp_${raw}`;
}

function normalizeClaudeToolArguments(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value || {});
  } catch {
    return "{}";
  }
}

function toOpenAIResponsesUsage({ inputTokens = 0, outputTokens = 0, reasoningTokens = 0 } = {}) {
  const normalizedInput = Number.isFinite(inputTokens) ? Number(inputTokens) : 0;
  const normalizedOutput = Number.isFinite(outputTokens) ? Number(outputTokens) : 0;
  const normalizedReasoning = Number.isFinite(reasoningTokens) ? Number(reasoningTokens) : 0;
  return {
    input_tokens: normalizedInput,
    input_tokens_details: {
      cached_tokens: 0
    },
    output_tokens: normalizedOutput,
    output_tokens_details: normalizedReasoning > 0
      ? { reasoning_tokens: normalizedReasoning }
      : {},
    total_tokens: normalizedInput + normalizedOutput
  };
}

function applyOpenAIResponsesEchoFields(response, requestBody, fallbackModel = "unknown") {
  const nextResponse = {
    ...response
  };

  for (const field of OPENAI_RESPONSES_ECHO_FIELDS) {
    if (requestBody?.[field] !== undefined) {
      nextResponse[field] = requestBody[field];
    }
  }

  if (typeof nextResponse.model !== "string" || !nextResponse.model.trim()) {
    nextResponse.model = fallbackModel;
  }

  return nextResponse;
}

function collectClaudeResponseOutputs(contentBlocks, responseId) {
  const outputs = [];
  const textParts = [];
  const toolCalls = [];
  const reasoningParts = [];

  for (const block of (Array.isArray(contentBlocks) ? contentBlocks : [])) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id || `call_${toolCalls.length + 1}`),
        name: String(block.name || "tool"),
        arguments: normalizeClaudeToolArguments(block.input)
      });
      continue;
    }

    if ((block.type === "thinking" || block.type === "redacted_thinking") && typeof block.thinking === "string") {
      reasoningParts.push(block.thinking);
    }
  }

  if (reasoningParts.length > 0) {
    outputs.push({
      id: `rs_${responseId}_0`,
      type: "reasoning",
      summary: [{
        type: "summary_text",
        text: reasoningParts.join("")
      }]
    });
  }

  if (textParts.length > 0) {
    outputs.push({
      id: `msg_${responseId}_0`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: textParts.join("")
      }]
    });
  }

  for (const toolCall of toolCalls) {
    outputs.push({
      id: `fc_${toolCall.id}`,
      type: "function_call",
      status: "completed",
      arguments: toolCall.arguments || "{}",
      call_id: toolCall.id,
      name: toolCall.name
    });
  }

  return {
    outputs,
    reasoningText: reasoningParts.join("")
  };
}

export function convertClaudeNonStreamToOpenAIResponses(message, requestBody, fallbackModel = "unknown") {
  const responseId = normalizeOpenAIResponseId(message?.id);
  const collected = collectClaudeResponseOutputs(message?.content, responseId);
  const reasoningTokens = collected.reasoningText
    ? Math.max(0, Math.floor(collected.reasoningText.length / 4))
    : 0;

  return applyOpenAIResponsesEchoFields({
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    output: collected.outputs,
    usage: toOpenAIResponsesUsage({
      inputTokens: message?.usage?.input_tokens,
      outputTokens: message?.usage?.output_tokens,
      reasoningTokens
    })
  }, requestBody, message?.model || fallbackModel);
}

function createOpenAIResponsesState(requestBody, fallbackModel = "unknown") {
  return {
    sequence: 0,
    responseId: "",
    createdAt: 0,
    model: typeof requestBody?.model === "string" && requestBody.model.trim()
      ? requestBody.model.trim()
      : fallbackModel,
    textMessageId: "",
    textOutputIndex: null,
    textBuffer: "",
    textOpened: false,
    nextOutputIndex: 0,
    outputItems: [],
    activeBlocks: new Map(),
    toolCalls: new Map(),
    reasoningItems: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    requestBody
  };
}

function nextOpenAIResponsesSequence(state) {
  state.sequence += 1;
  return state.sequence;
}

function formatOpenAIResponsesEvent(eventType, payload) {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function enqueueOpenAIResponsesEvent(controller, eventType, payload, encoder) {
  controller.enqueue(encoder.encode(formatOpenAIResponsesEvent(eventType, payload)));
}

function allocateOpenAIResponsesOutputIndex(state, itemType, key) {
  const outputIndex = state.nextOutputIndex;
  state.nextOutputIndex += 1;
  state.outputItems.push({
    itemType,
    key,
    outputIndex
  });
  return outputIndex;
}

function ensureOpenAIResponsesLifecycleStarted(state, controller, encoder) {
  if (state.createdAt > 0) return;
  state.createdAt = Math.floor(Date.now() / 1000);
  if (!state.responseId) {
    state.responseId = normalizeOpenAIResponseId(Date.now());
  }

  enqueueOpenAIResponsesEvent(controller, "response.created", {
    type: "response.created",
    sequence_number: nextOpenAIResponsesSequence(state),
    response: applyOpenAIResponsesEchoFields({
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      status: "in_progress",
      background: false,
      error: null,
      output: []
    }, state.requestBody, state.model)
  }, encoder);

  enqueueOpenAIResponsesEvent(controller, "response.in_progress", {
    type: "response.in_progress",
    sequence_number: nextOpenAIResponsesSequence(state),
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      status: "in_progress"
    }
  }, encoder);
}

function ensureOpenAIResponsesTextItem(state, controller, encoder) {
  if (state.textMessageId) return;
  ensureOpenAIResponsesLifecycleStarted(state, controller, encoder);
  state.textMessageId = `msg_${state.responseId}_0`;
  state.textOutputIndex = allocateOpenAIResponsesOutputIndex(state, "message", "assistant");

  enqueueOpenAIResponsesEvent(controller, "response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: nextOpenAIResponsesSequence(state),
    output_index: state.textOutputIndex,
    item: {
      id: state.textMessageId,
      type: "message",
      status: "in_progress",
      content: [],
      role: "assistant"
    }
  }, encoder);

  enqueueOpenAIResponsesEvent(controller, "response.content_part.added", {
    type: "response.content_part.added",
    sequence_number: nextOpenAIResponsesSequence(state),
    item_id: state.textMessageId,
    output_index: state.textOutputIndex,
    content_index: 0,
    part: {
      type: "output_text",
      text: ""
    }
  }, encoder);
}

function ensureOpenAIResponsesToolCall(state, index, block, controller, encoder) {
  ensureOpenAIResponsesLifecycleStarted(state, controller, encoder);
  const normalizedIndex = Number.isFinite(index) ? Number(index) : 0;
  const existing = state.toolCalls.get(normalizedIndex);
  if (existing) {
    if (typeof block?.name === "string" && block.name.trim()) {
      existing.name = block.name.trim();
    }
    if (typeof block?.id === "string" && block.id.trim()) {
      existing.id = block.id.trim();
    }
    return existing;
  }

  const toolCall = {
    id: String(block?.id || `call_${normalizedIndex}`),
    name: String(block?.name || "tool"),
    arguments: "",
    outputIndex: allocateOpenAIResponsesOutputIndex(state, "function_call", normalizedIndex)
  };
  state.toolCalls.set(normalizedIndex, toolCall);

  enqueueOpenAIResponsesEvent(controller, "response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: nextOpenAIResponsesSequence(state),
    output_index: toolCall.outputIndex,
    item: {
      id: `fc_${toolCall.id}`,
      type: "function_call",
      status: "in_progress",
      arguments: "",
      call_id: toolCall.id,
      name: toolCall.name
    }
  }, encoder);

  return toolCall;
}

function ensureOpenAIResponsesReasoningItem(state, index, controller, encoder) {
  ensureOpenAIResponsesLifecycleStarted(state, controller, encoder);
  const normalizedIndex = Number.isFinite(index) ? Number(index) : 0;
  const existing = state.reasoningItems.get(normalizedIndex);
  if (existing) {
    return existing;
  }

  const reasoningItem = {
    id: `rs_${state.responseId}_${normalizedIndex}`,
    outputIndex: allocateOpenAIResponsesOutputIndex(state, "reasoning", normalizedIndex),
    text: "",
    opened: true
  };
  state.reasoningItems.set(normalizedIndex, reasoningItem);

  enqueueOpenAIResponsesEvent(controller, "response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: nextOpenAIResponsesSequence(state),
    output_index: reasoningItem.outputIndex,
    item: {
      id: reasoningItem.id,
      type: "reasoning",
      status: "in_progress",
      summary: []
    }
  }, encoder);

  enqueueOpenAIResponsesEvent(controller, "response.reasoning_summary_part.added", {
    type: "response.reasoning_summary_part.added",
    sequence_number: nextOpenAIResponsesSequence(state),
    item_id: reasoningItem.id,
    output_index: reasoningItem.outputIndex,
    summary_index: 0,
    part: {
      type: "summary_text",
      text: ""
    }
  }, encoder);

  return reasoningItem;
}

function flushOpenAIResponsesTextItem(state, controller, encoder) {
  if (!state.textMessageId || !state.textOpened) return;
  enqueueOpenAIResponsesEvent(controller, "response.output_text.done", {
    type: "response.output_text.done",
    sequence_number: nextOpenAIResponsesSequence(state),
    item_id: state.textMessageId,
    output_index: state.textOutputIndex ?? 0,
    content_index: 0,
    text: state.textBuffer
  }, encoder);

  enqueueOpenAIResponsesEvent(controller, "response.content_part.done", {
    type: "response.content_part.done",
    sequence_number: nextOpenAIResponsesSequence(state),
    item_id: state.textMessageId,
    output_index: state.textOutputIndex ?? 0,
    content_index: 0,
    part: {
      type: "output_text",
      text: state.textBuffer
    }
  }, encoder);

  enqueueOpenAIResponsesEvent(controller, "response.output_item.done", {
    type: "response.output_item.done",
    sequence_number: nextOpenAIResponsesSequence(state),
    output_index: state.textOutputIndex ?? 0,
    item: {
      id: state.textMessageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: state.textBuffer
      }]
    }
  }, encoder);

  state.textOpened = false;
}

function flushOpenAIResponsesToolCall(state, index, controller, encoder) {
  const normalizedIndex = Number.isFinite(index) ? Number(index) : 0;
  const toolCall = state.toolCalls.get(normalizedIndex);
  if (!toolCall) return;
  enqueueOpenAIResponsesEvent(controller, "response.function_call_arguments.done", {
    type: "response.function_call_arguments.done",
    sequence_number: nextOpenAIResponsesSequence(state),
    item_id: `fc_${toolCall.id}`,
    output_index: toolCall.outputIndex,
    arguments: toolCall.arguments || "{}"
  }, encoder);

  enqueueOpenAIResponsesEvent(controller, "response.output_item.done", {
    type: "response.output_item.done",
    sequence_number: nextOpenAIResponsesSequence(state),
    output_index: toolCall.outputIndex,
    item: {
      id: `fc_${toolCall.id}`,
      type: "function_call",
      status: "completed",
      arguments: toolCall.arguments || "{}",
      call_id: toolCall.id,
      name: toolCall.name
    }
  }, encoder);
}

function flushOpenAIResponsesReasoningItem(state, index, controller, encoder) {
  const normalizedIndex = Number.isFinite(index) ? Number(index) : 0;
  const reasoningItem = state.reasoningItems.get(normalizedIndex);
  if (!reasoningItem || !reasoningItem.opened) return;

  enqueueOpenAIResponsesEvent(controller, "response.reasoning_summary_text.done", {
    type: "response.reasoning_summary_text.done",
    sequence_number: nextOpenAIResponsesSequence(state),
    item_id: reasoningItem.id,
    output_index: reasoningItem.outputIndex,
    summary_index: 0,
    text: reasoningItem.text
  }, encoder);

  enqueueOpenAIResponsesEvent(controller, "response.reasoning_summary_part.done", {
    type: "response.reasoning_summary_part.done",
    sequence_number: nextOpenAIResponsesSequence(state),
    item_id: reasoningItem.id,
    output_index: reasoningItem.outputIndex,
    summary_index: 0,
    part: {
      type: "summary_text",
      text: reasoningItem.text
    }
  }, encoder);

  reasoningItem.opened = false;
}

function buildCompletedOpenAIResponse(state) {
  const outputs = state.outputItems
    .slice()
    .sort((left, right) => left.outputIndex - right.outputIndex)
    .map((entry) => {
      if (entry.itemType === "reasoning") {
        const reasoningItem = state.reasoningItems.get(entry.key);
        if (!reasoningItem) return null;
        return {
          id: reasoningItem.id,
          type: "reasoning",
          summary: [{
            type: "summary_text",
            text: reasoningItem.text
          }]
        };
      }

      if (entry.itemType === "message") {
        if (!state.textMessageId && !state.textBuffer) return null;
        return {
          id: state.textMessageId || `msg_${state.responseId}_0`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{
            type: "output_text",
            text: state.textBuffer
          }]
        };
      }

      if (entry.itemType === "function_call") {
        const toolCall = state.toolCalls.get(entry.key);
        if (!toolCall) return null;
        return {
          id: `fc_${toolCall.id}`,
          type: "function_call",
          status: "completed",
          arguments: toolCall.arguments || "{}",
          call_id: toolCall.id,
          name: toolCall.name
        };
      }

      return null;
    })
    .filter(Boolean);

  const reasoningText = [...state.reasoningItems.values()]
    .map((item) => item.text)
    .join("");

  return applyOpenAIResponsesEchoFields({
    id: state.responseId || normalizeOpenAIResponseId(Date.now()),
    object: "response",
    created_at: state.createdAt || Math.floor(Date.now() / 1000),
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    output: outputs,
    usage: toOpenAIResponsesUsage({
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      reasoningTokens: reasoningText ? Math.floor(reasoningText.length / 4) : 0
    })
  }, state.requestBody, state.model);
}

export function handleClaudeStreamToOpenAIResponses(response, requestBody, fallbackModel = "unknown") {
  const state = createOpenAIResponsesState(requestBody, fallbackModel);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  function processBlock(block, controller) {
    if (!block || !block.trim()) return;
    const parsedBlock = parseSseBlock(block);
    if (!parsedBlock.data || parsedBlock.data === "[DONE]") return;

    let payload;
    try {
      payload = JSON.parse(parsedBlock.data);
    } catch {
      return;
    }

    const eventType = String(payload?.type || "").trim();
    if (!eventType) return;

    if (eventType === "message_start") {
      ensureOpenAIResponsesLifecycleStarted(state, controller, encoder);
      const message = payload.message || {};
      state.responseId = normalizeOpenAIResponseId(message.id || state.responseId || Date.now());
      state.model = typeof requestBody?.model === "string" && requestBody.model.trim()
        ? requestBody.model.trim()
        : (message.model || state.model || fallbackModel);
      if (message.usage && typeof message.usage === "object") {
        if (Number.isFinite(message.usage.input_tokens)) state.inputTokens = Number(message.usage.input_tokens);
        if (Number.isFinite(message.usage.output_tokens)) state.outputTokens = Number(message.usage.output_tokens);
      }
      return;
    }

    if (eventType === "content_block_start") {
      const index = Number(payload.index);
      const blockInfo = payload.content_block || {};
      state.activeBlocks.set(index, String(blockInfo.type || "").trim());
      // Defer text output item creation until first renderable text delta
      // to avoid emitting empty assistant text scaffolding before tool calls.
      if (blockInfo.type === "text") {
        // Intentionally do NOT open text item yet; wait for renderable text in content_block_delta.
      } else if (blockInfo.type === "thinking" || blockInfo.type === "redacted_thinking") {
        ensureOpenAIResponsesReasoningItem(state, index, controller, encoder);
      } else if (blockInfo.type === "tool_use") {
        ensureOpenAIResponsesToolCall(state, index, blockInfo, controller, encoder);
      }
      return;
    }

    if (eventType === "content_block_delta") {
      const index = Number(payload.index);
      const delta = payload.delta || {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        const hasRenderableText = /\S/.test(delta.text);
        if (!state.textOpened && !hasRenderableText) {
          return;
        }
        ensureOpenAIResponsesTextItem(state, controller, encoder);
        state.textOpened = true;
        state.textBuffer += delta.text;
        enqueueOpenAIResponsesEvent(controller, "response.output_text.delta", {
          type: "response.output_text.delta",
          sequence_number: nextOpenAIResponsesSequence(state),
          item_id: state.textMessageId,
          output_index: state.textOutputIndex ?? 0,
          content_index: 0,
          delta: delta.text
        }, encoder);
        return;
      }

      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const toolCall = ensureOpenAIResponsesToolCall(state, index, payload.content_block, controller, encoder);
        toolCall.arguments += delta.partial_json;
        enqueueOpenAIResponsesEvent(controller, "response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          sequence_number: nextOpenAIResponsesSequence(state),
          item_id: `fc_${toolCall.id}`,
          output_index: toolCall.outputIndex,
          delta: delta.partial_json
        }, encoder);
        return;
      }

      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        const reasoningItem = ensureOpenAIResponsesReasoningItem(state, index, controller, encoder);
        reasoningItem.text += delta.thinking;
        enqueueOpenAIResponsesEvent(controller, "response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          sequence_number: nextOpenAIResponsesSequence(state),
          item_id: reasoningItem.id,
          output_index: reasoningItem.outputIndex,
          summary_index: 0,
          delta: delta.thinking
        }, encoder);
      }
      return;
    }

    if (eventType === "content_block_stop") {
      const index = Number(payload.index);
      const blockType = state.activeBlocks.get(index);
      if (blockType === "text") {
        flushOpenAIResponsesTextItem(state, controller, encoder);
      } else if (blockType === "thinking" || blockType === "redacted_thinking") {
        flushOpenAIResponsesReasoningItem(state, index, controller, encoder);
      } else if (blockType === "tool_use") {
        flushOpenAIResponsesToolCall(state, index, controller, encoder);
      }
      state.activeBlocks.delete(index);
      return;
    }

    if (eventType === "message_delta") {
      const usage = payload.usage || {};
      if (Number.isFinite(usage.input_tokens)) state.inputTokens = Number(usage.input_tokens);
      if (Number.isFinite(usage.output_tokens)) state.outputTokens = Number(usage.output_tokens);
      return;
    }

    if (eventType === "message_stop") {
      flushOpenAIResponsesTextItem(state, controller, encoder);
      for (const index of [...state.activeBlocks.keys()]) {
        if (state.activeBlocks.get(index) === "thinking" || state.activeBlocks.get(index) === "redacted_thinking") {
          flushOpenAIResponsesReasoningItem(state, index, controller, encoder);
        } else if (state.activeBlocks.get(index) === "tool_use") {
          flushOpenAIResponsesToolCall(state, index, controller, encoder);
        }
        state.activeBlocks.delete(index);
      }
      ensureOpenAIResponsesLifecycleStarted(state, controller, encoder);
      enqueueOpenAIResponsesEvent(controller, "response.completed", {
        type: "response.completed",
        sequence_number: nextOpenAIResponsesSequence(state),
        response: buildCompletedOpenAIResponse(state)
      }, encoder);
    }
  }

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let boundaryIndex;
      while ((boundaryIndex = buffer.indexOf("\n\n")) >= 0) {
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
    }
  });

  return new Response(response.body.pipeThrough(transformStream), {
    headers: withCorsHeaders({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    })
  });
}

function formatClaudeEvent(event) {
  const eventType = event.type || "message";
  return `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

function mergeClaudeUsage(state, usage) {
  if (!usage || typeof usage !== "object") return;
  const nextUsage = {
    ...(state.usage && typeof state.usage === "object" ? state.usage : {})
  };

  for (const [key, value] of Object.entries(usage)) {
    if (value !== undefined) {
      nextUsage[key] = value;
    }
  }

  state.usage = nextUsage;
}

function buildSyntheticClaudeMessageDelta(state) {
  const usage = {
    ...(state.usage && typeof state.usage === "object" ? state.usage : {})
  };

  if (!Number.isFinite(usage.input_tokens)) usage.input_tokens = 0;
  if (!Number.isFinite(usage.output_tokens)) usage.output_tokens = 0;

  return {
    type: "message_delta",
    delta: {
      stop_reason: state.stopReason || (state.hasToolUse ? "tool_use" : "end_turn"),
      stop_sequence: state.stopSequence ?? null
    },
    usage
  };
}

export function normalizeClaudePassthroughStream(response) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = {
    messageStarted: false,
    messageStopped: false,
    terminalDeltaSeen: false,
    hasToolUse: false,
    stopReason: null,
    stopSequence: undefined,
    usage: undefined
  };
  let buffer = "";

  function enqueueRawBlock(controller, block) {
    controller.enqueue(encoder.encode(`${block}\n\n`));
  }

  function enqueueSyntheticMessageDelta(controller) {
    controller.enqueue(encoder.encode(formatClaudeEvent(buildSyntheticClaudeMessageDelta(state))));
    state.terminalDeltaSeen = true;
  }

  function finalizeClaudeMessage(controller) {
    if (!state.messageStarted || state.messageStopped) return;
    if (!state.terminalDeltaSeen) {
      enqueueSyntheticMessageDelta(controller);
    }
    controller.enqueue(encoder.encode(formatClaudeEvent({ type: "message_stop" })));
    state.messageStopped = true;
  }

  function beginNextClaudeMessage() {
    state.messageStarted = false;
    state.messageStopped = false;
    state.terminalDeltaSeen = false;
    state.hasToolUse = false;
    state.stopReason = null;
    state.stopSequence = undefined;
    state.usage = undefined;
  }

  function processBlock(block, controller) {
    if (!block || !block.trim()) return;
    const parsedBlock = parseSseBlock(block);
    if (!parsedBlock.data) {
      enqueueRawBlock(controller, block);
      return;
    }

    if (parsedBlock.data === "[DONE]") {
      finalizeClaudeMessage(controller);
      enqueueRawBlock(controller, block);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(parsedBlock.data);
    } catch {
      enqueueRawBlock(controller, block);
      return;
    }

    const eventType = String(payload?.type || parsedBlock.eventType || "").trim();
    if (eventType === "message_start") {
      if (state.messageStarted && !state.messageStopped) {
        finalizeClaudeMessage(controller);
        beginNextClaudeMessage();
      }
      state.messageStarted = true;
      mergeClaudeUsage(state, payload.message?.usage);
      enqueueRawBlock(controller, block);
      return;
    }

    if (eventType === "content_block_start") {
      if (String(payload?.content_block?.type || "").trim() === "tool_use") {
        state.hasToolUse = true;
      }
      enqueueRawBlock(controller, block);
      return;
    }

    if (eventType === "message_delta") {
      mergeClaudeUsage(state, payload.usage);
      if (typeof payload?.delta?.stop_reason === "string" && payload.delta.stop_reason.trim()) {
        state.stopReason = payload.delta.stop_reason.trim();
        state.terminalDeltaSeen = true;
      }
      if (payload?.delta && Object.hasOwn(payload.delta, "stop_sequence")) {
        state.stopSequence = payload.delta.stop_sequence;
      }
      enqueueRawBlock(controller, block);
      return;
    }

    if (eventType === "message_stop") {
      if (!state.terminalDeltaSeen) {
        enqueueSyntheticMessageDelta(controller);
      }
      state.messageStopped = true;
      enqueueRawBlock(controller, block);
      return;
    }

    enqueueRawBlock(controller, block);
  }

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

      let boundaryIndex;
      while ((boundaryIndex = buffer.indexOf("\n\n")) >= 0) {
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
      finalizeClaudeMessage(controller);
    }
  });

  return passthroughResponseWithCors(new Response(response.body?.pipeThrough(transformStream), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  }), {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
}

export function handleOpenAIStreamToClaude(response) {
  const state = initState(FORMATS.CLAUDE);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = "";

  function enqueueClaudeEvents(controller, events) {
    for (const event of events || []) {
      controller.enqueue(encoder.encode(formatClaudeEvent(event)));
    }
  }

  function processBlock(block, controller) {
    if (!block || !block.trim()) return;
    const parsedBlock = parseSseBlock(block);
    if (!parsedBlock.data) return;

    if (parsedBlock.data === "[DONE]") {
      if (!state.messageStopSent) {
        enqueueClaudeEvents(controller, finalizeOpenAIToClaudeStream(state));
      }
      return;
    }

    try {
      const parsed = JSON.parse(parsedBlock.data);
      enqueueClaudeEvents(controller, translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, parsed, state));
    } catch (error) {
      console.error("[Stream] Failed parsing OpenAI chunk:", error instanceof Error ? error.message : String(error));
    }
  }

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

      let boundaryIndex;
      while ((boundaryIndex = buffer.indexOf("\n\n")) >= 0) {
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
      if (!state.messageStopSent) {
        enqueueClaudeEvents(controller, finalizeOpenAIToClaudeStream(state, { force: state.messageStartSent }));
      }
    }
  });

  return new Response(response.body.pipeThrough(transformStream), {
    headers: withCorsHeaders({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    })
  });
}

function formatOpenAIChunkSse(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function parseSseBlock(block) {
  let eventType = "message";
  const dataLines = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    eventType,
    data: dataLines.join("\n").trim()
  };
}

export function handleClaudeStreamToOpenAI(response) {
  const state = initClaudeToOpenAIState();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = "";
  let doneSent = false;

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

      let boundaryIndex;
      while ((boundaryIndex = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        if (!block.trim()) continue;

        const parsedBlock = parseSseBlock(block);
        if (!parsedBlock.data) continue;

        if (parsedBlock.data === "[DONE]") {
          if (!doneSent) {
            doneSent = true;
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
          continue;
        }

        let payload;
        try {
          payload = JSON.parse(parsedBlock.data);
        } catch (error) {
          console.error("[Stream] Failed parsing Claude chunk:", error instanceof Error ? error.message : String(error));
          continue;
        }

        const translatedChunks = claudeEventToOpenAIChunks(parsedBlock.eventType, payload, state);
        for (const translated of translatedChunks) {
          if (translated === "[DONE]") {
            if (!doneSent) {
              doneSent = true;
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            continue;
          }
          controller.enqueue(encoder.encode(formatOpenAIChunkSse(translated)));
        }
      }
    },

    flush(controller) {
      if (!doneSent) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    }
  });

  return new Response(response.body.pipeThrough(transformStream), {
    headers: withCorsHeaders({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    })
  });
}
