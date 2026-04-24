import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import { promises as fs } from "node:fs";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { readConfigFile, writeConfigFile } from "../src/node/config-store.js";
import { buildProviderFromConfigInput, applyConfigChanges } from "../src/node/config-workflows.js";
import {
  patchCodexCliConfigFile,
  unpatchCodexCliConfigFile
} from "../src/node/coding-tool-config.js";
import { CODEX_CLI_INHERIT_MODEL_VALUE } from "../src/shared/coding-tool-bindings.js";
import { startLocalRouteServer } from "../src/node/local-server.js";
import { startWebConsoleServer } from "../src/node/web-console-server.js";
import {
  callClaude,
  callOpenAI,
  createIsolatedWorkspace,
  getAvailablePort,
  loadLiveSuiteSettings,
  resolveModelRequestFormat,
  runCommandCapture,
  runNodeCli
} from "./helpers/live-suite.js";

const liveSuite = await loadLiveSuiteSettings();
const DEFAULT_REQUEST_HEADERS = { "content-type": "application/json" };

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

function pickOpenAIProvider(providers) {
  return providers.find((provider) => provider.openaiBaseUrl)
    || providers[0]
    || null;
}

function pickClaudeProvider(providers) {
  return providers.find((provider) => provider.claudeBaseUrl)
    || providers.find((provider) => provider.openaiBaseUrl && provider.models.some((model) => String(model?.id || "").toLowerCase().includes("claude")))
    || null;
}

function pickAmpProvider(providers) {
  return providers.find((provider) => provider.openaiBaseUrl && provider.claudeBaseUrl)
    || providers.find((provider) => provider.claudeBaseUrl)
    || providers.find((provider) => provider.openaiBaseUrl)
    || null;
}

function buildToolRoutingConfig(provider, {
  codexAlias = "",
  claudeAlias = "",
  ampDefaultRoute = ""
} = {}) {
  const rawModels = Array.isArray(provider?.models) ? provider.models : [];
  const modelId = String(rawModels[0]?.id || rawModels[0] || "").trim();
  assert.ok(provider?.id, "A live provider is required.");
  assert.ok(modelId, `Provider '${provider?.id || "unknown"}' must expose at least one model.`);

  const normalizedModels = rawModels.map((model) => {
    if (model && typeof model === "object" && !Array.isArray(model)) return model;
    const modelIdText = String(model || "").trim();
    return {
      id: modelIdText,
      formats: modelIdText.toLowerCase().includes("claude") ? ["claude"] : ["openai"]
    };
  }).filter((model) => String(model?.id || "").trim());

  const formats = [];
  if (provider.openaiBaseUrl) formats.push("openai");
  if (provider.claudeBaseUrl) formats.push("claude");
  const baseUrlByFormat = {};
  if (provider.openaiBaseUrl) baseUrlByFormat.openai = provider.openaiBaseUrl;
  if (provider.claudeBaseUrl) baseUrlByFormat.claude = provider.claudeBaseUrl;

  const routeRef = `${provider.id}/${modelId}`;
  const modelAliases = {};
  if (codexAlias) {
    modelAliases[codexAlias] = {
      id: codexAlias,
      strategy: "ordered",
      targets: [{ ref: routeRef }],
      fallbackTargets: []
    };
  }
  if (claudeAlias) {
    modelAliases[claudeAlias] = {
      id: claudeAlias,
      strategy: "ordered",
      targets: [{ ref: routeRef }],
      fallbackTargets: []
    };
  }
  if (ampDefaultRoute) {
    modelAliases[ampDefaultRoute] = {
      id: ampDefaultRoute,
      strategy: "ordered",
      targets: [{ ref: routeRef }],
      fallbackTargets: []
    };
  }

  return {
    version: 2,
    masterKey: "gw_live_suite_master_key_1234567890abcdefghijklmnop",
    defaultModel: codexAlias || claudeAlias || ampDefaultRoute || routeRef,
    providers: [{
      id: provider.id,
      name: provider.name || provider.id,
      apiKey: provider.apiKey,
      baseUrl: provider.openaiBaseUrl || provider.claudeBaseUrl || "",
      baseUrlByFormat,
      format: provider.claudeBaseUrl && !provider.openaiBaseUrl ? "claude" : "openai",
      formats,
      headers: provider.headers || {},
      models: normalizedModels
    }],
    modelAliases,
    amp: {
      preset: "builtin",
      restrictManagementToLocalhost: true,
      defaultRoute: ampDefaultRoute || codexAlias || claudeAlias || routeRef
    }
  };
}

