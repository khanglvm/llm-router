import test from "node:test";
import assert from "node:assert/strict";
import { resolveListenPort } from "./listen-port.js";
import { FIXED_LOCAL_ROUTER_PORT } from "./local-server-settings.js";

test("resolveListenPort always returns the fixed local router port", () => {
  assert.equal(resolveListenPort(), FIXED_LOCAL_ROUTER_PORT);
  assert.equal(resolveListenPort({
    explicitPort: "9123",
    env: { LLM_ROUTER_PORT: "9456", PORT: "9789" }
  }), FIXED_LOCAL_ROUTER_PORT);
});
