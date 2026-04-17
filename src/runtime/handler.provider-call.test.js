import test from "node:test";
import assert from "node:assert/strict";
import { FORMATS } from "../translator/index.js";
import {
  makeProviderCall,
  resetOpenAIToolRoutingLearningState
} from "./handler/provider-call.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function buildOpenAICandidate(providerOverrides = {}) {
  const model = { id: "gpt-5.4" };
  return {
    provider: {
      id: "rc",
      name: "RamClouds",
      baseUrl: "https://ramclouds.me",
      format: FORMATS.OPENAI,
      formats: [FORMATS.OPENAI],
      models: [model],
      ...providerOverrides
    },
    providerId: "rc",
    modelId: "gpt-5.4",
    model,
    requestModelId: "rc/gpt-5.4",
    targetFormat: FORMATS.OPENAI,
    backend: "gpt-5.4"
  };
}

function buildClaudeCandidate(providerOverrides = {}) {
  const model = { id: "claude-sonnet-4-6" };
  return {
    provider: {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      format: FORMATS.CLAUDE,
      formats: [FORMATS.CLAUDE],
      models: [model],
      ...providerOverrides
    },
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
    model,
    requestModelId: "anthropic/claude-sonnet-4-6",
    targetFormat: FORMATS.CLAUDE,
    backend: "claude-sonnet-4-6"
  };
}

