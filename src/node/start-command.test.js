import test from "node:test";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { runStartCommand } from "./start-command.js";
import { parseFuserPidList, parsePidList, reclaimPort, stopStartupManagedListener } from "./port-reclaim.js";
import { LOCAL_ROUTER_HOST, LOCAL_ROUTER_PORT } from "../shared/local-router-defaults.js";

async function makeTempConfig(contents) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-start-"));
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

async function makeTempConfigText(rawText) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-start-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, rawText, "utf8");
  return {
    dir,
    configPath,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    }
  };
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
    ...createBaseConfig()
  };
}

test("parsePidList returns unique positive integer tokens only", () => {
  assert.deepEqual(
    parsePidList("123\n456 123 abc -1 0"),
    [123, 456]
  );
});

test("parseFuserPidList strips repeated port prefixes and returns unique listener pids", () => {
  assert.deepEqual(
    parseFuserPidList("8787/tcp: 1201 1202\n8787/tcp: 1202 1203"),
    [1201, 1202, 1203]
  );
  assert.deepEqual(
    parseFuserPidList("8787/tcp: 1201 1202\n"),
    [1201, 1202]
  );
  assert.deepEqual(
    parseFuserPidList("8787/tcp:\n"),
    []
  );
});

test("stopStartupManagedListener stops startup-managed runtime before reclaim", async () => {
  const lines = [];
  const result = await stopStartupManagedListener({
    port: LOCAL_ROUTER_PORT,
    line: (message) => lines.push(message),
    error: () => {}
  }, {
    getActiveRuntimeState: async () => ({ managedByStartup: true, port: LOCAL_ROUTER_PORT }),
    stopStartup: async () => {},
    clearRuntimeState: async () => {}
  });

  assert.deepEqual(result, { ok: true, attempted: true });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Stopping the startup service before reclaim/);
});

test("stopStartupManagedListener ignores startup-managed status when reclaiming a non-fixed port", async () => {
  const lines = [];
  let startupStatusCalls = 0;

  const result = await stopStartupManagedListener({
    port: LOCAL_ROUTER_PORT + 1,
    line: (message) => lines.push(message),
    error: () => {}
  }, {
    getActiveRuntimeState: async () => null,
    startupStatus: async () => {
      startupStatusCalls += 1;
      return { running: true };
    },
    stopStartup: async () => {
      throw new Error("stopStartup should not run for a non-fixed port");
    }
  });

  assert.deepEqual(result, { ok: true, attempted: false });
  assert.equal(startupStatusCalls, 0);
  assert.deepEqual(lines, []);
});

test("reclaimPort short-circuits when startup-managed stop fails", async () => {
  const calls = [];
  const result = await reclaimPort({
    port: LOCAL_ROUTER_PORT,
    line: () => {},
    error: () => {}
  }, {
    stopStartupManagedListener: async () => {
      calls.push("stop");
      return { ok: false, errorMessage: "startup stop failed" };
    },
    listListeningPids: () => {
      calls.push("probe");
      return { ok: true, pids: [9999] };
    }
  });

  assert.deepEqual(calls, ["stop"]);
  assert.deepEqual(result, { ok: false, errorMessage: "startup stop failed" });
});

