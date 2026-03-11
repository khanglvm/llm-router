#!/usr/bin/env node

import net from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import routerModule from "../src/cli/router-module.js";
import { writeConfigFile, readConfigFile } from "../src/node/config-store.js";
import { startLocalRouteServer } from "../src/node/local-server.js";
import { applyLocalServerSettings } from "../src/node/local-server-settings.js";
import { startWebConsoleServer } from "../src/node/web-console-server.js";
import { applyConfigChanges, buildProviderFromConfigInput } from "../src/node/config-workflows.js";
import { normalizeRuntimeConfig } from "../src/runtime/config.js";

const CLI_ENTRY = path.resolve("src/cli-entry.js");
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TOKENS = 16;
const DEFAULT_REQUEST_TEXT = "Reply with exactly: OK";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_WEB_HOST = "127.0.0.1";
const DEFAULT_SURFACES = ["cli", "tui", "web"];
const DEFAULT_PROBE_RPM = 30;

function parseArgs(argv) {
  const args = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const separator = body.indexOf("=");
    let key = body;
    let value = true;
    if (separator >= 0) {
      key = body.slice(0, separator);
      value = body.slice(separator + 1);
    } else {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        index += 1;
      }
    }

    if (args[key] === undefined) {
      args[key] = value;
      continue;
    }
    args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
  }

  return { args, positional };
}

