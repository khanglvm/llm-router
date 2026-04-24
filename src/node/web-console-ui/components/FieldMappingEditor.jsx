import { useState, useRef, useEffect } from "react";
import { Input } from "./ui/input.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.jsx";
import { Badge } from "./ui/badge.jsx";

const FIELDS = [
  { key: "used", placeholder: "$.quota.used_dollars" },
  { key: "limit", placeholder: "$.quota.limit_dollars" },
  { key: "remaining", placeholder: "$.quota.remaining_dollars" },
  { key: "resetAt", placeholder: "$.quota.reset_at" },
  { key: "isUnlimited", placeholder: "$.quota.is_unlimited" }
];

const COERCION_OPTIONS = [
  { value: "number", label: "Number" },
  { value: "datetime", label: "Date/time" },
  { value: "boolean", label: "Boolean" },
  { value: "dollars-from-cents", label: "$ from cents" },
  { value: "raw", label: "Raw" }
];

function defaultAs(key) {
  if (key === "resetAt") return "datetime";
  if (key === "isUnlimited") return "boolean";
  return "number";
}

/** Collect all leaf (non-object, non-array) paths from a JSON value. */
function collectLeafPaths(obj, prefix = "$") {
  if (obj === null || typeof obj !== "object") {
    return [{ path: prefix, value: obj }];
  }
  const paths = [];
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => paths.push(...collectLeafPaths(item, `${prefix}[${i}]`)));
  } else {
    for (const key of Object.keys(obj)) {
      paths.push(...collectLeafPaths(obj[key], `${prefix}.${key}`));
    }
  }
  return paths;
}

function formatPreview(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.length > 24 ? `"${value.slice(0, 24)}\u2026"` : `"${value}"`;
  return String(value);
}

/** Input with a dropdown picker for available JSON paths. Falls back to plain Input when no paths available. */
function PathPickerInput({ value, onChange, placeholder, availablePaths }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!availablePaths || availablePaths.length === 0) {
    return (
      <Input
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 flex-1 text-xs font-mono"
      />
    );
  }

  const filter = value || "";
  const filtered = filter
    ? availablePaths.filter((p) => p.path.toLowerCase().includes(filter.toLowerCase()))
    : availablePaths;

  return (
    <div ref={ref} className="relative flex-1">
      <Input
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="h-7 w-full text-xs font-mono"
      />
      {open && filtered.length > 0 ? (
        <div className="absolute left-0 z-50 mt-1 max-h-48 w-full min-w-64 overflow-auto rounded-lg border border-border bg-popover p-0.5 shadow-lg">
          {filtered.map(({ path: p, value: val }) => (
            <button
              key={p}
              type="button"
              className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-xs text-left${p === value ? " bg-accent" : " hover:bg-accent/60"}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(p); setOpen(false); }}
            >
              <span className="font-mono truncate">{p}</span>
              <span className="shrink-0 text-muted-foreground text-[10px]">{formatPreview(val)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FieldMappingEditor({ mapping = {}, testResult, rawResponse, onChange }) {
  const availablePaths = rawResponse ? collectLeafPaths(rawResponse) : null;

  function updateField(fieldKey, prop, value) {
    const current = mapping[fieldKey] || {};
    onChange({ ...mapping, [fieldKey]: { ...current, [prop]: value } });
  }

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Field mapping
        <span className="ml-2 normal-case tracking-normal text-[11px] text-muted-foreground/70">
          {availablePaths ? "Click a field to pick from response paths." : "Map JSON response paths to normalized snapshot fields."}
        </span>
      </div>
      {FIELDS.map(({ key, placeholder }) => {
        const field = mapping[key] || {};
        const extracted = testResult?.[key];
        return (
          <div key={key} className="flex items-center gap-1.5">
            <span className="w-24 shrink-0 text-xs font-medium font-mono text-foreground">{key}</span>
            <PathPickerInput
              value={field.path || ""}
              onChange={(v) => updateField(key, "path", v)}
              placeholder={placeholder}
              availablePaths={availablePaths}
            />
            <Select
              value={field.as || defaultAs(key)}
              onValueChange={(v) => updateField(key, "as", v)}
            >
              <SelectTrigger className="h-7 w-28 shrink-0 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COERCION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {testResult ? (
              <Badge variant="outline" className="shrink-0 text-[10px] max-w-20 truncate">
                {extracted != null ? String(extracted) : "\u2013"}
              </Badge>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
