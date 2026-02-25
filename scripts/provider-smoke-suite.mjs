#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { getDefaultConfigPath } from "../src/node/config-store.js";

const CLI_ENTRY = path.resolve("src/cli-entry.js");
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_REQUEST_TEXT = "Reply with exactly: OK";
const DEFAULT_MAX_TOKENS = 16;

function parseArgs(argv) {
  const args = {};
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const idx = body.indexOf("=");
    let key = body;
    let value = true;
    if (idx >= 0) {
      key = body.slice(0, idx);
      value = body.slice(idx + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
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

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
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
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = stripOuterQuotes(trimmed.slice(idx + 1).trim());
    env[key] = value;
  }
  return env;
}

function parseProvidersFromJson(args) {
  const jsonValues = asArray(args["providers-json"]);
  const providers = [];

  for (const raw of jsonValues) {
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
  const keys = splitCsv(providerKeysRaw || envMap.LLM_ROUTER_TEST_PROVIDER_KEYS);
  if (keys.length === 0) return [];

  return keys.map((keyRaw) => {
    const key = keyRaw.trim().toUpperCase();
    const prefix = `LLM_ROUTER_TEST_${key}_`;
    const id = envMap[`${prefix}PROVIDER_ID`] || envMap[`${prefix}ID`] || key.toLowerCase();
    const name = envMap[`${prefix}NAME`] || id;
    const apiKey = envMap[`${prefix}API_KEY`] || "";
    const openaiBaseUrl = envMap[`${prefix}OPENAI_BASE_URL`] || "";
    const claudeBaseUrl = envMap[`${prefix}CLAUDE_BASE_URL`] || "";
    const models = splitCsv(envMap[`${prefix}MODELS`]);
    const openaiHeaders = parseJsonObject(envMap[`${prefix}OPENAI_HEADERS_JSON`] || "", `${prefix}OPENAI_HEADERS_JSON`);
    const claudeHeaders = parseJsonObject(envMap[`${prefix}CLAUDE_HEADERS_JSON`] || "", `${prefix}CLAUDE_HEADERS_JSON`);
    const headers = parseJsonObject(envMap[`${prefix}HEADERS_JSON`] || "", `${prefix}HEADERS_JSON`);

    return {
      id,
      name,
      apiKey,
      openaiBaseUrl,
      claudeBaseUrl,
      models,
      openaiHeaders,
      claudeHeaders,
      headers
    };
  });
}

function normalizeProviderSpec(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = slugifyProviderId(raw.id || raw.providerId || raw.name);
  const name = String(raw.name || id);
  const apiKey = String(raw.apiKey || "").trim();
  const openaiBaseUrl = String(raw.openaiBaseUrl || raw.openaiEndpoint || "").trim().replace(/\/+$/, "");
  const claudeBaseUrl = String(raw.claudeBaseUrl || raw.anthropicBaseUrl || raw.anthropicEndpoint || "").trim().replace(/\/+$/, "");
  const models = Array.isArray(raw.models) ? raw.models : splitCsv(raw.models);
  const modelIds = models.map((model) => String(model).trim()).filter(Boolean);
  const headers = parseJsonObject(raw.headers || "", `providers[${id}].headers`);
  const openaiHeaders = parseJsonObject(raw.openaiHeaders || "", `providers[${id}].openaiHeaders`);
  const claudeHeaders = parseJsonObject(raw.claudeHeaders || "", `providers[${id}].claudeHeaders`);

  if (!id) throw new Error("Provider id is required.");
  if (!apiKey) throw new Error(`Provider '${id}' is missing apiKey.`);
  if (!openaiBaseUrl && !claudeBaseUrl) {
    throw new Error(`Provider '${id}' requires openaiBaseUrl or claudeBaseUrl.`);
  }
  if (modelIds.length === 0) {
    throw new Error(`Provider '${id}' requires at least one model.`);
  }

  return {
    id,
    name,
    apiKey,
    openaiBaseUrl,
    claudeBaseUrl,
    models: [...new Set(modelIds)],
    headers,
    openaiHeaders,
    claudeHeaders
  };
}

function buildConfigTargets(providers) {
  const targets = [];
  for (const provider of providers) {
    const baseId = slugifyProviderId(provider.id);
    if (provider.openaiBaseUrl) {
      targets.push({
        logicalProviderId: provider.id,
        providerId: `${baseId}-openai`,
        name: `${provider.name} OpenAI`,
        format: "openai",
        baseUrl: provider.openaiBaseUrl,
        apiKey: provider.apiKey,
        models: provider.models,
        headers: { ...(provider.headers || {}), ...(provider.openaiHeaders || {}) }
      });
    }
    if (provider.claudeBaseUrl) {
      targets.push({
        logicalProviderId: provider.id,
        providerId: `${baseId}-claude`,
        name: `${provider.name} Claude`,
        format: "claude",
        baseUrl: provider.claudeBaseUrl,
        apiKey: provider.apiKey,
        models: provider.models,
        headers: { ...(provider.headers || {}), ...(provider.claudeHeaders || {}) }
      });
    }
  }
  return targets;
}

function maskSecret(secret) {
  if (!secret) return "";
  const value = String(secret);
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return false;
}

async function startServer({ host, port }) {
  const child = spawn(process.execPath, [CLI_ENTRY, "start", `--host=${host}`, `--port=${port}`, "--watch-config=false"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[start] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[start] ${chunk.toString()}`);
  });

  child.on("error", (error) => {
    process.stderr.write(`[start] failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });

  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 4_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGINT");
  });
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
  if (body?.error?.message) return String(body.error.message).slice(0, 160);
  if (body?.message) return String(body.message).slice(0, 160);
  return JSON.stringify(body).slice(0, 160);
}

