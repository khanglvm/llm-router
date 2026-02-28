/**
 * Cloudflare Worker entrypoint.
 * Runtime config is supplied via LLM_ROUTER_CONFIG_JSON (or aliases) env/secret.
 */

import { createFetchHandler } from "./runtime/handler.js";
import { runtimeConfigFromEnv } from "./runtime/config.js";

const workerFetch = createFetchHandler({
  getConfig: async (env) => runtimeConfigFromEnv(env),
  defaultStateStoreBackend: "memory"
});

export default {
  async fetch(request, env, ctx) {
    return workerFetch(request, env, ctx);
  }
};
