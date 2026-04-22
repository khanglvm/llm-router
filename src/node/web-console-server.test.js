import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { TextDecoder, TextEncoder } from "node:util";
import { JSDOM, VirtualConsole } from "jsdom";
import { detectAvailableEditors, startWebConsoleServer } from "./web-console-server.js";
import { appendActivityLogEntry, resolveActivityLogPath } from "./activity-log.js";
import { resolveCodingToolBackupFilePath } from "./coding-tool-config.js";
import { FIXED_LOCAL_ROUTER_HOST, FIXED_LOCAL_ROUTER_PORT } from "./local-server-settings.js";
import { DEFAULT_MODEL_ALIAS_ID } from "../runtime/config.js";
import { createFileStateStore } from "../runtime/state-store.file.js";
import { resolveWindowRange } from "../runtime/rate-limits.js";
import {
  CODEX_CLI_INHERIT_MODEL_VALUE
} from "../shared/coding-tool-bindings.js";

async function makeTempConfig(contents) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-web-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  return {
    dir,
    configPath,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function makeAmpClientEnv() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-amp-client-"));
  return {
    dir,
    env: {
      XDG_CONFIG_HOME: path.join(dir, ".config"),
      XDG_DATA_HOME: path.join(dir, ".local", "share")
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function makeCodingToolEnv() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-coding-tools-"));
  return {
    dir,
    codexEnv: {
      CODEX_HOME: path.join(dir, ".codex")
    },
    claudeEnv: {
      CLAUDE_CONFIG_DIR: path.join(dir, ".claude")
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function makeRuntimeEnv() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-runtime-"));
  return {
    dir,
    env: {
      LLM_ROUTER_STATE_FILE_PATH: path.join(dir, "state.json")
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function makeCodexCliEnv() {
  const tools = await makeCodingToolEnv();
  return {
    dir: tools.dir,
    env: tools.codexEnv,
    async cleanup() {
      await tools.cleanup();
    }
  };
}

async function makeClaudeCodeEnv() {
  const tools = await makeCodingToolEnv();
  return {
    dir: tools.dir,
    env: tools.claudeEnv,
    async cleanup() {
      await tools.cleanup();
    }
  };
}


async function readJsonFileOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readTextFileOrNull(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

function getAmpSettingsPath(env) {
  return path.join(env.XDG_CONFIG_HOME, "amp", "settings.json");
}

function getWorkspaceAmpSettingsPath(cwd) {
  return path.join(cwd, ".amp", "settings.json");
}

function getAmpSecretsPath(env) {
  return path.join(env.XDG_DATA_HOME, "amp", "secrets.json");
}

function getCodexConfigPath(env) {
  return path.join(env.CODEX_HOME, "config.toml");
}

function getCodexModelCatalogPath(env) {
  return path.join(env.CODEX_HOME, "llm-router-model-catalog.json");
}

function getClaudeSettingsPath(env) {
  return path.join(env.CLAUDE_CONFIG_DIR, "settings.json");
}

function getToolBackupPath(filePath) {
  return resolveCodingToolBackupFilePath(filePath);
}

test("resolveCodingToolBackupFilePath inserts the backup marker before the final extension", () => {
  assert.equal(
    resolveCodingToolBackupFilePath("/tmp/config.toml"),
    "/tmp/config.llm_router_backup.toml"
  );
  assert.equal(
    resolveCodingToolBackupFilePath("/tmp/settings.json"),
    "/tmp/settings.llm_router_backup.json"
  );
  assert.equal(
    resolveCodingToolBackupFilePath("/tmp/config"),
    "/tmp/config.llm_router_backup"
  );
});

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  return { response, payload };
}

async function fetchJsonLines(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const messages = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { response, messages };
}

function createSilentEventSource(window) {
  return class SilentEventSource extends window.EventTarget {
    close() {}
  };
}

async function loadWebConsoleDom(baseUrl, { fetchImpl = null } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();

  virtualConsole.on("jsdomError", (error) => {
    if (String(error?.message || "").includes("Could not parse CSS stylesheet")) return;
    errors.push(error?.stack || error?.message || String(error));
  });
  virtualConsole.on("error", (...args) => {
    errors.push(args.map((arg) => arg?.stack || arg?.message || String(arg)).join("\n"));
  });

  const dom = await JSDOM.fromURL(baseUrl, {
    resources: "usable",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (input, init) => {
        const resolvedFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
        if (typeof input === "string" || input instanceof URL) {
          return resolvedFetch(new URL(String(input), window.location.href), init, window);
        }
        if (input instanceof window.Request) {
          return resolvedFetch(new URL(input.url, window.location.href), init, window);
        }
        return resolvedFetch(input, init, window);
      };
      window.Headers = globalThis.Headers;
      window.Request = globalThis.Request;
      window.Response = globalThis.Response;
      window.AbortController = globalThis.AbortController;
      window.AbortSignal = globalThis.AbortSignal;
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      window.confirm = () => true;
      window.matchMedia = () => ({
        matches: false,
        media: "",
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false; }
      });
      window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
      window.cancelAnimationFrame = (handle) => clearTimeout(handle);
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      window.PointerEvent = window.MouseEvent;
      window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
      window.navigator.clipboard = {
        async writeText() {}
      };
      if (!window.crypto?.getRandomValues) {
        Object.defineProperty(window, "crypto", {
          configurable: true,
          value: globalThis.crypto
        });
      }
      window.EventSource = createSilentEventSource(window);
    }
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for document load.")), 15_000);
    dom.window.addEventListener("load", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });

  return { dom, errors };
}

async function waitForDomText(dom, text, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((dom.window.document.body?.textContent || "").includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for DOM text: ${text}`);
}

async function waitForDomCondition(check, timeoutMs = 15_000, failureMessage = "Timed out waiting for DOM condition.") {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(failureMessage);
}

async function waitForAsyncCondition(check, timeoutMs = 15_000, failureMessage = "Timed out waiting for async condition.") {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(failureMessage);
}

async function waitForDomTextToDisappear(dom, text, timeoutMs = 15_000) {
  await waitForDomCondition(
    () => !(dom.window.document.body?.textContent || "").includes(text),
    timeoutMs,
    `Timed out waiting for DOM text to disappear: ${text}`
  );
}

function findButtonByText(root, text) {
  return Array.from(root.querySelectorAll("button")).find((button) => (button.textContent || "").trim().includes(text)) || null;
}

function setInputValue(window, input, value) {
  const prototype = input instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (typeof valueSetter === "function") {
    valueSetter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

async function getAvailablePort() {
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

async function startTestWebConsoleServer(options = {}, deps = {}) {
  const resolvedOptions = { ...options };
  if (resolvedOptions.routerPort === undefined) {
    resolvedOptions.routerPort = FIXED_LOCAL_ROUTER_PORT;
  }
  const harness = createRouterHarness(resolvedOptions.configPath);
  const server = await startWebConsoleServer(resolvedOptions, {
    ...harness.deps,
    listListeningPids: () => ({ occupied: false, occupiedBySelf: false, listenerPids: [], reason: "", error: "" }),
    reclaimPort: async () => ({ ok: true, attempted: false }),
    ...deps
  });
  server.routerHarness = harness;
  return server;
}

function createRouterHarness(configPath, { initialRuntime = null } = {}) {
  let activeRuntime = initialRuntime;
  let nextPid = 5000;
  const startCalls = [];
  const stopCalls = [];

  return {
    startCalls,
    stopCalls,
    get activeRuntime() {
      return activeRuntime;
    },
    set activeRuntime(value) {
      activeRuntime = value;
    },
    deps: {
      getActiveRuntimeState: async () => activeRuntime,
      startupStatus: async () => ({
        manager: "launchd",
        serviceId: "dev.llm-router",
        installed: false,
        running: false,
        detail: "Startup service is not installed."
      }),
      startDetachedRouterService: async ({ host, port, watchConfig, watchBinary, requireAuth }) => {
        activeRuntime = {
          pid: nextPid++,
          host,
          port,
          configPath,
          watchConfig,
          watchBinary,
          requireAuth,
          managedByStartup: false,
          cliPath: process.argv[1] || "",
          startedAt: new Date().toISOString(),
          version: "test"
        };
        startCalls.push({ host, port, watchConfig, watchBinary, requireAuth });
        return { ok: true, pid: activeRuntime.pid, runtime: activeRuntime };
      },
      stopProcessByPid: async (pid) => {
        stopCalls.push(pid);
        if (activeRuntime && Number(activeRuntime.pid) === Number(pid)) {
          activeRuntime = null;
        }
        return { ok: true, signal: "SIGTERM" };
      },
      clearRuntimeState: async ({ pid } = {}) => {
        if (!pid || (activeRuntime && Number(activeRuntime.pid) === Number(pid))) {
          activeRuntime = null;
        }
      }
    }
  };
}


function waitForSseEvent(url, eventName, timeoutMs = 4000, predicate = null) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let buffer = "";
      const timeout = setTimeout(() => {
        request.destroy(new Error(`Timed out waiting for SSE event '${eventName}'.`));
      }, timeoutMs);

      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        buffer += chunk;
        while (buffer.includes("\n\n")) {
          const separatorIndex = buffer.indexOf("\n\n");
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);

          let currentEvent = "message";
          const dataLines = [];
          for (const line of rawEvent.split("\n")) {
            if (!line || line.startsWith(":")) continue;
            if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }

          if (currentEvent === eventName) {
            const data = dataLines.join("\n");
            const payload = data ? JSON.parse(data) : null;
            if (typeof predicate === "function" && !predicate(payload)) {
              continue;
            }
            clearTimeout(timeout);
            request.destroy();
            resolve(payload);
            return;
          }
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

function createBaseConfig() {
  return {
    providers: [
      {
        id: "demo",
        name: "Demo",
        baseUrl: "https://example.com",
        apiKey: "sk-test-1234",
        format: "openai",
        models: [{ id: "gpt-4o-mini" }]
      }
    ]
  };
}

function createLegacyV1Config() {
  return {
    version: 1,
    defaultModel: "demo/gpt-4o-mini",
    ...createBaseConfig()
  };
}

test("web console state exposes config metadata and raw text", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  });

  try {
    const { response, payload } = await fetchJson(`${server.url}/api/state`);
    assert.equal(response.status, 200);
    assert.equal(payload.config.path, fixture.configPath);
    assert.equal(payload.config.providerCount, 1);
    assert.match(payload.config.rawText, /"demo"/);
    assert.equal(payload.config.localServer.port, FIXED_LOCAL_ROUTER_PORT);
    assert.equal(payload.activityLog.enabled, true);
    assert.match(payload.startup.label, /startup|launchagent|systemd/i);
    assert.equal(Array.isArray(payload.logs), true);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console state exposes live AMP web search quota state", async () => {
  const runtime = await makeRuntimeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    amp: {
      webSearch: {
        strategy: "ordered",
        count: 5,
        providers: [
          {
            id: "brave",
            apiKey: "brave_test_key",
            limit: 10,
            remaining: 5
          }
        ]
      }
    }
  });
  const stateStore = await createFileStateStore({
    filePath: runtime.env.LLM_ROUTER_STATE_FILE_PATH
  });
  const monthWindowKey = `${resolveWindowRange({ unit: "month", size: 1 }).key}:sync=5`;
  await stateStore.incrementBucketUsage("amp-web-search:brave", monthWindowKey, 2, {
    expiresAt: Date.now() + 60_000
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    runtimeEnv: runtime.env
  });

  try {
    const { response, payload } = await fetchJson(`${server.url}/api/state`);
    assert.equal(response.status, 200);
    assert.equal(payload.webSearch?.interceptEnabled, true);
    assert.equal(payload.webSearch?.providers?.[0]?.id, "brave");
    assert.equal(payload.webSearch?.providers?.[0]?.currentRemaining, 3);
    assert.equal(payload.webSearch?.providers?.[0]?.usedSinceSync, 2);
    assert.equal(payload.ampWebSearch?.providers?.[0]?.id, "brave");
  } finally {
    await stateStore.close();
    await server.close("test-cleanup");
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

test("web console clearing a web-search credential stops showing Saved immediately", async () => {
  const fixture = await makeTempConfig({
    version: 2,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    amp: {
      defaultRoute: DEFAULT_MODEL_ALIAS_ID
    },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: [{ ref: "openai/gpt-4o" }]
      }
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        format: "openai",
        endpoints: ["https://api.openai.com/v1"],
        apiKeyEnv: "OPENAI_API_KEY",
        models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
        rateLimits: [
          {
            id: "default",
            models: ["gpt-4o-mini"],
            requests: 60,
            window: { unit: "minute", size: 1 }
          }
        ]
      }
    ],
    webSearch: {
      strategy: "ordered",
      count: 5,
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key",
          limit: 1000,
          remaining: 1000
        }
      ]
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  try {
    const { dom } = await loadWebConsoleDom(server.url);
    await waitForDomText(dom, "OpenAI");

    const webSearchTab = Array.from(dom.window.document.querySelectorAll('[role="tab"]'))
      .find((button) => (button.textContent || "").trim().includes("Web Search"));
    assert.ok(webSearchTab);
    webSearchTab.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    webSearchTab.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    webSearchTab.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, button: 0 }));
    webSearchTab.click();

    await waitForDomCondition(
      () => Boolean(dom.window.document.querySelector('input[placeholder="brv_..."]')),
      15_000,
      "Timed out waiting for the Brave API key input."
    );

    const braveInput = dom.window.document.querySelector('input[placeholder="brv_..."]');
    assert.ok(braveInput);

    setInputValue(dom.window, braveInput, "brave_next_key");
    await waitForDomText(dom, "Last saved");

    setInputValue(dom.window, braveInput, "");

    await waitForDomCondition(() => {
      const text = dom.window.document.body.textContent || "";
      return !text.includes("Last saved")
        && (
          text.includes("Unsaved changes queued. Auto-save will run shortly.")
          || text.includes("saving...")
        );
    }, 4_000, "Timed out waiting for the web-search autosave status to leave Saved.");

    dom.window.close();
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console web-search shows saving state while autosave is in flight", async () => {
  const fixture = await makeTempConfig({
    version: 2,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    amp: {
      defaultRoute: DEFAULT_MODEL_ALIAS_ID
    },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: [{ ref: "openai/gpt-4o" }]
      }
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        format: "openai",
        endpoints: ["https://api.openai.com/v1"],
        apiKeyEnv: "OPENAI_API_KEY",
        models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
        rateLimits: [
          {
            id: "default",
            models: ["gpt-4o-mini"],
            requests: 60,
            window: { unit: "minute", size: 1 }
          }
        ]
      }
    ],
    webSearch: {
      strategy: "ordered",
      count: 5,
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key",
          limit: 1000,
          remaining: 1000
        }
      ]
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  let applyCallCount = 0;
  let delayedSaveStarted = false;
  let releaseDelayedSave = () => {};
  const delayedSaveGate = new Promise((resolve) => {
    releaseDelayedSave = resolve;
  });

  try {
    const { dom } = await loadWebConsoleDom(server.url, {
      fetchImpl: async (input, init) => {
        const url = String(input || "");
        if (url.endsWith("/api/amp/apply")) {
          applyCallCount += 1;
          if (applyCallCount >= 2) {
            delayedSaveStarted = true;
            await delayedSaveGate;
          }
        }
        return globalThis.fetch(input, init);
      }
    });
    await waitForDomText(dom, "OpenAI");

    const webSearchTab = Array.from(dom.window.document.querySelectorAll('[role="tab"]'))
      .find((button) => (button.textContent || "").trim().includes("Web Search"));
    assert.ok(webSearchTab);
    webSearchTab.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    webSearchTab.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    webSearchTab.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, button: 0 }));
    webSearchTab.click();

    await waitForDomCondition(
      () => Boolean(dom.window.document.querySelector('input[placeholder="brv_..."]')),
      15_000,
      "Timed out waiting for the Brave API key input."
    );

    const braveInput = dom.window.document.querySelector('input[placeholder="brv_..."]');
    assert.ok(braveInput);

    setInputValue(dom.window, braveInput, "brave_next_key");
    await waitForDomText(dom, "Last saved");

    setInputValue(dom.window, braveInput, "brave_final_key");
    await waitForAsyncCondition(
      async () => delayedSaveStarted,
      5_000,
      "Timed out waiting for the delayed autosave request."
    );

    await waitForDomCondition(() => {
      const text = dom.window.document.body.textContent || "";
      return text.includes("Saving changes...") && !text.includes("Last saved");
    }, 5_000, "Timed out waiting for the web-search autosave UI to show saving state.");

    releaseDelayedSave();
    await waitForDomText(dom, "Last saved");

    dom.window.close();
  } finally {
    releaseDelayedSave();
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console web-search credential edits persist across reloads", async () => {
  const fixture = await makeTempConfig({
    version: 2,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    amp: {
      defaultRoute: DEFAULT_MODEL_ALIAS_ID,
      webSearch: {
        strategy: "ordered",
        count: 5,
        providers: [
          {
            id: "brave",
            apiKey: "brave_test_key",
            limit: 1000,
            remaining: 1000
          }
        ]
      }
    },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: [{ ref: "openai/gpt-4o" }]
      }
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        format: "openai",
        endpoints: ["https://api.openai.com/v1"],
        apiKeyEnv: "OPENAI_API_KEY",
        models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
        rateLimits: [
          {
            id: "default",
            models: ["gpt-4o-mini"],
            requests: 60,
            window: { unit: "minute", size: 1 }
          }
        ]
      }
    ],
    webSearch: {
      strategy: "ordered",
      count: 5,
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key",
          limit: 1000,
          remaining: 1000
        }
      ]
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  try {
    const { dom } = await loadWebConsoleDom(server.url);
    await waitForDomText(dom, "OpenAI");

    const webSearchTab = Array.from(dom.window.document.querySelectorAll('[role="tab"]'))
      .find((button) => (button.textContent || "").trim().includes("Web Search"));
    assert.ok(webSearchTab);
    webSearchTab.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    webSearchTab.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    webSearchTab.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, button: 0 }));
    webSearchTab.click();

    await waitForDomCondition(
      () => Boolean(dom.window.document.querySelector('input[placeholder="brv_..."]'))
        && Boolean(dom.window.document.querySelector('input[placeholder="tvly-..."]')),
      15_000,
      "Timed out waiting for the web-search credential inputs."
    );

    const braveInput = dom.window.document.querySelector('input[placeholder="brv_..."]');
    const tavilyInput = dom.window.document.querySelector('input[placeholder="tvly-..."]');
    assert.ok(braveInput);
    assert.ok(tavilyInput);

    setInputValue(dom.window, tavilyInput, "tavily_test_key");
    await waitForAsyncCondition(async () => {
      const persisted = JSON.parse(await readFile(fixture.configPath, "utf8"));
      const providers = Array.isArray(persisted.webSearch?.providers) ? persisted.webSearch.providers : [];
      return providers.some((provider) => provider?.id === "tavily" && provider?.apiKey === "tavily_test_key");
    }, 10_000, "Timed out waiting for the Tavily credential to persist.");

    setInputValue(dom.window, braveInput, "");
    await waitForAsyncCondition(async () => {
      const persisted = JSON.parse(await readFile(fixture.configPath, "utf8"));
      const providers = Array.isArray(persisted.webSearch?.providers) ? persisted.webSearch.providers : [];
      return !providers.some((provider) => provider?.id === "brave" && provider?.apiKey)
        && providers.some((provider) => provider?.id === "tavily" && provider?.apiKey === "tavily_test_key")
        && !Object.prototype.hasOwnProperty.call(persisted.amp || {}, "webSearch");
    }, 10_000, "Timed out waiting for the Brave credential to clear.");

    dom.window.close();

    const { dom: reloadedDom } = await loadWebConsoleDom(server.url);
    await waitForDomText(reloadedDom, "OpenAI");

    const reloadedWebSearchTab = Array.from(reloadedDom.window.document.querySelectorAll('[role="tab"]'))
      .find((button) => (button.textContent || "").trim().includes("Web Search"));
    assert.ok(reloadedWebSearchTab);
    reloadedWebSearchTab.dispatchEvent(new reloadedDom.window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    reloadedWebSearchTab.dispatchEvent(new reloadedDom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    reloadedWebSearchTab.dispatchEvent(new reloadedDom.window.MouseEvent("mouseup", { bubbles: true, button: 0 }));
    reloadedWebSearchTab.click();

    await waitForDomCondition(
      () => Boolean(reloadedDom.window.document.querySelector('input[placeholder="brv_..."]'))
        && Boolean(reloadedDom.window.document.querySelector('input[placeholder="tvly-..."]')),
      15_000,
      "Timed out waiting for the reloaded web-search inputs."
    );

    assert.equal(reloadedDom.window.document.querySelector('input[placeholder="brv_..."]')?.value || "", "");
    assert.equal(reloadedDom.window.document.querySelector('input[placeholder="tvly-..."]')?.value || "", "tavily_test_key");

    reloadedDom.window.close();
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console can add a hosted GPT web-search endpoint from the modal", async () => {
  const fixture = await makeTempConfig({
    version: 2,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    amp: {
      defaultRoute: DEFAULT_MODEL_ALIAS_ID
    },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "rc/gpt-5.4" }],
        fallbackTargets: []
      }
    },
    providers: [
      {
        id: "rc",
        name: "RamClouds",
        baseUrl: "https://ramclouds.me",
        format: "openai",
        formats: ["openai"],
        apiKey: "rc_test_key",
        models: [{ id: "gpt-5.4", formats: ["openai"] }],
        rateLimits: [
          {
            id: "default",
            models: ["gpt-5.4"],
            requests: 60,
            window: { unit: "minute", size: 1 }
          }
        ]
      }
    ],
    webSearch: {
      strategy: "ordered",
      count: 5,
      providers: []
    }
  });
  const hostedSearchTests = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    testHostedWebSearchProvider: async ({ providerId, modelId }) => {
      hostedSearchTests.push({ providerId, modelId });
      return {
        routeId: `${providerId}/${modelId}`,
        providerId,
        providerName: "RamClouds",
        modelId,
        label: "RamClouds · gpt-5.4",
        usedWebSearch: true,
        text: "Sunrise in Paris today is 7:10 AM according to Time and Date."
      };
    }
  });

  try {
    const { dom } = await loadWebConsoleDom(server.url);
    await waitForDomText(dom, "RamClouds");

    const webSearchTab = Array.from(dom.window.document.querySelectorAll('[role="tab"]'))
      .find((button) => (button.textContent || "").trim().includes("Web Search"));
    assert.ok(webSearchTab);
    webSearchTab.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    webSearchTab.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    webSearchTab.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, button: 0 }));
    webSearchTab.click();

    await waitForDomCondition(() => {
      return Array.from(dom.window.document.querySelectorAll("button"))
        .some((button) => (button.textContent || "").trim() === "Endpoint");
    }, 15_000, "Timed out waiting for the hosted search endpoint button.");

    const addButton = Array.from(dom.window.document.querySelectorAll("button"))
      .find((button) => (button.textContent || "").trim() === "Endpoint");
    assert.ok(addButton);
    addButton.click();

    await waitForDomText(dom, "Saved route id");
    await waitForDomText(dom, "rc/gpt-5.4");

    const testButton = Array.from(dom.window.document.querySelectorAll("button"))
      .find((button) => (button.textContent || "").trim() === "Test connection");
    assert.ok(testButton);
    testButton.click();

    await waitForAsyncCondition(async () => {
      const persisted = JSON.parse(await readFile(fixture.configPath, "utf8"));
      const providers = Array.isArray(persisted.webSearch?.providers) ? persisted.webSearch.providers : [];
      return providers.some((provider) => provider?.id === "rc/gpt-5.4" && provider?.providerId === "rc" && provider?.model === "gpt-5.4");
    }, 10_000, "Timed out waiting for the hosted GPT web-search route to persist.");

    assert.deepEqual(hostedSearchTests, [
      {
        providerId: "rc",
        modelId: "gpt-5.4"
      }
    ]);

    dom.window.close();
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console amp apply persists a cleared web-search provider", async () => {
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    webSearch: {
      strategy: "ordered",
      count: 5,
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key",
          limit: 1000,
          remaining: 1000
        }
      ]
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const nextConfig = structuredClone(initial.payload.config.document);
    nextConfig.webSearch.providers = [];

    const saved = await fetchJson(`${server.url}/api/amp/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rawText: JSON.stringify(nextConfig),
        source: "autosave"
      })
    });

    assert.equal(saved.response.status, 200);
    assert.deepEqual(saved.payload.config.document.webSearch.providers, []);
    assert.equal(Object.prototype.hasOwnProperty.call(saved.payload.config.document.amp || {}, "webSearch"), false);

    const persisted = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.deepEqual(persisted.webSearch?.providers, []);
    assert.equal(Object.prototype.hasOwnProperty.call(persisted.amp || {}, "webSearch"), false);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console can toggle activity logging and clear the shared log file", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const activityLogPath = resolveActivityLogPath(fixture.configPath);
  await appendActivityLogEntry(activityLogPath, {
    level: "warn",
    message: "Seeded runtime activity",
    detail: "Fallback moved to backup model.",
    source: "runtime"
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.payload.activityLog.enabled, true);
    assert.equal(initial.payload.logs.some((entry) => entry.message === "Seeded runtime activity"), true);
    assert.equal(initial.payload.logs.find((entry) => entry.message === "Seeded runtime activity")?.category, "usage");

    const disabled = await fetchJson(`${server.url}/api/activity-log/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.payload.activityLog.enabled, false);

    const disabledConfig = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal(disabledConfig.metadata.activityLog.enabled, false);

    const enabled = await fetchJson(`${server.url}/api/activity-log/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.payload.activityLog.enabled, true);

    const enabledConfig = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(enabledConfig.metadata || {}, "activityLog"), false);

    const cleared = await fetchJson(`${server.url}/api/activity-log/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(cleared.response.status, 200);
    assert.deepEqual(cleared.payload.logs, []);
    assert.equal(await readTextFileOrNull(activityLogPath), null);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console broadcasts shared activity log updates", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const activityLogPath = resolveActivityLogPath(fixture.configPath);
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  try {
    const logsEventPromise = waitForSseEvent(`${server.url}/api/events`, "logs", 4000, (payload) =>
      Array.isArray(payload?.logs) && payload.logs.some((entry) => entry.message === "Request fallback triggered for chat.default.")
    );

    await appendActivityLogEntry(activityLogPath, {
      level: "warn",
      message: "Request fallback triggered for chat.default.",
      detail: "demo/gpt-4o-mini failed (status 429 · rate limited). Trying demo/gpt-4o next.",
      source: "runtime"
    });

    const logsEvent = await logsEventPromise;
    assert.equal(logsEvent.activityLog.enabled, true);
    assert.equal(logsEvent.logs[0].message, "Request fallback triggered for chat.default.");
    assert.equal(logsEvent.logs[0].source, "runtime");
    assert.equal(logsEvent.logs[0].category, "usage");
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console state exposes a default draft when the config file is missing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-web-"));
  const configPath = path.join(dir, "missing.json");
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath
  });

  try {
    const { response, payload } = await fetchJson(`${server.url}/api/state`);
    assert.equal(response.status, 200);
    assert.equal(payload.config.path, configPath);
    assert.equal(payload.config.exists, false);
    assert.equal(payload.config.providerCount, 0);
    assert.equal(payload.config.parseError, "");
    assert.match(payload.config.rawText, /"version": 2/);
    assert.equal(await readTextFileOrNull(configPath), null);
  } finally {
    await server.close("test-cleanup");
    await rm(dir, { recursive: true, force: true });
  }
});

test("web console save upgrades a legacy config file to the latest schema", async () => {
  const fixture = await makeTempConfig(createLegacyV1Config());
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    assert.equal(initial.response.status, 200);
    assert.match(initial.payload.config.rawText, /"version": 1/);

    const saved = await fetchJson(`${server.url}/api/config/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: initial.payload.config.rawText })
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.config.providerCount, 1);

    const diskConfig = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal(diskConfig.version, 2);
    assert.deepEqual(Object.keys(diskConfig.modelAliases || {}), ["default"]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console blocks router start when the config file contains invalid JSON", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-web-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, "{\n", "utf8");
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath
  });

  try {
    const state = await fetchJson(`${server.url}/api/state`);
    assert.equal(state.response.status, 200);
    assert.equal(state.payload.config.parseError.length > 0, true);

    const started = await fetchJson(`${server.url}/api/router/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(started.response.status, 400);
    assert.match(started.payload.error || "", /Config JSON must parse before starting the router/);
  } finally {
    await server.close("test-cleanup");
    await rm(dir, { recursive: true, force: true });
  }
});

test("web console serves the React shell assets", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  });

  try {
    const htmlResponse = await fetch(server.url);
    const html = await htmlResponse.text();
    assert.equal(htmlResponse.status, 200);
    assert.match(html, /<div id="app"><\/div>/);

    const stylesResponse = await fetch(`${server.url}/styles.css`);
    assert.equal(stylesResponse.status, 200);
    assert.match(stylesResponse.headers.get("content-type") || "", /text\/css/);

    const appResponse = await fetch(`${server.url}/app.js`);
    assert.equal(appResponse.status, 200);
    assert.match(appResponse.headers.get("content-type") || "", /application\/javascript/);
    const appJs = await appResponse.text();
    assert.match(appJs, /claudeCode\.webSearchProvider/);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console edit-provider modal opens without triggering a render loop", async () => {
  const fixture = await makeTempConfig({
    version: 2,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    amp: {
      defaultRoute: DEFAULT_MODEL_ALIAS_ID
    },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: [{ ref: "openai/gpt-4o" }]
      }
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        format: "openai",
        baseUrl: "https://api.openai.com/v1",
        endpoints: ["https://api.openai.com/v1"],
        apiKeyEnv: "OPENAI_API_KEY",
        models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
        rateLimits: [
          {
            id: "default",
            models: ["gpt-4o-mini"],
            requests: 60,
            window: { unit: "minute", size: 1 }
          }
        ]
      }
    ]
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  try {
    const { dom, errors } = await loadWebConsoleDom(server.url);
    await waitForDomText(dom, "OpenAI");
    await new Promise((resolve) => setTimeout(resolve, 250));

    const editButton = dom.window.document.querySelector('button[aria-label="Edit provider OpenAI"]');
    assert.ok(editButton);

    editButton.click();

    await waitForDomText(dom, "Edit · openai");
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(
      errors.some((entry) => entry.includes("Maximum update depth exceeded")),
      false
    );
    assert.match(dom.window.document.body.textContent || "", /Switch between provider settings and model list/);

    dom.window.close();
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console save-provider closes the edit-provider modal", async () => {
  const fixture = await makeTempConfig({
    version: 2,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    amp: {
      defaultRoute: DEFAULT_MODEL_ALIAS_ID
    },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: [{ ref: "openai/gpt-4o" }]
      }
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        format: "openai",
        baseUrl: "https://api.openai.com/v1",
        endpoints: ["https://api.openai.com/v1"],
        apiKeyEnv: "OPENAI_API_KEY",
        models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
        rateLimits: [
          {
            id: "default",
            models: ["gpt-4o-mini"],
            requests: 60,
            window: { unit: "minute", size: 1 }
          }
        ]
      }
    ]
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  try {
    const { dom } = await loadWebConsoleDom(server.url);
    if (typeof dom.window.structuredClone !== "function" && typeof globalThis.structuredClone === "function") {
      dom.window.structuredClone = globalThis.structuredClone;
    }
    await waitForDomText(dom, "OpenAI");
    await new Promise((resolve) => setTimeout(resolve, 250));

    const editButton = dom.window.document.querySelector('button[aria-label="Edit provider OpenAI"]');
    assert.ok(editButton);
    editButton.click();

    await waitForDomText(dom, "Edit · openai");

    const getModalRoot = () => dom.window.document.body.lastElementChild;
    const modalRoot = getModalRoot();
    assert.ok(modalRoot);

    const providerIdInput = Array.from(modalRoot.querySelectorAll("input")).find((input) => input.value === "openai");
    assert.ok(providerIdInput);
    setInputValue(dom.window, providerIdInput, "openai-updated");
    providerIdInput.dispatchEvent(new dom.window.FocusEvent("blur", { bubbles: true }));

    await waitForDomCondition(
      () => Boolean(findButtonByText(getModalRoot(), "Save provider")),
      15_000,
      "Timed out waiting for Save provider button."
    );

    const saveButton = findButtonByText(getModalRoot(), "Save provider");
    assert.ok(saveButton);
    saveButton.click();

    await waitForDomTextToDisappear(dom, "Edit · openai");

    const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal(saved.providers[0]?.id, "openai-updated");

    dom.window.close();
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console save-models closes the edit-provider modal", async () => {
  const fixture = await makeTempConfig({
    version: 2,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    amp: {
      defaultRoute: DEFAULT_MODEL_ALIAS_ID
    },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: [{ ref: "openai/gpt-4o" }]
      }
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        format: "openai",
        endpoints: ["https://api.openai.com/v1"],
        apiKeyEnv: "OPENAI_API_KEY",
        models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
        rateLimits: [
          {
            id: "default",
            models: ["gpt-4o-mini"],
            requests: 60,
            window: { unit: "minute", size: 1 }
          }
        ]
      }
    ]
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  try {
    const { dom } = await loadWebConsoleDom(server.url);
    await waitForDomText(dom, "OpenAI");
    await new Promise((resolve) => setTimeout(resolve, 250));

    const editButton = dom.window.document.querySelector('button[aria-label="Edit provider OpenAI"]');
    assert.ok(editButton);
    editButton.click();

    await waitForDomText(dom, "Edit · openai");

    const modelsTab = findButtonByText(dom.window.document.body, "Model list");
    assert.ok(modelsTab);
    modelsTab.click();

    await waitForDomCondition(
      () => Boolean(dom.window.document.querySelector('input[aria-label="Context window for gpt-4o-mini"]')),
      15_000,
      "Timed out waiting for provider model inputs."
    );

    const contextInput = dom.window.document.querySelector('input[aria-label="Context window for gpt-4o-mini"]');
    assert.ok(contextInput);
    contextInput.focus();
    setInputValue(dom.window, contextInput, "128000");
    contextInput.dispatchEvent(new dom.window.FocusEvent("blur", { bubbles: true }));

    await waitForDomCondition(
      () => Boolean(findButtonByText(dom.window.document.body, "Save models")),
      15_000,
      "Timed out waiting for Save models button."
    );

    const saveButton = findButtonByText(dom.window.document.body, "Save models");
    assert.ok(saveButton);
    saveButton.click();

    await waitForDomTextToDisappear(dom, "Edit · openai");

    const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
    const savedModel = (saved.providers?.[0]?.models || []).find((model) => model.id === "gpt-4o-mini");
    assert.equal(savedModel?.contextWindow, 128000);

    dom.window.close();
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console keeps the provider model draft row and new models at the top", async () => {
  const fixture = await makeTempConfig({
    version: 2,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    amp: {
      defaultRoute: DEFAULT_MODEL_ALIAS_ID
    },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: [{ ref: "openai/gpt-4o" }]
      }
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        format: "openai",
        endpoints: ["https://api.openai.com/v1"],
        apiKeyEnv: "OPENAI_API_KEY",
        models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
        rateLimits: [
          {
            id: "default",
            models: ["gpt-4o-mini"],
            requests: 60,
            window: { unit: "minute", size: 1 }
          }
        ]
      }
    ]
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  try {
    const { dom } = await loadWebConsoleDom(server.url);
    await waitForDomText(dom, "OpenAI");
    await new Promise((resolve) => setTimeout(resolve, 250));

    const editButton = dom.window.document.querySelector('button[aria-label="Edit provider OpenAI"]');
    assert.ok(editButton);
    editButton.click();

    await waitForDomText(dom, "Edit · openai");

    const modelsTab = findButtonByText(dom.window.document.body, "Model list");
    assert.ok(modelsTab);
    modelsTab.click();

    const getModelInputs = () => Array.from(
      dom.window.document.querySelectorAll('input[placeholder="Add a new model id"], input[placeholder="Model id"]')
    );

    await waitForDomCondition(
      () => getModelInputs().length >= 3,
      15_000,
      "Timed out waiting for provider model inputs."
    );

    let modelInputs = getModelInputs();
    assert.equal(modelInputs[0]?.getAttribute("placeholder"), "Add a new model id");
    assert.deepEqual(
      modelInputs.slice(1).map((input) => input.value),
      ["gpt-4o-mini", "gpt-4o"]
    );

    setInputValue(dom.window, modelInputs[0], "gpt-4.1-mini");

    await waitForDomCondition(
      () => {
        const currentInputs = getModelInputs();
        return currentInputs.length >= 4
          && currentInputs[0]?.getAttribute("placeholder") === "Add a new model id"
          && currentInputs[0]?.value === ""
          && currentInputs[1]?.value === "gpt-4.1-mini"
          && currentInputs[2]?.value === "gpt-4o-mini"
          && currentInputs[3]?.value === "gpt-4o";
      },
      15_000,
      "Timed out waiting for provider models to keep the draft row and new model at the top."
    );

    dom.window.close();
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console add-alias modal shows placeholder guidance and no header close button", async () => {
  const fixture = await makeTempConfig({
    version: 2,
    defaultModel: DEFAULT_MODEL_ALIAS_ID,
    amp: {
      defaultRoute: DEFAULT_MODEL_ALIAS_ID
    },
    modelAliases: {
      [DEFAULT_MODEL_ALIAS_ID]: {
        id: DEFAULT_MODEL_ALIAS_ID,
        strategy: "ordered",
        targets: [{ ref: "openai/gpt-4o-mini" }],
        fallbackTargets: [{ ref: "openai/gpt-4o" }]
      }
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        format: "openai",
        baseUrl: "https://api.openai.com/v1",
        endpoints: ["https://api.openai.com/v1"],
        apiKeyEnv: "OPENAI_API_KEY",
        models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
        rateLimits: [
          {
            id: "default",
            models: ["gpt-4o-mini"],
            requests: 60,
            window: { unit: "minute", size: 1 }
          }
        ]
      }
    ]
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  });

  try {
    const { dom } = await loadWebConsoleDom(server.url);
    await waitForDomCondition(
      () => Boolean(findButtonByText(dom.window.document.body, "Add alias")),
      30_000,
      "Timed out waiting for Add alias button."
    );

    const addAliasButton = findButtonByText(dom.window.document.body, "Add alias");
    assert.ok(addAliasButton);
    addAliasButton.click();

    await waitForDomCondition(
      () => Boolean(dom.window.document.body.lastElementChild?.textContent?.includes("Create alias")),
      15_000,
      "Timed out waiting for add-alias modal."
    );

    const modalRoot = dom.window.document.body.lastElementChild;
    assert.ok(modalRoot);

    const aliasNameInput = modalRoot.querySelector('input[placeholder="Enter alias name. Example: claude-opus"]');
    assert.ok(aliasNameInput);
    assert.equal(findButtonByText(modalRoot, "Close"), null);

    dom.window.close();
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console does not load dev asset tooling when dev mode is disabled", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    loadWebConsoleDevAssets: async () => {
      throw new Error("dev assets should not load in production mode");
    }
  });

  try {
    const appResponse = await fetch(`${server.url}/app.js`);
    assert.equal(appResponse.status, 200);
    assert.match(appResponse.headers.get("content-type") || "", /application\/javascript/);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console toggles AMP global routing and reports the global route state", async () => {
  const ampClient = await makeAmpClientEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop"
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    ampClientEnv: ampClient.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.payload.ampClient.global.routedViaRouter, false);

    const enabled = await fetchJson(`${server.url}/api/amp/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.payload.ampClient.global.routedViaRouter, true);

    const routedUrl = `http://${FIXED_LOCAL_ROUTER_HOST}:${FIXED_LOCAL_ROUTER_PORT}`;
    const settings = await readJsonFileOrNull(getAmpSettingsPath(ampClient.env));
    const secrets = await readJsonFileOrNull(getAmpSecretsPath(ampClient.env));
    assert.equal(settings["amp.url"], routedUrl);
    assert.equal(secrets[`apiKey@${routedUrl}`], "gw_test_master_key_1234567890abcdefghijklmnop");

    const disabled = await fetchJson(`${server.url}/api/amp/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.payload.ampClient.global.routedViaRouter, false);

    const nextSettings = await readJsonFileOrNull(getAmpSettingsPath(ampClient.env));
    const nextSecrets = await readJsonFileOrNull(getAmpSecretsPath(ampClient.env));
    assert.equal(Object.prototype.hasOwnProperty.call(nextSettings, "amp.url"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(nextSecrets, `apiKey@${routedUrl}`), false);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await ampClient.cleanup();
  }
});

test("web console treats AMP as connected when the endpoint matches even if the stored secret changes", async () => {
  const ampClient = await makeAmpClientEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop"
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    ampClientEnv: ampClient.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const enabled = await fetchJson(`${server.url}/api/amp/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });
    assert.equal(enabled.response.status, 200);

    const routedUrl = `http://${FIXED_LOCAL_ROUTER_HOST}:${FIXED_LOCAL_ROUTER_PORT}`;
    const secretsPath = getAmpSecretsPath(ampClient.env);
    const secrets = await readJsonFileOrNull(secretsPath);
    secrets[`apiKey@${routedUrl}`] = "gw_replaced_secret_value";
    await writeFile(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");

    const refreshed = await fetchJson(`${server.url}/api/state`);
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.payload.ampClient.global.routedViaRouter, true);
    assert.equal(refreshed.payload.ampClient.global.configuredUrl, routedUrl);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await ampClient.cleanup();
  }
});

