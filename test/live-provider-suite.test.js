import assert from "node:assert/strict";
import { TextDecoder, TextEncoder } from "node:util";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import routerModule from "../src/cli/router-module.js";
import { readConfigFile, writeConfigFile } from "../src/node/config-store.js";
import { buildProviderFromConfigInput, applyConfigChanges } from "../src/node/config-workflows.js";
import { startLocalRouteServer } from "../src/node/local-server.js";
import { startWebConsoleServer } from "../src/node/web-console-server.js";
import {
  callClaude,
  callOpenAI,
  createIsolatedWorkspace,
  getAvailablePort,
  loadLiveSuiteSettings,
  resolveModelRequestFormat,
  runNodeCli
} from "./helpers/live-suite.js";

const liveSuite = await loadLiveSuiteSettings();
const configAction = routerModule.actions.find((entry) => entry.actionId === "config");
const DEFAULT_REQUEST_HEADERS = { "content-type": "application/json" };

function createConfigContext(args, overrides = {}) {
  return {
    args,
    mode: "commandline",
    terminal: {
      line() {},
      info() {},
      warn() {},
      error() {}
    },
    prompts: {},
    ...overrides
  };
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

async function parseJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function buildProviderUrlArgs(provider) {
  const args = [];
  if (provider.openaiBaseUrl) {
    args.push(`--openai-base-url=${provider.openaiBaseUrl}`);
  }
  if (provider.claudeBaseUrl) {
    args.push(`--claude-base-url=${provider.claudeBaseUrl}`);
  }
  if (!provider.openaiBaseUrl && !provider.claudeBaseUrl) {
    throw new Error(`Provider '${provider.id}' is missing endpoints.`);
  }
  return args;
}

function isAcceptableLiveProviderFailure(response) {
  const summary = `${response?.summary || ""} ${JSON.stringify(response?.body || {})}`.trim();
  return response?.status === 429
    || (response?.status === 503 && /model_not_found|No available channel/i.test(summary));
}

function assertLiveRouteResponse(response, label) {
  if (response?.ok) return;
  assert.equal(
    isAcceptableLiveProviderFailure(response),
    true,
    `${label}: status=${response?.status} summary=${response?.summary || ""}`
  );
}

async function runQualifiedModelRequest(baseUrl, provider, modelId, requestOptions) {
  const format = resolveModelRequestFormat(provider, modelId);
  const qualifiedModel = `${provider.id}/${modelId}`;
  return format === "claude"
    ? callClaude(baseUrl, qualifiedModel, requestOptions)
    : callOpenAI(baseUrl, qualifiedModel, requestOptions);
}

function pickTuiProvider(providers) {
  return providers.find((provider) => provider.openaiBaseUrl && provider.claudeBaseUrl) || providers[0];
}

function pickWebProvider(providers, excludeId = "") {
  return providers.find((provider) => provider.id !== excludeId && provider.openaiBaseUrl && provider.claudeBaseUrl)
    || providers.find((provider) => provider.id !== excludeId && provider.openaiBaseUrl)
    || providers.find((provider) => provider.id !== excludeId)
    || providers[0];
}

function pickInteractiveModels(provider) {
  if (!provider) return [];
  if (provider.openaiBaseUrl && provider.claudeBaseUrl && provider.models.length >= 2) {
    return provider.models.slice(0, 2);
  }
  return provider.models.slice(0, 1);
}

function createFetchBackedEventSource(window) {
  return class FetchBackedEventSource extends window.EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    constructor(url) {
      super();
      this.url = new URL(url, window.location.href).toString();
      this.readyState = FetchBackedEventSource.CONNECTING;
      this.withCredentials = false;
      this.onopen = null;
      this.onerror = null;
      this.onmessage = null;
      this.#controller = new AbortController();
      this.#pump();
    }

    #controller;

    async #pump() {
      try {
        const response = await fetch(this.url, {
          headers: { Accept: "text/event-stream" },
          signal: this.#controller.signal
        });
        this.readyState = FetchBackedEventSource.OPEN;
        this.#emitSimple("open");

        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          if (this.readyState === FetchBackedEventSource.CLOSED) break;
          buffer += decoder.decode(chunk, { stream: true });
          while (buffer.includes("\n\n")) {
            const separatorIndex = buffer.indexOf("\n\n");
            const rawEvent = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);

            let eventName = "message";
            const dataLines = [];
            for (const line of rawEvent.split("\n")) {
              if (!line || line.startsWith(":")) continue;
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }

            const event = new window.MessageEvent(eventName, {
              data: dataLines.join("\n"),
              origin: window.location.origin
            });
            this.dispatchEvent(event);
            if (eventName === "message" && typeof this.onmessage === "function") {
              this.onmessage(event);
            }
          }
        }
      } catch (error) {
        if (this.readyState === FetchBackedEventSource.CLOSED) return;
        this.#emitError(error);
      }
    }

    #emitSimple(type) {
      const event = new window.Event(type);
      this.dispatchEvent(event);
      if (type === "open" && typeof this.onopen === "function") this.onopen(event);
    }

    #emitError(error) {
      this.readyState = FetchBackedEventSource.CLOSED;
      const event = new window.Event("error");
      event.error = error;
      this.dispatchEvent(event);
      if (typeof this.onerror === "function") this.onerror(event);
    }

    close() {
      this.readyState = FetchBackedEventSource.CLOSED;
      this.#controller.abort();
    }
  };
}

