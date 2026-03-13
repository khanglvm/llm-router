import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "./cli-entry.js";

test("runCli opens web console by default for bare invocation", async () => {
  const calls = [];

  const exitCode = await runCli([], false, {
    async runWebCommand(options) {
      calls.push({ type: "web", options });
      return { ok: true, exitCode: 0 };
    },
    async runSnapCli(argv) {
      calls.push({ type: "snap", argv });
      return 0;
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "web");
  assert.equal(calls[0].options.host, "127.0.0.1");
});

test("runCli opens web console by default for llr config", async () => {
  const calls = [];

  await runCli(["config", "--port=9999", "--open=false"], false, {
    async runWebCommand(options) {
      calls.push({ type: "web", options });
      return { ok: true, exitCode: 0 };
    },
    async runSnapCli(argv) {
      calls.push({ type: "snap", argv });
      return 0;
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "web");
  assert.equal(calls[0].options.port, "9999");
  assert.equal(calls[0].options.open, false);
});

test("runCli keeps config operations on the Snap CLI path", async () => {
  const calls = [];

  await runCli(["config", "--operation=list"], false, {
    async runWebCommand(options) {
      calls.push({ type: "web", options });
      return { ok: true, exitCode: 0 };
    },
    async runSnapCli(argv) {
      calls.push({ type: "snap", argv });
      return 0;
    }
  });

  assert.deepEqual(calls, [
    { type: "snap", argv: ["config", "--operation=list"] }
  ]);
});

test("runCli rejects the removed --tui flag", async () => {
  const calls = [];
  const errors = [];

  const exitCode = await runCli(["config", "--tui"], false, {
    error(message) {
      errors.push(message);
    },
    async runWebCommand(options) {
      calls.push({ type: "web", options });
      return { ok: true, exitCode: 0 };
    },
    async runSnapCli(argv) {
      calls.push({ type: "snap", argv });
      return 0;
    }
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
  assert.match(String(errors[0] || ""), /TUI flow has been removed/i);
});

test("runCli treats setup as the web-console alias", async () => {
  const calls = [];

  await runCli(["setup", "--open=false"], false, {
    async runWebCommand(options) {
      calls.push({ type: "web", options });
      return { ok: true, exitCode: 0 };
    },
    async runSnapCli(argv) {
      calls.push({ type: "snap", argv });
      return 0;
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "web");
  assert.equal(calls[0].options.host, "127.0.0.1");
  assert.equal(calls[0].options.open, false);
  assert.equal(calls[0].options.routerHost, "127.0.0.1");
  assert.equal(typeof calls[0].options.routerPort, "number");
  assert.equal(calls[0].options.routerWatchConfig, true);
  assert.equal(calls[0].options.routerWatchBinary, true);
  assert.equal(calls[0].options.routerRequireAuth, false);
  assert.equal(calls[0].options.allowRemoteClients, false);
});

test("runCli keeps setup --operation on the Snap CLI path", async () => {
  const calls = [];

  await runCli(["setup", "--operation=list"], false, {
    async runWebCommand(options) {
      calls.push({ type: "web", options });
      return { ok: true, exitCode: 0 };
    },
    async runSnapCli(argv) {
      calls.push({ type: "snap", argv });
      return 0;
    }
  });

  assert.deepEqual(calls, [
    { type: "snap", argv: ["config", "--operation=list"] }
  ]);
});