test("web console can validate, save, start, and stop managed router", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.payload.router.running, true);

    const invalid = await fetchJson(`${server.url}/api/config/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: "{" })
    });
    assert.equal(invalid.response.status, 200);
    assert.equal(invalid.payload.summary.parseError.length > 0, true);

    const nextConfig = createBaseConfig();
    nextConfig.masterKey = "gw_example_key_1234567890abcdefghijklmnop";
    const saved = await fetchJson(`${server.url}/api/config/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: `${JSON.stringify(nextConfig, null, 2)}
` })
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.config.hasMasterKey, true);

    const stopped = await fetchJson(`${server.url}/api/router/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(stopped.response.status, 200);
    assert.equal(stopped.payload.router.running, false);

    const started = await fetchJson(`${server.url}/api/router/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requireAuth: false, watchConfig: true })
    });
    assert.equal(started.response.status, 200);
    assert.equal(started.payload.router.running, true);
    assert.match(started.payload.router.url, /^http:\/\//);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console reports an occupied router port and can reclaim it", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const harness = createRouterHarness(fixture.configPath);
  let occupiedPids = [];
  const reclaimCalls = [];
  const server = await startWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    ...harness.deps,
    listListeningPids: () => ({ ok: true, pids: occupiedPids }),
    reclaimPort: async ({ port }) => {
      reclaimCalls.push(port);
      occupiedPids = [];
      return { ok: true };
    }
  });

  try {
    const stopped = await fetchJson(`${server.url}/api/router/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(stopped.response.status, 200);
    occupiedPids = [7123];

    const state = await fetchJson(`${server.url}/api/state`);
    assert.equal(state.response.status, 200);
    assert.equal(state.payload.router.running, false);
    assert.equal(state.payload.router.portBusy, true);
    assert.deepEqual(state.payload.router.listenerPids, [7123]);

    const reclaimed = await fetchJson(`${server.url}/api/router/reclaim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(reclaimed.response.status, 200);
    assert.equal(reclaimed.payload.router.portBusy, false);
    assert.deepEqual(reclaimed.payload.router.listenerPids, []);
    assert.deepEqual(reclaimCalls, [state.payload.config.localServer.port]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console reclaims the router port before starting", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const harness = createRouterHarness(fixture.configPath);
  let occupiedPids = [];
  const actionOrder = [];
  const server = await startWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    ...harness.deps,
    listListeningPids: () => ({ ok: true, pids: occupiedPids }),
    reclaimPort: async () => {
      actionOrder.push("reclaim");
      occupiedPids = [];
      return { ok: true };
    },
    startDetachedRouterService: async (options) => {
      actionOrder.push("start");
      assert.deepEqual(occupiedPids, []);
      return harness.deps.startDetachedRouterService(options);
    }
  });

  try {
    const stopped = await fetchJson(`${server.url}/api/router/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(stopped.response.status, 200);

    actionOrder.length = 0;
    occupiedPids = [8123];

    const started = await fetchJson(`${server.url}/api/router/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requireAuth: false, watchConfig: true })
    });
    assert.equal(started.response.status, 200);
    assert.equal(started.payload.router.running, true);
    assert.deepEqual(actionOrder, ["reclaim", "start"]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("closing the web console does not stop the running router service", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const harness = createRouterHarness(fixture.configPath);
  const server = await startWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, harness.deps);

  try {
    const state = await fetchJson(`${server.url}/api/state`);
    assert.equal(state.response.status, 200);
    assert.equal(state.payload.router.running, true);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }

  assert.deepEqual(harness.stopCalls, []);
  assert.equal(Boolean(harness.activeRuntime), true);
});

