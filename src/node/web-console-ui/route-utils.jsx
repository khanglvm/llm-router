import { Fragment } from "react";
import { SelectGroup, SelectItem, SelectLabel } from "./components/ui/select.jsx";
import { formatContextWindow } from "./context-window-utils.js";

export function buildManagedRouteOptions(config = {}) {
  const options = [];
  const aliases = config?.modelAliases && typeof config.modelAliases === "object" && !Array.isArray(config.modelAliases)
    ? config.modelAliases
    : {};

  for (const aliasId of Object.keys(aliases)) {
    options.push({
      value: aliasId,
      label: aliasId,
      hint: `Alias · ${(aliases[aliasId]?.targets || []).length || 0} target(s)`,
      kind: "alias",
      groupKey: "aliases",
      groupLabel: "Aliases"
    });
  }

  for (const provider of (Array.isArray(config?.providers) ? config.providers : [])) {
    const providerId = String(provider?.id || "").trim();
    const providerLabel = String(provider?.name || providerId || "provider").trim() || "provider";
    for (const model of (Array.isArray(provider?.models) ? provider.models : [])) {
      const modelId = String(model?.id || "").trim();
      if (!providerId || !modelId) continue;
      const contextWindow = Number.isFinite(model?.contextWindow) ? Number(model.contextWindow) : null;
      options.push({
        value: `${providerId}/${modelId}`,
        label: `${providerId}/${modelId}`,
        hint: contextWindow ? `${providerLabel} · ${formatContextWindow(contextWindow)}` : providerLabel,
        kind: "model",
        providerId,
        groupKey: `provider:${providerId}`,
        groupLabel: providerLabel
      });
    }
  }

  const seen = new Set();
  return options.filter((option) => {
    if (!option?.value || seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

export function inferManagedRouteOptionMetadata(value = "") {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return {};

  const normalizedAliasValue = normalizedValue.startsWith("alias:")
    ? normalizedValue.slice("alias:".length).trim()
    : normalizedValue;
  if (!normalizedAliasValue.includes("/")) {
    return {
      kind: "alias",
      groupKey: "aliases",
      groupLabel: "Aliases"
    };
  }

  const separatorIndex = normalizedAliasValue.indexOf("/");
  const providerId = normalizedAliasValue.slice(0, separatorIndex).trim();
  if (!providerId) return {};
  return {
    kind: "model",
    providerId,
    groupKey: `provider:${providerId}`,
    groupLabel: providerId
  };
}

export function withCurrentManagedRouteOptions(options = [], values = []) {
  const nextOptions = [...(Array.isArray(options) ? options : [])];
  const seen = new Set(nextOptions.map((option) => String(option?.value || "").trim()).filter(Boolean));

  for (const value of (Array.isArray(values) ? values : []).map((entry) => String(entry || "").trim()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    nextOptions.push({
      value,
      label: value,
      hint: "Current config",
      ...inferManagedRouteOptionMetadata(value)
    });
  }

  return nextOptions;
}

export function buildGroupedSelectOptions(options = []) {
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
      group = {
        key: groupKey,
        label: groupLabel || groupKey,
        options: []
      };
      groupsByKey.set(groupKey, group);
      groups.push(group);
    }
    group.options.push(option);
  }

  return groups;
}

export function formatRouteOptionSelectLabel(option = {}, { includeHint = false } = {}) {
  const label = String(option?.label || option?.value || "").trim() || String(option?.value || "").trim();
  const hint = String(option?.hint || "").trim();
  return includeHint && hint ? `${label} · ${hint}` : label;
}

export function renderSelectOptionNodes(options = [], {
  keyPrefix = "select-option",
  includeHint = false
} = {}) {
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
