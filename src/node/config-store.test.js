import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import {
  getDefaultDevConfigPath,
  readConfigFileState,
  readConfigFile,
  writeConfigFile
} from "./config-store.js";
import { DEFAULT_MODEL_ALIAS_ID } from "../runtime/config.js";
import { LOCAL_ROUTER_PORT } from "../shared/local-router-defaults.js";

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
  assert.deepEqual(Object.keys(loaded.modelAliases), [DEFAULT_MODEL_ALIAS_ID]);
  assert.deepEqual(
    loaded.modelAliases[DEFAULT_MODEL_ALIAS_ID].targets.map((target) => target.ref),
    ["openrouter/gpt-4o-mini"]
  );
  assert.deepEqual(loaded.providers[0].rateLimits, []);

  const rereadRaw = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(rereadRaw.version, 2);
  assert.deepEqual(Object.keys(rereadRaw.modelAliases || {}), [DEFAULT_MODEL_ALIAS_ID]);
});

test("getDefaultDevConfigPath points to the dedicated dev config file", () => {
  assert.equal(path.basename(getDefaultDevConfigPath()), ".llm-router-dev.json");
});

test("readConfigFileState reports migration details for legacy config reads", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-config-store-test-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const configPath = path.join(tempDir, "config.json");
  await fs.writeFile(configPath, `${JSON.stringify(createLegacyV1Config(), null, 2)}\n`, "utf8");

  const state = await readConfigFileState(configPath);

  assert.equal(state.exists, true);
  assert.equal(state.changed, true);
  assert.equal(state.persisted, true);
  assert.equal(state.persistError, undefined);
  assert.equal(state.beforeVersion, 1);
  assert.equal(state.afterVersion, 2);
  assert.equal(state.config.version, 2);
});

test("readConfigFileState returns a normalized default draft for a missing config file", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-config-store-test-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const configPath = path.join(tempDir, "missing.json");

  const state = await readConfigFileState(configPath);

  assert.equal(state.exists, false);
  assert.equal(state.changed, false);
  assert.equal(state.persisted, false);
  assert.equal(state.beforeVersion, undefined);
  assert.equal(state.afterVersion, 2);
  assert.equal(state.config.version, 2);
  assert.deepEqual(Object.keys(state.config.modelAliases || {}), [DEFAULT_MODEL_ALIAS_ID]);
  await fs.access(configPath).then(
    () => assert.fail("missing config draft should not create a file on disk"),
    (error) => assert.equal(error?.code, "ENOENT")
  );
});

test("readConfigFileState keeps migrated config in memory when persisting fails", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-config-store-test-"));
  const configPath = path.join(tempDir, "config.json");
  await fs.writeFile(configPath, `${JSON.stringify(createLegacyV1Config(), null, 2)}\n`, "utf8");
  await fs.chmod(configPath, 0o400);

  t.after(async () => {
    await fs.chmod(configPath, 0o600).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const state = await readConfigFileState(configPath);

  assert.equal(state.exists, true);
  assert.equal(state.changed, true);
  assert.equal(state.persisted, false);
  assert.equal(state.beforeVersion, 1);
  assert.equal(state.afterVersion, 2);
  assert.equal(state.config.version, 2);
  assert.equal(Boolean(state.persistError), true);

  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.modelAliases, undefined);
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

test("readConfigFile strips persisted local router host and port metadata", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-config-store-test-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const configPath = path.join(tempDir, "config.json");

  await fs.writeFile(configPath, `${JSON.stringify({
    ...createLegacyV1Config(),
    version: 2,
    metadata: {
      localServer: {
        host: "0.0.0.0",
        port: 8787,
        requireAuth: true
      }
    }
  }, null, 2)}\n`, "utf8");

  const loaded = await readConfigFile(configPath);
  assert.equal(loaded.metadata?.localServer?.host, undefined);
  assert.equal(loaded.metadata?.localServer?.port, undefined);
  assert.equal(loaded.metadata?.localServer?.requireAuth, true);

  const rereadRaw = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(rereadRaw.metadata?.localServer?.host, undefined);
  assert.equal(rereadRaw.metadata?.localServer?.port, undefined);
  assert.equal(rereadRaw.metadata?.localServer?.requireAuth, true);
  assert.equal(LOCAL_ROUTER_PORT, 8376);
});
