/** Ollama REST API client. All exports return { ok, error?, ... } — never throw. */

const DEFAULT_TIMEOUT_MS = 5_000;
const LOAD_TIMEOUT_MS = 120_000;
const PULL_TIMEOUT_MS = 600_000;

/**
 * @param {string} baseUrl  e.g. "http://localhost:11434"
 * @param {string} path     must start with "/"
 * @param {RequestInit & { timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, status: number, json: unknown, error: string | null }>}
 */
async function ollamaFetch(baseUrl, path, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options;
  const url = baseUrl.replace(/\/+$/, "") + path;
  let response;
  let json = null;
  let error = null;

  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // non-JSON body — leave json null
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    ok: Boolean(response?.ok),
    status: response?.status ?? 0,
    json,
    error
  };
}

/** Check whether the Ollama server is reachable. */
export async function ollamaCheckConnection(baseUrl) {
  const result = await ollamaFetch(baseUrl, "/");
  if (!result.ok) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` };
  }
  return { ok: true };
}

/** List all locally available models. */
export async function ollamaListModels(baseUrl) {
  const result = await ollamaFetch(baseUrl, "/api/tags");
  if (!result.ok) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` };
  }
  const raw = result.json?.models ?? [];
  const models = raw.map((m) => ({
    name: m.name,
    parameterSize: m.details?.parameter_size ?? null,
    quantizationLevel: m.details?.quantization_level ?? null,
    sizeBytes: m.size ?? null,
    family: m.details?.family ?? null,
    modifiedAt: m.modified_at ?? null,
    contextLength: null
  }));
  // Enrich with contextLength from /api/show (max 5 concurrent)
  const BATCH = 5;
  for (let i = 0; i < models.length; i += BATCH) {
    const batch = models.slice(i, i + BATCH);
    const details = await Promise.all(
      batch.map((m) => ollamaShowModel(baseUrl, m.name).catch(() => ({ ok: false })))
    );
    for (let j = 0; j < batch.length; j++) {
      if (details[j]?.ok && details[j].details?.contextLength) {
        batch[j].contextLength = details[j].details.contextLength;
      }
    }
  }
  return { ok: true, models };
}

/** Show detailed info for a specific model. */
export async function ollamaShowModel(baseUrl, modelName) {
  const result = await ollamaFetch(baseUrl, "/api/show", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName, verbose: false })
  });
  if (!result.ok) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` };
  }
  const body = result.json ?? {};
  const details = {
    contextLength: body.model_info?.["llm.context_length"] ?? null,
    parameterSize: body.details?.parameter_size ?? null,
    quantizationLevel: body.details?.quantization_level ?? null,
    family: body.details?.family ?? null,
    format: body.details?.format ?? null
  };
  return { ok: true, details };
}

/** List currently running (loaded) models. */
export async function ollamaListRunning(baseUrl) {
  const result = await ollamaFetch(baseUrl, "/api/ps");
  if (!result.ok) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` };
  }
  const raw = result.json?.models ?? [];
  const PINNED_SENTINEL = "0001-01-01T00:00:00Z";
  const models = raw.map((m) => ({
    name: m.name,
    sizeVram: m.size_vram ?? null,
    expiresAt: m.expires_at ?? null,
    isPinned: m.expires_at === PINNED_SENTINEL,
    processor: m.details?.families?.[0] ?? null
  }));
  return { ok: true, models };
}

/**
 * Load a model into memory. keepAlive: "24h" | "10m" | -1 (pin) | 0 (unload).
 * Uses 120 s timeout to accommodate large models.
 */
export async function ollamaLoadModel(baseUrl, modelName, keepAlive = "24h") {
  const result = await ollamaFetch(baseUrl, "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName, prompt: "", keep_alive: keepAlive, stream: false }),
    timeoutMs: LOAD_TIMEOUT_MS
  });
  if (!result.ok) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` };
  }
  const loadDurationMs =
    typeof result.json?.load_duration === "number"
      ? result.json.load_duration / 1_000_000
      : null;
  return { ok: true, loadDurationMs };
}

/** Unload a model from memory immediately. */
export async function ollamaUnloadModel(baseUrl, modelName) {
  const result = await ollamaFetch(baseUrl, "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName, prompt: "", keep_alive: 0, stream: false }),
    timeoutMs: LOAD_TIMEOUT_MS
  });
  if (!result.ok) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` };
  }
  return { ok: true, unloaded: true };
}

/** Pin a model in memory indefinitely (keep_alive = -1). */
export async function ollamaPinModel(baseUrl, modelName) {
  return ollamaLoadModel(baseUrl, modelName, -1);
}

/** Set a custom keep-alive duration for a loaded model (e.g. "10m", "1h"). */
export async function ollamaSetKeepAlive(baseUrl, modelName, duration) {
  return ollamaLoadModel(baseUrl, modelName, duration);
}

/** Pull (download) a model from the Ollama registry. 600 s timeout. */
export async function ollamaPullModel(baseUrl, modelName) {
  const result = await ollamaFetch(baseUrl, "/api/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName, stream: false }),
    timeoutMs: PULL_TIMEOUT_MS
  });
  if (!result.ok) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` };
  }
  return { ok: true };
}

/** Delete a locally stored model. */
export async function ollamaDeleteModel(baseUrl, modelName) {
  const result = await ollamaFetch(baseUrl, "/api/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName })
  });
  if (!result.ok) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` };
  }
  return { ok: true };
}
