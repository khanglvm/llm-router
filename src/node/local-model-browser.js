import path from "node:path";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";

const GGUF_PATTERN = /\.gguf$/i;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatScanEntry(filePath, stats = null) {
  return {
    filePath,
    fileName: path.basename(filePath),
    sizeBytes: Number.isFinite(Number(stats?.size)) ? Number(stats.size) : undefined
  };
}

async function collectGgufFiles(targetPath, entries = []) {
  const stats = await fs.stat(targetPath);
  if (stats.isFile()) {
    if (GGUF_PATTERN.test(targetPath)) entries.push(formatScanEntry(targetPath, stats));
    return entries;
  }

  if (!stats.isDirectory()) return entries;

  const children = await fs.readdir(targetPath, { withFileTypes: true });
  for (const child of children) {
    const childPath = path.join(targetPath, child.name);
    if (child.isDirectory()) {
      await collectGgufFiles(childPath, entries);
      continue;
    }
    if (!child.isFile() || !GGUF_PATTERN.test(child.name)) continue;
    const childStats = await fs.stat(childPath);
    entries.push(formatScanEntry(childPath, childStats));
  }
  return entries;
}

function buildBrowseAppleScript(selection) {
  if (selection === "directory") {
    return [
      "try",
      "POSIX path of (choose folder with prompt \"Select a folder to scan for GGUF files\")",
      "on error number -128",
      "return \"\"",
      "end try"
    ];
  }

  if (selection === "runtime") {
    return [
      "try",
      "POSIX path of (choose file with prompt \"Select a llama.cpp runtime binary (llama-server)\")",
      "on error number -128",
      "return \"\"",
      "end try"
    ];
  }

  return [
    "try",
    "POSIX path of (choose file with prompt \"Select a GGUF file\")",
    "on error number -128",
    "return \"\"",
    "end try"
  ];
}

export async function browseForLocalModelPath({
  selection = "file"
} = {}, {
  platform = process.platform,
  execFileImpl = execFile
} = {}) {
  if (platform !== "darwin") {
    return {
      canceled: true,
      reason: "Native local-model browse is currently available on macOS only.",
      selection
    };
  }

  const scriptLines = buildBrowseAppleScript(selection);
  const args = scriptLines.flatMap((line) => ["-e", line]);
  const result = await runExecFile(execFileImpl, "osascript", args, { encoding: "utf8" });
  const output = normalizeString(result?.stdout || "");
  if (!output) {
    return { canceled: true, selection };
  }

  return {
    canceled: false,
    selection,
    path: output
  };
}

export async function scanLocalModelPath(targetPath) {
  const resolvedPath = normalizeString(targetPath);
  if (!resolvedPath) return [];

  const matches = await collectGgufFiles(resolvedPath);
  return matches.sort((left, right) => left.fileName.localeCompare(right.fileName));
}
async function runExecFile(execFileImpl, command, args, options) {
  if (execFileImpl === execFile) {
    return new Promise((resolve, reject) => {
      execFile(command, args, options, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  }

  if (typeof execFileImpl !== "function") {
    throw new Error("execFile implementation is required.");
  }

  if (execFileImpl.length >= 4) {
    return new Promise((resolve, reject) => {
      execFileImpl(command, args, options, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  }

  return execFileImpl(command, args, options);
}
