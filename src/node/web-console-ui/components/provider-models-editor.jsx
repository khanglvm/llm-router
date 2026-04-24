import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { cn } from "../lib/utils.js";
import { MoveUpButton, MoveDownButton, InlineSpinner } from "./shared.jsx";
import { AdaptiveDropdownPanel } from "./shared.jsx";
import { DragGripIcon } from "../icons.jsx";
import { createProviderModelDraftRows, applyProviderModelEdits } from "../config-editor-utils.js";
import { useReorderLayoutAnimation } from "../hooks/use-reorder-layout-animation.js";
import { getClippingAncestors } from "../dropdown-placement.js";
import {
  normalizeContextWindowInput,
  formatContextWindow,
  formatCompactContextWindowInput,
  formatEditableContextWindowInput,
  buildLiteLlmContextLookupState,
  resolveLiteLlmPrefillContextWindow,
  buildLiteLlmContextLookupMap
} from "../context-window-utils.js";
import { inferQuickStartConnectionType } from "../quick-start-utils.js";
import { ModelCapabilityToggles } from "./model-capability-toggles.jsx";
import { mergeLiteLlmCapabilities, hasExplicitCapabilities } from "../capability-utils.js";
import {
  moveItemsByKey,
  moveItemUp,
  moveItemDown,
  setDraggingRowClasses,
  getReorderRowNode,
  hasDuplicateTrimmedValues
} from "../utils.js";
import { ROW_REMOVE_BUTTON_CLASS } from "../constants.js";

import { lookupLiteLlmContextWindow } from "../api-client.js";

