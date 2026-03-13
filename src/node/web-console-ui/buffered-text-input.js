import { createElement, forwardRef, useEffect, useRef, useState } from "react";
import { cn } from "./lib/utils.js";

const BASE_INPUT_CLASS_NAME = "flex h-9 w-full rounded-lg border border-input bg-background/80 px-3 py-2 text-sm text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40";

export function syncBufferedTextInputDraft({
  committedValue = "",
  draftValue = "",
  isFocused = false,
  hasLocalDraft = false,
  previousCommittedValue = ""
} = {}) {
  const normalizedCommittedValue = String(committedValue ?? "");
  const normalizedDraftValue = String(draftValue ?? "");
  const normalizedPreviousCommittedValue = String(previousCommittedValue ?? "");

  if (isFocused) {
    return {
      draftValue: normalizedDraftValue,
      hasLocalDraft,
      previousCommittedValue: normalizedCommittedValue
    };
  }

  if (!hasLocalDraft || normalizedCommittedValue === normalizedDraftValue) {
    return {
      draftValue: normalizedCommittedValue,
      hasLocalDraft: false,
      previousCommittedValue: normalizedCommittedValue
    };
  }

  if (normalizedCommittedValue !== normalizedPreviousCommittedValue) {
    return {
      draftValue: normalizedCommittedValue,
      hasLocalDraft: false,
      previousCommittedValue: normalizedCommittedValue
    };
  }

  return {
    draftValue: normalizedDraftValue,
    hasLocalDraft: true,
    previousCommittedValue: normalizedCommittedValue
  };
}

export function resolveBufferedTextInputValue({
  committedValue = "",
  draftValue = "",
  isFocused = false,
  hasLocalDraft = false
} = {}) {
  return (isFocused || hasLocalDraft) ? String(draftValue ?? "") : String(committedValue ?? "");
}

export function resolveBufferedTextInputBlurCommitValue({
  commitOnBlur = false,
  draftValue = "",
  hasLocalDraft = false
} = {}) {
  if (!commitOnBlur || !hasLocalDraft) return null;
  return String(draftValue ?? "");
}

export const BufferedTextInput = forwardRef(function BufferedTextInput(
  {
    className,
    commitOnBlur = false,
    value,
    onValueCommit,
    onValueChange,
    onChange,
    onFocus,
    onBlur,
    ...props
  },
  ref
) {
  const committedValue = String(value ?? "");
  const [draftValue, setDraftValue] = useState(committedValue);
  const [isFocused, setIsFocused] = useState(false);
  const [hasLocalDraft, setHasLocalDraft] = useState(false);
  const previousCommittedValueRef = useRef(committedValue);

  useEffect(() => {
    const nextState = syncBufferedTextInputDraft({
      committedValue,
      draftValue,
      isFocused,
      hasLocalDraft,
      previousCommittedValue: previousCommittedValueRef.current
    });
    previousCommittedValueRef.current = nextState.previousCommittedValue;
    setDraftValue(nextState.draftValue);
    setHasLocalDraft(nextState.hasLocalDraft);
  }, [committedValue, draftValue, hasLocalDraft, isFocused]);

  return createElement("input", {
    ...props,
    ref,
    className: cn(BASE_INPUT_CLASS_NAME, className),
    value: resolveBufferedTextInputValue({
      committedValue,
      draftValue,
      isFocused,
      hasLocalDraft
    }),
    onFocus: (event) => {
      setIsFocused(true);
      onFocus?.(event);
    },
    onChange: (event) => {
      const nextValue = event.target.value;
      setDraftValue(nextValue);
      setHasLocalDraft(true);
      onValueChange?.(nextValue, event);
      onChange?.(event);
    },
    onBlur: (event) => {
      setIsFocused(false);
      const commitValue = resolveBufferedTextInputBlurCommitValue({
        commitOnBlur,
        draftValue,
        hasLocalDraft
      });
      if (commitValue !== null) {
        onValueCommit?.(commitValue, event);
      }
      onBlur?.(event);
    }
  });
});
