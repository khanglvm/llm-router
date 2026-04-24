import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.jsx";
import { cn } from "../lib/utils.js";
import { Field } from "./shared.jsx";
import { AdaptiveDropdownPanel } from "./shared.jsx";
import {
  buildAutoRateLimitBucketId,
  normalizeRateLimitModelSelectors,
  RATE_LIMIT_ALL_MODELS_SELECTOR,
  validateRateLimitDraftRows
} from "../rate-limit-utils.js";
import {
  createRateLimitDraftRow,
  isBlankRateLimitDraftRow,
  resolveRateLimitDraftRows,
  normalizeUniqueTrimmedValues,
  normalizePositiveInteger
} from "../utils.js";
import { QUICK_START_WINDOW_OPTIONS } from "../constants.js";
import { PROVIDER_PRESET_BY_KEY } from "../provider-presets.js";

export function createBlankRateLimitEditorRow(key = "rate-limit-draft-row") {
  return createRateLimitDraftRow({
    key,
    models: [],
    requests: "",
    windowValue: "",
    windowUnit: PROVIDER_PRESET_BY_KEY.custom.rateLimitDefaults.windowUnit
  }, {
    keyPrefix: "rate-limit-draft",
    defaults: PROVIDER_PRESET_BY_KEY.custom.rateLimitDefaults,
    useDefaults: false
  });
}

