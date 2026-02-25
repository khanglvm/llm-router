/**
 * OS startup integration for llm-router.
 * Supports macOS LaunchAgent and Linux systemd --user service.
 */

import os from "node:os";
import path from "node:path";
import { promises as fs, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SERVICE_NAME = "llm-router";
const LAUNCH_AGENT_ID = "dev.llm-router";

function resolveDarwinDomain() {
  const uid = process.getuid?.();
  return uid !== undefined ? `gui/${uid}` : "gui/$(id -u)";
}

function quoteArg(value) {
  const escaped = String(value).replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function runCommand(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0"
    }
  });

  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error
  };
}

function resolveCliEntryPath() {
  if (process.env.LLM_ROUTER_CLI_PATH) return process.env.LLM_ROUTER_CLI_PATH;
  const nodeBinDir = path.dirname(process.execPath);
  for (const binName of ["llm-router", "llm-router-route"]) {
    const candidate = path.join(nodeBinDir, binName);
    if (existsSync(candidate)) return candidate;
  }
  if (process.argv[1]) return path.resolve(process.argv[1]);
  throw new Error("Unable to resolve llm-router CLI entry path.");
}

function makeExecArgs({ configPath, host, port, watchConfig, watchBinary, requireAuth }) {
  return [
    "start",
    `--config=${configPath}`,
    `--host=${host}`,
    `--port=${port}`,
    `--watch-config=${watchConfig ? "true" : "false"}`,
    `--watch-binary=${watchBinary ? "true" : "false"}`,
    `--require-auth=${requireAuth ? "true" : "false"}`
  ];
}

function buildLaunchAgentPlist({ nodePath, cliPath, configPath, host, port, watchConfig, watchBinary, requireAuth }) {
  const logDir = path.join(os.homedir(), "Library", "Logs");
  const stdoutPath = path.join(logDir, "llm-router.out.log");
  const stderrPath = path.join(logDir, "llm-router.err.log");
  const args = [nodePath, cliPath, ...makeExecArgs({ configPath, host, port, watchConfig, watchBinary, requireAuth })];

  const xmlArgs = args.map((arg) => `    <string>${arg}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_ID}</string>
    <key>ProgramArguments</key>
    <array>
${xmlArgs}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
      <key>LLM_ROUTER_MANAGED_BY_STARTUP</key>
      <string>1</string>
      <key>LLM_ROUTER_CLI_PATH</key>
      <string>${cliPath}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
    <key>WorkingDirectory</key>
    <string>${process.cwd()}</string>
  </dict>
</plist>
`;
}

function buildSystemdService({ nodePath, cliPath, configPath, host, port, watchConfig, watchBinary, requireAuth }) {
  const execArgs = makeExecArgs({ configPath, host, port, watchConfig, watchBinary, requireAuth }).map(quoteArg).join(" ");
  const execStart = `${quoteArg(nodePath)} ${quoteArg(cliPath)} ${execArgs}`;

  return `[Unit]
Description=LLM Router local route
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=2
Environment=NODE_ENV=production
Environment=LLM_ROUTER_MANAGED_BY_STARTUP=1
Environment=LLM_ROUTER_CLI_PATH=${cliPath}
WorkingDirectory=${process.cwd()}

[Install]
WantedBy=default.target
`;
}

async function installDarwin({ configPath, host, port, watchConfig, watchBinary, requireAuth }) {
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${LAUNCH_AGENT_ID}.plist`);
  const nodePath = process.execPath;
  const cliPath = resolveCliEntryPath();

  await fs.mkdir(launchAgentsDir, { recursive: true });
  await fs.mkdir(path.join(os.homedir(), "Library", "Logs"), { recursive: true });

  const content = buildLaunchAgentPlist({
    nodePath,
    cliPath,
    configPath,
    host,
    port,
    watchConfig,
    watchBinary,
    requireAuth
  });

  await fs.writeFile(plistPath, content, "utf8");

  const domain = resolveDarwinDomain();

  // Best effort reload sequence.
  runCommand("launchctl", ["bootout", domain, plistPath]);
  const bootstrap = runCommand("launchctl", ["bootstrap", domain, plistPath]);
  if (!bootstrap.ok) {
    throw new Error(bootstrap.stderr || bootstrap.stdout || "launchctl bootstrap failed.");
  }

  runCommand("launchctl", ["enable", `${domain}/${LAUNCH_AGENT_ID}`]);

  return {
    manager: "launchd",
    serviceId: LAUNCH_AGENT_ID,
    filePath: plistPath
  };
}

async function uninstallDarwin() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_ID}.plist`);
  const domain = resolveDarwinDomain();

  runCommand("launchctl", ["bootout", domain, plistPath]);

  try {
    await fs.unlink(plistPath);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }

  return {
    manager: "launchd",
    serviceId: LAUNCH_AGENT_ID,
    filePath: plistPath
  };
}

