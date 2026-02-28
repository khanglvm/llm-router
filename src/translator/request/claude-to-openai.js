/**
 * Claude (Anthropic) -> OpenAI Request Translator
 */

import { FORMATS } from "../formats.js";

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

function convertClaudeSystemToOpenAIContent(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return null;

  const parts = [];
  for (const block of system) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const cacheControl = cloneCacheControl(block.cache_control);
    parts.push({
      type: "text",
      text: block.text,
      ...(cacheControl ? { cache_control: cacheControl } : {})
    });
  }

  if (parts.length === 0) return null;
  const hasMetadata = parts.some((part) => Boolean(part.cache_control));
  if (!hasMetadata && parts.length === 1) {
    return parts[0].text;
  }
  return parts;
}

/**
 * Convert Claude request to OpenAI format
 */
export function claudeToOpenAIRequest(model, body, stream) {
  const result = {
    model: model,
    messages: [],
    stream: stream
  };

  // Max tokens
  if (body.max_tokens) {
    result.max_tokens = body.max_tokens;
  }

  // Temperature
  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  // System message
  const systemContent = convertClaudeSystemToOpenAIContent(body.system);
  if (systemContent !== null && systemContent !== "") {
    result.messages.push({
      role: "system",
      content: systemContent
    });
  }

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const converted = convertClaudeMessage(msg);
      if (converted) {
        if (Array.isArray(converted)) {
          result.messages.push(...converted);
        } else {
          result.messages.push(converted);
        }
      }
    }
  }

  // Fix missing tool responses
  fixMissingToolResponses(result.messages);

  // Tools
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => {
      const cacheControl = cloneCacheControl(tool.cache_control);
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema || { type: "object", properties: {} }
        },
        ...(cacheControl ? { cache_control: cacheControl } : {})
      };
    });
  }

  // Tool choice
  if (body.tool_choice) {
    result.tool_choice = convertToolChoice(body.tool_choice);
  }

  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) {
    result.prompt_cache_key = body.prompt_cache_key.trim();
  }
  if (typeof body.prompt_cache_retention === "string" && body.prompt_cache_retention.trim()) {
    result.prompt_cache_retention = body.prompt_cache_retention.trim();
  }
  const topLevelCacheControl = cloneCacheControl(body.cache_control);
  if (topLevelCacheControl) {
    result.cache_control = topLevelCacheControl;
  }

  return result;
}

/**
 * Fix missing tool responses
 */
function fixMissingToolResponses(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCallIds = msg.tool_calls.map(tc => tc.id);
      const respondedIds = new Set();
      let insertPosition = i + 1;
      
      for (let j = i + 1; j < messages.length; j++) {
        const nextMsg = messages[j];
        if (nextMsg.role === "tool" && nextMsg.tool_call_id) {
          respondedIds.add(nextMsg.tool_call_id);
          insertPosition = j + 1;
        } else {
          break;
        }
      }
      
      const missingIds = toolCallIds.filter(id => !respondedIds.has(id));
      
      if (missingIds.length > 0) {
        const missingResponses = missingIds.map(id => ({
          role: "tool",
          tool_call_id: id,
          content: "[No response received]"
        }));
        messages.splice(insertPosition, 0, ...missingResponses);
        i = insertPosition + missingResponses.length - 1;
      }
    }
  }
}

/**
 * Convert single Claude message
 */
function convertClaudeMessage(msg) {
  const role = msg.role === "user" || msg.role === "tool" ? "user" : "assistant";
  
  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }

  if (Array.isArray(msg.content)) {
    const parts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          {
            const cacheControl = cloneCacheControl(block.cache_control);
            parts.push({
              type: "text",
              text: block.text,
              ...(cacheControl ? { cache_control: cacheControl } : {})
            });
          }
          break;

        case "image":
          if (block.source?.type === "base64") {
            const cacheControl = cloneCacheControl(block.cache_control);
            parts.push({
              type: "image_url",
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`
              },
              ...(cacheControl ? { cache_control: cacheControl } : {})
            });
          }
          break;

        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {})
            }
          });
          break;

        case "tool_result":
          let resultContent = "";
          if (typeof block.content === "string") {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            resultContent = block.content
              .filter(c => c.type === "text")
              .map(c => c.text)
              .join("\n") || JSON.stringify(block.content);
          } else if (block.content) {
            resultContent = JSON.stringify(block.content);
          }
          
          {
            const cacheControl = cloneCacheControl(block.cache_control);
            toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: resultContent,
            ...(cacheControl ? { cache_control: cacheControl } : {})
          });
          }
          break;
      }
    }

    if (toolResults.length > 0) {
      if (parts.length > 0) {
        const textContent = parts.length === 1 && parts[0].type === "text" 
          ? parts[0].text 
          : parts;
        return [...toolResults, { role: "user", content: textContent }];
      }
      return toolResults;
    }

    if (toolCalls.length > 0) {
      const result = { role: "assistant" };
      if (parts.length > 0) {
        const hasMetadata = parts.some((part) => Boolean(part.cache_control));
        result.content = parts.length === 1 && parts[0].type === "text" && !hasMetadata
          ? parts[0].text 
          : parts;
      }
      result.tool_calls = toolCalls;
      return result;
    }

    if (parts.length > 0) {
      const hasMetadata = parts.some((part) => Boolean(part.cache_control));
      return {
        role,
        content: parts.length === 1 && parts[0].type === "text" && !hasMetadata ? parts[0].text : parts
      };
    }
    
    if (msg.content.length === 0) {
      return { role, content: "" };
    }
  }

  return null;
}

/**
 * Convert tool choice
 */
function convertToolChoice(choice) {
  if (!choice) return "auto";
  if (typeof choice === "string") return choice;
  
  switch (choice.type) {
    case "auto": return "auto";
    case "any": return "required";
    case "tool": return { type: "function", function: { name: choice.name } };
    default: return "auto";
  }
}
