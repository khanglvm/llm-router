/**
 * Ollama detection, installation, and server lifecycle management.
 * All public functions return structured results — never throw.
 */

import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

const OLLAMA_PORT_URL = "http://localhost:11434/";
const STARTUP_WAIT_MS = 2_000;
const HEALTH_TIMEOUT_MS = 3_000;

/** @type {Record<string, string[]>} */
const FALLBACK_PATHS = {
  darwin: ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"],
  linux: ["/usr/local/bin/ollama", "/usr/bin/ollama"],
  win32: ["C:\\Program Files\\Ollama\\ollama.exe"]
};

/**
 * Detect if Ollama is installed on the system.
 * @returns {{ installed: boolean, path: string, version: string }}
 */
export function detectOllamaInstallation() {
  try {
    const platform = process.platform;
    const whichCmd = platform === "win32" ? "where" : "which";
    const which = spawnSync(whichCmd, ["ollama"], { encoding: "utf8" });
    let ollamaPath = which.stdout?.trim() ?? "";

    if (!ollamaPath) {
      const candidates = FALLBACK_PATHS[platform] ?? [];
      ollamaPath = candidates.find((p) => existsSync(p)) ?? "";
    }

    if (!ollamaPath) {
      return { installed: false, path: "", version: "" };
    }

    const ver = spawnSync("ollama", ["--version"], { encoding: "utf8" });
    const version = ver.stdout?.trim() ?? "";
    return { installed: true, path: ollamaPath, version };
  } catch {
    return { installed: false, path: "", version: "" };
  }
}

/**
 * Install Ollama silently per platform.
 * @param {{ onProgress?: (event: { phase: string, message: string }) => void }} opts
 * @returns {Promise<{ ok: boolean, version?: string, error?: string, alreadyInstalled?: boolean }>}
 */
export async function installOllama({ onProgress } = {}) {
  const progress = (phase, message) => onProgress?.({ phase, message });

  try {
    progress("detecting", "Checking for existing Ollama installation...");
    const existing = detectOllamaInstallation();
    if (existing.installed) {
      progress("done", "Ollama is already installed.");
      return { ok: true, alreadyInstalled: true, version: existing.version };
    }

    const platform = process.platform;

    if (platform === "win32") {
      const msg = "Automatic install not supported on Windows. Please install from https://ollama.com/download";
      progress("error", msg);
      return { ok: false, error: msg };
    }

    if (platform === "darwin") {
      return await installViaBrew({ progress });
    }

    if (platform === "linux") {
      return await installViaScript({ progress });
    }

    const msg = `Unsupported platform: ${platform}`;
    progress("error", msg);
    return { ok: false, error: msg };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    progress("error", error);
    return { ok: false, error };
  }
}

/**
 * Start Ollama server as a detached background process.
 * @returns {Promise<{ ok: boolean, pid?: number, error?: string }>}
 */
export async function startOllamaServer() {
  try {
    const child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    const pid = child.pid;

    await new Promise((resolve) => setTimeout(resolve, STARTUP_WAIT_MS));

    const running = await isOllamaRunning();
    if (!running) {
      return { ok: false, error: "Server did not respond after startup" };
    }

    return { ok: true, pid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Stop the Ollama server process.
 * @returns {{ ok: boolean }}
 */
export function stopOllamaServer() {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/IM", "ollama.exe", "/F"]);
    } else {
      spawnSync("pkill", ["-x", "ollama"], { timeout: 5000 });
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Check if Ollama server is responding.
 * @returns {Promise<boolean>}
 */
export async function isOllamaRunning() {
  try {
    const res = await fetch(OLLAMA_PORT_URL, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    return res.ok || res.status > 0;
  } catch {
    return false;
  }
}

// -- Private helpers --

async function installViaBrew({ progress }) {
  const brew = spawnSync("which", ["brew"], { encoding: "utf8" });
  if (!brew.stdout?.trim()) {
    const msg =
      "Homebrew not found. Please install Ollama manually from https://ollama.com/download";
    progress("error", msg);
    return { ok: false, error: msg };
  }

  progress("downloading", "Installing Ollama via Homebrew...");
  return new Promise((resolve) => {
    const child = spawn("brew", ["install", "ollama"], { stdio: "pipe" });

    child.stdout.on("data", (d) =>
      progress("installing", d.toString().trim())
    );
    child.stderr.on("data", (d) =>
      progress("installing", d.toString().trim())
    );

    child.on("close", (code) => {
      if (code !== 0) {
        const error = `brew install ollama exited with code ${code}`;
        progress("error", error);
        return resolve({ ok: false, error });
      }
      progress("verifying", "Verifying installation...");
      const result = detectOllamaInstallation();
      if (!result.installed) {
        const error = "Installation succeeded but ollama binary not found";
        progress("error", error);
        return resolve({ ok: false, error });
      }
      progress("done", "Ollama installed successfully.");
      resolve({ ok: true, version: result.version });
    });

    child.on("error", (err) => {
      progress("error", err.message);
      resolve({ ok: false, error: err.message });
    });
  });
}

async function installViaScript({ progress }) {
  progress("downloading", "Downloading Ollama install script...");
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], {
      stdio: "pipe"
    });

    child.stdout.on("data", (d) =>
      progress("installing", d.toString().trim())
    );
    child.stderr.on("data", (d) =>
      progress("installing", d.toString().trim())
    );

    child.on("close", (code) => {
      if (code !== 0) {
        const error = `Install script exited with code ${code}`;
        progress("error", error);
        return resolve({ ok: false, error });
      }
      progress("verifying", "Verifying installation...");
      const result = detectOllamaInstallation();
      if (!result.installed) {
        const error = "Installation succeeded but ollama binary not found";
        progress("error", error);
        return resolve({ ok: false, error });
      }
      progress("done", "Ollama installed successfully.");
      resolve({ ok: true, version: result.version });
    });

    child.on("error", (err) => {
      progress("error", err.message);
      resolve({ ok: false, error: err.message });
    });
  });
}
