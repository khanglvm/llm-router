import { useState } from "react";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.jsx";
import { Input } from "./ui/input.jsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from "./ui/select.jsx";
import { Field } from "./shared.jsx";
import { ConnectionStatusChipRow } from "./header-chips.jsx";
import { formatTime } from "../utils.js";
import { BufferedTextInput } from "../buffered-text-input.js";

// ── Local helpers (mirrors of app.jsx private functions) ──────────────────────

function inferManagedRouteOptionMetadata(value = "") {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return {};

  const normalizedAliasValue = normalizedValue.startsWith("alias:")
    ? normalizedValue.slice("alias:".length).trim()
    : normalizedValue;
  if (!normalizedAliasValue.includes("/")) {
    return { kind: "alias", groupKey: "aliases", groupLabel: "Aliases" };
  }

  const separatorIndex = normalizedAliasValue.indexOf("/");
  const providerId = normalizedAliasValue.slice(0, separatorIndex).trim();
  if (!providerId) return {};
  return { kind: "model", providerId, groupKey: `provider:${providerId}`, groupLabel: providerId };
}

function buildGroupedSelectOptions(options = []) {
  const groups = [];
  const groupsByKey = new Map();
  let ungroupedGroup = null;

  for (const option of (Array.isArray(options) ? options : []).filter(Boolean)) {
    const groupKey = String(option?.groupKey || option?.groupLabel || "").trim();
    const groupLabel = String(option?.groupLabel || "").trim();

    if (!groupKey) {
      if (!ungroupedGroup) {
        ungroupedGroup = { key: "__ungrouped__", label: "", options: [] };
        groups.push(ungroupedGroup);
      }
      ungroupedGroup.options.push(option);
      continue;
    }

    let group = groupsByKey.get(groupKey);
    if (!group) {
      group = { key: groupKey, label: groupLabel || groupKey, options: [] };
      groupsByKey.set(groupKey, group);
      groups.push(group);
    }
    group.options.push(option);
  }

  return groups;
}

function formatRouteOptionSelectLabel(option = {}, { includeHint = false } = {}) {
  const label = String(option?.label || option?.value || "").trim() || String(option?.value || "").trim();
  const hint = String(option?.hint || "").trim();
  return includeHint && hint ? `${label} · ${hint}` : label;
}

function renderSelectOptionNodes(options = [], { keyPrefix = "select-option", includeHint = false } = {}) {
  return buildGroupedSelectOptions(options).map((group, groupIndex) => {
    const items = group.options.map((option) => (
      <SelectItem
        key={`${keyPrefix}-${option.value}`}
        value={option.value}
        searchText={`${option.label || ""} ${option.value || ""} ${option.hint || ""} ${group.label || ""}`}
      >
        {formatRouteOptionSelectLabel(option, { includeHint })}
      </SelectItem>
    ));

    if (!group.label) return items;
    return (
      <SelectGroup key={`${keyPrefix}-group-${group.key || groupIndex}`}>
        <SelectLabel>{group.label}</SelectLabel>
        {items}
      </SelectGroup>
    );
  });
}

function SecretFileIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M10 2.75 4.75 5v4.12c0 3.42 2.1 6.58 5.25 7.88 3.15-1.3 5.25-4.46 5.25-7.88V5L10 2.75Z" />
      <circle cx="10" cy="9" r="1.4" />
      <path d="M10 10.4v2.1" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function AmpSettingsPanel({
  rows,
  routeOptions,
  webSearchSnapshot,
  ampClientUrl,
  ampClientGlobal,
  routingBusy,
  onToggleGlobalRouting,
  onInboundChange,
  onOutboundChange,
  onCreateEntry,
  onRemoveEntry,
  onOpenWebSearchTab,
  onOpenConfigPath,
  onOpenSecretsPath,
  hasMasterKey,
  disabledReason,
  autosaveState
}) {
  const [addingEntry, setAddingEntry] = useState(false);
  const [newInbound, setNewInbound] = useState("");
  const [newOutbound, setNewOutbound] = useState(String(routeOptions[0]?.value || "").trim());
  const hasNewInboundDuplicate = rows.some((row) => String(row?.inbound || "").trim() === String(newInbound || "").trim() && String(newInbound || "").trim());
  const canCreateEntry = String(newInbound || "").trim() && String(newOutbound || "").trim() && !hasNewInboundDuplicate;
  const globalRoutingEnabled = ampClientGlobal?.routedViaRouter === true;
  const globalRoutingError = String(ampClientGlobal?.error || "").trim();
  const canEnableGlobalRouting = Boolean(hasMasterKey && ampClientUrl && !disabledReason && !globalRoutingError);
  const configuredSearchProviderCount = Number(webSearchSnapshot?.configuredProviderCount) || 0;
  const showWebSearchWarning = globalRoutingEnabled && configuredSearchProviderCount === 0;

  const statusVariant = disabledReason
    ? "warning"
    : autosaveState.status === "error"
      ? "danger"
      : autosaveState.status === "pending"
        ? "outline"
      : autosaveState.status === "saving"
        ? "info"
        : autosaveState.savedAt
          ? "success"
          : "outline";

  const statusLabel = disabledReason
    ? "Needs review"
    : autosaveState.status === "error"
      ? "Save failed"
        : autosaveState.status === "pending"
          ? "Unsaved"
        : autosaveState.status === "saving"
          ? "saving..."
        : autosaveState.savedAt
          ? "Saved"
          : "Ready";

  const statusMessage = disabledReason
    ? disabledReason
    : autosaveState.status === "error"
      ? autosaveState.message
      : autosaveState.status === "pending"
        ? "Unsaved changes queued. Auto-save will run shortly."
      : autosaveState.status === "saving"
        ? "Saving changes..."
      : autosaveState.savedAt
        ? `Last saved ${formatTime(autosaveState.savedAt)}.`
        : "AMP route changes auto-save after valid edits.";

  async function handleSubmitNewEntry() {
    if (!canCreateEntry) return;
    const result = await onCreateEntry?.({ inbound: newInbound, outbound: newOutbound });
    if (result === false) return;
    setAddingEntry(false);
    setNewInbound("");
    setNewOutbound(String(routeOptions[0]?.value || "").trim());
  }

  function handleOpenAddEntry() {
    setAddingEntry(true);
    setNewInbound("");
    setNewOutbound(String(routeOptions[0]?.value || "").trim());
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 p-4 pb-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <CardTitle className="flex items-center gap-2">
              <span>Use AMP via LLM Router</span>
            </CardTitle>
            <ConnectionStatusChipRow
              primaryLabel="Config file"
              primaryValue={ampClientGlobal?.settingsFilePath || ""}
              onOpenPrimary={onOpenConfigPath}
              secondaryLabel="Secrets file"
              secondaryValue={ampClientGlobal?.secretsFilePath || ""}
              secondaryIcon={<SecretFileIcon className="h-3 w-3" />}
              onOpenSecondary={onOpenSecretsPath}
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={globalRoutingEnabled ? "outline" : undefined}
              onClick={onToggleGlobalRouting}
              disabled={routingBusy !== "" || (!globalRoutingEnabled && !canEnableGlobalRouting)}
            >
              {routingBusy === "enable"
                ? "Connecting…"
                : routingBusy === "disable"
                  ? "Disconnecting…"
                  : globalRoutingEnabled
                    ? "Disconnect"
                    : "Connect"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-4">
          {globalRoutingError ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{globalRoutingError}</div>
          ) : null}
        {!globalRoutingEnabled && !hasMasterKey ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Set <code>masterKey</code> first to connect AMP.
          </div>
        ) : null}

        {showWebSearchWarning ? (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="max-w-3xl">
              AMP is connected, but no alternative web search provider is configured. AMP web search is only available through the shared Web Search tab.
            </div>
            <Button type="button" size="sm" variant="outline" onClick={onOpenWebSearchTab}>
              Open Web Search
            </Button>
          </div>
        ) : null}

        {disabledReason ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{disabledReason}</div>
        ) : (
            <div className="space-y-3 rounded-2xl border border-border/70 bg-background/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-foreground">Route mapping editor</div>
                  <div className="mt-1 text-xs text-muted-foreground">Map built-in AMP route keys and wildcard model matches to managed routes.</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={statusVariant}>{statusLabel}</Badge>
                  <Badge variant="outline">{rows.length} routes</Badge>
                  <Button type="button" size="sm" onClick={handleOpenAddEntry}>Add custom mapping</Button>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">{statusMessage}</div>

              {addingEntry ? (
                <div className="rounded-2xl border border-dashed border-border bg-background/80 p-3">
                  <div className="grid gap-3 xl:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-medium text-foreground">Add custom mapping</div>
                        <Badge variant="info">Custom</Badge>
                      </div>
                      <div className="text-xs leading-5 text-muted-foreground">Match a built-in AMP route key like <code>smart</code> or a wildcard such as <code>gpt-*-codex*</code>, then send it to any managed route.</div>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" size="sm" onClick={handleSubmitNewEntry} disabled={!canCreateEntry}>Create mapping</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setAddingEntry(false)}>Close</Button>
                      </div>
                    </div>

                    <Field label="Inbound match" hint="Built-in route key or AMP model pattern">
                      <Input
                        value={newInbound}
                        onChange={(event) => setNewInbound(event.target.value)}
                        placeholder="smart or gpt-*-codex*"
                      />
                    </Field>

                    <Field label="Route target" hint="Alias or provider/model route in LLM Router">
                      <Select value={newOutbound || undefined} onValueChange={setNewOutbound}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select local route" />
                        </SelectTrigger>
                        <SelectContent>
                          {renderSelectOptionNodes(routeOptions, {
                            keyPrefix: "amp-route-create",
                            includeHint: true
                          })}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                {rows.map((row) => (
                  <div key={row.id} className="rounded-2xl border border-border/70 bg-background/75 p-3">
                    <div className="grid gap-3 xl:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-medium text-foreground">{row.label}</div>
                          {row.isCustom ? <Badge variant="info">Custom</Badge> : null}
                        </div>
                        <div className="text-xs leading-5 text-muted-foreground">{row.description}</div>
                        {row.removable ? <Button type="button" size="sm" variant="ghost" onClick={() => onRemoveEntry(row.id)}>Remove</Button> : null}
                      </div>

                      <Field label="Inbound wildcard" hint={row.defaultMatch ? `Default: ${row.defaultMatch}` : "AMP model pattern"}>
                        <BufferedTextInput
                          commitOnBlur
                          value={row.inbound}
                          onValueCommit={(value) => onInboundChange(row.id, value)}
                          placeholder={row.defaultMatch || "gpt-*-codex*"}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            event.currentTarget.blur();
                          }}
                        />
                      </Field>

                      <Field label="Target route" hint="Alias or provider/model route">
                        <Select value={row.outbound || "__default__"} onValueChange={(value) => onOutboundChange(row.id, value)}>
                          <SelectTrigger>
                            <SelectValue placeholder={row.removable ? "Choose target route" : "Use default route"} />
                          </SelectTrigger>
                          <SelectContent>
                            {!row.removable ? <SelectItem value="__default__">Use default route</SelectItem> : null}
                            {renderSelectOptionNodes(routeOptions, {
                              keyPrefix: `amp-route-${row.id}`,
                              includeHint: true
                            })}
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