test("makeProviderCall retries OpenAI responses hosted web search with web_search when preview tool names are rejected", { concurrency: false }, async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body || "{}"));
    calls.push({
      url: String(url),
      body
    });

    if (calls.length === 1) {
      return jsonResponse({
        error: {
          message: "Unsupported tool type: web_search_preview"
        }
      }, 400);
    }

    return jsonResponse({
      id: "resp_native_search_retry",
      object: "response",
      model: "gpt-5.4",
      output: [
        { id: "ws_1", type: "web_search_call", status: "completed" },
        {
          id: "msg_1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Sunrise in Paris today is 7:10 AM."
            }
          ]
        }
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 12,
        total_tokens: 22
      }
    });
  };

  try {
    const result = await makeProviderCall({
      body: {
        model: "rc/gpt-5.4",
        input: "Find the sunrise time in Paris today and cite the source.",
        tools: [{ type: "web_search_preview" }],
        tool_choice: {
          type: "web_search_preview"
        }
      },
      sourceFormat: FORMATS.OPENAI,
      stream: false,
      candidate: buildOpenAICandidate(),
      requestKind: "responses",
      requestHeaders: new Headers(),
      env: {}
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://ramclouds.me/v1/responses");
    assert.equal(calls[0]?.body?.tools?.[0]?.type, "web_search_preview");
    assert.deepEqual(calls[0]?.body?.tool_choice, {
      type: "web_search_preview"
    });
    assert.equal(calls[1]?.body?.tools?.[0]?.type, "web_search");
    assert.equal(calls[1]?.body?.tool_choice, "required");

    const payload = await result.response.json();
    assert.equal(payload.object, "response");
    assert.equal(payload.output?.[0]?.type, "web_search_call");
    assert.equal(payload.output?.[1]?.content?.[0]?.text, "Sunrise in Paris today is 7:10 AM.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("makeProviderCall applies configured OpenAI responses hosted web search tool types before the first request", { concurrency: false }, async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body || "{}"))
    });
    return jsonResponse({
      id: "resp_native_search_declared",
      object: "response",
      model: "gpt-5.4",
      output: [
        {
          id: "msg_1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "OK"
            }
          ]
        }
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2
      }
    });
  };

  try {
    const result = await makeProviderCall({
      body: {
        model: "rc/gpt-5.4",
        input: "Search for a quick fact.",
        tools: [{ type: "web_search_preview" }],
        tool_choice: {
          type: "web_search_preview"
        }
      },
      sourceFormat: FORMATS.OPENAI,
      stream: false,
      candidate: buildOpenAICandidate({
        metadata: {
          openaiResponses: {
            webSearchToolType: "web_search"
          }
        }
      }),
      requestKind: "responses",
      requestHeaders: new Headers(),
      env: {}
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.body?.tools?.[0]?.type, "web_search");
    assert.equal(calls[0]?.body?.tool_choice, "required");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("makeProviderCall intercepts native Claude web search locally for non-AMP clients", { concurrency: false }, async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    if (normalizedUrl.startsWith("https://api.search.brave.com/")) {
      calls.push({
        url: normalizedUrl,
        kind: "search"
      });
      return jsonResponse({
        web: {
          results: [
            {
              title: "LLM Router Release Notes",
              url: "https://example.com/releases",
              description: "Latest release notes for llm-router."
            }
          ]
        }
      });
    }

    const body = JSON.parse(String(init.body || "{}"));
    calls.push({
      url: normalizedUrl,
      kind: "provider",
      body
    });

    if (calls.filter((entry) => entry.kind === "provider").length === 1) {
      return jsonResponse({
        id: "msg_native_search",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: "tool_web_1",
            name: "web_search",
            input: {
              query: "llm-router latest release notes"
            }
          }
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 12,
          output_tokens: 4
        }
      });
    }

    return jsonResponse({
      id: "msg_native_search_final",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "text",
          text: "The latest llm-router release notes are available and summarize the current release."
        }
      ],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 18,
        output_tokens: 10
      }
    });
  };

  try {
    const result = await makeProviderCall({
      body: {
        model: "smart",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Search the web for llm-router latest release notes." }]
          }
        ],
        tools: [
          {
            type: "web_search_20250305"
          }
        ]
      },
      sourceFormat: FORMATS.CLAUDE,
      stream: false,
      candidate: buildClaudeCandidate(),
      requestKind: "messages",
      requestHeaders: new Headers({ "anthropic-version": "2023-06-01" }),
      runtimeConfig: {
        webSearch: {
          providers: [
            {
              id: "brave",
              apiKey: "brave_test_key",
              count: 3,
              limit: 10,
              remaining: 10
            }
          ]
        }
      },
      env: {}
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[0]?.body?.tools?.length, 1);
    assert.equal(calls[0]?.body?.tools?.[0]?.name, "web_search");
    assert.equal(calls[0]?.body?.tools?.[0]?.input_schema?.properties?.query?.type, "string");
    assert.match(calls[1]?.url || "", /^https:\/\/api\.search\.brave\.com\//);
    assert.equal(calls[2]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[2]?.body?.tools, undefined);
    assert.match(String(calls[2]?.body?.system || ""), /You just performed web searches/);
    assert.equal(calls[2]?.body?.messages?.at(-1)?.role, "user");
    assert.equal(calls[2]?.body?.messages?.at(-1)?.content?.[0]?.type, "tool_result");
    assert.match(String(calls[2]?.body?.messages?.at(-1)?.content?.[0]?.content || ""), /LLM Router Release Notes/);

    const payload = await result.response.json();
    assert.equal(payload.type, "message");
    assert.equal(payload.content?.[0]?.type, "text");
    assert.match(String(payload.content?.[0]?.text || ""), /latest llm-router release notes/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("makeProviderCall prefers OpenAI routing for Claude tool calls on dual-format providers", { concurrency: false }, async () => {
  resetOpenAIToolRoutingLearningState();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body || "{}"))
    });

    return jsonResponse({
      id: "chatcmpl_tool_route",
      object: "chat.completion",
      created: 1730000200,
      model: "claude-sonnet-4-6",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_fetch_1",
            type: "function",
            function: {
              name: "fetch",
              arguments: "{\"url\":\"https://example.com\"}"
            }
          }]
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 6,
        total_tokens: 18
      }
    });
  };

  try {
    const result = await makeProviderCall({
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 256,
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Use the fetch tool for https://example.com." }]
        }],
        tools: [{
          name: "fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" }
            },
            required: ["url"]
          }
        }],
        tool_choice: { type: "any" }
      },
      sourceFormat: FORMATS.CLAUDE,
      stream: false,
      candidate: buildClaudeCandidate({
        formats: [FORMATS.CLAUDE, FORMATS.OPENAI],
        baseUrlByFormat: {
          claude: "https://api.anthropic.com",
          openai: "https://api.anthropic.com"
        }
      }),
      requestKind: "messages",
      requestHeaders: new Headers({ "anthropic-version": "2023-06-01" }),
      env: {}
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/chat/completions");
    assert.equal(calls[0]?.body?.messages?.[0]?.role, "user");
    assert.equal(calls[0]?.body?.tools?.[0]?.type, "function");
    assert.equal(calls[0]?.body?.tool_choice, "required");

    const payload = await result.response.json();
    assert.equal(payload.type, "message");
    assert.equal(payload.stop_reason, "tool_use");
    assert.equal(payload.content?.[0]?.type, "tool_use");
    assert.equal(payload.content?.[0]?.name, "fetch");
    assert.deepEqual(payload.content?.[0]?.input, { url: "https://example.com" });
  } finally {
    globalThis.fetch = originalFetch;
    resetOpenAIToolRoutingLearningState();
  }
});