async function statusDarwin() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_ID}.plist`);
  let installed = true;
  try {
    await fs.access(plistPath);
  } catch {
    installed = false;
  }

  const domain = resolveDarwinDomain();
  const listResult = runCommand("launchctl", ["print", `${domain}/${LAUNCH_AGENT_ID}`]);

  return {
    manager: "launchd",
    serviceId: LAUNCH_AGENT_ID,
    installed,
    running: listResult.ok,
    filePath: plistPath,
    detail: listResult.ok ? listResult.stdout : (listResult.stderr || listResult.stdout)
  };
}

async function stopDarwin() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_ID}.plist`);
  const domain = resolveDarwinDomain();
  runCommand("launchctl", ["bootout", domain, plistPath]);
  return statusDarwin();
}

async function restartDarwin() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_ID}.plist`);
  await fs.access(plistPath);
  const domain = resolveDarwinDomain();
  runCommand("launchctl", ["bootout", domain, plistPath]);
  const bootstrap = runCommand("launchctl", ["bootstrap", domain, plistPath]);
  if (!bootstrap.ok) {
    throw new Error(bootstrap.stderr || bootstrap.stdout || "launchctl bootstrap failed.");
  }
  runCommand("launchctl", ["enable", `${domain}/${LAUNCH_AGENT_ID}`]);
  return statusDarwin();
}

async function installLinux({ configPath, host, port, watchConfig, watchBinary, requireAuth }) {
  const systemdDir = path.join(os.homedir(), ".config", "systemd", "user");
  const servicePath = path.join(systemdDir, `${SERVICE_NAME}.service`);
  const nodePath = process.execPath;
  const cliPath = resolveCliEntryPath();

  await fs.mkdir(systemdDir, { recursive: true });
  const content = buildSystemdService({
    nodePath,
    cliPath,
    configPath,
    host,
    port,
    watchConfig,
    watchBinary,
    requireAuth
  });
  await fs.writeFile(servicePath, content, "utf8");

  const daemonReload = runCommand("systemctl", ["--user", "daemon-reload"]);
  if (!daemonReload.ok) {
    throw new Error(daemonReload.stderr || daemonReload.stdout || "systemctl daemon-reload failed.");
  }
  const enableNow = runCommand("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`]);
  if (!enableNow.ok) {
    throw new Error(enableNow.stderr || enableNow.stdout || "systemctl enable --now failed.");
  }

  return {
    manager: "systemd-user",
    serviceId: `${SERVICE_NAME}.service`,
    filePath: servicePath
  };
}

async function uninstallLinux() {
  const servicePath = path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  runCommand("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.service`]);
  runCommand("systemctl", ["--user", "daemon-reload"]);

  try {
    await fs.unlink(servicePath);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }

  return {
    manager: "systemd-user",
    serviceId: `${SERVICE_NAME}.service`,
    filePath: servicePath
  };
}

async function statusLinux() {
  const servicePath = path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  let installed = true;
  try {
    await fs.access(servicePath);
  } catch {
    installed = false;
  }

  const isActive = runCommand("systemctl", ["--user", "is-active", `${SERVICE_NAME}.service`]);
  return {
    manager: "systemd-user",
    serviceId: `${SERVICE_NAME}.service`,
    installed,
    running: isActive.ok && isActive.stdout.trim() === "active",
    filePath: servicePath,
    detail: isActive.stdout || isActive.stderr
  };
}

async function stopLinux() {
  runCommand("systemctl", ["--user", "stop", `${SERVICE_NAME}.service`]);
  return statusLinux();
}

async function restartLinux() {
  const servicePath = path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  await fs.access(servicePath);
  const restart = runCommand("systemctl", ["--user", "restart", `${SERVICE_NAME}.service`]);
  if (!restart.ok) {
    const start = runCommand("systemctl", ["--user", "start", `${SERVICE_NAME}.service`]);
    if (!start.ok) {
      throw new Error(start.stderr || start.stdout || restart.stderr || restart.stdout || "systemctl restart failed.");
    }
  }
  return statusLinux();
}

export async function installStartup(options) {
  const payload = {
    configPath: options.configPath,
    host: options.host || "127.0.0.1",
    port: options.port || 8787,
    watchConfig: options.watchConfig !== false,
    watchBinary: options.watchBinary !== false,
    requireAuth: options.requireAuth === true
  };

  if (process.platform === "darwin") return installDarwin(payload);
  if (process.platform === "linux") return installLinux(payload);

  throw new Error(`OS startup is not supported on platform '${process.platform}' yet.`);
}

export async function uninstallStartup() {
  if (process.platform === "darwin") return uninstallDarwin();
  if (process.platform === "linux") return uninstallLinux();
  throw new Error(`OS startup is not supported on platform '${process.platform}' yet.`);
}

export async function startupStatus() {
  if (process.platform === "darwin") return statusDarwin();
  if (process.platform === "linux") return statusLinux();
  return {
    manager: "unsupported",
    serviceId: SERVICE_NAME,
    installed: false,
    running: false,
    detail: `Platform '${process.platform}' is not supported yet.`
  };
}

export async function stopStartup() {
  if (process.platform === "darwin") return stopDarwin();
  if (process.platform === "linux") return stopLinux();
  throw new Error(`OS startup is not supported on platform '${process.platform}' yet.`);
}

export async function restartStartup() {
  if (process.platform === "darwin") return restartDarwin();
  if (process.platform === "linux") return restartLinux();
  throw new Error(`OS startup is not supported on platform '${process.platform}' yet.`);
}