test("web console auto-starts on the fixed router port and stops mismatched runtimes", async () => {
  const staleRouterPort = await getAvailablePort();
  const fixture = await makeTempConfig(createBaseConfig());
  const harness = createRouterHarness(fixture.configPath, {
    initialRuntime: {
      pid: 4242,
      host: FIXED_LOCAL_ROUTER_HOST,
      port: staleRouterPort,
      configPath: fixture.configPath,
      watchConfig: true,
      watchBinary: true,
      requireAuth: false,
      managedByStartup: false,
      cliPath: process.argv[1] || "",
      startedAt: new Date().toISOString(),
      version: "test"
    }
  });

  const server = await startWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, harness.deps);

  try {
    const state = await fetchJson(`${server.url}/api/state`);
    assert.equal(state.response.status, 200);
    assert.deepEqual(harness.stopCalls, [4242]);
    assert.equal(state.payload.router.running, true);
    assert.equal(state.payload.router.port, FIXED_LOCAL_ROUTER_PORT);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console keeps an existing manual router on the configured port even when startup is installed", async () => {
  const fixture = await makeTempConfig({
    ...createBaseConfig()
  });
  const harness = createRouterHarness(fixture.configPath, {
    initialRuntime: {
      pid: 9311,
      host: FIXED_LOCAL_ROUTER_HOST,
      port: FIXED_LOCAL_ROUTER_PORT,
      configPath: fixture.configPath,
      watchConfig: true,
      watchBinary: true,
      requireAuth: false,
      managedByStartup: false,
      cliPath: process.argv[1] || "",
      startedAt: new Date().toISOString(),
      version: "test"
    }
  });
  const installCalls = [];

  const server = await startWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    ...harness.deps,
    startupStatus: async () => ({
      manager: "launchd",
      serviceId: "dev.llm-router",
      installed: true,
      running: false,
      detail: "Startup service is installed but not currently loaded."
    }),
    installStartup: async (options) => {
      installCalls.push(options);
      throw new Error("installStartup should not run while a router already owns the configured port");
    }
  });

  try {
    const { response, payload } = await fetchJson(`${server.url}/api/state`);
    assert.equal(response.status, 200);
    assert.equal(payload.router.running, true);
    assert.equal(payload.router.port, FIXED_LOCAL_ROUTER_PORT);
    assert.equal(payload.router.portBusy, false);
    assert.deepEqual(harness.stopCalls, []);
    assert.deepEqual(installCalls, []);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console treats startup launch as ready when the endpoint runtime appears before managed flag sync", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const harness = createRouterHarness(fixture.configPath);
  const installCalls = [];
  let startupRunning = false;

  const server = await startWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    ...harness.deps,
    startupStatus: async () => ({
      manager: "launchd",
      serviceId: "dev.llm-router",
      installed: true,
      running: startupRunning,
      detail: startupRunning
        ? "LaunchAgent is running."
        : "Startup service is installed but not currently loaded."
    }),
    installStartup: async (options) => {
      installCalls.push(options);
      startupRunning = true;
      harness.activeRuntime = {
        pid: 9402,
        host: options.host,
        port: options.port,
        configPath: fixture.configPath,
        watchConfig: options.watchConfig,
        watchBinary: options.watchBinary,
        requireAuth: options.requireAuth,
        managedByStartup: false,
        cliPath: process.argv[1] || "",
        startedAt: new Date().toISOString(),
        version: "test"
      };
      return {
        manager: "launchd",
        serviceId: "dev.llm-router",
        filePath: "/tmp/dev.llm-router.plist"
      };
    },
    waitForRuntimeMatch: async () => null
  });

  try {
    const { response, payload } = await fetchJson(`${server.url}/api/state`);
    assert.equal(response.status, 200);
    assert.equal(payload.router.running, true);
    assert.equal(payload.router.port, payload.config.localServer.port);
    assert.equal(payload.router.lastError, "");
    assert.equal(payload.router.portBusy, false);
    assert.equal(installCalls.length, 1);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console uses the installed startup service as the single router owner", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const harness = createRouterHarness(fixture.configPath);
  const installCalls = [];
  let startupRunning = false;

  const server = await startWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    ...harness.deps,
    startupStatus: async () => ({
      manager: "launchd",
      serviceId: "dev.llm-router",
      installed: true,
      running: startupRunning,
      detail: startupRunning
        ? "LaunchAgent is running."
        : "Startup service is installed but not currently loaded."
    }),
    installStartup: async (options) => {
      installCalls.push(options);
      startupRunning = true;
      harness.activeRuntime = {
        pid: 9401,
        host: options.host,
        port: options.port,
        configPath: fixture.configPath,
        watchConfig: options.watchConfig,
        watchBinary: options.watchBinary,
        requireAuth: options.requireAuth,
        managedByStartup: true,
        cliPath: process.argv[1] || "",
        startedAt: new Date().toISOString(),
        version: "test"
      };
      return {
        manager: "launchd",
        serviceId: "dev.llm-router",
        filePath: "/tmp/dev.llm-router.plist"
      };
    },
    stopStartup: async () => {
      startupRunning = false;
      harness.activeRuntime = null;
      return {
        manager: "launchd",
        serviceId: "dev.llm-router",
        installed: true,
        running: false,
        detail: "Startup service is installed but not currently loaded."
      };
    }
  });

  try {
    const { response, payload } = await fetchJson(`${server.url}/api/state`);
    assert.equal(response.status, 200);
    assert.equal(payload.router.running, true);
    assert.equal(payload.router.port, payload.config.localServer.port);
    assert.equal(payload.startup.running, true);
    assert.equal(harness.startCalls.length, 0);
    assert.equal(installCalls.length, 1);
    assert.equal(installCalls[0].configPath, fixture.configPath);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console adopts an existing llm-router on the fixed router port", async () => {
  const fixture = await makeTempConfig(createBaseConfig());

  const harness = createRouterHarness(fixture.configPath, {
    initialRuntime: {
      pid: 4242,
      host: FIXED_LOCAL_ROUTER_HOST,
      port: FIXED_LOCAL_ROUTER_PORT,
      configPath: fixture.configPath,
      watchConfig: false,
      watchBinary: false,
      requireAuth: false,
      managedByStartup: false,
      cliPath: process.argv[1] || "",
      startedAt: new Date().toISOString(),
      version: "test"
    }
  });

  const server = await startWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, harness.deps);

  try {
    const { response, payload } = await fetchJson(`${server.url}/api/state`);
    assert.equal(response.status, 200);
    assert.deepEqual(harness.stopCalls, []);
    assert.equal(payload.config.localServer.port, FIXED_LOCAL_ROUTER_PORT);
    assert.equal(payload.router.running, true);
    assert.equal(payload.router.port, FIXED_LOCAL_ROUTER_PORT);
    assert.equal(payload.router.portBusy, false);
    assert.equal(payload.externalRuntime, null);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console can start subscription login via injected helper", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const calls = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    loginSubscription: async (profileId, options = {}) => {
      calls.push({ profileId, subscriptionType: options.subscriptionType });
      options.onUrl?.("https://auth.example.test", { openedBrowser: true });
      return true;
    }
  });

  try {
    const result = await fetchJson(`${server.url}/api/subscription/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileId: "personal",
        subscriptionType: "chatgpt-codex"
      })
    });

    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.authUrl, "https://auth.example.test");
    assert.deepEqual(calls, [{ profileId: "personal", subscriptionType: "chatgpt-codex" }]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console subscription login falls back to provider id when profile is omitted", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const calls = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    loginSubscription: async (profileId, options = {}) => {
      calls.push({ profileId, subscriptionType: options.subscriptionType });
      return true;
    }
  });

  try {
    const result = await fetchJson(`${server.url}/api/subscription/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt-sub",
        subscriptionType: "chatgpt-codex"
      })
    });

    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    assert.deepEqual(calls, [{ profileId: "chatgpt-sub", subscriptionType: "chatgpt-codex" }]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console can test provider config via injected endpoint checker", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const calls = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    testProviderConfig: async (input) => {
      calls.push(input);
      return {
        ok: true,
        workingFormats: ["openai"],
        preferredFormat: "openai",
        baseUrlByFormat: { openai: input.endpoints[0] },
        models: [input.models[0]],
        modelPreferredFormat: { [input.models[0]]: "openai" },
        warnings: []
      };
    }
  });

  try {
    const tested = await fetchJson(`${server.url}/api/config/test-provider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoints: ["https://api.openai.com/v1", "https://example.invalid/v1"],
        models: ["gpt-4o-mini", "gpt-4.1-mini"],
        apiKeyEnv: "OPENAI_API_KEY"
      })
    });

    assert.equal(tested.response.status, 200);
    assert.equal(tested.payload.result.ok, true);
    assert.deepEqual(tested.payload.result.workingFormats, ["openai"]);
    assert.deepEqual(tested.payload.result.models, ["gpt-4o-mini"]);
    assert.deepEqual(calls, [{
      endpoints: ["https://api.openai.com/v1", "https://example.invalid/v1"],
      models: ["gpt-4o-mini", "gpt-4.1-mini"],
      apiKeyEnv: "OPENAI_API_KEY",
      apiKey: "",
      headers: undefined
    }]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console test-provider accepts a direct api key value", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const calls = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    testProviderConfig: async (input) => {
      calls.push(input);
      return {
        ok: true,
        workingFormats: ["openai"],
        preferredFormat: "openai",
        baseUrlByFormat: { openai: input.endpoints[0] },
        models: input.models,
        modelPreferredFormat: Object.fromEntries(input.models.map((modelId) => [modelId, "openai"])),
        warnings: []
      };
    }
  });

  try {
    const tested = await fetchJson(`${server.url}/api/config/test-provider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoints: ["https://api.openai.com/v1"],
        models: ["gpt-4o-mini"],
        apiKey: "sk-live-direct-test"
      })
    });

    assert.equal(tested.response.status, 200);
    assert.equal(tested.payload.result.ok, true);
    assert.deepEqual(calls, [{
      endpoints: ["https://api.openai.com/v1"],
      models: ["gpt-4o-mini"],
      apiKeyEnv: "",
      apiKey: "sk-live-direct-test",
      headers: undefined
    }]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});