export function appendRateLimitDraftRow(rows = [], { keyPrefix = "rate-limit-draft" } = {}) {
  const nextKey = `${keyPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return [
    ...(Array.isArray(rows) ? rows : []),
    createBlankRateLimitEditorRow(nextKey)
  ];
}

export function RateLimitModelSelector({
  value = [],
  onChange,
  availableModelIds = [],
  disabled = false
}) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const normalizedValue = useMemo(
    () => normalizeRateLimitModelSelectors(value),
    [value]
  );
  const explicitAll = normalizedValue.includes(RATE_LIMIT_ALL_MODELS_SELECTOR);
  const selectedModelIds = explicitAll ? [] : normalizedValue.filter(Boolean);
  const effectiveAll = explicitAll || selectedModelIds.length === 0;
  const knownModelIds = useMemo(
    () => normalizeUniqueTrimmedValues(availableModelIds),
    [availableModelIds]
  );

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;

    function handlePointerDown(event) {
      if (rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  function commit(nextValues) {
    onChange(normalizeRateLimitModelSelectors(nextValues));
  }

  function handleToggleAll(checked) {
    commit(checked ? [RATE_LIMIT_ALL_MODELS_SELECTOR] : []);
  }

  function handleToggleModel(modelId, checked) {
    const nextValues = checked
      ? [...selectedModelIds, modelId]
      : selectedModelIds.filter((entry) => entry !== modelId);
    commit(nextValues);
  }

  function handleRemoveChip(modelId) {
    if (modelId === RATE_LIMIT_ALL_MODELS_SELECTOR) {
      commit([]);
      return;
    }
    commit(selectedModelIds.filter((entry) => entry !== modelId));
  }

  const chips = explicitAll
    ? [{ key: RATE_LIMIT_ALL_MODELS_SELECTOR, label: "All model", removable: true }]
    : selectedModelIds.length > 0
      ? selectedModelIds.map((modelId) => ({ key: modelId, label: modelId, removable: true }))
      : [{ key: "__implicit-all__", label: "All model", removable: false, muted: true }];

  return (
    <div ref={rootRef} className="relative space-y-1.5">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        className={cn(
          "flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background/80 px-3 py-1.5 text-left text-sm text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/40",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
          open ? "border-ring ring-2 ring-ring/40" : null
        )}
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((current) => !current);
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {chips.map((chip) => chip.removable ? (
            <button
              key={chip.key}
              type="button"
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background px-2 py-0.5 text-xs font-medium text-foreground transition hover:border-accent hover:bg-accent"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleRemoveChip(chip.key);
              }}
              disabled={disabled}
              title={`Remove ${chip.label}`}
            >
              <span className="truncate">{chip.label}</span>
              <span className="text-muted-foreground">x</span>
            </button>
          ) : (
            <span
              key={chip.key}
              className={cn(
                "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                chip.muted
                  ? "border-border/70 bg-secondary/45 text-muted-foreground"
                  : "border-border/70 bg-background text-foreground"
              )}
            >
              <span className="truncate">{chip.label}</span>
            </span>
          ))}
        </div>
        <span className="text-muted-foreground">▾</span>
      </div>

      {open ? (
        <AdaptiveDropdownPanel
          open={open}
          anchorRef={rootRef}
          preferredSide="top"
          desiredHeight={192}
          className="p-2"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground transition hover:bg-secondary/60">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={explicitAll}
              onChange={(event) => handleToggleAll(event.target.checked)}
            />
            <span>All model</span>
          </label>
          <div className="my-1 border-t border-border/70" />
          {knownModelIds.length > 0 ? (
            <div>
              {knownModelIds.map((modelId) => (
                <label key={modelId} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground transition hover:bg-secondary/60">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input"
                    checked={selectedModelIds.includes(modelId)}
                    onChange={(event) => handleToggleModel(modelId, event.target.checked)}
                  />
                  <span className="truncate">{modelId}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="px-2 py-2 text-sm text-muted-foreground">No models available yet.</div>
          )}
        </AdaptiveDropdownPanel>
      ) : null}
    </div>
  );
}

export function RateLimitBucketsEditor({
  rows,
  onChange,
  availableModelIds = [],
  disabled = false,
  inputRef = null,
  helperText = "",
  onValidBlur = null
}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const rootRef = useRef(null);
  const rowsRef = useRef(normalizedRows);
  const knownModelIds = useMemo(
    () => normalizeUniqueTrimmedValues(availableModelIds),
    [availableModelIds]
  );
  const duplicateBucketIds = useMemo(() => {
    const seen = new Set();
    const duplicates = new Set();
    for (const row of resolveRateLimitDraftRows(normalizedRows)) {
      const bucketId = buildAutoRateLimitBucketId(row);
      if (!bucketId) continue;
      if (seen.has(bucketId)) {
        duplicates.add(bucketId);
        continue;
      }
      seen.add(bucketId);
    }
    return duplicates;
  }, [normalizedRows]);
  const displayRows = useMemo(
    () => normalizedRows.map((row) => ({
      ...createBlankRateLimitEditorRow(row.key),
      ...row,
      models: normalizeRateLimitModelSelectors(row?.models || [])
    })),
    [normalizedRows]
  );

  useEffect(() => {
    rowsRef.current = normalizedRows;
  }, [normalizedRows]);

  function updateRows(nextRows) {
    const resolvedRows = Array.isArray(nextRows) ? nextRows : [];
    rowsRef.current = resolvedRows;
    onChange(resolvedRows);
  }

  function updateRow(rowKey, patch) {
    updateRows(normalizedRows.map((row) => (row.key === rowKey ? { ...row, ...patch } : row)));
  }

  function removeRow(rowKey) {
    updateRows(normalizedRows.filter((row) => row.key !== rowKey));
  }

  function getRowIssue(row) {
    if (isBlankRateLimitDraftRow(row)) return "";
    const resolvedModels = normalizeRateLimitModelSelectors(row?.models || []);
    if (knownModelIds.length > 0 && resolvedModels.some((modelId) => modelId !== RATE_LIMIT_ALL_MODELS_SELECTOR && !knownModelIds.includes(modelId))) {
      return "Use exact provider model ids only.";
    }
    if (normalizePositiveInteger(row?.requests, 0) <= 0) return "Requests must be a positive integer.";
    if (normalizePositiveInteger(row?.windowValue, 0) <= 0) return "Window size must be a positive integer.";
    if (!QUICK_START_WINDOW_OPTIONS.includes(String(row?.windowUnit || "").trim())) return "Window unit is invalid.";
    const bucketId = buildAutoRateLimitBucketId({
      requests: row?.requests,
      windowValue: row?.windowValue,
      windowUnit: row?.windowUnit
    });
    if (bucketId && duplicateBucketIds.has(bucketId)) return "Another row already uses this cap.";
    return "";
  }

  function handleRootBlur(event) {
    if (!onValidBlur || disabled) return;
    if (event.currentTarget.contains(event.relatedTarget)) return;
    if (typeof window === "undefined") {
      const resolvedRows = resolveRateLimitDraftRows(rowsRef.current);
      const issue = validateRateLimitDraftRows(resolvedRows, {
        knownModelIds,
        requireAtLeastOne: true
      });
      if (!issue) onValidBlur(resolvedRows);
      return;
    }

    window.setTimeout(() => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(document.activeElement)) return;
      const resolvedRows = resolveRateLimitDraftRows(rowsRef.current);
      const issue = validateRateLimitDraftRows(resolvedRows, {
        knownModelIds,
        requireAtLeastOne: true
      });
      if (!issue) onValidBlur(resolvedRows);
    }, 0);
  }

  return (
    <div ref={rootRef} className="space-y-2.5" onBlurCapture={handleRootBlur}>
      <div className="space-y-2.5">
        {displayRows.map((row, index) => {
          const isEmptyRow = isBlankRateLimitDraftRow(row);
          const rowIssue = getRowIssue(row);
          return (
            <div
              key={row.key}
              className={cn(
                "rounded-2xl border border-border/70 bg-background/70 p-3",
                rowIssue ? "border-amber-200 bg-amber-50/70" : null,
                isEmptyRow ? "border-dashed bg-background/80" : null
              )}
            >
              <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,0.72fr)_minmax(0,0.72fr)_minmax(0,0.86fr)_auto] xl:items-end">
                <Field label="Models" stacked className="gap-1" headerClassName="min-h-0" hintClassName="leading-4">
                  <RateLimitModelSelector
                    value={row.models}
                    onChange={(value) => updateRow(row.key, { models: value })}
                    availableModelIds={knownModelIds}
                    disabled={disabled}
                  />
                </Field>
                <Field label="Request" stacked className="gap-1" headerClassName="min-h-0">
                  <Input
                    ref={index === 0 ? inputRef : null}
                    value={row.requests}
                    onChange={(event) => updateRow(row.key, { requests: event.target.value })}
                    disabled={disabled}
                    inputMode="numeric"
                    placeholder="60"
                  />
                </Field>
                <Field label="Window" stacked className="gap-1" headerClassName="min-h-0">
                  <Input
                    value={row.windowValue}
                    onChange={(event) => updateRow(row.key, { windowValue: event.target.value })}
                    disabled={disabled}
                    inputMode="numeric"
                    placeholder="1"
                  />
                </Field>
                <Field label="Unit" stacked className="gap-1" headerClassName="min-h-0">
                  <Select value={String(row.windowUnit || "minute")} onValueChange={(value) => updateRow(row.key, { windowUnit: value })} disabled={disabled}>
                    <SelectTrigger>
                      <SelectValue placeholder="Window unit" />
                    </SelectTrigger>
                    <SelectContent>
                      {QUICK_START_WINDOW_OPTIONS.map((unit) => (
                        <SelectItem key={`${row.key}-${unit}`} value={unit}>{unit}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Button type="button" variant="ghost" onClick={() => removeRow(row.key)} disabled={disabled} className="xl:self-end">
                  Remove
                </Button>
              </div>
              {rowIssue ? (
                <div className="mt-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {rowIssue}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {helperText ? <div className="text-xs leading-5 text-muted-foreground">{helperText}</div> : null}
    </div>
  );
}