test("makeProviderCall translates streamed OpenAI tool calls back to Claude SSE for dual-format providers", { concurrency: false }, async () => {
  resetOpenAIToolRoutingLearningState();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body || "{}"))
    });

    const sse = [
      "data: {\"id\":\"chatcmpl_tool_stream\",\"object\":\"chat.completion.chunk\",\"model\":\"claude-sonnet-4-6\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_fetch_1\",\"type\":\"function\",\"function\":{\"name\":\"fetch\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"}}]}}]}",
      "",
      "data: {\"id\":\"chatcmpl_tool_stream\",\"object\":\"chat.completion.chunk\",\"model\":\"claude-sonnet-4-6\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}",
      "",
      "data: [DONE]",
      ""
    ].join("\n");

    return new Response(sse, {
      status: 200,
      headers: {
        "content-type": "text/event-stream"
      }
    });
  };

  try {
    const result = await makeProviderCall({
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 256,
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Use the fetch tool for https://example.com." }]
        }],
        tools: [{
          name: "fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" }
            }
          }
        }],
        tool_choice: { type: "any" }
      },
      sourceFormat: FORMATS.CLAUDE,
      stream: true,
      candidate: buildClaudeCandidate({
        formats: [FORMATS.CLAUDE, FORMATS.OPENAI],
        baseUrlByFormat: {
          claude: "https://api.anthropic.com",
          openai: "https://api.anthropic.com"
        }
      }),
      requestKind: "messages",
      requestHeaders: new Headers({ "anthropic-version": "2023-06-01" }),
      env: {}
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/chat/completions");

    const sseText = await result.response.text();
    assert.match(sseText, /"type":"tool_use"/);
    assert.match(sseText, /"name":"fetch"/);
    assert.match(sseText, /"stop_reason":"tool_use"/);
  } finally {
    globalThis.fetch = originalFetch;
    resetOpenAIToolRoutingLearningState();
  }
});

test("makeProviderCall falls back to Claude routing when OpenAI tool routing fails", { concurrency: false }, async () => {
  resetOpenAIToolRoutingLearningState();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body || "{}"))
    });

    if (calls.length === 1) {
      return jsonResponse({
        error: {
          message: "Model not available on chat completions."
        }
      }, 400);
    }

    return jsonResponse({
      id: "msg_claude_fallback",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{
        type: "text",
        text: "Claude fallback succeeded."
      }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 12,
        output_tokens: 6
      }
    });
  };

  try {
    const result = await makeProviderCall({
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 256,
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Use the fetch tool for https://example.com." }]
        }],
        tools: [{
          name: "fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" }
            }
          }
        }],
        tool_choice: { type: "any" }
      },
      sourceFormat: FORMATS.CLAUDE,
      stream: false,
      candidate: buildClaudeCandidate({
        formats: [FORMATS.CLAUDE, FORMATS.OPENAI],
        baseUrlByFormat: {
          claude: "https://api.anthropic.com",
          openai: "https://api.anthropic.com"
        }
      }),
      requestKind: "messages",
      requestHeaders: new Headers({ "anthropic-version": "2023-06-01" }),
      env: {}
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/chat/completions");
    assert.equal(calls[1]?.url, "https://api.anthropic.com/v1/messages");

    const payload = await result.response.json();
    assert.equal(payload.content?.[0]?.text, "Claude fallback succeeded.");
  } finally {
    globalThis.fetch = originalFetch;
    resetOpenAIToolRoutingLearningState();
  }
});