test("web console test-provider stream emits model progress and final result", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    testProviderConfig: async (input) => {
      input.onProgress?.({ phase: "model-done", model: "gpt-4o-mini", confirmed: true, formats: ["openai"] });
      input.onProgress?.({ phase: "model-done", model: "gpt-4.1-mini", confirmed: false, formats: [] });
      return {
        ok: false,
        workingFormats: ["openai"],
        preferredFormat: "openai",
        baseUrlByFormat: { openai: input.endpoints[0] },
        models: ["gpt-4o-mini"],
        unresolvedModels: ["gpt-4.1-mini"],
        warnings: ["1 model(s) were not fully auto-discovered and require manual confirmation."]
      };
    }
  });

  try {
    const response = await fetch(`${server.url}/api/config/test-provider-stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoints: ["https://api.openai.com/v1"],
        models: ["gpt-4o-mini", "gpt-4.1-mini"],
        apiKey: "sk-live-direct-test"
      })
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    const lines = body.trim().split(/\n+/).map((line) => JSON.parse(line));
    assert.equal(lines[0].type, "start");
    assert.deepEqual(lines.filter((entry) => entry.type === "progress").map((entry) => entry.event.model), ["gpt-4o-mini", "gpt-4.1-mini"]);
    assert.equal(lines.at(-1).type, "result");
    assert.deepEqual(lines.at(-1).result.models, ["gpt-4o-mini"]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console can discover provider models via injected helper", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const calls = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    discoverProviderModels: async (input) => {
      calls.push(input);
      return {
        ok: true,
        models: ["gpt-4o-mini", "gpt-4.1-mini"],
        workingFormats: ["openai"],
        preferredFormat: "openai",
        baseUrlByFormat: { openai: input.endpoints[0] },
        authByFormat: { openai: { type: "bearer" } },
        warnings: []
      };
    }
  });

  try {
    const discovered = await fetchJson(`${server.url}/api/config/discover-provider-models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoints: ["https://api.openai.com/v1", "https://example.invalid/v1"],
        apiKey: "sk-live-direct-test",
        headers: {
          "User-Agent": "AICodeClient/1.0.0",
          "x-test-header": "demo"
        }
      })
    });

    assert.equal(discovered.response.status, 200);
    assert.equal(discovered.payload.result.ok, true);
    assert.deepEqual(discovered.payload.result.models, ["gpt-4o-mini", "gpt-4.1-mini"]);
    assert.deepEqual(calls, [{
      endpoints: ["https://api.openai.com/v1", "https://example.invalid/v1"],
      apiKeyEnv: "",
      apiKey: "sk-live-direct-test",
      headers: {
        "User-Agent": "AICodeClient/1.0.0",
        "x-test-header": "demo"
      }
    }]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console can look up model context windows via injected LiteLLM helper", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const calls = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    lookupLiteLlmContextWindow: async (input) => {
      calls.push(input);
      return [{
        query: "gpt-4o-mini",
        exactMatch: {
          model: "gpt-4o-mini",
          contextWindow: 128000,
          provider: "openai"
        },
        suggestions: [],
        medianContextWindow: 128000
      }];
    }
  });

  try {
    const lookup = await fetchJson(`${server.url}/api/config/litellm-context-lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: ["gpt-4o-mini"],
        limit: 3
      })
    });

    assert.equal(lookup.response.status, 200);
    assert.deepEqual(lookup.payload.result, [{
      query: "gpt-4o-mini",
      exactMatch: {
        model: "gpt-4o-mini",
        contextWindow: 128000,
        provider: "openai"
      },
      suggestions: [],
      medianContextWindow: 128000
    }]);
    assert.equal(lookup.payload.source.provider, "litellm");
    assert.deepEqual(calls, [{
      models: ["gpt-4o-mini"],
      limit: 3
    }]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("exit endpoint shuts down the web console process loop", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  });

  try {
    const exiting = await fetchJson(`${server.url}/api/exit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(exiting.response.status, 200);
    const done = await server.done;
    assert.deepEqual(done, { reason: "user-exit" });
    assert.equal(Boolean(server.routerHarness.activeRuntime), true);
    assert.deepEqual(server.routerHarness.stopCalls, []);
  } finally {
    await fixture.cleanup();
  }
});


