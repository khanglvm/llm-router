import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Badge } from "./ui/badge.jsx";
import { Card, CardContent } from "./ui/card.jsx";
import { Input } from "./ui/input.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.jsx";
import { cn } from "../lib/utils.js";
import {
  Field,
  Modal,
  CredentialInput,
  UnsavedChangesModal,
  FailedModelsCloseModal
} from "./shared.jsx";
import { EditIcon, TrashIcon } from "../icons.jsx";
import {
  slugifyProviderId,
  looksLikeEnvVarName,
  isLikelyHttpEndpoint,
  normalizeUniqueTrimmedValues,
  mergeChipValuesAndDraft,
  serializeRateLimitDraftRows,
  resolveRateLimitDraftRows,
  formatRateLimitSummary
} from "../utils.js";
import { validateRateLimitDraftRows } from "../rate-limit-utils.js";
import { QUICK_START_PROVIDER_ID_PATTERN } from "../constants.js";
import { createProviderInlineDraftState, collectQuickStartEndpoints, inferQuickStartConnectionType } from "../quick-start-utils.js";
import { ChipInput } from "./chip-input.jsx";
import { appendRateLimitDraftRow, RateLimitBucketsEditor } from "./rate-limit-editor.jsx";
import { ProviderModelsEditor } from "./provider-models-editor.jsx";
import { SummaryChipButton } from "./shared.jsx";

