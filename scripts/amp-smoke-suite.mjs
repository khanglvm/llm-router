#!/usr/bin/env node

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { promises as fs, appendFileSync } from "node:fs";
import {
  DEFAULT_AMP_ENTITY_DEFINITIONS,
  DEFAULT_AMP_SIGNATURE_DEFINITIONS,
  DEFAULT_AMP_SUBAGENT_DEFINITIONS,
  normalizeRuntimeConfig,
  resolveRequestModel
} from "../src/runtime/config.js";
import { getDefaultConfigPath, readConfigFile } from "../src/node/config-store.js";
import { createFetchHandler } from "../src/runtime/handler.js";
import { FORMATS } from "../src/translator/formats.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8791;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_UPSTREAM_URL = "https://ampcode.com";
const DEFAULT_TARGET_MODEL = "rc/gpt-5.3-codex";
const DEFAULT_PROMPT = "Reply with exactly OK.";
const DEFAULT_ORACLE_PROMPT = "Use Oracle for reasoning if needed, then reply with exactly OK.";
const DEFAULT_MODES = ["smart", "rush", "deep"];

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
    const eq = body.indexOf("=");
    let key = body;
    let value = true;
    if (eq >= 0) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        index += 1;
      }
    }
    args[key] = value;
  }
  return { args, positional };
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function maskSecret(secret) {
  const text = String(secret || "").trim();
  if (!text) return "(not set)";
  if (text.length <= 8) return `${text.slice(0, 2)}…${text.slice(-2)}`;
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function defaultAmpSecretsPath({ env = process.env, homeDir = os.homedir() } = {}) {
  const dataHome = String(env.XDG_DATA_HOME || "").trim() || path.join(homeDir, ".local", "share");
  return path.join(dataHome, "amp", "secrets.json");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = raw.trim() ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return parsed;
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function detectSourceFormatFromAmpUrl(url) {
  const normalized = String(url || "");
  if (normalized.includes("/api/provider/anthropic/")) return FORMATS.CLAUDE;
  return FORMATS.OPENAI;
}

function detectProviderHintFromAmpUrl(url) {
  const normalized = String(url || "");
  if (normalized.includes("/api/provider/anthropic/")) return "anthropic";
  if (normalized.includes("/api/provider/google/")) return "google";
  return "openai";
}

function buildAmpResolverProbeConfig() {
  const routeTarget = "openrouter/gpt-4o-mini";
  const routes = Object.fromEntries([
    ...DEFAULT_AMP_ENTITY_DEFINITIONS.map((entry) => [entry.id, routeTarget]),
    ...DEFAULT_AMP_SIGNATURE_DEFINITIONS.map((entry) => [entry.id, routeTarget])
  ]);

  return normalizeRuntimeConfig({
    version: 2,
    providers: [
      {
        id: "openrouter",
        type: "openai",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "amp_probe_key",
        models: [
          { id: "gpt-4o-mini" }
        ]
      }
    ],
    amp: {
      preset: "builtin",
      routes,
      fallback: {
        onUnknown: "none",
        onAmbiguous: "none",
        proxyUpstream: false
      }
    }
  });
}

const AMP_RESOLVER_PROBE_CONFIG = buildAmpResolverProbeConfig();

function verifyObservedAmpModels(entries) {
  const checks = [];
  const seen = new Set();

  for (const entry of entries) {
    const model = String(entry?.summary?.model || "").trim();
    if (!model) continue;

    const providerHint = detectProviderHintFromAmpUrl(entry.url);
    const sourceFormat = detectSourceFormatFromAmpUrl(entry.url);
    const key = `${providerHint}::${sourceFormat}::${model}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const resolved = resolveRequestModel(
      AMP_RESOLVER_PROBE_CONFIG,
      model,
      sourceFormat,
      { clientType: "amp", providerHint }
    );

    checks.push({
      model,
      providerHint,
      sourceFormat,
      matched: Boolean(resolved?.primary),
      routeType: resolved?.routeType || null,
      entities: resolved?.routeMetadata?.amp?.entities || [],
      signatures: resolved?.routeMetadata?.amp?.signatures || [],
      error: resolved?.error || null
    });
  }

  return checks;
}

async function findAmpUpstreamApiKey(upstreamUrl, { env = process.env, homeDir = os.homedir() } = {}) {
  const secretsPath = defaultAmpSecretsPath({ env, homeDir });
  const secrets = await readJsonObject(secretsPath);
  const normalizedUrl = normalizeBaseUrl(upstreamUrl);
  return String(
    secrets[`apiKey@${normalizedUrl}`] ||
    secrets[`apiKey@${normalizedUrl}/`] ||
    ""
  ).trim();
}

async function appendJsonl(filePath, entry) {
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

function buildRequestUrl(req, { host, port }) {
  const hostHeader = req.headers.host || `${host}:${port}`;
  const rawUrl = req.url || "/";
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) return rawUrl;
  return `http://${hostHeader}${rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`}`;
}

function summarizeJsonBody(bodyText) {
  if (typeof bodyText !== "string" || !bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    return {
      model: parsed?.model,
      stream: parsed?.stream,
      messages: Array.isArray(parsed?.messages) ? parsed.messages.length : undefined,
      input: Array.isArray(parsed?.input) ? parsed.input.length : undefined
    };
  } catch {
    return { rawLength: bodyText.length };
  }
}

function nodeRequestToFetchRequest(req, { host, port, bodyText = undefined } = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  if (req.socket?.remoteAddress) {
    headers.set("x-real-ip", req.socket.remoteAddress);
  }
  const url = buildRequestUrl(req, { host, port });
  const method = req.method || "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  if (typeof bodyText === "string") {
    return new Request(url, {
      method,
      headers,
      body: bodyText,
      duplex: "half"
    });
  }
  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(req),
    duplex: "half"
  });
}