test("reclaimPort escalates from SIGTERM to SIGKILL when listener remains", async () => {
  const lines = [];
  const kills = [];
  const waitCalls = [];
  let listCalls = 0;

  const result = await reclaimPort({
    port: LOCAL_ROUTER_PORT,
    line: (message) => lines.push(message),
    error: () => {}
  }, {
    selfPid: 10,
    stopStartupManagedListener: async () => ({ ok: true, attempted: false }),
    listListeningPids: () => {
      listCalls += 1;
      if (listCalls === 1) return { ok: true, pids: [10, 1201, 1202] };
      return { ok: true, pids: [10, 1202] };
    },
    waitForPortToRelease: async (_port, timeoutMs) => {
      waitCalls.push(timeoutMs);
      return waitCalls.length > 1;
    },
    kill: (pid, signal) => {
      kills.push({ pid, signal });
    }
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(waitCalls, [3000, 2000]);
  assert.deepEqual(kills, [
    { pid: 1201, signal: "SIGTERM" },
    { pid: 1202, signal: "SIGTERM" },
    { pid: 1202, signal: "SIGKILL" }
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Stopping existing listener/);
  assert.match(lines[1], /Force killing listener/);
});

test("reclaimPort waits for startup-managed port release when no external pid is detected", async () => {
  const lines = [];
  const waitCalls = [];

  const result = await reclaimPort({
    port: LOCAL_ROUTER_PORT,
    line: (message) => lines.push(message),
    error: () => {}
  }, {
    selfPid: 4242,
    stopStartupManagedListener: async () => ({ ok: true, attempted: true }),
    listListeningPids: () => ({ ok: true, pids: [4242] }),
    waitForPortToRelease: async (_port, timeoutMs) => {
      waitCalls.push(timeoutMs);
      return true;
    }
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(waitCalls, [4000]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`Waiting for port ${LOCAL_ROUTER_PORT} to release`));
});

test("runStartCommand reports a missing config file with setup guidance", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-start-"));
  const configPath = path.join(dir, "missing.json");

  try {
    const result = await runStartCommand({ configPath });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.errorMessage || "", /Config file not found/);
    assert.match(result.errorMessage || "", /Run 'llr config'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runStartCommand reports invalid JSON config load errors", async () => {
  const fixture = await makeTempConfigText("{\n");

  try {
    const result = await runStartCommand({ configPath: fixture.configPath });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.errorMessage || "", /Failed to load config from/);
    assert.match(result.errorMessage || "", new RegExp(fixture.configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await fixture.cleanup();
  }
});

test("runStartCommand hands off to installed startup service instead of starting inline", async () => {
  const fixture = await makeTempConfig(createBaseConfig());
  const lines = [];
  const errors = [];
  const installCalls = [];
  const stopCalls = [];
  let activeRuntime = {
    pid: 4321,
    host: LOCAL_ROUTER_HOST,
    port: LOCAL_ROUTER_PORT,
    configPath: fixture.configPath,
    watchConfig: true,
    watchBinary: true,
    requireAuth: false,
    managedByStartup: false,
    cliPath: process.argv[1] || "",
    startedAt: new Date().toISOString(),
    version: "test"
  };

  try {
    const result = await runStartCommand({
      configPath: fixture.configPath,
      host: LOCAL_ROUTER_HOST,
      port: LOCAL_ROUTER_PORT,
      watchConfig: true,
      watchBinary: true,
      requireAuth: false,
      onLine: (message) => lines.push(message),
      onError: (message) => errors.push(message),
      startupStatus: async () => ({
        manager: "launchd",
        serviceId: "dev.llm-router",
        installed: true,
        running: false,
        detail: "Startup service is installed but not currently loaded."
      }),
      getActiveRuntimeState: async () => activeRuntime,
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
        return true;
      },
      reclaimPort: async () => ({ ok: true }),
      installStartup: async (options) => {
        installCalls.push(options);
        activeRuntime = {
          pid: 5432,
          host: options.host,
          port: options.port,
          configPath: options.configPath,
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
      waitForRuntimeMatch: async () => activeRuntime,
      startLocalRouteServer: async () => {
        throw new Error("inline start should not run when startup is installed");
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.data || "", /Startup-managed LLM Router is active/);
    assert.deepEqual(stopCalls, [4321]);
    assert.equal(installCalls.length, 1);
    assert.equal(installCalls[0].configPath, fixture.configPath);
    assert.equal(installCalls[0].port, LOCAL_ROUTER_PORT);
    assert.deepEqual(errors, []);
    assert.equal(lines.some((message) => /Stopped manual LLM Router/.test(message)), true);
  } finally {
    await fixture.cleanup();
  }
});

test("runStartCommand auto-migrates legacy config before startup handoff", async () => {
  const fixture = await makeTempConfig(createLegacyV1Config());
  const lines = [];
  let activeRuntime = null;

  try {
    const result = await runStartCommand({
      configPath: fixture.configPath,
      onLine: (message) => lines.push(message),
      onError: (message) => {
        throw new Error(`unexpected startup error: ${message}`);
      },
      startupStatus: async () => ({
        manager: "launchd",
        serviceId: "dev.llm-router",
        installed: true,
        running: false,
        detail: "Startup service is installed but not currently loaded."
      }),
      getActiveRuntimeState: async () => activeRuntime,
      stopProcessByPid: async () => ({ ok: true, signal: "SIGTERM" }),
      clearRuntimeState: async () => true,
      reclaimPort: async () => ({ ok: true }),
      installStartup: async (options) => {
        activeRuntime = {
          pid: 6543,
          host: options.host,
          port: options.port,
          configPath: options.configPath,
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
      waitForRuntimeMatch: async () => activeRuntime,
      startLocalRouteServer: async () => {
        throw new Error("inline start should not run when startup is installed");
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(lines[0] || "", /Config auto-migrated from v1 to v2/i);

    const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal(saved.version, 2);
    assert.deepEqual(Object.keys(saved.modelAliases || {}), ["default"]);
  } finally {
    await fixture.cleanup();
  }
});

test("runStartCommand continues with an in-memory migrated config when the legacy file is read-only", async () => {
  const fixture = await makeTempConfig(createLegacyV1Config());
  const lines = [];
  const errors = [];
  let activeRuntime = null;
  await writeFile(fixture.configPath, `${JSON.stringify(createLegacyV1Config(), null, 2)}\n`, "utf8");
  await chmod(fixture.configPath, 0o400);

  try {
    const result = await runStartCommand({
      configPath: fixture.configPath,
      onLine: (message) => lines.push(message),
      onError: (message) => errors.push(message),
      startupStatus: async () => ({
        manager: "launchd",
        serviceId: "dev.llm-router",
        installed: true,
        running: false,
        detail: "Startup service is installed but not currently loaded."
      }),
      getActiveRuntimeState: async () => activeRuntime,
      stopProcessByPid: async () => ({ ok: true, signal: "SIGTERM" }),
      clearRuntimeState: async () => true,
      reclaimPort: async () => ({ ok: true }),
      installStartup: async (options) => {
        activeRuntime = {
          pid: 7654,
          host: options.host,
          port: options.port,
          configPath: options.configPath,
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
      waitForRuntimeMatch: async () => activeRuntime,
      startLocalRouteServer: async () => {
        throw new Error("inline start should not run when startup is installed");
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(lines.some((message) => /Config auto-migrated from v1 to v2/.test(message)), false);
    assert.equal(errors.some((message) => /could not be saved/.test(message)), true);

    const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal(saved.version, 1);
  } finally {
    await chmod(fixture.configPath, 0o600).catch(() => {});
    await fixture.cleanup();
  }
});