test("web console broadcasts state when config file changes on disk", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  });

  try {
    const stateEvent = waitForSseEvent(`${server.url}/api/events`, "state", 4000, (payload) => payload?.snapshot?.config?.hasMasterKey === true);
    const nextConfig = createBaseConfig();
    nextConfig.masterKey = "gw_live_sync_example_1234567890abcdefghijklmnop";
    setTimeout(() => {
      void writeFile(fixture.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
    }, 150);

    const payload = await stateEvent;
    assert.equal(payload.snapshot.config.hasMasterKey, true);
    assert.match(payload.snapshot.config.rawText, /masterKey/);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});


test("detectAvailableEditors adds common editors when commands exist", () => {
  const editors = detectAvailableEditors({
    platform: "linux",
    exists: (command) => ["code", "subl", "gedit"].includes(command)
  });

  assert.equal(editors.some((entry) => entry.id === "default"), true);
  assert.equal(editors.some((entry) => entry.id === "vscode"), true);
  assert.equal(editors.some((entry) => entry.id === "sublime"), true);
  assert.equal(editors.some((entry) => entry.id === "gedit"), true);
});

test("web console can open config in detected editor", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const opened = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
  }, {
    detectAvailableEditors: () => [{ id: "vscode", label: "VS Code", description: "Open in VS Code" }],
    openConfigInEditor: async (editorId, configPath) => {
      opened.push({ editorId, configPath });
    }
  });

  try {
    const stateResponse = await fetchJson(`${server.url}/api/state`);
    assert.deepEqual(stateResponse.payload.editors, [{ id: "vscode", label: "VS Code", description: "Open in VS Code" }]);

    const openResponse = await fetchJson(`${server.url}/api/config/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ editorId: "vscode" })
    });

    assert.equal(openResponse.response.status, 200);
    assert.deepEqual(opened, [{ editorId: "vscode", configPath: fixture.configPath }]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console can open AMP config in detected editor", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const ampClient = await makeAmpClientEnv();
  const opened = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    ampClientEnv: ampClient.env,
    openFileInEditor: async (editorId, filePath) => {
      opened.push({ editorId, filePath });
    }
  });

  try {
    const state = await fetchJson(`${server.url}/api/state`);
    assert.equal(state.response.status, 200);
    assert.equal(state.payload.ampClient.global.settingsFilePath, getAmpSettingsPath(ampClient.env));
    assert.equal(state.payload.ampClient.global.secretsFilePath, getAmpSecretsPath(ampClient.env));

    const openResponse = await fetchJson(`${server.url}/api/amp/config/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ editorId: "default" })
    });

    assert.equal(openResponse.response.status, 200);
    assert.equal(openResponse.payload.filePath, getAmpSettingsPath(ampClient.env));
    assert.equal(openResponse.payload.secretsFilePath, getAmpSecretsPath(ampClient.env));
    assert.deepEqual(opened, [{ editorId: "default", filePath: getAmpSettingsPath(ampClient.env) }]);
    assert.deepEqual(await readJsonFileOrNull(getAmpSettingsPath(ampClient.env)), {});
    assert.deepEqual(await readJsonFileOrNull(getAmpSecretsPath(ampClient.env)), {});
  } finally {
    await server.close("test-cleanup");
    await ampClient.cleanup();
    await fixture.cleanup();
  }
});

