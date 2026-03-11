/**
 * OpenAI -> Claude request translator.
 */

const DEFAULT_MAX_TOKENS = 1024;

function cloneCacheControl(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const type = typeof value.type === "string" ? value.type.trim() : "";
  if (!type) return undefined;
  const next = { type };
  if (typeof value.ttl === "string" && value.ttl.trim()) {
    next.ttl = value.ttl.trim();
  }
  return next;
}

function safeJsonParse(raw, fallback = {}) {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
        text.push(part.text);
      }
    }
    return text.join("\n");
  }
  return "";
}

function parseDataUrl(url) {
  if (typeof url !== "string") return null;
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mediaType: match[1],
    data: match[2]
  };
}

function convertOpenAIContentToClaudeBlocks(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
      const cacheControl = cloneCacheControl(part.cache_control);
      blocks.push({
        type: "text",
        text: part.text,
        ...(cacheControl ? { cache_control: cacheControl } : {})
      });
      continue;
    }

    if (part.type === "image_url" && part.image_url?.url) {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) {
        const cacheControl = cloneCacheControl(part.cache_control);
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mediaType,
            data: parsed.data
          },
          ...(cacheControl ? { cache_control: cacheControl } : {})
        });
      } else {
        // Claude image blocks do not accept remote URLs directly.
        const cacheControl = cloneCacheControl(part.cache_control);
        blocks.push({
          type: "text",
          text: `[image_url:${part.image_url.url}]`,
          ...(cacheControl ? { cache_control: cacheControl } : {})
        });
      }
      continue;
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return blocks;
}

function appendClaudeMessage(messages, role, blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return;
  const normalizedRole = role === "assistant" ? "assistant" : "user";
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === normalizedRole && Array.isArray(lastMessage.content)) {
    lastMessage.content.push(...blocks);
    return;
  }
  messages.push({
    role: normalizedRole,
    content: blocks
  });
}

function convertResponsesMessageContentToClaudeBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      const cacheControl = cloneCacheControl(part.cache_control);
      blocks.push({
        type: "text",
        text: part.text,
        ...(cacheControl ? { cache_control: cacheControl } : {})
      });
      continue;
    }

    const rawImageUrl = typeof part.image_url === "string"
      ? part.image_url
      : part.image_url?.url;
    if ((part.type === "image_url" || part.type === "input_image") && typeof rawImageUrl === "string" && rawImageUrl.trim()) {
      const parsed = parseDataUrl(rawImageUrl.trim());
      const cacheControl = cloneCacheControl(part.cache_control);
      if (parsed) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mediaType,
            data: parsed.data
          },
          ...(cacheControl ? { cache_control: cacheControl } : {})
        });
      } else {
        blocks.push({
          type: "text",
          text: `[image_url:${rawImageUrl.trim()}]`,
          ...(cacheControl ? { cache_control: cacheControl } : {})
        });
      }
      continue;
    }

    const rawFileUrl = typeof part.file_url === "string"
      ? part.file_url
      : (typeof part.url === "string" ? part.url : "");
    if (part.type === "input_file" && rawFileUrl.trim()) {
      const cacheControl = cloneCacheControl(part.cache_control);
      blocks.push({
        type: "text",
        text: `[input_file:${rawFileUrl.trim()}]`,
        ...(cacheControl ? { cache_control: cacheControl } : {})
      });
    }
  }

  return blocks;
}

function normalizeResponseInputArray(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === "string" && input.trim()) {
    return [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: input.trim() }]
    }];
  }
  return [];
}

function extractResponsesSystem(body) {
  const blocks = [];
  const pushText = (text) => {
    if (typeof text !== "string" || !text.trim()) return;
    blocks.push({ type: "text", text: text.trim() });
  };

  if (typeof body?.instructions === "string" && body.instructions.trim()) {
    pushText(body.instructions);
  }

  const explicitSystem = body?.system;
  if (typeof explicitSystem === "string" && explicitSystem.trim()) {
    pushText(explicitSystem);
  } else if (Array.isArray(explicitSystem)) {
    for (const item of explicitSystem) {
      if ((item?.type === "text" || item?.type === "input_text" || item?.type === "output_text") && typeof item.text === "string") {
        pushText(item.text);
      }
    }
  }

  for (const item of normalizeResponseInputArray(body?.input)) {
    if (!item || typeof item !== "object") continue;
    const role = String(item.role || "").trim().toLowerCase();
    if (role !== "system" && role !== "developer") continue;
    const text = normalizeTextContent(item.content);
    if (text) pushText(text);
  }

  if (blocks.length === 0) return "";
  return blocks.map((block) => block.text).join("\n").trim();
}

