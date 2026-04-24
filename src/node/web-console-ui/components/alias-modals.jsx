import { useEffect, useMemo, useState } from "react";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.jsx";
import { cn } from "../lib/utils.js";
import { Modal } from "./shared.jsx";
import { normalizeModelAliasStrategyValue, formatModelAliasStrategyLabel } from "../utils.js";
import { buildAliasGuideContextNotes } from "../context-window-utils.js";
import { formatContextWindow } from "../context-window-utils.js";
import { MODEL_ALIAS_STRATEGY_OPTIONS } from "../constants.js";

export function gcd(left, right) {
  let a = Math.abs(Number(left) || 0);
  let b = Math.abs(Number(right) || 0);
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

export function gcdMany(values = []) {
  if (!Array.isArray(values) || values.length === 0) return 1;
  return values.reduce((accumulator, value) => gcd(accumulator, value), 0) || 1;
}

export function formatRouteOptionLabel(ref, routeOptionMap) {
  const normalizedRef = String(ref || "").trim();
  if (!normalizedRef) return "Unconfigured route";
  const option = routeOptionMap.get(normalizedRef);
  if (!option) return normalizedRef;
  const label = String(option.label || normalizedRef).trim() || normalizedRef;
  const hint = String(option.hint || "").trim();
  return hint && hint !== label ? `${label} · ${hint}` : label;
}

export function buildAliasStrategyEntries(draft, alias, routeOptions = []) {
  const routeOptionMap = new Map(
    (routeOptions || [])
      .map((option) => [String(option?.value || "").trim(), option])
      .filter(([value]) => Boolean(value))
  );
  const primarySourceMap = new Map(
    (Array.isArray(alias?.targets) ? alias.targets : [])
      .map((target) => [String(target?.ref || "").trim(), target])
      .filter(([ref]) => Boolean(ref))
  );
  const fallbackSourceMap = new Map(
    (Array.isArray(alias?.fallbackTargets) ? alias.fallbackTargets : [])
      .map((target) => [String(target?.ref || "").trim(), target])
      .filter(([ref]) => Boolean(ref))
  );

  function buildEntries(rows, bucket, sourceMap) {
    return (rows || []).map((row, index) => {
      const ref = String(row?.ref || "").trim();
      const sourceRef = String(row?.sourceRef || row?.ref || "").trim();
      const sourceTarget = sourceMap.get(sourceRef) || sourceMap.get(ref) || {};
      const parsedWeight = Number(row?.weight ?? sourceTarget?.weight);
      const weight = Number.isFinite(parsedWeight) && parsedWeight > 0 ? Math.floor(parsedWeight) : 1;
      return {
        key: `${bucket}-${ref || "empty"}-${index}`,
        ref,
        label: formatRouteOptionLabel(ref, routeOptionMap),
        bucket,
        weight
      };
    }).filter((entry) => Boolean(entry.ref));
  }

  return [
    ...buildEntries(draft?.targets, "primary", primarySourceMap),
    ...buildEntries(draft?.fallbackTargets, "fallback", fallbackSourceMap)
  ];
}

export function buildWeightedPreview(entries = [], limit = 8) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const weights = entries.map((entry) => Math.max(1, Number(entry?.weight) || 1));
  const divisor = gcdMany(weights);
  let slotWeights = weights.map((weight) => Math.max(1, Math.floor(weight / divisor)));
  let totalSlots = slotWeights.reduce((sum, weight) => sum + weight, 0);

  if (totalSlots > 24) {
    const scaleDown = totalSlots / 24;
    slotWeights = slotWeights.map((weight) => Math.max(1, Math.round(weight / scaleDown)));
    totalSlots = slotWeights.reduce((sum, weight) => sum + weight, 0);
  }

  const slots = [];
  for (let index = 0; index < entries.length; index += 1) {
    for (let slotIndex = 0; slotIndex < slotWeights[index]; slotIndex += 1) {
      slots.push(entries[index]);
    }
  }

  return Array.from({ length: Math.max(entries.length, limit) }, (_, index) => slots[index % slots.length]);
}