async function waitForDomText(dom, text, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const bodyText = dom.window.document.body?.textContent || "";
    if (bodyText.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for DOM text: ${text}`);
}

async function waitForDomTextAny(dom, texts, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const bodyText = dom.window.document.body?.textContent || "";
    if (texts.some((text) => bodyText.includes(text))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for DOM text: ${texts.join(" | ")}`);
}

async function loadWebConsoleDom(baseUrl) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (String(error?.message || "").includes("Could not parse CSS stylesheet")) return;
    console.error(error);
  });
  const dom = await JSDOM.fromURL(baseUrl, {
    resources: "usable",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (input, init) => {
        if (typeof input === "string" || input instanceof URL) {
          return globalThis.fetch(new URL(String(input), window.location.href), init);
        }
        if (input instanceof window.Request) {
          return globalThis.fetch(new URL(input.url, window.location.href), init);
        }
        return globalThis.fetch(input, init);
      };
      window.Headers = globalThis.Headers;
      window.Request = globalThis.Request;
      window.Response = globalThis.Response;
      window.AbortController = globalThis.AbortController;
      window.AbortSignal = globalThis.AbortSignal;
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      if (!window.crypto?.getRandomValues) {
        Object.defineProperty(window, "crypto", {
          configurable: true,
          value: globalThis.crypto
        });
      }
      if (typeof window.structuredClone !== "function") {
        window.structuredClone = globalThis.structuredClone;
      }
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
      window.EventSource = createFetchBackedEventSource(window);
    }
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for document load.")), 15_000);
    dom.window.addEventListener("load", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });

  return dom;
}