test("web console can open managed file chips by path", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const opened = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    openFileInEditor: async (editorId, filePath) => {
      opened.push({ editorId, filePath });
    }
  });

  const textFilePath = path.join(fixture.dir, "tooling", "config.toml");
  const jsonFilePath = path.join(fixture.dir, "tooling", "backup.json");

  try {
    const textResponse = await fetchJson(`${server.url}/api/file/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        editorId: "default",
        filePath: textFilePath,
        ensureMode: "text"
      })
    });

    const jsonResponse = await fetchJson(`${server.url}/api/file/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        editorId: "default",
        filePath: jsonFilePath,
        ensureMode: "jsonObject"
      })
    });

    assert.equal(textResponse.response.status, 200);
    assert.equal(jsonResponse.response.status, 200);
    assert.equal(await readTextFileOrNull(textFilePath), "");
    assert.deepEqual(await readJsonFileOrNull(jsonFilePath), {});
    assert.deepEqual(opened, [
      { editorId: "default", filePath: textFilePath },
      { editorId: "default", filePath: jsonFilePath }
    ]);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console opens the workspace AMP config when it already exists", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const ampClient = await makeAmpClientEnv();
  const opened = [];
  const workspaceAmpSettingsPath = getWorkspaceAmpSettingsPath(fixture.dir);
  await mkdir(path.dirname(workspaceAmpSettingsPath), { recursive: true });
  await writeFile(workspaceAmpSettingsPath, `${JSON.stringify({ "amp.url": `http://${FIXED_LOCAL_ROUTER_HOST}:${FIXED_LOCAL_ROUTER_PORT}` }, null, 2)}\n`, "utf8");
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    ampClientEnv: ampClient.env,
    ampClientCwd: fixture.dir,
    openFileInEditor: async (editorId, filePath) => {
      opened.push({ editorId, filePath });
    }
  });

  try {
    const state = await fetchJson(`${server.url}/api/state`);
    assert.equal(state.response.status, 200);
    assert.equal(state.payload.ampClient.global.scope, "workspace");
    assert.equal(state.payload.ampClient.global.settingsFilePath, workspaceAmpSettingsPath);
    assert.equal(state.payload.ampClient.global.secretsFilePath, getAmpSecretsPath(ampClient.env));

    const openResponse = await fetchJson(`${server.url}/api/amp/config/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ editorId: "default" })
    });

    assert.equal(openResponse.response.status, 200);
    assert.equal(openResponse.payload.filePath, workspaceAmpSettingsPath);
    assert.equal(openResponse.payload.secretsFilePath, getAmpSecretsPath(ampClient.env));
    assert.deepEqual(opened, [{ editorId: "default", filePath: workspaceAmpSettingsPath }]);
    assert.deepEqual(
      await readJsonFileOrNull(workspaceAmpSettingsPath),
      { "amp.url": `http://${FIXED_LOCAL_ROUTER_HOST}:${FIXED_LOCAL_ROUTER_PORT}` }
    );
    assert.deepEqual(await readJsonFileOrNull(getAmpSecretsPath(ampClient.env)), {});
  } finally {
    await server.close("test-cleanup");
    await ampClient.cleanup();
    await fixture.cleanup();
  }
});

test("web console toggles AMP routing against the workspace AMP config when present", async () => {
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop"
  });
  const ampClient = await makeAmpClientEnv();
  const workspaceAmpSettingsPath = getWorkspaceAmpSettingsPath(fixture.dir);
  await mkdir(path.dirname(workspaceAmpSettingsPath), { recursive: true });
  await writeFile(workspaceAmpSettingsPath, "{}\n", "utf8");
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    ampClientEnv: ampClient.env,
    ampClientCwd: fixture.dir
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.payload.ampClient.global.scope, "workspace");
    assert.equal(initial.payload.ampClient.global.routedViaRouter, false);

    const enabled = await fetchJson(`${server.url}/api/amp/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.payload.ampClient.global.scope, "workspace");
    assert.equal(enabled.payload.ampClient.global.routedViaRouter, true);

    const routedUrl = `http://${FIXED_LOCAL_ROUTER_HOST}:${FIXED_LOCAL_ROUTER_PORT}`;
    const workspaceSettings = await readJsonFileOrNull(workspaceAmpSettingsPath);
    const globalSettings = await readJsonFileOrNull(getAmpSettingsPath(ampClient.env));
    const secrets = await readJsonFileOrNull(getAmpSecretsPath(ampClient.env));
    assert.equal(workspaceSettings["amp.url"], routedUrl);
    assert.equal(globalSettings, null);
    assert.equal(secrets[`apiKey@${routedUrl}`], "gw_test_master_key_1234567890abcdefghijklmnop");
  } finally {
    await server.close("test-cleanup");
    await ampClient.cleanup();
    await fixture.cleanup();
  }
});

test("web console can open Codex CLI config in detected editor", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const codexCli = await makeCodexCliEnv();
  const opened = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    codexCliEnv: codexCli.env,
    openFileInEditor: async (editorId, filePath) => {
      opened.push({ editorId, filePath });
    }
  });

  try {
    const openResponse = await fetchJson(`${server.url}/api/codex-cli/config/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ editorId: "default" })
    });

    assert.equal(openResponse.response.status, 200);
    assert.deepEqual(opened, [{ editorId: "default", filePath: getCodexConfigPath(codexCli.env) }]);
    assert.equal(await readTextFileOrNull(getCodexConfigPath(codexCli.env)), "");
    assert.deepEqual(await readJsonFileOrNull(getToolBackupPath(getCodexConfigPath(codexCli.env))), {});
  } finally {
    await server.close("test-cleanup");
    await codexCli.cleanup();
    await fixture.cleanup();
  }
});

test("web console toggles Codex CLI global routing and restores the prior config", async () => {
  const codexCli = await makeCodexCliEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop"
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    codexCliEnv: codexCli.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.payload.codingTools.codexCli.routedViaRouter, false);

    const enabled = await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.payload.codingTools.codexCli.routedViaRouter, true);

    const expectedBaseUrl = `http://${FIXED_LOCAL_ROUTER_HOST}:${FIXED_LOCAL_ROUTER_PORT}/openai/v1`;
    const catalogPath = getCodexModelCatalogPath(codexCli.env);
    const codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.match(codexConfigText || "", /model_provider = "llm-router"/);
    assert.match(codexConfigText || "", /model = "demo\/gpt-4o-mini"/);
    assert.ok(String(codexConfigText || "").includes(`model_catalog_json = "${catalogPath}"`));
    assert.ok(String(codexConfigText || "").includes(`base_url = "${expectedBaseUrl}"`));
    assert.match(codexConfigText || "", /experimental_bearer_token = "gw_test_master_key_1234567890abcdefghijklmnop"/);
    const catalog = await readJsonFileOrNull(catalogPath);
    assert.equal(catalog?.models?.some((entry) => entry?.slug === "demo/gpt-4o-mini"), true);

    const backup = await readJsonFileOrNull(getToolBackupPath(getCodexConfigPath(codexCli.env)));
    assert.deepEqual(backup, {});

    const disabled = await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.payload.codingTools.codexCli.routedViaRouter, false);

    const restoredConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.doesNotMatch(restoredConfigText || "", /model_provider = "llm-router"/);
    assert.doesNotMatch(restoredConfigText || "", /\[model_providers\.llm-router\]/);
    assert.deepEqual(await readJsonFileOrNull(getToolBackupPath(getCodexConfigPath(codexCli.env))), {});
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await codexCli.cleanup();
  }
});

test("web console uses the configured router port for Codex CLI routing endpoints", async () => {
  const customRouterPort = FIXED_LOCAL_ROUTER_PORT + 1;
  const codexCli = await makeCodexCliEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop"
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
    routerPort: customRouterPort
  }, {
    codexCliEnv: codexCli.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    assert.equal(initial.response.status, 200);

    const enabled = await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.payload.codingTools.codexCli.routedViaRouter, true);

    const expectedBaseUrl = `http://${FIXED_LOCAL_ROUTER_HOST}:${customRouterPort}/openai/v1`;
    const codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.ok(String(codexConfigText || "").includes(`base_url = "${expectedBaseUrl}"`));
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await codexCli.cleanup();
  }
});

test("web console dev mode blocks startup management", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  let installCalls = 0;
  let uninstallCalls = 0;
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
    devMode: true,
    routerPort: FIXED_LOCAL_ROUTER_PORT + 1
  }, {
    installStartup: async () => {
      installCalls += 1;
      return { manager: "launchd", installed: true, running: true };
    },
    uninstallStartup: async () => {
      uninstallCalls += 1;
    }
  });

  try {
    const enableResponse = await fetchJson(`${server.url}/api/startup/enable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(enableResponse.response.status, 409);
    assert.match(enableResponse.payload.error || "", /unavailable in dev mode/i);

    const disableResponse = await fetchJson(`${server.url}/api/startup/disable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(disableResponse.response.status, 409);
    assert.match(disableResponse.payload.error || "", /unavailable in dev mode/i);
    assert.equal(installCalls, 0);
    assert.equal(uninstallCalls, 0);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("web console dev mode can sync from the production config while preserving the dev router port", async () => {
  const devRouterPort = FIXED_LOCAL_ROUTER_PORT + 1;
  const fixture = await makeTempConfig(createBaseConfig());
  const productionFixture = await makeTempConfig({
    providers: [
      {
        id: "prod-sync",
        name: "Production Sync Provider",
        baseUrl: "https://prod.example.com/v1",
        apiKey: "sk-prod-sync-1234",
        format: "openai",
        models: [{ id: "gpt-4.1-mini" }]
      }
    ],
    modelAliases: {
      default: {
        id: "default",
        strategy: "ordered",
        targets: [{ ref: "prod-sync/gpt-4.1-mini" }],
        fallbackTargets: []
      }
    }
  });

  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath,
    productionConfigPath: productionFixture.configPath,
    routerPort: devRouterPort,
    devMode: true
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.payload.environment.devMode, true);
    assert.equal(initial.payload.environment.canSyncProductionConfig, true);
    assert.equal(initial.payload.config.localServer.port, devRouterPort);

    const synced = await fetchJson(`${server.url}/api/config/sync-production`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(synced.response.status, 200);
    assert.equal(synced.payload.environment.devMode, true);
    assert.equal(synced.payload.config.localServer.port, devRouterPort);
    assert.equal(synced.payload.router.port, devRouterPort);
    assert.match(String(synced.payload.config.rawText || ""), /prod-sync/);
    assert.match(String(synced.payload.message || ""), /Synced dev config from/);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await productionFixture.cleanup();
  }
});

test("web console writes Codex CLI model catalog metadata for alias bindings and removes it on disconnect", async () => {
  const codexCli = await makeCodexCliEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    modelAliases: {
      smart: {
        id: "smart",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      }
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    codexCliEnv: codexCli.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const enabled = await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText,
        bindings: {
          defaultModel: "smart"
        }
      })
    });
    assert.equal(enabled.response.status, 200);

    const catalogPath = getCodexModelCatalogPath(codexCli.env);
    const codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.match(codexConfigText || "", /model = "smart"/);
    assert.ok(String(codexConfigText || "").includes(`model_catalog_json = "${catalogPath}"`));

    const catalog = await readJsonFileOrNull(catalogPath);
    assert.equal(Array.isArray(catalog?.models), true);
    assert.equal(catalog.models.some((entry) => entry?.slug === "smart"), true);

    const disabled = await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(disabled.response.status, 200);

    const restoredConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.doesNotMatch(restoredConfigText || "", /model_catalog_json = /);
    assert.equal(await readTextFileOrNull(catalogPath), null);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await codexCli.cleanup();
  }
});

test("web console writes Codex CLI model catalog metadata for direct route bindings", async () => {
  const codexCli = await makeCodexCliEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    defaultModel: "rc/gpt-5.4",
    providers: [{
      id: "rc",
      name: "Router Codex",
      format: "openai",
      baseUrl: "https://api.example.test/v1",
      apiKey: "provider-secret",
      models: [{ id: "gpt-5.4" }]
    }]
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    codexCliEnv: codexCli.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const enabled = await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText,
        bindings: {
          defaultModel: "rc/gpt-5.4"
        }
      })
    });
    assert.equal(enabled.response.status, 200);

    const catalogPath = getCodexModelCatalogPath(codexCli.env);
    const codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.match(codexConfigText || "", /model = "rc\/gpt-5\.4"/);
    assert.ok(String(codexConfigText || "").includes(`model_catalog_json = "${catalogPath}"`));

    const catalog = await readJsonFileOrNull(catalogPath);
    assert.equal(Array.isArray(catalog?.models), true);
    assert.equal(catalog.models.some((entry) => entry?.slug === "rc/gpt-5.4"), true);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await codexCli.cleanup();
  }
});

test("web console supports Codex CLI inherit mode without writing router model mappings", async () => {
  const codexCli = await makeCodexCliEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    modelAliases: {
      "gpt-5.4": {
        id: "gpt-5.4",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      }
    }
  });
  await mkdir(path.dirname(getCodexConfigPath(codexCli.env)), { recursive: true });
  await writeFile(getCodexConfigPath(codexCli.env), 'model = "gpt-5.4"\n', "utf8");
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    codexCliEnv: codexCli.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const enabled = await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText,
        bindings: {
          defaultModel: CODEX_CLI_INHERIT_MODEL_VALUE
        }
      })
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.payload.codingTools.codexCli.bindings.defaultModel, CODEX_CLI_INHERIT_MODEL_VALUE);

    const codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.match(codexConfigText || "", /model_provider = "llm-router"/);
    assert.match(codexConfigText || "", /model = "gpt-5\.4"/);
    assert.doesNotMatch(codexConfigText || "", /model_catalog_json = /);
    assert.equal(await readTextFileOrNull(getCodexModelCatalogPath(codexCli.env)), null);

    const refreshed = await fetchJson(`${server.url}/api/state`);
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.payload.codingTools.codexCli.bindings.defaultModel, CODEX_CLI_INHERIT_MODEL_VALUE);
    assert.equal(refreshed.payload.codingTools.codexCli.inheritCliModel, true);
    assert.equal(refreshed.payload.codingTools.codexCli.configuredModel, "gpt-5.4");
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await codexCli.cleanup();
  }
});

