/**
 * IO layer: executes quota probes (HTTP or custom JS), caches snapshots,
 * and manages a per-provider circuit breaker.
 */
import { createContext, Script } from "node:vm";
import { validateSnapshot, deriveSnapshot } from "../runtime/quota-probe.js";
import { extractMappedSnapshot, interpolateShortcodes } from "./quota-probe-mapping.js";

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_PAUSE_MS = 5 * 60 * 1000;

function makeErroredSnapshot(capKind, now, error, lastKnownGood) {
  return {
    capKind,
    state: "errored",
    error: { message: String(error) },
    fetchedAt: now,
    raw: null,
    lastKnownGood: lastKnownGood || null,
  };
}

async function executeHttp(probeConfig, shortcodeCtx, env, fetchFn) {
  const http = probeConfig.http;
  const url = interpolateShortcodes(http.url, shortcodeCtx, env);
  const headers = {};
  for (const h of http.headers || []) {
    const headerKey = String(h.key || h.name || "").trim();
    if (!headerKey) continue;
    headers[interpolateShortcodes(headerKey, shortcodeCtx, env)] =
      interpolateShortcodes(String(h.value || ""), shortcodeCtx, env);
  }
  const opts = { method: http.method || "GET", headers };
  if (http.body !== undefined && opts.method !== "GET") {
    opts.body = typeof http.body === "string"
      ? interpolateShortcodes(http.body, shortcodeCtx, env)
      : JSON.stringify(http.body);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), http.timeoutMs || 5000);
  opts.signal = ac.signal;

  try {
    const res = await fetchFn(url, opts);
    clearTimeout(timer);
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.responseBody = body;
      throw err;
    }
    return body;
  } catch (err) {
    clearTimeout(timer);
    if (err.responseBody !== undefined) {
      const wrapped = new Error(err.message);
      wrapped.responseBody = err.responseBody;
      throw wrapped;
    }
    const msg = err.name === "AbortError" ? "timeout" : err.message;
    throw new Error(msg);
  }
}

async function executeCustom(probeConfig, shortcodeCtx, fetchFn, now) {
  const { source, timeoutMs } = probeConfig.custom;
  const sandbox = Object.freeze({
    ctx: Object.freeze({
      fetch: fetchFn,
      providerApiKey: shortcodeCtx.providerApiKey,
      providerBaseUrl: shortcodeCtx.providerBaseUrl,
      providerId: shortcodeCtx.providerId,
      log: () => {},
      now,
      timeoutMs,
    }),
  });
  const vmCtx = createContext(sandbox);
  const wrapped = `(async () => { ${source}\n return fetchUsage(ctx); })()`;
  const script = new Script(wrapped, { timeout: timeoutMs });
  return await script.runInContext(vmCtx, { timeout: timeoutMs });
}

