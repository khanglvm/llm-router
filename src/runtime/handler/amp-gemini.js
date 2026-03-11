import { FORMATS } from "../../translator/index.js";
import { listConfiguredModels, resolveRequestModel } from "../config.js";
import { jsonResponse, withCorsHeaders } from "./http.js";

let toolCallCounter = 0;

const GEMINI_SUPPORTED_METHODS = ["generateContent", "streamGenerateContent"];
const GOOGLE_MODEL_PATH_PATTERNS = [
  "/api/provider/google/v1beta1",
  "/api/provider/google/v1beta",
  "/api/provider/google/v1",
  "/api/provider/google",
  "/v1/publishers/google",
  "/publishers/google"
];

function normalizePath(pathname) {
  const text = String(pathname || "").trim() || "/";
  if (text.length > 1 && text.endsWith("/")) return text.slice(0, -1);
  return text;
}

function parseInlineData(part) {
  if (!part || typeof part !== "object") return null;
  return part.inlineData || part.inline_data || null;
}

function buildDataUriFromInlineData(inlineData) {
  if (!inlineData || typeof inlineData !== "object") return "";
  const data = String(inlineData.data || "").trim();
  if (!data) return "";
  const mimeType = String(inlineData.mimeType || inlineData.mime_type || "application/octet-stream").trim() || "application/octet-stream";
  return `data:${mimeType};base64,${data}`;
}

function parseJsonObjectSafely(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value || "").trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function safeJsonStringify(value, fallback = "{}") {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function generateToolCallId() {
  toolCallCounter += 1;
  return `call_amp_${Date.now()}_${toolCallCounter}`;
}

function mapGeminiThinkingConfigToEffort(config) {
  if (!config || typeof config !== "object") return undefined;
  const explicit = String(config.thinkingLevel || config.thinking_level || "").trim().toLowerCase();
  if (explicit) return explicit;
  const budget = Number(config.thinkingBudget ?? config.thinking_budget);
  if (!Number.isFinite(budget) || budget <= 0) return undefined;
  if (budget <= 1024) return "low";
  if (budget <= 4096) return "medium";
  return "high";
}

function toMessageContent(textParts, imageUrls) {
  const items = [];

  for (const text of textParts) {
    const value = String(text || "");
    if (!value) continue;
    items.push({ type: "text", text: value });
  }

  for (const url of imageUrls) {
    const value = String(url || "").trim();
    if (!value) continue;
    items.push({ type: "image_url", image_url: { url: value } });
  }

  if (items.length === 0) return "";
  if (items.length === 1 && items[0].type === "text") return items[0].text;
  return items;
}

function enqueuePendingToolCall(queueByName, name, id) {
  if (!name || !id) return;
  const list = queueByName.get(name) || [];
  list.push(id);
  queueByName.set(name, list);
}

function dequeuePendingToolCall(queueByName, name) {
  const list = queueByName.get(name) || [];
  const next = list.shift() || "";
  if (list.length > 0) {
    queueByName.set(name, list);
  } else {
    queueByName.delete(name);
  }
  return next;
}

function convertGeminiContentToMessages(content, queueByName) {
  if (!content || typeof content !== "object") return [];

  const role = String(content.role || "user").trim().toLowerCase() === "model"
    ? "assistant"
    : "user";
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const textParts = [];
  const imageUrls = [];
  const toolCalls = [];
  const toolResults = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;

    if (typeof part.text === "string" && part.text) {
      textParts.push(part.text);
    }

    const inlineData = parseInlineData(part);
    const imageUrl = buildDataUriFromInlineData(inlineData);
    if (imageUrl) {
      imageUrls.push(imageUrl);
    }

    if (part.functionCall && typeof part.functionCall === "object") {
      const name = String(part.functionCall.name || "").trim() || "tool";
      const id = String(part.functionCall.id || "").trim() || generateToolCallId();
      toolCalls.push({
        id,
        type: "function",
        function: {
          name,
          arguments: safeJsonStringify(part.functionCall.args || {}, "{}")
        }
      });
      enqueuePendingToolCall(queueByName, name, id);
    }

    if (part.functionResponse && typeof part.functionResponse === "object") {
      const name = String(part.functionResponse.name || "").trim() || "tool";
      const id = String(part.functionResponse.id || "").trim() || dequeuePendingToolCall(queueByName, name) || generateToolCallId();
      toolResults.push({
        role: "tool",
        tool_call_id: id,
        content: safeJsonStringify(part.functionResponse.response || {}, "{}")
      });
    }
  }

  const messages = [];
  const contentValue = toMessageContent(textParts, imageUrls);

  if (role === "assistant") {
    if (contentValue || toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: typeof contentValue === "string" ? contentValue : (contentValue || ""),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      });
    }
  } else if (contentValue) {
    messages.push({
      role: "user",
      content: contentValue
    });
  }

  if (toolResults.length > 0) {
    messages.push(...toolResults);
  }

  return messages;
}