async function readAmpUpstreamApiKey({ env = process.env, homeDir = os.homedir() } = {}) {
  const explicit = String(env.LLM_ROUTER_TEST_AMP_UPSTREAM_API_KEY || env.AMP_API_KEY || "").trim();
  if (explicit) return explicit;

  const dataHome = String(env.XDG_DATA_HOME || "").trim() || path.join(homeDir, ".local", "share");
  const secretsPath = path.join(dataHome, "amp", "secrets.json");

  try {
    const raw = await fs.readFile(secretsPath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const fromSecrets = String(
      parsed["apiKey@https://ampcode.com"]
      || parsed["apiKey@https://ampcode.com/"]
      || ""
    ).trim();
    if (fromSecrets) return fromSecrets;
  } catch {
  }

  try {
    const routerConfigPath = path.join(homeDir, ".llm-router.json");
    const raw = await fs.readFile(routerConfigPath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return String(parsed?.amp?.upstreamApiKey || "").trim();
  } catch {
    return "";
  }
}

function isAcceptableLiveToolFailure(output = "") {
  return /high demand|provider network error|fetch failed|overloaded|temporar(?:y|ily) unavailable|rate limit|unsupported value: 'low'|text\.verbosity|invalid schema for function|object schema missing properties/i.test(String(output || ""));
}

function isAcceptableAffirmativeReply(output = "") {
  const text = String(output || "").trim();
  if (!text) return false;
  return /\bok\b/i.test(text)
    || /^(yes|yeah|yep|sure|affirmative|okay|好的|好|可以)$/i.test(text);
}

async function configureAmpClientFiles({
  env,
  endpointUrl,
  apiKey
}) {
  const settingsPath = path.join(env.XDG_CONFIG_HOME, "amp", "settings.json");
  const secretsPath = path.join(env.XDG_DATA_HOME, "amp", "secrets.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.mkdir(path.dirname(secretsPath), { recursive: true });

  await fs.writeFile(settingsPath, `${JSON.stringify({
    "amp.url": endpointUrl,
    "amp.dangerouslyAllowAll": true,
    "amp.showCosts": false,
    "amp.updates.mode": "disabled"
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(secretsPath, `${JSON.stringify({
    [`apiKey@${endpointUrl}`]: apiKey
  }, null, 2)}\n`, "utf8");

  return {
    settingsPath,
    secretsPath
  };
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

test("real-provider flows cover CLI and Web UI", {
  timeout: Math.max(liveSuite.timeoutMs * 4, 360_000)
}, async (t) => {
  if (!liveSuite.enabled) {
    t.skip(liveSuite.reason);
    return;
  }

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

  await t.test("Codex CLI inherit-model routing works end-to-end against the live router", {
    timeout: Math.max(liveSuite.timeoutMs * 2, 180_000)
  }, async (t) => {
    const provider = pickOpenAIProvider(liveSuite.providers);
    if (!provider?.openaiBaseUrl) {
      t.skip("No OpenAI-compatible live provider configured for Codex CLI.");
      return;
    }

    const workspace = await createIsolatedWorkspace("llm-router-live-codex-");
    const env = workspace.buildEnv(liveSuite.envMap);
    const configPath = workspace.configPath;
    const port = await getAvailablePort();
    const baseUrl = `http://${liveSuite.host}:${port}`;
    let localServer = null;

    try {
      await writeConfigFile(buildToolRoutingConfig(provider, {
        codexAlias: "gpt-5.4",
        ampDefaultRoute: "amp-live"
      }), configPath);

      await fs.mkdir(path.join(env.CODEX_HOME || path.join(workspace.homeDir, ".codex")), { recursive: true });
      const seededCodexConfig = [
        'model = "gpt-5.4"',
        'model_reasoning_effort = "xhigh"'
      ].join("\n");
      await fs.writeFile(path.join(env.CODEX_HOME || path.join(workspace.homeDir, ".codex"), "config.toml"), `${seededCodexConfig}\n`, "utf8");

      localServer = await startLocalRouteServer({
        host: liveSuite.host,
        port,
        configPath,
        watchConfig: false
      });

      await patchCodexCliConfigFile({
        endpointUrl: baseUrl,
        apiKey: "gw_live_suite_master_key_1234567890abcdefghijklmnop",
        bindings: {
          defaultModel: CODEX_CLI_INHERIT_MODEL_VALUE,
          thinkingLevel: "xhigh"
        },
        env
      });

      const result = await runCommandCapture("codex", [
        "exec",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-C",
        workspace.cwd,
        "Reply with exactly OK"
      ], {
        cwd: workspace.cwd,
        env,
        label: "codex-live",
        timeoutMs: liveSuite.timeoutMs
      });

      assert.equal(result.timedOut, false, "Codex CLI timed out.");
      assert.doesNotMatch(result.stdout + result.stderr, /tools\[\d+\]\.name|missing_required_parameter/i);
      if (!result.ok) {
        assert.equal(
          isAcceptableLiveToolFailure(result.stdout + result.stderr),
          true,
          result.stderr || result.stdout || "Codex CLI failed."
        );
        return;
      }
      assert.match(result.stdout, /\bOK\b/i);
    } finally {
      await unpatchCodexCliConfigFile({ env }).catch(() => {});
      await localServer?.close();
      await workspace.cleanup();
    }
  });

  await t.test("Claude Code routes through the live router with an alias model", {
    timeout: Math.max(liveSuite.timeoutMs * 2, 180_000)
  }, async (t) => {
    const provider = pickClaudeProvider(liveSuite.providers);
    if (!provider?.claudeBaseUrl) {
      t.skip("No Anthropic-compatible live provider configured for Claude Code.");
      return;
    }

    const workspace = await createIsolatedWorkspace("llm-router-live-claude-");
    const env = workspace.buildEnv(liveSuite.envMap);
    const configPath = workspace.configPath;
    const port = await getAvailablePort();
    const baseUrl = `http://${liveSuite.host}:${port}`;
    let localServer = null;

    try {
      await writeConfigFile(buildToolRoutingConfig(provider, {
        claudeAlias: "default",
        ampDefaultRoute: "amp-live"
      }), configPath);

      localServer = await startLocalRouteServer({
        host: liveSuite.host,
        port,
        configPath,
        watchConfig: false
      });

      const claudeEnv = {
        ...env,
        ANTHROPIC_BASE_URL: `${baseUrl}/anthropic`,
        ANTHROPIC_AUTH_TOKEN: "gw_live_suite_master_key_1234567890abcdefghijklmnop",
        ANTHROPIC_MODEL: "default"
      };

      const result = await runCommandCapture("claude", [
        "-p",
        "--output-format",
        "json",
        "Reply with exactly OK"
      ], {
        cwd: workspace.cwd,
        env: claudeEnv,
        label: "claude-live",
        timeoutMs: liveSuite.timeoutMs
      });

      assert.equal(result.timedOut, false, "Claude Code timed out.");
      if (!result.ok) {
        assert.equal(
          isAcceptableLiveToolFailure(result.stdout + result.stderr),
          true,
          result.stderr || result.stdout || "Claude Code failed."
        );
        return;
      }
      const payload = JSON.parse(result.stdout.trim());
      assert.equal(
        isAcceptableAffirmativeReply(payload?.result || payload?.content?.[0]?.text || ""),
        true,
        `Unexpected Claude Code live reply: ${String(payload?.result || payload?.content?.[0]?.text || "")}`
      );
    } finally {
      await localServer?.close();
      await workspace.cleanup();
    }
  });

  await t.test("AMP execute mode routes through the live router", {
    timeout: Math.max(liveSuite.timeoutMs * 3, 240_000)
  }, async (t) => {
    const provider = pickAmpProvider(liveSuite.providers);
    if (!provider?.openaiBaseUrl && !provider?.claudeBaseUrl) {
      t.skip("No live provider configured for AMP routing.");
      return;
    }

    const upstreamApiKey = await readAmpUpstreamApiKey({ env: liveSuite.envMap });
    if (!upstreamApiKey) {
      t.skip("AMP upstream API key not found in env or local AMP secrets.");
      return;
    }

    const workspace = await createIsolatedWorkspace("llm-router-live-amp-");
    const env = workspace.buildEnv(liveSuite.envMap);
    const configPath = workspace.configPath;
    const port = await getAvailablePort();
    const baseUrl = `http://${liveSuite.host}:${port}`;
    let localServer = null;

    try {
      const config = buildToolRoutingConfig(provider, {
        codexAlias: "gpt-5.4",
        claudeAlias: "default",
        ampDefaultRoute: "amp-live"
      });
      config.amp.upstreamUrl = "https://ampcode.com";
      config.amp.upstreamApiKey = upstreamApiKey;
      await writeConfigFile(config, configPath);

      await configureAmpClientFiles({
        env,
        endpointUrl: baseUrl,
        apiKey: "gw_live_suite_master_key_1234567890abcdefghijklmnop"
      });

      localServer = await startLocalRouteServer({
        host: liveSuite.host,
        port,
        configPath,
        watchConfig: false
      });

      const result = await runCommandCapture("amp", [
        "--no-color",
        "--no-ide",
        "--no-jetbrains",
        "-x",
        "Reply with exactly OK",
        "-m",
        "smart"
      ], {
        cwd: workspace.cwd,
        env: {
          ...env,
          AMP_URL: baseUrl,
          AMP_API_KEY: "gw_live_suite_master_key_1234567890abcdefghijklmnop"
        },
        label: "amp-live",
        timeoutMs: Math.max(liveSuite.timeoutMs, 180_000)
      });

      assert.equal(result.timedOut, false, "AMP CLI timed out.");
      if (!result.ok) {
        assert.equal(
          isAcceptableLiveToolFailure(result.stdout + result.stderr),
          true,
          result.stderr || result.stdout || "AMP CLI failed."
        );
        return;
      }
      assert.match(result.stdout, /\bOK\b/i);
    } finally {
      await localServer?.close();
      await workspace.cleanup();
    }
  });
});