function convertOpenAIResponsesInput(input) {
  const messages = [];
  const items = normalizeResponseInputArray(input);
  let generatedToolIndex = 0;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const itemType = String(item.type || (item.role ? "message" : "")).trim().toLowerCase();
    if (itemType === "message") {
      const role = String(item.role || "user").trim().toLowerCase();
      if (role === "system" || role === "developer") {
        continue;
      }
      const blocks = convertResponsesMessageContentToClaudeBlocks(item.content);
      if (blocks.length > 0) {
        appendClaudeMessage(messages, role === "assistant" ? "assistant" : "user", blocks);
      }
      continue;
    }

    if (itemType === "function_call") {
      const callId = String(item.call_id || item.id || `tool_call_${generatedToolIndex += 1}`).trim();
      const name = String(item.name || "tool").trim() || "tool";
      appendClaudeMessage(messages, "assistant", [{
        type: "tool_use",
        id: callId,
        name,
        input: safeJsonParse(item.arguments, {})
      }]);
      continue;
    }

    if (itemType === "function_call_output") {
      const toolUseId = String(item.call_id || item.tool_call_id || item.id || "").trim();
      if (!toolUseId) continue;
      const content = normalizeTextContent(item.output ?? item.content);
      appendClaudeMessage(messages, "user", [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content
      }]);
    }
  }

  return messages;
}

function mapToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    if (choice === "required") return { type: "any" };
    if (choice === "none") return { type: "auto" };
    return { type: "auto" };
  }

  if (choice.type === "function") {
    return {
      type: "tool",
      name: choice.function?.name
    };
  }

  if (choice.type === "auto") return { type: "auto" };
  if (choice.type === "any") return { type: "any" };
  if (choice.type === "tool") return { type: "tool", name: choice.name };

  return { type: "auto" };
}

function normalizeSystemText(messages, explicitSystem) {
  const blocks = [];
  const pushBlock = (text, cacheControl = undefined) => {
    if (typeof text !== "string" || text.length === 0) return;
    blocks.push({
      type: "text",
      text,
      ...(cacheControl ? { cache_control: cacheControl } : {})
    });
  };

  if (typeof explicitSystem === "string" && explicitSystem.trim()) {
    pushBlock(explicitSystem);
  } else if (Array.isArray(explicitSystem)) {
    for (const item of explicitSystem) {
      if ((item?.type === "text" || item?.type === "input_text") && typeof item.text === "string") {
        pushBlock(item.text, cloneCacheControl(item.cache_control));
      }
    }
  }

  for (const message of messages) {
    if (message?.role !== "system") continue;
    if (typeof message.content === "string") {
      if (message.content) {
        pushBlock(message.content, cloneCacheControl(message.cache_control));
      }
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if ((item?.type === "text" || item?.type === "input_text") && typeof item.text === "string") {
          pushBlock(item.text, cloneCacheControl(item.cache_control));
        }
      }
      continue;
    }
    const text = normalizeTextContent(message.content);
    if (text) pushBlock(text, cloneCacheControl(message.cache_control));
  }

  if (blocks.length === 0) return "";
  const hasMetadata = blocks.some((block) => Boolean(block.cache_control));
  if (!hasMetadata) {
    return blocks.map((block) => block.text).join("\n").trim();
  }
  return blocks;
}