export function ProviderModelsEditor({
  provider,
  disabled = false,
  disabledReason = "",
  busy = false,
  onApply,
  framed = true,
  focusRequest = 0,
  onStateChange = null,
  testStateByModel = {},
  savePhase = "",
  saveMessage = ""
}) {
  const initialRows = useMemo(() => createProviderModelDraftRows(provider), [provider]);
  const [rows, setRows] = useState([]);
  const [submitState, setSubmitState] = useState("");
  const [contextLookupBusy, setContextLookupBusy] = useState(false);
  const [contextLookupPendingByRowKey, setContextLookupPendingByRowKey] = useState({});
  const [contextLookupStateByRowKey, setContextLookupStateByRowKey] = useState({});
  const [contextLookupStatus, setContextLookupStatus] = useState(null);
  const [activeContextLookupRowKey, setActiveContextLookupRowKey] = useState("");
  const [editingContextRowKey, setEditingContextRowKey] = useState("");
  const [editingContextDraftByRowKey, setEditingContextDraftByRowKey] = useState({});
  const rowCounterRef = useRef(0);
  const rowsRef = useRef([]);
  const inputRefs = useRef(new Map());
  const contextInputShellRefs = useRef(new Map());
  const pendingFocusRowKeyRef = useRef("");
  const draggingKeyRef = useRef("");
  const draggingNodeRef = useRef(null);
  const contextLookupCacheRef = useRef(new Map());
  const contextLookupRequestRef = useRef(new Map());

  function createDraftRow(overrides = {}) {
    rowCounterRef.current += 1;
    return {
      key: `model-${provider.id}-draft-${rowCounterRef.current}`,
      id: "",
      sourceId: "",
      contextWindow: "",
      capabilities: {},
      ...overrides
    };
  }

  function focusRow(rowKey) {
    pendingFocusRowKeyRef.current = rowKey;
  }

  function ensureDraftRow(nextRows = [], { preserveFocus = false } = {}) {
    const filledRows = [];
    let draftRow = null;

    for (const row of (Array.isArray(nextRows) ? nextRows : [])) {
      const value = String(row?.id || "");
      const contextWindow = row?.contextWindow === undefined || row?.contextWindow === null
        ? ""
        : String(row.contextWindow);
      if (String(value).trim()) {
        filledRows.push({ ...row, id: value, contextWindow });
        continue;
      }
      if (!draftRow) {
        draftRow = {
          ...row,
          id: "",
          contextWindow
        };
      }
    }

    if (!draftRow) {
      draftRow = createDraftRow();
      if (preserveFocus) focusRow(draftRow.key);
    }

    return [draftRow, ...filledRows];
  }

  function clearContextLookupState(rowKey) {
    setContextLookupStateByRowKey((current) => {
      if (!current[rowKey]) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
  }

  function setRowLookupPending(rowKey, pending) {
    setContextLookupPendingByRowKey((current) => {
      if (pending) {
        if (current[rowKey]) return current;
        return {
          ...current,
          [rowKey]: true
        };
      }
      if (!current[rowKey]) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
  }

  function updateRow(rowKey, patch = {}, { clearLookupState = false, clearStatus = true, closeLookupMenu = false } = {}) {
    if (clearLookupState) clearContextLookupState(rowKey);
    if (clearStatus) setContextLookupStatus(null);
    if (closeLookupMenu && activeContextLookupRowKey === rowKey) {
      setActiveContextLookupRowKey("");
    }
    setRows((current) => ensureDraftRow(
      current.map((row) => (row.key === rowKey ? { ...row, ...patch } : row)),
      { preserveFocus: false }
    ));
  }

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    const nextRows = ensureDraftRow(initialRows, { preserveFocus: true });
    setRows(nextRows);
    rowsRef.current = nextRows;
    contextLookupCacheRef.current.clear();
    contextLookupRequestRef.current.clear();
    setContextLookupPendingByRowKey({});
    setContextLookupStateByRowKey({});
    setContextLookupStatus(null);
    setActiveContextLookupRowKey("");
    setEditingContextRowKey("");
    setEditingContextDraftByRowKey({});
  }, [initialRows]);

  useEffect(() => {
    const rowKey = pendingFocusRowKeyRef.current;
    if (!rowKey) return;
    const input = inputRefs.current.get(rowKey);
    if (!input) return;
    input.scrollIntoView?.({ block: "nearest" });
    input.focus();
    const length = input.value?.length || 0;
    input.setSelectionRange?.(length, length);
    pendingFocusRowKeyRef.current = "";
  }, [rows]);

  useEffect(() => {
    if (!focusRequest) return;
    setRows((current) => {
      const nextRows = ensureDraftRow(current, { preserveFocus: false });
      const draftRow = nextRows.find((row) => !String(row?.id || "").trim()) || nextRows[nextRows.length - 1];
      if (draftRow) focusRow(draftRow.key);
      return nextRows;
    });
  }, [focusRequest]);

  useEffect(() => {
    if (!activeContextLookupRowKey) return;
    if (rows.some((row) => row.key === activeContextLookupRowKey)) return;
    setActiveContextLookupRowKey("");
  }, [rows, activeContextLookupRowKey]);

  useEffect(() => {
    if (!editingContextRowKey) return;
    if (rows.some((row) => row.key === editingContextRowKey)) return;
    setEditingContextRowKey("");
  }, [rows, editingContextRowKey]);

  useEffect(() => {
    setEditingContextDraftByRowKey((current) => {
      const activeRowKeys = new Set(rows.map((row) => row.key));
      let changed = false;
      const next = {};
      for (const [rowKey, value] of Object.entries(current)) {
        if (!activeRowKeys.has(rowKey)) {
          changed = true;
          continue;
        }
        next[rowKey] = value;
      }
      return changed ? next : current;
    });
  }, [rows]);

  useEffect(() => {
    if (!activeContextLookupRowKey || typeof document === "undefined") return undefined;

    function handlePointerDown(event) {
      const activeShell = contextInputShellRefs.current.get(activeContextLookupRowKey);
      if (activeShell?.contains(event.target)) return;
      setActiveContextLookupRowKey("");
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [activeContextLookupRowKey]);

  const filledRows = useMemo(
    () => rows.filter((row) => String(row?.id || "").trim()),
    [rows]
  );

  const normalizedInitialRows = useMemo(
    () => initialRows
      .map((row) => ({
        id: String(row?.id || "").trim(),
        contextWindow: normalizeContextWindowInput(row?.contextWindow || ""),
        capabilities: row?.capabilities || {}
      }))
      .filter((row) => row.id),
    [initialRows]
  );
  const normalizedFilledRows = useMemo(
    () => filledRows.map((row) => ({
      ...row,
      id: String(row?.id || "").trim(),
      contextWindow: normalizeContextWindowInput(row?.contextWindow || "")
    })),
    [filledRows]
  );
  const filledModelIds = normalizedFilledRows.map((row) => row.id);
  const initialModelIds = normalizedInitialRows.map((row) => row.id);
  const newModelIds = filledModelIds.filter((modelId) => !initialModelIds.includes(modelId));
  const hasDuplicates = hasDuplicateTrimmedValues(filledModelIds);
  const hasModels = filledModelIds.length > 0;
  const invalidContextWindowRowKeys = new Set(
    normalizedFilledRows
      .filter((row) => {
        const rawValue = String(row?.contextWindow || "").trim();
        if (!rawValue) return false;
        const parsed = Number.parseInt(rawValue, 10);
        return !Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== rawValue;
      })
      .map((row) => row.key)
  );
  const rowsMissingContextWindow = normalizedFilledRows.filter((row) => !String(row?.contextWindow || "").trim());
  const isDirty = JSON.stringify(normalizedInitialRows) !== JSON.stringify(normalizedFilledRows.map((row) => ({
    id: row.id,
    contextWindow: row.contextWindow,
    capabilities: row.capabilities || {}
  })));
  const actionBusy = submitState !== "" || savePhase === "testing" || savePhase === "saving";
  const locked = disabled || busy || actionBusy || contextLookupBusy;
  const lastFilledRowIndex = useMemo(() => {
    let lastIndex = -1;
    rows.forEach((row, index) => {
      if (String(row?.id || "").trim()) lastIndex = index;
    });
    return lastIndex;
  }, [rows]);
  const issue = disabled
    ? disabledReason
    : !hasModels
      ? "Keep at least one model id on the provider."
      : hasDuplicates
        ? "Model ids must be unique for each provider."
        : invalidContextWindowRowKeys.size > 0
          ? "Context windows must be positive integers when set."
          : "";
  const setAnimatedRowRef = useReorderLayoutAnimation(rows.map((row) => row.key));

  useEffect(() => {
    onStateChange?.({
      isDirty,
      issue,
      locked,
      rows: normalizedFilledRows.map((row) => ({
        ...row,
        contextWindow: normalizeContextWindowInput(row.contextWindow)
      }))
    });
  }, [onStateChange, isDirty, issue, locked, normalizedFilledRows]);

  function removeRow(rowKey) {
    clearContextLookupState(rowKey);
    setRowLookupPending(rowKey, false);
    setContextLookupStatus(null);
    if (activeContextLookupRowKey === rowKey) setActiveContextLookupRowKey("");
    if (editingContextRowKey === rowKey) setEditingContextRowKey("");
    setEditingContextDraftByRowKey((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, rowKey)) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
    setRows((current) => ensureDraftRow(current.filter((row) => row.key !== rowKey)));
  }

  function moveRowUp(rowKey) {
    setRows((current) => ensureDraftRow(moveItemUp(current, rowKey, (row) => row?.key)));
  }

  function moveRowDown(rowKey) {
    setRows((current) => ensureDraftRow(moveItemDown(current, rowKey, (row) => row?.key)));
  }

  function clearDraggingState() {
    draggingKeyRef.current = "";
    setDraggingRowClasses(draggingNodeRef.current, false);
    draggingNodeRef.current = null;
  }

  async function getContextLookupState(modelId, { force = false } = {}) {
    const normalizedModelId = String(modelId || "").trim();
    if (!normalizedModelId) {
      return buildLiteLlmContextLookupState({ query: normalizedModelId });
    }
    if (!force && contextLookupCacheRef.current.has(normalizedModelId)) {
      return contextLookupCacheRef.current.get(normalizedModelId);
    }
    if (!force && contextLookupRequestRef.current.has(normalizedModelId)) {
      return contextLookupRequestRef.current.get(normalizedModelId);
    }

    const request = (async () => {
      const results = await lookupLiteLlmContextWindow([normalizedModelId]);
      const rawLookupResult = (Array.isArray(results) ? results : [])
        .find((entry) => String(entry?.query || "").trim() === normalizedModelId) || { query: normalizedModelId };
      const lookupState = buildLiteLlmContextLookupState(rawLookupResult, { fallbackQuery: normalizedModelId });
      contextLookupCacheRef.current.set(normalizedModelId, lookupState);
      return lookupState;
    })();

    contextLookupRequestRef.current.set(normalizedModelId, request);
    try {
      return await request;
    } finally {
      contextLookupRequestRef.current.delete(normalizedModelId);
    }
  }

  async function ensureContextLookupForRow(rowKey, { openMenu = false, prefill = false, modelId: nextModelId = "" } = {}) {
    const currentRow = rowsRef.current.find((row) => row.key === rowKey);
    const modelId = String(nextModelId || currentRow?.id || "").trim();
    if (!modelId) return null;

    if (openMenu) setActiveContextLookupRowKey(rowKey);
    setRowLookupPending(rowKey, true);

    try {
      const lookupState = await getContextLookupState(modelId);
      setContextLookupStateByRowKey((current) => ({
        ...current,
        [rowKey]: lookupState
      }));

      if (prefill) {
        const prefillValue = resolveLiteLlmPrefillContextWindow(lookupState);
        const prefillCaps = lookupState?.exactMatch?.capabilities;
        if (prefillValue || prefillCaps) {
          setRows((current) => ensureDraftRow(current.map((row) => {
            if (row.key !== rowKey) return row;
            const currentId = String(row?.id || "").trim();
            if (!currentId || currentId !== modelId) return row;
            const patch = {};
            if (prefillValue && !String(row?.contextWindow || "").trim()) {
              patch.contextWindow = prefillValue;
            }
            if (prefillCaps && !hasExplicitCapabilities(row.capabilities)) {
              patch.capabilities = mergeLiteLlmCapabilities(row.capabilities, prefillCaps);
            }
            return Object.keys(patch).length > 0 ? { ...row, ...patch } : row;
          }), { preserveFocus: false }));
        }
      }

      return lookupState;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureState = {
        query: modelId,
        status: "error",
        error: message,
        options: []
      };
      setContextLookupStateByRowKey((current) => ({
        ...current,
        [rowKey]: failureState
      }));
      return failureState;
    } finally {
      setRowLookupPending(rowKey, false);
    }
  }

  async function handleLookupEmptyContextWindows(rowKeys = []) {
    const lookupKeySet = new Set(Array.isArray(rowKeys) ? rowKeys : []);
    const lookupTargets = normalizedFilledRows
      .filter((row) => {
        if (!row.id) return false;
        if (String(row?.contextWindow || "").trim()) return false;
        if (lookupKeySet.size === 0) return true;
        return lookupKeySet.has(row.key);
      })
      .map((row) => ({
        key: row.key,
        id: row.id
      }));

    if (lookupTargets.length === 0) return;

    setContextLookupBusy(true);
    setContextLookupStatus(null);

    try {
      const results = await lookupLiteLlmContextWindow(lookupTargets.map((row) => row.id));
      const lookupByQuery = buildLiteLlmContextLookupMap(results);
      const targetByKey = new Map(lookupTargets.map((row) => [row.key, row]));

      for (const lookupState of lookupByQuery.values()) {
        if (!lookupState?.query) continue;
        contextLookupCacheRef.current.set(lookupState.query, lookupState);
      }

      const currentRows = Array.isArray(rowsRef.current) ? rowsRef.current : [];
      let filledCount = 0;
      let missCount = 0;
      const nextRows = currentRows.map((row) => {
        const target = targetByKey.get(row.key);
        if (!target) return row;

        const currentId = String(row?.id || "").trim();
        const currentContextWindow = String(row?.contextWindow || "").trim();
        if (!currentId || currentId !== target.id || currentContextWindow) return row;

        const lookupState = lookupByQuery.get(currentId) || buildLiteLlmContextLookupState({ query: currentId });
        const prefillValue = resolveLiteLlmPrefillContextWindow(lookupState);
        if (prefillValue) {
          filledCount += 1;
          return {
            ...row,
            contextWindow: prefillValue
          };
        }
        missCount += 1;
        return row;
      });

      setRows(ensureDraftRow(nextRows, { preserveFocus: false }));
      setContextLookupStatus({
        tone: filledCount > 0 ? "success" : "warning",
        message: filledCount > 0
          ? `Filled ${filledCount} context size${filledCount === 1 ? "" : "s"}${missCount > 0 ? `; ${missCount} still need a manual value` : ""}.`
          : `Could not fill ${missCount} model${missCount === 1 ? "" : "s"}.`
      });
    } catch (error) {
      setContextLookupStatus({
        tone: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setContextLookupBusy(false);
    }
  }

  async function handleApply() {
    if (locked || issue || !isDirty) return false;
    const willTestNewModels = inferQuickStartConnectionType(provider) === "api" && newModelIds.length > 0;
    setSubmitState(willTestNewModels ? "testing" : "saving");
    try {
      return await onApply(normalizedFilledRows.map((row) => ({
        ...row,
        contextWindow: normalizeContextWindowInput(row.contextWindow)
      })));
    } finally {
      setSubmitState("");
    }
  }

  return (
    <div className={cn(framed ? "space-y-3 rounded-2xl border border-border/70 bg-background/60 p-4" : "space-y-3")}>
      <div className="rounded-2xl border border-border/70 bg-secondary/35 px-4 py-3 text-sm leading-6 text-muted-foreground">
        Direct routes follow this top-to-bottom order. Focus a context field to load suggested sizes, or use Fill missing context size to fill each empty row with a median size.
      </div>

      <div className="space-y-2">
        {rows.map((row, index) => {
          const trimmedValue = String(row?.id || "").trim();
          const normalizedContextWindow = String(row?.contextWindow || "").trim();
          const isFilledRow = Boolean(trimmedValue);
          const filledRowIndex = isFilledRow
            ? filledRows.findIndex((candidate) => candidate.key === row.key)
            : -1;
          const rowLookupState = contextLookupStateByRowKey[row.key] || null;
          const rowLookupPending = Boolean(contextLookupPendingByRowKey[row.key]);
          const showContextLookupMenu = activeContextLookupRowKey === row.key && Boolean(trimmedValue);
          const hasInvalidContextWindow = invalidContextWindowRowKeys.has(row.key);
          const rowTestState = trimmedValue ? (testStateByModel?.[trimmedValue] || "default") : "default";

          return (
            <div
              key={row.key}
              ref={setAnimatedRowRef(row.key)}
              data-reorder-row="true"
              onDragOver={(event) => {
                if (!locked && draggingKeyRef.current && draggingKeyRef.current !== row.key) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                if (locked) return;
                event.preventDefault();
                const fromKey = event.dataTransfer.getData("text/plain") || draggingKeyRef.current;
                clearDraggingState();
                setRows((current) => ensureDraftRow(moveItemsByKey(current, fromKey, row.key)));
              }}
              className={cn(
                "space-y-2 rounded-xl border border-border/70 bg-card/90 p-3",
                !isFilledRow ? "border-dashed bg-background/85" : null,
                hasInvalidContextWindow ? "border-amber-200 bg-amber-50/70" : null,
                !hasInvalidContextWindow && rowTestState === "success" ? "border-emerald-200 bg-emerald-50/70" : null,
                !hasInvalidContextWindow && rowTestState === "error" ? "border-rose-200 bg-rose-50/70" : null,
                !hasInvalidContextWindow && rowTestState === "pending" ? "border-sky-200 bg-sky-50/70" : null
              )}
            >
              <div className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)_minmax(12rem,14rem)_5.5rem] items-center gap-2">
                <span className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground",
                  isFilledRow && !locked ? "cursor-grab" : "opacity-45"
                )}
                  draggable={!locked && isFilledRow}
                  onDragStart={(event) => {
                    if (locked || !isFilledRow) return;
                    const rowNode = getReorderRowNode(event.currentTarget);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", row.key);
                    if (rowNode && typeof event.dataTransfer?.setDragImage === "function") {
                      event.dataTransfer.setDragImage(rowNode, 20, 20);
                    }
                    clearDraggingState();
                    draggingKeyRef.current = row.key;
                    draggingNodeRef.current = rowNode;
                    setDraggingRowClasses(rowNode, true);
                  }}
                  onDragEnd={clearDraggingState}
                  title={isFilledRow ? "Drag to reorder" : "New model draft row"}
                >
                  <DragGripIcon className="h-4 w-4" />
                </span>
                <MoveUpButton
                  disabled={locked || !isFilledRow || filledRowIndex <= 0}
                  label={!isFilledRow || filledRowIndex <= 0 ? "Already first" : `Move ${row.id || `model ${filledRowIndex + 1}`} up`}
                  onClick={() => moveRowUp(row.key)}
                />
                <MoveDownButton
                  disabled={locked || !isFilledRow || index >= lastFilledRowIndex}
                  label={!isFilledRow || index >= lastFilledRowIndex ? "Already last" : `Move ${row.id || `model ${filledRowIndex + 1}`} down`}
                  onClick={() => moveRowDown(row.key)}
                />
                <Input
                  ref={(node) => {
                    if (node) {
                      inputRefs.current.set(row.key, node);
                    } else {
                      inputRefs.current.delete(row.key);
                    }
                  }}
                  value={row.id}
                  onChange={(event) => updateRow(
                    row.key,
                    { id: event.target.value },
                    { clearLookupState: true, closeLookupMenu: true }
                  )}
                  placeholder={isFilledRow ? "Model id" : "Add a new model id"}
                  disabled={locked}
                />
                <div
                  ref={(node) => {
                    if (node) {
                      contextInputShellRefs.current.set(row.key, node);
                    } else {
                      contextInputShellRefs.current.delete(row.key);
                    }
                  }}
                  className="relative min-w-0"
                >
                  <Input
                    value={editingContextRowKey === row.key
                      ? (editingContextDraftByRowKey[row.key] ?? formatEditableContextWindowInput(row.contextWindow))
                      : formatCompactContextWindowInput(row.contextWindow)}
                    onChange={(event) => {
                      const nextDisplayValue = event.target.value;
                      const normalizedContextWindow = normalizeContextWindowInput(nextDisplayValue);
                      setEditingContextDraftByRowKey((current) => ({
                        ...current,
                        [row.key]: formatEditableContextWindowInput(normalizedContextWindow)
                      }));
                      updateRow(row.key, { contextWindow: normalizedContextWindow }, { clearStatus: false });
                    }}
                    onBlur={(event) => {
                      setEditingContextRowKey((current) => (current === row.key ? "" : current));
                      setEditingContextDraftByRowKey((current) => {
                        if (!Object.prototype.hasOwnProperty.call(current, row.key)) return current;
                        const next = { ...current };
                        delete next[row.key];
                        return next;
                      });
                      updateRow(row.key, { contextWindow: normalizeContextWindowInput(event.target.value) }, { clearStatus: false });
                    }}
                    onFocus={() => {
                      if (!trimmedValue) return;
                      setEditingContextRowKey(row.key);
                      setEditingContextDraftByRowKey((current) => ({
                        ...current,
                        [row.key]: formatEditableContextWindowInput(row.contextWindow)
                      }));
                      void ensureContextLookupForRow(row.key, { openMenu: true });
                    }}
                    onClick={() => {
                      if (!trimmedValue) return;
                      void ensureContextLookupForRow(row.key, { openMenu: true });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" && trimmedValue) {
                        event.preventDefault();
                        void ensureContextLookupForRow(row.key, { openMenu: true });
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setActiveContextLookupRowKey("");
                      }
                    }}
                    placeholder="Context window"
                    inputMode="numeric"
                    disabled={locked || !trimmedValue}
                    className="font-medium tabular-nums"
                    aria-label={trimmedValue ? `Context window for ${trimmedValue}` : "Context window"}
                  />
                  {showContextLookupMenu ? (
                    <AdaptiveDropdownPanel
                      open={showContextLookupMenu}
                      anchorRef={{ current: contextInputShellRefs.current.get(row.key) || null }}
                      preferredSide="top"
                      desiredHeight={224}
                      className="z-20 rounded-lg bg-background/98 p-2"
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      {rowLookupPending ? (
                        <div className="inline-flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
                          <InlineSpinner />
                          Fetching size options for <code>{trimmedValue}</code>.
                        </div>
                      ) : rowLookupState?.status === "error" ? (
                        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                          {rowLookupState.error || "Could not load suggested sizes."}
                        </div>
                      ) : rowLookupState?.options?.length > 0 ? (
                        <div className="space-y-1">
                          {rowLookupState.options.map((option) => (
                            <button
                              key={option.key}
                              type="button"
                              className="flex w-full flex-col gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-left text-sm text-foreground transition hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-70"
                              disabled={locked}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setEditingContextDraftByRowKey((current) => ({
                                  ...current,
                                  [row.key]: formatEditableContextWindowInput(option.contextWindow)
                                }));
                                updateRow(
                                  row.key,
                                  { contextWindow: String(option.contextWindow) },
                                  { clearStatus: false }
                                );
                                setActiveContextLookupRowKey("");
                              }}
                              title={`Use ${option.label}`}
                            >
                              <div className="min-w-0 space-y-1">
                                <div className="break-words font-medium leading-5">{option.label}</div>
                                <div className="break-words text-xs leading-4 text-muted-foreground">{option.detail}</div>
                              </div>
                              <div className="w-full rounded-md border border-border/70 bg-secondary/70 px-3 py-2">
                                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Context size</div>
                                <div className="mt-1 text-lg font-semibold leading-none tabular-nums text-foreground">
                                  {formatContextWindow(option.contextWindow)}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border/70 bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                          No suggested size was found for <code>{rowLookupState?.query || trimmedValue}</code>.
                        </div>
                      )}
                    </AdaptiveDropdownPanel>
                  ) : null}
                </div>
                {isFilledRow ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className={ROW_REMOVE_BUTTON_CLASS}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => removeRow(row.key)}
                    disabled={locked}
                  >
                    Remove
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(ROW_REMOVE_BUTTON_CLASS, "pointer-events-none invisible")}
                    tabIndex={-1}
                    disabled
                    aria-hidden="true"
                  >
                    Remove
                  </Button>
                )}
              </div>

              {isFilledRow && (
                <ModelCapabilityToggles
                  capabilities={row.capabilities || {}}
                  disabled={locked}
                  onChange={(capKey, capValue) => {
                    const nextCaps = { ...(row.capabilities || {}) };
                    if (capValue === undefined) {
                      delete nextCaps[capKey];
                    } else {
                      nextCaps[capKey] = capValue;
                    }
                    updateRow(row.key, { capabilities: nextCaps });
                  }}
                />
              )}

              {rowLookupPending ? (
                <div className="flex justify-end text-xs">
                  <div className="inline-flex items-center gap-1.5 text-sky-700">
                    <InlineSpinner />
                    Looking up sizes
                  </div>
                </div>
              ) : null}

              {hasInvalidContextWindow ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Enter a positive integer like <code>128000</code>, or leave the field blank.
                </div>
              ) : rowTestState === "pending" ? (
                <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
                  Testing this model against the provider endpoint now.
                </div>
              ) : rowTestState === "success" ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                  Confirmed by the latest live provider test.
                </div>
              ) : rowTestState === "error" ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                  This model failed the latest live provider test.
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {issue ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{issue}</div> : null}
      {contextLookupStatus ? (
        <div className={cn(
          "rounded-xl px-3 py-2 text-sm",
          contextLookupStatus.tone === "error"
            ? "border border-rose-200 bg-rose-50 text-rose-900"
            : contextLookupStatus.tone === "warning"
              ? "border border-amber-200 bg-amber-50 text-amber-900"
              : "border border-emerald-200 bg-emerald-50 text-emerald-900"
        )}>
          {contextLookupStatus.message}
        </div>
      ) : null}

      <div
        className={cn(
          "sticky z-10 border-t border-border/70 bg-background/95 pt-3 backdrop-blur",
          framed
            ? "bottom-0"
            : "bottom-0 -mx-5 rounded-b-[1rem] px-5 pb-4"
        )}
      >
        <div className="flex min-h-9 items-center justify-between gap-3">
          <div className={cn(
            "text-xs",
            savePhase === "testing"
              ? "text-sky-700"
              : savePhase === "saving"
                ? "text-foreground"
                : "text-muted-foreground"
          )}>
            {savePhase === "testing" ? (
              <span className="inline-flex items-center gap-1.5">
                <InlineSpinner />
                {saveMessage || "Testing new models before save."}
              </span>
            ) : savePhase === "saving" ? (
              <span className="inline-flex items-center gap-1.5">
                <InlineSpinner />
                {saveMessage || "Saving provider models."}
              </span>
            ) : newModelIds.length > 0 && inferQuickStartConnectionType(provider) === "api"
              ? `${newModelIds.length} new model${newModelIds.length === 1 ? "" : "s"} will be tested before save.`
              : "Existing models keep their current configuration metadata."}
          </div>
          <div className="flex items-center justify-end gap-2">
            {!disabled && !locked && rowsMissingContextWindow.length > 0 ? (
              <Button type="button" variant="outline" onClick={() => void handleLookupEmptyContextWindows()}>
                {contextLookupBusy ? "Filling…" : "Fill missing context size"}
              </Button>
            ) : null}
            {!disabled && !locked && isDirty ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setContextLookupPendingByRowKey({});
                  setContextLookupStateByRowKey({});
                  setContextLookupStatus(null);
                  setActiveContextLookupRowKey("");
                  contextLookupCacheRef.current.clear();
                  contextLookupRequestRef.current.clear();
                  setRows(ensureDraftRow(initialRows, { preserveFocus: true }));
                }}
              >
                Reset
              </Button>
            ) : null}
            {!disabled && isDirty && !issue ? (
              <Button type="button" onClick={() => void handleApply()} disabled={locked}>
                {savePhase === "testing" || submitState === "testing"
                  ? "Testing…"
                  : savePhase === "saving" || submitState === "saving" || busy
                    ? "Saving…"
                    : "Save models"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
