import { useState } from "react";
import { Switch } from "./ui/switch.jsx";
import { cn } from "../lib/utils.js";
import { CAPABILITY_DEFINITIONS, cycleCapabilityValue, hasExplicitCapabilities } from "../capability-utils.js";

function CapabilityToggle({ label, value, disabled, onCycle }) {
  const isSet = typeof value === "boolean";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onCycle}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
        !disabled && "hover:bg-secondary/80",
        !isSet && "opacity-50"
      )}
    >
      <span className={cn(
        "inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors",
        value === true && "bg-emerald-500",
        value === false && "bg-muted-foreground/30",
        !isSet && "bg-muted"
      )}>
        <span className={cn(
          "block size-2.5 rounded-full bg-background shadow-sm transition-transform",
          value === true && "translate-x-3",
          value === false && "translate-x-0.5",
          !isSet && "translate-x-[5px]"
        )} />
      </span>
      <span className={cn(
        "select-none whitespace-nowrap",
        value === true && "text-emerald-700 dark:text-emerald-400",
        value === false && "text-muted-foreground line-through",
        !isSet && "text-muted-foreground italic"
      )}>
        {label}
        {!isSet && " (auto)"}
      </span>
    </button>
  );
}

export function ModelCapabilityToggles({ capabilities = {}, disabled = false, onChange }) {
  const [expanded, setExpanded] = useState(false);
  const hasSet = hasExplicitCapabilities(capabilities);

  return (
    <div className="mt-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "text-xs font-medium transition-colors",
          hasSet ? "text-foreground/70" : "text-muted-foreground/60",
          !disabled && "hover:text-foreground"
        )}
      >
        {expanded ? "\u25BE" : "\u25B8"} Capabilities
        {hasSet && <span className="ml-1 text-[10px] text-muted-foreground">(configured)</span>}
      </button>

      {expanded && (
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 pl-2">
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
      )}
    </div>
  );
}
