import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";

function resolveStateBadge(snapshot, circuitOpen) {
  if (circuitOpen) return { label: "Probe unhealthy", variant: "warning" };
  if (!snapshot) return { label: "No data", variant: "outline" };
  if (snapshot.isUnlimited) return { label: "Unlimited", variant: "success" };
  if (snapshot.state === "fresh" && typeof snapshot.remaining === "number" && snapshot.remaining <= 0) {
    return { label: "Exhausted", variant: "destructive" };
  }
  if (snapshot.state === "fresh") return { label: "Available", variant: "success" };
  if (snapshot.state === "errored") return { label: "Error", variant: "destructive" };
  if (snapshot.state === "stale") return { label: "Stale", variant: "warning" };
  return { label: "Unknown", variant: "outline" };
}

function formatAge(ms) {
  if (!ms || ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function formatResetIn(resetAtMs, now) {
  if (!resetAtMs) return null;
  const ms = resetAtMs - (now || Date.now());
  if (ms <= 0) return "resets soon";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

export function LiveSnapshotPanel({ snapshot, circuitOpen, onRefresh, now }) {
  const badge = resolveStateBadge(snapshot, circuitOpen);
  const currentTime = now || Date.now();
  const age = snapshot?.fetchedAt ? currentTime - snapshot.fetchedAt : null;
  const hasUsage = typeof snapshot?.used === "number" && typeof snapshot?.limit === "number" && snapshot.limit > 0;
  const pct = hasUsage ? Math.min(100, Math.round((snapshot.used / snapshot.limit) * 100)) : 0;
  const errorMsg = snapshot?.error?.message || (typeof snapshot?.error === "string" ? snapshot.error : null);

  return (
    <div className="rounded-2xl border border-border/70 bg-secondary/45 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {age !== null ? (
            <span className="text-xs text-muted-foreground">last refreshed {formatAge(age)}</span>
          ) : null}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh}>Refresh</Button>
      </div>
      {hasUsage ? (
        <div className="space-y-1">
          <div className="flex items-baseline gap-1 text-sm">
            <span className="font-medium">${snapshot.used.toFixed(2)}</span>
            <span className="text-muted-foreground">/ ${snapshot.limit.toFixed(2)} used</span>
            {snapshot.resetAt ? (
              <span className="ml-2 text-muted-foreground">{formatResetIn(snapshot.resetAt, currentTime)}</span>
            ) : null}
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div className={`h-full rounded-full transition-all ${pct >= 95 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : null}
      {errorMsg ? (
        <div className="text-xs text-destructive">{errorMsg}</div>
      ) : null}
    </div>
  );
}
