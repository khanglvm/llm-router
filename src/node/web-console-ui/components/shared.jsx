import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Switch } from "./ui/switch.jsx";
import { cn } from "../lib/utils.js";
import { BufferedTextInput } from "../buffered-text-input.js";
import { classifyTransientIntegerInput } from "../transient-integer-input-utils.js";
import { useDropdownPlacement } from "../dropdown-placement.js";

function ArrowUpIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 12V4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.75 7.25 8 4l3.25 3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowDownIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 4v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.75 8.75 8 12l3.25-3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EyeIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M2.5 10s3-5.5 7.5-5.5S17.5 10 17.5 10s-3 5.5-7.5 5.5S2.5 10 2.5 10Z" />
      <circle cx="10" cy="10" r="2.5" />
    </svg>
  );
}

function EyeOffIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8.15 4.85A8.5 8.5 0 0 1 10 4.5c4.5 0 7.5 5.5 7.5 5.5a12.4 12.4 0 0 1-1.67 2.28" />
      <path d="M5.6 5.6A12.2 12.2 0 0 0 2.5 10s3 5.5 7.5 5.5a8.3 8.3 0 0 0 4.4-1.6" />
      <path d="M8.23 8.23a2.5 2.5 0 0 0 3.54 3.54" />
      <path d="M3 3l14 14" />
    </svg>
  );
}

export function CredentialInput({
  value,
  onChange,
  onValueChange,
  placeholder,
  disabled,
  isEnvVar,
  buffered,
  commitOnBlur,
  onValueCommit,
  className,
  inputProps: extraInputProps = {},
  maskMode = "password"
}) {
  const [visible, setVisible] = useState(false);
  const shouldMask = !isEnvVar && !visible;
  const resolvedType = shouldMask && maskMode !== "obscured-text" ? "password" : "text";
  const inputStyle = shouldMask && maskMode === "obscured-text"
    ? {
        ...(extraInputProps?.style && typeof extraInputProps.style === "object" ? extraInputProps.style : {}),
        WebkitTextSecurity: "disc"
      }
    : extraInputProps?.style;
  const inputProps = buffered
    ? {
        value: value || "",
        onValueChange,
        onValueCommit,
        commitOnBlur,
        type: resolvedType,
        autoComplete: "off",
        spellCheck: false,
        placeholder,
        disabled,
        className: cn("flex h-9 w-full rounded-lg rounded-r-none border border-r-0 border-input bg-background/80 px-3 py-2 text-sm text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40", className),
        style: inputStyle,
        ...extraInputProps
      }
    : {
        value: value || "",
        onChange,
        type: resolvedType,
        autoComplete: "off",
        spellCheck: false,
        placeholder,
        disabled,
        className: cn("flex h-9 w-full rounded-lg rounded-r-none border border-r-0 border-input bg-background/80 px-3 py-2 text-sm text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40", className),
        style: inputStyle,
        ...extraInputProps
      };

  return (
    <div className="flex">
      {buffered
        ? <BufferedTextInput {...inputProps} />
        : <input {...inputProps} />}
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg rounded-l-none border border-l-0 border-input bg-background/80 text-muted-foreground transition hover:text-foreground focus:outline-none disabled:pointer-events-none disabled:opacity-50"
        aria-label={visible ? "Hide credential" : "Show credential"}
      >
        {visible ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
      </button>
    </div>
  );
}

export function MoveUpButton({ disabled = false, label = "Move up", onClick }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 w-7 rounded-full p-0"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <ArrowUpIcon className="h-3.5 w-3.5" />
    </Button>
  );
}

export function MoveDownButton({ disabled = false, label = "Move down", onClick }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 w-7 rounded-full p-0"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <ArrowDownIcon className="h-3.5 w-3.5" />
    </Button>
  );
}

export function ProviderStatusDot({ active = false }) {
  if (!active) return null;
  return <span aria-hidden="true" className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />;
}