test("makeProviderCall learns to skip repeated OpenAI tool-routing failures for the same Claude route", { concurrency: false }, async () => {
  resetOpenAIToolRoutingLearningState();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body || "{}"))
    });

    if (calls.length === 1) {
      return jsonResponse({
        error: {
          message: "Model not available on chat completions."
        }
      }, 400);
    }

    return jsonResponse({
      id: `msg_claude_${calls.length}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{
        type: "text",
        text: "Claude fallback succeeded."
      }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 12,
        output_tokens: 6
      }
    });
  };

  const request = {
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Use the fetch tool for https://example.com." }]
      }],
      tools: [{
        name: "fetch",
        description: "Fetch a URL",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string" }
          }
        }
      }],
      tool_choice: { type: "any" }
    },
    sourceFormat: FORMATS.CLAUDE,
    stream: false,
    candidate: buildClaudeCandidate({
      formats: [FORMATS.CLAUDE, FORMATS.OPENAI],
      baseUrlByFormat: {
        claude: "https://api.anthropic.com",
        openai: "https://api.anthropic.com"
      }
    }),
    requestKind: "messages",
    requestHeaders: new Headers({ "anthropic-version": "2023-06-01" }),
    env: {}
  };

  try {
    const firstResult = await makeProviderCall(request);
    assert.equal(firstResult.ok, true);

    const secondResult = await makeProviderCall(request);
    assert.equal(secondResult.ok, true);

    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/chat/completions");
    assert.equal(calls[1]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[2]?.url, "https://api.anthropic.com/v1/messages");
  } finally {
    globalThis.fetch = originalFetch;
    resetOpenAIToolRoutingLearningState();
  }
});

test("makeProviderCall skips OpenAI tool routing when probe data prefers Claude for the model", { concurrency: false }, async () => {
  resetOpenAIToolRoutingLearningState();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body || "{}"))
    });
    return jsonResponse({
      id: "msg_claude_preferred",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{
        type: "text",
        text: "Claude route selected directly."
      }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 12,
        output_tokens: 6
      }
    });
  };

  try {
    const result = await makeProviderCall({
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 256,
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Use the fetch tool for https://example.com." }]
        }],
        tools: [{
          name: "fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" }
            }
          }
        }],
        tool_choice: { type: "any" }
      },
      sourceFormat: FORMATS.CLAUDE,
      stream: false,
      candidate: buildClaudeCandidate({
        formats: [FORMATS.CLAUDE, FORMATS.OPENAI],
        baseUrlByFormat: {
          claude: "https://api.anthropic.com",
          openai: "https://api.anthropic.com"
        },
        lastProbe: {
          modelSupport: {
            "claude-sonnet-4-6": [FORMATS.CLAUDE, FORMATS.OPENAI]
          },
          modelPreferredFormat: {
            "claude-sonnet-4-6": FORMATS.CLAUDE
          }
        }
      }),
      requestKind: "messages",
      requestHeaders: new Headers({ "anthropic-version": "2023-06-01" }),
      env: {}
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/messages");
  } finally {
    globalThis.fetch = originalFetch;
    resetOpenAIToolRoutingLearningState();
  }
});

test("makeProviderCall queues an oversized request log entry when enabled", { concurrency: false }, async () => {
  const logs = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    id: "resp_large_log",
    object: "response",
    model: "gpt-5.4",
    output: [{
      id: "msg_1",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "Logged."
      }]
    }]
  });

  try {
    const result = await makeProviderCall({
      body: {
        model: "rc/gpt-5.4",
        input: "A".repeat(1024),
        tools: [{ type: "web_search_preview" }]
      },
      sourceFormat: FORMATS.OPENAI,
      stream: false,
      candidate: buildOpenAICandidate(),
      requestKind: "responses",
      requestHeaders: new Headers(),
      env: {
        LLM_ROUTER_LOG_LARGE_REQUESTS: "1",
        LLM_ROUTER_LARGE_REQUEST_LOG_THRESHOLD_BYTES: "32"
      },
      onLargeRequestLog: async (entry) => {
        logs.push(entry);
      }
    });

    assert.equal(result.ok, true);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.kind, "large-provider-request");
    assert.equal(logs[0]?.providerId, "rc");
    assert.equal(logs[0]?.targetFormat, FORMATS.OPENAI);
    assert.equal(logs[0]?.requestKind, "responses");
    assert.equal(logs[0]?.bodySummary?.toolTypes?.[0], "web_search_preview");
    assert.ok(logs[0]?.requestBytes >= 32);
    assert.ok(logs[0]?.bodySummary?.largestStringBytes >= 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("makeProviderCall skips oversized request logging when disabled", { concurrency: false }, async () => {
  const logs = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    id: "resp_large_log_disabled",
    object: "response",
    model: "gpt-5.4",
    output: []
  });

  try {
    const result = await makeProviderCall({
      body: {
        model: "rc/gpt-5.4",
        input: "B".repeat(1024)
      },
      sourceFormat: FORMATS.OPENAI,
      stream: false,
      candidate: buildOpenAICandidate(),
      requestKind: "responses",
      requestHeaders: new Headers(),
      env: {
        LLM_ROUTER_LOG_LARGE_REQUESTS: "0",
        LLM_ROUTER_LARGE_REQUEST_LOG_THRESHOLD_BYTES: "32"
      },
      onLargeRequestLog: (entry) => {
        logs.push(entry);
      }
    });

    assert.equal(result.ok, true);
    assert.equal(logs.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("makeProviderCall ignores oversized request logger failures", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    id: "resp_large_log_error",
    object: "response",
    model: "gpt-5.4",
    output: []
  });

  try {
    const result = await makeProviderCall({
      body: {
        model: "rc/gpt-5.4",
        input: "C".repeat(1024)
      },
      sourceFormat: FORMATS.OPENAI,
      stream: false,
      candidate: buildOpenAICandidate(),
      requestKind: "responses",
      requestHeaders: new Headers(),
      env: {
        LLM_ROUTER_LOG_LARGE_REQUESTS: "1",
        LLM_ROUTER_LARGE_REQUEST_LOG_THRESHOLD_BYTES: "32"
      },
      onLargeRequestLog: async () => {
        throw new Error("logger failed");
      }
    });

    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