function convertGeminiToolsToOpenAITools(tools) {
  const out = [];
  for (const tool of (Array.isArray(tools) ? tools : [])) {
    if (!tool || typeof tool !== "object") continue;
    if (hasGeminiWebSearchTool([tool])) {
      out.push({ type: "web_search" });
    }
    const declarations = Array.isArray(tool.functionDeclarations)
      ? tool.functionDeclarations
      : (Array.isArray(tool.function_declarations) ? tool.function_declarations : []);
    for (const declaration of declarations) {
      if (!declaration || typeof declaration !== "object") continue;
      const name = String(declaration.name || "").trim();
      if (!name) continue;
      out.push({
        type: "function",
        function: {
          name,
          description: typeof declaration.description === "string" ? declaration.description : "",
          parameters: declaration.parametersJsonSchema || declaration.parameters_json_schema || declaration.parameters || { type: "object", properties: {} }
        }
      });
    }
  }
  return out;
}

export function hasGeminiWebSearchTool(tools) {
  for (const tool of (Array.isArray(tools) ? tools : [])) {
    if (!tool || typeof tool !== "object") continue;
    if (
      (tool.googleSearch && typeof tool.googleSearch === "object")
      || (tool.google_search && typeof tool.google_search === "object")
      || (tool.googleSearchRetrieval && typeof tool.googleSearchRetrieval === "object")
      || (tool.google_search_retrieval && typeof tool.google_search_retrieval === "object")
    ) {
      return true;
    }
  }
  return false;
}

function convertGeminiToolChoice(toolConfig) {
  const functionCallingConfig = toolConfig?.functionCallingConfig || toolConfig?.function_calling_config;
  if (!functionCallingConfig || typeof functionCallingConfig !== "object") return undefined;

  const mode = String(functionCallingConfig.mode || "").trim().toUpperCase();
  const allowed = Array.isArray(functionCallingConfig.allowedFunctionNames)
    ? functionCallingConfig.allowedFunctionNames.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  if (mode === "NONE") return "none";
  if (allowed.length === 1) {
    return {
      type: "function",
      function: { name: allowed[0] }
    };
  }
  if (mode === "ANY" || mode === "REQUIRED") return "required";
  if (mode === "AUTO") return "auto";
  return undefined;
}

export function extractAmpGeminiRouteInfo(pathname) {
  const path = normalizePath(pathname);

  for (const prefix of GOOGLE_MODEL_PATH_PATTERNS) {
    if (!(path === prefix || path.startsWith(`${prefix}/`))) continue;
    const relative = path.slice(prefix.length) || "/";

    if (relative === "/models" || relative === "/models/") {
      return { type: "models" };
    }

    if (!relative.startsWith("/models/")) continue;

    const modelAction = relative.slice("/models/".length);
    if (!modelAction) {
      return { type: "models" };
    }

    const colonIndex = modelAction.indexOf(":");
    if (colonIndex < 0) {
      return {
        type: "model",
        model: decodeURIComponent(modelAction)
      };
    }

    const model = decodeURIComponent(modelAction.slice(0, colonIndex));
    const method = modelAction.slice(colonIndex + 1);
    if (!model || !GEMINI_SUPPORTED_METHODS.includes(method)) return null;

    return {
      type: "request",
      model,
      method,
      stream: method === "streamGenerateContent"
    };
  }

  return null;
}