export function Field({ label, hint, className, children, stacked = false, headerClassName, hintClassName, headerAction = null }) {
  return (
    <div className={cn("flex flex-col gap-2 text-sm", className)}>
      <div className={cn(
        "text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground",
        stacked ? "flex min-h-10 items-start justify-between gap-3" : "flex items-center justify-between gap-2",
        headerClassName
      )}>
        <div className={cn("min-w-0", stacked ? "flex-1 space-y-1" : "flex min-w-0 items-center gap-2")}>
          <span>{label}</span>
          {hint ? (
            <span className={cn(
              "block normal-case tracking-normal text-[11px] text-muted-foreground/80",
              stacked ? "leading-4" : null,
              hintClassName
            )}>{hint}</span>
          ) : null}
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function TransientIntegerInput({ value, onValueChange, disabled = false, allowEmptyCommit = false, ...props }) {
  const canonicalValue = String(value ?? "");
  const [draftValue, setDraftValue] = useState(canonicalValue);

  useEffect(() => {
    setDraftValue(canonicalValue);
  }, [canonicalValue]);

  return (
    <Input
      {...props}
      value={draftValue}
      inputMode="numeric"
      disabled={disabled}
      onChange={(event) => {
        const change = classifyTransientIntegerInput(event.target.value);
        if (!change.accepted) return;
        setDraftValue(change.draftValue);
        if (change.shouldCommit) {
          onValueChange(change.commitValue);
        } else if (allowEmptyCommit && change.draftValue === "") {
          onValueChange("");
        }
      }}
      onBlur={() => {
        setDraftValue((current) => {
          if (current !== "") return current;
          if (allowEmptyCommit) {
            onValueChange("");
            return "";
          }
          return canonicalValue;
        });
      }}
    />
  );
}

export function ToggleField({ label, hint, checked = false, onCheckedChange, disabled = false, className }) {
  return (
    <div className={cn("flex items-center justify-between gap-4 rounded-2xl border border-border/70 bg-background/80 px-4 py-3", className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {hint ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</div> : null}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60"
      />
    </div>
  );
}

export function Modal({
  open = false,
  title = "",
  description = "",
  onClose = () => {},
  children,
  variant = "dialog",
  headerActions = null,
  showCloseButton = true,
  closeDisabled = false,
  closeOnEscape = true,
  closeOnBackdrop = true,
  footer = null,
  contentClassName = "",
  bodyClassName = "",
  footerClassName = ""
}) {
  useEffect(() => {
    if (!open || typeof window === "undefined") return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape" && closeOnEscape) onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeOnEscape, open, onClose]);

  if (!open) return null;
  const isPage = variant === "page";
  const modalContent = (
    <div
      className={cn(
        "fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-sm",
        isPage ? "p-0" : "flex items-center justify-center p-4"
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && closeOnBackdrop) onClose();
      }}
    >
      <div className={cn(
        "overflow-hidden border border-border/70 bg-card/95 shadow-2xl",
        isPage
          ? "flex h-full w-full flex-col rounded-none border-x-0 border-y-0 bg-background/98"
          : "flex max-h-[85vh] w-full max-w-3xl flex-col rounded-3xl",
        contentClassName
      )}>
        <div className={cn(
          "flex items-start justify-between gap-3 border-b border-border/70",
          isPage ? "px-5 py-4 sm:px-6" : "px-5 py-4"
        )}>
          <div className="min-w-0">
            <div className="text-base font-semibold text-foreground">{title}</div>
            {description ? <div className="mt-1 text-sm leading-6 text-muted-foreground">{description}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            {showCloseButton ? (
              <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={closeDisabled}>
                Close
              </Button>
            ) : null}
          </div>
        </div>
        <div className={cn(
          "overflow-y-auto",
          isPage ? "min-h-0 flex-1 px-5 py-4 sm:px-6 sm:py-5" : "min-h-0 flex-1 px-5 py-4",
          bodyClassName
        )}>
          {children}
        </div>
        {footer ? (
          <div className={cn(
            "border-t border-border/70 bg-background/96",
            isPage ? "px-5 py-4 sm:px-6" : "px-5 py-4",
            footerClassName
          )}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (typeof document === "undefined" || !document.body) return modalContent;
  return createPortal(modalContent, document.body);
}

export function AdaptiveDropdownPanel({
  open = false,
  anchorRef,
  preferredSide = "bottom",
  desiredHeight = 288,
  offset = 4,
  className = "",
  children,
  ...props
}) {
  const placement = useDropdownPlacement({
    open,
    anchorRef,
    preferredSide,
    desiredHeight,
    offset
  });

  if (!open) return null;

  return (
    <div
      className={cn(
        "absolute left-0 right-0 z-30 overflow-y-auto rounded-xl border border-border/70 bg-popover shadow-lg",
        placement.side === "top" ? "bottom-full mb-1" : "top-full mt-1",
        className
      )}
      style={{
        maxHeight: `${Math.max(0, Math.floor(placement.maxHeight || desiredHeight))}px`
      }}
      {...props}
    >
      {children}
    </div>
  );
}

export function UnsavedChangesModal({
  open = false,
  onKeepEditing = () => {},
  onDiscardAndClose = () => {},
  onSaveAndClose = () => {},
  saveDisabled = false,
  dirtyLabels = [],
  details = ""
}) {
  const sectionLabel = dirtyLabels.length > 1
    ? `${dirtyLabels.slice(0, -1).join(", ")} and ${dirtyLabels[dirtyLabels.length - 1]}`
    : dirtyLabels[0] || "this form";

  return (
    <Modal
      open={open}
      onClose={onKeepEditing}
      title="Unsaved changes"
      description={`You have unsaved edits in ${sectionLabel}.`}
      contentClassName="max-w-lg rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
      showCloseButton={false}
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onKeepEditing}>
            Keep editing
          </Button>
          <Button type="button" variant="outline" onClick={onDiscardAndClose}>
            Cancel + Close
          </Button>
          <Button type="button" onClick={() => void onSaveAndClose()} disabled={saveDisabled}>
            Save + Close
          </Button>
        </div>
      )}
    >
      <div className="space-y-3 text-sm leading-6 text-muted-foreground">
        <div>Choose whether to save these edits before closing the modal.</div>
        {details ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
            {details}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function FailedModelsCloseModal({
  open = false,
  failedModelIds = [],
  onKeepEditing = () => {},
  onRemoveFailedAndClose = () => {},
  removeDisabled = false
}) {
  const failedLabel = failedModelIds.length > 1
    ? `${failedModelIds.length} failed models`
    : failedModelIds[0] || "the failed model";

  return (
    <Modal
      open={open}
      onClose={onKeepEditing}
      title="Failed model tests"
      description={`Some new models did not pass validation: ${failedLabel}.`}
      contentClassName="max-w-lg rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
      showCloseButton={false}
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onKeepEditing}>
            Keep editing
          </Button>
          <Button type="button" variant="outline" onClick={() => void onRemoveFailedAndClose()} disabled={removeDisabled}>
            Remove failed + close
          </Button>
        </div>
      )}
    >
      <div className="space-y-3 text-sm leading-6 text-muted-foreground">
        <div>Successful new models are still kept in the draft. You can continue editing, or remove only the failed rows and close the modal.</div>
        {failedModelIds.length > 0 ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-900">
            {failedModelIds.join(", ")}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function ValidationPanel({ summary, validationMessages, isDirty }) {
  const variant = detectValidationVariant(summary);
  const badgeVariant = variant === "danger" ? "danger" : variant === "warning" ? "warning" : "success";

  return (
    <div className="rounded-2xl border border-border/70 bg-secondary/45 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badgeVariant}>{summary?.validationSummary || "Waiting for validation"}</Badge>
        {isDirty ? <Badge variant="outline">Unsaved local edits</Badge> : null}
      </div>
      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
        {validationMessages?.length > 0 ? validationMessages.map((entry, index) => (
          <div key={`${entry.message}-${index}`} className="rounded-xl border border-border/70 bg-background/80 px-3 py-2">
            {entry.message}
          </div>
        )) : (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">
            Schema and JSON are in good shape.
          </div>
        )}
      </div>
    </div>
  );
}

export function InlineSpinner() {
  return <span className="mr-2 inline-flex h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent align-[-0.125em]" />;
}

export function SummaryChipButton({ children, onClick, disabled = false, title = "", className = "" }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-background/70 px-2.5 py-1 text-[11px] font-medium tracking-wide text-muted-foreground transition hover:border-primary/35 hover:bg-primary/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title || undefined}
    >
      {children}
    </button>
  );
}

function detectValidationVariant(summary) {
  if (summary?.parseError) return "danger";
  if ((summary?.validationErrors || []).length > 0) return "warning";
  return "success";
}
