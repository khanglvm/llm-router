import path from "node:path";
import { promises as fs } from "node:fs";
import { estimateLlamacppRuntimeBytes } from "./llamacpp-runtime-profile.js";

const HUGGING_FACE_API_URL = "https://huggingface.co/api/models";
const HUGGING_FACE_BASE_URL = "https://huggingface.co";
const POTENTIAL_MODEL_ARTIFACT_PATTERN = /\.(gguf|safetensors|bin|pth|pt)$/i;
const DEFAULT_EXPECTED_CONTEXT_WINDOW = 200000;

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

function scoreQuantization(fileName) {
  const quantization = parseQuantizationFromFileName(fileName);
  if (!quantization) return 0;
  if (quantization.startsWith("Q5")) return 6;
  if (quantization.startsWith("IQ")) return 5;
  if (quantization === "Q4_K_M" || quantization === "Q4_K_S" || quantization.startsWith("Q4")) return 4;
  if (quantization.startsWith("Q6")) return 3;
  if (quantization.startsWith("Q8")) return 2;
  if (quantization === "BF16" || quantization === "F16" || quantization === "F32") return 1;
  return 1;
}

function buildCompatibilityBadges(fileName, fit, recommendation = "") {
  const badges = [];
  if (/\.gguf$/i.test(fileName)) badges.push("GGUF");
  badges.push("llama.cpp");
  if (fit === "safe") badges.push("Mac OK");
  else if (fit === "tight") badges.push("Mac Tight");
  else badges.push("Mac review");
  if (/best fit/i.test(recommendation)) badges.push("Best fit");
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
  const expectedContextWindow = normalizePositiveNumber(candidate?.expectedContextWindow) || DEFAULT_EXPECTED_CONTEXT_WINDOW;

  if (!/\.gguf$/i.test(fileName)) {
    return {
      fit: "unsupported",
      disabled: true,
      reason: "Not a GGUF file",
      recommendation: "Unsupported for llama.cpp in v1."
    };
  }

  if (sizeBytes && totalMemoryBytes && sizeBytes > Number(totalMemoryBytes) * 0.85) {
    return {
      fit: "over-budget",
      disabled: true,
      reason: "Too large for this Mac",
      recommendation: "Skip this one on a 64 GB Mac."
    };
  }

  if (!sizeBytes || !totalMemoryBytes) {
    return {
      fit: "unknown",
      disabled: false,
      reason: "",
      recommendation: "Review memory fit manually before download."
    };
  }

  const memoryRatio = sizeBytes / Number(totalMemoryBytes);
  const quantScore = scoreQuantization(fileName);

  if (expectedContextWindow >= 200000 && memoryRatio >= 0.5) {
    return {
      fit: "tight",
      disabled: false,
      reason: "200K context will be tight on this Mac",
      recommendation: quantScore >= 2
        ? "200K context needs review on a 64 GB Mac."
        : "Large context and heavy quantization choice need review."
    };
  }

  if (memoryRatio >= 0.4) {
    return {
      fit: "tight",
      disabled: false,
      reason: "Fits, but leaves limited unified memory headroom",
      recommendation: "Reasonable fit, but memory headroom will be tight."
    };
  }

  return {
    fit: "safe",
    disabled: false,
    reason: "",
    recommendation: quantScore >= 4
      ? "Best fit for a 64 GB Mac and long-context testing."
      : "Fits this Mac comfortably."
  };
}

export function shapeHuggingFaceGgufResults(files, systemInfo = {}) {
  const results = (Array.isArray(files) ? files : []).map((entry) => {
    const file = normalizeString(entry?.file || entry?.rfilename);
    const sizeBytes = normalizePositiveNumber(entry?.sizeBytes ?? entry?.size);
    const status = classifyGgufCandidateForMac({
      file,
      sizeBytes,
      expectedContextWindow: systemInfo?.expectedContextWindow
    }, systemInfo);
    const quantization = parseQuantizationFromFileName(file);
    const estimatedRuntimeBytes = sizeBytes
      ? estimateLlamacppRuntimeBytes({
        sizeBytes,
        contextWindow: systemInfo?.expectedContextWindow,
        preset: status.fit === "tight" ? "memory-safe" : "balanced"
      })
      : undefined;
    const fitScore = status.fit === "safe" ? 30 : status.fit === "tight" ? 15 : status.fit === "unknown" ? 8 : -20;
    const rankingScore = fitScore
      + (status.disabled ? -100 : 0)
      + (scoreQuantization(file) * 10)
      + Math.min(15, Math.log10(Number(entry?.downloads || 0) + 1) * 4)
      + Math.min(8, Math.log10(Number(entry?.likes || 0) + 1) * 3)
      - Math.min(12, (sizeBytes || 0) / (1024 ** 3));
    return {
      repo: normalizeString(entry?.repo || entry?.id || entry?.modelId),
      file,
      quantization,
      sizeBytes,
      estimatedRuntimeBytes,
      memoryLabel: estimatedRuntimeBytes
        ? `${(estimatedRuntimeBytes / (1024 ** 3)).toFixed(1)} GB runtime est.`
        : "Runtime estimate unavailable",
      disabled: status.disabled,
      disabledReason: status.reason,
      fit: status.fit,
      recommendation: status.recommendation,
      badges: buildCompatibilityBadges(file, status.fit, status.recommendation),
      rankingScore
    };
  });

  return results.sort((left, right) => {
    if (right.rankingScore !== left.rankingScore) return right.rankingScore - left.rankingScore;
    return String(left.file || "").localeCompare(String(right.file || ""));
  });
}

export async function searchHuggingFaceGgufCandidates(query, {
  limit = 20,
  totalMemoryBytes,
  expectedContextWindow = DEFAULT_EXPECTED_CONTEXT_WINDOW,
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
    { totalMemoryBytes, expectedContextWindow }
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