test("web console treats Codex CLI as connected when the endpoint matches and still reflects live config file changes", async () => {
  const codexCli = await makeCodexCliEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    modelAliases: {
      "coding.default": {
        id: "coding.default",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      }
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    codexCliEnv: codexCli.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const enabled = await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });
    assert.equal(enabled.response.status, 200);

    const configPath = getCodexConfigPath(codexCli.env);
    const originalText = await readTextFileOrNull(configPath);
    const updatedText = String(originalText || "")
      .replace("gw_test_master_key_1234567890abcdefghijklmnop", "gw_replaced_secret_value")
      .replace(
        'model = "demo/gpt-4o-mini"',
        'model = "coding.default"\nmodel_reasoning_effort = "minimal"'
      );
    await writeFile(configPath, updatedText, "utf8");

    const refreshed = await fetchJson(`${server.url}/api/state`);
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.payload.codingTools.codexCli.routedViaRouter, true);
    assert.equal(refreshed.payload.codingTools.codexCli.bindings.defaultModel, "coding.default");
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await codexCli.cleanup();
  }
});

test("web console updates Codex CLI model bindings while routed through llm-router", async () => {
  const codexCli = await makeCodexCliEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    modelAliases: {
      "coding.default": {
        id: "coding.default",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      }
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    codexCliEnv: codexCli.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });

    const updated = await fetchJson(`${server.url}/api/codex-cli/model-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bindings: {
          defaultModel: "coding.default",
          thinkingLevel: "high"
        }
      })
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.codingTools.codexCli.bindings.defaultModel, "coding.default");
    assert.equal(updated.payload.codingTools.codexCli.bindings.thinkingLevel, "high");

    const codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.match(codexConfigText || "", /model = "coding.default"/);
    assert.match(codexConfigText || "", /model_reasoning_effort = "high"/);
    const catalog = await readJsonFileOrNull(getCodexModelCatalogPath(codexCli.env));
    assert.equal(catalog?.models?.some((entry) => entry?.slug === "coding.default"), true);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await codexCli.cleanup();
  }
});

test("web console restores Codex CLI built-in model control when switching to inherit mode and preserves later CLI model edits", async () => {
  const codexCli = await makeCodexCliEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    modelAliases: {
      "coding.default": {
        id: "coding.default",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      },
      "gpt-5.4": {
        id: "gpt-5.4",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      },
      "gpt-5.1-codex-mini": {
        id: "gpt-5.1-codex-mini",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      }
    }
  });
  await mkdir(path.dirname(getCodexConfigPath(codexCli.env)), { recursive: true });
  await writeFile(getCodexConfigPath(codexCli.env), 'model = "gpt-5.4"\n', "utf8");
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    codexCliEnv: codexCli.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText,
        bindings: {
          defaultModel: "coding.default"
        }
      })
    });

    let codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.match(codexConfigText || "", /model = "coding\.default"/);
    assert.match(codexConfigText || "", /model_catalog_json = /);

    const inheritMode = await fetchJson(`${server.url}/api/codex-cli/model-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bindings: {
          defaultModel: CODEX_CLI_INHERIT_MODEL_VALUE
        }
      })
    });
    assert.equal(inheritMode.response.status, 200);
    assert.equal(inheritMode.payload.codingTools.codexCli.bindings.defaultModel, CODEX_CLI_INHERIT_MODEL_VALUE);

    codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.match(codexConfigText || "", /model = "gpt-5\.4"/);
    assert.doesNotMatch(codexConfigText || "", /model_catalog_json = /);
    assert.equal(await readTextFileOrNull(getCodexModelCatalogPath(codexCli.env)), null);

    const liveUpdatedText = String(codexConfigText || "").replace('model = "gpt-5.4"', 'model = "gpt-5.1-codex-mini"');
    await writeFile(getCodexConfigPath(codexCli.env), liveUpdatedText, "utf8");

    const nextConfig = JSON.parse(initial.payload.config.rawText);
    nextConfig.providers[0].name = "Demo Updated";
    const saved = await fetchJson(`${server.url}/api/config/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: `${JSON.stringify(nextConfig, null, 2)}\n` })
    });
    assert.equal(saved.response.status, 200);

    codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.match(codexConfigText || "", /model = "gpt-5\.1-codex-mini"/);
    assert.doesNotMatch(codexConfigText || "", /model_catalog_json = /);

    const refreshed = await fetchJson(`${server.url}/api/state`);
    assert.equal(refreshed.payload.codingTools.codexCli.bindings.defaultModel, CODEX_CLI_INHERIT_MODEL_VALUE);
    assert.equal(refreshed.payload.codingTools.codexCli.configuredModel, "gpt-5.1-codex-mini");
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await codexCli.cleanup();
  }
});

test("web console syncs Codex CLI binding refs when saved config renames managed routes", async () => {
  const codexCli = await makeCodexCliEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    modelAliases: {
      smart: {
        id: "smart",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      }
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    codexCliEnv: codexCli.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText,
        bindings: {
          defaultModel: "demo/gpt-4o-mini"
        }
      })
    });

    const renamedModelConfig = JSON.parse(initial.payload.config.rawText);
    renamedModelConfig.providers[0].models = [{ id: "gpt-4.1-mini" }];
    renamedModelConfig.modelAliases.smart.targets = [{ ref: "demo/gpt-4.1-mini" }];

    const savedAfterModelRename = await fetchJson(`${server.url}/api/config/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: `${JSON.stringify(renamedModelConfig, null, 2)}\n` })
    });
    assert.equal(savedAfterModelRename.response.status, 200);

    let codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.match(codexConfigText || "", /model = "demo\/gpt-4\.1-mini"/);
    let catalog = await readJsonFileOrNull(getCodexModelCatalogPath(codexCli.env));
    assert.equal(catalog?.models?.some((entry) => entry?.slug === "demo/gpt-4.1-mini"), true);
    assert.equal(catalog?.models?.some((entry) => entry?.slug === "demo/gpt-4o-mini"), false);

    await fetchJson(`${server.url}/api/codex-cli/model-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bindings: {
          defaultModel: "smart"
        }
      })
    });

    const renamedAliasConfig = JSON.parse(savedAfterModelRename.payload.config.rawText);
    const renamedAlias = renamedAliasConfig.modelAliases.smart;
    delete renamedAliasConfig.modelAliases.smart;
    renamedAliasConfig.modelAliases["coding.default"] = {
      ...renamedAlias,
      id: "coding.default"
    };

    const savedAfterAliasRename = await fetchJson(`${server.url}/api/config/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: `${JSON.stringify(renamedAliasConfig, null, 2)}\n` })
    });
    assert.equal(savedAfterAliasRename.response.status, 200);

    codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.match(codexConfigText || "", /model = "coding\.default"/);

    catalog = await readJsonFileOrNull(getCodexModelCatalogPath(codexCli.env));
    assert.equal(catalog?.models?.some((entry) => entry?.slug === "coding.default"), true);
    assert.equal(catalog?.models?.some((entry) => entry?.slug === "smart"), false);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await codexCli.cleanup();
  }
});

test("web console updates Codex CLI routing when the gateway key changes", async () => {
  const codexCli = await makeCodexCliEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop"
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    codexCliEnv: codexCli.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const enabled = await fetchJson(`${server.url}/api/codex-cli/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });
    assert.equal(enabled.response.status, 200);

    const nextConfig = JSON.parse(enabled.payload.config.rawText);
    nextConfig.masterKey = "gw_rotated_master_key_abcdefghijklmnopqrstuvwxyz";

    const saved = await fetchJson(`${server.url}/api/config/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: `${JSON.stringify(nextConfig, null, 2)}\n` })
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.codingTools.codexCli.routedViaRouter, true);

    const codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.ok(String(codexConfigText || "").includes(`base_url = "http://${FIXED_LOCAL_ROUTER_HOST}:${FIXED_LOCAL_ROUTER_PORT}/openai/v1"`));
    assert.match(codexConfigText || "", /experimental_bearer_token = "gw_rotated_master_key_abcdefghijklmnopqrstuvwxyz"/);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await codexCli.cleanup();
  }
});

