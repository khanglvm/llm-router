import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getActiveRuntimeState,
  stopProcessByPid,
  clearRuntimeState,
  spawnDetachedStart
} from "./instance-state.js";

const PKG_NAME = "@khanglvm/llm-router";

function readInstalledVersion() {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function fetchLatestVersion() {
  try {
    return execSync(`npm view ${PKG_NAME} version`, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function detectPackageManager() {
  try {
    const npmGlobalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    const entryReal = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    if (entryReal.startsWith(npmGlobalRoot)) return "npm";
  } catch { /* ignore */ }

  try {
    const out = execSync("pnpm list -g --json 2>/dev/null", { encoding: "utf8" });
    if (out.includes(PKG_NAME)) return "pnpm";
  } catch { /* ignore */ }

  return "npm";
}

export async function runUpgradeCommand({ onLine, onError } = {}) {
  const line = typeof onLine === "function" ? onLine : (msg) => console.log(msg);
  const error = typeof onError === "function" ? onError : (msg) => console.error(msg);

  const currentVersion = readInstalledVersion();
  line(`Current version: ${currentVersion}`);

  // Check latest
  line("Checking for updates...");
  const latestVersion = fetchLatestVersion();
  if (!latestVersion) {
    error("Could not fetch latest version from npm registry.");
    return { ok: false, exitCode: 1 };
  }

  if (latestVersion === currentVersion) {
    line(`Already on the latest version (${currentVersion}).`);
    return { ok: true, exitCode: 0 };
  }

  line(`New version available: ${currentVersion} → ${latestVersion}`);

  // Stop running instance
  let wasRunning = false;
  let savedState = null;
  try {
    const runtime = await getActiveRuntimeState();
    if (runtime) {
      wasRunning = true;
      savedState = { ...runtime };
      line(`Stopping running server (pid ${runtime.pid})...`);
      const stopResult = await stopProcessByPid(runtime.pid);
      if (stopResult.ok) {
        await clearRuntimeState({ pid: runtime.pid });
        line("Server stopped.");
      } else {
        error(`Warning: could not stop server cleanly — ${stopResult.reason || "unknown"}`);
      }
    }
  } catch {
    // instance-state not available, skip
  }

  // Install latest
  const pm = detectPackageManager();
  const installCmd = pm === "pnpm"
    ? `pnpm add -g ${PKG_NAME}@latest`
    : `npm install -g ${PKG_NAME}@latest`;

  line(`Upgrading via: ${installCmd}`);
  try {
    execSync(installCmd, { stdio: "inherit" });
  } catch {
    error("Upgrade failed. You may need to run with sudo or fix npm permissions.");
    return { ok: false, exitCode: 1 };
  }

  const newVersion = fetchLatestVersion() || latestVersion;
  line(`Upgraded to ${newVersion}.`);

  // Restart server if it was running
  if (wasRunning && savedState) {
    line("Restarting server...");
    try {
      spawnDetachedStart({
        cliPath: savedState.cliPath || "",
        configPath: savedState.configPath || "",
        host: savedState.host || "127.0.0.1",
        port: savedState.port || 18080,
        watchConfig: savedState.watchConfig ?? true,
        watchBinary: savedState.watchBinary ?? true,
        requireAuth: savedState.requireAuth ?? false,
      });
      line("Server restarted.");
    } catch (err) {
      error(`Could not restart server: ${err instanceof Error ? err.message : String(err)}`);
      line("Start manually with: llr start");
    }
  }

  return { ok: true, exitCode: 0 };
}
