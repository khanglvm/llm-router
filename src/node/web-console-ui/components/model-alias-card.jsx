import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Card, CardContent } from "./ui/card.jsx";
import { Input } from "./ui/input.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "./ui/select.jsx";
import { cn } from "../lib/utils.js";
import { EditIcon, CheckIcon, TrashIcon, CopyIcon } from "../icons.jsx";
import { createAliasDraftState } from "../config-editor-utils.js";
import { RouteTargetListEditor } from "./route-target-editor.jsx";
import { ModelAliasStrategyModal, AliasGuideModal, buildAliasStrategyEntries } from "./alias-modals.jsx";
import {
  buildAliasDraftResetKey,
  hasDuplicateTrimmedValues,
  normalizeModelAliasStrategyValue,
  formatModelAliasStrategyLabel
} from "../utils.js";
import { measureAliasSwitcherWidth } from "../context-window-utils.js";
import { withCurrentManagedRouteOptions } from "../route-utils.jsx";
import { DEFAULT_MODEL_ALIAS_ID } from "../../../runtime/config.js";
import { QUICK_START_ALIAS_ID_PATTERN } from "../constants.js";

const ALIAS_AUTOSAVE_DELAY_MS = 500;

function serializeAliasTargetRows(rows = []) {
  return (rows || []).map((row) => ({
    ref: String(row?.ref || "").trim(),
    weight: String(row?.weight || "1").trim()
  }));
}

