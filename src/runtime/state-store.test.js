import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { createMemoryStateStore } from "./state-store.memory.js";
import { createFileStateStore } from "./state-store.file.js";

function buildTempPath(name) {
  const unique = `llm-router-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `${name}-${unique}.json`);
}

test("memory store supports cursor/state/bucket roundtrip and pruning", async () => {
  const store = createMemoryStateStore({
    candidateStateTtlMs: 10
  });

  await store.setRouteCursor("route:chat.default", 3);
  assert.equal(await store.getRouteCursor("route:chat.default"), 3);

  const state = await store.setCandidateState("candidate:openrouter%2Fgpt-4o-mini@openai", {
    cooldownUntil: 10,
    expiresAt: 20,
    consecutiveRetryableFailures: 2
  });
  assert.equal(state.cooldownUntil, 10);
  assert.equal(state.consecutiveRetryableFailures, 2);

  await store.incrementBucketUsage("bucket:openrouter:all-month", "month:1:2026-02", 2, {
    expiresAt: 30
  });
  assert.equal(await store.readBucketUsage("bucket:openrouter:all-month", "month:1:2026-02"), 2);

  await store.incrementBucketUsage("bucket:openrouter:all-month", "month:1:2026-02", 1, {
    expiresAt: 30
  });
  assert.equal(await store.readBucketUsage("bucket:openrouter:all-month", "month:1:2026-02"), 3);

  const pruned = await store.pruneExpired(50);
  assert.equal(pruned.prunedBuckets, 1);
  assert.equal(pruned.prunedCandidateStates, 1);
  assert.equal(await store.readBucketUsage("bucket:openrouter:all-month", "month:1:2026-02"), 0);
  assert.equal(await store.getCandidateState("candidate:openrouter%2Fgpt-4o-mini@openai"), null);
});

test("file store read/write roundtrip and restart persistence", async () => {
  const filePath = buildTempPath("state-store");
  const store = await createFileStateStore({ filePath });

  await store.setRouteCursor("route:chat.default", 4);
  await store.setCandidateState("candidate:anthropic%2Fclaude-3-5-haiku@claude", {
    cooldownUntil: 1200,
    consecutiveRetryableFailures: 1
  });
  await store.incrementBucketUsage("bucket:anthropic:all-week", "week:1:2026-02-23", 5, {
    expiresAt: 2000
  });
  await store.close();

  const restarted = await createFileStateStore({ filePath });
  assert.equal(await restarted.getRouteCursor("route:chat.default"), 4);
  assert.equal(await restarted.readBucketUsage("bucket:anthropic:all-week", "week:1:2026-02-23"), 5);
  const candidateState = await restarted.getCandidateState("candidate:anthropic%2Fclaude-3-5-haiku@claude");
  assert.equal(candidateState?.cooldownUntil, 1200);
  assert.equal(candidateState?.consecutiveRetryableFailures, 1);
  await restarted.close();

  await fs.unlink(filePath).catch(() => {});
});

test("file store gracefully handles missing file", async () => {
  const filePath = buildTempPath("missing-state-store");
  await fs.unlink(filePath).catch(() => {});

  const store = await createFileStateStore({ filePath });
  assert.equal(await store.getRouteCursor("route:missing"), 0);
  assert.equal(await store.readBucketUsage("bucket:missing", "day:1:2026-02-28"), 0);
  assert.equal(await store.getCandidateState("candidate:missing"), null);
  await store.close();
});

test("file store gracefully recovers from corrupt JSON", async () => {
  const filePath = buildTempPath("corrupt-state-store");
  await fs.writeFile(filePath, "{not-json", "utf8");

  const store = await createFileStateStore({ filePath });
  assert.equal(await store.getRouteCursor("route:any"), 0);
  await store.setRouteCursor("route:any", 2);
  assert.equal(await store.getRouteCursor("route:any"), 2);
  await store.close();

  await fs.unlink(filePath).catch(() => {});
});
