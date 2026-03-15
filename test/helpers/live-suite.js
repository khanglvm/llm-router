import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../../src/cli-entry.js", import.meta.url));
const DEFAULT_ENV_FILE = ".env.test-suite";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TOKENS = 48;
const DEFAULT_REQUEST_TEXT = "Reply with exactly: OK";

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

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readEnvFile(filePath) {
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

function parseProvidersFromEnvMap(envMap = {}) {
  const keys = splitCsv(envMap.LLM_ROUTER_TEST_PROVIDER_KEYS);
  if (keys.length === 0) return [];

  return keys.map((keyRaw) => {
    const key = keyRaw.trim().toUpperCase();
    const prefix = `LLM_ROUTER_TEST_${key}_`;
    return {
      key,
      id: envMap[`${prefix}PROVIDER_ID`] || envMap[`${prefix}ID`] || key.toLowerCase(),
      name: envMap[`${prefix}NAME`] || key.toLowerCase(),
      apiKey: envMap[`${prefix}API_KEY`] || "",
      openaiBaseUrl: String(envMap[`${prefix}OPENAI_BASE_URL`] || "").trim().replace(/\/+$/, ""),
      claudeBaseUrl: String(envMap[`${prefix}CLAUDE_BASE_URL`] || "").trim().replace(/\/+$/, ""),
      models: splitCsv(envMap[`${prefix}MODELS`]),
      headers: parseJsonObject(envMap[`${prefix}HEADERS_JSON`] || "", `${prefix}HEADERS_JSON`),
      openaiHeaders: parseJsonObject(envMap[`${prefix}OPENAI_HEADERS_JSON`] || "", `${prefix}OPENAI_HEADERS_JSON`),
      claudeHeaders: parseJsonObject(envMap[`${prefix}CLAUDE_HEADERS_JSON`] || "", `${prefix}CLAUDE_HEADERS_JSON`)
    };
  }).filter((provider) => provider.apiKey && (provider.openaiBaseUrl || provider.claudeBaseUrl) && provider.models.length > 0);
}

export async function loadLiveSuiteSettings({ cwd = process.cwd(), env = process.env } = {}) {
  const envFile = path.resolve(cwd, String(env.LLM_ROUTER_TEST_ENV_FILE || DEFAULT_ENV_FILE));
  const envFromFile = await fileExists(envFile) ? await readEnvFile(envFile) : {};
  const mergedEnv = {
    ...envFromFile,
    ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined))
  };
  const providers = parseProvidersFromEnvMap(mergedEnv);
  const enabled = providers.length > 0;
  const reason = enabled
    ? ""
    : `No real providers configured. Create ${envFile} from .env.test-suite.example or set LLM_ROUTER_TEST_PROVIDER_KEYS and provider env vars.`;

  return {
    enabled,
    reason,
    envFile,
    envMap: mergedEnv,
    providers,
    host: String(mergedEnv.LLM_ROUTER_TEST_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST,
    port: toInteger(mergedEnv.LLM_ROUTER_TEST_PORT, DEFAULT_PORT),
    timeoutMs: toInteger(mergedEnv.LLM_ROUTER_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxTokens: toInteger(mergedEnv.LLM_ROUTER_TEST_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    requestText: String(mergedEnv.LLM_ROUTER_TEST_REQUEST_TEXT || DEFAULT_REQUEST_TEXT)
  };
}

export async function createIsolatedWorkspace(prefix = "llm-router-live-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(dir, "home");
  const cwd = path.join(dir, "cwd");
  const configPath = path.join(dir, "config.json");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });

  return {
    dir,
    homeDir,
    cwd,
    configPath,
    buildEnv(overrides = {}) {
      return {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        XDG_CONFIG_HOME: path.join(homeDir, ".config"),
        XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
        ...overrides
      };
    },
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

export async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
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

export function summarizeBody(body) {
  if (!body || typeof body !== "object") return "";
  if (Array.isArray(body?.choices) && body.choices[0]?.message?.content) {
    return String(body.choices[0].message.content).slice(0, 160);
  }
  if (Array.isArray(body?.content)) {
    const textBlock = body.content.find((item) => item?.type === "text" && typeof item.text === "string");
    if (textBlock?.text) return textBlock.text.slice(0, 160);
  }
  if (body?.error?.message) return String(body.error.message).slice(0, 160);
  if (body?.message) return String(body.message).slice(0, 160);
  return JSON.stringify(body).slice(0, 160);
}

export function resolveModelRequestFormat(provider, modelId) {
  const model = (provider?.models || []).find((entry) => String(entry?.id || "").trim() === String(modelId || "").trim());
  const formats = Array.isArray(model?.formats) && model.formats.length > 0
    ? model.formats
    : Array.isArray(provider?.formats) && provider.formats.length > 0
      ? provider.formats
      : [provider?.format || "openai"];
  const normalizedModelId = String(modelId || "").trim().toLowerCase();
  if (!Array.isArray(model?.formats) || model.formats.length === 0) {
    if (normalizedModelId.includes("claude")) return "claude";
  }
  return formats.includes("claude") && !formats.includes("openai") ? "claude" : "openai";
}

export async function waitForHealth(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
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
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return false;
}

function redactSecrets(text, secrets = []) {
  let output = String(text || "");
  for (const secret of secrets) {
    const value = String(secret || "").trim();
    if (!value) continue;
    output = output.split(value).join("[REDACTED]");
  }
  return output;
}

export function runNodeCli(args, {
  cwd = process.cwd(),
  env = process.env,
  label = "cli",
  redactions = []
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[${label}] ${redactSecrets(text, redactions)}`);
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[${label}] ${redactSecrets(text, redactions)}`);
    });

    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        ok: code === 0,
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

export function runCommandCapture(command, args = [], {
  cwd = process.cwd(),
  env = process.env,
  label = command,
  redactions = [],
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({
        ok: false,
        code: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        spawnError: error
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      resolve({
        ok: false,
        code: child.exitCode ?? 1,
        stdout,
        stderr,
        timedOut: true,
        spawnError: null
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[${label}] ${redactSecrets(text, redactions)}`);
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[${label}] ${redactSecrets(text, redactions)}`);
    });

    child.once("error", (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({
        ok: false,
        code: 1,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
        spawnError: error
      });
    });

    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({
        ok: code === 0,
        code: code ?? 1,
        stdout,
        stderr,
        timedOut: false,
        spawnError: null
      });
    });
  });
}

export function startCliServer({ configPath, port, env, cwd = process.cwd() }) {
  const child = spawn(process.execPath, [
    CLI_ENTRY,
    "start",
    `--config=${configPath}`,
    `--port=${port}`,
    "--watch-config=false",
    "--watch-binary=false"
  ], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[start] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[start] ${chunk.toString()}`);
  });

  return child;
}

export async function stopChildProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGINT");
  });
}

export async function callOpenAI(baseUrl, model, {
  requestText = DEFAULT_REQUEST_TEXT,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {}
} = {}) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
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
    body,
    summary: summarizeBody(body)
  };
}

export async function callClaude(baseUrl, model, {
  requestText = DEFAULT_REQUEST_TEXT,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {}
} = {}) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/anthropic/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers
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
    body,
    summary: summarizeBody(body)
  };
}
