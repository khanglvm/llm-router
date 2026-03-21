import { FORMATS } from "../../translator/index.js";
import { buildTimeoutSignal } from "../../shared/timeout-signal.js";
import { commitRouteSelection, rankRouteCandidates } from "../balancer.js";
import { buildCandidateKey } from "../state-store.js";
import { consumeCandidateRateLimits, resolveWindowRange } from "../rate-limits.js";
import {
  buildProviderHeaders,
  resolveProviderFormat,
  resolveProviderUrl,
  resolveRouteReference
} from "../config.js";
import { jsonResponse } from "./http.js";

function isSubscriptionProvider(provider) {
  return provider?.type === "subscription";
}

const SEARCH_TOOL_NAME = "web_search";
const READ_WEB_PAGE_TOOL_NAME = "read_web_page";
const DEFAULT_SEARCH_COUNT = 5;
const MIN_SEARCH_COUNT = 1;
const MAX_SEARCH_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_READ_WEB_PAGE_TEXT_CHARS = 24_000;
const MAX_READ_WEB_PAGE_TABLES = 8;
const MAX_READ_WEB_PAGE_TABLE_ROWS = 40;
const SEARCH_ROUTE_KEY = "route:amp-web-search";
const HOSTED_WEB_SEARCH_TEST_QUERY = "Find the sunrise time in Paris today and cite the source.";
const SEARCH_SYSTEM_INSTRUCTION = [
  "You just performed web searches and received real, current search results.",
  "Synthesize the results into a direct answer with clear headings or bullets when helpful.",
  "Mention source names, but do not include raw URLs unless the user explicitly asks for them.",
  "Include specific dates, names, and facts when the results contain them.",
  "Do not say that web search is unavailable."
].join(" ");

const AMP_WEB_SEARCH_PROVIDER_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "brave", label: "Brave", type: "api-key", defaultLimit: 1000 }),
  Object.freeze({ id: "tavily", label: "Tavily", type: "api-key", defaultLimit: 1000 }),
  Object.freeze({ id: "exa", label: "Exa", type: "api-key", defaultLimit: 1000 }),
  Object.freeze({ id: "searxng", label: "SearXNG", type: "url", defaultLimit: 0 })
]);

const AMP_WEB_SEARCH_PROVIDER_META = new Map(
  AMP_WEB_SEARCH_PROVIDER_DEFINITIONS.map((entry) => [entry.id, entry])
);

const SEARCH_BACKENDS = Object.freeze([
  "brave",
  "tavily",
  "exa",
  "searxng",
  "gnews",
  "ddghtml",
  "bing",
  "ddglite"
]);

const FREE_FALLBACK_BACKENDS = Object.freeze(["gnews", "ddghtml", "bing", "ddglite"]);
const inMemoryBucketUsage = new Map();
const inMemoryRouteCursor = new Map();

const WEB_SEARCH_FUNCTION_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The search query to run against the web."
    }
  },
  required: ["query"],
  additionalProperties: false
};

const READ_WEB_PAGE_FUNCTION_PARAMETERS = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "The absolute URL of the web page to read."
    }
  },
  required: ["url"],
  additionalProperties: true
};

const OPENAI_CHAT_WEB_SEARCH_TOOL = Object.freeze({
  type: "function",
  function: {
    name: SEARCH_TOOL_NAME,
    description: "Search the web for current information, news, documentation, or real-time facts.",
    parameters: WEB_SEARCH_FUNCTION_PARAMETERS
  }
});

const OPENAI_RESPONSES_WEB_SEARCH_TOOL = Object.freeze({
  type: "function",
  name: SEARCH_TOOL_NAME,
  description: "Search the web for current information, news, documentation, or real-time facts.",
  parameters: WEB_SEARCH_FUNCTION_PARAMETERS
});

const CLAUDE_WEB_SEARCH_TOOL = Object.freeze({
  name: SEARCH_TOOL_NAME,
  description: "Search the web for current information, news, documentation, or real-time facts.",
  input_schema: WEB_SEARCH_FUNCTION_PARAMETERS
});

const OPENAI_CHAT_READ_WEB_PAGE_TOOL = Object.freeze({
  type: "function",
  function: {
    name: READ_WEB_PAGE_TOOL_NAME,
    description: "Fetch and extract the readable text and table content from a web page URL.",
    parameters: READ_WEB_PAGE_FUNCTION_PARAMETERS
  }
});

const OPENAI_RESPONSES_READ_WEB_PAGE_TOOL = Object.freeze({
  type: "function",
  name: READ_WEB_PAGE_TOOL_NAME,
  description: "Fetch and extract the readable text and table content from a web page URL.",
  parameters: READ_WEB_PAGE_FUNCTION_PARAMETERS
});

const CLAUDE_READ_WEB_PAGE_TOOL = Object.freeze({
  name: READ_WEB_PAGE_TOOL_NAME,
  description: "Fetch and extract the readable text and table content from a web page URL.",
  input_schema: READ_WEB_PAGE_FUNCTION_PARAMETERS
});

