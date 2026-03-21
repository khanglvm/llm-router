#!/usr/bin/env node

import { spawn } from "node:child_process";

const PORT = Number(process.env.WORKER_TEST_PORT) || 18787;
const TIMEOUT_MS = 30_000;
const MASTER_KEY = "smoke-test-key";
const CONFIG = JSON.stringify({ version: 2, masterKey: MASTER_KEY, providers: [] });

let child = null;
let childExited = false;

function cleanup() {
  if (child && !childExited) {
    child.kill("SIGTERM");
  }
}

const handleSignal = (signal) => {
  console.log(`Received ${signal}. Cleaning up wrangler process...`);
  cleanup();
  process.exit(1);
};
process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);

async function run() {
  console.log(`Worker smoke test starting on port ${PORT}...`);

  const wranglerArgs = [
    "wrangler", "dev",
    "--port", String(PORT),
    "--show-interactive-dev-session", "false",
    "--var", `LLM_ROUTER_CONFIG_JSON:${CONFIG}`
  ];
  child = spawn("npx", wranglerArgs, { stdio: ["ignore", "pipe", "pipe"] }); // spawn wrangler dev

  child.on("exit", () => { childExited = true; });

  try {
    // Wait for ready signal from either stdout or stderr
    console.log("Waiting for wrangler dev ready signal...");
    await waitForReady(child);

    // Send health check
    console.log("Worker ready. Sending health check...");
    const res = await fetch(`http://localhost:${PORT}/health`, {
      headers: { "Authorization": `Bearer ${MASTER_KEY}` }
    });

    const body = await res.text();

    if (res.status !== 200) {
      console.error(`Worker smoke test FAILED: Health check returned ${res.status} ${body}`);
      process.exit(1);
    }

    // Verify response contains status: ok
    const json = JSON.parse(body);
    if (json.status !== "ok") {
      console.error(`Worker smoke test FAILED: Expected status "ok", got "${json.status}"`);
      process.exit(1);
    }

    console.log(`Health check passed: ${res.status} ${body}`);
    console.log("Worker smoke test PASSED");
  } finally {
    cleanup();
  }
}

function waitForReady(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${TIMEOUT_MS}ms waiting for wrangler dev to start`));
    }, TIMEOUT_MS);

    const onData = (chunk) => {
      const text = chunk.toString();
      if (text.includes("Ready on")) {
        clearTimeout(timer);
        proc.stdout.removeListener("data", onData);
        proc.stderr.removeListener("data", onData);
        resolve();
      }
    };

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`wrangler dev exited unexpectedly with code ${code}`));
    });
  });
}

run().catch((err) => {
  console.error(`Worker smoke test FAILED: ${err.message}`);
  cleanup();
  process.exit(1);
});
