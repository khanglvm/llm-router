import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getActiveRuntimeState } from "./instance-state.js";

const PKG_NAME = "@khanglvm/llm-router";
const GRACEFUL_RESTART_SIGNAL = "SIGUSR2";

function readInstalledVersion() {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function fetchLatestVersion(exec = execSync) {
  try {
    return exec(`npm view ${PKG_NAME} version`, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function detectPackageManager(exec = execSync) {
  try {
    const npmGlobalRoot = exec("npm root -g", { encoding: "utf8" }).trim();
    const entryReal = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    if (entryReal.startsWith(npmGlobalRoot)) return "npm";
  } catch {
    // ignore
  }

  try {
    const out = exec("pnpm list -g --json 2>/dev/null", { encoding: "utf8" });
    if (out.includes(PKG_NAME)) return "pnpm";
  } catch {
    // ignore
  }

  return "npm";
}

function requestGracefulRuntimeRestart(runtime, signalProcess = process.kill) {
  const pid = Number(runtime?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "Invalid runtime pid." };
  }

  try {
    signalProcess(pid, GRACEFUL_RESTART_SIGNAL);
    return { ok: true, signal: GRACEFUL_RESTART_SIGNAL };
  } catch (restartError) {
    return {
      ok: false,
      reason: restartError instanceof Error ? restartError.message : String(restartError)
    };
  }
}

export async function runUpgradeCommand({ onLine, onError } = {}, deps = {}) {
  const line = typeof onLine === "function" ? onLine : (msg) => console.log(msg);
  const error = typeof onError === "function" ? onError : (msg) => console.error(msg);
  const exec = typeof deps.exec === "function" ? deps.exec : execSync;
  const readInstalledVersionFn = typeof deps.readInstalledVersion === "function"
    ? deps.readInstalledVersion
    : readInstalledVersion;
  const fetchLatestVersionFn = typeof deps.fetchLatestVersion === "function"
    ? deps.fetchLatestVersion
    : () => fetchLatestVersion(exec);
  const detectPackageManagerFn = typeof deps.detectPackageManager === "function"
    ? deps.detectPackageManager
    : () => detectPackageManager(exec);
  const getActiveRuntimeStateFn = typeof deps.getActiveRuntimeState === "function"
    ? deps.getActiveRuntimeState
    : getActiveRuntimeState;
  const signalProcess = typeof deps.signalProcess === "function"
    ? deps.signalProcess
    : process.kill;

  const currentVersion = readInstalledVersionFn();
  line(`Current version: ${currentVersion}`);

  line("Checking for updates...");
  const latestVersion = fetchLatestVersionFn();
  if (!latestVersion) {
    error("Could not fetch the latest version from the npm registry.");
    return { ok: false, exitCode: 1 };
  }

  if (latestVersion === currentVersion) {
    line(`Already on the latest version (${currentVersion}).`);
    return { ok: true, exitCode: 0 };
  }

  line(`New version available: ${currentVersion} -> ${latestVersion}`);

  let runtime = null;
  try {
    runtime = await getActiveRuntimeStateFn();
  } catch {
    runtime = null;
  }

  if (runtime) {
    line(`Running router detected (pid ${runtime.pid}) at http://${runtime.host}:${runtime.port}.`);
    line("The router will keep serving current requests while the package upgrade runs.");
  } else {
    line("No running local router detected. The new version will be used on the next start.");
  }

  const pm = detectPackageManagerFn();
  const installCmd = pm === "pnpm"
    ? `pnpm add -g ${PKG_NAME}@latest`
    : `npm install -g ${PKG_NAME}@latest`;

  line(`Upgrading via: ${installCmd}`);
  try {
    exec(installCmd, { stdio: "inherit" });
  } catch {
    error("Upgrade failed. The running router was left untouched. You may need sudo or corrected npm permissions.");
    return { ok: false, exitCode: 1 };
  }

  line(`Upgraded package to ${latestVersion}.`);

  if (!runtime) {
    return { ok: true, exitCode: 0 };
  }

  const restartResult = requestGracefulRuntimeRestart(runtime, signalProcess);
  if (restartResult.ok) {
    line(`Requested a graceful router reload (pid ${runtime.pid}).`);
    line("Existing requests will drain before the new version takes over.");
    return { ok: true, exitCode: 0 };
  }

  error(`Could not trigger an immediate graceful router reload: ${restartResult.reason || "unknown error"}`);
  if (runtime.watchBinary) {
    line("The running router is still serving traffic and should self-reload when its binary watcher detects the new version.");
  } else {
    line("Binary update watch is disabled for the running router. Restart it manually with `llr start` to activate the new version.");
  }

  return { ok: true, exitCode: 0 };
}

export {
  detectPackageManager,
  fetchLatestVersion,
  readInstalledVersion,
  requestGracefulRuntimeRestart
};