export function createQuotaProbeRunner({ fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const cache = new Map();
  const circuits = new Map();

  function getCircuit(providerId) {
    if (!circuits.has(providerId)) {
      circuits.set(providerId, { failures: 0, openUntil: 0 });
    }
    return circuits.get(providerId);
  }

  function isCircuitOpen(providerId, now) {
    const c = circuits.get(providerId);
    return !!c && c.failures >= CIRCUIT_THRESHOLD && now < c.openUntil;
  }

  function resetCircuit(providerId) {
    circuits.delete(providerId);
  }

  async function executeProbe({ providerId, probeConfig, shortcodeCtx, env, now }) {
    const capKind = probeConfig.capKind;
    const prev = cache.get(providerId);
    const lastKnownGood = prev?.state === "fresh" ? prev : prev?.lastKnownGood || null;

    try {
      let result;
      if (probeConfig.mode === "custom") {
        result = await executeCustom(probeConfig, shortcodeCtx, fetchFn, now);
      } else {
        const rawJson = await executeHttp(probeConfig, shortcodeCtx, env, fetchFn);
        const mapped = extractMappedSnapshot(rawJson, probeConfig.http.mapping);
        result = { ...mapped, capKind, raw: rawJson };
      }

      const toValidate = { ...result, capKind: result.capKind || capKind };
      const validation = validateSnapshot(toValidate);
      if (!validation.valid) {
        const err = new Error(validation.error);
        err.responseBody = result.raw;
        throw err;
      }

      const derived = deriveSnapshot(toValidate);
      const snapshot = {
        capKind: derived.capKind,
        used: derived.used,
        limit: derived.limit,
        remaining: derived.remaining,
        resetAt: derived.resetAt,
        isUnlimited: derived.isUnlimited,
        state: "fresh",
        fetchedAt: now,
        error: null,
        raw: result.raw ?? null,
        lastKnownGood: null,
      };

      cache.set(providerId, snapshot);
      resetCircuit(providerId);
      return snapshot;
    } catch (err) {
      const circuit = getCircuit(providerId);
      circuit.failures++;
      if (circuit.failures >= CIRCUIT_THRESHOLD) {
        circuit.openUntil = now + CIRCUIT_PAUSE_MS;
      }
      const snapshot = makeErroredSnapshot(capKind, now, err.message, lastKnownGood);
      snapshot.raw = err.responseBody ?? null;
      cache.set(providerId, snapshot);
      return snapshot;
    }
  }

  function getSnapshot(providerId) {
    return cache.get(providerId) || null;
  }

  function getAllSnapshots() {
    return new Map(cache);
  }

  // ── Refresh trigger management ──────────────────────────────────────
  const pendingRefreshes = new Map();
  const resetAtTimers = new Map();
  const MAX_CONCURRENT_PROBES = 4;
  const MAX_RESET_AT_DELAY_MS = 24 * 60 * 60 * 1000;
  let activeConcurrent = 0;
  let _onTriggerRefresh = null;

  function scheduleResetAtRefresh(providerId, snapshot, probeConfig, shortcodeCtx, env) {
    if (resetAtTimers.has(providerId)) {
      clearTimeout(resetAtTimers.get(providerId));
      resetAtTimers.delete(providerId);
    }
    if (!probeConfig.refreshTriggers?.onResetAt) return;
    if (!snapshot.resetAt) return;
    const delay = snapshot.resetAt - Date.now();
    if (delay <= 0 || delay > MAX_RESET_AT_DELAY_MS) return;

    const timerId = setTimeout(() => {
      resetAtTimers.delete(providerId);
      if (_onTriggerRefresh) _onTriggerRefresh({ providerId, trigger: "scheduler.resetAt" });
      enqueueRefresh({ providerId, probeConfig, shortcodeCtx, env });
    }, delay);
    resetAtTimers.set(providerId, timerId);
  }

  async function enqueueRefresh({ providerId, probeConfig, shortcodeCtx, env, bypassCircuit }) {
    if (isCircuitOpen(providerId, Date.now()) && !bypassCircuit) {
      return getSnapshot(providerId);
    }
    if (pendingRefreshes.has(providerId)) {
      return pendingRefreshes.get(providerId);
    }

    const run = async () => {
      while (activeConcurrent >= MAX_CONCURRENT_PROBES) {
        await new Promise(r => setTimeout(r, 50));
      }
      activeConcurrent++;
      try {
        const snap = await executeProbe({ providerId, probeConfig, shortcodeCtx, env, now: Date.now() });
        scheduleResetAtRefresh(providerId, snap, probeConfig, shortcodeCtx, env);
        return snap;
      } finally {
        activeConcurrent--;
        pendingRefreshes.delete(providerId);
      }
    };

    const promise = run();
    pendingRefreshes.set(providerId, promise);
    return promise;
  }

  function dispose() {
    for (const id of resetAtTimers.values()) clearTimeout(id);
    resetAtTimers.clear();
  }

  const runner = { executeProbe, getSnapshot, getAllSnapshots, isCircuitOpen, resetCircuit, enqueueRefresh, dispose };
  Object.defineProperty(runner, "onTriggerRefresh", {
    get() { return _onTriggerRefresh; },
    set(fn) { _onTriggerRefresh = fn; },
    enumerable: true,
  });
  return runner;
}
