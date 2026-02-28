import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import {
  readConfigFile,
  writeConfigFile
} from "./config-store.js";

function createLegacyV1Config() {
  return {
    version: 1,
    defaultModel: "openrouter/gpt-4o-mini",
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        format: "openai",
        models: [
          { id: "gpt-4o-mini" }
        ]
      }
    ]
  };
}

test("readConfigFile auto-migrates v1 config to latest schema and persists silently", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-config-store-test-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const configPath = path.join(tempDir, "config.json");
  await fs.writeFile(configPath, `${JSON.stringify(createLegacyV1Config(), null, 2)}\n`, "utf8");

  const loaded = await readConfigFile(configPath);
  assert.equal(loaded.version, 2);
  assert.deepEqual(loaded.modelAliases, {});
  assert.deepEqual(loaded.providers[0].rateLimits, []);

  const rereadRaw = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(rereadRaw.version, 2);
});

test("writeConfigFile upgrades version when writing v1 with v2 fields", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-config-store-test-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const configPath = path.join(tempDir, "config.json");

  const v1WithV2Fields = {
    ...createLegacyV1Config(),
    version: 1,
    modelAliases: {
      "chat.default": {
        targets: [{ ref: "openrouter/gpt-4o-mini" }]
      }
    }
  };
  const written = await writeConfigFile(v1WithV2Fields, configPath);
  assert.equal(written.version, 2);

  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(raw.version, 2);
});
