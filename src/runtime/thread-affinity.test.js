import { test } from "node:test";
import assert from "node:assert";
import { createThreadAffinityStore } from "./thread-affinity.js";

test("Thread Affinity Store", async (t) => {
  await t.test("getAffinity returns null for unknown thread", () => {
    const store = createThreadAffinityStore();
    assert.strictEqual(store.getAffinity("unknown-thread"), null);
  });

  await t.test("setAffinity + getAffinity returns correct candidateKey", () => {
    const store = createThreadAffinityStore();
    store.setAffinity("thread-1", "provider-a");
    assert.strictEqual(store.getAffinity("thread-1"), "provider-a");
  });

  await t.test("Expired affinity returns null", (t) => {
    const store = createThreadAffinityStore({ ttlMs: 1 });
    store.setAffinity("thread-2", "provider-b");
    assert.strictEqual(store.getAffinity("thread-2"), "provider-b");

    // Wait for TTL to expire
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(store.getAffinity("thread-2"), null);
        resolve();
      }, 5);
    });
  });

  await t.test("clearAffinity removes binding", () => {
    const store = createThreadAffinityStore();
    store.setAffinity("thread-3", "provider-c");
    assert.strictEqual(store.getAffinity("thread-3"), "provider-c");

    store.clearAffinity("thread-3");
    assert.strictEqual(store.getAffinity("thread-3"), null);
  });

  await t.test("Max bindings cap triggers cleanup", async () => {
    const store = createThreadAffinityStore({ ttlMs: 1 });
    const MAX_BINDINGS = 10_000;

    // First, set some entries and let them expire
    for (let i = 0; i < 100; i++) {
      store.setAffinity(`thread-expired-${i}`, `provider-${i}`);
    }

    // Wait for them to expire
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Now set MAX_BINDINGS + 1 fresh entries - this should trigger pruneExpired
    // and remove the expired entries from earlier
    for (let i = 0; i <= MAX_BINDINGS; i++) {
      store.setAffinity(`thread-fresh-${i}`, `provider-${i}`);
    }

    // After exceeding the limit with a pruneExpired call, expired entries should be cleaned
    const finalSize = store._bindings.size;
    assert.ok(finalSize <= MAX_BINDINGS, `Expected size (${finalSize}) <= MAX_BINDINGS (${MAX_BINDINGS})`);
  });
});