async function writeFetchResponseToNode(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  const readable = Readable.fromWeb(response.body);
  readable.on("error", (error) => res.destroy(error));
  readable.pipe(res);
}

async function startLoggingRouterServer({ configPath, logFile, host, port }) {
  const config = await readConfigFile(configPath);
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (url, init = {}) => {
    let summary = null;
    if (typeof init.body === "string" && init.body) {
      try {
        const parsed = JSON.parse(init.body);
        summary = {
          model: parsed?.model,
          stream: parsed?.stream,
          messages: Array.isArray(parsed?.messages) ? parsed.messages.length : undefined,
          input: Array.isArray(parsed?.input) ? parsed.input.length : undefined
        };
      } catch {
        summary = { rawLength: init.body.length };
      }
    }
    await appendJsonl(logFile, {
      type: "upstream-request",
      ts: new Date().toISOString(),
      url: String(url),
      method: init.method || "GET",
      summary
    });
    const response = await originalFetch(url, init);
    await appendJsonl(logFile, {
      type: "upstream-response",
      ts: new Date().toISOString(),
      url: String(url),
      status: response.status,
      contentType: response.headers.get("content-type") || ""
    });
    return response;
  };

  const fetchHandler = createFetchHandler({
    getConfig: async () => config,
    ignoreAuth: false,
    defaultStateStoreBackend: "file"
  });

  const server = http.createServer(async (req, res) => {
    const method = req.method || "GET";
    let bodyText = "";
    if (method !== "GET" && method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      bodyText = Buffer.concat(chunks).toString("utf8");
    }

    await appendJsonl(logFile, {
      type: "inbound-request",
      ts: new Date().toISOString(),
      method,
      url: req.url || "/",
      contentType: req.headers["content-type"] || "",
      authHeader: req.headers.authorization
        ? "authorization"
        : (req.headers["x-api-key"] ? "x-api-key" : (req.headers["x-goog-api-key"] ? "x-goog-api-key" : "none")),
      summary: summarizeJsonBody(bodyText)
    });

    try {
      const request = nodeRequestToFetchRequest(req, { host, port, bodyText });
      const response = await fetchHandler(request, {}, undefined);
      await writeFetchResponseToNode(res, response);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    async close() {
      globalThis.fetch = originalFetch;
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function buildSmokeConfig(baseConfig, { targetModel, upstreamUrl, upstreamApiKey }) {
  const next = structuredClone(baseConfig);
  next.defaultModel = targetModel;
  next.amp = {
    upstreamUrl,
    upstreamApiKey,
    restrictManagementToLocalhost: true,
    forceModelMappings: true,
    modelMappings: [
      { from: "*", to: targetModel }
    ],
    subagentMappings: Object.fromEntries(
      DEFAULT_AMP_SUBAGENT_DEFINITIONS.map((entry) => [entry.id, targetModel])
    )
  };
  return next;
}

function buildAmpSettings(localUrl) {
  return {
    "amp.url": localUrl,
    "amp.dangerouslyAllowAll": true,
    "amp.showCosts": false,
    "amp.updates.mode": "disabled"
  };
}

function runChild(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: Number.isInteger(code) ? code : 1,
        signal: signal || "",
        stdout,
        stderr,
        timedOut
      });
    });
  });
}

