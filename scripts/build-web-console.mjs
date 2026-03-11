import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "..");
const stylesInput = path.join(repoDir, "src/node/web-console-ui/styles.css");
const stylesOutput = path.join(repoDir, ".web-console-styles.css");
const stylesModuleOutput = path.join(repoDir, "src/node/web-console-styles.generated.js");
const appEntry = path.join(repoDir, "src/node/web-console-ui/main.jsx");
const appOutput = path.join(repoDir, "src/node/web-console-client.js");

const cliCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const tailwind = spawnSync(cliCommand, ["@tailwindcss/cli", "-i", stylesInput, "-o", stylesOutput, "--minify", "--cwd", repoDir], {
  cwd: repoDir,
  stdio: "inherit"
});

if (tailwind.status !== 0) {
  process.exit(tailwind.status || 1);
}

const css = await readFile(stylesOutput, "utf8");
await writeFile(stylesModuleOutput, `export const WEB_CONSOLE_CSS = ${JSON.stringify(css)};\n`);
await rm(stylesOutput, { force: true });

await build({
  entryPoints: [appEntry],
  outfile: appOutput,
  bundle: true,
  format: "iife",
  jsx: "automatic",
  legalComments: "none",
  minify: true,
  platform: "browser",
  target: ["es2020"],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production")
  }
});
