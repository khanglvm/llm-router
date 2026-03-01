function joinTextParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeGeminiRole(role) {
  const value = String(role || "").trim().toLowerCase();
  if (value === "model") return "assistant";
  if (value === "user") return "user";
  return "user";
}

function extractResponseTextFromOpenAI(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function extractResponseTextFromClaude(payload) {
  if (!Array.isArray(payload?.content)) return "";
  return payload.content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function mapFinishReason(reason) {
  const normalized = String(reason || "").trim().toLowerCase();
  if (!normalized) return "STOP";
  if (normalized === "stop" || normalized === "end_turn") return "STOP";
  if (normalized === "length" || normalized === "max_tokens") return "MAX_TOKENS";
  return normalized.toUpperCase();
}

export function convertAmpGeminiRequestToOpenAI(body, route = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      error: "Invalid Gemini request payload."
    };
  }

  const model = typeof route.ampModelId === "string" && route.ampModelId.trim()
    ? route.ampModelId.trim()
    : "";
  if (!model) {
    return {
      error: "Gemini route is missing model id."
    };
  }

  const messages = Array.isArray(body.contents)
    ? body.contents.map((item) => ({
        role: normalizeGeminiRole(item?.role),
        content: joinTextParts(item?.parts)
      })).filter((item) => item.content)
    : [];

  if (messages.length === 0) {
    messages.push({
      role: "user",
      content: ""
    });
  }

  const system = joinTextParts(body?.systemInstruction?.parts);
  const openAIBody = {
    model,
    messages,
    stream: route?.ampAction === "streamGenerateContent"
  };

  const maxTokens = Number(body?.generationConfig?.maxOutputTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    openAIBody.max_completion_tokens = Math.floor(maxTokens);
  }

  const temperature = Number(body?.generationConfig?.temperature);
  if (Number.isFinite(temperature)) {
    openAIBody.temperature = temperature;
  }

  if (system) {
    openAIBody.messages.unshift({
      role: "system",
      content: system
    });
  }

  return { body: openAIBody };
}

export async function convertRouteResponseToAmpGemini(response) {
  if (!(response instanceof Response)) return response;
  if (!response.ok) return response;

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return response;
  }

  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  let text = "";
  let finishReason = "STOP";
  let usageMetadata = undefined;

  if (Array.isArray(payload?.choices)) {
    text = extractResponseTextFromOpenAI(payload);
    finishReason = mapFinishReason(payload?.choices?.[0]?.finish_reason);
    const promptTokens = Number(payload?.usage?.prompt_tokens || 0);
    const candidateTokens = Number(payload?.usage?.completion_tokens || 0);
    const totalTokens = Number(payload?.usage?.total_tokens || (promptTokens + candidateTokens));
    usageMetadata = {
      promptTokenCount: promptTokens,
      candidatesTokenCount: candidateTokens,
      totalTokenCount: totalTokens
    };
  } else if (payload?.type === "message") {
    text = extractResponseTextFromClaude(payload);
    finishReason = mapFinishReason(payload?.stop_reason);
    const promptTokens = Number(payload?.usage?.input_tokens || 0);
    const candidateTokens = Number(payload?.usage?.output_tokens || 0);
    const totalTokens = promptTokens + candidateTokens;
    usageMetadata = {
      promptTokenCount: promptTokens,
      candidatesTokenCount: candidateTokens,
      totalTokenCount: totalTokens
    };
  } else {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");

  return new Response(JSON.stringify({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text }
          ]
        },
        finishReason
      }
    ],
    ...(usageMetadata ? { usageMetadata } : {})
  }), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