function stripOuterQuotes(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupeStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJsonObject(value, fieldName) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`${fieldName} must be a JSON object. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function slugifyProviderId(value, fallback = "provider") {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function maskSecret(secret) {
  if (!secret) return "(not set)";
  const text = String(secret).trim();
  if (text.length <= 8) return `${text.slice(0, 2)}...${text.slice(-2)}`;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function mergeHeaderMaps(maps, fieldName) {
  const output = {};
  const seen = new Map();

  for (const source of maps) {
    for (const [key, value] of Object.entries(source || {})) {
      const normalizedKey = String(key);
      const nextValue = String(value);
      if (seen.has(normalizedKey) && seen.get(normalizedKey) !== nextValue) {
        throw new Error(`${fieldName} has conflicting values for header '${normalizedKey}'. Split this provider into separate targets or make the values match.`);
      }
      seen.set(normalizedKey, nextValue);
      output[normalizedKey] = nextValue;
    }
  }

  return output;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readEnvFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = stripOuterQuotes(trimmed.slice(separator + 1).trim());
    env[key] = value;
  }
  return env;
}

async function resolveEnvMap(args) {
  const explicit = args["env-file"] ? path.resolve(String(args["env-file"])) : "";
  const candidates = dedupeStrings([
    explicit,
    path.resolve(".env.test-suite.local"),
    path.resolve(".env.test-suite")
  ]);

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (await fileExists(candidate)) {
      return {
        filePath: candidate,
        values: await readEnvFile(candidate)
      };
    }
  }

  return { filePath: "", values: null };
}

function parseProvidersFromJson(args) {
  const providers = [];
  for (const raw of asArray(args["providers-json"])) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("--providers-json must be a JSON array.");
    }
    providers.push(...parsed);
  }
  return providers;
}

async function parseProvidersFromJsonFile(args) {
  const fileValue = args["providers-file"];
  if (!fileValue) return [];
  const filePath = path.resolve(String(fileValue));
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("--providers-file must contain a JSON array.");
  }
  return parsed;
}

function parseProvidersFromEnvMap(envMap, providerKeysRaw) {
  const keys = splitCsv(providerKeysRaw || envMap?.LLM_ROUTER_TEST_PROVIDER_KEYS);
  if (keys.length === 0) return [];

  return keys.map((keyRaw) => {
    const key = keyRaw.trim().toUpperCase();
    const prefix = `LLM_ROUTER_TEST_${key}_`;
    return {
      id: envMap[`${prefix}PROVIDER_ID`] || envMap[`${prefix}ID`] || key.toLowerCase(),
      name: envMap[`${prefix}NAME`] || key,
      apiKey: envMap[`${prefix}API_KEY`] || "",
      baseUrl: envMap[`${prefix}BASE_URL`] || "",
      openaiBaseUrl: envMap[`${prefix}OPENAI_BASE_URL`] || "",
      claudeBaseUrl: envMap[`${prefix}CLAUDE_BASE_URL`] || envMap[`${prefix}ANTHROPIC_BASE_URL`] || "",
      endpoints: splitCsv(envMap[`${prefix}ENDPOINTS`]),
      models: splitCsv(envMap[`${prefix}MODELS`]),
      headers: parseJsonObject(envMap[`${prefix}HEADERS_JSON`] || "", `${prefix}HEADERS_JSON`),
      openaiHeaders: parseJsonObject(envMap[`${prefix}OPENAI_HEADERS_JSON`] || "", `${prefix}OPENAI_HEADERS_JSON`),
      claudeHeaders: parseJsonObject(envMap[`${prefix}CLAUDE_HEADERS_JSON`] || "", `${prefix}CLAUDE_HEADERS_JSON`)
    };
  });
}

function normalizeProviderSpec(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = slugifyProviderId(raw.id || raw.providerId || raw.name);
  const name = String(raw.name || id).trim() || id;
  const apiKey = String(raw.apiKey || "").trim();
  const baseUrl = String(raw.baseUrl || "").trim().replace(/\/+$/, "");
  const openaiBaseUrl = String(raw.openaiBaseUrl || raw.openaiEndpoint || "").trim().replace(/\/+$/, "");
  const claudeBaseUrl = String(raw.claudeBaseUrl || raw.anthropicBaseUrl || raw.anthropicEndpoint || "").trim().replace(/\/+$/, "");
  const endpoints = dedupeStrings([
    ...asArray(raw.endpoints || []),
    baseUrl,
    openaiBaseUrl,
    claudeBaseUrl
  ]).map((value) => value.replace(/\/+$/, ""));
  const models = dedupeStrings(Array.isArray(raw.models) ? raw.models : splitCsv(raw.models));
  const headers = parseJsonObject(raw.headers || "", `providers[${id}].headers`);
  const openaiHeaders = parseJsonObject(raw.openaiHeaders || "", `providers[${id}].openaiHeaders`);
  const claudeHeaders = parseJsonObject(raw.claudeHeaders || "", `providers[${id}].claudeHeaders`);
  const mergedHeaders = mergeHeaderMaps([headers, openaiHeaders, claudeHeaders], `providers[${id}] headers`);

  if (!apiKey) throw new Error(`Provider '${id}' is missing apiKey.`);
  if (endpoints.length === 0) {
    throw new Error(`Provider '${id}' requires at least one endpoint.`);
  }
  if (models.length === 0) {
    throw new Error(`Provider '${id}' requires at least one model.`);
  }

  return {
    id,
    name,
    apiKey,
    baseUrl,
    openaiBaseUrl,
    claudeBaseUrl,
    endpoints,
    models,
    headers: mergedHeaders
  };
}

function summarizeBody(body) {
  if (!body || typeof body !== "object") return "";
  if (Array.isArray(body?.choices) && body.choices[0]?.message?.content) {
    return String(body.choices[0].message.content).slice(0, 120);
  }
  if (Array.isArray(body?.content)) {
    const textBlock = body.content.find((item) => item?.type === "text" && typeof item.text === "string");
    if (textBlock?.text) return textBlock.text.slice(0, 120);
  }
  if (body?.output_text) return String(body.output_text).slice(0, 120);
  if (body?.error?.message) return String(body.error.message).slice(0, 160);
  if (body?.message) return String(body.message).slice(0, 160);
  return JSON.stringify(body).slice(0, 160);
}

async function getAvailablePort(host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? Number(address.port) : 0;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function runNodeCli(args, { cwd = process.cwd(), label = "cli" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[${label}] ${text}`);
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[${label}] ${text}`);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        ok: code === 0,
        stdout,
        stderr
      });
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  const healthUrl = `${baseUrl}/health`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(3_000)
      });
      if (response.ok) return true;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

async function callLocalOpenAI(baseUrl, model, requestText, maxTokens, timeoutMs) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: requestText }],
      max_tokens: maxTokens,
      temperature: 0,
      stream: false
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return {
    ok: response.ok,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    summary: summarizeBody(body),
    body
  };
}

async function callLocalClaude(baseUrl, model, requestText, maxTokens, timeoutMs) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/anthropic/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: requestText }]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return {
    ok: response.ok,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    summary: summarizeBody(body),
    body
  };
}

function buildRouteCases(config) {
  const cases = [];

  for (const provider of config?.providers || []) {
    const providerFormats = dedupeStrings([
      ...(provider?.formats || []),
      provider?.format || ""
    ]);
    const models = Array.isArray(provider?.models) ? provider.models : [];

    const pickModel = (requestType) => {
      const preferredByFormat = models.find((model) => Array.isArray(model?.formats) && model.formats.includes(requestType));
      if (preferredByFormat) return preferredByFormat;

      if (requestType === "claude") {
        const claudeNamed = models.find((model) => /claude/i.test(String(model?.id || "")));
        if (claudeNamed) return claudeNamed;
      }

      if (requestType === "openai") {
        const nonClaude = models.find((model) => !/claude/i.test(String(model?.id || "")));
        if (nonClaude) return nonClaude;
      }

      return models[0] || null;
    };

    if (providerFormats.includes("openai")) {
      const model = pickModel("openai");
      if (model) {
        cases.push({
          providerId: provider.id,
          modelId: model.id,
          requestType: "openai",
          qualifiedModel: `${provider.id}/${model.id}`
        });
      }
    }

    if (providerFormats.includes("claude")) {
      const model = pickModel("claude");
      if (model) {
        cases.push({
          providerId: provider.id,
          modelId: model.id,
          requestType: "claude",
          qualifiedModel: `${provider.id}/${model.id}`
        });
      }
    }
  }

  return cases;
}

function selectRouteCases(config, { preferredTypes = ["openai"], maxCases = 1 } = {}) {
  const allCases = buildRouteCases(config);
  const selected = [];

  for (const requestType of preferredTypes) {
    const match = allCases.find((entry) => entry.requestType === requestType && !selected.includes(entry));
    if (!match) continue;
    selected.push(match);
    if (selected.length >= maxCases) return selected;
  }

  for (const entry of allCases) {
    if (selected.length >= maxCases) break;
    if (selected.includes(entry)) continue;
    selected.push(entry);
  }

  return selected;
}

async function runRouteCases(baseUrl, config, options, selectionOptions) {
  const routeCases = selectRouteCases(config, selectionOptions);
  if (routeCases.length === 0) {
    throw new Error("No routable provider/model cases were generated from the saved config.");
  }

  const results = [];
  for (const routeCase of routeCases) {
    const response = routeCase.requestType === "claude"
      ? await callLocalClaude(baseUrl, routeCase.qualifiedModel, options.requestText, options.maxTokens, options.timeoutMs)
      : await callLocalOpenAI(baseUrl, routeCase.qualifiedModel, options.requestText, options.maxTokens, options.timeoutMs);

    if (!response.ok) {
      throw new Error(`${routeCase.requestType.toUpperCase()} route failed for ${routeCase.qualifiedModel} with status ${response.status}: ${response.summary}`);
    }
    if (!String(response.summary || "").trim()) {
      throw new Error(`${routeCase.requestType.toUpperCase()} route for ${routeCase.qualifiedModel} returned an empty summary.`);
    }

    results.push({
      ...routeCase,
      status: response.status,
      elapsedMs: response.elapsedMs,
      summary: response.summary
    });
  }

  return results;
}

function createQueuedPrompts(entries) {
  const queue = [...entries];
  const take = (type) => {
    assert.ok(queue.length > 0, `No queued answer left for ${type}`);
    const next = queue.shift();
    if (next && typeof next === "object" && next.type === "cancel") {
      throw new Error("Prompt cancelled");
    }
    if (next && typeof next === "object" && "type" in next) {
      assert.equal(next.type, type);
      return next.value;
    }
    if (next === "__cancel__") {
      throw new Error("Prompt cancelled");
    }
    return next;
  };

  return {
    select: async () => take("select"),
    text: async () => take("text"),
    confirm: async () => take("confirm"),
    password: async () => take("password"),
    multiselect: async () => take("multiselect"),
    remaining: () => [...queue]
  };
}

async function withForcedTty(callback) {
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });

  try {
    return await callback();
  } finally {
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    } else {
      delete process.stdout.isTTY;
    }
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    } else {
      delete process.stdin.isTTY;
    }
  }
}

function getConfigAction() {
  const action = routerModule.actions.find((entry) => entry.actionId === "config");
  if (!action) throw new Error("Router config action is unavailable.");
  return action;
}

async function readJsonResponse(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { response, payload };
}

async function readJsonLineResponse(response) {
  const text = await response.text();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { response, lines };
}

function createInProcessRouterHarness(configPath) {
  let activeRuntime = null;
  let activeServer = null;
  let nextPid = 7000;

  const stopActiveServer = async () => {
    if (!activeServer) return;
    await closeServer(activeServer);
    activeServer = null;
  };

  return {
    deps: {
      startupStatus: async () => ({
        manager: "launchd",
        serviceId: "dev.llm-router.live-suite",
        installed: false,
        running: false,
        detail: "Startup service is not installed."
      }),
      getActiveRuntimeState: async () => activeRuntime,
      listListeningPids: () => ({ ok: true, pids: [] }),
      reclaimPort: async () => ({ ok: true, attempted: false }),
      startDetachedRouterService: async ({ host, port, watchConfig, watchBinary, requireAuth }) => {
        await stopActiveServer();
        activeServer = await startLocalRouteServer({
          host,
          port,
          configPath,
          watchConfig,
          requireAuth
        });
        activeRuntime = {
          pid: nextPid++,
          host,
          port,
          configPath,
          watchConfig,
          watchBinary,
          requireAuth,
          managedByStartup: false,
          cliPath: CLI_ENTRY,
          startedAt: new Date().toISOString(),
          version: "live-suite"
        };
        return {
          ok: true,
          pid: activeRuntime.pid,
          runtime: activeRuntime
        };
      },
      stopProcessByPid: async (pid) => {
        if (!activeRuntime || Number(activeRuntime.pid) !== Number(pid)) {
          return { ok: false, signal: "SIGTERM", errorMessage: `PID ${pid} is not managed by the live suite.` };
        }
        await stopActiveServer();
        activeRuntime = null;
        return { ok: true, signal: "SIGTERM" };
      },
      clearRuntimeState: async ({ pid } = {}) => {
        if (!pid || (activeRuntime && Number(activeRuntime.pid) === Number(pid))) {
          activeRuntime = null;
        }
      }
    },
    async cleanup() {
      await stopActiveServer();
      activeRuntime = null;
    }
  };
}

function buildEmptyConfig(localServerSettings) {
  const base = normalizeRuntimeConfig({});
  return applyLocalServerSettings(base, localServerSettings);
}

async function runCliSurface(provider, options) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-live-cli-"));
  const configPath = path.join(tempDir, "cli.config.json");
  const routerPort = await getAvailablePort(options.host);
  const baseUrl = `http://${options.host}:${routerPort}`;
  const headersArg = Object.keys(provider.headers).length > 0 ? JSON.stringify(provider.headers) : "";

  console.log(`\n[cli] provider=${provider.id} endpoints=${provider.endpoints.join(",")} apiKey=${maskSecret(provider.apiKey)}`);

  try {
    const configArgs = [
      "config",
      "--operation=upsert-provider",
      `--config=${configPath}`,
      `--provider-id=${provider.id}`,
      `--name=${provider.name}`,
      `--endpoints=${provider.endpoints.join(",")}`,
      `--api-key=${provider.apiKey}`,
      `--models=${provider.models.join(",")}`,
      "--skip-probe=false",
      `--probe-requests-per-minute=${options.probeRequestsPerMinute}`
    ];
    if (headersArg) {
      configArgs.push(`--headers=${headersArg}`);
    }

    const upsertResult = await runNodeCli(configArgs, { label: "cli:upsert" });
    if (!upsertResult.ok) {
      throw new Error(`CLI upsert-provider failed with exit code ${upsertResult.code}.`);
    }

    const listResult = await runNodeCli([
      "config",
      "--operation=list",
      `--config=${configPath}`
    ], { label: "cli:list" });
    if (!listResult.ok) {
      throw new Error(`CLI list failed with exit code ${listResult.code}.`);
    }
    if (!listResult.stdout.includes(provider.id)) {
      throw new Error(`CLI list output did not include provider '${provider.id}'.`);
    }

    const savedConfig = await readConfigFile(configPath);
    const server = await startLocalRouteServer({
      host: options.host,
      port: routerPort,
      configPath,
      watchConfig: false,
      requireAuth: false
    });

    try {
      const healthy = await waitForHealth(baseUrl, options.timeoutMs);
      if (!healthy) {
        throw new Error(`CLI surface router did not become healthy on ${baseUrl} within ${options.timeoutMs} ms.`);
      }

      const routeResults = await runRouteCases(baseUrl, savedConfig, options, {
        preferredTypes: ["openai", "claude"],
        maxCases: 2
      });

      return {
        surface: "cli",
        providerId: provider.id,
        configPath,
        routeResults
      };
    } finally {
      await closeServer(server);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runTuiSurface(provider, options) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-live-tui-"));
  const configPath = path.join(tempDir, "tui.config.json");
  const routerPort = await getAvailablePort(options.host);
  const baseUrl = `http://${options.host}:${routerPort}`;
  const configAction = getConfigAction();
  const prompts = createQueuedPrompts([
    { type: "select", value: "standard" },
    { type: "text", value: provider.name },
    { type: "text", value: provider.id },
    { type: "password", value: provider.apiKey },
    { type: "text", value: provider.endpoints.join(",") },
    { type: "text", value: provider.models.join(",") },
    { type: "text", value: JSON.stringify(provider.headers) },
    { type: "confirm", value: true },
    { type: "text", value: String(options.probeRequestsPerMinute) },
    { type: "confirm", value: false }
  ]);

  console.log(`\n[tui] provider=${provider.id} endpoints=${provider.endpoints.join(",")} apiKey=${maskSecret(provider.apiKey)}`);

  try {
    const result = await withForcedTty(async () => configAction.run({
      args: {
        operation: "upsert-provider",
        config: configPath
      },
      mode: "commandline",
      forcePrompt: true,
      prompts,
      terminal: {
        line(message) {
          if (message) process.stdout.write(`[tui] ${String(message)}\n`);
        },
        info(message) {
          if (message) process.stdout.write(`[tui] ${String(message)}\n`);
        },
        warn(message) {
          if (message) process.stdout.write(`[tui] ${String(message)}\n`);
        },
        error(message) {
          if (message) process.stderr.write(`[tui] ${String(message)}\n`);
        }
      }
    }));

    if (!result?.ok) {
      throw new Error(result?.errorMessage || "TUI upsert-provider failed.");
    }
    if (prompts.remaining().length > 0) {
      throw new Error(`TUI prompt queue was not fully consumed (${prompts.remaining().length} answers left).`);
    }

    const savedConfig = await readConfigFile(configPath);
    const server = await startLocalRouteServer({
      host: options.host,
      port: routerPort,
      configPath,
      watchConfig: false,
      requireAuth: false
    });

    try {
      const healthy = await waitForHealth(baseUrl, options.timeoutMs);
      if (!healthy) {
        throw new Error(`TUI surface router did not become healthy on ${baseUrl} within ${options.timeoutMs} ms.`);
      }

      const routeResults = await runRouteCases(baseUrl, savedConfig, options, {
        preferredTypes: ["claude", "openai"],
        maxCases: 1
      });

      return {
        surface: "tui",
        providerId: provider.id,
        configPath,
        routeResults
      };
    } finally {
      await closeServer(server);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJsonResponse(response);
}

async function postJsonLines(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJsonLineResponse(response);
}

async function runWebSurface(providers, options) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-live-web-"));
  const configPath = path.join(tempDir, "web.config.json");
  const webPort = await getAvailablePort(DEFAULT_WEB_HOST);
  const routerPort = await getAvailablePort(DEFAULT_HOST);
  const webBaseUrl = `http://${DEFAULT_WEB_HOST}:${webPort}`;
  const routerBaseUrl = `http://${DEFAULT_HOST}:${routerPort}`;
  const localServerSettings = {
    host: DEFAULT_HOST,
    port: routerPort,
    watchConfig: false,
    watchBinary: false,
    requireAuth: false
  };

  await writeConfigFile(buildEmptyConfig(localServerSettings), configPath);
  const harness = createInProcessRouterHarness(configPath);
  const webServer = await startWebConsoleServer({
    host: DEFAULT_WEB_HOST,
    port: webPort,
    configPath,
    open: false
  }, harness.deps);

  console.log(`\n[web] providers=${providers.map((provider) => provider.id).join(",")} web=${webBaseUrl} router=${routerBaseUrl}`);

  try {
    const htmlResponse = await fetch(webBaseUrl, { signal: AbortSignal.timeout(5_000) });
    const html = await htmlResponse.text();
    if (!htmlResponse.ok || !html.includes("<div id=\"app\"></div>")) {
      throw new Error("Web console root HTML did not load the app shell.");
    }

    const appResponse = await fetch(`${webBaseUrl}/app.js`, { signal: AbortSignal.timeout(5_000) });
    const appJs = await appResponse.text();
    if (!appResponse.ok || !/LLM Router Web Console|Provider models/.test(appJs)) {
      throw new Error("Web console app bundle did not load correctly.");
    }

    const stylesResponse = await fetch(`${webBaseUrl}/styles.css`, { signal: AbortSignal.timeout(5_000) });
    const stylesCss = await stylesResponse.text();
    if (!stylesResponse.ok || !String(stylesCss || "").trim()) {
      throw new Error("Web console styles did not load correctly.");
    }

    const initialState = await readJsonResponse(await fetch(`${webBaseUrl}/api/state`, {
      signal: AbortSignal.timeout(5_000)
    }));
    if (!initialState.response.ok) {
      throw new Error(`Web console state endpoint failed with status ${initialState.response.status}.`);
    }

    const probeResults = [];
    const discoveryResults = [];

    for (const provider of providers) {
      const discovered = await postJson(`${webBaseUrl}/api/config/discover-provider-models`, {
        endpoints: provider.endpoints,
        apiKey: provider.apiKey,
        headers: provider.headers
      });
      if (!discovered.response.ok) {
        throw new Error(`Web provider discovery failed for ${provider.id} with status ${discovered.response.status}.`);
      }
      discoveryResults.push({
        providerId: provider.id,
        payload: discovered.payload
      });

      const streamed = await postJsonLines(`${webBaseUrl}/api/config/test-provider-stream`, {
        endpoints: provider.endpoints,
        models: provider.models,
        apiKey: provider.apiKey,
        headers: provider.headers
      });
      if (!streamed.response.ok) {
        throw new Error(`Web provider test stream failed for ${provider.id} with status ${streamed.response.status}.`);
      }

      const resultLine = streamed.lines.find((entry) => entry.type === "result");
      if (!resultLine?.result?.ok) {
        throw new Error(`Web provider test did not confirm a working config for ${provider.id}.`);
      }
      probeResults.push({
        provider,
        result: resultLine.result,
        progressEvents: streamed.lines.filter((entry) => entry.type === "progress")
      });
    }

    let nextConfig = buildEmptyConfig(localServerSettings);
    for (const { provider, result } of probeResults) {
      const providerConfig = buildProviderFromConfigInput({
        providerId: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl || result.baseUrl || provider.openaiBaseUrl || provider.claudeBaseUrl || provider.endpoints[0],
        openaiBaseUrl: result.baseUrlByFormat?.openai || provider.openaiBaseUrl,
        claudeBaseUrl: result.baseUrlByFormat?.claude || provider.claudeBaseUrl,
        apiKey: provider.apiKey,
        models: provider.models,
        headers: provider.headers,
        format: result.preferredFormat || "openai",
        probe: result
      });
      nextConfig = applyConfigChanges(nextConfig, {
        provider: providerConfig,
        setDefaultModel: true
      });
    }
    nextConfig = applyLocalServerSettings(nextConfig, localServerSettings);

    const saved = await postJson(`${webBaseUrl}/api/config/save`, {
      rawText: `${JSON.stringify(nextConfig, null, 2)}\n`
    });
    if (!saved.response.ok) {
      throw new Error(`Web config save failed with status ${saved.response.status}.`);
    }

    const restarted = await postJson(`${webBaseUrl}/api/router/restart`, {});
    if (!restarted.response.ok) {
      throw new Error(`Web router restart failed with status ${restarted.response.status}.`);
    }

    const healthy = await waitForHealth(routerBaseUrl, options.timeoutMs);
    if (!healthy) {
      throw new Error(`Web-managed router did not become healthy on ${routerBaseUrl} within ${options.timeoutMs} ms.`);
    }

    const savedConfig = await readConfigFile(configPath);
    const routeResults = await runRouteCases(routerBaseUrl, savedConfig, options, {
      preferredTypes: ["openai", "claude"],
      maxCases: 2
    });

    return {
      surface: "web",
      providerIds: providers.map((provider) => provider.id),
      configPath,
      discoveryResults,
      probeResults: probeResults.map((entry) => ({
        providerId: entry.provider.id,
        workingFormats: entry.result.workingFormats || [],
        confirmedModels: entry.result.models || [],
        progressEvents: entry.progressEvents.length
      })),
      routeResults
    };
  } finally {
    await webServer.close("live-suite-cleanup");
    await harness.cleanup();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function printUsage() {
  console.log([
    "Live provider suite",
    "",
    "Runs real provider coverage across:",
    "  - CLI non-interactive config flow",
    "  - prompt-driven TUI config flow",
    "  - Web console provider discovery / test / save / router control flow",
    "",
    "Usage:",
    "  node scripts/live-provider-suite.mjs",
    "  node scripts/live-provider-suite.mjs --env-file=.env.test-suite.local",
    "  node scripts/live-provider-suite.mjs --surfaces=cli,tui,web",
    "",
    "Provider sources:",
    "  --providers-json='[...]'",
    "  --providers-file=./providers.json",
    "  --env-file=.env.test-suite.local",
    "",
    "Environment file shape:",
    "  LLM_ROUTER_TEST_PROVIDER_KEYS=RAMCLOUDS,ZAI",
    "  LLM_ROUTER_TEST_RAMCLOUDS_PROVIDER_ID=ramclouds",
    "  LLM_ROUTER_TEST_RAMCLOUDS_NAME=RamClouds",
    "  LLM_ROUTER_TEST_RAMCLOUDS_API_KEY=sk-...",
    "  LLM_ROUTER_TEST_RAMCLOUDS_ENDPOINTS=https://ramclouds.me,https://ramclouds.me/v1",
    "  LLM_ROUTER_TEST_RAMCLOUDS_OPENAI_BASE_URL=https://ramclouds.me/v1",
    "  LLM_ROUTER_TEST_RAMCLOUDS_CLAUDE_BASE_URL=https://ramclouds.me",
    "  LLM_ROUTER_TEST_RAMCLOUDS_MODELS=gpt-5.1-codex-mini,claude-haiku-4-5",
    "",
    "Options:",
    "  --timeout-ms=90000",
    "  --max-tokens=16",
    "  --request-text='Reply with exactly: OK'",
    "  --probe-requests-per-minute=30",
    "  --surfaces=cli,tui,web"
  ].join("\n"));
}

export async function main(rawArgv = process.argv.slice(2)) {
  const { args } = parseArgs(rawArgv);
  if (args.help || args.h) {
    printUsage();
    return 0;
  }

  const envContext = await resolveEnvMap(args);
  const envMap = envContext.values;
  const providers = [
    ...parseProvidersFromJson(args),
    ...await parseProvidersFromJsonFile(args),
    ...parseProvidersFromEnvMap(envMap, args["provider-keys"])
  ]
    .map(normalizeProviderSpec)
    .filter(Boolean);

  if (providers.length === 0) {
    throw new Error("No providers were supplied. Create .env.test-suite.local, or pass --providers-json / --providers-file / --env-file.");
  }

  const surfaces = dedupeStrings(splitCsv(args.surfaces || DEFAULT_SURFACES.join(","))).map((value) => value.toLowerCase());
  const invalidSurfaces = surfaces.filter((value) => !DEFAULT_SURFACES.includes(value));
  if (invalidSurfaces.length > 0) {
    throw new Error(`Unsupported surface(s): ${invalidSurfaces.join(", ")}.`);
  }

  const options = {
    host: DEFAULT_HOST,
    timeoutMs: toInteger(args["timeout-ms"] ?? envMap?.LLM_ROUTER_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxTokens: toInteger(args["max-tokens"] ?? envMap?.LLM_ROUTER_TEST_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    requestText: String(args["request-text"] || envMap?.LLM_ROUTER_TEST_REQUEST_TEXT || DEFAULT_REQUEST_TEXT),
    probeRequestsPerMinute: toInteger(
      args["probe-requests-per-minute"] ?? envMap?.LLM_ROUTER_TEST_PROBE_REQUESTS_PER_MINUTE,
      DEFAULT_PROBE_RPM
    )
  };

  console.log("=== Live Provider Suite ===");
  if (envContext.filePath) {
    console.log(`Env file: ${path.relative(process.cwd(), envContext.filePath) || path.basename(envContext.filePath)}`);
  }
  console.log(`Providers: ${providers.map((provider) => provider.id).join(", ")}`);
  console.log(`Surfaces: ${surfaces.join(", ")}`);
  console.log(`Timeout: ${options.timeoutMs}ms`);

  const results = [];

  if (surfaces.includes("cli")) {
    results.push(await runCliSurface(providers[0], options));
  }

  if (surfaces.includes("tui")) {
    const provider = providers[Math.min(1, providers.length - 1)];
    results.push(await runTuiSurface(provider, options));
  }

  if (surfaces.includes("web")) {
    results.push(await runWebSurface(providers, options));
  }

  console.log("\n=== Live Provider Suite Report ===");
  for (const result of results) {
    console.log(`Surface: ${result.surface}`);
    if (result.providerId) {
      console.log(`  Provider: ${result.providerId}`);
    }
    if (result.providerIds) {
      console.log(`  Providers: ${result.providerIds.join(", ")}`);
    }
    for (const routeResult of result.routeResults || []) {
      console.log(`  PASS ${routeResult.requestType.toUpperCase()} ${routeResult.qualifiedModel} status=${routeResult.status} elapsed=${routeResult.elapsedMs}ms`);
      console.log(`    response: ${routeResult.summary}`);
    }
    for (const probeResult of result.probeResults || []) {
      console.log(`  Probe ${probeResult.providerId}: formats=${(probeResult.workingFormats || []).join(",") || "(none)"} models=${(probeResult.confirmedModels || []).join(",") || "(none)"} progress=${probeResult.progressEvents}`);
    }
  }

  console.log(`\nSummary: ${results.length}/${results.length} surfaces passed.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
