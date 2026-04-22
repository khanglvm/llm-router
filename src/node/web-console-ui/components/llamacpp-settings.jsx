import { useMemo, useState } from "react";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Card, CardContent } from "./ui/card.jsx";
import { Modal } from "./shared.jsx";
import { formatContextWindow } from "../context-window-utils.js";
import {
  buildEditableLlamacppVariantDraft,
  buildLlamacppVariantDraft,
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

function LibraryRow({ entry, variantCount = 0, disabledReason = "", onCreateVariant }) {
  const availability = formatAvailability(entry?.availability);
  const sizeLabel = formatBytes(entry?.metadata?.sizeBytes);

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
          <div className="text-xs text-muted-foreground">
            {variantCount} variant{variantCount === 1 ? "" : "s"} attached to this base model.
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => onCreateVariant?.(entry)}
            disabled={Boolean(disabledReason) || availability.label !== "Available"}
          >
            Create variant
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

export function LlamacppSettingsPanel({
  runtime = {},
  library = {},
  variants = {},
  disableEditsReason = "",
  onSaveVariant
}) {
  const runtimeStatus = formatRuntimeStatus(runtime?.status);
  const libraryEntries = useMemo(() => Object.values(library || []), [library]);
  const variantEntries = useMemo(() => Object.values(variants || []), [variants]);
  const selectedCommand = String(runtime?.selectedCommand || runtime?.manualCommand || "").trim();
  const host = String(runtime?.host || "127.0.0.1").trim() || "127.0.0.1";
  const port = Number.isFinite(Number(runtime?.port)) ? Number(runtime.port) : 39391;
  const [editorState, setEditorState] = useState({ open: false, draft: null, baseModelId: "", title: "" });
  const [savingVariant, setSavingVariant] = useState(false);

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
    try {
      const normalizedDraft = {
        ...editorState.draft,
        contextWindow: normalizeLocalVariantContextWindow(editorState.draft.contextWindow)
      };
      const saved = await onSaveVariant?.(normalizedDraft);
      if (saved) closeEditor();
    } finally {
      setSavingVariant(false);
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
            <Badge variant={runtimeStatus.variant}>{runtimeStatus.label}</Badge>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Selected Command</div>
              <div className="mt-2 break-all font-mono text-sm text-foreground">{selectedCommand || "Not configured yet"}</div>
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
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="space-y-1">
              <div className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">Library</div>
              <div className="text-lg font-semibold text-foreground">Tracked GGUF base models</div>
              <div className="text-sm text-muted-foreground">
                Create router-facing variants from managed Hugging Face downloads or attached GGUF paths. Missing or stale files stay visible until you repair or remove them.
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
                    onCreateVariant={openCreateModal}
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
