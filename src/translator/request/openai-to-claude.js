/**
 * OpenAI -> Claude request translator.
 */

const DEFAULT_MAX_TOKENS = 1024;

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
      if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
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
      blocks.push({ type: "text", text: part.text });
      continue;
    }

    if (part.type === "image_url" && part.image_url?.url) {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mediaType,
            data: parsed.data
          }
        });
      } else {
        // Claude image blocks do not accept remote URLs directly.
        blocks.push({
          type: "text",
          text: `[image_url:${part.image_url.url}]`
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
  const parts = [];
  if (typeof explicitSystem === "string" && explicitSystem.trim()) {
    parts.push(explicitSystem);
  } else if (Array.isArray(explicitSystem)) {
    for (const item of explicitSystem) {
      if (item?.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      }
    }
  }

  for (const message of messages) {
    if (message?.role !== "system") continue;
    const text = normalizeTextContent(message.content);
    if (text) parts.push(text);
  }

  return parts.join("\n").trim();
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
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content
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

/**
 * Convert OpenAI chat completion request to Claude messages request.
 */
export function openAIToClaudeRequest(model, body, stream = false) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const result = {
    model,
    messages: convertOpenAIMessages(messages),
    stream: Boolean(stream),
    max_tokens: Number.isFinite(body?.max_tokens)
      ? Number(body.max_tokens)
      : (Number.isFinite(body?.max_completion_tokens) ? Number(body.max_completion_tokens) : DEFAULT_MAX_TOKENS)
  };

  const system = normalizeSystemText(messages, body?.system);
  if (system) {
    result.system = system;
  }

  if (body?.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  if (Array.isArray(body?.tools)) {
    result.tools = body.tools
      .map((tool) => {
        if (!tool || typeof tool !== "object") return null;
        if (tool.type === "function" && tool.function) {
          return {
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters || { type: "object", properties: {} }
          };
        }
        if (tool.name) {
          return {
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema || { type: "object", properties: {} }
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

  return result;
}
