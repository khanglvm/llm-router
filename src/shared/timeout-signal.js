export function buildTimeoutSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal: undefined, cleanup: () => {} };
  }

  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return {
      signal: AbortSignal.timeout(timeoutMs),
      cleanup: () => {}
    };
  }

  if (typeof AbortController === "undefined") {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`timeout:${timeoutMs}`), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer)
  };
}