export function convertAmpGeminiRequestToOpenAI(body, spec) {
  const payload = body && typeof body === "object" ? body : {};
  const out = {
    model: spec?.model || String(payload.model || payload.modelName || "").trim() || "smart",
    messages: [],
    stream: Boolean(spec?.stream)
  };

  const systemInstruction = payload.systemInstruction || payload.system_instruction;
  if (systemInstruction && typeof systemInstruction === "object") {
    const systemParts = Array.isArray(systemInstruction.parts) ? systemInstruction.parts : [];
    const texts = systemParts
      .map((part) => (part && typeof part === "object" && typeof part.text === "string") ? part.text : "")
      .filter(Boolean);
    if (texts.length > 0) {
      out.messages.push({
        role: "system",
        content: texts.join("\n")
      });
    }
  }

  const pendingToolCalls = new Map();
  for (const content of (Array.isArray(payload.contents) ? payload.contents : [])) {
    out.messages.push(...convertGeminiContentToMessages(content, pendingToolCalls));
  }

  const generationConfig = payload.generationConfig || payload.generation_config;
  if (generationConfig && typeof generationConfig === "object") {
    if (Number.isFinite(Number(generationConfig.temperature))) out.temperature = Number(generationConfig.temperature);
    if (Number.isFinite(Number(generationConfig.maxOutputTokens ?? generationConfig.max_output_tokens))) out.max_tokens = Number(generationConfig.maxOutputTokens ?? generationConfig.max_output_tokens);
    if (Number.isFinite(Number(generationConfig.topP ?? generationConfig.top_p))) out.top_p = Number(generationConfig.topP ?? generationConfig.top_p);
    if (Number.isFinite(Number(generationConfig.topK ?? generationConfig.top_k))) out.top_k = Number(generationConfig.topK ?? generationConfig.top_k);
    const stopSequences = Array.isArray(generationConfig.stopSequences)
      ? generationConfig.stopSequences
      : (Array.isArray(generationConfig.stop_sequences) ? generationConfig.stop_sequences : []);
    if (stopSequences.length > 0) {
      out.stop = stopSequences.map((value) => String(value || "")).filter(Boolean);
    }
    if (Number.isFinite(Number(generationConfig.candidateCount ?? generationConfig.candidate_count))) {
      out.n = Number(generationConfig.candidateCount ?? generationConfig.candidate_count);
    }
    const reasoningEffort = mapGeminiThinkingConfigToEffort(generationConfig.thinkingConfig || generationConfig.thinking_config);
    if (reasoningEffort) out.reasoning_effort = reasoningEffort;
  }

  const tools = convertGeminiToolsToOpenAITools(payload.tools);
  if (tools.length > 0) out.tools = tools;

  const toolChoice = convertGeminiToolChoice(payload.toolConfig || payload.tool_config);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  return out;
}

function mapOpenAIFinishReason(reason) {
  switch (String(reason || "").trim().toLowerCase()) {
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    case "tool_calls":
    case "stop":
    default:
      return "STOP";
  }
}

function buildGeminiUsageMetadata(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    promptTokenCount: Number(usage.prompt_tokens || 0),
    candidatesTokenCount: Number(usage.completion_tokens || 0),
    totalTokenCount: Number(usage.total_tokens || 0),
    ...(Number(usage?.completion_tokens_details?.reasoning_tokens || 0) > 0
      ? { thoughtsTokenCount: Number(usage.completion_tokens_details.reasoning_tokens) }
      : {})
  };
}

function buildGeminiPartsFromOpenAIMessage(message = {}) {
  const parts = [];
  const reasoning = String(message.reasoning_content || "").trim();
  if (reasoning) {
    parts.push({ thought: true, text: reasoning });
  }

  if (typeof message.content === "string" && message.content) {
    parts.push({ text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.text === "string" && item.text) {
        parts.push({ text: item.text });
      }
    }
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object") continue;
    const name = String(toolCall.function?.name || toolCall.name || "").trim();
    if (!name) continue;
    parts.push({
      functionCall: {
        ...(String(toolCall.id || "").trim() ? { id: String(toolCall.id).trim() } : {}),
        name,
        args: parseToolArgumentsObject(toolCall.function?.arguments)
      }
    });
  }

  if (parts.length === 0) {
    parts.push({ text: "" });
  }
  return parts;
}

