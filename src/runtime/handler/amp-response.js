import { withCorsHeaders } from "./http.js";

const AMP_MODEL_FIELD_PATHS = [
  ["model"],
  ["message", "model"],
  ["response", "model"],
  ["modelVersion"],
  ["response", "modelVersion"]
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readAmpVisibleModel(requestBody) {
  return typeof requestBody?.model === "string" ? requestBody.model.trim() : "";
}

function setPathIfPresent(payload, path, value) {
  if (!isPlainObject(payload) || !Array.isArray(path) || path.length === 0) return false;
  let cursor = payload;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!isPlainObject(cursor?.[path[index]])) return false;
    cursor = cursor[path[index]];
  }

  const key = path[path.length - 1];
  if (typeof cursor?.[key] !== "string") return false;
  if (cursor[key] === value) return false;
  cursor[key] = value;
  return true;
}

function rewriteAmpModelFields(payload, visibleModel) {
  if (!visibleModel) return false;
  let changed = false;
  for (const path of AMP_MODEL_FIELD_PATHS) {
    changed = setPathIfPresent(payload, path, visibleModel) || changed;
  }
  return changed;
}

function stripClaudeThinkingBlocks(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.content)) return false;
  const hasToolUse = payload.content.some((block) => block?.type === "tool_use");
  if (!hasToolUse) return false;

  const filtered = payload.content.filter(
    (block) => block?.type !== "thinking" && block?.type !== "redacted_thinking"
  );
  if (filtered.length === payload.content.length) return false;
  payload.content = filtered;
  return true;
}

function normalizeClaudeToolUseStopReason(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.content)) return false;
  const hasToolUse = payload.content.some((block) => block?.type === "tool_use");
  if (!hasToolUse) return false;
  if (payload.stop_reason === "tool_use") return false;
  payload.stop_reason = "tool_use";
  return true;
}

function rewriteAmpPayload(payload, visibleModel) {
  if (!isPlainObject(payload)) return false;
  let changed = false;
  changed = rewriteAmpModelFields(payload, visibleModel) || changed;
  changed = normalizeClaudeToolUseStopReason(payload) || changed;
  changed = stripClaudeThinkingBlocks(payload) || changed;
  return changed;
}

function rewriteAmpSseEvent(rawEvent, visibleModel) {
  const lines = String(rawEvent || "").split(/\r?\n/);
  let changed = false;
  const nextLines = lines.map((line) => {
    if (!line.startsWith("data:")) return line;
    const value = line.slice(5).trimStart();
    if (!value || value === "[DONE]") return line;

    try {
      const payload = JSON.parse(value);
      if (!rewriteAmpPayload(payload, visibleModel)) return line;
      changed = true;
      return `data: ${JSON.stringify(payload)}`;
    } catch {
      return line;
    }
  });

  return {
    changed,
    event: `${nextLines.join("\n")}\n\n`
  };
}

const AMP_STREAM_SUPPRESSED_BLOCK_TYPES = new Set([
  "thinking",
  "redacted_thinking"
]);

function parseSseEventBlock(rawEvent) {
  const lines = String(rawEvent || "").split(/\r?\n/);
  let eventName = "";
  const dataLines = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    eventName,
    dataText: dataLines.join("\n").trim()
  };
}

function formatSseEventBlock(eventName, payload) {
  const lines = [];
  if (eventName) {
    lines.push(`event: ${eventName}`);
  }
  lines.push(`data: ${JSON.stringify(payload)}`);
  return `${lines.join("\n")}\n\n`;
}

function rewriteAmpClaudeStreamPayload(state, payload, visibleModel) {
  let changed = rewriteAmpPayload(payload, visibleModel);
  const type = String(payload?.type || "").trim();

  if (type === "content_block_start") {
    const originalIndex = Number(payload.index);
    const blockType = String(payload?.content_block?.type || "").trim();
    if (Number.isFinite(originalIndex) && AMP_STREAM_SUPPRESSED_BLOCK_TYPES.has(blockType)) {
      state.suppressedIndexes.add(originalIndex);
      return {
        changed: false,
        suppressed: true,
        payload
      };
    }

    if (Number.isFinite(originalIndex)) {
      const visibleIndex = state.nextVisibleIndex;
      state.nextVisibleIndex += 1;
      state.visibleIndexByOriginal.set(originalIndex, visibleIndex);
      if (visibleIndex !== originalIndex) {
        payload.index = visibleIndex;
        changed = true;
      }
    }

    return {
      changed,
      suppressed: false,
      payload
    };
  }

  if (type === "content_block_delta" || type === "content_block_stop") {
    const originalIndex = Number(payload.index);
    if (Number.isFinite(originalIndex) && state.suppressedIndexes.has(originalIndex)) {
      return {
        changed: false,
        suppressed: true,
        payload
      };
    }

    const visibleIndex = state.visibleIndexByOriginal.get(originalIndex);
    if (Number.isFinite(visibleIndex) && visibleIndex !== originalIndex) {
      payload.index = visibleIndex;
      changed = true;
    }

    return {
      changed,
      suppressed: false,
      payload
    };
  }

  return {
    changed,
    suppressed: false,
    payload
  };
}

function rewriteAmpStreamResponse(response, visibleModel) {
  if (!(response instanceof Response) || !response.body || !visibleModel) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const claudeStreamState = {
    suppressedIndexes: new Set(),
    visibleIndexByOriginal: new Map(),
    nextVisibleIndex: 0
  };

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body.getReader();

      const emitEvent = (rawEvent) => {
        if (!rawEvent) return;
        const parsedEvent = parseSseEventBlock(rawEvent);
        if (!parsedEvent.dataText || parsedEvent.dataText === "[DONE]") {
          const rewritten = rewriteAmpSseEvent(rawEvent, visibleModel);
          controller.enqueue(encoder.encode(rewritten.event));
          return;
        }

        try {
          const payload = JSON.parse(parsedEvent.dataText);
          const rewritten = rewriteAmpClaudeStreamPayload(claudeStreamState, payload, visibleModel);
          if (rewritten.suppressed) return;
          controller.enqueue(encoder.encode(formatSseEventBlock(parsedEvent.eventName, rewritten.payload)));
        } catch {
          const rewritten = rewriteAmpSseEvent(rawEvent, visibleModel);
          controller.enqueue(encoder.encode(rewritten.event));
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

          while (true) {
            const separatorIndex = buffer.indexOf("\n\n");
            if (separatorIndex < 0) break;
            const rawEvent = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            emitEvent(rawEvent);
          }
        }

        buffer += decoder.decode();
        if (buffer.trim()) emitEvent(buffer);
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

  const headers = new Headers(response.headers);
  headers.delete("content-length");

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export async function maybeRewriteAmpClientResponse(response, { clientType, requestBody, stream = false } = {}) {
  if (clientType !== "amp" || !(response instanceof Response)) return response;

  const visibleModel = readAmpVisibleModel(requestBody);
  if (!visibleModel) return response;

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (stream || contentType.includes("text/event-stream")) {
    return rewriteAmpStreamResponse(response, visibleModel);
  }

  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    return response;
  }

  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  if (!rewriteAmpPayload(payload, visibleModel)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", headers.get("content-type") || "application/json");
  headers.delete("content-length");

  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(withCorsHeaders(Object.fromEntries(headers.entries())))
  });
}