function toInteger(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toTrimmedString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function parseJsonSafely(raw, fallback = null) {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function buildSearchTimeoutSignal(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeoutControl = buildTimeoutSignal(timeoutMs);
  return {
    signal: timeoutControl.signal,
    cleanup: timeoutControl.cleanup
  };
}

function runFetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeoutControl = buildSearchTimeoutSignal(timeoutMs);
  return fetch(url, {
    ...init,
    ...(timeoutControl.signal ? { signal: timeoutControl.signal } : {})
  }).finally(() => timeoutControl.cleanup());
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function clampText(value, maxChars = MAX_READ_WEB_PAGE_TEXT_CHARS) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 15)).trimEnd()}\n[truncated]`;
}

function stripHtmlPreservingLines(text) {
  const normalized = String(text || "")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|header|footer|aside|nav|li|tr|h1|h2|h3|h4|h5|h6|ul|ol|table)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<t[dh]\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return normalized
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractHtmlTitle(html) {
  return stripHtml((String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
}

function extractPreferredHtmlSection(html) {
  const normalized = String(html || "");
  for (const tagName of ["main", "article", "body"]) {
    const match = normalized.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
    if (match?.[1]) return match[1];
  }
  return normalized;
}

function removeHtmlNoise(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ");
}

function extractHtmlTables(html) {
  const tableBlocks = [...String(html || "").matchAll(/<table\b[\s\S]*?<\/table>/gi)].slice(0, MAX_READ_WEB_PAGE_TABLES);
  const tables = [];

  for (let index = 0; index < tableBlocks.length; index += 1) {
    const tableHtml = tableBlocks[index]?.[0] || "";
    const caption = stripHtml((tableHtml.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i) || [])[1] || "");
    const rowBlocks = [...tableHtml.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].slice(0, MAX_READ_WEB_PAGE_TABLE_ROWS);
    const rows = rowBlocks.map((rowBlock) => {
      const rowHtml = rowBlock?.[0] || "";
      return [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((cellMatch) => stripHtml(cellMatch?.[1] || ""))
        .filter((cell) => cell.length > 0);
    }).filter((row) => row.length > 0);

    if (rows.length === 0) continue;
    const formattedRows = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
    tables.push([
      caption ? `Table ${tables.length + 1}: ${caption}` : `Table ${tables.length + 1}:`,
      formattedRows
    ].join("\n"));
  }

  return tables;
}

function formatReadWebPageHtml(url, html) {
  const cleanHtml = removeHtmlNoise(html);
  const title = extractHtmlTitle(cleanHtml);
  const mainSection = extractPreferredHtmlSection(cleanHtml);
  const tables = extractHtmlTables(mainSection);
  const pageText = clampText(stripHtmlPreservingLines(mainSection));
  const sections = [
    `URL: ${url}`
  ];

  if (title) sections.push(`Title: ${title}`);
  if (tables.length > 0) sections.push(`Tables:\n${tables.join("\n\n")}`);
  if (pageText) sections.push(`Page text:\n${pageText}`);

  return sections.join("\n\n").trim();
}

function formatReadWebPageBody(url, bodyText, contentType = "") {
  const sections = [
    `URL: ${url}`
  ];
  const normalizedContentType = String(contentType || "").trim();
  if (normalizedContentType) sections.push(`Content-Type: ${normalizedContentType}`);
  sections.push(`Page text:\n${clampText(bodyText) || "[No readable page text extracted]"}`);
  return sections.join("\n\n").trim();
}

function looksLikeHtml(contentType, bodyText) {
  const normalizedContentType = String(contentType || "").toLowerCase();
  if (normalizedContentType.includes("text/html") || normalizedContentType.includes("application/xhtml+xml")) {
    return true;
  }
  const sample = String(bodyText || "").trim().slice(0, 512).toLowerCase();
  return sample.startsWith("<!doctype html") || sample.startsWith("<html") || sample.includes("<body");
}

function formatSearchResults(results) {
  const lines = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!result) continue;
    const title = String(result.title || "").trim() || "(untitled)";
    const url = String(result.url || "").trim();
    const snippet = String(result.snippet || "").trim() || "(no description)";
    lines.push(`[${index + 1}] ${title}`);
    if (url) lines.push(`URL: ${url}`);
    lines.push(snippet);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function hasSearchToolType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (!normalized) return false;
  return normalized === SEARCH_TOOL_NAME
    || normalized.startsWith("web_search_preview")
    || normalized === "web_search_20250305";
}

function hasSearchToolName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return normalized === SEARCH_TOOL_NAME || normalized === "web_search_preview";
}

function hasReadWebPageToolName(name) {
  return String(name || "").trim().toLowerCase() === READ_WEB_PAGE_TOOL_NAME;
}

function hasInterceptableTool(tool) {
  if (!tool || typeof tool !== "object") return false;
  return hasSearchToolType(tool.type)
    || hasSearchToolName(tool.name)
    || hasSearchToolName(tool.function?.name)
    || hasReadWebPageToolName(tool.name)
    || hasReadWebPageToolName(tool.function?.name);
}

function hasInterceptableToolName(name) {
  return hasSearchToolName(name) || hasReadWebPageToolName(name);
}

function getToolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (hasReadWebPageToolName(tool.name) || hasReadWebPageToolName(tool.function?.name)) {
    return READ_WEB_PAGE_TOOL_NAME;
  }
  if (hasSearchToolType(tool.type) || hasSearchToolName(tool.name) || hasSearchToolName(tool.function?.name)) {
    return SEARCH_TOOL_NAME;
  }
  return "";
}

function dedupeStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
}

function buildHostedSearchProviderId(providerId, modelId) {
  const normalizedProviderId = String(providerId || "").trim();
  const normalizedModelId = String(modelId || "").trim();
  if (!normalizedProviderId || !normalizedModelId) return "";
  return `${normalizedProviderId}/${normalizedModelId}`;
}

function looksLikeHostedSearchProviderId(value) {
  const normalized = String(value || "").trim();
  return normalized.includes("/");
}

function isHostedSearchProvider(provider) {
  return Boolean(
    provider
    && typeof provider === "object"
    && looksLikeHostedSearchProviderId(provider.id)
    && String(provider?.providerId || "").trim()
    && String(provider?.model || "").trim()
  );
}

function normalizeHostedSearchProviderEntry(entry, explicitId = "") {
  const routeId = String(
    explicitId
    || entry?.id
    || buildHostedSearchProviderId(
      entry?.providerId ?? entry?.provider,
      entry?.model ?? entry?.modelId
    )
  ).trim();
  if (!looksLikeHostedSearchProviderId(routeId)) return null;

  const providerId = String(entry?.providerId ?? entry?.provider ?? routeId.slice(0, routeId.indexOf("/"))).trim();
  const model = String(entry?.model ?? entry?.modelId ?? routeId.slice(routeId.indexOf("/") + 1)).trim();
  const normalizedRouteId = buildHostedSearchProviderId(providerId, model);
  if (!normalizedRouteId || normalizedRouteId !== routeId) return null;

  return {
    id: normalizedRouteId,
    providerId,
    model
  };
}

function normalizeSearchProviderId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return AMP_WEB_SEARCH_PROVIDER_META.has(normalized) ? normalized : "";
}

function normalizeSearchRoutingStrategy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "ordered";
  if (normalized === "quota-balance" || normalized === "quota-aware-weighted-rr") return "quota-balance";
  return "ordered";
}

function resolveProviderDefaultLimit(providerId) {
  return AMP_WEB_SEARCH_PROVIDER_META.get(providerId)?.defaultLimit || 0;
}

function hasOwnSearchProviderField(entry, keys = []) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(entry, key) && entry[key] !== undefined && entry[key] !== null && String(entry[key]).trim() !== "");
}

function resolveSearchProviderCount(provider = {}, fallback = DEFAULT_SEARCH_COUNT) {
  return toInteger(
    provider?.count ?? provider?.resultCount ?? provider?.["result-count"] ?? provider?.resultsPerCall ?? provider?.["results-per-call"],
    fallback,
    { min: MIN_SEARCH_COUNT, max: MAX_SEARCH_COUNT }
  );
}

function normalizeSearchProviderEntry(entry, explicitId = "", env = {}, { preserveUnconfigured = true, inheritedCount = DEFAULT_SEARCH_COUNT } = {}) {
  const hostedProvider = normalizeHostedSearchProviderEntry(entry, explicitId);
  if (hostedProvider) return hostedProvider;

  const providerId = normalizeSearchProviderId(explicitId || entry?.id || entry?.provider || entry?.backend || entry?.name);
  if (!providerId) return null;

  const defaultLimit = resolveProviderDefaultLimit(providerId);
  const apiKeyEnvName = providerId === "brave"
    ? "BRAVE_API_KEY"
    : providerId === "tavily"
      ? "TAVILY_API_KEY"
      : providerId === "exa"
        ? "EXA_API_KEY"
        : "";
  const limitEnvName = providerId === "brave"
    ? "BRAVE_MONTHLY_LIMIT"
    : providerId === "tavily"
      ? "TAVILY_MONTHLY_LIMIT"
      : providerId === "exa"
        ? "EXA_MONTHLY_LIMIT"
        : "";

  const apiKey = providerId === "searxng"
    ? undefined
    : toTrimmedString(entry?.apiKey ?? entry?.["api-key"] ?? env?.[apiKeyEnvName]);
  const url = providerId === "searxng"
    ? toTrimmedString(entry?.url ?? entry?.baseUrl ?? entry?.["base-url"] ?? entry?.searxngUrl ?? entry?.["searxng-url"] ?? env?.WEB_SEARCH_URL)?.replace(/\/+$/, "")
    : undefined;
  const hasExplicitCount = hasOwnSearchProviderField(entry, ["count", "resultCount", "result-count", "resultsPerCall", "results-per-call"]);
  const hasExplicitLimit = hasOwnSearchProviderField(entry, ["limit", "monthlyLimit", "monthly-limit"]);
  const hasExplicitRemaining = hasOwnSearchProviderField(entry, ["remaining", "remainingQuota", "remaining-quota", "remainingQueries", "remaining-queries"]);
  const hasCredential = providerId === "searxng" ? Boolean(url) : Boolean(apiKey);
  if (!preserveUnconfigured && !hasCredential && !hasExplicitCount && !hasExplicitLimit && !hasExplicitRemaining) {
    return null;
  }
  const count = resolveSearchProviderCount(entry, inheritedCount);
  const includeQuotaDefaults = hasCredential || hasExplicitLimit || hasExplicitRemaining;
  const limit = toInteger(
    entry?.limit ?? entry?.monthlyLimit ?? entry?.["monthly-limit"] ?? env?.[limitEnvName],
    includeQuotaDefaults ? defaultLimit : 0,
    { min: 0 }
  );
  const remaining = toInteger(
    entry?.remaining ?? entry?.remainingQuota ?? entry?.["remaining-quota"] ?? entry?.remainingQueries ?? entry?.["remaining-queries"],
    includeQuotaDefaults && limit > 0 ? limit : 0,
    { min: 0 }
  );

  return {
    id: providerId,
    ...(apiKey ? { apiKey } : {}),
    ...(url ? { url } : {}),
    ...(count !== DEFAULT_SEARCH_COUNT ? { count } : {}),
    ...(hasExplicitLimit || (includeQuotaDefaults && limit > 0) ? { limit } : {}),
    ...(hasExplicitRemaining || (includeQuotaDefaults && (limit > 0 || remaining > 0))
      ? { remaining: limit > 0 ? Math.min(remaining, limit) : remaining }
      : {})
  };
}

function normalizeConfiguredSearchProviders(rawProviders, raw = {}, env = {}) {
  const inheritedCount = resolveSearchProviderCount(raw, toInteger(
    env.AMP_WEB_SEARCH_COUNT ?? env.WEB_SEARCH_COUNT,
    DEFAULT_SEARCH_COUNT,
    { min: MIN_SEARCH_COUNT, max: MAX_SEARCH_COUNT }
  ));
  if (Array.isArray(rawProviders) && rawProviders.length > 0) {
    const out = [];
    const seen = new Set();
    for (const entry of rawProviders) {
      const normalized = normalizeSearchProviderEntry(entry, "", env, {
        preserveUnconfigured: true,
        inheritedCount
      });
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      out.push(normalized);
    }
    return out;
  }

  if (rawProviders && typeof rawProviders === "object" && !Array.isArray(rawProviders)) {
    const out = [];
    const seen = new Set();
    for (const [providerId, value] of Object.entries(rawProviders)) {
      const normalized = normalizeSearchProviderEntry(value, providerId, env, {
        preserveUnconfigured: true,
        inheritedCount
      });
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      out.push(normalized);
    }
    return out;
  }

  const legacyPreferredBackend = normalizeSearchProviderId(
    raw.preferredBackend ?? raw["preferred-backend"] ?? env.AMP_WEB_SEARCH_BACKEND ?? env.WEB_SEARCH_BACKEND
  );
  const legacyEntries = [
    normalizeSearchProviderEntry({
      apiKey: raw.braveApiKey ?? raw["brave-api-key"],
      count: raw.count,
      limit: raw.braveMonthlyLimit ?? raw["brave-monthly-limit"],
      remaining: raw.braveRemaining ?? raw["brave-remaining"]
    }, "brave", env, { preserveUnconfigured: false, inheritedCount }),
    normalizeSearchProviderEntry({
      apiKey: raw.tavilyApiKey ?? raw["tavily-api-key"],
      count: raw.count,
      limit: raw.tavilyMonthlyLimit ?? raw["tavily-monthly-limit"],
      remaining: raw.tavilyRemaining ?? raw["tavily-remaining"]
    }, "tavily", env, { preserveUnconfigured: false, inheritedCount }),
    normalizeSearchProviderEntry({
      apiKey: raw.exaApiKey ?? raw["exa-api-key"],
      count: raw.count,
      limit: raw.exaMonthlyLimit ?? raw["exa-monthly-limit"],
      remaining: raw.exaRemaining ?? raw["exa-remaining"]
    }, "exa", env, { preserveUnconfigured: false, inheritedCount }),
    normalizeSearchProviderEntry({
      count: raw.count,
      url: raw.searxngUrl ?? raw["searxng-url"] ?? raw.url
    }, "searxng", env, { preserveUnconfigured: false, inheritedCount })
  ].filter(Boolean);

  if (!legacyPreferredBackend) return legacyEntries;
  return [
    ...legacyEntries.filter((entry) => entry.id === legacyPreferredBackend),
    ...legacyEntries.filter((entry) => entry.id !== legacyPreferredBackend)
  ];
}

export function resolveAmpWebSearchConfig(runtimeConfig = {}, env = {}) {
  const amp = runtimeConfig?.amp && typeof runtimeConfig.amp === "object" ? runtimeConfig.amp : {};
  const raw = runtimeConfig?.webSearch && typeof runtimeConfig.webSearch === "object" && !Array.isArray(runtimeConfig.webSearch)
    ? runtimeConfig.webSearch
    : (amp.webSearch && typeof amp.webSearch === "object" && !Array.isArray(amp.webSearch)
      ? amp.webSearch
      : {});
  const count = toInteger(
    raw.count ?? env.AMP_WEB_SEARCH_COUNT ?? env.WEB_SEARCH_COUNT,
    DEFAULT_SEARCH_COUNT,
    { min: MIN_SEARCH_COUNT, max: MAX_SEARCH_COUNT }
  );
  const providers = normalizeConfiguredSearchProviders(raw.providers, raw, env);

  return {
    strategy: normalizeSearchRoutingStrategy(raw.strategy ?? env.AMP_WEB_SEARCH_STRATEGY),
    count,
    providers
  };
}

function isSearchProviderConfigured(provider) {
  if (!provider || typeof provider !== "object") return false;
  if (isHostedSearchProvider(provider)) {
    return Boolean(String(provider.providerId || "").trim() && String(provider.model || "").trim());
  }
  if (provider.id === "searxng") return Boolean(String(provider.url || "").trim());
  return Boolean(String(provider.apiKey || "").trim());
}

function getResolvedHostedSearchRoute(runtimeConfig = {}, providerEntry = {}) {
  if (!isHostedSearchProvider(providerEntry)) return null;
  const resolvedRoute = resolveRouteReference(runtimeConfig, providerEntry.id);
  if (!resolvedRoute?.provider || !resolvedRoute?.model) return null;
  if (String(resolvedRoute.provider?.id || "").trim() !== String(providerEntry.providerId || "").trim()) return null;
  if (String(resolvedRoute.model?.id || "").trim() !== String(providerEntry.model || "").trim()) return null;
  return resolvedRoute;
}

function getResolvedHostedSearchModelFormats(provider, model) {
  const modelId = String(model?.id || "").trim();
  if (!modelId) return [];

  const preferredFormat = String(provider?.lastProbe?.modelPreferredFormat?.[modelId] || "").trim();
  if (preferredFormat === FORMATS.OPENAI || preferredFormat === FORMATS.CLAUDE) {
    return [preferredFormat];
  }

  const probedFormats = dedupeStrings(provider?.lastProbe?.modelSupport?.[modelId] || [])
    .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
  if (probedFormats.length > 0) return probedFormats;

  return dedupeStrings([...(model?.formats || []), model?.format])
    .filter((value) => value === FORMATS.OPENAI || value === FORMATS.CLAUDE);
}

function supportsResolvedHostedSearchRoute(provider, model) {
  const providerFormats = dedupeStrings([...(provider?.formats || []), provider?.format]);
  if (!providerFormats.includes(FORMATS.OPENAI)) return false;
  const modelFormats = getResolvedHostedSearchModelFormats(provider, model);
  return modelFormats.length === 0 || modelFormats.includes(FORMATS.OPENAI);
}

function buildHostedSearchProviderLabel(providerEntry, resolvedRoute = null) {
  const providerLabel = String(
    resolvedRoute?.provider?.name
    || resolvedRoute?.provider?.id
    || providerEntry?.providerId
    || providerEntry?.id
    || "Search provider"
  ).trim();
  const modelLabel = String(
    resolvedRoute?.model?.id
    || providerEntry?.model
    || ""
  ).trim();
  return modelLabel ? `${providerLabel} · ${modelLabel}` : providerLabel;
}

function extractAssistantTextFragments(payload) {
  const fragments = [];
  if (!payload || typeof payload !== "object") return fragments;

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    fragments.push(payload.output_text.trim());
  }

  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      const content = choice?.message?.content;
      if (typeof content === "string" && content.trim()) {
        fragments.push(content.trim());
      }
    }
  }

  if (payload.type === "message" && Array.isArray(payload.content)) {
    for (const block of payload.content) {
      if (typeof block?.text === "string" && block.text.trim()) {
        fragments.push(block.text.trim());
      }
    }
  }

  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (item?.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) continue;
      for (const block of item.content) {
        if (typeof block?.text === "string" && block.text.trim()) {
          fragments.push(block.text.trim());
          continue;
        }
        if (typeof block?.refusal === "string" && block.refusal.trim()) {
          fragments.push(block.refusal.trim());
        }
      }
    }
  }

  return fragments;
}

function payloadHasHostedWebSearchEvidence(payload) {
  if (!payload || typeof payload !== "object") return false;

  if (Array.isArray(payload.output)) {
    if (payload.output.some((item) => item?.type === "web_search_call")) return true;
    if (payload.output.some((item) => item?.type === "function_call" && hasSearchToolName(item?.name))) return true;
  }

  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      const toolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
      if (toolCalls.some((toolCall) => hasSearchToolName(toolCall?.function?.name))) {
        return true;
      }
    }
  }

  const contentBlocks = Array.isArray(payload?.content) ? payload.content : [];
  if (contentBlocks.some((block) => block?.type === "tool_use" && hasSearchToolName(block?.name))) {
    return true;
  }

  return false;
}

function readHostedSearchResponseText(payload) {
  return extractAssistantTextFragments(payload).join("\n\n").trim();
}

async function readSearchProviderError(response) {
  if (!(response instanceof Response)) return "Search provider request failed.";
  try {
    const raw = await response.text();
    const parsed = parseJsonSafely(raw, null);
    return String(
      parsed?.error?.message
      || parsed?.error?.code
      || parsed?.error?.type
      || parsed?.error
      || parsed?.message
      || raw
      || `Search provider request failed with status ${response.status}.`
    ).trim() || `Search provider request failed with status ${response.status}.`;
  } catch {
    return `Search provider request failed with status ${response.status}.`;
  }
}

function createInMemorySearchStateStore() {
  return {
    async getRouteCursor(routeKey) {
      const key = String(routeKey || "").trim();
      return key ? (inMemoryRouteCursor.get(key) || 0) : 0;
    },

    async setRouteCursor(routeKey, value) {
      const key = String(routeKey || "").trim();
      const normalized = Math.max(0, Math.floor(Number(value) || 0));
      if (key) inMemoryRouteCursor.set(key, normalized);
      return normalized;
    },

    async getCandidateState() {
      return null;
    },

    async setCandidateState() {
      return null;
    },

    async readBucketUsage(bucketKey, windowKey) {
      const compositeKey = `${String(bucketKey || "").trim()}::${String(windowKey || "").trim()}`;
      return inMemoryBucketUsage.get(compositeKey)?.count || 0;
    },

    async incrementBucketUsage(bucketKey, windowKey, amount = 1, options = {}) {
      const compositeKey = `${String(bucketKey || "").trim()}::${String(windowKey || "").trim()}`;
      const current = inMemoryBucketUsage.get(compositeKey) || { count: 0, expiresAt: 0 };
      const next = {
        count: current.count + Math.max(0, Math.floor(Number(amount) || 0)),
        expiresAt: Number(options?.expiresAt) || current.expiresAt || 0
      };
      inMemoryBucketUsage.set(compositeKey, next);
      return next.count;
    },

    async pruneExpired(now = Date.now()) {
      const currentTime = Number(now) || Date.now();
      let prunedBuckets = 0;
      for (const [key, value] of inMemoryBucketUsage.entries()) {
        const expiresAt = Number(value?.expiresAt) || 0;
        if (expiresAt > 0 && expiresAt <= currentTime) {
          inMemoryBucketUsage.delete(key);
          prunedBuckets += 1;
        }
      }
      return {
        prunedBuckets,
        prunedCandidateStates: 0
      };
    },

    async close() {
      return undefined;
    }
  };
}

function resolveSearchStateStore(stateStore) {
  return stateStore || createInMemorySearchStateStore();
}

function buildSearchProviderBucketKey(providerId) {
  return `amp-web-search:${String(providerId || "").trim()}`;
}

function buildSearchProviderWindow(provider, now = Date.now()) {
  const monthlyWindow = resolveWindowRange({ unit: "month", size: 1 }, now);
  const syncSeed = `${provider?.remaining ?? provider?.limit ?? 0}`;
  return {
    ...monthlyWindow,
    key: `${monthlyWindow.key}:sync=${syncSeed}`
  };
}

async function buildSearchProviderEvaluation(provider, stateStore, now = Date.now()) {
  const configuredRemaining = Number.isFinite(Number(provider?.remaining)) ? Math.max(0, Math.floor(Number(provider.remaining))) : 0;
  const limit = Number.isFinite(Number(provider?.limit)) ? Math.max(0, Math.floor(Number(provider.limit))) : 0;
  const window = buildSearchProviderWindow(provider, now);
  const hasQuota = limit > 0;
  const bucketKey = buildSearchProviderBucketKey(provider?.id);
  const usedSinceSync = hasQuota
    ? Math.max(0, Math.floor(Number(await stateStore.readBucketUsage(bucketKey, window.key)) || 0))
    : 0;
  const currentRemaining = hasQuota
    ? Math.max(0, configuredRemaining - usedSinceSync)
    : Number.POSITIVE_INFINITY;
  const remainingCapacityRatio = hasQuota
    ? (limit > 0 ? (currentRemaining / limit) : 0)
    : 1;
  const eligible = !hasQuota || currentRemaining > 0;
  const candidate = {
    providerId: "amp-web-search",
    modelId: provider.id,
    requestModelId: `amp-web-search/${provider.id}`,
    routeWeight: hasQuota ? Math.max(1, configuredRemaining || limit) : 1,
    targetFormat: FORMATS.OPENAI
  };
  const bucket = hasQuota
    ? {
        providerId: "amp-web-search",
        modelId: provider.id,
        bucketId: provider.id,
        bucketKey,
        window,
        windowKey: window.key,
        requests: Math.max(1, configuredRemaining || limit),
        models: [provider.id],
        metadata: {
          providerId: provider.id,
          syncSeed: configuredRemaining
        },
        used: usedSinceSync,
        remaining: currentRemaining,
        remainingRatio: remainingCapacityRatio,
        exhausted: currentRemaining <= 0
      }
    : null;

  return {
    candidate,
    candidateKey: buildCandidateKey(candidate),
    eligible,
    remainingCapacityRatio,
    buckets: bucket ? [bucket] : [],
    exhaustedBuckets: bucket?.exhausted ? [bucket] : [],
    usedSinceSync,
    currentRemaining
  };
}

function buildSearchProviderStatus(provider, evaluation, runtimeConfig = {}) {
  const hostedRoute = getResolvedHostedSearchRoute(runtimeConfig, provider);
  const hostedRouteReady = hostedRoute
    ? supportsResolvedHostedSearchRoute(hostedRoute.provider, hostedRoute.model)
    : false;
  const definition = AMP_WEB_SEARCH_PROVIDER_META.get(provider.id) || { label: buildHostedSearchProviderLabel(provider, hostedRoute) };
  const limit = Number.isFinite(Number(provider?.limit)) ? Math.max(0, Math.floor(Number(provider.limit))) : 0;
  const configured = isSearchProviderConfigured(provider);
  return {
    ...provider,
    label: definition.label,
    configured,
    ready: isHostedSearchProvider(provider) ? hostedRouteReady : configured,
    count: resolveSearchProviderCount(provider),
    limit,
    configuredRemaining: Number.isFinite(Number(provider?.remaining)) ? Math.max(0, Math.floor(Number(provider.remaining))) : Math.max(0, limit),
    usedSinceSync: evaluation.usedSinceSync,
    currentRemaining: Number.isFinite(evaluation.currentRemaining) ? evaluation.currentRemaining : null,
    remainingCapacityRatio: evaluation.remainingCapacityRatio,
    exhausted: evaluation.eligible === false,
    hostedRoute: hostedRoute
      ? {
          providerId: hostedRoute.provider.id,
          providerName: hostedRoute.provider.name || hostedRoute.provider.id,
          modelId: hostedRoute.model.id
        }
      : null,
    evaluation
  };
}

export async function buildAmpWebSearchSnapshot(runtimeConfig = {}, { env = {}, stateStore = null, now = Date.now() } = {}) {
  const settings = resolveAmpWebSearchConfig(runtimeConfig, env);
  const effectiveStateStore = resolveSearchStateStore(stateStore);
  const providers = [];

  for (const provider of settings.providers) {
    const evaluation = await buildSearchProviderEvaluation(provider, effectiveStateStore, now);
    providers.push(buildSearchProviderStatus(provider, evaluation, runtimeConfig));
  }

  return {
    strategy: settings.strategy,
    count: settings.count,
    providers,
    configuredProviderCount: providers.filter((provider) => provider.configured).length,
    interceptEnabled: providers.some((provider) => provider.ready)
  };
}

async function rankConfiguredSearchProviders(providerStatuses, strategy, stateStore, now = Date.now()) {
  if (!Array.isArray(providerStatuses) || providerStatuses.length === 0) {
    return [];
  }

  const evaluations = new Map();
  const candidates = [];
  for (const status of providerStatuses) {
    evaluations.set(status.evaluation.candidateKey, status.evaluation);
    candidates.push(status.evaluation.candidate);
  }

  const ranking = await rankRouteCandidates({
    route: {
      routeType: "amp-web-search",
      routeRef: "webSearch",
      routeStrategy: strategy === "quota-balance" ? "quota-aware-weighted-rr" : "ordered"
    },
    routeKey: SEARCH_ROUTE_KEY,
    strategy: strategy === "quota-balance" ? "quota-aware-weighted-rr" : "ordered",
    candidates,
    stateStore,
    config: { providers: [] },
    rateLimitEvaluations: evaluations,
    now
  });

  if (ranking.shouldAdvanceCursor) {
    await commitRouteSelection(stateStore, ranking, {
      amount: 0,
      now
    });
  }

  const statusById = new Map(providerStatuses.map((status) => [status.id, status]));
  return ranking.entries
    .filter((entry) => entry?.eligible)
    .map((entry) => statusById.get(entry?.candidate?.modelId))
    .filter(Boolean);
}

function buildSearchTag(providerStatus) {
  const label = String(providerStatus?.label || providerStatus?.id || "Search").trim();
  const limit = Number(providerStatus?.limit) || 0;
  if (limit > 0 && Number.isFinite(providerStatus?.currentRemaining)) {
    return `${label} (${providerStatus.currentRemaining}/${limit} remaining)`;
  }
  return label;
}

function decodeDuckDuckGoRedirect(url) {
  const normalized = String(url || "").trim();
  const uddgMatch = normalized.match(/[?&]uddg=([^&]+)/i);
  return uddgMatch ? decodeURIComponent(uddgMatch[1]) : normalized;
}

async function searchBrave(query, count, provider) {
  if (!provider?.apiKey) return null;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&text_decorations=false`;
  const response = await runFetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": provider.apiKey
    }
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const results = Array.isArray(payload?.web?.results) ? payload.web.results.slice(0, count) : [];
  if (results.length === 0) return null;
  return formatSearchResults(results.map((item) => ({
    title: item?.title,
    url: item?.url,
    snippet: item?.description
  })));
}