export function convertOpenAIResponseToAmpGeminiPayload(openAIResponse) {
  const response = openAIResponse && typeof openAIResponse === "object" ? openAIResponse : {};
  const candidates = [];

  for (const choice of (Array.isArray(response.choices) ? response.choices : [])) {
    candidates.push({
      index: Number.isFinite(choice?.index) ? Number(choice.index) : 0,
      content: {
        role: "model",
        parts: buildGeminiPartsFromOpenAIMessage(choice?.message || {})
      },
      finishReason: mapOpenAIFinishReason(choice?.finish_reason)
    });
  }

  return {
    candidates: candidates.length > 0
      ? candidates
      : [{ index: 0, content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
    model: response.model,
    ...(buildGeminiUsageMetadata(response.usage) ? { usageMetadata: buildGeminiUsageMetadata(response.usage) } : {})
  };
}

function createAmpGeminiSseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function copyRouterDebugHeaders(response, headersLike = {}) {
  const headers = new Headers(withCorsHeaders(headersLike));
  if (!(response instanceof Response)) return headers;

  for (const [name, value] of response.headers.entries()) {
    if (!String(name || "").toLowerCase().startsWith("x-llm-router-")) continue;
    headers.set(name, value);
  }

  return headers;
}

export function createAmpGeminiStreamResponse(payload, status = 200) {
  return new Response(createAmpGeminiSseChunk(payload), {
    status,
    headers: copyRouterDebugHeaders(null, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    })
  });
}

function normalizeDeltaTextParts(content) {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }

  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string" && item.text) {
      parts.push({ text: item.text });
    }
  }
  return parts;
}

