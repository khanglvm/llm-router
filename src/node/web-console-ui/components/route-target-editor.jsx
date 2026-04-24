import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "./ui/select.jsx";
import { cn } from "../lib/utils.js";
import { MoveUpButton, MoveDownButton } from "./shared.jsx";
import { DragGripIcon } from "../icons.jsx";
import { PlusIcon } from "../icons.jsx";
import {
  moveItemsByKey,
  moveItemUp,
  moveItemDown,
  setDraggingRowClasses,
  getReorderRowNode,
  normalizeUniqueTrimmedValues,
  captureScrollSettleSnapshot,
  isScrollSettleSnapshotStable
} from "../utils.js";
import { withCurrentManagedRouteOptions, renderSelectOptionNodes } from "../route-utils.jsx";
import { useReorderLayoutAnimation } from "../hooks/use-reorder-layout-animation.js";
import { getClippingAncestors } from "../dropdown-placement.js";
import { ROW_REMOVE_BUTTON_CLASS } from "../constants.js";

export function RouteTargetListEditor({
  title,
  rows,
  onChange,
  options,
  disabled = false,
  addLabel = "Add target",
  emptyLabel = "No targets configured.",
  helperText = "Drag rows or use the arrow to change routing order.",
  helperAction = null,
  placeholder = "provider/model or alias",
  draftPlaceholder = "Add a new route",
  showDraftRow = false,
  showDraftFocusButton = false,
  showWeightInput = false,
  filterOtherSelectedValues = false,
  excludedValues = []
}) {
  const rowCounterRef = useRef(0);
  const draggingKeyRef = useRef("");
  const draggingNodeRef = useRef(null);
  const rowNodeRefs = useRef(new Map());
  const draftRowScrollFrameRef = useRef(0);
  const draftRowScrollRequestRef = useRef(0);
  const [draftRowOpenSearchRequest, setDraftRowOpenSearchRequest] = useState(0);
  const rowKeyPrefix = useMemo(
    () => String(title || "targets").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "targets",
    [title]
  );
  const draftRowKey = `${rowKeyPrefix}-draft-row`;
  const displayRows = useMemo(() => {
    const filledRows = (rows || []).filter((row) => String(row?.ref || "").trim());
    if (!showDraftRow) return filledRows;
    return [{ key: draftRowKey, ref: "", sourceRef: "" }, ...filledRows];
  }, [rows, showDraftRow, draftRowKey]);
  const setAnimatedRowRef = useReorderLayoutAnimation(displayRows.map((row) => row.key));
  const normalizedExcludedValues = useMemo(
    () => normalizeUniqueTrimmedValues(excludedValues),
    [excludedValues]
  );
  const resolvedOptions = useMemo(
    () => withCurrentManagedRouteOptions(options, [...displayRows.map((row) => row?.ref), ...normalizedExcludedValues]),
    [options, displayRows, normalizedExcludedValues]
  );

  useEffect(() => () => {
    if (typeof window !== "undefined" && draftRowScrollFrameRef.current) {
      window.cancelAnimationFrame(draftRowScrollFrameRef.current);
    }
  }, []);

  function updateRow(rowKey, value) {
    if (showDraftRow && rowKey === draftRowKey) {
      if (!String(value || "").trim()) return;
      rowCounterRef.current += 1;
      onChange([
        {
          key: `${rowKeyPrefix}-draft-${rowCounterRef.current}`,
          ref: value,
          sourceRef: "",
          ...(showWeightInput ? { weight: "1" } : {})
        },
        ...(rows || []).filter((row) => String(row?.ref || "").trim())
      ]);
      return;
    }

    onChange((rows || []).map((row) => (row.key === rowKey ? { ...row, ref: value } : row)));
  }

  function updateWeight(rowKey, value) {
    onChange((rows || []).map((row) => (row.key === rowKey ? { ...row, weight: value } : row)));
  }

  function removeRow(rowKey) {
    onChange((rows || []).filter((row) => row.key !== rowKey));
  }

  function moveRowUp(rowKey) {
    onChange(moveItemUp(rows || [], rowKey, (row) => row?.key));
  }

  function moveRowDown(rowKey) {
    onChange(moveItemDown(rows || [], rowKey, (row) => row?.key));
  }

  function clearDraggingState() {
    draggingKeyRef.current = "";
    setDraggingRowClasses(draggingNodeRef.current, false);
    draggingNodeRef.current = null;
  }

  function addRow() {
    rowCounterRef.current += 1;
    const usedRefs = new Set([
      ...(rows || []).map((row) => String(row?.ref || "").trim()).filter(Boolean),
      ...normalizedExcludedValues
    ]);
    const suggestedRef = resolvedOptions.find((option) => !usedRefs.has(option.value))?.value || "";
    onChange([
      ...(rows || []),
      {
        key: `${rowKeyPrefix}-draft-${rowCounterRef.current}`,
        ref: suggestedRef,
        sourceRef: ""
      }
    ]);
  }

  function handleDraftFocusButtonClick() {
    if (!showDraftRow || disabled) return;
    const rowNode = rowNodeRefs.current.get(draftRowKey);
    if (!rowNode || typeof window === "undefined") {
      setDraftRowOpenSearchRequest((current) => current + 1);
      return;
    }

    draftRowScrollRequestRef.current += 1;
    const scrollRequestId = draftRowScrollRequestRef.current;
    if (draftRowScrollFrameRef.current) {
      window.cancelAnimationFrame(draftRowScrollFrameRef.current);
      draftRowScrollFrameRef.current = 0;
    }

    rowNode.scrollIntoView({ block: "start", behavior: "smooth" });

    const scrollContainers = getClippingAncestors(rowNode);
    let lastSnapshot = captureScrollSettleSnapshot(rowNode, scrollContainers);
    let stableFrames = 0;
    let frameCount = 0;
    const maxFrames = 90;
    const minFrames = 8;
    const stableFramesRequired = 6;
    const settleThreshold = 0.5;

    const waitForScrollSettle = () => {
      if (draftRowScrollRequestRef.current !== scrollRequestId) return;
      const currentRowNode = rowNodeRefs.current.get(draftRowKey) || rowNode;
      const currentSnapshot = captureScrollSettleSnapshot(currentRowNode, scrollContainers);
      if (!Number.isFinite(currentSnapshot.top) || !Number.isFinite(currentSnapshot.left)) {
        draftRowScrollFrameRef.current = 0;
        setDraftRowOpenSearchRequest((current) => current + 1);
        return;
      }

      if (isScrollSettleSnapshotStable(lastSnapshot, currentSnapshot, settleThreshold)) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }

      lastSnapshot = currentSnapshot;
      frameCount += 1;

      if ((frameCount >= minFrames && stableFrames >= stableFramesRequired) || frameCount >= maxFrames) {
        draftRowScrollFrameRef.current = 0;
        setDraftRowOpenSearchRequest((current) => current + 1);
        return;
      }

      draftRowScrollFrameRef.current = window.requestAnimationFrame(waitForScrollSettle);
    };

    draftRowScrollFrameRef.current = window.requestAnimationFrame(waitForScrollSettle);
  }

  return (
    <div className="space-y-2 rounded-2xl border border-border/70 bg-background/55 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{title}</div>
          {showDraftFocusButton && showDraftRow ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 rounded-md p-0 text-muted-foreground hover:text-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleDraftFocusButtonClick}
              disabled={disabled}
              aria-label={addLabel}
              title={addLabel}
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-start justify-end gap-x-3 gap-y-2">
          {helperText ? (
            <div className="max-w-[34rem] text-right text-[11px] leading-4 text-muted-foreground">{helperText}</div>
          ) : null}
          {!showDraftRow ? <Button type="button" variant="ghost" onClick={addRow} disabled={disabled}>{addLabel}</Button> : null}
        </div>
      </div>

      {displayRows.length > 0 ? (
        <div className="space-y-2">
          {displayRows.map((row, index) => {
            const isDraftRow = showDraftRow && row.key === draftRowKey;
            const filledRowIndex = isDraftRow
              ? -1
              : (rows || []).findIndex((candidate) => candidate?.key === row.key);
            const rowOptions = filterOtherSelectedValues
              ? resolvedOptions.filter((option) => {
                const optionValue = String(option?.value || "").trim();
                if (!optionValue) return false;
                if (optionValue === String(row?.ref || "").trim()) return true;
                if (normalizedExcludedValues.includes(optionValue)) return false;
                return !(displayRows || []).some((candidate) => candidate?.key !== row.key && String(candidate?.ref || "").trim() === optionValue);
              })
              : resolvedOptions;
            return (
              <div
                key={row.key}
                ref={(node) => {
                  setAnimatedRowRef(row.key)(node);
                  if (node) {
                    rowNodeRefs.current.set(row.key, node);
                    return;
                  }
                  rowNodeRefs.current.delete(row.key);
                }}
                data-reorder-row="true"
                onDragOver={(event) => {
                  if (!disabled && draggingKeyRef.current && draggingKeyRef.current !== row.key) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(event) => {
                  if (disabled) return;
                  event.preventDefault();
                  const fromKey = event.dataTransfer.getData("text/plain") || draggingKeyRef.current;
                  clearDraggingState();
                  onChange(moveItemsByKey(rows || [], fromKey, row.key));
                }}
                className={cn(
                  showWeightInput
                    ? "grid grid-cols-[auto_auto_auto_minmax(0,1fr)_10rem_5.5rem] items-center gap-2 rounded-xl border border-border/70 bg-card/90 p-3"
                    : "grid grid-cols-[auto_auto_auto_minmax(0,1fr)_5.5rem] items-center gap-2 rounded-xl border border-border/70 bg-card/90 p-3",
                  isDraftRow ? "border-dashed bg-background/85" : null
                )}
              >
                <span className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground",
                  isDraftRow || disabled ? "opacity-45" : "cursor-grab"
                )}
                  draggable={!disabled && !isDraftRow}
                  onDragStart={(event) => {
                    if (disabled || isDraftRow) return;
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
                  title={isDraftRow ? "New route draft row" : "Drag to reorder"}
                >
                  <DragGripIcon className="h-4 w-4" />
                </span>
                <MoveUpButton
                  disabled={disabled || isDraftRow || filledRowIndex <= 0}
                  label={isDraftRow || filledRowIndex <= 0 ? "Already first" : `Move ${row.ref || `target ${filledRowIndex + 1}`} up`}
                  onClick={() => moveRowUp(row.key)}
                />
                <MoveDownButton
                  disabled={disabled || isDraftRow || filledRowIndex === -1 || filledRowIndex >= (rows || []).length - 1}
                  label={isDraftRow || filledRowIndex === -1 || filledRowIndex >= (rows || []).length - 1 ? "Already last" : `Move ${row.ref || `target ${filledRowIndex + 1}`} down`}
                  onClick={() => moveRowDown(row.key)}
                />
                <div className="flex h-9 min-w-0 overflow-hidden rounded-lg border border-input bg-background/80 shadow-sm transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
                  <div className="flex shrink-0 items-center border-r border-border/70 bg-secondary/55 px-2.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Model
                  </div>
                  <Select
                    value={row.ref || undefined}
                    onValueChange={(value) => updateRow(row.key, value)}
                    disabled={disabled}
                    openSearchRequest={isDraftRow ? draftRowOpenSearchRequest : 0}
                  >
                    <SelectTrigger className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-3 shadow-none focus:border-transparent focus:ring-0">
                      <SelectValue placeholder={isDraftRow ? draftPlaceholder : placeholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {rowOptions.length > 0 ? renderSelectOptionNodes(rowOptions, {
                        keyPrefix: `${title}-row-${row.key}`
                      }) : (
                        <SelectItem value="__no-route-options" disabled>No routes available</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                {showWeightInput ? (
                  <div className={cn(
                    "flex h-9 overflow-hidden rounded-lg border border-input bg-background/80 shadow-sm transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40",
                    isDraftRow ? "opacity-45" : null
                  )}>
                    <div className="flex shrink-0 items-center border-r border-border/70 bg-secondary/55 px-2.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                      Weight
                    </div>
                    <Input
                      value={isDraftRow ? "" : String(row?.weight || "1")}
                      onChange={(event) => updateWeight(row.key, event.target.value)}
                      inputMode="numeric"
                      placeholder="1"
                      disabled={disabled || isDraftRow}
                      className="h-full min-w-0 rounded-none border-0 bg-transparent px-3 text-center shadow-none focus:border-transparent focus:ring-0"
                      aria-label={isDraftRow ? "Weight for new target" : `Weight for ${row.ref || `target ${index + 1}`}`}
                    />
                  </div>
                ) : null}
                {!isDraftRow ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className={ROW_REMOVE_BUTTON_CLASS}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => removeRow(row.key)}
                    disabled={disabled}
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
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{emptyLabel}</div>
      )}

      {helperAction ? <div className="flex min-h-8 items-center justify-end">{helperAction}</div> : null}
    </div>
  );
}
