import test from "node:test";
import assert from "node:assert/strict";
import { parseFuserPidList, parsePidList, reclaimPort, stopStartupManagedListener } from "./port-reclaim.js";

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
    port: 8787,
    line: (message) => lines.push(message),
    error: () => {}
  }, {
    getActiveRuntimeState: async () => ({ managedByStartup: true, port: 8787 }),
    stopStartup: async () => {},
    clearRuntimeState: async () => {}
  });

  assert.deepEqual(result, { ok: true, attempted: true });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Stopping startup service before reclaim/);
});

test("reclaimPort short-circuits when startup-managed stop fails", async () => {
  const calls = [];
  const result = await reclaimPort({
    port: 8787,
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
    port: 8787,
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
    port: 8787,
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
  assert.match(lines[0], /Waiting for port 8787 to release/);
});
