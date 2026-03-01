import test from "node:test";
import assert from "node:assert/strict";
import { resolveAmpRequestedModel } from "./amp-routing.js";

function createAmpContext(overrides = {}) {
  return {
    isAmp: true,
    mode: "smart",
    agent: "review",
    application: "CLI Execute Mode",
    provider: "anthropic",
    requestedModel: "claude-haiku-4-5-20251001",
    ...overrides
  };
}

test("resolveAmpRequestedModel returns original request when ampRouting is disabled", () => {
  const result = resolveAmpRequestedModel({
    ampRouting: {
      enabled: false,
      modeMap: {
        smart: "chat.default"
      }
    }
  }, "anthropic/claude-3-5-haiku", createAmpContext());

  assert.equal(result.requestedModel, "anthropic/claude-3-5-haiku");
  assert.equal(result.ampMatchedBy, "");
  assert.equal(result.ampMatchedRef, "");
});

test("resolveAmpRequestedModel applies precedence across amp routing maps", () => {
  const config = {
    ampRouting: {
      enabled: true,
      fallbackRoute: "chat.fallback",
      modeMap: {
        smart: "chat.mode"
      },
      agentMap: {
        review: "chat.agent"
      },
      agentModeMap: {
        review: {
          smart: "chat.agent-mode"
        }
      },
      applicationMap: {
        "cli execute mode": "chat.application"
      },
      modelMap: {
        "claude-haiku-4-5-20251001": "chat.model",
        "anthropic/claude-haiku-4-5-20251001": "chat.provider-model"
      }
    }
  };

  const cases = [
    {
      name: "agent-mode",
      config,
      expectedModel: "chat.agent-mode",
      expectedMatchedBy: "agent-mode"
    },
    {
      name: "mode",
      config: {
        ampRouting: {
          ...config.ampRouting,
          agentModeMap: {}
        }
      },
      expectedModel: "chat.mode",
      expectedMatchedBy: "mode"
    },
    {
      name: "agent",
      config: {
        ampRouting: {
          ...config.ampRouting,
          agentModeMap: {},
          modeMap: {}
        }
      },
      expectedModel: "chat.agent",
      expectedMatchedBy: "agent"
    },
    {
      name: "application",
      config: {
        ampRouting: {
          ...config.ampRouting,
          agentModeMap: {},
          modeMap: {},
          agentMap: {}
        }
      },
      expectedModel: "chat.application",
      expectedMatchedBy: "application"
    },
    {
      name: "model",
      config: {
        ampRouting: {
          ...config.ampRouting,
          agentModeMap: {},
          modeMap: {},
          agentMap: {},
          applicationMap: {}
        }
      },
      expectedModel: "chat.model",
      expectedMatchedBy: "model"
    },
    {
      name: "provider-model",
      config: {
        ampRouting: {
          ...config.ampRouting,
          agentModeMap: {},
          modeMap: {},
          agentMap: {},
          applicationMap: {},
          modelMap: {
            "anthropic/claude-haiku-4-5-20251001": "chat.provider-model"
          }
        }
      },
      expectedModel: "chat.provider-model",
      expectedMatchedBy: "provider-model"
    },
    {
      name: "fallback",
      config: {
        ampRouting: {
          ...config.ampRouting,
          agentModeMap: {},
          modeMap: {},
          agentMap: {},
          applicationMap: {},
          modelMap: {}
        }
      },
      expectedModel: "chat.fallback",
      expectedMatchedBy: "fallback"
    }
  ];

  for (const entry of cases) {
    const result = resolveAmpRequestedModel(entry.config, "smart", createAmpContext());
    assert.equal(result.requestedModel, entry.expectedModel, entry.name);
    assert.equal(result.ampMatchedBy, entry.expectedMatchedBy, entry.name);
    assert.equal(result.ampMatchedRef, entry.expectedModel, entry.name);
  }
});

test("resolveAmpRequestedModel returns original request for non-amp traffic", () => {
  const result = resolveAmpRequestedModel({
    ampRouting: {
      enabled: true,
      fallbackRoute: "chat.default"
    }
  }, "anthropic/claude-3-5-haiku", {
    isAmp: false
  });

  assert.equal(result.requestedModel, "anthropic/claude-3-5-haiku");
  assert.equal(result.ampMatchedBy, "");
  assert.equal(result.ampMatchedRef, "");
});

test("resolveAmpRequestedModel uses smart when fallbackRoute is missing", () => {
  const result = resolveAmpRequestedModel({
    ampRouting: {
      enabled: true,
      modeMap: {}
    }
  }, "anthropic/claude-3-5-haiku", createAmpContext({
    mode: "",
    agent: "",
    application: "",
    provider: "",
    requestedModel: ""
  }));

  assert.equal(result.requestedModel, "smart");
  assert.equal(result.ampMatchedBy, "fallback");
  assert.equal(result.ampMatchedRef, "smart");
});
