/**
 * Sanitizes tool names that contain characters rejected by OpenAI-compatible APIs.
 * Pattern: ^[a-zA-Z0-9_-]+$
 *
 * Applies sanitization to the request body before sending to the provider,
 * and reverse-maps tool names in the response so the client receives original names.
 */

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

function sanitizeName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Scan body.tools for names needing sanitization.
 * Returns Map<sanitizedName, originalName> or null if none needed.
 */
export function buildToolNameMap(body) {
  if (!body || !Array.isArray(body.tools) || body.tools.length === 0) return null;

  const map = new Map();
  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") continue;
    const name = typeof tool.function?.name === "string"
      ? tool.function.name
      : typeof tool.name === "string" ? tool.name : "";
    if (name && !VALID_TOOL_NAME.test(name)) {
      const sanitized = sanitizeName(name);
      if (!map.has(sanitized)) {
        map.set(sanitized, name);
      }
    }
  }
  return map.size > 0 ? map : null;
}

function applySanitizationToName(name, nameMap) {
  if (typeof name !== "string" || !name) return name;
  const sanitized = sanitizeName(name);
  return nameMap.has(sanitized) ? sanitized : name;
}

/**
 * Return a shallow-cloned body with every matching tool name replaced.
 * Covers: tools[], tool_choice, input[] (Responses API), messages[] (Chat Completions).
 */
