import { cn } from "../lib/utils.js";

function KeyIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="6.75" cy="10" r="3.25" />
      <path d="M10 10h6.5" />
      <path d="M13.5 10v2.25" />
      <path d="M15.75 10v1.5" />
    </svg>
  );
}

function RotateIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M16.25 10a6.25 6.25 0 1 1-1.83-4.42" />
      <path d="M13.5 3.75h3v3" />
      <path d="M16.5 3.75 12.75 7.5" />
    </svg>
  );
}

function EndpointIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M7.25 5.75h-1.5A2.75 2.75 0 0 0 3 8.5v5.75A2.75 2.75 0 0 0 5.75 17h5.75a2.75 2.75 0 0 0 2.75-2.75v-1.5" />
      <path d="M10.5 9.5 17 3" />
      <path d="M12 3h5v5" />
    </svg>
  );
}

function FileIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 3.5h5.25L15 7.25V16A1.5 1.5 0 0 1 13.5 17.5h-7A1.5 1.5 0 0 1 5 16V5A1.5 1.5 0 0 1 6.5 3.5H6Z" />
      <path d="M11 3.5V7.5H15" />
    </svg>
  );
}

function BackupFileIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 3.5h5.25L15 7.25V16A1.5 1.5 0 0 1 13.5 17.5h-7A1.5 1.5 0 0 1 5 16V5A1.5 1.5 0 0 1 6.5 3.5H6Z" />
      <path d="M11 3.5V7.5H15" />
      <path d="M7 12.25a3 3 0 1 1 2.85 2.99" />
      <path d="M8.5 10.25h1.5v1.5" />
    </svg>
  );
}

export function HeaderAccessChip({
  label,
  value,
  icon,
  disabled = false,
  onClick,
  actionLabel
}) {
  return (
    <button
      type="button"
      className="inline-flex h-9 min-w-0 max-w-full items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3 text-left transition hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-70 sm:max-w-[18rem]"
      onClick={onClick}
      disabled={disabled}
      aria-label={actionLabel}
      title={disabled ? actionLabel : value}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        {icon}
      </span>
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-xs font-medium text-foreground">{value}</span>
    </button>
  );
}

export function HeaderGatewayChip({
  value,
  pending = false,
  disabled = false,
  rotateDisabled = false,
  onCopy,
  onRotate
}) {
  return (
    <div className="flex h-9 min-w-0 max-w-full items-stretch overflow-hidden rounded-full border border-border/70 bg-background/90 sm:max-w-[18rem]">
      <button
        type="button"
        className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-l-full px-3 text-left transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-70"
        onClick={onCopy}
        disabled={disabled}
        aria-label={pending ? "Gateway key is still generating" : "Copy gateway key"}
        title={pending ? "Gateway key is still generating" : "Copy gateway key"}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <KeyIcon className="h-3.5 w-3.5" />
        </span>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Gateway key</span>
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{value}</span>
      </button>
      <button
        type="button"
        className="inline-flex w-9 shrink-0 items-center justify-center rounded-r-full border-l border-border/70 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70"
        onClick={onRotate}
        disabled={rotateDisabled}
        aria-label="Rotate gateway key"
        title="Rotate gateway key"
      >
        <RotateIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function HeaderAccessGroup({
  endpointValue,
  endpointDisabled = false,
  gatewayValue,
  gatewayPending = false,
  gatewayDisabled = false,
  rotateDisabled = false,
  onCopyEndpoint,
  onCopyGatewayKey,
  onRotateKey
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <HeaderAccessChip
        label="Endpoint"
        value={endpointValue}
        icon={<EndpointIcon className="h-3.5 w-3.5" />}
        disabled={endpointDisabled}
        onClick={onCopyEndpoint}
        actionLabel={endpointDisabled ? "API endpoint not ready yet" : "Copy API endpoint"}
      />
      <HeaderGatewayChip
        value={gatewayValue}
        pending={gatewayPending}
        disabled={gatewayDisabled}
        rotateDisabled={rotateDisabled}
        onCopy={onCopyGatewayKey}
        onRotate={onRotateKey}
      />
    </div>
  );
}

export function CompactHeaderChip({
  label,
  value,
  icon,
  disabled = false,
  onClick,
  actionLabel = "",
  emptyLabel = "Not resolved"
}) {
  const displayValue = String(value || "").trim() || emptyLabel;

  return (
    <button
      type="button"
      className="inline-flex min-w-0 max-w-full items-start gap-2 rounded-2xl border border-border/70 bg-background/90 px-3 py-2 text-left transition hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-70"
      onClick={onClick}
      disabled={disabled}
      aria-label={actionLabel}
      title={disabled ? actionLabel : displayValue}
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
        <span className="mt-1 block break-all text-[11px] font-medium leading-4 text-foreground">{displayValue}</span>
      </span>
    </button>
  );
}

export function ConnectedIndicatorDot({
  connected = false,
  className,
  srLabel = "Connected",
  size = "sm"
}) {
  if (!connected) return null;

  const outerSizeClassName = size === "md" ? "h-3.5 w-3.5" : "h-2.5 w-2.5";
  const innerSizeClassName = size === "md" ? "h-2 w-2" : "h-1.5 w-1.5";

  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center", outerSizeClassName, className)}>
      <span aria-hidden="true" className="absolute inset-0 rounded-full bg-emerald-400/45 animate-ping motion-reduce:animate-none" />
      <span aria-hidden="true" className={cn("relative rounded-full bg-emerald-500 ring-2 ring-emerald-500/15", innerSizeClassName)} />
      <span className="sr-only">{srLabel}</span>
    </span>
  );
}

export function ConnectionStatusChipRow({
  primaryLabel = "Config file",
  primaryValue = "",
  primaryIcon = <FileIcon className="h-3 w-3" />,
  onOpenPrimary,
  secondaryLabel = "Backup file",
  secondaryValue = "",
  secondaryIcon = <BackupFileIcon className="h-3 w-3" />,
  onOpenSecondary
}) {
  const resolvedPrimaryValue = String(primaryValue || "").trim();
  const resolvedSecondaryValue = String(secondaryValue || "").trim();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CompactHeaderChip
        label={primaryLabel}
        value={resolvedPrimaryValue}
        icon={primaryIcon}
        disabled={!resolvedPrimaryValue || typeof onOpenPrimary !== "function"}
        onClick={onOpenPrimary}
        actionLabel={resolvedPrimaryValue ? `Open ${primaryLabel.toLowerCase()}` : `${primaryLabel} path is not resolved yet`}
      />
      <CompactHeaderChip
        label={secondaryLabel}
        value={resolvedSecondaryValue}
        icon={secondaryIcon}
        disabled={!resolvedSecondaryValue || typeof onOpenSecondary !== "function"}
        onClick={onOpenSecondary}
        actionLabel={resolvedSecondaryValue ? `Open ${secondaryLabel.toLowerCase()}` : `${secondaryLabel} path is not resolved yet`}
      />
    </div>
  );
}
