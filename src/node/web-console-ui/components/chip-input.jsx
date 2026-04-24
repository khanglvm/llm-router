import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils.js";
import { normalizeUniqueTrimmedValues, splitListValues } from "../utils.js";

export function ChipInput({
  values,
  onChange,
  placeholder,
  helperText,
  inputRef = null,
  inputClassName = "",
  suggestedValues = [],
  valueStates = {},
  draftValue = "",
  onDraftValueChange = () => {},
  commitOnBlur = false,
  disabled = false,
  isValueValid = (value) => Boolean(String(value || "").trim()),
  inputProps = {}
}) {
  const normalizedValues = useMemo(() => normalizeUniqueTrimmedValues(values), [values]);
  const [editingValue, setEditingValue] = useState("");
  const [editingDraft, setEditingDraft] = useState("");

  function commit(rawValue = draftValue, { clearDraft = true } = {}) {
    if (disabled) return false;
    const nextValues = splitListValues(rawValue).filter((value) => isValueValid(value));
    if (nextValues.length === 0) {
      if (clearDraft) onDraftValueChange("");
      return false;
    }

    const merged = Array.from(new Set([...(normalizedValues || []), ...nextValues]));
    if (JSON.stringify(merged) !== JSON.stringify(normalizedValues || [])) {
      onChange(merged);
    }
    if (clearDraft) onDraftValueChange("");
    return true;
  }

  function removeChip(value) {
    if (disabled) return;
    onChange(normalizedValues.filter((entry) => entry !== value));
    if (editingValue === value) {
      setEditingValue("");
      setEditingDraft("");
    }
  }

  function handleUseSuggestedValues() {
    if (disabled) return;
    if (!suggestedValues.length) return;
    onChange(Array.from(new Set([...(normalizedValues || []), ...suggestedValues])));
    onDraftValueChange("");
  }

  function startEditing(value) {
    if (disabled) return;
    setEditingValue(value);
    setEditingDraft(value);
  }

  function commitEditedValue(rawValue = editingDraft) {
    if (disabled) {
      setEditingValue("");
      setEditingDraft("");
      return false;
    }
    if (!editingValue) return false;
    const replacementValues = splitListValues(rawValue).filter((value) => isValueValid(value));
    const nextValues = [];
    let replaced = false;
    for (const value of normalizedValues || []) {
      if (value !== editingValue) {
        nextValues.push(value);
        continue;
      }
      if (!replaced) {
        nextValues.push(...replacementValues);
        replaced = true;
      }
    }
    const deduped = Array.from(new Set(nextValues.map((value) => String(value || "").trim()).filter(Boolean)));
    if (JSON.stringify(deduped) !== JSON.stringify(normalizedValues || [])) {
      onChange(deduped);
    }
    setEditingValue("");
    setEditingDraft("");
    return replacementValues.length > 0;
  }

  useEffect(() => {
    if (!disabled || !editingValue) return;
    setEditingValue("");
    setEditingDraft("");
  }, [disabled, editingValue]);

  return (
    <div className="space-y-2">
      <div className={cn(
        "flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-input bg-background/80 px-3 py-2",
        disabled ? "opacity-80" : null
      )}>
        {normalizedValues.map((value) => {
          const state = valueStates?.[value] || "default";
          const chipClassName = state === "success"
            ? "border-emerald-200 bg-emerald-50 text-emerald-900"
            : state === "error"
              ? "border-rose-200 bg-rose-50 text-rose-900"
              : state === "pending"
                ? "border-sky-200 bg-sky-50 text-sky-900"
                : "border-border bg-secondary text-foreground";
          const isEditing = !disabled && editingValue === value;
          return (
            <span key={value} className={cn("inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs", chipClassName)}>
              {isEditing ? (
                <input
                  autoFocus
                  className="min-w-[7rem] bg-transparent text-xs text-foreground outline-none"
                  value={editingDraft}
                  onChange={(event) => setEditingDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      commitEditedValue();
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingValue("");
                      setEditingDraft("");
                    }
                  }}
                  onBlur={() => {
                    commitEditedValue();
                  }}
                />
              ) : (
                <button
                  className="max-w-[16rem] truncate text-left transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70"
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => startEditing(value)}
                  disabled={disabled}
                  title="Click to edit"
                >
                  {value}
                </button>
              )}
              <button
                className="text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => removeChip(value)}
                disabled={disabled}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          {...inputProps}
          ref={inputRef}
          className={cn(
            "min-w-[10rem] flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70",
            inputClassName
          )}
          value={draftValue}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            if (/[\s,]/.test(value)) {
              const parts = value.split(/[\s,]+/);
              const trailing = parts.pop() || "";
              if (parts.length > 0) commit(parts.join(","), { clearDraft: false });
              onDraftValueChange(trailing);
              return;
            }
            onDraftValueChange(value);
          }}
          onKeyDown={(event) => {
            if ((event.key === "," || event.key === " " || event.key === "Enter" || event.key === "Tab") && draftValue.trim()) {
              event.preventDefault();
              commit();
              return;
            }
            if (event.key === "Backspace" && !draftValue && normalizedValues.length > 0) {
              event.preventDefault();
              removeChip(normalizedValues[normalizedValues.length - 1]);
            }
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData?.getData("text") || "";
            if (/[\s,]/.test(pasted)) {
              event.preventDefault();
              const parts = pasted.split(/[\s,]+/).filter(Boolean).filter((value) => isValueValid(value));
              if (parts.length > 0) {
                onChange(Array.from(new Set([...(normalizedValues || []), ...parts])));
                onDraftValueChange("");
              }
              return;
            }
            event.preventDefault();
            onDraftValueChange(`${draftValue}${pasted}`);
          }}
          onBlur={() => {
            if (commitOnBlur && isValueValid(draftValue)) {
              commit(draftValue);
              return;
            }
            onDraftValueChange(draftValue);
          }}
          placeholder={placeholder}
        />
        {normalizedValues.length > 0 || draftValue ? (
          <button
            className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange([]);
              onDraftValueChange("");
            }}
            disabled={disabled}
          >
            Clear all
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {helperText ? <span>{helperText}</span> : null}
        {normalizedValues.length === 0 && suggestedValues.length > 0 ? (
          <button
            className="font-medium uppercase tracking-[0.16em] text-foreground transition hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            onClick={handleUseSuggestedValues}
            disabled={disabled}
          >
            Use suggested values
          </button>
        ) : null}
      </div>
    </div>
  );
}