async function readJsonl(filePath) {
  if (!(await fileExists(filePath))) return [];
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const configPath = path.resolve(String(args.config || getDefaultConfigPath()));
  const outputDir = args["output-dir"]
    ? path.resolve(String(args["output-dir"]))
    : await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-amp-smoke-"));
  const host = String(args.host || DEFAULT_HOST);
  const port = toInteger(args.port, DEFAULT_PORT);
  const timeoutMs = toInteger(args.timeout, DEFAULT_TIMEOUT_MS);
  const targetModel = String(args["target-model"] || DEFAULT_TARGET_MODEL).trim();
  const targetModelId = targetModel.split("/").slice(1).join("/") || targetModel;
  const upstreamUrl = normalizeBaseUrl(args["amp-upstream-url"] || DEFAULT_UPSTREAM_URL);
  const upstreamApiKey = String(args["amp-upstream-api-key"] || "").trim() || await findAmpUpstreamApiKey(upstreamUrl);
  const ampBin = String(args["amp-bin"] || "amp").trim();
  const modes = splitCsv(args.modes).length > 0 ? splitCsv(args.modes) : DEFAULT_MODES;
  const includeOracle = toBoolean(args.oracle, true);
  const prompt = String(args.prompt || DEFAULT_PROMPT);
  const oraclePrompt = String(args["oracle-prompt"] || DEFAULT_ORACLE_PROMPT);

  if (!upstreamApiKey) {
    throw new Error(`AMP upstream API key not found for ${upstreamUrl}. Open https://ampcode.com/settings or pass --amp-upstream-api-key.`);
  }

  const baseConfig = await readConfigFile(configPath);
  if (!String(baseConfig.masterKey || "").trim()) {
    throw new Error(`masterKey is required in ${configPath} for local AMP smoke testing.`);
  }

  await fs.mkdir(outputDir, { recursive: true });
  const smokeConfig = buildSmokeConfig(baseConfig, { targetModel, upstreamUrl, upstreamApiKey });
  const smokeConfigPath = path.join(outputDir, "config.json");
  const ampSettingsPath = path.join(outputDir, "settings.json");
  const routerLogPath = path.join(outputDir, "router-log.jsonl");
  await fs.writeFile(smokeConfigPath, `${JSON.stringify(smokeConfig, null, 2)}\n`, "utf8");
  await fs.writeFile(ampSettingsPath, `${JSON.stringify(buildAmpSettings(`http://${host}:${port}`), null, 2)}\n`, "utf8");
  await fs.writeFile(routerLogPath, "", "utf8");

  const router = await startLoggingRouterServer({
    configPath: smokeConfigPath,
    logFile: routerLogPath,
    host,
    port
  });

  const cases = modes.map((mode) => ({ label: mode, mode, prompt }));
  if (includeOracle) {
    cases.push({ label: "oracle", mode: "smart", prompt: oraclePrompt });
  }

  const results = [];
  let logCursor = 0;

  try {
    for (const testCase of cases) {
      if (testCase.mode === "free") {
        results.push({
          label: testCase.label,
          mode: testCase.mode,
          exitCode: 0,
          timedOut: false,
          managementRequests: 0,
          providerRequests: 0,
          inboundProviderRequests: 0,
          leakedAmpProviderRequests: 0,
          routedModels: [],
          observedInboundModels: [],
          resolverChecks: [],
          resolverCheckOk: true,
          stdoutPath: "",
          ampLogPath: "",
          ok: true,
          skipped: true,
          stderr: "AMP CLI execute mode (-x) is not supported with --mode free; verify free mode interactively."
        });
        continue;
      }

      const ampLogPath = path.join(outputDir, `amp-${testCase.label}.log`);
      const stdoutPath = path.join(outputDir, `amp-${testCase.label}.stdout.txt`);
      const child = await runChild(ampBin, [
        "--no-color",
        "--no-ide",
        "--no-jetbrains",
        "-x",
        testCase.prompt,
        "-m",
        testCase.mode
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          AMP_URL: `http://${host}:${port}`,
          AMP_API_KEY: smokeConfig.masterKey,
          AMP_SETTINGS_FILE: ampSettingsPath,
          AMP_LOG_FILE: ampLogPath
        },
        timeoutMs
      });
      await fs.writeFile(stdoutPath, child.stdout, "utf8");

      const entries = await readJsonl(routerLogPath);
      const delta = entries.slice(logCursor);
      logCursor = entries.length;
      const managementRequests = delta.filter((entry) => entry.type === "upstream-request" && String(entry.url).startsWith(`${upstreamUrl}/api/internal`));
      const leakedAmpProviderRequests = delta.filter((entry) => entry.type === "upstream-request" && String(entry.url).startsWith(`${upstreamUrl}/api/provider/`));
      const providerRequests = delta.filter((entry) => {
        if (entry.type !== "upstream-request") return false;
        if (String(entry.url).startsWith(`${upstreamUrl}/api/internal`)) return false;
        return Boolean(entry.summary?.model);
      });
      const inboundProviderRequests = delta.filter((entry) => {
        if (entry.type !== "inbound-request") return false;
        if (!String(entry.url).startsWith("/api/provider/")) return false;
        return Boolean(entry.summary?.model);
      });
      const uniqueModels = dedupeStrings(providerRequests.map((entry) => entry.summary?.model));
      const observedInboundModels = dedupeStrings(inboundProviderRequests.map((entry) => entry.summary?.model));
      const resolverChecks = verifyObservedAmpModels(inboundProviderRequests);
      const resolverCheckOk = resolverChecks.length > 0 && resolverChecks.every((entry) => entry.matched);
      const ok = child.code === 0
        && !child.timedOut
        && managementRequests.length > 0
        && providerRequests.length > 0
        && inboundProviderRequests.length > 0
        && leakedAmpProviderRequests.length === 0
        && uniqueModels.every((model) => model === targetModelId)
        && resolverCheckOk;

      results.push({
        label: testCase.label,
        mode: testCase.mode,
        exitCode: child.code,
        timedOut: child.timedOut,
        managementRequests: managementRequests.length,
        providerRequests: providerRequests.length,
        inboundProviderRequests: inboundProviderRequests.length,
        leakedAmpProviderRequests: leakedAmpProviderRequests.length,
        routedModels: uniqueModels,
        observedInboundModels,
        resolverChecks,
        resolverCheckOk,
        stdoutPath,
        ampLogPath,
        ok,
        stderr: child.stderr.trim()
      });
    }
  } finally {
    await router.close();
  }

  const observedModels = dedupeStrings(results.flatMap((result) => result.observedInboundModels || []));
  const observedModelsPath = path.join(outputDir, "observed-models.json");
  await fs.writeFile(observedModelsPath, `${JSON.stringify({
    observedModels,
    cases: results.map((result) => ({
      label: result.label,
      mode: result.mode,
      observedInboundModels: result.observedInboundModels,
      resolverChecks: result.resolverChecks
    }))
  }, null, 2)}\n`, "utf8");

  const summaryPath = path.join(outputDir, "summary.json");
  await fs.writeFile(summaryPath, `${JSON.stringify({
    configPath: smokeConfigPath,
    ampSettingsPath,
    routerLogPath,
    observedModelsPath,
    targetModel,
    upstreamUrl,
    upstreamApiKeyMasked: maskSecret(upstreamApiKey),
    observedModels,
    results
  }, null, 2)}\n`, "utf8");

  console.log(`AMP smoke output: ${outputDir}`);
  console.log(`Smoke config: ${smokeConfigPath}`);
  console.log(`AMP settings: ${ampSettingsPath}`);
  console.log(`Router log: ${routerLogPath}`);
  console.log(`Observed models: ${observedModelsPath}`);
  console.log(`Summary: ${summaryPath}`);
  for (const result of results) {
    console.log(`- ${result.label}: exit=${result.exitCode} timeout=${result.timedOut} mgmt=${result.managementRequests} provider=${result.providerRequests} inbound=${result.inboundProviderRequests} leakedAmpProvider=${result.leakedAmpProviderRequests} models=${result.routedModels.join(",") || "(none)"} observed=${result.observedInboundModels.join(",") || "(none)"} resolver=${result.resolverCheckOk} ok=${result.ok}`);
    if (result.skipped) {
      console.log("  skipped: true");
    }
    if (result.stderr) {
      console.log(`  stderr: ${result.stderr}`);
    }
  }

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
    return;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
