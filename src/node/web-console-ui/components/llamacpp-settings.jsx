import { useEffect, useMemo, useState } from "react";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Card, CardContent } from "./ui/card.jsx";
import { Input } from "./ui/input.jsx";
import { Switch } from "./ui/switch.jsx";
import { Field, Modal } from "./shared.jsx";
import { formatContextWindow } from "../context-window-utils.js";
import {
  browseLocalModelPath,
  discoverLlamacppRuntime,
  scanLocalModelPath,
  searchHuggingFaceGguf
} from "../api-client.js";
import {
  buildAttachedLocalModelDraft,
  buildEditableLlamacppVariantDraft,
  buildLlamacppVariantDraft,
  buildManagedLocalModelDraft,
  LLAMACPP_VARIANT_PRESETS,
  normalizeLocalVariantContextWindow,
  resolveLocalVariantSaveDisabledReason
} from "../local-models-utils.js";
import { LocalModelVariantEditor } from "./local-model-variant-editor.jsx";

function formatRuntimeStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return { label: "Needs validation", variant: "outline" };
  if (normalized === "running") return { label: "Running", variant: "success" };
  if (normalized === "stale") return { label: "Stale runtime", variant: "warning" };
  if (normalized === "invalid") return { label: "Invalid runtime", variant: "warning" };
  if (normalized === "stopped") return { label: "Stopped", variant: "outline" };
  return { label: normalized, variant: "outline" };
}

function formatAvailability(availability) {
  const normalized = String(availability || "").trim().toLowerCase();
  if (!normalized || normalized === "available") return { label: "Available", variant: "success" };
  if (normalized === "stale") return { label: "Stale", variant: "warning" };
  if (normalized === "missing") return { label: "Missing", variant: "warning" };
  if (normalized === "invalid") return { label: "Invalid", variant: "warning" };
  return { label: normalized, variant: "outline" };
}

function formatCapacityState(capacityState) {
  const normalized = String(capacityState || "").trim().toLowerCase();
  if (!normalized || normalized === "safe") return { label: "Safe", variant: "success" };
  if (normalized === "tight") return { label: "Tight", variant: "warning" };
  if (normalized === "over-budget") return { label: "Over budget", variant: "danger" };
  return { label: normalized, variant: "outline" };
}

function formatSource(source) {
  return String(source || "").includes("managed") ? "Managed" : "Attached";
}

function formatBytes(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = normalized;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const rendered = size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1);
  return `${rendered} ${units[unitIndex]}`;
}

function looksLikeGgufPath(filePath) {
  return /\.gguf$/i.test(String(filePath || "").trim());
}

function deriveParentPath(filePath) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return "";
  const slashIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return slashIndex > 0 ? normalized.slice(0, slashIndex) : "";
}