async function searchTavily(query, count, provider) {
  if (!provider?.apiKey) return null;
  const response = await runFetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: provider.apiKey,
      query,
      max_results: count,
      include_answer: true,
      search_depth: "basic"
    })
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const answer = String(payload?.answer || "").trim();
  const results = Array.isArray(payload?.results) ? payload.results.slice(0, count) : [];
  if (!answer && results.length === 0) return null;
  const formatted = formatSearchResults(results.map((item) => ({
    title: item?.title,
    url: item?.url,
    snippet: item?.content
  })));
  return [answer ? `AI Summary: ${answer}` : "", formatted].filter(Boolean).join("\n\n").trim();
}

async function searchExa(query, count, provider) {
  if (!provider?.apiKey) return null;
  const response = await runFetchWithTimeout("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey
    },
    body: JSON.stringify({
      query,
      numResults: count,
      type: "auto",
      contents: {
        text: {
          maxCharacters: 500
        }
      }
    })
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const results = Array.isArray(payload?.results) ? payload.results.slice(0, count) : [];
  if (results.length === 0) return null;
  return formatSearchResults(results.map((item) => ({
    title: item?.title,
    url: item?.url,
    snippet: item?.text || item?.snippet
  })));
}

async function searchSearXng(query, count, provider) {
  if (!provider?.url) return null;
  const url = `${provider.url}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=auto`;
  const response = await runFetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "llm-router"
    }
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const results = Array.isArray(payload?.results) ? payload.results.slice(0, count) : [];
  if (results.length === 0) return null;
  return formatSearchResults(results.map((item) => ({
    title: item?.title,
    url: item?.url,
    snippet: item?.content
  })));
}

