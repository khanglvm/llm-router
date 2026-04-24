import { Card, CardContent } from "./ui/card.jsx";
import { Button } from "./ui/button.jsx";

function SummaryMetric({ label, value }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/75 p-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{value}</div>
    </div>
  );
}

export function LocalModelsOverview({ summary, onOpenSection }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryMetric label="Enabled Variants" value={summary?.enabledVariants || 0} />
        <SummaryMetric label="Preloaded" value={summary?.preloadedVariants || 0} />
        <SummaryMetric label="Stale Assets" value={summary?.staleAssets || 0} />
        <SummaryMetric label="Running Runtimes" value={summary?.runningRuntimes || 0} />
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">Quick Access</div>
            <div className="text-lg font-semibold text-foreground">Jump into runtime-specific controls</div>
            <div className="text-sm text-muted-foreground">
              `llama.cpp` covers native GGUF models and managed downloads. Ollama stays available under the same Local Models umbrella.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => onOpenSection?.("llamacpp")}>Open llama.cpp</Button>
            <Button variant="outline" onClick={() => onOpenSection?.("ollama")}>Open Ollama</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
