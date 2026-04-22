import path from "node:path";
import { promises as fs } from "node:fs";

const HUGGING_FACE_API_URL = "https://huggingface.co/api/models";
const HUGGING_FACE_BASE_URL = "https://huggingface.co";
const POTENTIAL_MODEL_ARTIFACT_PATTERN = /\.(gguf|safetensors|bin|pth|pt)$/i;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseQuantizationFromFileName(fileName) {
  const match = String(fileName || "").match(/(UD-[A-Z0-9_]+|IQ\d+_[A-Z]+|Q\d+_[A-Z0-9]+|Q\d+_0|MXFP4_MOE|BF16|F16|F32)/i);
  return match ? match[1].toUpperCase() : "";
}

function buildCompatibilityBadges(fileName, fit) {
  const badges = [];
  if (/\.gguf$/i.test(fileName)) badges.push("GGUF");
  badges.push("llama.cpp");
  badges.push(fit === "safe" ? "Mac OK" : "Mac review");
  return badges;
}

function isPotentialModelArtifact(fileName) {
  return POTENTIAL_MODEL_ARTIFACT_PATTERN.test(String(fileName || ""));
}

function encodePathSegments(rawPath) {
  return String(rawPath || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function extractHuggingFaceFiles(models = []) {
  const files = [];
  for (const model of Array.isArray(models) ? models : []) {
    const repo = normalizeString(model?.id || model?.modelId);
    if (!repo) continue;
    for (const sibling of Array.isArray(model?.siblings) ? model.siblings : []) {
      const file = normalizeString(sibling?.rfilename);
      if (!file || !isPotentialModelArtifact(file)) continue;
      files.push({
        repo,
        file,
        size: normalizePositiveNumber(sibling?.size) ?? normalizePositiveNumber(sibling?.lfs?.size),
        downloads: normalizePositiveNumber(model?.downloads) || 0,
        likes: normalizePositiveNumber(model?.likes) || 0,
        gguf: model?.gguf || undefined,
        private: model?.private === true,
        gated: model?.gated === true
      });
    }
  }
  return files;
}

export function classifyGgufCandidateForMac(candidate, { totalMemoryBytes } = {}) {
  const fileName = normalizeString(candidate?.file || candidate?.rfilename);
  const sizeBytes = normalizePositiveNumber(candidate?.sizeBytes ?? candidate?.size);

  if (!/\.gguf$/i.test(fileName)) {
    return { fit: "unsupported", disabled: true, reason: "Not a GGUF file" };
  }

  if (sizeBytes && totalMemoryBytes && sizeBytes > Number(totalMemoryBytes) * 0.85) {
    return { fit: "over-budget", disabled: true, reason: "Too large for this Mac" };
  }

  if (!sizeBytes || !totalMemoryBytes) {
    return { fit: "unknown", disabled: false, reason: "" };
  }

  return { fit: "safe", disabled: false, reason: "" };
}

export function shapeHuggingFaceGgufResults(files, systemInfo = {}) {
  return (Array.isArray(files) ? files : []).map((entry) => {
    const file = normalizeString(entry?.file || entry?.rfilename);
    const sizeBytes = normalizePositiveNumber(entry?.sizeBytes ?? entry?.size);
    const status = classifyGgufCandidateForMac({ file, sizeBytes }, systemInfo);
    return {
      repo: normalizeString(entry?.repo || entry?.id || entry?.modelId),
      file,
      quantization: parseQuantizationFromFileName(file),
      sizeBytes,
      disabled: status.disabled,
      disabledReason: status.reason,
      fit: status.fit,
      badges: buildCompatibilityBadges(file, status.fit)
    };
  });
}

export async function searchHuggingFaceGgufCandidates(query, {
  limit = 20,
  totalMemoryBytes,
  fetchImpl = fetch
} = {}) {
  const search = normalizeString(query);
  const url = new URL(HUGGING_FACE_API_URL);
  if (search) url.searchParams.set("search", search);
  url.searchParams.set("limit", String(Math.max(1, Math.min(50, Number(limit) || 20))));
  for (const field of ["siblings", "gguf", "downloads", "likes", "gated", "private"]) {
    url.searchParams.append("expand[]", field);
  }

  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`Hugging Face search failed (${response.status}).`);
  }

  const payload = await response.json();
  return shapeHuggingFaceGgufResults(
    extractHuggingFaceFiles(payload),
    { totalMemoryBytes }
  );
}

export function buildHuggingFaceFileDownloadUrl(repo, file) {
  const normalizedRepo = encodePathSegments(repo);
  const normalizedFile = encodePathSegments(file);
  return `${HUGGING_FACE_BASE_URL}/${normalizedRepo}/resolve/main/${normalizedFile}?download=true`;
}

export async function downloadManagedHuggingFaceGguf({
  repo,
  file,
  destinationPath
} = {}, {
  fetchImpl = fetch,
  onProgress = () => {}
} = {}) {
  const targetRepo = normalizeString(repo);
  const targetFile = normalizeString(file);
  const outputPath = normalizeString(destinationPath);
  if (!targetRepo || !targetFile || !outputPath) {
    throw new Error("repo, file, and destinationPath are required.");
  }

  const url = buildHuggingFaceFileDownloadUrl(targetRepo, targetFile);
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/octet-stream"
    }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Hugging Face download failed (${response.status}).`);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.part`;
  const fileHandle = await fs.open(tempPath, "w");
  const totalBytes = normalizePositiveNumber(response.headers.get("content-length"));
  let receivedBytes = 0;

  try {
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value || new Uint8Array();
      if (chunk.byteLength > 0) {
        await fileHandle.write(chunk);
        receivedBytes += chunk.byteLength;
        onProgress({ receivedBytes, totalBytes });
      }
    }
  } finally {
    await fileHandle.close();
  }

  await fs.rename(tempPath, outputPath);
  return {
    filePath: outputPath,
    sizeBytes: receivedBytes || totalBytes || undefined,
    downloadUrl: url
  };
}
