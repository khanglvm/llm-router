import test from "node:test";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { resolveStartupCliEntryPath } from "./startup-manager.js";

async function makeTempTree() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-startup-manager-"));
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

test("resolveStartupCliEntryPath prefers the current CLI entry over a sibling global shim", async () => {
  const fixture = await makeTempTree();
  const binDir = path.join(fixture.dir, "bin");
  const localDir = path.join(fixture.dir, "repo", "src");
  const shimPath = path.join(binDir, "llm-router");
  const localCliPath = path.join(localDir, "cli-entry.js");

  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await writeFile(shimPath, "#!/usr/bin/env node\n", "utf8");
    await writeFile(localCliPath, "#!/usr/bin/env node\n", "utf8");

    const resolved = resolveStartupCliEntryPath({
      execPath: path.join(binDir, "node"),
      env: {},
      argv: ["node", localCliPath]
    });

    assert.equal(resolved, localCliPath);
  } finally {
    await fixture.cleanup();
  }
});

test("resolveStartupCliEntryPath prefers explicit LLM_ROUTER_CLI_PATH over argv and node-bin shims", async () => {
  const fixture = await makeTempTree();
  const binDir = path.join(fixture.dir, "bin");
  const envCliPath = path.join(fixture.dir, "custom", "llm-router.js");
  const argvCliPath = path.join(fixture.dir, "repo", "src", "cli-entry.js");
  const shimPath = path.join(binDir, "llm-router");

  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(path.dirname(envCliPath), { recursive: true });
    await mkdir(path.dirname(argvCliPath), { recursive: true });
    await writeFile(shimPath, "#!/usr/bin/env node\n", "utf8");
    await writeFile(envCliPath, "#!/usr/bin/env node\n", "utf8");
    await writeFile(argvCliPath, "#!/usr/bin/env node\n", "utf8");

    const resolved = resolveStartupCliEntryPath({
      execPath: path.join(binDir, "node"),
      env: { LLM_ROUTER_CLI_PATH: envCliPath },
      argv: ["node", argvCliPath]
    });

    assert.equal(resolved, envCliPath);
  } finally {
    await fixture.cleanup();
  }
});