async function callOpenAI(baseUrl, model, requestText, maxTokens, timeoutMs) {
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
    summary: summarizeBody(body)
  };
}

async function callClaude(baseUrl, model, requestText, maxTokens, timeoutMs) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/anthropic/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
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
    summary: summarizeBody(body)
  };
}

async function backupConfig(configPath) {
  const existed = await fileExists(configPath);
  if (!existed) return { existed: false, backupPath: null };

  const backupPath = path.join(
    os.tmpdir(),
    `.llm-router.json.backup.${Date.now()}.${process.pid}`
  );
  await fs.copyFile(configPath, backupPath);
  return { existed: true, backupPath };
}

async function restoreConfig(configPath, backup) {
  if (backup.existed && backup.backupPath) {
    await fs.rm(configPath, { force: true });
    await fs.copyFile(backup.backupPath, configPath);
    await fs.rm(backup.backupPath, { force: true });
    return "restored";
  }
  await fs.rm(configPath, { force: true });
  return "removed";
}

function printUsage() {
  console.log([
    "Provider smoke suite",
    "",
    "Usage:",
    "  node scripts/provider-smoke-suite.mjs --providers-json='[...]'",
    "  node scripts/provider-smoke-suite.mjs --providers-file=./providers.json",
    "  node scripts/provider-smoke-suite.mjs --env-file=.env.test-suite --provider-keys=RAMCLOUDS,ZAI",
    "",
    "Provider JSON shape:",
    "  [{",
    '    "id": "ramclouds",',
    '    "name": "RamClouds",',
    '    "apiKey": "sk-...",',
    '    "openaiBaseUrl": "https://example.com/v1",',
    '    "claudeBaseUrl": "https://example.com",',
    '    "models": ["model-a", "model-b"]',
    "  }]",
    "",
    "Options:",
    "  --host=127.0.0.1",
    "  --port=8787",
    "  --timeout-ms=90000",
    "  --max-tokens=16",
    "  --request-text='Reply with exactly: OK'",
    "  --skip-probe=true|false   (default: true)",
    "  --provider-keys=KEY1,KEY2 (used with --env-file)"
  ].join("\n"));
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    return 0;
  }

  const providers = [];
  providers.push(...parseProvidersFromJson(args));
  providers.push(...await parseProvidersFromJsonFile(args));
  let envMap = null;

  if (args["env-file"]) {
    envMap = await readEnvFile(path.resolve(String(args["env-file"])));
    providers.push(...parseProvidersFromEnvMap(envMap, args["provider-keys"]));
  }

  const host = String(args.host || envMap?.LLM_ROUTER_TEST_HOST || DEFAULT_HOST);
  const port = toInteger(args.port ?? envMap?.LLM_ROUTER_TEST_PORT, DEFAULT_PORT);
  const timeoutMs = toInteger(args["timeout-ms"] ?? envMap?.LLM_ROUTER_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxTokens = toInteger(args["max-tokens"] ?? envMap?.LLM_ROUTER_TEST_MAX_TOKENS, DEFAULT_MAX_TOKENS);
  const requestText = String(args["request-text"] || envMap?.LLM_ROUTER_TEST_REQUEST_TEXT || DEFAULT_REQUEST_TEXT);
  const skipProbe = toBoolean(args["skip-probe"] ?? envMap?.LLM_ROUTER_TEST_SKIP_PROBE, true);

  const normalizedProviders = providers
    .map(normalizeProviderSpec)
    .filter(Boolean);

  if (normalizedProviders.length === 0) {
    throw new Error("No providers were supplied. Pass --providers-json, --providers-file, or --env-file + --provider-keys.");
  }

  const targets = buildConfigTargets(normalizedProviders);
  if (targets.length === 0) {
    throw new Error("No config targets generated from provider specs.");
  }

  const configPath = getDefaultConfigPath();
  const backup = await backupConfig(configPath);
  const baseUrl = `http://${host}:${port}`;
  let server = null;
  const results = [];

  console.log(`Using config path: ${configPath}`);
  console.log(`Providers in suite: ${normalizedProviders.map((item) => item.id).join(", ")}`);
  console.log(`Config targets: ${targets.map((item) => `${item.providerId}:${item.format}`).join(", ")}`);

  try {
    await fs.rm(configPath, { force: true });

    for (const target of targets) {
      const configArgs = [
        "config",
        "--operation=upsert-provider",
        `--provider-id=${target.providerId}`,
        `--name=${target.name}`,
        `--base-url=${target.baseUrl}`,
        `--api-key=${target.apiKey}`,
        `--models=${target.models.join(",")}`,
        `--format=${target.format}`,
        `--skip-probe=${skipProbe ? "true" : "false"}`
      ];
      if (target.headers && Object.keys(target.headers).length > 0) {
        configArgs.push(`--headers=${JSON.stringify(target.headers)}`);
      }

      console.log(`\n[config] provider=${target.providerId} format=${target.format} baseUrl=${target.baseUrl} apiKey=${maskSecret(target.apiKey)}`);
      const configResult = await runNodeCli(configArgs, { label: `config:${target.providerId}` });
      if (!configResult.ok) {
        throw new Error(`Config failed for ${target.providerId} with exit code ${configResult.code}.`);
      }
    }

    server = await startServer({ host, port });
    const healthy = await waitForHealth(baseUrl, timeoutMs);
    if (!healthy) {
      throw new Error(`Local server did not become healthy on ${baseUrl} within ${timeoutMs} ms.`);
    }

    for (const target of targets) {
      for (const modelId of target.models) {
        const qualifiedModel = `${target.providerId}/${modelId}`;
        const requestType = target.format === "claude" ? "claude" : "openai";
        try {
          const response = requestType === "claude"
            ? await callClaude(baseUrl, qualifiedModel, requestText, maxTokens, timeoutMs)
            : await callOpenAI(baseUrl, qualifiedModel, requestText, maxTokens, timeoutMs);

          results.push({
            ok: response.ok,
            logicalProviderId: target.logicalProviderId,
            providerId: target.providerId,
            requestType,
            modelId,
            status: response.status,
            elapsedMs: response.elapsedMs,
            summary: response.summary
          });
        } catch (error) {
          results.push({
            ok: false,
            logicalProviderId: target.logicalProviderId,
            providerId: target.providerId,
            requestType,
            modelId,
            status: 0,
            elapsedMs: 0,
            summary: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  } finally {
    await stopServer(server);
    const restoreState = await restoreConfig(configPath, backup);
    console.log(`\n[cleanup] ${restoreState === "restored" ? "Original ~/.llm-router.json restored." : "Test ~/.llm-router.json removed (no original file existed)."}`);
  }

  console.log("\n=== Provider Smoke Suite Report ===");
  for (const item of results) {
    const status = item.ok ? "PASS" : "FAIL";
    console.log(
      `${status} provider=${item.providerId} logical=${item.logicalProviderId} request=${item.requestType} model=${item.modelId} status=${item.status} elapsed=${item.elapsedMs}ms`
    );
    if (item.summary) {
      console.log(`  response: ${item.summary}`);
    }
  }

  const failed = results.filter((item) => !item.ok);
  const passed = results.length - failed.length;
  console.log(`\nSummary: ${passed}/${results.length} passed, ${failed.length} failed.`);

  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