async function searchGoogleNews(query, count) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const response = await runFetchWithTimeout(url, {
    headers: {
      "User-Agent": "llm-router"
    }
  });
  if (!response.ok) return null;
  const xml = await response.text();
  const matches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, count);
  if (matches.length === 0) return null;
  const results = matches.map((match) => {
    const block = match[1] || "";
    const title = stripHtml((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "");
    const urlValue = String((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || "").trim();
    const source = stripHtml((block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || "");
    const published = stripHtml((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || "");
    return {
      title,
      url: urlValue,
      snippet: [source, published].filter(Boolean).join(" - ")
    };
  }).filter((entry) => entry.title || entry.url);
  if (results.length === 0) return null;
  return formatSearchResults(results);
}

async function searchDuckDuckGoHtml(query, count) {
  const response = await runFetchWithTimeout("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0"
    },
    body: `q=${encodeURIComponent(query)}`
  });
  if (!response.ok) return null;
  const html = await response.text();
  const linkMatches = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].slice(0, count);
  if (linkMatches.length === 0) return null;
  const snippetMatches = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  const results = linkMatches.map((match, index) => ({
    title: stripHtml(match[2]),
    url: decodeDuckDuckGoRedirect(match[1]),
    snippet: stripHtml(snippetMatches[index]?.[1] || "")
  }));
  return formatSearchResults(results);
}