function RuntimeCandidateRow({ candidate, busy = false, onUseRuntime }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-foreground">{candidate?.label || candidate?.path}</div>
            <Badge variant="outline">{candidate?.source || "path"}</Badge>
            {candidate?.isTurboQuant ? <Badge variant="warning">TurboQuant</Badge> : null}
            {candidate?.current ? <Badge variant="success">Configured</Badge> : null}
            <Badge variant={candidate?.ok === false ? "warning" : "outline"}>
              {candidate?.ok === false ? "Needs review" : "Detected"}
            </Badge>
          </div>
          <div className="break-all font-mono text-xs text-muted-foreground">{candidate?.path}</div>
          {candidate?.directory ? (
            <div className="font-mono text-xs text-muted-foreground/80">Dir: {candidate.directory}</div>
          ) : null}
          {candidate?.errorMessage ? (
            <div className="text-xs text-amber-900">{candidate.errorMessage}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onUseRuntime?.(candidate?.path)}
            disabled={busy || candidate?.current === true || candidate?.ok === false}
          >
            {candidate?.current === true ? "Selected" : (busy ? "Selecting…" : "Use runtime")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function LibraryRow({
  entry,
  variantCount = 0,
  disabledReason = "",
  busy = false,
  onCreateVariant,
  onLocateModel,
  onRemoveModel
}) {
  const availability = formatAvailability(entry?.availability);
  const sizeLabel = formatBytes(entry?.metadata?.sizeBytes);
  const managedRepo = String(entry?.metadata?.repo || "").trim();
  const managedFile = String(entry?.metadata?.file || "").trim();
  const canCreateVariant = !disabledReason && availability.label === "Available";
  const showLocate = availability.label !== "Available";

  return (
    <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-foreground">{entry?.displayName || entry?.id}</div>
            <Badge variant="outline">{formatSource(entry?.source)}</Badge>
            <Badge variant={availability.variant}>{availability.label}</Badge>
            {sizeLabel ? <Badge variant="outline">{sizeLabel}</Badge> : null}
          </div>
          <div className="break-all font-mono text-xs text-muted-foreground">{entry?.path || "Path not recorded"}</div>
          {managedRepo || managedFile ? (
            <div className="text-xs text-muted-foreground">
              {managedRepo ? managedRepo : "Managed file"}
              {managedFile ? ` • ${managedFile}` : ""}
            </div>
          ) : null}
          <div className="text-xs text-muted-foreground">
            {variantCount} variant{variantCount === 1 ? "" : "s"} attached to this base model.
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => onCreateVariant?.(entry)}
            disabled={!canCreateVariant || busy}
          >
            Create variant
          </Button>
          {showLocate ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onLocateModel?.(entry)}
              disabled={Boolean(disabledReason) || busy}
            >
              Locate model
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => onRemoveModel?.(entry)}
            disabled={Boolean(disabledReason) || busy}
          >
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}

function VariantRow({ variant, baseModel, runtimeStatus, onEdit }) {
  const availability = formatAvailability(variant?.availability || baseModel?.availability);
  const capacity = formatCapacityState(variant?.capacityState);
  const runtimeLabel = availability.label !== "Available"
    ? availability.label
    : (String(runtimeStatus?.label || "").trim() || "Stopped");

  return (
    <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-foreground">{variant?.name || variant?.id}</div>
            <Badge variant={variant?.enabled === true ? "success" : "outline"}>
              {variant?.enabled === true ? "Enabled" : "Disabled"}
            </Badge>
            {variant?.preload === true ? <Badge variant="warning">Preload</Badge> : null}
            <Badge variant={capacity.variant}>{capacity.label}</Badge>
            <Badge variant={availability.variant}>{availability.label}</Badge>
          </div>
          <div className="font-mono text-xs text-muted-foreground">{variant?.id || "Missing model id"}</div>
          <div className="text-xs text-muted-foreground">
            Base model: {baseModel?.displayName || baseModel?.id || variant?.baseModelId} • Context: {formatContextWindow(variant?.contextWindow)}
          </div>
          <div className="text-xs text-muted-foreground">Runtime state: {runtimeLabel}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => onEdit?.(variant)}>
            Edit
          </Button>
        </div>
      </div>
    </div>
  );
}

function SearchResultRow({ result, downloading = false, onDownload }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-foreground">{result.file}</div>
            {result.quantization ? <Badge variant="outline">{result.quantization}</Badge> : null}
            {(result.badges || []).map((badge) => (
              <Badge key={`${result.repo}:${result.file}:${badge}`} variant="outline">{badge}</Badge>
            ))}
          </div>
          <div className="text-xs text-muted-foreground">{result.repo}</div>
          {result.sizeBytes ? <div className="text-xs text-muted-foreground">{formatBytes(result.sizeBytes)}</div> : null}
          {result.disabledReason ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {result.disabledReason}
            </div>
          ) : null}
          {result.recommendation ? (
            <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
              {result.recommendation}
            </div>
          ) : null}
        </div>
        <Button
          size="sm"
          onClick={() => onDownload?.(result)}
          disabled={result.disabled === true || downloading}
        >
          {downloading ? "Downloading…" : "Download"}
        </Button>
      </div>
    </div>
  );
}