function tryParseNumber(value) {
  if (value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readQuotedStringToken(chars, startIndex) {
  if (chars[startIndex] !== '"') return null;
  let index = startIndex + 1;
  let escaped = false;
  while (index < chars.length) {
    const char = chars[index];
    if (char === "\\" && !escaped) {
      escaped = true;
      index += 1;
      continue;
    }
    if (char === '"' && !escaped) {
      return {
        token: chars.slice(startIndex, index + 1).join(""),
        nextIndex: index + 1
      };
    }
    escaped = false;
    index += 1;
  }
  return {
    token: chars.slice(startIndex).join(""),
    nextIndex: chars.length
  };
}

function parseJsonStringToken(token) {
  try {
    return JSON.parse(token);
  } catch {
    return token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
  }
}

function captureBalancedSegment(chars, startIndex) {
  const startChar = chars[startIndex];
  const endChar = startChar === "{" ? "}" : (startChar === "[" ? "]" : "");
  if (!endChar) return null;

  let index = startIndex;
  let depth = 0;
  let inString = false;
  let escaped = false;

  while (index < chars.length) {
    const char = chars[index];
    if (inString) {
      if (char === "\\" && !escaped) {
        escaped = true;
        index += 1;
        continue;
      }
      if (char === '"' && !escaped) {
        inString = false;
      } else {
        escaped = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      index += 1;
      continue;
    }

    if (char === startChar) {
      depth += 1;
    } else if (char === endChar) {
      depth -= 1;
      if (depth === 0) {
        return {
          segment: chars.slice(startIndex, index + 1).join(""),
          nextIndex: index + 1
        };
      }
    }

    index += 1;
  }

  return {
    segment: chars.slice(startIndex).join(""),
    nextIndex: chars.length
  };
}

function tolerantParseObjectString(input) {
  const raw = String(input || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return {};

  const chars = Array.from(raw.slice(start + 1, end));
  const result = {};
  let index = 0;

  while (index < chars.length) {
    while (index < chars.length && /[\s,]/.test(chars[index])) index += 1;
    if (index >= chars.length) break;

    if (chars[index] !== '"') {
      while (index < chars.length && chars[index] !== ",") index += 1;
      continue;
    }

    const keyToken = readQuotedStringToken(chars, index);
    if (!keyToken) break;
    const key = parseJsonStringToken(keyToken.token);
    index = keyToken.nextIndex;

    while (index < chars.length && /\s/.test(chars[index])) index += 1;
    if (index >= chars.length || chars[index] !== ":") break;
    index += 1;
    while (index < chars.length && /\s/.test(chars[index])) index += 1;
    if (index >= chars.length) break;

    const char = chars[index];
    if (char === '"') {
      const valueToken = readQuotedStringToken(chars, index);
      result[key] = valueToken ? parseJsonStringToken(valueToken.token) : "";
      index = valueToken ? valueToken.nextIndex : chars.length;
    } else if (char === "{" || char === "[") {
      const segment = captureBalancedSegment(chars, index);
      const segmentText = segment?.segment || "";
      try {
        result[key] = JSON.parse(segmentText);
      } catch {
        result[key] = segmentText;
      }
      index = segment ? segment.nextIndex : chars.length;
    } else {
      let endIndex = index;
      while (endIndex < chars.length && chars[endIndex] !== ",") endIndex += 1;
      const token = chars.slice(index, endIndex).join("").trim();
      if (token === "true") {
        result[key] = true;
      } else if (token === "false") {
        result[key] = false;
      } else if (token === "null") {
        result[key] = null;
      } else {
        const number = tryParseNumber(token);
        result[key] = number ?? token;
      }
      index = endIndex;
    }

    while (index < chars.length && /[\s,]/.test(chars[index])) index += 1;
  }

  return result;
}

function parseToolArgumentsObject(value) {
  const text = String(value || "").trim();
  if (!text || text === "{}") return {};

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to tolerant parser.
  }

  return tolerantParseObjectString(text);
}

function accumulateToolCallDelta(state, toolCall) {
  if (!toolCall || typeof toolCall !== "object") return;
  const index = Number.isInteger(toolCall.index) ? toolCall.index : state.toolCalls.size;
  const existing = state.toolCalls.get(index) || { id: "", name: "", argumentsText: "" };
  const id = String(toolCall.id || "").trim();
  const name = String(toolCall.function?.name || "").trim();
  const argumentsText = String(toolCall.function?.arguments || "");

  if (id) existing.id = id;
  if (name) existing.name = name;
  if (argumentsText) existing.argumentsText += argumentsText;

  state.toolCalls.set(index, existing);
}

function flushToolCallAccumulator(state) {
  const parts = [];
  const indexes = [...state.toolCalls.keys()].sort((left, right) => left - right);
  for (const index of indexes) {
    const accumulator = state.toolCalls.get(index);
    if (!accumulator) continue;
    parts.push({
      functionCall: {
        ...(accumulator.id ? { id: accumulator.id } : {}),
        name: accumulator.name || "tool",
        args: parseToolArgumentsObject(accumulator.argumentsText)
      }
    });
  }
  state.toolCalls.clear();
  return parts;
}

function convertOpenAIStreamChunkToGeminiPayloads(openAIChunk, state) {
  const chunk = openAIChunk && typeof openAIChunk === "object" ? openAIChunk : {};
  const payloads = [];

  for (const choice of (Array.isArray(chunk.choices) ? chunk.choices : [])) {
    const delta = choice?.delta && typeof choice.delta === "object" ? choice.delta : null;
    if (delta) {
      const reasoning = String(delta.reasoning_content || "").trim();
      if (reasoning) {
        payloads.push({
          candidates: [{
            content: {
              role: "model",
              parts: [{ thought: true, text: reasoning }]
            }
          }]
        });
      }

      const textParts = normalizeDeltaTextParts(delta.content);
      if (textParts.length > 0) {
        payloads.push({
          candidates: [{
            content: {
              role: "model",
              parts: textParts
            }
          }]
        });
      }

      for (const toolCall of (Array.isArray(delta.tool_calls) ? delta.tool_calls : [])) {
        accumulateToolCallDelta(state, toolCall);
      }
    }

    if (choice?.finish_reason) {
      const toolParts = flushToolCallAccumulator(state);
      const candidate = {
        finishReason: mapOpenAIFinishReason(choice.finish_reason),
        ...(toolParts.length > 0
          ? {
              content: {
                role: "model",
                parts: toolParts
              }
            }
          : {})
      };
      payloads.push({ candidates: [candidate] });
    }
  }

  const usageMetadata = buildGeminiUsageMetadata(chunk.usage);
  if (usageMetadata) {
    payloads.push({
      candidates: [],
      usageMetadata
    });
  }

  return payloads;
}

function parseSseEventData(rawEvent) {
  const lines = String(rawEvent || "").split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice(5).trimStart());
  }
  return dataLines.join("\n");
}

function createAmpGeminiStreamResponseFromOpenAIStream(response) {
  if (!(response instanceof Response) || !response.body) {
    return jsonResponse({ error: { message: "Provider did not return a streaming body for AMP Gemini request." } }, 502);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state = {
    toolCalls: new Map()
  };

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body.getReader();
      let buffer = "";

      const emitPayloads = (payloads) => {
        for (const payload of payloads) {
          controller.enqueue(encoder.encode(createAmpGeminiSseChunk(payload)));
        }
      };

      const handleEvent = (rawEvent) => {
        const eventData = parseSseEventData(rawEvent);
        if (!eventData || eventData === "[DONE]") return;

        let parsed;
        try {
          parsed = JSON.parse(eventData);
        } catch {
          return;
        }

        emitPayloads(convertOpenAIStreamChunkToGeminiPayloads(parsed, state));
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          while (true) {
            const separatorIndex = buffer.indexOf("\n\n");
            if (separatorIndex < 0) break;
            const rawEvent = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            handleEvent(rawEvent);
          }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
          handleEvent(buffer);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Ignore reader cleanup errors.
        }
      }
    }
  });

  return new Response(stream, {
    status: response.status,
    headers: copyRouterDebugHeaders(response, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    })
  });
}

