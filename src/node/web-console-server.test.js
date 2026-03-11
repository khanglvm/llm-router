import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { detectAvailableEditors, startWebConsoleServer } from "./web-console-server.js";
import { FIXED_LOCAL_ROUTER_HOST, FIXED_LOCAL_ROUTER_PORT } from "./local-server-settings.js";

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
  return `${filePath}.llm_router_backup`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  return { response, payload };
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
    assert.match(payload.startup.label, /startup|launchagent|systemd/i);
    assert.equal(Array.isArray(payload.logs), true);
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
    assert.equal(reclaimed.payload.router.running, false);
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
      .replace('model = "demo/gpt-4o-mini"', 'model = "coding.default"');
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
          defaultModel: "coding.default"
        }
      })
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.codingTools.codexCli.bindings.defaultModel, "coding.default");

    const codexConfigText = await readTextFileOrNull(getCodexConfigPath(codexCli.env));
    assert.match(codexConfigText || "", /model = "coding.default"/);
    const catalog = await readJsonFileOrNull(getCodexModelCatalogPath(codexCli.env));
    assert.equal(catalog?.models?.some((entry) => entry?.slug === "coding.default"), true);
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
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    const refreshed = await fetchJson(`${server.url}/api/state`);
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.payload.codingTools.claudeCode.routedViaRouter, true);
    assert.equal(refreshed.payload.codingTools.claudeCode.bindings.defaultOpusModel, "coding.default");
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
      CLAUDE_CODE_SUBAGENT_MODEL: "old/subagent"
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
          subagentModel: "coding.default"
        }
      })
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.codingTools.claudeCode.bindings.primaryModel, "coding.default");
    assert.equal(updated.payload.codingTools.claudeCode.bindings.defaultOpusModel, "demo/gpt-4o-mini");
    assert.equal(updated.payload.codingTools.claudeCode.bindings.defaultSonnetModel, "coding.default");
    assert.equal(updated.payload.codingTools.claudeCode.bindings.defaultHaikuModel, "demo/gpt-4o-mini");
    assert.equal(updated.payload.codingTools.claudeCode.bindings.subagentModel, "coding.default");

    const settings = await readJsonFileOrNull(getClaudeSettingsPath(claudeCode.env));
    assert.equal(settings.env.ANTHROPIC_MODEL, "coding.default");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "demo/gpt-4o-mini");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "coding.default");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "demo/gpt-4o-mini");
    assert.equal(settings.env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
    assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, "coding.default");
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