export function buildAliasStrategyExplanation(strategy, entries = []) {
  const normalizedStrategy = normalizeModelAliasStrategyValue(strategy);
  const strategyLabel = formatModelAliasStrategyLabel(normalizedStrategy);
  const normalizedEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const hasFallbackEntries = normalizedEntries.some((entry) => entry.bucket === "fallback");
  const fallbackNote = hasFallbackEntries
    ? "Runtime builds the candidate pool as all primary targets first, then all fallback targets."
    : "Runtime builds the candidate pool from the primary target list only.";

  if (normalizedStrategy === "round-robin") {
    const sequenceEntries = normalizedEntries.length > 0
      ? Array.from({ length: Math.max(normalizedEntries.length, 8) }, (_, index) => normalizedEntries[index % normalizedEntries.length])
      : [];
    return {
      strategyLabel,
      summary: "Each new request starts from the next candidate in the current pool, then wraps around.",
      poolNote: `${fallbackNote} Round-robin rotates across that combined eligible list.`,
      sequenceLabel: "Example starting candidate by request",
      sequenceEntries,
      footnote: "If a candidate is unhealthy or quota-blocked, it is skipped and the next eligible candidate is chosen."
    };
  }

  if (normalizedStrategy === "weighted-rr" || normalizedStrategy === "quota-aware-weighted-rr" || normalizedStrategy === "auto") {
    const normalizedAuto = normalizedStrategy === "auto";
    const sequenceEntries = buildWeightedPreview(normalizedEntries, 8);
    return {
      strategyLabel,
      summary: normalizedAuto
        ? "`auto` normalizes to quota-aware weighted round-robin in the runtime balancer."
        : normalizedStrategy === "quota-aware-weighted-rr"
          ? "Candidates rotate like weighted round-robin, but low remaining quota or poor health lowers their share."
          : "Candidates repeat in proportion to their configured weights.",
      poolNote: `${fallbackNote} This strategy ranks across the full eligible pool after it is built.`,
      sequenceLabel: "Example starting candidate by request",
      sequenceEntries,
      footnote: normalizedAuto || normalizedStrategy === "quota-aware-weighted-rr"
        ? "When all quotas and health scores are equal, the rotation looks like the weighted example below. Low remaining capacity or retryable failures push a target later."
        : "Weights come from the existing alias target metadata when present. Targets without a stored weight behave as weight 1."
    };
  }

  return {
    strategyLabel,
    summary: "Requests try candidates in the configured list order and only move to later candidates when earlier ones are unavailable or fail.",
    poolNote: `${fallbackNote} Ordered keeps that exact sequence.`,
    sequenceLabel: "Attempt order",
    sequenceEntries: normalizedEntries,
    footnote: "This is the most predictable option when you want a strict preference order."
  };
}

