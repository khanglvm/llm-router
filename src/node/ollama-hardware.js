/**
 * VRAM/memory estimation utilities for Ollama models.
 * Pure functions, no side effects, no external dependencies.
 */

const QUANT_BITS = {
  q2_k: 2.5,
  q3_k_s: 3.0, q3_k_m: 3.5, q3_k_l: 3.5,
  q4_0: 4.0, q4_k_s: 4.5, q4_k_m: 4.5,
  q5_0: 5.0, q5_k_s: 5.5, q5_k_m: 5.5,
  q6_k: 6.5, q8_0: 8.0, f16: 16.0, f32: 32.0
};

const DEFAULT_BITS = 4.5; // Q4_K_M
const OVERHEAD_BYTES = 512 * 1024 * 1024; // 512 MB

/**
 * Parse a parameter size string like "4.3B", "70B" into numeric count.
 * @param {string} parameterSize
 * @returns {number|null} Parameter count as integer, or null if unparseable
 */
export function parseParameterSize(parameterSize) {
  const match = String(parameterSize || '').trim().match(/^([\d.]+)([BKMGT]?)$/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const suffix = match[2].toUpperCase();
  const multipliers = { B: 1e9, M: 1e6, K: 1e3, G: 1e9, T: 1e12, '': 1 };
  const multiplier = multipliers[suffix] ?? 1;

  return Math.round(value * multiplier);
}

/**
 * Estimate VRAM required for a model at a given quantization and context length.
 * @param {string} parameterSize - e.g. "7B", "70B"
 * @param {string} quantLevel - e.g. "Q4_K_M", "F16"
 * @param {number} contextLength - number of tokens in context window
 * @returns {{ baseModelBytes: number, kvCacheBytes: number, totalBytes: number }|null}
 */
export function estimateModelVram(parameterSize, quantLevel, contextLength) {
  const params = parseParameterSize(parameterSize);
  if (params === null) return null;

  const bitsPerWeight = QUANT_BITS[String(quantLevel || '').toLowerCase()] ?? DEFAULT_BITS;
  const baseModelBytes = params * bitsPerWeight / 8;

  // Empirical KV cache estimate: bytes per token scales with model size
  const kvBytesPerToken = params * 0.00000025;
  const kvCacheBytes = (Number(contextLength) || 0) * kvBytesPerToken;

  const totalBytes = baseModelBytes + kvCacheBytes + OVERHEAD_BYTES;
  return { baseModelBytes, kvCacheBytes, totalBytes };
}

/**
 * Calculate max practical context given available memory.
 * @param {string} parameterSize - e.g. "7B"
 * @param {string} quantLevel - e.g. "Q4_K_M"
 * @param {number} availableMemoryBytes
 * @returns {{ maxContext: number, warningThreshold: number }}
 */
export function estimateMaxContext(parameterSize, quantLevel, availableMemoryBytes) {
  const params = parseParameterSize(parameterSize);
  if (params === null) return { maxContext: 0, warningThreshold: 0 };

  const bitsPerWeight = QUANT_BITS[String(quantLevel || '').toLowerCase()] ?? DEFAULT_BITS;
  const baseModelBytes = params * bitsPerWeight / 8;

  const remaining = availableMemoryBytes - baseModelBytes - OVERHEAD_BYTES;
  if (remaining <= 0) return { maxContext: 0, warningThreshold: 0 };

  const kvBytesPerToken = params * 0.00000025;
  const maxContext = Math.floor(remaining / kvBytesPerToken / 1024) * 1024;
  const warningThreshold = Math.floor(maxContext * 0.85);

  return { maxContext, warningThreshold };
}

/**
 * Format a byte count as a human-readable string.
 * @param {number} bytes
 * @returns {string} e.g. "4.5 GB", "512.0 MB"
 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024)      return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
