/**
 * Higher-level config workflows used by CLI actions.
 */

import { normalizeRuntimeConfig, validateRuntimeConfig } from "../runtime/config.js";

function dedupe(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function normalizeBaseUrlByFormatInput(input) {
  const source = input?.baseUrlByFormat && typeof input.baseUrlByFormat === "object"
    ? input.baseUrlByFormat
    : {};
  const openai = String(
    source.openai ||
    input?.openaiBaseUrl ||
    input?.["openai-base-url"] ||
    ""
  ).trim();
  const claude = String(
    source.claude ||
    source.anthropic ||
    input?.claudeBaseUrl ||
    input?.anthropicBaseUrl ||
    input?.["claude-base-url"] ||
    input?.["anthropic-base-url"] ||
    ""
  ).trim();

  const out = {};
  if (openai) out.openai = openai;
  if (claude) out.claude = claude;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseModelListInput(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return dedupe(raw);
  return dedupe(String(raw).split(/[,\n]/g));
}

function normalizeModelArray(models) {
  const rows = Array.isArray(models) ? models : dedupe(models).map((id) => ({ id }));
  return rows
    .map((entry) => {
      if (typeof entry === "string") return { id: entry };
      if (!entry || typeof entry !== "object") return null;
      const id = String(entry.id || entry.name || "").trim();
      if (!id) return null;
      const formats = dedupe(entry.formats || entry.format || []).filter((value) => value === "openai" || value === "claude");
      return {
        id,
        ...(formats.length > 0 ? { formats } : {})
      };
    })
    .filter(Boolean);
}

function buildModelsWithPreferredFormat(modelIds, modelSupport = {}, modelPreferredFormat = {}) {
  return normalizeModelArray(modelIds.map((id) => {
    const preferred = modelPreferredFormat[id];
    if (preferred) {
      return { id, formats: [preferred] };
    }
    return { id, formats: modelSupport[id] || [] };
  }));
}

function summarizeEndpointMatrix(endpointMatrix) {
  if (!Array.isArray(endpointMatrix)) return undefined;
  return endpointMatrix.map((row) => ({
    endpoint: row.endpoint,
    supportedFormats: row.supportedFormats || [],
    workingFormats: row.workingFormats || [],
    modelsByFormat: row.modelsByFormat || {},
    authByFormat: row.authByFormat || {}
  }));
}

export function buildProviderFromConfigInput(input) {
  const providerId = input.providerId || input.id || input.name;
  const baseUrlByFormat = normalizeBaseUrlByFormatInput(input);
  const explicitModelIds = parseModelListInput(input.models);
  const probeModelSupport = input.probe?.modelSupport && typeof input.probe.modelSupport === "object"
    ? input.probe.modelSupport
    : {};
  const probeModelPreferredFormat = input.probe?.modelPreferredFormat && typeof input.probe.modelPreferredFormat === "object"
    ? input.probe.modelPreferredFormat
    : {};
  const explicitModels = explicitModelIds.length > 0
    ? buildModelsWithPreferredFormat(explicitModelIds, probeModelSupport, probeModelPreferredFormat)
    : [];
  const probeModels = input.probe?.models?.length
    ? buildModelsWithPreferredFormat(input.probe.models, probeModelSupport, probeModelPreferredFormat)
    : [];
  const mergedModels = explicitModels.length > 0 ? explicitModels : probeModels;
  const endpointFormats = baseUrlByFormat ? Object.keys(baseUrlByFormat) : [];

  const preferredFormat = input.probe?.preferredFormat || input.format;
  const supportedFormats = dedupe([
    ...(input.probe?.formats || []),
    ...endpointFormats,
    ...(input.formats || []),
    ...(preferredFormat ? [preferredFormat] : [])
  ]);
  const baseUrl = String(input.baseUrl || "").trim()
    || (preferredFormat ? baseUrlByFormat?.[preferredFormat] : "")
    || baseUrlByFormat?.openai
    || baseUrlByFormat?.claude
    || "";

  return normalizeRuntimeConfig({
    providers: [{
      id: providerId,
      name: input.name || providerId,
      baseUrl,
      baseUrlByFormat,
      apiKey: input.apiKey,
      format: preferredFormat,
      formats: supportedFormats,
      auth: input.probe?.auth || input.auth,
      authByFormat: input.probe?.authByFormat || input.authByFormat,
      anthropicVersion: input.anthropicVersion,
      anthropicBeta: input.anthropicBeta,
      headers: input.headers || {},
      models: mergedModels,
      lastProbe: input.probe
        ? {
            ok: Boolean(input.probe.ok),
            at: new Date().toISOString(),
            formats: input.probe.formats || [],
            workingFormats: input.probe.workingFormats || [],
            models: input.probe.models || [],
            modelSupport: input.probe.modelSupport || undefined,
            modelPreferredFormat: input.probe.modelPreferredFormat || undefined,
            endpointMatrix: summarizeEndpointMatrix(input.probe.endpointMatrix),
            warnings: input.probe.warnings || undefined
          }
        : undefined
    }]
  }).providers[0];
}

export function ensureProviderHasModels(provider) {
  if (Array.isArray(provider.models) && provider.models.length > 0) return provider;
  return {
    ...provider,
    models: []
  };
}

function mergeProviderModelsWithExistingFallbacks(existingProvider, incomingProvider) {
  const existingModelById = new Map((existingProvider?.models || []).map((model) => [model.id, model]));
  const mergedModels = (incomingProvider?.models || []).map((model) => {
    const previous = existingModelById.get(model.id);
    const hasExplicitFallbacks = Object.prototype.hasOwnProperty.call(model, "fallbackModels");
    if (hasExplicitFallbacks || !previous) return model;
    if (!Object.prototype.hasOwnProperty.call(previous, "fallbackModels")) return model;
    return {
      ...model,
      fallbackModels: previous.fallbackModels || []
    };
  });

  return {
    ...incomingProvider,
    models: mergedModels
  };
}

export function applyConfigChanges(existingConfig, {
  provider,
  masterKey,
  setDefaultModel = true
}) {
  const normalized = normalizeRuntimeConfig(existingConfig);
  const providers = [...normalized.providers];
  const existingIndex = providers.findIndex((item) => item.id === provider.id);

  if (existingIndex >= 0) {
    const mergedProvider = mergeProviderModelsWithExistingFallbacks(
      providers[existingIndex],
      ensureProviderHasModels(provider)
    );
    providers[existingIndex] = {
      ...providers[existingIndex],
      ...mergedProvider
    };
  } else {
    providers.push(ensureProviderHasModels(provider));
  }

  const nextConfig = normalizeRuntimeConfig({
    ...normalized,
    providers,
    masterKey: masterKey ?? normalized.masterKey,
    defaultModel: normalized.defaultModel
  });

  if (setDefaultModel) {
    const bestDefaultModel =
      nextConfig.defaultModel ||
      (provider.models?.[0] ? `${provider.id}/${provider.models[0].id}` : undefined);

    if (bestDefaultModel) {
      nextConfig.defaultModel = bestDefaultModel;
    }
  }

  return nextConfig;
}

export function buildWorkerConfigPayload(config, { masterKey } = {}) {
  const normalized = normalizeRuntimeConfig({
    ...config,
    masterKey: masterKey ?? config.masterKey
  });

  const errors = validateRuntimeConfig(normalized, { requireProvider: true, requireMasterKey: true });
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  const workingProviders = (normalized.providers || []).filter((provider) => {
    const probe = provider.lastProbe;
    return !probe || probe.ok !== false;
  });

  if (workingProviders.length === 0) {
    throw new Error("At least one working provider is required for worker export.");
  }

  const payload = {
    ...normalized,
    providers: normalized.providers.map((provider) => ({
      ...provider,
      // Keep apiKey in payload for all-in-one secret export. Users can later convert to apiKeyEnv if preferred.
      apiKey: provider.apiKey,
      lastProbe: provider.lastProbe
    }))
  };

  return payload;
}