async function searchBing(query, count) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}`;
  const response = await runFetchWithTimeout(url, {
    headers: {
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) return null;
  const html = await response.text();
  const matches = [...html.matchAll(/<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g)].slice(0, count);
  if (matches.length === 0) return null;
  const results = matches.map((match) => {
    const block = match[1] || "";
    const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!linkMatch) return null;
    return {
      title: stripHtml(linkMatch[2]),
      url: linkMatch[1],
      snippet: stripHtml(snippetMatch?.[1] || "")
    };
  }).filter(Boolean);
  if (results.length === 0) return null;
  return formatSearchResults(results);
}

async function searchDuckDuckGoLite(query, count) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const response = await runFetchWithTimeout(url, {
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) return null;
  const html = await response.text();
  const linkMatches = [...html.matchAll(/href="([^"]+)"[^>]*class='result-link'>([\s\S]*?)<\/a>/g)].slice(0, count);
  if (linkMatches.length === 0) return null;
  const snippetMatches = [...html.matchAll(/class='result-snippet'>([\s\S]*?)<\/td>/g)];
  const results = linkMatches.map((match, index) => ({
    title: stripHtml(match[2]),
    url: decodeDuckDuckGoRedirect(match[1]),
    snippet: stripHtml(snippetMatches[index]?.[1] || "")
  }));
  return formatSearchResults(results);
}

async function searchHostedProviderRoute(query, count, provider, runtimeConfig = {}, env = {}, runtimeFlags) {
  void count;
  if (!isHostedSearchProvider(provider)) return null;
  const result = await runHostedSearchProviderQuery(provider, query, runtimeConfig, env, runtimeFlags);
  return String(result?.text || "").trim() || null;
}

const backendSearchers = Object.freeze({
  brave: searchBrave,
  tavily: searchTavily,
  exa: searchExa,
  searxng: searchSearXng,
  gnews: searchGoogleNews,
  ddghtml: searchDuckDuckGoHtml,
  bing: searchBing,
  ddglite: searchDuckDuckGoLite
});

export async function executeAmpWebSearch(query, runtimeConfig = {}, env = {}, options = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return {
      text: "[Empty search query]",
      backend: "",
      tag: ""
    };
  }

  const snapshot = await buildAmpWebSearchSnapshot(runtimeConfig, {
    env,
    stateStore: options.stateStore,
    now: options.now
  });
  const stateStore = resolveSearchStateStore(options.stateStore);
  const configuredProviders = snapshot.providers.filter((provider) => provider.ready);
  const rankedConfiguredProviders = await rankConfiguredSearchProviders(
    configuredProviders,
    snapshot.strategy,
    stateStore,
    options.now
  );

  for (const providerStatus of rankedConfiguredProviders) {
    try {
      const searcher = isHostedSearchProvider(providerStatus)
        ? searchHostedProviderRoute
        : backendSearchers[providerStatus.id];
      if (typeof searcher !== "function") continue;
      const providerCount = resolveSearchProviderCount(providerStatus, snapshot.count);
      const result = isHostedSearchProvider(providerStatus)
        ? await searcher(normalizedQuery, providerCount, providerStatus, runtimeConfig, env, options.runtimeFlags)
        : await searcher(normalizedQuery, providerCount, providerStatus);
      if (!result || !String(result).trim()) continue;
      await consumeCandidateRateLimits(stateStore, providerStatus.evaluation, {
        amount: 1,
        now: options.now
      });
      const refreshedSnapshot = await buildAmpWebSearchSnapshot(runtimeConfig, {
        env,
        stateStore,
        now: options.now
      });
      const refreshedProvider = refreshedSnapshot.providers.find((entry) => entry.id === providerStatus.id) || providerStatus;
      return {
        text: String(result).trim(),
        backend: providerStatus.id,
        providerId: providerStatus.id,
        tag: buildSearchTag(refreshedProvider)
      };
    } catch {
      continue;
    }
  }

  for (const backend of FREE_FALLBACK_BACKENDS) {
    const searcher = backendSearchers[backend];
    if (typeof searcher !== "function") continue;
    try {
      const result = await searcher(normalizedQuery, snapshot.count);
      if (!result || !String(result).trim()) continue;
      return {
        text: String(result).trim(),
        backend,
        providerId: backend,
        tag: backend
      };
    } catch {
      continue;
    }
  }

  return {
    text: "[No search results available]",
    backend: "",
    tag: ""
  };
}

export function shouldInterceptAmpWebSearch({ clientType, originalBody, runtimeConfig, env }) {
  const tools = Array.isArray(originalBody?.tools) ? originalBody.tools : [];
  const requestedToolNames = dedupeStrings(tools.map((tool) => getToolName(tool)).filter(Boolean));
  if (requestedToolNames.length === 0) {
    return false;
  }
  const readyProviders = resolveAmpWebSearchConfig(runtimeConfig, env).providers.filter((provider) => {
    if (!isSearchProviderConfigured(provider)) return false;
    if (!isHostedSearchProvider(provider)) return true;
    const resolvedRoute = getResolvedHostedSearchRoute(runtimeConfig, provider);
    return Boolean(resolvedRoute && supportsResolvedHostedSearchRoute(resolvedRoute.provider, resolvedRoute.model));
  });
  if (readyProviders.length === 0) {
    return clientType === "amp" && requestedToolNames.includes(READ_WEB_PAGE_TOOL_NAME);
  }
  if (clientType === "amp") {
    if (requestedToolNames.includes(READ_WEB_PAGE_TOOL_NAME)) return true;
    return true;
  }
  return true;
}

function getOpenAIInterceptToolDefinitions(requestKind) {
  if (requestKind === "responses") {
    return {
      webSearch: OPENAI_RESPONSES_WEB_SEARCH_TOOL,
      readWebPage: OPENAI_RESPONSES_READ_WEB_PAGE_TOOL
    };
  }
  return {
    webSearch: OPENAI_CHAT_WEB_SEARCH_TOOL,
    readWebPage: OPENAI_CHAT_READ_WEB_PAGE_TOOL
  };
}

export function rewriteProviderBodyForAmpWebSearch(providerBody, targetFormat, requestKind = undefined) {
  const tools = Array.isArray(providerBody?.tools) ? providerBody.tools : [];
  if (tools.length === 0) {
    return {
      providerBody,
      hasWebSearch: false
    };
  }

  const interceptedToolNames = new Set();
  const nextTools = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      nextTools.push(tool);
      continue;
    }
    const toolName = getToolName(tool);
    if (toolName) {
      interceptedToolNames.add(toolName);
      continue;
    }
    nextTools.push(tool);
  }

  if (interceptedToolNames.size === 0) {
    return {
      providerBody,
      hasWebSearch: false
    };
  }

  if (targetFormat === FORMATS.OPENAI) {
    const toolDefinitions = getOpenAIInterceptToolDefinitions(requestKind);
    if (interceptedToolNames.has(SEARCH_TOOL_NAME)) nextTools.push(toolDefinitions.webSearch);
    if (interceptedToolNames.has(READ_WEB_PAGE_TOOL_NAME)) nextTools.push(toolDefinitions.readWebPage);
  } else if (targetFormat === FORMATS.CLAUDE) {
    if (interceptedToolNames.has(SEARCH_TOOL_NAME)) nextTools.push(CLAUDE_WEB_SEARCH_TOOL);
    if (interceptedToolNames.has(READ_WEB_PAGE_TOOL_NAME)) nextTools.push(CLAUDE_READ_WEB_PAGE_TOOL);
  }

  return {
    hasWebSearch: true,
    providerBody: {
      ...providerBody,
      tools: nextTools
    }
  };
}

function extractOpenAIChatProbe(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = choice?.message && typeof choice.message === "object" ? choice.message : null;
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.filter((item) => hasInterceptableToolName(item?.function?.name))
    : [];

  return {
    hasWebSearchCalls: toolCalls.length > 0,
    toolCalls,
    assistantMessage: message ? {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : (message.content || ""),
      ...(Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? { tool_calls: message.tool_calls } : {})
    } : null
  };
}

function normalizeResponseInput(input) {
  if (Array.isArray(input)) return input.slice();
  const normalized = String(input || "").trim();
  if (!normalized) return [];
  return [{
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: normalized
    }]
  }];
}

function extractOpenAIResponsesProbe(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const toolCalls = output.filter((item) => item?.type === "function_call" && hasInterceptableToolName(item?.name));
  const assistantInputItems = output
    .filter((item) => item && item.type !== "reasoning")
    .map((item) => {
      if (item.type === "message") {
        return {
          type: "message",
          role: item.role || "assistant",
          content: Array.isArray(item.content) ? item.content : []
        };
      }
      if (item.type === "function_call") {
        return {
          type: "function_call",
          call_id: item.call_id || item.id || `call_${Date.now()}`,
          name: item.name || SEARCH_TOOL_NAME,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        };
      }
      return null;
    })
    .filter(Boolean);

  return {
    hasWebSearchCalls: toolCalls.length > 0,
    toolCalls,
    assistantInputItems
  };
}

function extractClaudeProbe(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const assistantContent = content.filter((item) => item?.type !== "thinking" && item?.type !== "redacted_thinking");
  const toolCalls = assistantContent.filter((item) => item?.type === "tool_use" && hasInterceptableToolName(item?.name));

  return {
    hasWebSearchCalls: toolCalls.length > 0,
    toolCalls,
    assistantContent
  };
}

export function extractAmpWebSearchProbe(payload, { targetFormat, requestKind }) {
  if (targetFormat === FORMATS.CLAUDE) {
    return extractClaudeProbe(payload);
  }
  if (targetFormat === FORMATS.OPENAI && requestKind === "responses") {
    return extractOpenAIResponsesProbe(payload);
  }
  if (targetFormat === FORMATS.OPENAI) {
    return extractOpenAIChatProbe(payload);
  }
  return {
    hasWebSearchCalls: false,
    toolCalls: []
  };
}

function extractQueryFromToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return "";
  if (typeof toolCall?.input?.query === "string") return toolCall.input.query.trim();
  const parsedArguments = parseJsonSafely(toolCall?.arguments, {});
  if (typeof parsedArguments?.query === "string") return parsedArguments.query.trim();
  const parsedFunctionArguments = parseJsonSafely(toolCall?.function?.arguments, {});
  if (typeof parsedFunctionArguments?.query === "string") return parsedFunctionArguments.query.trim();
  if (typeof toolCall?.function?.query === "string") return toolCall.function.query.trim();
  return "";
}

function extractUrlFromToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return "";
  for (const candidate of [
    toolCall?.input?.url,
    toolCall?.input?.uri,
    toolCall?.input?.href
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const parsedArguments = parseJsonSafely(toolCall?.arguments, {});
  for (const candidate of [parsedArguments?.url, parsedArguments?.uri, parsedArguments?.href]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const parsedFunctionArguments = parseJsonSafely(toolCall?.function?.arguments, {});
  for (const candidate of [parsedFunctionArguments?.url, parsedFunctionArguments?.uri, parsedFunctionArguments?.href]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const candidate of [toolCall?.function?.url, toolCall?.function?.uri, toolCall?.function?.href]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function getToolCallName(toolCall) {
  return getToolName(toolCall);
}

function buildToolResultText(query, searchText) {
  const normalizedQuery = String(query || "").trim();
  const normalizedResults = String(searchText || "").trim() || "[No search results available]";
  if (!normalizedQuery) return normalizedResults;
  return `Web search results for "${normalizedQuery}":\n\n${normalizedResults}`;
}

function buildReadWebPageResultText(url, pageText) {
  const normalizedUrl = String(url || "").trim();
  const normalizedPageText = String(pageText || "").trim() || "[Unable to extract web page content]";
  if (!normalizedUrl) return normalizedPageText;
  return `Web page content from "${normalizedUrl}":\n\n${normalizedPageText}`;
}

async function executeAmpReadWebPage(url) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) {
    return {
      text: "[Missing URL for read_web_page]",
      providerId: READ_WEB_PAGE_TOOL_NAME,
      backend: READ_WEB_PAGE_TOOL_NAME,
      tag: READ_WEB_PAGE_TOOL_NAME
    };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return {
      text: `[Invalid URL for read_web_page: ${normalizedUrl}]`,
      providerId: READ_WEB_PAGE_TOOL_NAME,
      backend: READ_WEB_PAGE_TOOL_NAME,
      tag: READ_WEB_PAGE_TOOL_NAME
    };
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return {
      text: `[Unsupported URL protocol for read_web_page: ${parsedUrl.protocol}]`,
      providerId: READ_WEB_PAGE_TOOL_NAME,
      backend: READ_WEB_PAGE_TOOL_NAME,
      tag: READ_WEB_PAGE_TOOL_NAME
    };
  }

  try {
    const response = await runFetchWithTimeout(parsedUrl.toString(), {
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
        "User-Agent": "llm-router"
      }
    });
    if (!response.ok) {
      return {
        text: `[Failed to read web page: ${await readSearchProviderError(response)}]`,
        providerId: READ_WEB_PAGE_TOOL_NAME,
        backend: READ_WEB_PAGE_TOOL_NAME,
        tag: READ_WEB_PAGE_TOOL_NAME
      };
    }

    const contentType = String(response.headers.get("content-type") || "").trim();
    const bodyText = await response.text();
    const formattedText = looksLikeHtml(contentType, bodyText)
      ? formatReadWebPageHtml(parsedUrl.toString(), bodyText)
      : formatReadWebPageBody(parsedUrl.toString(), bodyText, contentType);

    return {
      text: formattedText,
      providerId: READ_WEB_PAGE_TOOL_NAME,
      backend: READ_WEB_PAGE_TOOL_NAME,
      tag: READ_WEB_PAGE_TOOL_NAME
    };
  } catch (error) {
    return {
      text: `[Failed to read web page: ${error instanceof Error ? error.message : String(error)}]`,
      providerId: READ_WEB_PAGE_TOOL_NAME,
      backend: READ_WEB_PAGE_TOOL_NAME,
      tag: READ_WEB_PAGE_TOOL_NAME
    };
  }
}

async function executeAmpInterceptedToolCall(toolCall, runtimeConfig, env, options = {}) {
  const toolName = getToolCallName(toolCall);
  if (toolName === READ_WEB_PAGE_TOOL_NAME) {
    return executeAmpReadWebPage(extractUrlFromToolCall(toolCall));
  }
  return executeAmpWebSearch(
    extractQueryFromToolCall(toolCall),
    runtimeConfig,
    env,
    options
  );
}

function mergeClaudeSystemInstruction(system, instruction) {
  if (typeof system === "string" && system.trim()) {
    return `${system.trim()}\n\n${instruction}`;
  }
  if (Array.isArray(system) && system.length > 0) {
    return [
      ...system,
      {
        type: "text",
        text: instruction
      }
    ];
  }
  return instruction;
}

function mergeOpenAIInstructions(originalInstructions, instruction) {
  const existing = String(originalInstructions || "").trim();
  return existing ? `${existing}\n\n${instruction}` : instruction;
}

export function buildAmpWebSearchFollowUp(providerBody, probePayload, probe, searchResultsByCall, { targetFormat, requestKind, stream }) {
  const toolCalls = Array.isArray(probe?.toolCalls) ? probe.toolCalls : [];
  const normalizedToolResults = Array.isArray(searchResultsByCall)
    ? searchResultsByCall
    : [];

  if (targetFormat === FORMATS.CLAUDE) {
    const toolResults = toolCalls.map((toolCall, index) => ({
      type: "tool_result",
      tool_use_id: toolCall.id || `tool_${index + 1}`,
      content: getToolCallName(toolCall) === READ_WEB_PAGE_TOOL_NAME
        ? buildReadWebPageResultText(
            extractUrlFromToolCall(toolCall),
            normalizedToolResults[index]?.text
          )
        : buildToolResultText(
            extractQueryFromToolCall(toolCall),
            normalizedToolResults[index]?.text
          )
    }));
    return {
      ...providerBody,
      stream: Boolean(stream),
      system: mergeClaudeSystemInstruction(providerBody.system, SEARCH_SYSTEM_INSTRUCTION),
      messages: [
        ...(Array.isArray(providerBody.messages) ? providerBody.messages : []),
        {
          role: "assistant",
          content: Array.isArray(probe.assistantContent) ? probe.assistantContent : []
        },
        {
          role: "user",
          content: toolResults
        }
      ]
    };
  }

  if (targetFormat === FORMATS.OPENAI && requestKind === "responses") {
    const toolOutputs = toolCalls.map((toolCall, index) => ({
      type: "function_call_output",
      call_id: toolCall.call_id || toolCall.id || `call_${index + 1}`,
      output: getToolCallName(toolCall) === READ_WEB_PAGE_TOOL_NAME
        ? buildReadWebPageResultText(
            extractUrlFromToolCall(toolCall),
            normalizedToolResults[index]?.text
          )
        : buildToolResultText(
            extractQueryFromToolCall(toolCall),
            normalizedToolResults[index]?.text
          )
    }));
    return {
      ...providerBody,
      stream: Boolean(stream),
      input: [
        ...normalizeResponseInput(providerBody.input),
        ...(Array.isArray(probe.assistantInputItems) ? probe.assistantInputItems : []),
        ...toolOutputs
      ],
      instructions: mergeOpenAIInstructions(providerBody.instructions, SEARCH_SYSTEM_INSTRUCTION)
    };
  }

  const assistantMessage = probe?.assistantMessage && typeof probe.assistantMessage === "object"
    ? probe.assistantMessage
    : {
      role: "assistant",
      content: ""
    };
  const toolMessages = toolCalls.map((toolCall, index) => ({
    role: "tool",
    tool_call_id: toolCall.id || `call_${index + 1}`,
    content: getToolCallName(toolCall) === READ_WEB_PAGE_TOOL_NAME
      ? buildReadWebPageResultText(
          extractUrlFromToolCall(toolCall),
          normalizedToolResults[index]?.text
        )
      : buildToolResultText(
          extractQueryFromToolCall(toolCall),
          normalizedToolResults[index]?.text
        )
  }));
  const nextMessages = Array.isArray(providerBody.messages) ? providerBody.messages.slice() : [];
  const hasLeadingSystem = nextMessages[0]?.role === "system";
  if (hasLeadingSystem && typeof nextMessages[0].content === "string") {
    nextMessages[0] = {
      ...nextMessages[0],
      content: mergeOpenAIInstructions(nextMessages[0].content, SEARCH_SYSTEM_INSTRUCTION)
    };
  } else {
    nextMessages.unshift({
      role: "system",
      content: SEARCH_SYSTEM_INSTRUCTION
    });
  }
  nextMessages.push(assistantMessage, ...toolMessages);
  return {
    ...providerBody,
    stream: Boolean(stream),
    messages: nextMessages
  };
}

export function stripAmpWebSearchFollowUpTools(providerBody) {
  const nextBody = {
    ...providerBody
  };
  delete nextBody.tool_choice;
  delete nextBody.parallel_tool_calls;
  delete nextBody.max_tool_calls;
  if (Array.isArray(nextBody.tools)) {
    delete nextBody.tools;
  }
  return nextBody;
}

function splitSseEventBlocks(rawText) {
  return String(rawText || "")
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean);
}

function parseSseDataLines(block) {
  const dataLines = [];
  for (const line of String(block || "").split("\n")) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice(5).trimStart());
  }
  return dataLines.join("\n").trim();
}

function parseOpenAIChatStreamPayload(rawText) {
  const toolCalls = [];
  const toolCallsByIndex = new Map();
  let responseId = "";
  let model = "";
  let content = "";
  let finishReason = "stop";

  for (const block of splitSseEventBlocks(rawText)) {
    const dataText = parseSseDataLines(block);
    if (!dataText || dataText === "[DONE]") continue;

    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch {
      continue;
    }

    responseId = responseId || String(payload?.id || "").trim();
    model = model || String(payload?.model || "").trim();

    for (const choice of (Array.isArray(payload?.choices) ? payload.choices : [])) {
      const delta = choice?.delta || {};
      if (typeof delta?.content === "string") {
        content += delta.content;
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const call of delta.tool_calls) {
          const callIndex = Number.isFinite(Number(call?.index)) ? Number(call.index) : toolCalls.length;
          const current = toolCallsByIndex.get(callIndex) || {
            id: call?.id || `call_${callIndex + 1}`,
            type: "function",
            function: {
              name: "",
              arguments: ""
            }
          };
          if (call?.id) current.id = call.id;
          if (call?.function?.name) current.function.name += call.function.name;
          if (call?.function?.arguments) current.function.arguments += call.function.arguments;
          toolCallsByIndex.set(callIndex, current);
        }
      }

      if (delta?.function_call && typeof delta.function_call === "object") {
        const current = toolCallsByIndex.get(0) || {
          id: payload?.id ? `${payload.id}_tool_1` : "call_1",
          type: "function",
          function: {
            name: "",
            arguments: ""
          }
        };
        if (delta.function_call.name) current.function.name += delta.function_call.name;
        if (delta.function_call.arguments) current.function.arguments += delta.function_call.arguments;
        toolCallsByIndex.set(0, current);
      }

      if (choice?.finish_reason) {
        finishReason = String(choice.finish_reason).trim() || finishReason;
      }
    }
  }

  const orderedIndexes = [...toolCallsByIndex.keys()].sort((left, right) => left - right);
  for (const index of orderedIndexes) {
    toolCalls.push(toolCallsByIndex.get(index));
  }

  return {
    id: responseId || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    model: model || "unknown",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        },
        finish_reason: finishReason
      }
    ]
  };
}

function parseOpenAIResponsesStreamPayload(rawText) {
  let completedResponse = null;
  let responseId = "";
  let createdAt = Math.floor(Date.now() / 1000);
  let model = "";
  let usage = null;
  const output = [];
  const messageItems = new Map();
  const functionItems = new Map();

  function ensureMessageItem(itemId) {
    const current = messageItems.get(itemId) || {
      type: "message",
      id: itemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "" }]
    };
    messageItems.set(itemId, current);
    return current;
  }

  function ensureFunctionItem(itemId, callId = itemId) {
    const current = functionItems.get(itemId) || {
      type: "function_call",
      id: itemId,
      call_id: callId,
      name: SEARCH_TOOL_NAME,
      arguments: "",
      status: "completed"
    };
    functionItems.set(itemId, current);
    return current;
  }

  for (const block of splitSseEventBlocks(rawText)) {
    const dataText = parseSseDataLines(block);
    if (!dataText || dataText === "[DONE]") continue;

    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch {
      continue;
    }

    if (payload?.type === "response.completed" && payload?.response && typeof payload.response === "object") {
      completedResponse = payload.response;
      break;
    }

    if (payload?.response && typeof payload.response === "object") {
      responseId = responseId || String(payload.response.id || "").trim();
      model = model || String(payload.response.model || "").trim();
      if (Number.isFinite(payload.response.created_at)) createdAt = Number(payload.response.created_at);
      if (payload.response.usage && typeof payload.response.usage === "object") usage = payload.response.usage;
    }

    if (payload?.type === "response.output_item.added") {
      const item = payload.item || payload.output_item;
      if (item?.type === "message") {
        messageItems.set(item.id || `msg_${messageItems.size + 1}`, {
          ...item,
          content: Array.isArray(item.content) ? item.content.slice() : []
        });
      }
      if (item?.type === "function_call") {
        functionItems.set(item.id || `fc_${functionItems.size + 1}`, {
          ...item,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
          status: item.status || "completed"
        });
      }
      continue;
    }

    if (payload?.type === "response.output_text.delta") {
      const messageItem = ensureMessageItem(String(payload.item_id || "msg_1"));
      const currentText = typeof messageItem.content?.[0]?.text === "string" ? messageItem.content[0].text : "";
      messageItem.content = [{ type: "output_text", text: `${currentText}${payload.delta || ""}` }];
      continue;
    }

    if (payload?.type === "response.function_call_arguments.delta") {
      const functionItem = ensureFunctionItem(String(payload.item_id || "fc_1"));
      functionItem.arguments += String(payload.delta || "");
      continue;
    }

    if (payload?.type === "response.output_item.done") {
      const item = payload.item || payload.output_item;
      if (item?.type === "message") {
        messageItems.set(item.id || `msg_${messageItems.size + 1}`, item);
      }
      if (item?.type === "function_call") {
        functionItems.set(item.id || `fc_${functionItems.size + 1}`, {
          ...item,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
          status: item.status || "completed"
        });
      }
    }
  }

  if (completedResponse) return completedResponse;

  for (const item of messageItems.values()) output.push(item);
  for (const item of functionItems.values()) output.push(item);

  return {
    id: responseId || `resp_${Date.now()}`,
    object: "response",
    created_at: createdAt,
    model: model || "unknown",
    status: "completed",
    output,
    usage
  };
}

function parseClaudeStreamPayload(rawText) {
  let messageId = "";
  let model = "";
  let stopReason = "end_turn";
  let usage = null;
  const activeBlocks = new Map();
  const orderedBlocks = [];

  function ensureBlock(index, contentBlock = {}) {
    if (activeBlocks.has(index)) return activeBlocks.get(index);
    const blockType = String(contentBlock?.type || "").trim();
    const block = blockType === "tool_use"
      ? {
          type: "tool_use",
          id: contentBlock.id || `tool_${index + 1}`,
          name: contentBlock.name || SEARCH_TOOL_NAME,
          input: contentBlock.input && typeof contentBlock.input === "object" ? contentBlock.input : {}
        }
      : blockType === "thinking" || blockType === "redacted_thinking"
        ? {
            type: blockType,
            thinking: contentBlock.thinking || ""
          }
        : {
            type: "text",
            text: contentBlock.text || ""
          };
    activeBlocks.set(index, block);
    orderedBlocks[index] = block;
    return block;
  }

  for (const block of splitSseEventBlocks(rawText)) {
    const dataText = parseSseDataLines(block);
    if (!dataText || dataText === "[DONE]") continue;

    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch {
      continue;
    }

    const type = String(payload?.type || "").trim();
    if (!type) continue;

    if (type === "message_start") {
      const message = payload.message || {};
      messageId = messageId || String(message.id || "").trim();
      model = model || String(message.model || "").trim();
      if (message.usage && typeof message.usage === "object") {
        usage = {
          input_tokens: Number(message.usage.input_tokens) || 0,
          output_tokens: Number(message.usage.output_tokens) || 0
        };
      }
      continue;
    }

    if (type === "content_block_start") {
      const index = Number(payload.index);
      ensureBlock(index, payload.content_block || {});
      continue;
    }

    if (type === "content_block_delta") {
      const index = Number(payload.index);
      const current = ensureBlock(index, payload.content_block || {});
      const delta = payload.delta || {};
      if (delta.type === "text_delta" && typeof delta.text === "string" && current.type === "text") {
        current.text += delta.text;
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && current.type === "tool_use") {
        const existing = typeof current.__input_json === "string" ? current.__input_json : "";
        current.__input_json = `${existing || ""}${delta.partial_json}`;
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && (current.type === "thinking" || current.type === "redacted_thinking")) {
        current.thinking += delta.thinking;
      }
      continue;
    }

    if (type === "content_block_stop") {
      const index = Number(payload.index);
      const current = activeBlocks.get(index);
      if (current?.type === "tool_use" && typeof current.__input_json === "string") {
        current.input = parseJsonSafely(current.__input_json, current.input || {});
        delete current.__input_json;
      }
      continue;
    }

    if (type === "message_delta") {
      if (payload.delta && typeof payload.delta === "object") {
        stopReason = String(payload.delta.stop_reason || stopReason).trim() || stopReason;
      }
      if (payload.usage && typeof payload.usage === "object") {
        usage = {
          ...(usage || {}),
          output_tokens: Number(payload.usage.output_tokens) || Number(usage?.output_tokens) || 0
        };
      }
    }
  }

  return {
    id: messageId || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: model || "unknown",
    content: orderedBlocks.filter(Boolean),
    stop_reason: stopReason,
    usage
  };
}

async function collectAmpWebSearchProbePayload(response, { targetFormat, requestKind }) {
  if (!(response instanceof Response)) return null;
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();

  if (!contentType.includes("text/event-stream")) {
    try {
      return await response.clone().json();
    } catch {
      return null;
    }
  }

  let rawText = "";
  try {
    rawText = await response.clone().text();
  } catch {
    return null;
  }

  if (targetFormat === FORMATS.CLAUDE) {
    return parseClaudeStreamPayload(rawText);
  }
  if (targetFormat === FORMATS.OPENAI && requestKind === "responses") {
    return parseOpenAIResponsesStreamPayload(rawText);
  }
  if (targetFormat === FORMATS.OPENAI) {
    return parseOpenAIChatStreamPayload(rawText);
  }
  return null;
}

async function executeHostedSearchProviderRequest(resolvedRoute, body, env = {}, runtimeFlags) {
  const provider = resolvedRoute?.provider;
  if (!provider || typeof provider !== "object") {
    throw new Error("Hosted web search provider is not configured.");
  }

  if (isSubscriptionProvider(provider)) {
    if (runtimeFlags?.workerRuntime) {
      throw new Error("Subscription-based hosted web search providers are not available in Worker mode.");
    }
    const { makeSubscriptionProviderCall } = await import("../subscription-provider.js");
    const subscriptionType = String(provider?.subscriptionType || provider?.subscription_type || "").trim().toLowerCase();
    const subscriptionResult = await makeSubscriptionProviderCall({
      provider,
      body,
      stream: subscriptionType === "chatgpt-codex"
    });
    if (!subscriptionResult?.ok || !(subscriptionResult.response instanceof Response)) {
      const message = await readSearchProviderError(subscriptionResult?.response);
      throw new Error(message || "Hosted web search subscription request failed.");
    }
    return subscriptionResult.response;
  }

  const targetFormat = FORMATS.OPENAI;
  const providerUrl = resolveProviderUrl(provider, targetFormat, "responses");
  if (!providerUrl) {
    throw new Error(`Provider '${provider.id}' does not expose an OpenAI Responses endpoint.`);
  }

  const response = await runFetchWithTimeout(providerUrl, {
    method: "POST",
    headers: buildProviderHeaders(provider, env, targetFormat),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(await readSearchProviderError(response.clone()));
  }
  return response;
}

async function runHostedSearchProviderQuery(providerEntry, query, runtimeConfig = {}, env = {}, runtimeFlags) {
  const resolvedRoute = getResolvedHostedSearchRoute(runtimeConfig, providerEntry);
  if (!resolvedRoute?.provider || !resolvedRoute?.model) {
    throw new Error(`Hosted web search route '${providerEntry?.id || providerEntry?.providerId || "unknown"}' is not configured.`);
  }
  if (!supportsResolvedHostedSearchRoute(resolvedRoute.provider, resolvedRoute.model)) {
    throw new Error(`Hosted web search route '${providerEntry.id}' is not OpenAI-compatible.`);
  }

  const requestBody = {
    model: resolvedRoute.model.id,
    input: String(query || "").trim() || HOSTED_WEB_SEARCH_TEST_QUERY,
    tools: [{ type: "web_search" }],
    tool_choice: "auto"
  };
  const response = await executeHostedSearchProviderRequest(resolvedRoute, requestBody, env, runtimeFlags);
  const payload = await collectAmpWebSearchProbePayload(response, {
    targetFormat: FORMATS.OPENAI,
    requestKind: "responses"
  });
  if (!payload) {
    throw new Error(`Hosted web search route '${providerEntry.id}' returned an unreadable response payload.`);
  }

  const text = readHostedSearchResponseText(payload);
  if (!text) {
    throw new Error(`Hosted web search route '${providerEntry.id}' did not return assistant text.`);
  }

  return {
    routeId: providerEntry.id,
    providerId: resolvedRoute.provider.id,
    providerName: resolvedRoute.provider.name || resolvedRoute.provider.id,
    modelId: resolvedRoute.model.id,
    label: buildHostedSearchProviderLabel(providerEntry, resolvedRoute),
    payload,
    usedWebSearch: payloadHasHostedWebSearchEvidence(payload),
    text
  };
}

export async function testHostedWebSearchProviderRoute({
  runtimeConfig = {},
  routeId = "",
  env = {},
  query = HOSTED_WEB_SEARCH_TEST_QUERY
} = {}) {
  const resolvedRouteId = String(routeId || "").trim();
  if (!resolvedRouteId) {
    throw new Error("Hosted web search route id is required.");
  }
  return runHostedSearchProviderQuery({
    id: resolvedRouteId,
    providerId: resolvedRouteId.slice(0, resolvedRouteId.indexOf("/")),
    model: resolvedRouteId.slice(resolvedRouteId.indexOf("/") + 1)
  }, query, runtimeConfig, env);
}

async function fetchStructuredSearchResults(query, count, provider) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery || !provider) return [];

  const id = provider.id;

  if (id === "brave") {
    if (!provider.apiKey) return [];
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(normalizedQuery)}&count=${count}&text_decorations=false`;
    const response = await runFetchWithTimeout(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": provider.apiKey }
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return (Array.isArray(payload?.web?.results) ? payload.web.results.slice(0, count) : [])
      .map((item) => ({ title: String(item?.title || ""), url: String(item?.url || ""), snippet: String(item?.description || "") }));
  }

  if (id === "tavily") {
    if (!provider.apiKey) return [];
    const response = await runFetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: provider.apiKey, query: normalizedQuery, max_results: count, search_depth: "basic" })
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return (Array.isArray(payload?.results) ? payload.results.slice(0, count) : [])
      .map((item) => ({ title: String(item?.title || ""), url: String(item?.url || ""), snippet: String(item?.content || "") }));
  }

  if (id === "exa") {
    if (!provider.apiKey) return [];
    const response = await runFetchWithTimeout("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": provider.apiKey },
      body: JSON.stringify({ query: normalizedQuery, numResults: count, type: "auto", contents: { text: { maxCharacters: 500 } } })
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return (Array.isArray(payload?.results) ? payload.results.slice(0, count) : [])
      .map((item) => ({ title: String(item?.title || ""), url: String(item?.url || ""), snippet: String(item?.text || item?.snippet || "") }));
  }

  if (id === "searxng") {
    if (!provider.url) return [];
    const url = `${provider.url}/search?q=${encodeURIComponent(normalizedQuery)}&format=json&categories=general&language=auto`;
    const response = await runFetchWithTimeout(url, {
      headers: { Accept: "application/json", "User-Agent": "llm-router" }
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return (Array.isArray(payload?.results) ? payload.results.slice(0, count) : [])
      .map((item) => ({ title: String(item?.title || ""), url: String(item?.url || ""), snippet: String(item?.content || "") }));
  }

  return [];
}

export async function executeWebSearchQueries({ queries, maxResults, config, env }) {
  const normalizedQueries = (Array.isArray(queries) ? queries : []).map((q) => String(q || "").trim()).filter(Boolean).slice(0, 10);
  if (normalizedQueries.length === 0) return { results: [], provider: "" };

  const count = Math.max(1, Math.min(20, Number(maxResults) || 5));
  const snapshot = await buildAmpWebSearchSnapshot(config, { env });
  const readyProviders = snapshot.providers.filter((p) => p.ready && !isHostedSearchProvider(p));

  for (const providerStatus of readyProviders) {
    try {
      const allResults = [];
      const batchResults = await Promise.all(
        normalizedQueries.map((query) => fetchStructuredSearchResults(query, count, providerStatus))
      );
      for (const results of batchResults) allResults.push(...results);
      if (allResults.length > 0) {
        return { results: allResults, provider: providerStatus.id };
      }
    } catch {
      continue;
    }
  }

  return { results: [], provider: "" };
}

export async function maybeInterceptAmpInternalSearch(request, url, config, env) {
  const searchParams = url.searchParams;
  if (!searchParams.has("webSearch2")) return null;

  const webSearchConfig = config?.webSearch || config?.amp?.webSearch;
  if (!webSearchConfig?.interceptInternalSearch) return null;

  const providers = Array.isArray(webSearchConfig?.providers) ? webSearchConfig.providers : [];
  if (providers.length === 0) return null;

  let body;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }

  const params = body?.params;
  if (!params || !Array.isArray(params.searchQueries) || params.searchQueries.length === 0) return null;

  try {
    const results = await executeWebSearchQueries({
      queries: params.searchQueries,
      maxResults: Number(params.maxResults) || 5,
      config,
      env
    });

    return jsonResponse({
      result: {
        results: results.results.map((r) => ({
          title: r.title || "",
          url: r.url || "",
          snippet: r.snippet || "",
          content: r.snippet || ""
        }))
      }
    });
  } catch (error) {
    console.warn(`[llm-router] webSearch2 interception failed: ${error?.message || error}`);
    return null;
  }
}

