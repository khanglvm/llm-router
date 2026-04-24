import { useState } from "react";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";

const ASSIGNABLE_FIELDS = [
  { key: "used", label: "used" },
  { key: "limit", label: "limit" },
  { key: "remaining", label: "remaining" },
  { key: "resetAt", label: "resetAt" },
  { key: "isUnlimited", label: "isUnlimited" }
];

function isLeaf(value) {
  return value === null || typeof value !== "object";
}

/**
 * Recursively render a JSON value as an interactive tree.
 * Leaf rows are clickable at the row level — clicking opens a "Map to…" menu.
 */
function JsonNode({ value, path, depth, assignedPaths, activeMenuPath, onRowClick, onAssign }) {
  const [collapsed, setCollapsed] = useState(depth > 2);

  if (isLeaf(value)) {
    return <LeafValue value={value} path={path} assignedPaths={assignedPaths} isMenuOpen={activeMenuPath === path} onAssign={onAssign} />;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground/60">{"[]"}</span>;
    return (
      <span>
        <button type="button" onClick={() => setCollapsed(!collapsed)} className="text-muted-foreground hover:text-foreground">
          {collapsed ? `[…] ${value.length} items` : "["}
        </button>
        {!collapsed ? (
          <div className="ml-4 border-l border-border/40 pl-2">
            {value.map((item, i) => {
              const childPath = `${path}[${i}]`;
              const childIsLeaf = isLeaf(item);
              return (
                <div
                  key={i}
                  className={`flex gap-1${childIsLeaf ? " cursor-pointer rounded px-1 -mx-1 hover:bg-accent/40 transition-colors" : ""}${childIsLeaf && activeMenuPath === childPath ? " bg-accent/40" : ""}`}
                  onClick={childIsLeaf ? (e) => { e.stopPropagation(); onRowClick(childPath); } : undefined}
                >
                  <span className="shrink-0 text-muted-foreground/50 select-none">{i}:</span>
                  <JsonNode value={item} path={childPath} depth={depth + 1} assignedPaths={assignedPaths} activeMenuPath={activeMenuPath} onRowClick={onRowClick} onAssign={onAssign} />
                </div>
              );
            })}
          </div>
        ) : null}
        {!collapsed ? <span>{"]"}</span> : null}
      </span>
    );
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return <span className="text-muted-foreground/60">{"{}"}</span>;
    return (
      <span>
        <button type="button" onClick={() => setCollapsed(!collapsed)} className="text-muted-foreground hover:text-foreground">
          {collapsed ? `{…} ${keys.length} keys` : "{"}
        </button>
        {!collapsed ? (
          <div className="ml-4 border-l border-border/40 pl-2">
            {keys.map((k) => {
              const childPath = `${path}.${k}`;
              const childIsLeaf = isLeaf(value[k]);
              return (
                <div
                  key={k}
                  className={`flex gap-1${childIsLeaf ? " cursor-pointer rounded px-1 -mx-1 hover:bg-accent/40 transition-colors" : ""}${childIsLeaf && activeMenuPath === childPath ? " bg-accent/40" : ""}`}
                  onClick={childIsLeaf ? (e) => { e.stopPropagation(); onRowClick(childPath); } : undefined}
                >
                  <span className="shrink-0 text-muted-foreground select-none">{k}:</span>
                  <JsonNode value={value[k]} path={childPath} depth={depth + 1} assignedPaths={assignedPaths} activeMenuPath={activeMenuPath} onRowClick={onRowClick} onAssign={onAssign} />
                </div>
              );
            })}
          </div>
        ) : null}
        {!collapsed ? <span>{"}"}</span> : null}
      </span>
    );
  }

  return <span className="text-muted-foreground">{String(value)}</span>;
}

/**
 * A leaf value display. Shows the value, assignment badge, and map-to menu when active.
 * Controlled by parent — isMenuOpen comes from the row-level click state.
 */
function LeafValue({ value, path, assignedPaths, isMenuOpen, onAssign }) {
  const type = value === null ? "null" : typeof value;
  const display = value === null ? "null"
    : typeof value === "string" ? `"${value}"`
    : String(value);

  const assignedTo = assignedPaths.get(path) || null;

  const colorClass = type === "string" ? "text-emerald-600 dark:text-emerald-400"
    : type === "number" ? "text-blue-600 dark:text-blue-400"
    : type === "boolean" ? "text-amber-600 dark:text-amber-400"
    : "text-muted-foreground";

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`${colorClass} font-mono text-xs`}>{display}</span>
      {assignedTo ? (
        <Badge variant="success" className="text-[9px] px-1 py-0 leading-tight">{assignedTo}</Badge>
      ) : null}
      {isMenuOpen ? (
        <span className="inline-flex flex-wrap gap-0.5">
          {ASSIGNABLE_FIELDS.map(({ key, label }) => (
            <Button
              key={key}
              type="button"
              variant={assignedPaths.get(path) === key ? "default" : "outline"}
              size="sm"
              className="h-5 px-1.5 text-[10px]"
              onClick={(e) => {
                e.stopPropagation();
                onAssign(key, path);
              }}
            >
              {"\u2192"} {label}
            </Button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Interactive JSON viewer that lets users click rows to assign leaf values as mapping paths.
 */
export function JsonPathPicker({ raw, mapping = {}, onAssign }) {
  const [expanded, setExpanded] = useState(true);
  const [activeMenuPath, setActiveMenuPath] = useState(null);

  const assignedPaths = new Map();
  for (const [fieldKey, fieldConfig] of Object.entries(mapping)) {
    if (fieldConfig?.path) assignedPaths.set(fieldConfig.path, fieldKey);
  }

  function handleRowClick(path) {
    setActiveMenuPath((current) => current === path ? null : path);
  }

  function handleAssign(fieldKey, jsonPath) {
    onAssign(fieldKey, jsonPath);
    setActiveMenuPath(null);
  }

  if (!raw || typeof raw !== "object") return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Response
          <span className="ml-2 normal-case tracking-normal text-[11px] text-muted-foreground/70">
            Click any row to map it to a field.
          </span>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-6 text-[11px] text-muted-foreground" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </div>
      {expanded ? (
        <div className="max-h-72 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-5">
          <JsonNode value={raw} path="$" depth={0} assignedPaths={assignedPaths} activeMenuPath={activeMenuPath} onRowClick={handleRowClick} onAssign={handleAssign} />
        </div>
      ) : null}
    </div>
  );
}
