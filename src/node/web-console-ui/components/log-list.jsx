import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "./ui/select.jsx";
import { cn } from "../lib/utils.js";
import { LOG_LEVEL_STYLES, ACTIVITY_FILTER_OPTIONS, ACTIVITY_CATEGORY_META } from "../constants.js";
import { formatTime, getActivityEntryCategory } from "../utils.js";

export function LogList({
  logs,
  activityLogEnabled = true,
  activityFilter = "usage",
  busyAction = "",
  onActivityFilterChange,
  onToggleEnabled,
  onClear
}) {
  const normalizedLogs = Array.isArray(logs) ? logs : [];
  const filteredLogs = normalizedLogs.filter((entry) => activityFilter === "all"
    ? true
    : getActivityEntryCategory(entry) === activityFilter);
  const activeCategoryMeta = ACTIVITY_CATEGORY_META[activityFilter] || ACTIVITY_CATEGORY_META.usage;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Activity</CardTitle>
            <CardDescription>
              {activityLogEnabled
                ? "Router actions, request fallbacks, and runtime issues stream here."
                : "Activity logging is paused. Re-enable it to capture router actions, request fallbacks, and runtime issues."}
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="min-w-[13rem]">
              <Select value={activityFilter} onValueChange={onActivityFilterChange} searchEnabled={false}>
                <SelectTrigger>
                  <SelectValue placeholder="Filter category" />
                </SelectTrigger>
                <SelectContent>
                  {ACTIVITY_FILTER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={onClear} disabled={busyAction !== "" || !logs?.length}>
              {busyAction === "clear" ? "Clearing…" : "Clear log"}
            </Button>
            <Button type="button" size="sm" variant={activityLogEnabled ? "outline" : "default"} onClick={onToggleEnabled} disabled={busyAction !== ""}>
              {busyAction === "toggle"
                ? "Updating…"
                : (activityLogEnabled ? "Disable log" : "Enable log")}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="max-h-[32rem] space-y-3 overflow-auto pr-1">
          {filteredLogs.length ? filteredLogs.map((entry) => {
            const category = getActivityEntryCategory(entry);
            const categoryMeta = ACTIVITY_CATEGORY_META[category] || ACTIVITY_CATEGORY_META.usage;
            return (
            <div key={entry.id} className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className={cn("inline-flex h-2.5 w-2.5 rounded-full ring-4", LOG_LEVEL_STYLES[entry.level] || LOG_LEVEL_STYLES.info)} />
                  <Badge variant={categoryMeta.badgeVariant}>{categoryMeta.label}</Badge>
                  <span className="text-sm font-medium text-foreground">{entry.message}</span>
                </div>
                <span className="text-xs text-muted-foreground">{formatTime(entry.time)}</span>
              </div>
              {entry.detail ? <div className="mt-2 text-sm leading-6 text-muted-foreground">{entry.detail}</div> : null}
            </div>
            );
          }) : normalizedLogs.length ? (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              No {activeCategoryMeta.emptyLabel} activity matches the current filter. Switch the dropdown to inspect the hidden categories.
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              Activity is quiet. Save config changes or start the router to populate this stream.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