export function ModelAliasStrategyModal({
  open = false,
  onClose = () => {},
  onSave = () => {},
  aliasLabel = "",
  initialStrategy = "auto",
  entries = [],
  disabled = false
}) {
  const normalizedInitialStrategy = normalizeModelAliasStrategyValue(initialStrategy);
  const [selectedStrategy, setSelectedStrategy] = useState(normalizedInitialStrategy);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedStrategy(normalizedInitialStrategy);
    setSaving(false);
  }, [open, normalizedInitialStrategy, aliasLabel]);

  async function handleSaveClick() {
    if (disabled || saving) return;
    setSaving(true);
    try {
      const result = await onSave(selectedStrategy);
      if (result !== false) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={aliasLabel ? `Choose strategy · ${aliasLabel}` : "Choose strategy"}
      description="Review each routing strategy in its own tab. Save applies the currently selected tab to this alias."
      showCloseButton={false}
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSaveClick()}
            disabled={disabled || saving}
          >
            {saving ? "Saving…" : "Save strategy"}
          </Button>
        </div>
      )}
    >
      <Tabs value={selectedStrategy} onValueChange={setSelectedStrategy}>
        <div className="overflow-x-auto pb-1">
          <TabsList className="h-auto min-w-max flex-wrap justify-start gap-2 rounded-2xl bg-secondary/80 p-2">
            {MODEL_ALIAS_STRATEGY_OPTIONS.map((option) => (
              <TabsTrigger key={option.value} value={option.value} className="h-auto min-h-10 rounded-xl px-4 py-2">
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {MODEL_ALIAS_STRATEGY_OPTIONS.map((option) => {
          const strategyExplanation = buildAliasStrategyExplanation(option.value, entries);
          const sequenceEntries = (strategyExplanation.sequenceEntries || []).filter(Boolean);
          return (
            <TabsContent key={option.value} value={option.value} className="mt-4">
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
                <div className="space-y-4">
                  <div className="rounded-2xl border border-border/70 bg-background/80 p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{strategyExplanation.strategyLabel}</Badge>
                      <Badge variant="info">{entries.length} candidate{entries.length === 1 ? "" : "s"}</Badge>
                    </div>
                    <div className="mt-4 space-y-3 text-sm leading-6 text-foreground">
                      <p>{strategyExplanation.summary}</p>
                      <p className="text-muted-foreground">{strategyExplanation.poolNote}</p>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-border/70 bg-background/80 p-5">
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{strategyExplanation.sequenceLabel}</div>
                    {sequenceEntries.length > 0 ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {sequenceEntries.map((entry, index) => (
                          <div key={`${entry.key}-sequence-${index}`} className="rounded-full border border-border/70 bg-card/90 px-3 py-1.5 text-sm text-foreground">
                            <span className="mr-2 text-xs text-muted-foreground">{index + 1}</span>
                            <span>{entry.label}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
                        Add at least one target to preview how this strategy would route requests.
                      </div>
                    )}
                    <div className="mt-4 text-sm leading-6 text-muted-foreground">{strategyExplanation.footnote}</div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-2xl border border-border/70 bg-background/80 p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Current setup</div>
                      {aliasLabel ? <Badge variant="outline">{aliasLabel}</Badge> : null}
                    </div>
                    {entries.length > 0 ? (
                      <div className="mt-4 space-y-2">
                        {entries.map((entry) => (
                          <div key={entry.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-sm">
                            <Badge variant={entry.bucket === "primary" ? "info" : "outline"}>{entry.bucket}</Badge>
                            <span className="font-medium text-foreground">{entry.label}</span>
                            <span className="text-xs text-muted-foreground">weight {entry.weight}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
                        This alias does not have any targets yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </TabsContent>
          );
        })}
      </Tabs>
    </Modal>
  );
}

export function AliasGuideModal({
  open = false,
  onClose = () => {},
  config = {}
}) {
  const mixedContextAliases = useMemo(
    () => buildAliasGuideContextNotes(config),
    [config]
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Alias guide"
      description="Aliases give clients one stable route while letting LLM Router swap, balance, and fail over across provider/model targets behind that route."
      contentClassName="max-h-[92vh] max-w-4xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
      bodyClassName="max-h-[calc(92vh-5.5rem)]"
    >
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Stable route</div>
            <div className="mt-2 text-sm leading-6 text-foreground">Expose one alias like <code>coding</code> or <code>gpt-5.4</code> to clients, then retarget the alias later without touching client config.</div>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Selection strategy</div>
            <div className="mt-2 text-sm leading-6 text-foreground">The alias strategy controls how LLM Router picks from the configured targets. Ordered is strict preference; the other strategies distribute traffic when multiple targets are healthy.</div>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Fallback behavior</div>
            <div className="mt-2 text-sm leading-6 text-foreground">If one target is unavailable or rate limited, LLM Router can continue to later candidates in the same alias instead of failing the whole request immediately.</div>
          </div>
        </div>

        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="warning">Important</Badge>
            <div className="text-sm font-medium text-amber-950">Mixed context windows inside one alias can change behavior.</div>
          </div>
          <div className="mt-3 text-sm leading-6 text-amber-900">
            If an alias mixes models with different context windows, requests that fit the larger model may still fail on the smaller model.
            For example, an alias that includes both a <code>258K</code> model and a <code>128K</code> model can still fail when routing lands on the smaller target.
            Keep aliases aligned by context size when you expect long histories or large prompts.
          </div>
        </div>

        <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Current config check</div>
              <div className="mt-1 text-sm text-muted-foreground">Aliases below currently mix different configured model context windows.</div>
            </div>
            <Badge variant={mixedContextAliases.length > 0 ? "warning" : "success"}>
              {mixedContextAliases.length > 0 ? `${mixedContextAliases.length} alias${mixedContextAliases.length === 1 ? "" : "es"} need review` : "No mixed context windows detected"}
            </Badge>
          </div>

          {mixedContextAliases.length > 0 ? (
            <div className="mt-4 space-y-3">
              {mixedContextAliases.map((summary) => (
                <div key={summary.aliasId} className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{summary.aliasId}</Badge>
                    <div className="text-sm font-medium text-amber-950">
                      Smallest target: {formatContextWindow(summary.smallestContextWindow)}. Largest target: {formatContextWindow(summary.largestContextWindow)}.
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {summary.models.map((model) => (
                      <div key={model.ref} className="rounded-full border border-amber-200 bg-background/90 px-3 py-1.5 text-sm text-foreground">
                        {model.ref} · {formatContextWindow(model.contextWindow)}
                      </div>
                    ))}
                    {summary.unknownRefs.map((ref) => (
                      <div key={ref} className="rounded-full border border-dashed border-amber-300 bg-background/70 px-3 py-1.5 text-sm text-muted-foreground">
                        {ref} · context unknown
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
              No alias currently mixes known context-window sizes across its configured targets.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
