import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promises as fs, watch as fsWatch } from "node:fs";
import { build, context as createEsbuildContext } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "../..");
const appEntry = path.join(repoDir, "src/node/web-console-ui/main.jsx");
const stylesInput = path.join(repoDir, "src/node/web-console-ui/styles.css");
const tailwindCli = process.platform === "win32" ? "npx.cmd" : "npx";

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createBuildErrorScript(label, error) {
  const lines = [`[llm-router] ${label} build error`, toErrorMessage(error)];
  const escaped = JSON.stringify(lines.join("\n\n"));
  return `(() => {
    const message = ${escaped};
    console.error(message);
    const pre = document.createElement("pre");
    pre.textContent = message;
    pre.style.whiteSpace = "pre-wrap";
    pre.style.padding = "24px";
    pre.style.margin = "0";
    pre.style.font = "14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace";
    pre.style.color = "#7f1d1d";
    pre.style.background = "#fff7ed";
    pre.style.minHeight = "100vh";
    document.body.innerHTML = "";
    document.body.appendChild(pre);
  })();`;
}

function buildEsbuildOptions(outputFile) {
  return {
    entryPoints: [appEntry],
    bundle: true,
    outfile: outputFile,
    write: true,
    format: "iife",
    jsx: "automatic",
    legalComments: "none",
    minify: false,
    platform: "browser",
    target: ["es2020"],
    sourcemap: "inline",
    define: {
      "process.env.NODE_ENV": JSON.stringify("development")
    }
  };
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function runProcess(command, args, { cwd, stdio = ["ignore", "ignore", "pipe"] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio });
    let stderr = "";

    child.once("error", reject);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code || 1}.`));
    });
  });
}

export async function startWebConsoleDevAssets({
  onChange,
  onError,
  cwd = repoDir
} = {}) {
  let closed = false;
  let appJs = 'console.info("[llm-router] Waiting for dev bundle…");';
  let stylesCss = "";
  let changeTimer = null;
  let esbuildContext = null;
  let cssWatcher = null;
  let tailwindProcess = null;
  let tempDir = "";

  const emitError = (message) => {
    if (typeof onError === "function") onError(message);
  };

  const scheduleChange = (kind) => {
    if (closed) return;
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = null;
      if (typeof onChange === "function") onChange({ kind, changedAt: new Date().toISOString() });
    }, 90);
  };

  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-web-dev-"));
  const appOutput = path.join(tempDir, "app.js");
  const stylesOutput = path.join(tempDir, "styles.css");

  async function refreshAppBundle(kind = "app") {
    const nextJs = await readTextIfExists(appOutput);
    if (!nextJs) {
      throw new Error("Web console bundle output is empty.");
    }
    appJs = nextJs;
    scheduleChange(kind);
  }

  async function rebuildAppBundle() {
    try {
      await build(buildEsbuildOptions(appOutput));
      await refreshAppBundle("app");
    } catch (error) {
      appJs = createBuildErrorScript("Web console", error);
      emitError(`Web console build error: ${toErrorMessage(error)}`);
      scheduleChange("app-error");
    }
  }

  async function refreshStyles(kind = "styles") {
    try {
      const nextCss = await readTextIfExists(stylesOutput);
      if (!nextCss) return;
      stylesCss = nextCss;
      scheduleChange(kind);
    } catch (error) {
      emitError(`Web console styles error: ${toErrorMessage(error)}`);
    }
  }

  async function buildStylesOnce() {
    await runProcess(tailwindCli, [
      "@tailwindcss/cli",
      "-i",
      stylesInput,
      "-o",
      stylesOutput,
      "--cwd",
      cwd
    ], { cwd });
    await refreshStyles("styles");
  }

  await rebuildAppBundle();
  await buildStylesOnce();

  esbuildContext = await createEsbuildContext({
    ...buildEsbuildOptions(appOutput),
    plugins: [
      {
        name: "llm-router-dev-refresh",
        setup(buildApi) {
          buildApi.onEnd(async (result) => {
            if (closed) return;
            if (Array.isArray(result.errors) && result.errors.length > 0) {
              const message = result.errors.map((entry) => entry.text).filter(Boolean).join("\n") || "Unknown esbuild error.";
              appJs = createBuildErrorScript("Web console", message);
              emitError(`Web console build error: ${message}`);
              scheduleChange("app-error");
              return;
            }

            try {
              await refreshAppBundle("app");
            } catch (error) {
              appJs = createBuildErrorScript("Web console", error);
              emitError(`Web console build error: ${toErrorMessage(error)}`);
              scheduleChange("app-error");
            }
          });
        }
      }
    ]
  });
  await esbuildContext.watch();

  tailwindProcess = spawn(tailwindCli, [
    "@tailwindcss/cli",
    "-i",
    stylesInput,
    "-o",
    stylesOutput,
    "--cwd",
    cwd,
    "--watch"
  ], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"]
  });

  tailwindProcess.once("error", (error) => {
    emitError(`Tailwind watch error: ${toErrorMessage(error)}`);
  });
  tailwindProcess.stderr?.on("data", (chunk) => {
    const message = String(chunk || "").trim();
    if (message) emitError(`Tailwind watch error: ${message}`);
  });

  cssWatcher = fsWatch(tempDir, (eventType, filename) => {
    if (closed) return;
    if (filename && String(filename) !== "styles.css") return;
    if ((eventType || "change") !== "rename" && (eventType || "change") !== "change") return;
    void refreshStyles("styles");
  });

  return {
    isDevMode: true,
    getAppJs() {
      return appJs;
    },
    getStylesCss() {
      return stylesCss;
    },
    async close() {
      if (closed) return;
      closed = true;

      if (changeTimer) {
        clearTimeout(changeTimer);
        changeTimer = null;
      }
      if (cssWatcher) {
        cssWatcher.close();
        cssWatcher = null;
      }
      if (tailwindProcess && tailwindProcess.exitCode === null) {
        tailwindProcess.kill("SIGTERM");
      }
      tailwindProcess = null;
      if (esbuildContext) {
        await esbuildContext.dispose();
        esbuildContext = null;
      }
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
        tempDir = "";
      }
    }
  };
}
