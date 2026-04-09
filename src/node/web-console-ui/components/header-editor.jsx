import { useRef } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { cn } from "../lib/utils.js";
import { MoveUpButton } from "./shared.jsx";
import { hasDuplicateHeaderName } from "../utils.js";
import { normalizeQuickStartHeaderRows } from "../quick-start-utils.js";
import { QUICK_START_FALLBACK_USER_AGENT } from "../constants.js";
import { DragGripIcon } from "../icons.jsx";
import { setDraggingRowClasses, getReorderRowNode, moveItemUp } from "../utils.js";
import { useReorderLayoutAnimation } from "../hooks/use-reorder-layout-animation.js";

export function HeaderEditor({ rows, onChange }) {
  const normalizedRows = normalizeQuickStartHeaderRows(rows);
  const effectiveRows = normalizedRows.length > 0 ? normalizedRows : [{ name: "", value: "" }];

  function updateRow(index, field, value) {
    if (field === "name" && hasDuplicateHeaderName(effectiveRows, value, index)) {
      return;
    }
    onChange(effectiveRows.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row)));
  }

  function addRow() {
    onChange([...effectiveRows, { name: "", value: "" }]);
  }

  function removeRow(index) {
    const nextRows = effectiveRows.filter((_, rowIndex) => rowIndex !== index);
    onChange(nextRows.length > 0 ? nextRows : [{ name: "", value: "" }]);
  }

  return (
    <div className="space-y-2">
      {effectiveRows.map((row, index) => (
        <div key={`header-row-${index}`} className="grid gap-2 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_auto]">
          <Input
            value={row.name}
            onChange={(event) => updateRow(index, "name", event.target.value)}
            placeholder={index === 0 ? "User-Agent" : "Header name"}
          />
          <Input
            value={row.value}
            onChange={(event) => updateRow(index, "value", event.target.value)}
            placeholder={index === 0 ? QUICK_START_FALLBACK_USER_AGENT : "Header value"}
          />
          <Button type="button" variant="ghost" onClick={() => removeRow(index)}>
            Remove
          </Button>
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>User-Agent is included by default. Add more only when a provider needs them.</span>
        <Button type="button" variant="outline" onClick={addRow}>Add custom header</Button>
      </div>
    </div>
  );
}

export function AliasTargetEditor({ providerId, values, onChange }) {
  const normalizedValues = (values || []).map((value) => String(value || "").trim()).filter(Boolean);
  const setAnimatedRowRef = useReorderLayoutAnimation(normalizedValues);
  const draggingModelIdRef = useRef("");
  const draggingNodeRef = useRef(null);

  function removeValue(modelId) {
    onChange((values || []).filter((entry) => entry !== modelId));
  }

  function moveValue(fromModelId, toModelId) {
    if (!fromModelId || !toModelId || fromModelId === toModelId) return;
    const nextValues = [...(values || [])];
    const fromIndex = nextValues.indexOf(fromModelId);
    const toIndex = nextValues.indexOf(toModelId);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = nextValues.splice(fromIndex, 1);
    nextValues.splice(toIndex, 0, moved);
    onChange(nextValues);
  }

  function moveValueUp(modelId) {
    onChange(moveItemUp(values || [], modelId, (entry) => String(entry || "").trim()));
  }

  function clearDraggingState() {
    draggingModelIdRef.current = "";
    setDraggingRowClasses(draggingNodeRef.current, false);
    draggingNodeRef.current = null;
  }

  return (
    <div className="space-y-2">
      <div className="space-y-2 rounded-xl border border-input bg-background/80 px-3 py-3">
        {normalizedValues.length > 0 ? normalizedValues.map((modelId, index) => (
          <div
            key={modelId}
            ref={setAnimatedRowRef(modelId)}
            data-reorder-row="true"
            onDragOver={(event) => {
              if (draggingModelIdRef.current && draggingModelIdRef.current !== modelId) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const fromModelId = event.dataTransfer.getData("text/plain") || draggingModelIdRef.current;
              clearDraggingState();
              moveValue(fromModelId, modelId);
            }}
            className={cn(
              "grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-border/70 bg-card/90 p-3",
            )}
          >
            <span
              className="flex h-8 w-8 cursor-grab items-center justify-center rounded-full text-muted-foreground"
              draggable
              onDragStart={(event) => {
                const rowNode = getReorderRowNode(event.currentTarget);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", modelId);
                if (rowNode && typeof event.dataTransfer?.setDragImage === "function") {
                  event.dataTransfer.setDragImage(rowNode, 20, 20);
                }
                clearDraggingState();
                draggingModelIdRef.current = modelId;
                draggingNodeRef.current = rowNode;
                setDraggingRowClasses(rowNode, true);
              }}
              onDragEnd={clearDraggingState}
              title="Drag to reorder"
            >
              <DragGripIcon className="h-4 w-4" />
            </span>
            <MoveUpButton
              disabled={index === 0}
              label={index === 0 ? "Already first" : `Move ${providerId}/${modelId} up`}
              onClick={() => moveValueUp(modelId)}
            />
            <span className="truncate text-sm font-medium text-foreground">{providerId}/{modelId}</span>
            <button
              className="text-muted-foreground transition hover:text-foreground"
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => removeValue(modelId)}
            >
              ×
            </button>
          </div>
        )) : (
          <span className="block px-1 text-xs text-muted-foreground">Leave it empty for now, or add models to back the fixed <code>default</code> route. An empty default route returns 500 until you add a working model.</span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">Drag rows to change the preferred order, use the arrow to move a model earlier, or remove any models you do not want in this route.</div>
    </div>
  );
}