test("web console can open Claude Code config in detected editor", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const claudeCode = await makeClaudeCodeEnv();
  const opened = [];
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env,
    openFileInEditor: async (editorId, filePath) => {
      opened.push({ editorId, filePath });
    }
  });

  try {
    const openResponse = await fetchJson(`${server.url}/api/claude-code/config/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ editorId: "default" })
    });

    assert.equal(openResponse.response.status, 200);
    assert.deepEqual(opened, [{ editorId: "default", filePath: getClaudeSettingsPath(claudeCode.env) }]);
    assert.deepEqual(await readJsonFileOrNull(getClaudeSettingsPath(claudeCode.env)), {});
    assert.deepEqual(await readJsonFileOrNull(getToolBackupPath(getClaudeSettingsPath(claudeCode.env))), {});
  } finally {
    await server.close("test-cleanup");
    await claudeCode.cleanup();
    await fixture.cleanup();
  }
});

test("web console toggles Claude Code global routing and restores the prior config", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop"
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.payload.codingTools.claudeCode.routedViaRouter, false);

    const enabled = await fetchJson(`${server.url}/api/claude-code/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.payload.codingTools.claudeCode.routedViaRouter, true);

    const expectedBaseUrl = `http://${FIXED_LOCAL_ROUTER_HOST}:${FIXED_LOCAL_ROUTER_PORT}/anthropic`;
    const settings = await readJsonFileOrNull(getClaudeSettingsPath(claudeCode.env));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, expectedBaseUrl);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "gw_test_master_key_1234567890abcdefghijklmnop");
    assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(settings.env.ANTHROPIC_MODEL, undefined);

    const backup = await readJsonFileOrNull(getToolBackupPath(getClaudeSettingsPath(claudeCode.env)));
    assert.deepEqual(backup, {});

    const disabled = await fetchJson(`${server.url}/api/claude-code/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.payload.codingTools.claudeCode.routedViaRouter, false);
    assert.deepEqual(await readJsonFileOrNull(getClaudeSettingsPath(claudeCode.env)), {});
    assert.deepEqual(await readJsonFileOrNull(getToolBackupPath(getClaudeSettingsPath(claudeCode.env))), {});
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("web console treats Claude Code as connected when the endpoint matches and still reflects live settings changes", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    modelAliases: {
      "coding.default": {
        id: "coding.default",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      }
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const enabled = await fetchJson(`${server.url}/api/claude-code/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });
    assert.equal(enabled.response.status, 200);

    const settingsPath = getClaudeSettingsPath(claudeCode.env);
    const settings = await readJsonFileOrNull(settingsPath);
    settings.env.ANTHROPIC_AUTH_TOKEN = "gw_replaced_secret_value";
    settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "coding.default";
    settings.env.CLAUDE_CODE_EFFORT_LEVEL = "high";
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    const refreshed = await fetchJson(`${server.url}/api/state`);
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.payload.codingTools.claudeCode.routedViaRouter, true);
    assert.equal(refreshed.payload.codingTools.claudeCode.bindings.defaultOpusModel, "coding.default");
    assert.equal(refreshed.payload.codingTools.claudeCode.bindings.thinkingLevel, "high");
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("web console state exposes Claude Code web search provider selection", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    webSearch: {
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key"
        },
        {
          id: "demo/gpt-4o-mini",
          providerId: "demo",
          model: "gpt-4o-mini"
        }
      ]
    },
    claudeCode: {
      webSearchProvider: "demo/gpt-4o-mini"
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const state = await fetchJson(`${server.url}/api/state`);
    assert.equal(state.response.status, 200);
    assert.equal(state.payload.codingTools.claudeCode.webSearchProvider, "demo/gpt-4o-mini");
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("web console updates Claude Code web search provider selection", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    webSearch: {
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key"
        }
      ]
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const updated = await fetchJson(`${server.url}/api/claude-code/search-provider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rawText: initial.payload.config.rawText,
        webSearchProvider: "brave"
      })
    });

    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.codingTools.claudeCode.webSearchProvider, "brave");

    const config = await readJsonFileOrNull(fixture.configPath);
    assert.equal(config.claudeCode.webSearchProvider, "brave");
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("web console clears Claude Code web search provider selection", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    webSearch: {
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key"
        }
      ]
    },
    claudeCode: {
      webSearchProvider: "brave"
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const cleared = await fetchJson(`${server.url}/api/claude-code/search-provider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rawText: initial.payload.config.rawText,
        webSearchProvider: ""
      })
    });

    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.payload.codingTools.claudeCode.webSearchProvider, "");

    const config = await readJsonFileOrNull(fixture.configPath);
    assert.equal(config.claudeCode, undefined);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("web console rejects invalid Claude Code web search provider selection", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    webSearch: {
      providers: [
        {
          id: "brave",
          apiKey: "brave_test_key"
        }
      ]
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const invalid = await fetchJson(`${server.url}/api/claude-code/search-provider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rawText: initial.payload.config.rawText,
        webSearchProvider: "demo/gpt-4o-mini"
      })
    });

    assert.equal(invalid.response.status, 400);
    assert.equal(
      invalid.payload.error,
      "Claude Code web search provider 'demo/gpt-4o-mini' must reference a configured webSearch provider."
    );
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("web console restores deprecated Claude Code small/fast bindings from backup on disconnect", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop"
  });
  const originalSettings = {
    env: {
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_AUTH_TOKEN: "old_auth_token",
      ANTHROPIC_API_KEY: "old_api_key",
      ANTHROPIC_MODEL: "old/primary",
      ANTHROPIC_SMALL_FAST_MODEL: "old/small-fast",
      CLAUDE_CODE_SUBAGENT_MODEL: "old/subagent",
      CLAUDE_CODE_EFFORT_LEVEL: "low"
    }
  };
  await mkdir(path.dirname(getClaudeSettingsPath(claudeCode.env)), { recursive: true });
  await writeFile(getClaudeSettingsPath(claudeCode.env), `${JSON.stringify(originalSettings, null, 2)}\n`, "utf8");
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    assert.equal(initial.response.status, 200);

    const enabled = await fetchJson(`${server.url}/api/claude-code/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });
    assert.equal(enabled.response.status, 200);

    const routedSettings = await readJsonFileOrNull(getClaudeSettingsPath(claudeCode.env));
    assert.equal(routedSettings.env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
    assert.equal(routedSettings.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);

    const disabled = await fetchJson(`${server.url}/api/claude-code/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(disabled.response.status, 200);
    assert.deepEqual(await readJsonFileOrNull(getClaudeSettingsPath(claudeCode.env)), originalSettings);
    assert.deepEqual(await readJsonFileOrNull(getToolBackupPath(getClaudeSettingsPath(claudeCode.env))), {});
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("web console accepts xhigh Claude Code effort level updates", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop"
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const updated = await fetchJson(`${server.url}/api/claude-code/effort-level`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        effortLevel: "xhigh"
      })
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.codingTools.claudeCode.bindings.thinkingLevel, "xhigh");

    const settings = await readJsonFileOrNull(getClaudeSettingsPath(claudeCode.env));
    assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, "xhigh");
    assert.equal(settings.effortLevel, undefined);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("web console updates Claude Code model bindings while routed through llm-router", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    modelAliases: {
      "coding.default": {
        id: "coding.default",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      }
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    await fetchJson(`${server.url}/api/claude-code/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });

    const updated = await fetchJson(`${server.url}/api/claude-code/model-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bindings: {
          primaryModel: "coding.default",
          defaultOpusModel: "demo/gpt-4o-mini",
          defaultSonnetModel: "coding.default",
          defaultHaikuModel: "demo/gpt-4o-mini",
          subagentModel: "coding.default",
          thinkingLevel: "high"
        }
      })
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.codingTools.claudeCode.bindings.primaryModel, "coding.default");
    assert.equal(updated.payload.codingTools.claudeCode.bindings.defaultOpusModel, "demo/gpt-4o-mini");
    assert.equal(updated.payload.codingTools.claudeCode.bindings.defaultSonnetModel, "coding.default");
    assert.equal(updated.payload.codingTools.claudeCode.bindings.defaultHaikuModel, "demo/gpt-4o-mini");
    assert.equal(updated.payload.codingTools.claudeCode.bindings.subagentModel, "coding.default");
    assert.equal(updated.payload.codingTools.claudeCode.bindings.thinkingLevel, "high");

    const settings = await readJsonFileOrNull(getClaudeSettingsPath(claudeCode.env));
    assert.equal(settings.env.ANTHROPIC_MODEL, "coding.default");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "demo/gpt-4o-mini");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "coding.default");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "demo/gpt-4o-mini");
    assert.equal(settings.env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
    assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, "coding.default");
    assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, "high");
    assert.equal(settings.env.MAX_THINKING_TOKENS, undefined);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("web console syncs Claude Code binding refs when saved config renames managed routes", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    modelAliases: {
      smart: {
        id: "smart",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      }
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    await fetchJson(`${server.url}/api/claude-code/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText,
        bindings: {
          primaryModel: "smart",
          defaultOpusModel: "demo/gpt-4o-mini",
          defaultSonnetModel: "smart",
          defaultHaikuModel: "demo/gpt-4o-mini",
          subagentModel: "smart"
        }
      })
    });

    const renamedConfig = JSON.parse(initial.payload.config.rawText);
    renamedConfig.providers[0].models = [{ id: "gpt-4.1-mini" }];
    const renamedAlias = renamedConfig.modelAliases.smart;
    delete renamedConfig.modelAliases.smart;
    renamedConfig.modelAliases["coding.default"] = {
      ...renamedAlias,
      id: "coding.default",
      targets: [{ ref: "demo/gpt-4.1-mini" }]
    };

    const saved = await fetchJson(`${server.url}/api/config/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: `${JSON.stringify(renamedConfig, null, 2)}\n` })
    });
    assert.equal(saved.response.status, 200);

    const settings = await readJsonFileOrNull(getClaudeSettingsPath(claudeCode.env));
    assert.equal(settings.env.ANTHROPIC_MODEL, "coding.default");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "demo/gpt-4.1-mini");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "coding.default");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "demo/gpt-4.1-mini");
    assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, "coding.default");
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("web console can clear the Claude Code current model override while routed through llm-router", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop",
    modelAliases: {
      "coding.default": {
        id: "coding.default",
        strategy: "ordered",
        targets: [{ ref: "demo/gpt-4o-mini" }],
        fallbackTargets: []
      }
    }
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    await fetchJson(`${server.url}/api/claude-code/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });

    await fetchJson(`${server.url}/api/claude-code/model-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bindings: {
          primaryModel: "coding.default",
          defaultOpusModel: "demo/gpt-4o-mini",
          defaultSonnetModel: "",
          defaultHaikuModel: "",
          subagentModel: ""
        }
      })
    });

    const cleared = await fetchJson(`${server.url}/api/claude-code/model-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bindings: {
          primaryModel: "",
          defaultOpusModel: "demo/gpt-4o-mini",
          defaultSonnetModel: "",
          defaultHaikuModel: "",
          subagentModel: ""
        }
      })
    });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.payload.codingTools.claudeCode.bindings.primaryModel, "");

    const settings = await readJsonFileOrNull(getClaudeSettingsPath(claudeCode.env));
    assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "demo/gpt-4o-mini");
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("web console updates Claude Code routing when the gateway key changes", async () => {
  const claudeCode = await makeClaudeCodeEnv();
  const fixture = await makeTempConfig({
    ...createBaseConfig(),
    masterKey: "gw_test_master_key_1234567890abcdefghijklmnop"
  });
  const server = await startTestWebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    configPath: fixture.configPath
  }, {
    claudeCodeEnv: claudeCode.env
  });

  try {
    const initial = await fetchJson(`${server.url}/api/state`);
    const enabled = await fetchJson(`${server.url}/api/claude-code/global-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        rawText: initial.payload.config.rawText
      })
    });
    assert.equal(enabled.response.status, 200);

    const nextConfig = JSON.parse(enabled.payload.config.rawText);
    nextConfig.masterKey = "gw_rotated_master_key_abcdefghijklmnopqrstuvwxyz";

    const saved = await fetchJson(`${server.url}/api/config/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: `${JSON.stringify(nextConfig, null, 2)}\n` })
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.codingTools.claudeCode.routedViaRouter, true);

    const settings = await readJsonFileOrNull(getClaudeSettingsPath(claudeCode.env));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, `http://${FIXED_LOCAL_ROUTER_HOST}:${FIXED_LOCAL_ROUTER_PORT}/anthropic`);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "gw_rotated_master_key_abcdefghijklmnopqrstuvwxyz");
    assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
    await claudeCode.cleanup();
  }
});

test("POST /api/local-models/attach stores an attached llama.cpp model in config metadata", async () => {
  const fixture = await makeTempConfig({
    version: 2,
    providers: [],
    metadata: {
      localModels: {
        runtime: {},
        library: {},
        variants: {},
        capacity: {}
      }
    }
  });
  const server = await startTestWebConsoleServer({
    configPath: fixture.configPath,
    port: await getAvailablePort()
  });

  try {
    const attached = await fetchJson(`${server.url}/api/local-models/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "base-qwen",
        displayName: "Qwen External",
        filePath: "/Volumes/models/qwen.gguf"
      })
    });

    assert.equal(attached.response.status, 200);
    assert.equal(attached.payload.ok, true);
    assert.equal(attached.payload.library["base-qwen"].source, "llamacpp-attached");

    const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal(saved.metadata.localModels.library["base-qwen"].path, "/Volumes/models/qwen.gguf");
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("POST /api/local-models/search-huggingface returns shaped candidates with disabled reasons", async () => {
  const fixture = await makeTempConfig({ version: 2, providers: [] });
  const server = await startTestWebConsoleServer({
    configPath: fixture.configPath,
    port: await getAvailablePort()
  }, {
    searchHuggingFaceGgufCandidates: async () => ([
      {
        repo: "org/model",
        file: "model.Q5_K_M.gguf",
        sizeBytes: 24 * 1024 ** 3,
        disabled: false,
        disabledReason: "",
        fit: "safe",
        badges: ["GGUF", "llama.cpp", "Mac OK"]
      },
      {
        repo: "org/model",
        file: "model.safetensors",
        sizeBytes: 24 * 1024 ** 3,
        disabled: true,
        disabledReason: "Not a GGUF file",
        fit: "unsupported",
        badges: ["Mac review"]
      }
    ])
  });

  try {
    const searched = await fetchJson(`${server.url}/api/local-models/search-huggingface`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "qwen" })
    });

    assert.equal(searched.response.status, 200);
    assert.equal(searched.payload.results.length, 2);
    assert.equal(searched.payload.results[1].disabled, true);
    assert.match(searched.payload.results[1].disabledReason, /not a gguf file/i);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("POST /api/local-models/download-managed streams progress and registers the managed model", async () => {
  const fixture = await makeTempConfig({ version: 2, providers: [] });
  const server = await startTestWebConsoleServer({
    configPath: fixture.configPath,
    port: await getAvailablePort()
  }, {
    downloadManagedHuggingFaceGguf: async (request, { onProgress }) => {
      onProgress({ receivedBytes: 5, totalBytes: 10 });
      return {
        id: "base-qwen-managed",
        displayName: "Qwen Managed",
        filePath: path.join(fixture.dir, "managed", "qwen.Q5.gguf"),
        repo: request.repo,
        file: request.file,
        sizeBytes: 10
      };
    }
  });

  try {
    const streamed = await fetchJsonLines(`${server.url}/api/local-models/download-managed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "base-qwen-managed",
        displayName: "Qwen Managed",
        repo: "org/model",
        file: "qwen.Q5.gguf"
      })
    });

    assert.equal(streamed.response.status, 200);
    assert.equal(streamed.messages[0].type, "start");
    assert.equal(streamed.messages.some((message) => message.type === "progress"), true);
    const resultMessage = streamed.messages.find((message) => message.type === "result");
    assert.equal(resultMessage.result.library["base-qwen-managed"].source, "llamacpp-managed");

    const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal(saved.metadata.localModels.library["base-qwen-managed"].managed, true);
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});

test("POST /api/local-models/variants/save persists a local variant and returns it", async () => {
  const fixture = await makeTempConfig({
    version: 2,
    providers: [],
    metadata: {
      localModels: {
        library: {
          "base-qwen": {
            id: "base-qwen",
            source: "llamacpp-managed",
            path: "/tmp/qwen.gguf",
            metadata: { sizeBytes: 8 * 1024 ** 3 }
          }
        },
        variants: {}
      }
    }
  });
  const server = await startTestWebConsoleServer({
    configPath: fixture.configPath,
    port: await getAvailablePort()
  }, {
    getLocalModelSystemInfo: () => ({
      platform: "darwin",
      totalMemoryBytes: 64 * 1024 ** 3,
      unifiedMemory: true
    })
  });

  try {
    const saved = await fetchJson(`${server.url}/api/local-models/variants/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        variant: {
          key: "qwen-balanced",
          baseModelId: "base-qwen",
          id: "local/qwen-balanced",
          name: "Qwen Balanced",
          runtime: "llamacpp",
          enabled: true,
          preload: false,
          contextWindow: 65536
        }
      })
    });

    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.ok, true);
    assert.equal(saved.payload.variants["qwen-balanced"].id, "local/qwen-balanced");
    assert.equal(saved.payload.variants["qwen-balanced"].capacityState, "safe");
  } finally {
    await server.close("test-cleanup");
    await fixture.cleanup();
  }
});
