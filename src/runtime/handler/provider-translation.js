import { FORMATS, initState, translateResponse } from "../../translator/index.js";
import {
  claudeEventToOpenAIChunks,
  initClaudeToOpenAIState
} from "../../translator/response/claude-to-openai.js";
import { withCorsHeaders } from "./http.js";

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
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    default:
      return "end_turn";
  }
}

export function convertOpenAINonStreamToClaude(result, fallbackModel = "unknown") {
  const choice = result?.choices?.[0];
  const message = choice?.message || {};
  const content = [
    ...normalizeOpenAIContent(message.content)
  ];

  if (Array.isArray(message.tool_calls)) {
    for (let index = 0; index < message.tool_calls.length; index += 1) {
      const call = message.tool_calls[index];
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
    stop_reason: convertOpenAIFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: result?.usage?.prompt_tokens || 0,
      output_tokens: result?.usage?.completion_tokens || 0
    }
  };
}

function formatClaudeEvent(event) {
  const eventType = event.type || "message";
  return `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function handleOpenAIStreamToClaude(response) {
  const state = initState(FORMATS.CLAUDE);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = "";

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();

        if (data === "[DONE]") {
          controller.enqueue(encoder.encode("event: message_stop\ndata: {}\n\n"));
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const translated = translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, parsed, state);
          for (const event of translated) {
            controller.enqueue(encoder.encode(formatClaudeEvent(event)));
          }
        } catch (error) {
          console.error("[Stream] Failed parsing OpenAI chunk:", error instanceof Error ? error.message : String(error));
        }
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