test("real-provider flows cover CLI, TUI, and Web UI", {
  timeout: Math.max(liveSuite.timeoutMs * 4, 360_000)
}, async (t) => {
  if (!liveSuite.enabled) {
    t.skip(liveSuite.reason);
    return;
  }

  assert.ok(configAction, "config action should exist");

  await t.test("CLI flow configures real providers and routes live requests", {
    timeout: Math.max(liveSuite.timeoutMs * 2, 180_000)
  }, async () => {
    const workspace = await createIsolatedWorkspace("llm-router-live-cli-");
    const env = workspace.buildEnv(liveSuite.envMap);
    const configPath = workspace.configPath;
    const port = await getAvailablePort();
    const baseUrl = `http://${liveSuite.host}:${port}`;
    let localServer = null;

    try {
      await writeConfigFile({ version: 2, providers: [], modelAliases: {} }, configPath);

      for (const provider of liveSuite.providers) {
        const result = await runNodeCli([
          "config",
          `--config=${configPath}`,
          "--operation=upsert-provider",
          `--provider-id=${provider.id}`,
          `--name=${provider.name}`,
          `--api-key=${provider.apiKey}`,
          `--models=${provider.models.join(",")}`,
          "--skip-probe=true",
          ...buildProviderUrlArgs(provider)
        ], {
          cwd: workspace.cwd,
          env,
          label: `cli:${provider.id}`,
          redactions: [provider.apiKey]
        });

        assert.equal(result.ok, true, result.stderr || result.stdout || `CLI config failed for ${provider.id}`);
      }

      const savedConfig = await readConfigFile(configPath);
      assert.equal(savedConfig.providers.length, liveSuite.providers.length);

      localServer = await startLocalRouteServer({
        host: liveSuite.host,
        port,
        configPath,
        watchConfig: false
      });

      const requests = [];
      for (const provider of savedConfig.providers) {
        for (const model of provider.models || []) {
          requests.push({
            provider,
            modelId: model.id
          });
        }
      }

      let successCount = 0;
      for (const request of requests) {
        const response = await runQualifiedModelRequest(baseUrl, request.provider, request.modelId, {
          requestText: liveSuite.requestText,
          maxTokens: liveSuite.maxTokens,
          timeoutMs: liveSuite.timeoutMs
        });

        if (response.ok) {
          successCount += 1;
          continue;
        }

        assertLiveRouteResponse(
          response,
          `CLI route request failed for ${request.provider.id}/${request.modelId}`
        );
      }

      assert.equal(successCount > 0, true, "CLI flow should return at least one successful routed response.");
    } finally {
      await localServer?.close();
      await workspace.cleanup();
    }
  });

  await t.test("TUI flow probes a real provider and saves a working config", {
    timeout: Math.max(liveSuite.timeoutMs * 2, 180_000)
  }, async () => {
    const provider = pickTuiProvider(liveSuite.providers);
    const interactiveModels = pickInteractiveModels(provider);
    const workspace = await createIsolatedWorkspace("llm-router-live-tui-");
    const configPath = workspace.configPath;
    const port = await getAvailablePort();
    const baseUrl = `http://${liveSuite.host}:${port}`;
    const prompts = createQueuedPrompts([
      { type: "select", value: "models" },
      { type: "select", value: provider.id },
      { type: "text", value: interactiveModels.join(",") },
      { type: "cancel" },
      { type: "cancel" }
    ]);
    let localServer = null;

    try {
      await writeConfigFile({
        version: 2,
        providers: [{
          id: provider.id,
          name: `${provider.name} TUI`,
          apiKey: provider.apiKey,
          baseUrl: provider.openaiBaseUrl || provider.claudeBaseUrl,
          baseUrlByFormat: {
            ...(provider.openaiBaseUrl ? { openai: provider.openaiBaseUrl } : {}),
            ...(provider.claudeBaseUrl ? { claude: provider.claudeBaseUrl } : {})
          },
          format: provider.openaiBaseUrl ? "openai" : "claude",
          formats: [provider.openaiBaseUrl ? "openai" : "", provider.claudeBaseUrl ? "claude" : ""].filter(Boolean),
          headers: provider.headers,
          models: []
        }],
        modelAliases: {}
      }, configPath);

      const result = await configAction.run(createConfigContext({
        config: configPath
      }, {
        forcePrompt: true,
        prompts
      }));

      assert.equal(result.ok, true, String(result.errorMessage || result.data || ""));
      assert.deepEqual(prompts.remaining(), []);

      const savedConfig = await readConfigFile(configPath);
      const savedProvider = savedConfig.providers.find((entry) => entry.id === provider.id);
      assert.ok(savedProvider, "TUI should persist the provider");
      assert.equal(savedProvider.models.length > 0, true);

      localServer = await startLocalRouteServer({
        host: liveSuite.host,
        port,
        configPath,
        watchConfig: false
      });

      const response = await runQualifiedModelRequest(baseUrl, savedProvider, savedProvider.models[0].id, {
        requestText: liveSuite.requestText,
        maxTokens: liveSuite.maxTokens,
        timeoutMs: liveSuite.timeoutMs
      });
      assertLiveRouteResponse(
        response,
        `TUI-configured route request failed for ${savedProvider.id}/${savedProvider.models[0].id}`
      );
    } finally {
      await localServer?.close();
      await workspace.cleanup();
    }
  });

  await t.test("Web console uses live provider discovery/test endpoints and renders the bundle", {
    timeout: Math.max(liveSuite.timeoutMs * 2, 180_000)
  }, async () => {
    const provider = pickWebProvider(liveSuite.providers);
    const interactiveModels = pickInteractiveModels(provider);
    const workspace = await createIsolatedWorkspace("llm-router-live-web-");
    const configPath = workspace.configPath;
    const webPort = await getAvailablePort();
    const routePort = await getAvailablePort();
    let webServer = null;
    let routeServer = null;
    let dom = null;

    try {
      await writeConfigFile({ version: 2, providers: [], modelAliases: {} }, configPath);

      webServer = await startWebConsoleServer({
        host: liveSuite.host,
        port: webPort,
        configPath
      });

      const discoverResponse = await fetch(`${webServer.url}/api/config/discover-provider-models`, {
        method: "POST",
        headers: DEFAULT_REQUEST_HEADERS,
        body: JSON.stringify({
          endpoints: [provider.openaiBaseUrl, provider.claudeBaseUrl].filter(Boolean),
          apiKey: provider.apiKey,
          headers: provider.headers
        })
      });
      assert.equal(discoverResponse.status, 200);
      const discoveredPayload = await parseJsonResponse(discoverResponse);
      assert.ok(
        (discoveredPayload?.result?.models || []).length > 0 || (discoveredPayload?.result?.workingFormats || []).length > 0,
        "Web discovery should return models or detected formats"
      );

      const streamResponse = await fetch(`${webServer.url}/api/config/test-provider-stream`, {
        method: "POST",
        headers: DEFAULT_REQUEST_HEADERS,
        body: JSON.stringify({
          endpoints: [provider.openaiBaseUrl, provider.claudeBaseUrl].filter(Boolean),
          models: interactiveModels,
          apiKey: provider.apiKey,
          headers: provider.headers
        })
      });
      assert.equal(streamResponse.status, 200);
      const streamText = await streamResponse.text();
      const streamEntries = streamText.trim().split(/\n+/).map((line) => JSON.parse(line));
      const finalResult = streamEntries.at(-1)?.result;
      assert.equal(streamEntries[0]?.type, "start");
      assert.equal(finalResult?.ok, true, `Web provider test failed: ${JSON.stringify(finalResult)}`);

      const builtProvider = buildProviderFromConfigInput({
        providerId: `${provider.id}-web`,
        name: `${provider.name} Web`,
        apiKey: provider.apiKey,
        openaiBaseUrl: provider.openaiBaseUrl,
        claudeBaseUrl: provider.claudeBaseUrl,
        models: interactiveModels.join(","),
        headers: provider.headers,
        probe: finalResult
      });
      const nextConfig = applyConfigChanges({ version: 2, providers: [], modelAliases: {} }, {
        provider: builtProvider
      });
      const saveResponse = await fetch(`${webServer.url}/api/config/save`, {
        method: "POST",
        headers: DEFAULT_REQUEST_HEADERS,
        body: JSON.stringify({
          rawText: `${JSON.stringify(nextConfig, null, 2)}\n`
        })
      });
      assert.equal(saveResponse.status, 200);

      const probeResponse = await fetch(`${webServer.url}/api/provider/probe`, {
        method: "POST",
        headers: DEFAULT_REQUEST_HEADERS,
        body: JSON.stringify({
          providerId: builtProvider.id
        })
      });
      assert.equal(probeResponse.status, 200);
      const probePayload = await parseJsonResponse(probeResponse);
      assert.equal(probePayload?.result?.ok, true, `Web provider probe failed: ${JSON.stringify(probePayload?.result)}`);

      dom = await loadWebConsoleDom(webServer.url);
      await waitForDomTextAny(dom, ["LLM Router Web Console", "Quick start wizard", "Add provider"], 20_000);

      routeServer = await startLocalRouteServer({
        host: liveSuite.host,
        port: routePort,
        configPath,
        watchConfig: false
      });
      const routeBaseUrl = `http://${liveSuite.host}:${routePort}`;
      const response = await runQualifiedModelRequest(routeBaseUrl, builtProvider, builtProvider.models[0].id, {
        requestText: liveSuite.requestText,
        maxTokens: liveSuite.maxTokens,
        timeoutMs: liveSuite.timeoutMs
      });
      assertLiveRouteResponse(
        response,
        `Web-configured route request failed for ${builtProvider.id}/${builtProvider.models[0].id}`
      );
    } finally {
      dom?.window.close();
      await routeServer?.close();
      await webServer?.close("test-cleanup");
      await workspace.cleanup();
    }
  });
});