export function sanitizeBodyToolNames(body, nameMap) {
  if (!nameMap || nameMap.size === 0 || !body) return body;

  const result = { ...body };

  // 1. Tool definitions
  if (Array.isArray(result.tools)) {
    result.tools = result.tools.map((tool) => {
      if (!tool || typeof tool !== "object") return tool;
      if (tool.function && typeof tool.function.name === "string" && !VALID_TOOL_NAME.test(tool.function.name)) {
        return { ...tool, function: { ...tool.function, name: applySanitizationToName(tool.function.name, nameMap) } };
      }
      if (typeof tool.name === "string" && !VALID_TOOL_NAME.test(tool.name)) {
        return { ...tool, name: applySanitizationToName(tool.name, nameMap) };
      }
      return tool;
    });
  }

  // 2. tool_choice
  if (result.tool_choice && typeof result.tool_choice === "object") {
    const choiceName = result.tool_choice.function?.name || result.tool_choice.name;
    if (typeof choiceName === "string" && !VALID_TOOL_NAME.test(choiceName)) {
      if (result.tool_choice.function) {
        result.tool_choice = { ...result.tool_choice, function: { ...result.tool_choice.function, name: applySanitizationToName(choiceName, nameMap) } };
      } else {
        result.tool_choice = { ...result.tool_choice, name: applySanitizationToName(choiceName, nameMap) };
      }
    }
  }

  // 3. Responses API input — function_call items carry name
  if (Array.isArray(result.input)) {
    result.input = result.input.map((item) => {
      if (item?.type === "function_call" && typeof item.name === "string" && !VALID_TOOL_NAME.test(item.name)) {
        return { ...item, name: applySanitizationToName(item.name, nameMap) };
      }
      return item;
    });
  }

  // 4. Chat Completions messages — assistant tool_calls carry function.name
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map((msg) => {
      if (!Array.isArray(msg?.tool_calls)) return msg;
      const toolCalls = msg.tool_calls.map((tc) => {
        if (tc?.function && typeof tc.function.name === "string" && !VALID_TOOL_NAME.test(tc.function.name)) {
          return { ...tc, function: { ...tc.function, name: applySanitizationToName(tc.function.name, nameMap) } };
        }
        return tc;
      });
      return { ...msg, tool_calls: toolCalls };
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Response reverse-mapping
// ---------------------------------------------------------------------------

function reverseNameInParsed(parsed, nameMap) {
  if (!parsed || typeof parsed !== "object") return parsed;

  // OpenAI Chat Completions: choices[].delta.tool_calls[].function.name
  if (Array.isArray(parsed.choices)) {
    for (const choice of parsed.choices) {
      for (const tc of (choice?.message?.tool_calls || choice?.delta?.tool_calls || [])) {
        if (tc?.function?.name && nameMap.has(tc.function.name)) {
          tc.function.name = nameMap.get(tc.function.name);
        }
      }
    }
  }

  // Responses API: output[].name or top-level name for streaming events
  if (Array.isArray(parsed.output)) {
    for (const item of parsed.output) {
      if (item?.type === "function_call" && nameMap.has(item.name)) {
        item.name = nameMap.get(item.name);
      }
    }
  }
  // Streaming events: response.output_item.added → item.name
  if (parsed.item?.type === "function_call" && nameMap.has(parsed.item.name)) {
    parsed.item = { ...parsed.item, name: nameMap.get(parsed.item.name) };
  }
  // Streaming event: response.function_call_arguments.done → name
  if (typeof parsed.name === "string" && nameMap.has(parsed.name) && (parsed.type || "").includes("function_call")) {
    parsed.name = nameMap.get(parsed.name);
  }

  // Responses API completed response embedded in streaming
  if (parsed.response && Array.isArray(parsed.response.output)) {
    for (const item of parsed.response.output) {
      if (item?.type === "function_call" && nameMap.has(item.name)) {
        item.name = nameMap.get(item.name);
      }
    }
  }

  // Claude: content[].name for tool_use blocks
  if (Array.isArray(parsed.content)) {
    for (const block of parsed.content) {
      if (block?.type === "tool_use" && nameMap.has(block.name)) {
        block.name = nameMap.get(block.name);
      }
    }
  }
  // Claude streaming: content_block_start → content_block.name
  if (parsed.content_block?.type === "tool_use" && nameMap.has(parsed.content_block.name)) {
    parsed.content_block = { ...parsed.content_block, name: nameMap.get(parsed.content_block.name) };
  }

  return parsed;
}

/**
 * Wrap a Response so tool names are reversed.
 * For streaming: TransformStream over SSE events.
 * For non-streaming: buffer, parse JSON, replace, re-serialize.
 */
export function reverseToolNamesInResponse(response, nameMap, isStream) {
  if (!nameMap || nameMap.size === 0 || !(response instanceof Response)) return response;
  if (!response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Build a quick-check set of sanitized names for fast rejection
  const sanitizedNames = [...nameMap.keys()];

  if (isStream) {
    let buffer = "";
    const transformStream = new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundaryIndex;
        while ((boundaryIndex = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);
          controller.enqueue(encoder.encode(processBlock(block, sanitizedNames, nameMap) + "\n\n"));
        }
      },
      flush(controller) {
        if (buffer.trim()) {
          controller.enqueue(encoder.encode(processBlock(buffer, sanitizedNames, nameMap)));
        }
      }
    });

    return new Response(response.body.pipeThrough(transformStream), {
      status: response.status,
      headers: response.headers
    });
  }

  // Non-streaming: buffer the whole body, parse, reverse, re-serialize.
  const { readable, writable } = new TransformStream();
  (async () => {
    const writer = writable.getWriter();
    try {
      let text = "";
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      if (!sanitizedNames.some((n) => text.includes(n))) {
        writer.write(encoder.encode(text));
      } else {
        try {
          const parsed = JSON.parse(text);
          reverseNameInParsed(parsed, nameMap);
          writer.write(encoder.encode(JSON.stringify(parsed)));
        } catch {
          writer.write(encoder.encode(text));
        }
      }
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    status: response.status,
    headers: response.headers
  });
}

function processBlock(block, sanitizedNames, nameMap) {
  // Quick-check: skip parsing if no sanitized name appears in the block
  if (!sanitizedNames.some((n) => block.includes(n))) return block;

  // Extract data lines from SSE block
  const lines = block.split("\n");
  return lines.map((line) => {
    if (!line.startsWith("data:")) return line;
    const jsonStr = line.slice(5).trimStart();
    if (jsonStr === "[DONE]") return line;
    try {
      const parsed = JSON.parse(jsonStr);
      reverseNameInParsed(parsed, nameMap);
      return `data: ${JSON.stringify(parsed)}`;
    } catch {
      return line;
    }
  }).join("\n");
}
