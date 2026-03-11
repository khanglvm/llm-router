import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  runCli,
  installTuiSigintExitHandler,
  shouldExitTuiOnKeypress
} from "./cli-entry.js";

test("shouldExitTuiOnKeypress only matches Ctrl+C", () => {
  assert.equal(shouldExitTuiOnKeypress("\u0003", { sequence: "\u0003", ctrl: true, name: "c" }), true);
  assert.equal(shouldExitTuiOnKeypress("c", { ctrl: true, name: "c" }), true);
  assert.equal(shouldExitTuiOnKeypress(undefined, { name: "escape", sequence: "\u001b" }), false);
  assert.equal(shouldExitTuiOnKeypress("x", { name: "x" }), false);
});

test("installTuiSigintExitHandler exits on Ctrl+C and ignores Escape", () => {
  const input = new EventEmitter();
  const exitCodes = [];
  const dispose = installTuiSigintExitHandler({
    input,
    isTTY: true,
    exit(code) {
      exitCodes.push(code);
    }
  });

  input.emit("keypress", undefined, { name: "escape", sequence: "\u001b" });
  assert.deepEqual(exitCodes, []);

  input.emit("keypress", "\u0003", { sequence: "\u0003", ctrl: true, name: "c" });
  assert.deepEqual(exitCodes, [130]);

  dispose();
  input.emit("keypress", "\u0003", { sequence: "\u0003", ctrl: true, name: "c" });
  assert.deepEqual(exitCodes, [130]);
});

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

test("runCli opens TUI for bare invocation when --tui is provided", async () => {
  const calls = [];

  await runCli(["--tui"], false, {
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
    { type: "snap", argv: ["config"] }
  ]);
});

test("runCli opens web console by default for llm-router config", async () => {
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

test("runCli opens TUI for llm-router config --tui", async () => {
  const calls = [];

  await runCli(["config", "--tui", "--config=/tmp/router.json"], false, {
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
    { type: "snap", argv: ["config", "--config=/tmp/router.json"] }
  ]);
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