export async function maybeInterceptAmpWebSearch({
  response,
  providerBody,
  targetFormat,
  requestKind,
  stream,
  runtimeConfig,
  env,
  stateStore,
  executeProviderRequest
} = {}) {
  if (!(response instanceof Response)) {
    return {
      intercepted: false,
      response
    };
  }

  const probePayload = await collectAmpWebSearchProbePayload(response, {
    targetFormat,
    requestKind
  });
  if (!probePayload) {
    return {
      intercepted: false,
      response
    };
  }

  const probe = extractAmpWebSearchProbe(probePayload, {
    targetFormat,
    requestKind
  });
  if (!probe.hasWebSearchCalls) {
    return {
      intercepted: false,
      response
    };
  }

  const searchResultsByCall = [];
  for (const toolCall of (probe.toolCalls || [])) {
    searchResultsByCall.push(await executeAmpInterceptedToolCall(
      toolCall,
      runtimeConfig,
      env,
      {
        stateStore
      }
    ));
  }

  const followUpBody = stripAmpWebSearchFollowUpTools(buildAmpWebSearchFollowUp(
    providerBody,
    probePayload,
    probe,
    searchResultsByCall,
    {
      targetFormat,
      requestKind,
      stream
    }
  ));

  const followUpResponse = await executeProviderRequest(followUpBody);
  if (!(followUpResponse instanceof Response) || !followUpResponse.ok) {
    return {
      intercepted: false,
      response
    };
  }

  return {
    intercepted: true,
    response: followUpResponse,
    probePayload,
    probe,
    searchResultsByCall
  };
}
