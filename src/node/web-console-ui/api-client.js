import { JSON_HEADERS, CONTEXT_LOOKUP_SUGGESTION_LIMIT } from "./constants.js";
import { pickFreeTierProbeModels } from "./quick-start-utils.js";
import { looksLikeEnvVarName } from "./utils.js";

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function fetchJsonLineStream(url, options = {}, { onMessage } = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = null;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (rawLine) {
        const message = JSON.parse(rawLine);
        onMessage?.(message);
        if (message?.type === "result") {
          finalResult = message.result;
        }
        if (message?.type === "error") {
          const error = new Error(message.error || "Request failed.");
          error.statusCode = message.statusCode || 500;
          throw error;
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }

    if (done) break;
  }

  const finalLine = buffer.trim();
  if (finalLine) {
    const message = JSON.parse(finalLine);
    onMessage?.(message);
    if (message?.type === "result") finalResult = message.result;
    if (message?.type === "error") {
      const error = new Error(message.error || "Request failed.");
      error.statusCode = message.statusCode || 500;
      throw error;
    }
  }

  return finalResult;
}

export async function probeFreeTierModels(baseUrl, credential, modelIds) {
  const sampleIds = pickFreeTierProbeModels(modelIds);
  if (sampleIds.length === 0) return null;
  try {
    const payload = await fetchJson("/api/config/probe-free-tier-models", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        baseUrl,
        ...(looksLikeEnvVarName(credential) ? { apiKeyEnv: credential } : { apiKey: credential }),
        modelIds: sampleIds
      })
    });
    if (!payload?.result) return null;
    const freeTiers = new Set();
    const paidTiers = new Set();
    for (const [id, info] of Object.entries(payload.result)) {
      const lower = id.toLowerCase();
      const tier = lower.includes("flash-lite") ? "flash-lite"
        : lower.includes("flash") ? "flash"
        : lower.includes("pro") ? "pro"
        : lower;
      if (info?.freeTier) freeTiers.add(tier);
      else paidTiers.add(tier);
    }
    return modelIds.filter((id) => {
      const lower = id.toLowerCase();
      const tier = lower.includes("flash-lite") ? "flash-lite"
        : lower.includes("flash") ? "flash"
        : lower.includes("pro") ? "pro"
        : lower;
      if (freeTiers.has(tier)) return true;
      if (paidTiers.has(tier)) return false;
      return true;
    });
  } catch {
    return null;
  }
}

export async function lookupLiteLlmContextWindow(models = []) {
  const normalizedModels = [...new Set((Array.isArray(models) ? models : [])
    .map((model) => String(model || "").trim())
    .filter(Boolean))];
  if (normalizedModels.length === 0) return [];
  const payload = await fetchJson("/api/config/litellm-context-lookup", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      models: normalizedModels,
      limit: CONTEXT_LOOKUP_SUGGESTION_LIMIT
    })
  });
  return Array.isArray(payload?.result) ? payload.result : [];
}

export async function searchHuggingFaceGguf(request = {}) {
  const payload = await fetchJson("/api/local-models/search-huggingface", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(request)
  });
  return Array.isArray(payload?.results) ? payload.results : [];
}

export async function downloadManagedGguf(request, { onMessage } = {}) {
  return fetchJsonLineStream("/api/local-models/download-managed", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(request)
  }, { onMessage });
}

export async function saveLocalModelVariant(variant) {
  const payload = await fetchJson("/api/local-models/variants/save", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ variant })
  });
  return payload?.variants || {};
}

export async function attachLocalModel(request) {
  const payload = await fetchJson("/api/local-models/attach", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(request)
  });
  return payload;
}

export async function locateLocalModel(request) {
  const payload = await fetchJson("/api/local-models/locate", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(request)
  });
  return payload;
}

export async function removeLocalModel(baseModelId) {
  const payload = await fetchJson("/api/local-models/remove", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ baseModelId })
  });
  return payload;
}

export async function reconcileLocalModels() {
  const payload = await fetchJson("/api/local-models/reconcile", {
    method: "POST",
    headers: JSON_HEADERS,
    body: "{}"
  });
  return payload;
}

export async function discoverLlamacppRuntime() {
  return fetchJson("/api/local-models/runtime/discover", {
    method: "POST",
    headers: JSON_HEADERS,
    body: "{}"
  });
}

export async function selectLlamacppRuntime(command) {
  return fetchJson("/api/local-models/runtime/select", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ command })
  });
}

export async function browseLocalModelPath(selection = "file") {
  return fetchJson("/api/local-models/browse", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ selection })
  });
}

export async function scanLocalModelPath(targetPath) {
  return fetchJson("/api/local-models/scan-path", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ path: targetPath })
  });
}
