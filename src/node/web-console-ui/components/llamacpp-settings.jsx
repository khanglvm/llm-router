import { Badge } from "./ui/badge.jsx";
import { Card, CardContent } from "./ui/card.jsx";

function formatRuntimeStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return { label: "Needs validation", variant: "outline" };
  if (normalized === "running") return { label: "Running", variant: "success" };
  if (normalized === "stale") return { label: "Stale runtime", variant: "warning" };
  if (normalized === "invalid") return { label: "Invalid runtime", variant: "warning" };
  if (normalized === "stopped") return { label: "Stopped", variant: "outline" };
  return { label: normalized, variant: "outline" };
}

export function LlamacppSettingsPanel({
  runtime = {},
  library = {},
  variants = {}
}) {
  const runtimeStatus = formatRuntimeStatus(runtime?.status);
  const libraryEntries = Object.values(library || {});
  const variantEntries = Object.values(variants || {});
  const selectedCommand = String(runtime?.selectedCommand || runtime?.manualCommand || "").trim();
  const host = String(runtime?.host || "127.0.0.1").trim() || "127.0.0.1";
  const port = Number.isFinite(Number(runtime?.port)) ? Number(runtime.port) : 39391;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">llama.cpp Runtime</div>
              <div className="text-lg font-semibold text-foreground">Native runtime configuration</div>
            </div>
            <Badge variant={runtimeStatus.variant}>{runtimeStatus.label}</Badge>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Selected Command</div>
              <div className="mt-2 break-all font-mono text-sm text-foreground">{selectedCommand || "Not configured yet"}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Runtime Address</div>
              <div className="mt-2 font-mono text-sm text-foreground">{`${host}:${port}`}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Start With Router</div>
              <div className="mt-2 text-sm text-foreground">{runtime?.startWithRouter === true ? "Enabled" : "Disabled"}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">Library</div>
            <div className="text-lg font-semibold text-foreground">{libraryEntries.length} tracked base model{libraryEntries.length === 1 ? "" : "s"}</div>
            <div className="text-sm text-muted-foreground">
              Managed Hugging Face downloads and attached GGUF files will appear here. Search/download APIs are ready; the richer library UI lands in the next steps.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">Variants</div>
            <div className="text-lg font-semibold text-foreground">{variantEntries.length} local variant{variantEntries.length === 1 ? "" : "s"}</div>
            <div className="text-sm text-muted-foreground">
              Router-visible local variants, presets, and capacity controls attach to this section once the editor and policy layer are added.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