export async function adaptOpenAIResponseToAmpGeminiResponse(response, { stream = false } = {}) {
  if (stream) {
    return createAmpGeminiStreamResponseFromOpenAIStream(response);
  }

  let payload;
  try {
    payload = convertOpenAIResponseToAmpGeminiPayload(await response.json());
  } catch {
    return jsonResponse({ error: { message: "Provider returned invalid JSON for AMP Gemini response." } }, 502);
  }

  return new Response(JSON.stringify(payload), {
    status: response.status,
    headers: copyRouterDebugHeaders(response, {
      "Content-Type": "application/json"
    })
  });
}

function buildGeminiModelRow(row) {
  return {
    name: `models/${row.id}`,
    baseModelId: row.id,
    displayName: row.id,
    description: `${row.provider_name || row.provider_id || "provider"} / ${row.id}`,
    supportedGenerationMethods: [...GEMINI_SUPPORTED_METHODS]
  };
}

export function buildAmpGeminiModelsPayload(config) {
  const seen = new Set();
  const models = [];

  for (const row of listConfiguredModels(config)) {
    const id = String(row?.id || "").split("/").slice(1).join("/") || String(row?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(buildGeminiModelRow({ ...row, id }));
  }

  return { models };
}

export function buildAmpGeminiModelPayload(config, modelId) {
  const payload = buildAmpGeminiModelsPayload(config);
  const requested = String(modelId || "").trim();
  const target = payload.models.find((row) => row.name === `models/${requested}` || row.baseModelId === requested);
  if (target) return target || null;
  if (!requested) return null;

  const resolved = resolveRequestModel(config, requested, FORMATS.OPENAI, {
    clientType: "amp",
    providerHint: "google"
  });
  if (!resolved?.primary) return null;

  const targetModelId = String(resolved.primary.requestModelId || resolved.resolvedModel || "").split("/").slice(1).join("/")
    || String(resolved.primary.requestModelId || resolved.resolvedModel || "");
  const fallback = payload.models.find((row) => row.name === `models/${targetModelId}` || row.baseModelId === targetModelId);
  if (!fallback) return null;

  let reason = "route fallback";
  if (resolved.routeType === "amp-default-model") reason = "defaultModel fallback";
  if (resolved.routeType === "amp-subagent") {
    const names = Array.isArray(resolved.routeMetadata?.amp?.subagents) ? resolved.routeMetadata.amp.subagents.join(", ") : "subagent";
    reason = `subagent mapping (${names})`;
  }

  return {
    ...fallback,
    name: `models/${requested}` ,
    baseModelId: requested,
    displayName: requested,
    description: `${fallback.description} (${reason} -> ${targetModelId})`
  };
}