function convertOpenAIMessages(messages) {
  const result = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "system") {
      continue;
    }

    if (message.role === "tool") {
      const toolUseId = message.tool_call_id || message.tool_use_id;
      if (!toolUseId) continue;

      const content = normalizeTextContent(message.content);
      const cacheControl = cloneCacheControl(message.cache_control);
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content,
            ...(cacheControl ? { cache_control: cacheControl } : {})
          }
        ]
      });
      continue;
    }

    if (message.role === "assistant") {
      const contentBlocks = convertOpenAIContentToClaudeBlocks(message.content);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

      for (const call of toolCalls) {
        if (!call || typeof call !== "object") continue;
        contentBlocks.push({
          type: "tool_use",
          id: call.id || `tool_${Date.now()}`,
          name: call.function?.name || "tool",
          input: safeJsonParse(call.function?.arguments, {})
        });
      }

      result.push({
        role: "assistant",
        content: contentBlocks
      });
      continue;
    }

    // default user role
    result.push({
      role: "user",
      content: convertOpenAIContentToClaudeBlocks(message.content)
    });
  }

  return result;
}

function normalizeToolInputSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  const normalized = { ...schema };
  if (normalized.type === "object") {
    if (!normalized.properties || typeof normalized.properties !== "object" || Array.isArray(normalized.properties)) {
      normalized.properties = {};
    }
  }

  return normalized;
}

function isOpenAIWebSearchToolType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (!normalized) return false;
  return normalized === "web_search" || normalized.startsWith("web_search_preview");
}

function convertOpenAIWebSearchTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  const name = typeof tool.name === "string" && tool.name.trim()
    ? tool.name.trim()
    : "web_search";
  const maxUses = Number(tool.max_uses);
  return {
    type: "web_search_20250305",
    name,
    ...(Number.isFinite(maxUses) && maxUses > 0 ? { max_uses: Math.trunc(maxUses) } : {})
  };
}

/**
 * Convert OpenAI chat completion request to Claude messages request.
 */
export function openAIToClaudeRequest(model, body, stream = false) {
  const isResponsesPayload = body?.input !== undefined || body?.instructions !== undefined;
  const messages = isResponsesPayload
    ? convertOpenAIResponsesInput(body?.input)
    : convertOpenAIMessages(Array.isArray(body?.messages) ? body.messages : []);
  const result = {
    model,
    messages,
    stream: Boolean(stream),
    max_tokens: Number.isFinite(body?.max_output_tokens)
      ? Number(body.max_output_tokens)
      : (Number.isFinite(body?.max_tokens)
      ? Number(body.max_tokens)
      : (Number.isFinite(body?.max_completion_tokens) ? Number(body.max_completion_tokens) : DEFAULT_MAX_TOKENS))
  };

  const system = isResponsesPayload
    ? extractResponsesSystem(body)
    : normalizeSystemText(Array.isArray(body?.messages) ? body.messages : [], body?.system);
  if (system && ((Array.isArray(system) && system.length > 0) || (typeof system === "string" && system.trim()))) {
    result.system = system;
  }

  if (body?.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  if (Array.isArray(body?.tools)) {
    result.tools = body.tools
      .map((tool) => {
        if (!tool || typeof tool !== "object") return null;
        if (isOpenAIWebSearchToolType(tool.type)) {
          return convertOpenAIWebSearchTool(tool);
        }
        if (tool.type === "function" && tool.function) {
          const cacheControl = cloneCacheControl(tool.cache_control || tool.function?.cache_control);
          return {
            name: tool.function.name,
            description: tool.function.description,
            input_schema: normalizeToolInputSchema(tool.function.parameters),
            ...(cacheControl ? { cache_control: cacheControl } : {})
          };
        }
        if (tool.type === "function" && tool.name) {
          const cacheControl = cloneCacheControl(tool.cache_control);
          return {
            name: tool.name,
            description: tool.description,
            input_schema: normalizeToolInputSchema(tool.parameters),
            ...(cacheControl ? { cache_control: cacheControl } : {})
          };
        }
        if (tool.name) {
          const cacheControl = cloneCacheControl(tool.cache_control);
          return {
            name: tool.name,
            description: tool.description,
            input_schema: normalizeToolInputSchema(tool.input_schema),
            ...(cacheControl ? { cache_control: cacheControl } : {})
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  const mappedChoice = mapToolChoice(body?.tool_choice);
  if (mappedChoice) {
    result.tool_choice = mappedChoice;
  }

  const topLevelCacheControl = cloneCacheControl(body?.cache_control);
  if (topLevelCacheControl) {
    result.cache_control = topLevelCacheControl;
  }

  return result;
}
