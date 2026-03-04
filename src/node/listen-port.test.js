import test from "node:test";
import assert from "node:assert/strict";
import { resolveListenPort } from "./listen-port.js";

test("resolveListenPort prefers explicit port over env vars", () => {
  const port = resolveListenPort({
    explicitPort: "9123",
    env: { LLM_ROUTER_PORT: "9456", PORT: "9789" }
  });
  assert.equal(port, 9123);
});

test("resolveListenPort falls back to LLM_ROUTER_PORT then PORT", () => {
  assert.equal(resolveListenPort({
    env: { LLM_ROUTER_PORT: "9456", PORT: "9789" }
  }), 9456);

  assert.equal(resolveListenPort({
    env: { LLM_ROUTER_PORT: "", PORT: "9789" }
  }), 9789);
});

test("resolveListenPort ignores invalid values and returns default", () => {
  assert.equal(resolveListenPort({
    explicitPort: "abc",
    env: { LLM_ROUTER_PORT: "-1", PORT: "70000" }
  }), 8787);
});

