import test from "node:test";
import assert from "node:assert/strict";
import { runUpgradeCommand } from "./upgrade-command.js";

const PKG_NAME = "@khanglvm/llm-router";

test("runUpgradeCommand keeps the active router online and requests a graceful reload", async () => {
  const lines = [];
  const errors = [];
  const execCalls = [];
  const signalCalls = [];

  const result = await runUpgradeCommand({
    onLine: (message) => lines.push(message),
    onError: (message) => errors.push(message)
  }, {
    readInstalledVersion: () => "2.3.6",
    fetchLatestVersion: () => "2.3.7",
    detectPackageManager: () => "npm",
    getActiveRuntimeState: async () => ({
      pid: 4321,
      host: "127.0.0.1",
      port: 8376,
      watchBinary: false
    }),
    exec: (command, options) => {
      execCalls.push({ command, options });
      return "";
    },
    signalProcess: (pid, signal) => {
      signalCalls.push({ pid, signal });
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(execCalls.map((entry) => entry.command), [`npm install -g ${PKG_NAME}@latest`]);
  assert.deepEqual(signalCalls, [{ pid: 4321, signal: "SIGUSR2" }]);
  assert.match(lines.join("\n"), /keep serving current requests while the package upgrade runs/i);
  assert.match(lines.join("\n"), /requested a graceful router reload/i);
  assert.deepEqual(errors, []);
});

test("runUpgradeCommand leaves the running router untouched when install fails", async () => {
  const lines = [];
  const errors = [];
  const signalCalls = [];

  const result = await runUpgradeCommand({
    onLine: (message) => lines.push(message),
    onError: (message) => errors.push(message)
  }, {
    readInstalledVersion: () => "2.3.6",
    fetchLatestVersion: () => "2.3.7",
    detectPackageManager: () => "pnpm",
    getActiveRuntimeState: async () => ({
      pid: 9001,
      host: "127.0.0.1",
      port: 8376,
      watchBinary: true
    }),
    exec: () => {
      throw new Error("install failed");
    },
    signalProcess: (pid, signal) => {
      signalCalls.push({ pid, signal });
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(errors.join("\n"), /running router was left untouched/i);
  assert.deepEqual(signalCalls, []);
  assert.match(lines.join("\n"), /running router detected/i);
});

test("runUpgradeCommand falls back to the binary watcher when the graceful reload signal fails", async () => {
  const lines = [];
  const errors = [];

  const result = await runUpgradeCommand({
    onLine: (message) => lines.push(message),
    onError: (message) => errors.push(message)
  }, {
    readInstalledVersion: () => "2.3.6",
    fetchLatestVersion: () => "2.3.7",
    detectPackageManager: () => "npm",
    getActiveRuntimeState: async () => ({
      pid: 2468,
      host: "127.0.0.1",
      port: 8376,
      watchBinary: true
    }),
    exec: () => "",
    signalProcess: () => {
      throw new Error("signal unsupported");
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(errors.join("\n"), /could not trigger an immediate graceful router reload/i);
  assert.match(lines.join("\n"), /should self-reload when its binary watcher detects the new version/i);
});