export function LlamacppSettingsPanel({
  runtime = {},
  library = {},
  variants = {},
  disableEditsReason = "",
  onSelectRuntime,
  onStartRuntime,
  onStopRuntime,
  onSaveRuntimeSettings,
  onSaveVariant,
  onRefreshLibrary,
  onAttachModel,
  onLocateModel,
  onRemoveModel,
  onDownloadManagedModel
}) {
  const runtimeStatus = formatRuntimeStatus(runtime?.status);
  const libraryEntries = useMemo(() => Object.values(library || {}), [library]);
  const variantEntries = useMemo(() => Object.values(variants || {}), [variants]);
  const selectedCommand = String(runtime?.selectedCommand || runtime?.manualCommand || "").trim();
  const selectedDirectory = String(runtime?.selectedDirectory || "").trim() || deriveParentPath(selectedCommand);
  const host = String(runtime?.host || "127.0.0.1").trim() || "127.0.0.1";
  const port = Number.isFinite(Number(runtime?.port)) ? Number(runtime.port) : 39391;
  const runtimeRunning = String(runtime?.status || "").trim().toLowerCase() === "running";

  const [editorState, setEditorState] = useState({ open: false, draft: null, baseModelId: "", title: "" });
  const [savingVariant, setSavingVariant] = useState(false);
  const [attachState, setAttachState] = useState({
    open: false,
    draft: { id: "", displayName: "", filePath: "" },
    saving: false,
    browseBusy: false,
    scanBusy: false,
    scanMatches: [],
    error: ""
  });
  const [locateState, setLocateState] = useState({
    open: false,
    baseModelId: "",
    displayName: "",
    filePath: "",
    saving: false,
    browseBusy: false,
    error: ""
  });
  const [downloadState, setDownloadState] = useState({
    open: false,
    query: "",
    searching: false,
    results: [],
    error: "",
    downloadingKey: "",
    progressLabel: ""
  });
  const [refreshingLibrary, setRefreshingLibrary] = useState(false);
  const [rowActionKey, setRowActionKey] = useState("");
  const [runtimeActionState, setRuntimeActionState] = useState({
    selecting: false,
    starting: false,
    stopping: false,
    savingSettings: false,
    error: ""
  });
  const [runtimeAutoStart, setRuntimeAutoStart] = useState(runtime?.startWithRouter === true);
  const [runtimeDiscovery, setRuntimeDiscovery] = useState({
    loading: false,
    error: "",
    runtime: null
  });

  useEffect(() => {
    setRuntimeAutoStart(runtime?.startWithRouter === true);
  }, [runtime?.startWithRouter]);

  const duplicateIds = useMemo(() => {
    const draftId = String(editorState?.draft?.id || "").trim();
    const currentKey = String(editorState?.draft?.key || "").trim();
    return new Set(
      variantEntries
        .filter((variant) => String(variant?.key || "").trim() !== currentKey)
        .map((variant) => String(variant?.id || "").trim())
        .filter((id) => id && id === draftId)
    );
  }, [editorState?.draft?.id, editorState?.draft?.key, variantEntries]);

  const activeBaseModel = editorState?.baseModelId ? library[editorState.baseModelId] || null : null;
  const saveDisabledReason = resolveLocalVariantSaveDisabledReason(editorState?.draft || {}, duplicateIds);
  const attachDisabledReason = !String(attachState?.draft?.id || "").trim()
    ? "Model id is required."
    : (!String(attachState?.draft?.filePath || "").trim()
        ? "GGUF file path is required."
        : (!looksLikeGgufPath(attachState?.draft?.filePath) ? "Select a GGUF file path." : ""));
  const locateDisabledReason = !String(locateState.filePath || "").trim()
    ? "GGUF file path is required."
    : (!looksLikeGgufPath(locateState.filePath) ? "Select a GGUF file path." : "");

  useEffect(() => {
    if (!disableEditsReason && typeof onRefreshLibrary === "function") {
      void onRefreshLibrary({ silent: true });
    }
  }, []);

  async function loadRuntimeDiscovery() {
    setRuntimeDiscovery((current) => ({ ...current, loading: true, error: "" }));
    try {
      const payload = await discoverLlamacppRuntime();
      setRuntimeDiscovery({
        loading: false,
        error: "",
        runtime: payload?.runtime || null
      });
    } catch (error) {
      setRuntimeDiscovery({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        runtime: null
      });
    }
  }

  useEffect(() => {
    let canceled = false;

    async function load() {
      setRuntimeDiscovery((current) => ({ ...current, loading: true, error: "" }));
      try {
        const payload = await discoverLlamacppRuntime();
        if (canceled) return;
        setRuntimeDiscovery({
          loading: false,
          error: "",
          runtime: payload?.runtime || null
        });
      } catch (error) {
        if (canceled) return;
        setRuntimeDiscovery({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          runtime: null
        });
      }
    }

    void load();
    return () => {
      canceled = true;
    };
  }, [selectedCommand, runtime?.startWithRouter, runtime?.status]);

  async function handleSelectRuntime(command) {
    const normalizedCommand = String(command || "").trim();
    if (!normalizedCommand || !onSelectRuntime) return;
    setRuntimeActionState((current) => ({
      ...current,
      selecting: true,
      error: ""
    }));
    try {
      const didSave = await onSelectRuntime(normalizedCommand);
      if (didSave) {
        await loadRuntimeDiscovery();
      }
    } catch (error) {
      setRuntimeActionState((current) => ({
        ...current,
        selecting: false,
        error: error instanceof Error ? error.message : String(error)
      }));
      return;
    }
    setRuntimeActionState((current) => ({
      ...current,
      selecting: false,
      error: ""
    }));
  }

  async function handleStartRuntime() {
    if (!onStartRuntime || !selectedCommand) return;
    setRuntimeActionState((current) => ({
      ...current,
      starting: true,
      error: ""
    }));
    try {
      await onStartRuntime();
      await loadRuntimeDiscovery();
      setRuntimeActionState((current) => ({
        ...current,
        starting: false,
        error: ""
      }));
    } catch (error) {
      setRuntimeActionState((current) => ({
        ...current,
        starting: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  async function handleStopRuntime() {
    if (!onStopRuntime) return;
    setRuntimeActionState((current) => ({
      ...current,
      stopping: true,
      error: ""
    }));
    try {
      await onStopRuntime();
      await loadRuntimeDiscovery();
      setRuntimeActionState((current) => ({
        ...current,
        stopping: false,
        error: ""
      }));
    } catch (error) {
      setRuntimeActionState((current) => ({
        ...current,
        stopping: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  async function handleSaveRuntimeSettings() {
    if (!onSaveRuntimeSettings) return;
    setRuntimeActionState((current) => ({
      ...current,
      savingSettings: true,
      error: ""
    }));
    try {
      await onSaveRuntimeSettings({
        startWithRouter: runtimeAutoStart
      });
      await loadRuntimeDiscovery();
      setRuntimeActionState((current) => ({
        ...current,
        savingSettings: false,
        error: ""
      }));
    } catch (error) {
      setRuntimeActionState((current) => ({
        ...current,
        savingSettings: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  async function handleBrowseRuntime() {
    setRuntimeActionState((current) => ({
      ...current,
      selecting: true,
      error: ""
    }));
    try {
      const payload = await browseLocalModelPath("runtime");
      const pickedPath = String(payload?.selection?.path || "").trim();
      if (!pickedPath) {
        setRuntimeActionState((current) => ({
          ...current,
          selecting: false,
          error: ""
        }));
        return;
      }
      const didSave = await onSelectRuntime?.(pickedPath);
      if (didSave) {
        await loadRuntimeDiscovery();
      }
      setRuntimeActionState((current) => ({
        ...current,
        selecting: false,
        error: ""
      }));
    } catch (error) {
      setRuntimeActionState((current) => ({
        ...current,
        selecting: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  function openCreateModal(baseModel) {
    setEditorState({
      open: true,
      title: "Create local variant",
      baseModelId: baseModel?.id || "",
      draft: buildLlamacppVariantDraft(baseModel, variants)
    });
  }

  function openEditModal(variant) {
    setEditorState({
      open: true,
      title: "Edit local variant",
      baseModelId: variant?.baseModelId || "",
      draft: buildEditableLlamacppVariantDraft(variant)
    });
  }

  function closeEditor() {
    if (savingVariant) return;
    setEditorState({ open: false, draft: null, baseModelId: "", title: "" });
  }

  async function handleSaveVariant() {
    if (!editorState?.draft || saveDisabledReason) return;
    setSavingVariant(true);
    let didSave = false;
    try {
      const normalizedDraft = {
        ...editorState.draft,
        contextWindow: normalizeLocalVariantContextWindow(editorState.draft.contextWindow)
      };
      didSave = await onSaveVariant?.(normalizedDraft);
    } finally {
      setSavingVariant(false);
    }
    if (didSave) {
      setEditorState({ open: false, draft: null, baseModelId: "", title: "" });
    }
  }

  function openAttachModal() {
    setAttachState({
      open: true,
      saving: false,
      browseBusy: false,
      scanBusy: false,
      scanMatches: [],
      error: "",
      draft: { id: "", displayName: "", filePath: "" }
    });
  }

  function closeAttachModal() {
    if (attachState.saving) return;
    setAttachState({
      open: false,
      draft: { id: "", displayName: "", filePath: "" },
      saving: false,
      browseBusy: false,
      scanBusy: false,
      scanMatches: [],
      error: ""
    });
  }

  async function handleAttachSave() {
    if (attachDisabledReason) return;
    setAttachState((current) => ({ ...current, saving: true }));
    let didSave = false;
    try {
      didSave = await onAttachModel?.(attachState.draft);
    } finally {
      setAttachState((current) => ({ ...current, saving: false }));
    }
    if (didSave) {
      setAttachState({
        open: false,
        draft: { id: "", displayName: "", filePath: "" },
        saving: false,
        browseBusy: false,
        scanBusy: false,
        scanMatches: [],
        error: ""
      });
    }
  }

  function applyAttachFilePath(filePath) {
    const suggested = buildAttachedLocalModelDraft(filePath, library);
    setAttachState((current) => ({
      ...current,
      draft: {
        id: suggested.id,
        displayName: suggested.displayName,
        filePath: suggested.filePath
      },
      error: ""
    }));
  }

  async function handleBrowseAttach(selection) {
    setAttachState((current) => ({
      ...current,
      browseBusy: true,
      error: ""
    }));
    try {
      const payload = await browseLocalModelPath(selection);
      const pickedPath = String(payload?.selection?.path || "").trim();
      const matches = Array.isArray(payload?.matches) ? payload.matches : [];
      if (pickedPath && selection === "file" && matches.length > 0) {
        applyAttachFilePath(matches[0].filePath || pickedPath);
      } else {
        setAttachState((current) => ({
          ...current,
          draft: {
            ...current.draft,
            filePath: pickedPath || current.draft.filePath
          },
          scanMatches: matches,
          error: matches.length === 0 && selection === "directory" && pickedPath
            ? "No GGUF files were found in that folder."
            : ""
        }));
      }
    } catch (error) {
      setAttachState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setAttachState((current) => ({
        ...current,
        browseBusy: false
      }));
    }
  }

  async function handleScanAttachPath() {
    const targetPath = String(attachState?.draft?.filePath || "").trim();
    if (!targetPath) return;
    setAttachState((current) => ({
      ...current,
      scanBusy: true,
      error: ""
    }));
    try {
      const payload = await scanLocalModelPath(targetPath);
      const matches = Array.isArray(payload?.matches) ? payload.matches : [];
      setAttachState((current) => ({
        ...current,
        scanMatches: matches,
        error: matches.length === 0 ? "No GGUF files were found at that path." : ""
      }));
      if (matches.length === 1 && looksLikeGgufPath(matches[0]?.filePath)) {
        applyAttachFilePath(matches[0].filePath);
      }
    } catch (error) {
      setAttachState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setAttachState((current) => ({
        ...current,
        scanBusy: false
      }));
    }
  }

  function openLocateModal(entry) {
    setLocateState({
      open: true,
      baseModelId: entry?.id || "",
      displayName: entry?.displayName || entry?.id || "",
      filePath: entry?.path || "",
      saving: false,
      browseBusy: false,
      error: ""
    });
  }

  function closeLocateModal() {
    if (locateState.saving) return;
    setLocateState({
      open: false,
      baseModelId: "",
      displayName: "",
      filePath: "",
      saving: false,
      browseBusy: false,
      error: ""
    });
  }

  async function handleLocateSave() {
    if (!locateState.baseModelId || !String(locateState.filePath || "").trim()) return;
    setLocateState((current) => ({ ...current, saving: true }));
    let didSave = false;
    try {
      didSave = await onLocateModel?.({
        baseModelId: locateState.baseModelId,
        filePath: locateState.filePath
      });
    } finally {
      setLocateState((current) => ({ ...current, saving: false }));
    }
    if (didSave) {
      setLocateState({
        open: false,
        baseModelId: "",
        displayName: "",
        filePath: "",
        saving: false,
        browseBusy: false,
        error: ""
      });
    }
  }

  async function handleBrowseLocate() {
    setLocateState((current) => ({
      ...current,
      browseBusy: true,
      error: ""
    }));
    try {
      const payload = await browseLocalModelPath("file");
      const pickedPath = String(payload?.selection?.path || "").trim();
      if (pickedPath) {
        setLocateState((current) => ({
          ...current,
          filePath: pickedPath
        }));
      }
    } catch (error) {
      setLocateState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setLocateState((current) => ({
        ...current,
        browseBusy: false
      }));
    }
  }

  async function handleRemoveEntry(entry) {
    if (!entry?.id) return;
    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm(`Remove local model "${entry.displayName || entry.id}" and all of its variants?`);
    if (!confirmed) return;

    setRowActionKey(`remove:${entry.id}`);
    try {
      await onRemoveModel?.(entry.id);
    } finally {
      setRowActionKey("");
    }
  }

  async function handleRefreshStatus() {
    setRefreshingLibrary(true);
    try {
      await onRefreshLibrary?.({ silent: false });
    } finally {
      setRefreshingLibrary(false);
    }
  }

  async function handleSearchDownloads(queryOverride = null) {
    const query = queryOverride ?? downloadState.query;
    setDownloadState((current) => ({
      ...current,
      searching: true,
      error: ""
    }));
    try {
      const results = await searchHuggingFaceGguf({
        query,
        expectedContextWindow: 200000
      });
      setDownloadState((current) => ({
        ...current,
        query,
        results,
        searching: false,
        error: ""
      }));
    } catch (error) {
      setDownloadState((current) => ({
        ...current,
        query,
        searching: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  function openDownloadModal() {
    setDownloadState((current) => ({
      ...current,
      open: true,
      error: "",
      progressLabel: ""
    }));
    if ((downloadState.results || []).length === 0 && !downloadState.searching) {
      void handleSearchDownloads("");
    }
  }

  function closeDownloadModal() {
    if (downloadState.downloadingKey) return;
    setDownloadState((current) => ({
      ...current,
      open: false,
      error: "",
      progressLabel: ""
    }));
  }

  async function handleDownloadResult(result) {
    const draft = buildManagedLocalModelDraft(result, library);
    const downloadKey = `${result.repo}:${result.file}`;
    setDownloadState((current) => ({
      ...current,
      downloadingKey: downloadKey,
      progressLabel: "Preparing download…",
      error: ""
    }));

    let didSave = false;
    try {
      didSave = await onDownloadManagedModel?.({
        ...draft,
        repo: result.repo,
        file: result.file
      }, {
        onMessage: (message) => {
          if (message?.type === "progress") {
            const receivedBytes = Number(message?.event?.receivedBytes || 0);
            const totalBytes = Number(message?.event?.totalBytes || 0);
            const label = totalBytes > 0
              ? `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`
              : (receivedBytes > 0 ? formatBytes(receivedBytes) : "Downloading…");
            setDownloadState((current) => ({
              ...current,
              progressLabel: label
            }));
          }
        }
      });
    } finally {
      setDownloadState((current) => ({
        ...current,
        downloadingKey: "",
        progressLabel: ""
      }));
    }
    if (didSave) {
      setDownloadState((current) => ({
        ...current,
        open: false,
        downloadingKey: "",
        progressLabel: "",
        error: ""
      }));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">llama.cpp Runtime</div>
              <div className="text-lg font-semibold text-foreground">Native runtime configuration</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!runtimeRunning ? (
                <Button size="sm" onClick={handleStartRuntime} disabled={!selectedCommand || runtimeActionState.starting}>
                  {runtimeActionState.starting ? "Starting…" : "Start Runtime"}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={handleStopRuntime} disabled={runtimeActionState.stopping}>
                  {runtimeActionState.stopping ? "Stopping…" : "Stop Runtime"}
                </Button>
              )}
              <Badge variant={runtimeStatus.variant}>{runtimeStatus.label}</Badge>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Selected Command</div>
              <div className="mt-2 break-all font-mono text-sm text-foreground">{selectedCommand || "Not configured yet"}</div>
              {selectedDirectory ? (
                <div className="mt-2 font-mono text-xs text-muted-foreground">Dir: {selectedDirectory}</div>
              ) : null}
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Runtime Address</div>
              <div className="mt-2 font-mono text-sm text-foreground">{`${host}:${port}`}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Start With Router</div>
              <div className="mt-2 text-sm text-foreground">{runtime?.startWithRouter === true ? "Enabled" : "Disabled"}</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/75 p-4">
            <div className="space-y-1">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Runtime Settings</div>
              <div className="text-sm text-muted-foreground">Auto-start launches the selected `llama-server` when the router starts.</div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-foreground">Auto-start with router</label>
              <Switch checked={runtimeAutoStart} onCheckedChange={setRuntimeAutoStart} disabled={Boolean(disableEditsReason) || runtimeActionState.savingSettings} />
              <Button size="sm" variant="outline" onClick={handleSaveRuntimeSettings} disabled={Boolean(disableEditsReason) || runtimeActionState.savingSettings}>
                {runtimeActionState.savingSettings ? "Saving…" : "Save Settings"}
              </Button>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Detected runtimes</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  Auto-search checks `PATH`, Homebrew, and common source-build locations such as `~/src/llama-cpp-turboquant/build/bin`. TurboQuant builds are labeled explicitly when detected.
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleBrowseRuntime}
                  disabled={runtimeActionState.selecting}
                >
                  {runtimeActionState.selecting ? "Selecting…" : "Browse runtime"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void loadRuntimeDiscovery()} disabled={runtimeDiscovery.loading || runtimeActionState.selecting}>
                  {runtimeDiscovery.loading ? "Refreshing…" : "Refresh runtimes"}
                </Button>
              </div>
            </div>
            {runtimeActionState.error ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {runtimeActionState.error}
              </div>
            ) : null}
            {runtimeDiscovery.error ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {runtimeDiscovery.error}
              </div>
            ) : null}
            {(runtimeDiscovery.runtime?.candidates || []).length === 0 && !runtimeDiscovery.loading ? (
              <div className="rounded-2xl border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
                No local `llama-server` candidates were detected yet. If TurboQuant is already built outside the common search locations, use Browse runtime and point the router at the binary directly.
              </div>
            ) : (
              <div className="space-y-3">
                {(runtimeDiscovery.runtime?.candidates || []).map((candidate) => (
                  <RuntimeCandidateRow
                    key={candidate.path || candidate.id}
                    candidate={candidate}
                    busy={runtimeActionState.selecting}
                    onUseRuntime={handleSelectRuntime}
                  />
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">Library</div>
                <div className="text-lg font-semibold text-foreground">Tracked GGUF base models</div>
                <div className="text-sm text-muted-foreground">
                  Create router-facing variants from managed Hugging Face downloads or attached GGUF paths. Missing or stale files stay visible until you repair or remove them.
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={openAttachModal} disabled={Boolean(disableEditsReason)}>
                  Attach path
                </Button>
                <Button size="sm" onClick={openDownloadModal} disabled={Boolean(disableEditsReason)}>
                  Download from Hugging Face
                </Button>
                <Button size="sm" variant="outline" onClick={handleRefreshStatus} disabled={Boolean(disableEditsReason) || refreshingLibrary}>
                  {refreshingLibrary ? "Refreshing…" : "Refresh status"}
                </Button>
              </div>
            </div>
            {disableEditsReason ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {disableEditsReason}
              </div>
            ) : null}
            <div className="space-y-3">
              {libraryEntries.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                  No `llama.cpp` base models are tracked yet. Managed downloads and attached GGUF files will land here.
                </div>
              ) : (
                libraryEntries.map((entry) => (
                  <LibraryRow
                    key={entry.id}
                    entry={entry}
                    variantCount={variantEntries.filter((variant) => variant?.baseModelId === entry.id).length}
                    disabledReason={disableEditsReason}
                    busy={rowActionKey === `remove:${entry.id}`}
                    onCreateVariant={openCreateModal}
                    onLocateModel={openLocateModal}
                    onRemoveModel={handleRemoveEntry}
                  />
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="space-y-1">
              <div className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">Variants</div>
              <div className="text-lg font-semibold text-foreground">Router-visible local models</div>
              <div className="text-sm text-muted-foreground">
                Variants behave like standard router models after save, including alias usage, context-window metadata, and capability hints.
              </div>
            </div>
            <div className="space-y-3">
              {variantEntries.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                  No local variants yet. Start from a base model on the left, choose a preset, and expose the saved variant to aliases and route pickers.
                </div>
              ) : (
                variantEntries.map((variant) => (
                  <VariantRow
                    key={variant.key || variant.id}
                    variant={variant}
                    baseModel={library[variant?.baseModelId] || null}
                    runtimeStatus={runtimeStatus}
                    onEdit={openEditModal}
                  />
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Modal
        open={attachState.open}
        onClose={closeAttachModal}
        title="Attach local GGUF"
        description="Register an existing GGUF file in place. The router stores metadata only and does not copy the file."
        contentClassName="max-w-xl"
      >
        <div className="space-y-4">
          <Field label="GGUF file path" stacked>
            <div className="space-y-2">
              <Input
                value={attachState.draft.filePath}
                onChange={(event) => {
                  const nextDraft = {
                    ...attachState.draft,
                    filePath: event.target.value
                  };
                  if (!String(attachState.draft.id || "").trim() || !String(attachState.draft.displayName || "").trim()) {
                    const suggested = buildAttachedLocalModelDraft(event.target.value, library);
                    if (!String(attachState.draft.id || "").trim()) nextDraft.id = suggested.id;
                    if (!String(attachState.draft.displayName || "").trim()) nextDraft.displayName = suggested.displayName;
                  }
                  setAttachState((current) => ({ ...current, draft: nextDraft }));
                }}
                placeholder="/Volumes/models/qwen.Q5.gguf"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => handleBrowseAttach("file")} disabled={attachState.browseBusy || attachState.scanBusy}>
                  {attachState.browseBusy ? "Browsing…" : "Browse file"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleBrowseAttach("directory")} disabled={attachState.browseBusy || attachState.scanBusy}>
                  {attachState.browseBusy ? "Browsing…" : "Browse folder"}
                </Button>
                <Button size="sm" variant="outline" onClick={handleScanAttachPath} disabled={attachState.scanBusy || !String(attachState.draft.filePath || "").trim()}>
                  {attachState.scanBusy ? "Scanning…" : "Scan path"}
                </Button>
              </div>
            </div>
          </Field>
          <Field label="Model name" stacked>
            <Input
              value={attachState.draft.displayName}
              onChange={(event) => setAttachState((current) => ({
                ...current,
                draft: {
                  ...current.draft,
                  displayName: event.target.value
                }
              }))}
            />
          </Field>
          <Field label="Base model id" stacked hint="Stable inventory id used for variants and stale-path recovery.">
            <Input
              value={attachState.draft.id}
              onChange={(event) => setAttachState((current) => ({
                ...current,
                draft: {
                  ...current.draft,
                  id: event.target.value
                }
              }))}
            />
          </Field>
          {attachState.error ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {attachState.error}
            </div>
          ) : null}
          {(attachState.scanMatches || []).length > 0 ? (
            <div className="space-y-2 rounded-2xl border border-border/70 bg-background/60 p-3">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Scanned GGUF files</div>
              {(attachState.scanMatches || []).map((match) => (
                <div key={match.filePath} className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-border/60 bg-background/80 px-3 py-3">
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-foreground">{match.fileName}</div>
                    <div className="break-all font-mono text-xs text-muted-foreground">{match.filePath}</div>
                    {match.sizeBytes ? <div className="text-xs text-muted-foreground">{formatBytes(match.sizeBytes)}</div> : null}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => applyAttachFilePath(match.filePath)} disabled={attachState.saving}>
                    Use file
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          {attachDisabledReason ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {attachDisabledReason}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={closeAttachModal} disabled={attachState.saving}>
              Cancel
            </Button>
            <Button type="button" onClick={handleAttachSave} disabled={Boolean(attachDisabledReason) || attachState.saving}>
              {attachState.saving ? "Attaching…" : "Attach model"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={locateState.open}
        onClose={closeLocateModal}
        title="Locate local model"
        description={`Update the file path for ${locateState.displayName || "this model"} without changing any attached variants.`}
        contentClassName="max-w-xl"
      >
        <div className="space-y-4">
          <Field label="Updated GGUF path" stacked>
            <div className="space-y-2">
              <Input
                value={locateState.filePath}
                onChange={(event) => setLocateState((current) => ({ ...current, filePath: event.target.value }))}
                placeholder="/Volumes/models/qwen.Q5.gguf"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={handleBrowseLocate} disabled={locateState.browseBusy || locateState.saving}>
                  {locateState.browseBusy ? "Browsing…" : "Browse file"}
                </Button>
              </div>
            </div>
          </Field>
          {locateState.error ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {locateState.error}
            </div>
          ) : null}
          {locateDisabledReason ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {locateDisabledReason}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={closeLocateModal} disabled={locateState.saving}>
              Cancel
            </Button>
            <Button type="button" onClick={handleLocateSave} disabled={Boolean(locateDisabledReason) || locateState.saving}>
              {locateState.saving ? "Updating…" : "Save path"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={downloadState.open}
        onClose={closeDownloadModal}
        title="Download GGUF from Hugging Face"
        description="Public Hugging Face search only for v1. Unsupported or oversized files stay visible with explicit reasons instead of disappearing."
        contentClassName="max-w-4xl"
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Search query" stacked className="min-w-0 flex-1">
              <Input
                value={downloadState.query}
                onChange={(event) => setDownloadState((current) => ({ ...current, query: event.target.value }))}
                placeholder="qwen q5 gguf"
              />
            </Field>
            <Button type="button" onClick={() => handleSearchDownloads()} disabled={downloadState.searching}>
              {downloadState.searching ? "Searching…" : "Search"}
            </Button>
          </div>
          {downloadState.error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              {downloadState.error}
            </div>
          ) : null}
          {downloadState.progressLabel ? (
            <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
              {downloadState.progressLabel}
            </div>
          ) : null}
          <div className="space-y-3">
            {(downloadState.results || []).length === 0 && !downloadState.searching ? (
              <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                Search for a public GGUF repo or file name to download into the router-managed local model directory.
              </div>
            ) : (
              (downloadState.results || []).map((result) => (
                <SearchResultRow
                  key={`${result.repo}:${result.file}`}
                  result={result}
                  downloading={downloadState.downloadingKey === `${result.repo}:${result.file}`}
                  onDownload={handleDownloadResult}
                />
              ))
            )}
          </div>
        </div>
      </Modal>

      <Modal
        open={editorState.open}
        onClose={closeEditor}
        title={editorState.title}
        description="Create a router-visible local model without touching the base GGUF file. Presets seed the context window, while the backend enforces Mac unified-memory activation limits."
        contentClassName="max-w-2xl"
      >
        <LocalModelVariantEditor
          draft={editorState.draft}
          baseModel={activeBaseModel}
          duplicateIds={duplicateIds}
          saveDisabled={Boolean(saveDisabledReason)}
          saveDisabledReason={saveDisabledReason}
          saving={savingVariant}
          onChange={(nextDraft) => {
            const nextPreset = String(nextDraft?.preset || editorState?.draft?.preset || "balanced").trim() || "balanced";
            const previousPreset = String(editorState?.draft?.preset || "balanced").trim() || "balanced";
            const previousContext = normalizeLocalVariantContextWindow(editorState?.draft?.contextWindow);
            const shouldApplyPresetContext = nextPreset !== previousPreset
              && previousContext === LLAMACPP_VARIANT_PRESETS[previousPreset]?.contextWindow;

            setEditorState((current) => ({
              ...current,
              draft: {
                ...nextDraft,
                contextWindow: shouldApplyPresetContext
                  ? LLAMACPP_VARIANT_PRESETS[nextPreset]?.contextWindow ?? nextDraft?.contextWindow
                  : nextDraft?.contextWindow
              }
            }));
          }}
          onCancel={closeEditor}
          onSave={handleSaveVariant}
        />
      </Modal>
    </div>
  );
}
