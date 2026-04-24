import { cn } from "../lib/utils.js";
import { CAPABILITY_DEFINITIONS, cycleCapabilityValue } from "../capability-utils.js";

function CapabilityToggle({ label, value, disabled, onCycle }) {
  const isSet = typeof value === "boolean";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onCycle}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
        value === true && "border-emerald-200 bg-emerald-50/80",
        value === false && "border-rose-200 bg-rose-50/60",
        !isSet && "border-border/60 bg-secondary/40",
        !disabled && "hover:bg-accent"
      )}
    >
      <span className={cn(
        "inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full text-[8px] font-bold leading-none",
        value === true && "bg-emerald-500 text-white",
        value === false && "bg-rose-400 text-white",
        !isSet && "bg-muted-foreground/25"
      )}>
        {value === true ? "\u2713" : value === false ? "\u2715" : ""}
      </span>
      <span className={cn(
        "select-none whitespace-nowrap font-medium",
        value === true && "text-emerald-800",
        value === false && "text-rose-700 line-through",
        !isSet && "text-muted-foreground"
      )}>
        {label}
      </span>
    </button>
  );
}

export function ModelCapabilityToggles({ capabilities = {}, disabled = false, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="text-[11px] font-medium text-muted-foreground/80">Capabilities</span>
      {CAPABILITY_DEFINITIONS.map(({ key, label }) => {
        const value = capabilities[key];
        return (
          <CapabilityToggle
            key={key}
            label={label}
            value={value}
            disabled={disabled}
            onCycle={() => onChange(key, cycleCapabilityValue(value))}
          />
        );
      })}
    </div>
  );
}
