import {
  listConfiguredModels,
  normalizeRuntimeConfig
} from "../config.js";

const modelListCache = new WeakMap();

function looksNormalizedConfig(config) {
  return Boolean(
    config &&
    typeof config === "object" &&
    Array.isArray(config.providers) &&
    Number.isFinite(config.version)
  );
}

export async function loadRuntimeConfig(getConfig, env) {
  const raw = await getConfig(env);
  return looksNormalizedConfig(raw) ? raw : normalizeRuntimeConfig(raw);
}

export function getCachedModelList(config, endpointFormat) {
  if (!config || typeof config !== "object") {
    return listConfiguredModels(config, {
      endpointFormat
    });
  }

  const cacheKey = endpointFormat || "__auto__";
  let byFormat = modelListCache.get(config);
  if (!byFormat) {
    byFormat = new Map();
    modelListCache.set(config, byFormat);
  }

  if (byFormat.has(cacheKey)) {
    return byFormat.get(cacheKey);
  }

  const rows = listConfiguredModels(config, {
    endpointFormat
  });
  byFormat.set(cacheKey, rows);
  return rows;
}