export function ModelAliasCard({
  aliasId,
  alias,
  aliasIds,
  routeOptions,
  defaultModel,
  ampDefaultRoute,
  disabled = false,
  disabledReason = "",
  busy = false,
  onApply,
  onRemove,
  onCopyAliasId = () => {},
  isNew = false,
  alwaysShowAliasIdInput = false,
  showIssueOnSubmitOnly = false,
  onDiscard = () => {},
  onOpenStrategyModal = () => {},
  titleAccessory = null,
  aliasSwitcher = null,
  framed = true
}) {
  const initialDraftResetKey = buildAliasDraftResetKey(aliasId, alias, { isNew });
  const initialDraft = useMemo(
    () => createAliasDraftState(isNew ? "" : aliasId, alias),
    [initialDraftResetKey]
  );
  const [draft, setDraft] = useState(initialDraft);
  const [aliasIdEditing, setAliasIdEditing] = useState(isNew);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const aliasIdInputRef = useRef(null);
  const autosaveTimerRef = useRef(0);
  const lastAutosaveAttemptSignatureRef = useRef("");
  const [autosaveState, setAutosaveState] = useState("idle");

  useEffect(() => {
    setDraft(initialDraft);
    setAliasIdEditing(isNew);
    setSubmitAttempted(false);
    setAutosaveState("idle");
    lastAutosaveAttemptSignatureRef.current = "";
  }, [initialDraft, isNew]);

  const hasAliasSwitcher = !isNew && Array.isArray(aliasSwitcher?.entries) && aliasSwitcher.entries.length > 1;
  const showAliasIdInput = alwaysShowAliasIdInput || aliasIdEditing;

  useEffect(() => {
    if (!showAliasIdInput) return undefined;
    const frameId = typeof window !== "undefined"
      ? window.requestAnimationFrame(() => {
        aliasIdInputRef.current?.focus();
        aliasIdInputRef.current?.select?.();
      })
      : 0;
    return () => {
      if (typeof window !== "undefined") window.cancelAnimationFrame(frameId);
    };
  }, [showAliasIdInput]);

  const normalizedAliasId = String(draft?.id || "").trim();
  const isFixedDefault = aliasId === DEFAULT_MODEL_ALIAS_ID || normalizedAliasId === DEFAULT_MODEL_ALIAS_ID;
  const filteredRouteOptions = useMemo(
    () => withCurrentManagedRouteOptions(
      (routeOptions || []).filter((option) => (
        option.kind !== "alias"
        && option.value !== normalizedAliasId
        && option.value !== `alias:${normalizedAliasId}`
      )),
      [...(draft?.targets || []).map((row) => row?.ref), ...(draft?.fallbackTargets || []).map((row) => row?.ref)]
    ),
    [routeOptions, normalizedAliasId, draft?.targets, draft?.fallbackTargets]
  );
  const primaryRefs = (draft?.targets || []).map((row) => String(row?.ref || "").trim());
  const fallbackRefs = (draft?.fallbackTargets || []).map((row) => String(row?.ref || "").trim());
  const allRefs = [...primaryRefs, ...fallbackRefs];
  const allRows = [...(draft?.targets || []), ...(draft?.fallbackTargets || [])];
  const hasBlankRows = allRows.some((row) => !String(row?.ref || "").trim());
  const hasDuplicates = hasDuplicateTrimmedValues(allRefs);
  const hasInvalidWeights = allRows.some((row) => {
    if (!String(row?.ref || "").trim()) return false;
    const weight = Math.floor(Number(row?.weight));
    return !Number.isFinite(weight) || weight <= 0;
  });
  const aliasIdConflict = normalizedAliasId && aliasIds.some((candidate) => candidate !== aliasId && candidate === normalizedAliasId);
  const hasSelfReference = normalizedAliasId
    && allRefs.some((ref) => ref === normalizedAliasId || ref === `alias:${normalizedAliasId}`);
  const hasTargets = allRefs.filter(Boolean).length > 0;
  const initialSignature = JSON.stringify({
    id: initialDraft.id,
    strategy: initialDraft.strategy,
    targets: serializeAliasTargetRows(initialDraft.targets),
    fallbackTargets: serializeAliasTargetRows(initialDraft.fallbackTargets)
  });
  const draftSignature = JSON.stringify({
    id: normalizedAliasId,
    strategy: draft?.strategy,
    targets: serializeAliasTargetRows(draft?.targets),
    fallbackTargets: serializeAliasTargetRows(draft?.fallbackTargets)
  });
  const initialAutosaveSignature = JSON.stringify({
    targets: serializeAliasTargetRows(initialDraft.targets),
    fallbackTargets: serializeAliasTargetRows(initialDraft.fallbackTargets)
  });
  const autosaveSignature = JSON.stringify({
    targets: serializeAliasTargetRows(draft?.targets),
    fallbackTargets: serializeAliasTargetRows(draft?.fallbackTargets)
  });
  const isDirty = initialSignature !== draftSignature;
  const validationIssue = !normalizedAliasId
      ? "Alias id is required."
      : !QUICK_START_ALIAS_ID_PATTERN.test(normalizedAliasId)
        ? "Alias id must start with a letter or number and use letters, numbers, dots, underscores, colons, or hyphens."
        : aliasIdConflict
        ? "Alias id already exists. Choose another id."
        : hasBlankRows
          ? "Fill or remove blank target rows before applying."
          : hasDuplicates
            ? "Duplicate targets are not allowed anywhere in this alias."
            : hasInvalidWeights
              ? "Target weights must be positive integers."
            : hasSelfReference
              ? "An alias cannot target itself."
              : "";
  const issue = disabled ? disabledReason : validationIssue;
  const visibleIssue = disabled
    ? disabledReason
    : (showIssueOnSubmitOnly && validationIssue && !submitAttempted ? "" : validationIssue);
  const locked = disabled || busy;
  const selectedAliasId = String(normalizedAliasId || aliasId || "").trim();
  const selectedAliasLabel = selectedAliasId || "Select alias";
  const removeAliasDisabled = locked || isFixedDefault || isNew;
  const removeAliasLabel = isFixedDefault
    ? "Default alias cannot be removed"
    : `Remove alias ${selectedAliasId || aliasId}`;
  const aliasSwitcherTriggerWidth = useMemo(
    () => measureAliasSwitcherWidth(selectedAliasLabel),
    [selectedAliasLabel]
  );
  const isDefault = isFixedDefault || defaultModel === aliasId || defaultModel === normalizedAliasId;
  const isAmpDefault = ampDefaultRoute === aliasId || ampDefaultRoute === normalizedAliasId;
  const aliasIdPlaceholder = isNew ? "Enter alias name. Example: claude-opus" : undefined;
  const strategyEntries = useMemo(
    () => buildAliasStrategyEntries(draft, alias, routeOptions),
    [draft, alias, routeOptions]
  );

  async function handleApplyClick() {
    setSubmitAttempted(true);
    if (issue) return false;
    const result = await onApply(aliasId, draft);
    if (result && isNew) onDiscard(aliasId);
    return result;
  }

  async function handleSaveStrategy(strategy) {
    const nextDraft = { ...draft, strategy };
    const result = await onApply(aliasId, nextDraft);
    if (!result) return false;
    if (isNew) {
      onDiscard(aliasId);
      return true;
    }
    setDraft(nextDraft);
    return true;
  }

  async function handleInlineAliasRename() {
    setSubmitAttempted(true);
    if (issue) return false;
    const result = await onApply(aliasId, draft);
    if (result) {
      setAliasIdEditing(false);
      setSubmitAttempted(false);
    }
    return result;
  }

  function handleAliasIdBlur() {
    if (alwaysShowAliasIdInput) return;
    if (!hasAliasSwitcher) {
      setAliasIdEditing(false);
      return;
    }

    const currentAliasId = String(aliasId || "").trim();
    const nextAliasId = String(draft?.id || "").trim();
    if (!nextAliasId || nextAliasId === currentAliasId) {
      setDraft((current) => ({ ...current, id: currentAliasId }));
      setAliasIdEditing(false);
      setSubmitAttempted(false);
      return;
    }

    void handleInlineAliasRename();
  }

  function handleAliasIdKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft((current) => ({ ...current, id: initialDraft.id }));
      setAliasIdEditing(false);
      setSubmitAttempted(false);
      return;
    }

    if (!alwaysShowAliasIdInput && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  async function handleAliasIdActionClick() {
    if (showAliasIdInput) {
      const currentAliasId = String(aliasId || "").trim();
      const nextAliasId = String(draft?.id || "").trim();
      if (!nextAliasId || nextAliasId === currentAliasId) {
        setDraft((current) => ({ ...current, id: currentAliasId }));
        setAliasIdEditing(false);
        setSubmitAttempted(false);
        return;
      }
      await handleInlineAliasRename();
      return;
    }

    setAliasIdEditing(true);
  }

  useEffect(() => () => {
    if (typeof window !== "undefined" && autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (isNew || locked || issue || autosaveSignature === initialAutosaveSignature) {
      if (typeof window !== "undefined" && autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = 0;
      }
      if (!isNew && autosaveSignature === initialAutosaveSignature && autosaveState !== "saving") {
        setAutosaveState("idle");
      }
      return undefined;
    }

    if (lastAutosaveAttemptSignatureRef.current === autosaveSignature && autosaveState === "error") {
      return undefined;
    }

    setAutosaveState("pending");
    if (typeof window === "undefined") return undefined;

    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = 0;
      lastAutosaveAttemptSignatureRef.current = autosaveSignature;
      setAutosaveState("saving");
      void onApply(aliasId, draft, {
        showSuccessNotice: false,
        successMessage: ""
      }).then((result) => {
        setAutosaveState(result ? "saved" : "error");
      });
    }, ALIAS_AUTOSAVE_DELAY_MS);

    return () => {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = 0;
      }
    };
  }, [aliasId, autosaveSignature, draft, initialAutosaveSignature, isNew, issue, locked, onApply]);

  const autosaveMessage = isNew
    ? ""
    : autosaveState === "saving"
      ? "Saving alias changes…"
      : autosaveState === "pending"
        ? "Changes save automatically."
        : autosaveState === "saved"
          ? "Alias changes saved."
          : autosaveState === "error"
            ? "Autosave failed. Keep editing to retry."
            : "Changes save automatically.";

  const content = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {hasAliasSwitcher ? (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <div className={cn(
                  "flex h-9 min-w-0 max-w-full overflow-hidden rounded-lg border border-input bg-background/80 shadow-sm transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40",
                  showAliasIdInput ? "flex-1" : "w-fit"
                )}>
                  <div className="flex shrink-0 items-center border-r border-border/70 bg-secondary/55 px-2.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Select an alias
                  </div>
                  {showAliasIdInput ? (
                    <Input
                      ref={aliasIdInputRef}
                      value={draft.id}
                      placeholder={aliasIdPlaceholder}
                      onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
                      onBlur={handleAliasIdBlur}
                      onKeyDown={handleAliasIdKeyDown}
                      disabled={locked || isFixedDefault}
                      className="h-full min-w-[12rem] flex-1 rounded-none border-0 bg-transparent px-3 text-sm font-medium shadow-none focus:border-transparent focus:ring-0"
                    />
                  ) : (
                    <Select value={aliasSwitcher.value || undefined} onValueChange={aliasSwitcher.onValueChange}>
                      <SelectTrigger
                        className="h-full min-w-[10rem] flex-none rounded-none border-0 bg-transparent px-3 pr-[50px] text-left text-sm font-medium shadow-none focus:border-transparent focus:ring-0"
                        style={{ width: `${aliasSwitcherTriggerWidth}px`, maxWidth: "100%" }}
                      >
                        <SelectValue placeholder="Select alias" />
                      </SelectTrigger>
                      <SelectContent>
                        {aliasSwitcher.entries.map(([entryAliasId, entryAlias]) => (
                          <SelectItem
                            key={entryAliasId}
                            value={entryAliasId}
                            searchText={`${entryAliasId} ${(entryAlias?.targets || []).length} ${(entryAlias?.fallbackTargets || []).length}`}
                          >
                            {entryAliasId}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {!showAliasIdInput ? (
                    <button
                      type="button"
                      className="flex h-full w-10 shrink-0 items-center justify-center border-l border-border/70 text-muted-foreground transition hover:bg-accent/60 hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => void onCopyAliasId(selectedAliasId)}
                      disabled={locked || !selectedAliasId}
                      aria-label={`Copy alias id ${selectedAliasId}`}
                      title={selectedAliasId ? `Copy alias id ${selectedAliasId}` : "Alias id is not ready yet"}
                    >
                      <CopyIcon className="h-4 w-4 shrink-0" />
                    </button>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 w-9 rounded-lg border-border/70 bg-background/70 p-0 text-muted-foreground shadow-none hover:bg-background/90 hover:text-foreground"
                  onMouseDown={(event) => {
                    if (showAliasIdInput) event.preventDefault();
                  }}
                  onClick={() => void handleAliasIdActionClick()}
                  disabled={locked || isFixedDefault}
                  aria-label={showAliasIdInput ? "Save alias id" : (isFixedDefault ? "Default alias id cannot be edited" : "Edit alias id")}
                  title={showAliasIdInput ? "Save alias id" : (isFixedDefault ? "Default alias id cannot be edited" : "Edit alias id")}
                >
                  {showAliasIdInput ? <CheckIcon className="h-4 w-4 shrink-0" /> : <EditIcon className="h-4 w-4 shrink-0" />}
                </Button>
                {!isNew ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 w-9 rounded-lg border-border/70 bg-background/70 p-0 text-muted-foreground shadow-none hover:border-destructive hover:bg-background/90 hover:text-destructive"
                    onClick={() => onRemove(aliasId)}
                    disabled={removeAliasDisabled}
                    aria-label={removeAliasLabel}
                    title={removeAliasLabel}
                  >
                    <TrashIcon className="h-4 w-4 shrink-0" />
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                {showAliasIdInput ? (
                  <Input
                    ref={aliasIdInputRef}
                    autoFocus={isNew}
                    value={draft.id}
                    placeholder={aliasIdPlaceholder}
                    onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
                    onBlur={handleAliasIdBlur}
                    onKeyDown={handleAliasIdKeyDown}
                    disabled={locked || (isFixedDefault && !isNew)}
                    className="max-w-[22rem] font-semibold"
                  />
                ) : (
                  isFixedDefault && !isNew ? (
                    <div className="truncate text-base font-semibold text-foreground">{aliasId}</div>
                  ) : (
                    <button
                      type="button"
                      className="group inline-flex max-w-full items-center gap-2 rounded-lg text-left text-base font-semibold text-foreground transition hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      onClick={() => setAliasIdEditing(true)}
                      disabled={locked}
                      aria-label="Edit alias id"
                      title="Edit alias id"
                    >
                      <span className="truncate">{isNew ? (normalizedAliasId || "New alias") : normalizedAliasId || aliasId}</span>
                      <EditIcon className="h-4 w-4 shrink-0" />
                    </button>
                  )
                )}
                {titleAccessory ? <div className="min-w-[11rem] max-w-full">{titleAccessory}</div> : null}
              </>
            )}
          </div>
          {!isFixedDefault ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {isDefault ? <Badge variant="success">Default route</Badge> : null}
              {isAmpDefault ? <Badge variant="info">AMP default</Badge> : null}
            </div>
          ) : null}
        </div>
        <div className="flex items-start gap-2 self-start">
          <Button
            type="button"
            variant="outline"
            size="default"
            className="group h-9 gap-0 overflow-hidden rounded-lg border-border/70 bg-background/70 px-0 text-sm font-medium normal-case tracking-normal shadow-none hover:bg-background/90"
            onClick={() => onOpenStrategyModal({
              aliasLabel: normalizedAliasId || (isNew ? "New alias" : aliasId),
              strategy: draft?.strategy || "auto",
              entries: strategyEntries,
              disabled: locked || Boolean(issue),
              onSave: handleSaveStrategy
            })}
            disabled={locked}
          >
            <span className="flex h-full shrink-0 items-center border-r border-border/70 bg-secondary/55 px-2.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Routing stratergy
            </span>
            <span className="inline-flex min-w-0 items-center gap-2 px-3 text-left">
              <span className="truncate">{formatModelAliasStrategyLabel(draft.strategy || "auto")}</span>
              <EditIcon className="h-4 w-4 shrink-0" />
            </span>
          </Button>
          {!hasAliasSwitcher && !isNew ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 w-9 rounded-lg border-border/70 bg-background/70 p-0 text-muted-foreground shadow-none hover:border-destructive hover:bg-background/90 hover:text-destructive"
              onClick={() => onRemove(aliasId)}
              disabled={removeAliasDisabled}
              aria-label={removeAliasLabel}
              title={removeAliasLabel}
            >
              <TrashIcon className="h-4 w-4 shrink-0" />
            </Button>
          ) : null}
        </div>
      </div>

      <RouteTargetListEditor
        title="Primary targets"
        rows={draft.targets}
        onChange={(targets) => setDraft((current) => ({ ...current, targets }))}
        options={filteredRouteOptions}
        disabled={locked}
        addLabel="Add target"
        emptyLabel="No targets yet. This alias can stay empty until you wire routes back in."
        helperText="Primary targets are tried first. Drag to reorder targets. Weights and metadata stay with the same ref."
        draftPlaceholder="Add a new target"
        showDraftRow
        showDraftFocusButton
        showWeightInput
        filterOtherSelectedValues
        excludedValues={fallbackRefs}
      />

      <RouteTargetListEditor
        title="Fallback targets"
        rows={draft.fallbackTargets}
        onChange={(fallbackTargets) => setDraft((current) => ({ ...current, fallbackTargets }))}
        options={filteredRouteOptions}
        disabled={locked}
        addLabel="Add fallback"
        emptyLabel="No fallback targets configured."
        helperText="Fallback targets only enter the candidate pool after the full primary list. Weights still apply within the chosen routing strategy."
        draftPlaceholder="Add a fallback target"
        showDraftRow
        showDraftFocusButton
        showWeightInput
        filterOtherSelectedValues
        excludedValues={primaryRefs}
      />

      {!visibleIssue ? <div className="text-xs text-muted-foreground">{autosaveMessage}</div> : null}
      {visibleIssue ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{visibleIssue}</div> : null}
      {!visibleIssue && isFixedDefault && !hasTargets ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The fixed <code>default</code> route is empty. Requests routed to <code>default</code> or <code>smart</code> will return 500 until you add a working target.
        </div>
      ) : null}

      {isNew ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Button type="button" variant="ghost" onClick={() => onDiscard(aliasId)} disabled={locked}>Discard</Button>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" onClick={() => void handleApplyClick()} disabled={locked || Boolean(issue)}>
              {busy ? "Saving…" : "Create alias"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (!framed) {
    return content;
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        {content}
      </CardContent>
    </Card>
  );
}
