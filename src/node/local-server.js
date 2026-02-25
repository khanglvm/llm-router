/**
 * Local HTTP server wrapper around the shared fetch handler.
 */

import http from "node:http";
import { Readable } from "node:stream";
import { createFetchHandler } from "../runtime/handler.js";
import { readConfigFile, getDefaultConfigPath } from "./config-store.js";

function buildRequestUrl(req, fallbackHost) {
  const host = req.headers.host || fallbackHost;
  const path = req.url || "/";
  return `http://${host}${path}`;
}

function nodeRequestToFetchRequest(req, fallbackHost) {
  const url = buildRequestUrl(req, fallbackHost);
  const method = req.method || "GET";
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  if (!hasBody) {
    return new Request(url, { method, headers });
  }

  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(req),
    duplex: "half"
  });
}

async function writeFetchResponseToNode(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const readable = Readable.fromWeb(response.body);
  readable.on("error", (error) => {
    res.destroy(error);
  });
  readable.pipe(res);
}

export async function startLocalRouteServer({
  port = 8787,
  host = "127.0.0.1",
  configPath = getDefaultConfigPath(),
  requireAuth = false
} = {}) {
  const fetchHandler = createFetchHandler({
    ignoreAuth: !requireAuth,
    getConfig: async () => readConfigFile(configPath)
  });

  const fallbackHost = `${host}:${port}`;

  const server = http.createServer(async (req, res) => {
    try {
      const request = nodeRequestToFetchRequest(req, fallbackHost);
      const response = await fetchHandler(request, {}, undefined);
      await writeFetchResponseToNode(res, response);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}
