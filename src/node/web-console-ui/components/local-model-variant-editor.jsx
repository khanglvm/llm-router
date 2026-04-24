import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "./ui/select.jsx";
import { Switch } from "./ui/switch.jsx";
import { Field } from "./shared.jsx";
import { ModelCapabilityToggles } from "./model-capability-toggles.jsx";

export function LocalModelVariantEditor({
  draft,
  baseModel = null,
  duplicateIds = new Set(),
  saveDisabled = false,
  saveDisabledReason = "",
  saving = false,
  onChange,
  onSave,
  onCancel
}) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave?.();
      }}
    >
      {baseModel ? (
        <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Base Model</div>
          <div className="mt-2 text-sm font-medium text-foreground">{baseModel?.displayName || baseModel?.id}</div>
          <div className="mt-1 break-all text-xs text-muted-foreground">{baseModel?.path || "Path not recorded"}</div>
        </div>
      ) : null}
      <Field label="Variant name" stacked>
        <Input
          aria-label="Variant name"
          value={draft?.name || ""}
          onChange={(event) => onChange?.({ ...draft, name: event.target.value })}
        />
      </Field>
      <Field label="Model id" stacked>
        <Input
          aria-label="Model id"
          value={draft?.id || ""}
          onChange={(event) => onChange?.({ ...draft, id: event.target.value })}
        />
        {duplicateIds.has(draft?.id) ? <div className="text-xs text-red-600">Model id already exists.</div> : null}
      </Field>
      <Field label="Preset" stacked>
        <Select value={draft?.preset || "balanced"} onValueChange={(preset) => onChange?.({ ...draft, preset })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="balanced">Balanced</SelectItem>
            <SelectItem value="long-context">Long Context</SelectItem>
            <SelectItem value="low-memory">Low Memory</SelectItem>
            <SelectItem value="fast-response">Fast Response</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Context window" stacked hint="Router-visible max context length for this variant.">
        <Input
          aria-label="Context window"
          inputMode="numeric"
          value={draft?.contextWindow ?? ""}
          onChange={(event) => onChange?.({ ...draft, contextWindow: event.target.value })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Enabled in router" stacked>
          <div className="flex items-center justify-between rounded-xl border border-border/70 px-3 py-2">
            <span className="text-sm text-foreground">Expose this variant to aliases and route pickers</span>
            <Switch checked={draft?.enabled === true} onCheckedChange={(enabled) => onChange?.({ ...draft, enabled })} />
          </div>
        </Field>
        <Field label="Preload on startup" stacked>
          <div className="flex items-center justify-between rounded-xl border border-border/70 px-3 py-2">
            <span className="text-sm text-foreground">Load it when the local runtime starts</span>
            <Switch checked={draft?.preload === true} onCheckedChange={(preload) => onChange?.({ ...draft, preload })} />
          </div>
        </Field>
      </div>
      <Field label="Capability hints" stacked hint="Leave unset unless this model needs a routing override.">
        <ModelCapabilityToggles
          capabilities={draft?.capabilities || {}}
          onChange={(key, value) => {
            const nextCapabilities = { ...(draft?.capabilities || {}) };
            if (typeof value === "boolean") nextCapabilities[key] = value;
            else delete nextCapabilities[key];
            onChange?.({ ...draft, capabilities: nextCapabilities });
          }}
        />
      </Field>
      {saveDisabledReason ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {saveDisabledReason}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => onCancel?.()} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saveDisabled || saving}>
          {saving ? "Saving…" : "Save variant"}
        </Button>
      </div>
    </form>
  );
}