export function ProviderCard({
  provider,
  onRemove,
  onCopyModelId,
  onApplyProviderDetails,
  onApplyProviderModels,
  onSaveAndCloseEditor,
  disabledReason = "",
  busy = false
}) {
  const initialDraft = useMemo(() => createProviderInlineDraftState(provider), [provider]);
  const [draft, setDraft] = useState(initialDraft);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [failedCloseOpen, setFailedCloseOpen] = useState(false);
  const [editTab, setEditTab] = useState("provider");
  const [editFocusTarget, setEditFocusTarget] = useState("");
  const [modelFocusRequest, setModelFocusRequest] = useState(0);
  const [modelEditorState, setModelEditorState] = useState({
    isDirty: false,
    issue: "",
    locked: false,
    rows: []
  });
  const [modelSaveState, setModelSaveState] = useState({
    phase: "",
    modelStates: {},
    failedModelIds: [],
    message: ""
  });
  const endpointSectionRef = useRef(null);
  const endpointInputRef = useRef(null);
  const rateLimitSectionRef = useRef(null);
  const rateLimitInputRef = useRef(null);

  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  const connectionType = inferQuickStartConnectionType(provider);
  const isSubscription = connectionType !== "api";
  const modelIds = (Array.isArray(provider?.models) ? provider.models : []).map((model) => String(model?.id || "").trim()).filter(Boolean);
  const endpointCandidates = collectQuickStartEndpoints(provider);
  const rateLimitSummary = !isSubscription ? formatRateLimitSummary(provider?.rateLimits) : "";
  const resolvedEndpoints = isSubscription
    ? []
    : mergeChipValuesAndDraft(draft?.endpoints, draft?.endpointDraft);
  const resolvedRateLimitRows = isSubscription ? [] : resolveRateLimitDraftRows(draft?.rateLimitRows);
  const draftSignature = JSON.stringify({
    id: String(draft?.id || "").trim(),
    name: String(draft?.name || "").trim(),
    credentialInput: String(draft?.credentialInput || "").trim(),
    endpoints: resolvedEndpoints,
    endpointDraft: String(draft?.endpointDraft || "").trim(),
    rateLimitRows: serializeRateLimitDraftRows(draft?.rateLimitRows)
  });
  const initialSignature = JSON.stringify({
    id: String(initialDraft?.id || "").trim(),
    name: String(initialDraft?.name || "").trim(),
    credentialInput: String(initialDraft?.credentialInput || "").trim(),
    endpoints: normalizeUniqueTrimmedValues(initialDraft?.endpoints),
    endpointDraft: String(initialDraft?.endpointDraft || "").trim(),
    rateLimitRows: serializeRateLimitDraftRows(initialDraft?.rateLimitRows)
  });
  const isDirty = draftSignature !== initialSignature;
  const locked = Boolean(disabledReason) || busy;
  const activeModelIds = new Set((Array.isArray(modelEditorState.rows) ? modelEditorState.rows : []).map((row) => String(row?.id || "").trim()).filter(Boolean));
  const activeFailedModelIds = modelSaveState.failedModelIds.filter((modelId) => activeModelIds.has(modelId));
  const modalCloseLocked = locked || modelSaveState.phase === "testing" || modelSaveState.phase === "saving";
  const rateLimitIssue = !isSubscription
    ? validateRateLimitDraftRows(resolvedRateLimitRows, {
        knownModelIds: modelIds,
        requireAtLeastOne: true
      })
    : "";
  const issue = disabledReason
    ? disabledReason
    : !String(draft?.id || "").trim()
      ? "Provider id is required."
      : !QUICK_START_PROVIDER_ID_PATTERN.test(String(draft?.id || "").trim())
        ? "Provider id must start with a letter and use lowercase letters, digits, or dashes only."
        : !String(draft?.name || "").trim()
          ? "Provider name is required."
          : !isSubscription && resolvedEndpoints.length === 0
            ? "Add at least one endpoint for API Key providers."
            : !isSubscription && resolvedEndpoints.some((endpoint) => !isLikelyHttpEndpoint(endpoint))
            ? "All endpoints must start with http:// or https://."
              : rateLimitIssue;
  const providerDraftForSave = isSubscription ? draft : { ...draft, endpoints: resolvedEndpoints, endpointDraft: "" };
  const hasModelUnsavedChanges = Boolean(modelEditorState.isDirty);
  const hasUnsavedChanges = isDirty || hasModelUnsavedChanges;
  const closeDirtyLabels = [
    isDirty ? "provider settings" : "",
    hasModelUnsavedChanges ? "model list" : ""
  ].filter(Boolean);
  const closeDetails = [
    isDirty && issue ? `Provider: ${issue}` : "",
    hasModelUnsavedChanges && modelEditorState.issue ? `Models: ${modelEditorState.issue}` : ""
  ].filter(Boolean).join(" ");
  const saveAndCloseDisabled = locked
    || modelSaveState.phase === "testing"
    || modelSaveState.phase === "saving"
    || (isDirty && Boolean(issue))
    || (hasModelUnsavedChanges && (Boolean(modelEditorState.issue) || modelEditorState.locked))
    || typeof onSaveAndCloseEditor !== "function";

  async function handleApplyClick() {
    const saved = await onApplyProviderDetails(
      provider.id,
      providerDraftForSave
    );
    if (saved) finalizeCloseEditModal();
    return saved;
  }

  async function handleApplyModelsAndClose(rows) {
    const saved = await onApplyProviderModels(provider.id, rows, {
      providerDraft: isDirty ? providerDraftForSave : null,
      onModelTestStateChange: (nextState) => {
        setModelSaveState({
          phase: String(nextState?.phase || ""),
          modelStates: nextState?.modelStates && typeof nextState.modelStates === "object" ? nextState.modelStates : {},
          failedModelIds: Array.isArray(nextState?.failedModelIds) ? nextState.failedModelIds : [],
          message: String(nextState?.message || "")
        });
      }
    });
    if (saved) finalizeCloseEditModal();
    return saved;
  }

  function handleResetProviderDraft() {
    setDraft(initialDraft);
  }

  const handleModelEditorStateChange = useCallback((nextState) => {
    setModelEditorState(nextState);
  }, []);

  function finalizeCloseEditModal() {
    setConfirmCloseOpen(false);
    setFailedCloseOpen(false);
    setEditOpen(false);
    setEditTab("provider");
    setEditFocusTarget("");
    setDraft(initialDraft);
    setModelEditorState({
      isDirty: false,
      issue: "",
      locked: false,
      rows: []
    });
    setModelSaveState({
      phase: "",
      modelStates: {},
      failedModelIds: [],
      message: ""
    });
  }

  async function handleRemoveFailedModelsAndClose() {
    const remainingRows = (Array.isArray(modelEditorState.rows) ? modelEditorState.rows : [])
      .filter((row) => !activeFailedModelIds.includes(String(row?.id || "").trim()));

    if (remainingRows.length === 0 && !isDirty) {
      finalizeCloseEditModal();
      return true;
    }

    const saved = await onSaveAndCloseEditor(provider.id, {
      providerDraft: isDirty ? providerDraftForSave : null,
      modelRows: hasModelUnsavedChanges ? remainingRows : null,
      onModelTestStateChange: (nextState) => {
        setModelSaveState({
          phase: String(nextState?.phase || ""),
          modelStates: nextState?.modelStates && typeof nextState.modelStates === "object" ? nextState.modelStates : {},
          failedModelIds: Array.isArray(nextState?.failedModelIds) ? nextState.failedModelIds : [],
          message: String(nextState?.message || "")
        });
      }
    });
    if (!saved) {
      setEditTab("models");
      return false;
    }
    finalizeCloseEditModal();
    return true;
  }

  useEffect(() => {
    setModelSaveState({
      phase: "",
      modelStates: {},
      failedModelIds: [],
      message: ""
    });
  }, [initialDraft]);

  useEffect(() => {
    if (activeFailedModelIds.length > 0 || !failedCloseOpen) return;
    setFailedCloseOpen(false);
  }, [activeFailedModelIds, failedCloseOpen]);

  useEffect(() => {
    if (!editOpen || editTab !== "provider") return undefined;
    if (editFocusTarget !== "endpoint" && editFocusTarget !== "rate-limit") return undefined;
    if (typeof window === "undefined") return undefined;
    const frameId = window.requestAnimationFrame(() => {
      const sectionNode = editFocusTarget === "endpoint" ? endpointSectionRef.current : rateLimitSectionRef.current;
      const inputNode = editFocusTarget === "endpoint" ? endpointInputRef.current : rateLimitInputRef.current;
      sectionNode?.scrollIntoView?.({ block: "nearest" });
      inputNode?.focus?.();
      inputNode?.select?.();
      setEditFocusTarget("");
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [editOpen, editTab, editFocusTarget]);

  function handleOpenEditModal(tab = "provider", focusTarget = "") {
    setConfirmCloseOpen(false);
    setFailedCloseOpen(false);
    setEditTab(tab);
    setEditFocusTarget(focusTarget);
    if (tab === "models" && focusTarget === "models") {
      setModelFocusRequest((current) => current + 1);
    }
    setEditOpen(true);
  }

  function handleCloseEditModal() {
    if (modalCloseLocked) return;
    if (activeFailedModelIds.length > 0) {
      setConfirmCloseOpen(false);
      setFailedCloseOpen(true);
      return;
    }
    if (hasUnsavedChanges) {
      setConfirmCloseOpen(true);
      return;
    }
    finalizeCloseEditModal();
  }

  async function handleSaveAndCloseEditModal() {
    if (saveAndCloseDisabled) return;
    const saved = await onSaveAndCloseEditor(provider.id, {
      providerDraft: isDirty ? providerDraftForSave : null,
      modelRows: hasModelUnsavedChanges ? modelEditorState.rows : null,
      onModelTestStateChange: (nextState) => {
        setModelSaveState({
          phase: String(nextState?.phase || ""),
          modelStates: nextState?.modelStates && typeof nextState.modelStates === "object" ? nextState.modelStates : {},
          failedModelIds: Array.isArray(nextState?.failedModelIds) ? nextState.failedModelIds : [],
          message: String(nextState?.message || "")
        });
      }
    });
    if (!saved) {
      if (hasModelUnsavedChanges) {
        setConfirmCloseOpen(false);
        setEditTab("models");
      }
      return;
    }
    finalizeCloseEditModal();
  }

  return (
    <>
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 px-0.5 py-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-base font-semibold text-foreground">{provider.name || provider.id}</span>
                <span className="text-sm text-muted-foreground">({provider.id})</span>
              </div>
            </div>
            <div className="flex items-start gap-2 self-start">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 normal-case tracking-normal"
                onClick={() => handleOpenEditModal("provider")}
                disabled={locked}
                aria-label={`Edit provider ${provider.name || provider.id}`}
                title="Edit provider"
              >
                <EditIcon className="h-4 w-4 shrink-0" />
                Edit
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:border-destructive/35 hover:bg-destructive/5 hover:text-destructive"
                onClick={() => onRemove(provider.id)}
                disabled={busy}
                aria-label="Remove provider"
                title="Remove provider"
              >
                <TrashIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {modelIds.length > 0 ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {modelIds.map((modelId) => (
                <SummaryChipButton
                  key={`${provider.id}-${modelId}`}
                  onClick={() => onCopyModelId?.(modelId)}
                  title={`Copy model id ${modelId}`}
                  className="max-w-full"
                >
                  <span className="truncate">{modelId}</span>
                </SummaryChipButton>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Modal
        open={editOpen}
        onClose={handleCloseEditModal}
        title={`Edit · ${provider.id}`}
        description={modelSaveState.phase === "testing"
          ? (modelSaveState.message || "Testing new models before save.")
          : modelSaveState.phase === "saving"
            ? (modelSaveState.message || "Saving provider changes.")
            : "Switch between provider settings and model list. Each tab saves independently."}
        closeDisabled={modalCloseLocked}
        closeOnBackdrop={!modalCloseLocked}
        closeOnEscape={!modalCloseLocked}
        contentClassName="max-h-[92vh] max-w-5xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
        bodyClassName="max-h-[calc(92vh-5.5rem)] pb-0"
      >
        <Tabs value={editTab} onValueChange={setEditTab}>
          <TabsList className="w-full justify-start">
            <TabsTrigger value="provider">Provider</TabsTrigger>
            <TabsTrigger value="models">Model list</TabsTrigger>
          </TabsList>

          <TabsContent forceMount value="provider" className={cn("space-y-4 pb-4", editTab !== "provider" ? "hidden" : null)}>
            <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Provider</div>
                  <div className="mt-1 text-sm text-muted-foreground">Update provider identity and connection settings here.</div>
                </div>
                <Badge variant="outline">{isSubscription ? "Subscription" : "API Key"}</Badge>
              </div>
            </div>

            <div className={cn("grid gap-3", isSubscription ? "md:grid-cols-2" : "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
              <Field label="Provider name" stacked>
                <Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} disabled={modalCloseLocked} />
              </Field>
              <Field label="Provider id" hint="Used in direct routes like provider/model" stacked>
                <Input value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: slugifyProviderId(event.target.value) }))} disabled={modalCloseLocked} />
              </Field>
            </div>

            {!isSubscription ? (
              <div className="space-y-3">
                <Field label="API key or env" hint="Use an env var like OPENAI_API_KEY or paste the direct key." stacked>
                  <CredentialInput
                    value={draft.credentialInput || ""}
                    onChange={(event) => setDraft((current) => ({ ...current, credentialInput: event.target.value }))}
                    disabled={modalCloseLocked}
                    placeholder="Example: OPENAI_API_KEY or sk-..."
                    isEnvVar={looksLikeEnvVarName(draft.credentialInput)}
                  />
                </Field>
                <div ref={endpointSectionRef}>
                  <Field
                    label="Endpoints"
                    hint={endpointCandidates.length > 1
                      ? "Comma, space, or newline turns into chips. The first endpoint stays active until you re-test this provider."
                      : "Comma, space, or newline turns into chips."}
                    stacked
                  >
                    <ChipInput
                      values={draft.endpoints}
                      onChange={(value) => setDraft((current) => ({ ...current, endpoints: value }))}
                      draftValue={draft.endpointDraft}
                      onDraftValueChange={(value) => setDraft((current) => ({ ...current, endpointDraft: value }))}
                      commitOnBlur
                      disabled={modalCloseLocked}
                      isValueValid={isLikelyHttpEndpoint}
                      inputRef={endpointInputRef}
                      inputClassName="placeholder:text-muted-foreground/55"
                      placeholder="Click here to type new endpoint"
                      helperText="Paste one or more endpoints"
                    />
                  </Field>
                </div>
                <div ref={rateLimitSectionRef} className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1fr)]">
                  <div className="md:col-span-2 xl:col-span-4">
                    <Field
                      label="Rate limit"
                      stacked
                      headerAction={(
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setDraft((current) => ({ ...current, rateLimitRows: appendRateLimitDraftRow(current.rateLimitRows) }))}
                          disabled={modalCloseLocked}
                        >
                          Add rate limit
                        </Button>
                      )}
                    >
                      <RateLimitBucketsEditor
                        rows={draft.rateLimitRows}
                        onChange={(value) => setDraft((current) => ({ ...current, rateLimitRows: value }))}
                        availableModelIds={modelIds}
                        disabled={modalCloseLocked}
                        inputRef={rateLimitInputRef}
                      />
                    </Field>
                  </div>
                </div>
              </div>
            ) : null}

            {issue ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{issue}</div> : null}

            <div className="flex min-h-9 items-center justify-end gap-2">
              {!modalCloseLocked && isDirty ? <Button type="button" variant="ghost" onClick={handleResetProviderDraft}>Reset</Button> : null}
              {isDirty && !issue ? (
                <Button type="button" onClick={() => void handleApplyClick()} disabled={modalCloseLocked}>
                  {modelSaveState.phase === "saving" || busy ? "Saving…" : "Save provider"}
                </Button>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent forceMount value="models" className={cn(editTab !== "models" ? "hidden" : null)}>
            <ProviderModelsEditor
              provider={provider}
              disabled={Boolean(disabledReason)}
              disabledReason={disabledReason}
              busy={busy}
              framed={false}
              focusRequest={modelFocusRequest}
              onStateChange={handleModelEditorStateChange}
              onApply={handleApplyModelsAndClose}
              testStateByModel={modelSaveState.modelStates}
              savePhase={modelSaveState.phase}
              saveMessage={modelSaveState.message}
            />
          </TabsContent>
        </Tabs>
      </Modal>

      <UnsavedChangesModal
        open={confirmCloseOpen}
        onKeepEditing={() => setConfirmCloseOpen(false)}
        onDiscardAndClose={finalizeCloseEditModal}
        onSaveAndClose={handleSaveAndCloseEditModal}
        saveDisabled={saveAndCloseDisabled}
        dirtyLabels={closeDirtyLabels}
        details={closeDetails}
      />

      <FailedModelsCloseModal
        open={failedCloseOpen}
        failedModelIds={activeFailedModelIds}
        onKeepEditing={() => setFailedCloseOpen(false)}
        onRemoveFailedAndClose={handleRemoveFailedModelsAndClose}
        removeDisabled={modalCloseLocked || typeof onSaveAndCloseEditor !== "function"}
      />
    </>
  );
}

export function ProviderList({
  providers,
  onRemove,
  onCopyModelId,
  onApplyProviderDetails,
  onApplyProviderModels,
  onSaveAndCloseEditor,
  disabledReason = "",
  busy = false
}) {
  if (!providers.length) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 p-5 text-sm text-muted-foreground">
          <div>No enabled providers are configured yet. Use Add provider to create your first provider, model list, and rate limits.</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          onRemove={onRemove}
          onCopyModelId={onCopyModelId}
          onApplyProviderDetails={onApplyProviderDetails}
          onApplyProviderModels={onApplyProviderModels}
          onSaveAndCloseEditor={onSaveAndCloseEditor}
          disabledReason={disabledReason}
          busy={busy}
        />
      ))}
    </div>
  );
}

export function ProviderModelsSection({
  providers,
  onAddProvider,
  onRemove,
  onCopyModelId,
  onApplyProviderDetails,
  onApplyProviderModels,
  onSaveAndCloseEditor,
  disabledReason = "",
  busy = false
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-card p-4" aria-label="Provider models">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Provider &amp; Models</div>
          <div className="mt-1 text-sm text-muted-foreground">Manage providers, direct model routes, endpoints, and rate limits in one place.</div>
        </div>
        <Button onClick={onAddProvider}>Add provider</Button>
      </div>
      <div className="mt-4">
        <ProviderList
          providers={providers}
          onRemove={onRemove}
          onCopyModelId={onCopyModelId}
          onApplyProviderDetails={onApplyProviderDetails}
          onApplyProviderModels={onApplyProviderModels}
          onSaveAndCloseEditor={onSaveAndCloseEditor}
          disabledReason={disabledReason}
          busy={busy}
        />
      </div>
    </section>
  );
}
