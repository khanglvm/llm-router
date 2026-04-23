import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import {
  browseForLocalModelPath,
  scanLocalModelPath
} from "./local-model-browser.js";

test("scanLocalModelPath returns a single GGUF file selection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-local-model-browser-"));
  const filePath = path.join(dir, "qwen.Q5_K_M.gguf");
  await writeFile(filePath, "gguf", "utf8");

  try {
    const matches = await scanLocalModelPath(filePath);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].filePath, filePath);
    assert.equal(matches[0].fileName, "qwen.Q5_K_M.gguf");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanLocalModelPath recursively finds GGUF files inside a selected folder", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-router-local-model-browser-"));
  const nestedDir = path.join(dir, "nested");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(path.join(dir, "ignore.txt"), "skip", "utf8");
  await writeFile(path.join(nestedDir, "beta.Q4_K_M.gguf"), "gguf", "utf8");
  await writeFile(path.join(dir, "alpha.Q5_K_M.gguf"), "gguf", "utf8");

  try {
    const matches = await scanLocalModelPath(dir);
    assert.deepEqual(matches.map((entry) => entry.fileName), [
      "alpha.Q5_K_M.gguf",
      "beta.Q4_K_M.gguf"
    ]);
    assert.equal(matches.every((entry) => entry.filePath.endsWith(".gguf")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("browseForLocalModelPath uses native macOS picker output when available", async () => {
  const result = await browseForLocalModelPath({
    selection: "file"
  }, {
    platform: "darwin",
    execFileImpl: (_command, _args, _options, callback) => {
      callback(null, "/Volumes/models/qwen.Q5.gguf\n", "");
    }
  });

  assert.equal(result.canceled, false);
  assert.equal(result.path, "/Volumes/models/qwen.Q5.gguf");
  assert.equal(result.selection, "file");
});

test("browseForLocalModelPath returns canceled on non-macOS platforms", async () => {
  const result = await browseForLocalModelPath({
    selection: "file"
  }, {
    platform: "linux"
  });

  assert.equal(result.canceled, true);
  assert.match(result.reason, /macos/i);
});

test("browseForLocalModelPath supports runtime binary selection prompts", async () => {
  const result = await browseForLocalModelPath({
    selection: "runtime"
  }, {
    platform: "darwin",
    execFileImpl: (_command, _args, _options, callback) => {
      callback(null, "/Users/test/src/llama-cpp-turboquant/build/bin/llama-server\n", "");
    }
  });

  assert.equal(result.canceled, false);
  assert.equal(result.path, "/Users/test/src/llama-cpp-turboquant/build/bin/llama-server");
  assert.equal(result.selection, "runtime");
});
