import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeoutSignal } from "./timeout-signal.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("buildTimeoutSignal aborts when the timeout elapses", async () => {
  const timeoutControl = buildTimeoutSignal(20);

  try {
    assert.ok(timeoutControl.signal);
    assert.equal(timeoutControl.signal.aborted, false);

    await sleep(40);

    assert.equal(timeoutControl.signal.aborted, true);
    assert.equal(timeoutControl.signal.reason, "timeout:20");
  } finally {
    timeoutControl.cleanup();
  }
});

test("buildTimeoutSignal cleanup cancels the pending timeout", async () => {
  const timeoutControl = buildTimeoutSignal(20);

  assert.ok(timeoutControl.signal);
  assert.equal(timeoutControl.signal.aborted, false);

  timeoutControl.cleanup();
  await sleep(40);

  assert.equal(timeoutControl.signal.aborted, false);
});
