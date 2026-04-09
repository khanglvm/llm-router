import { useMemo, useState } from "react";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.jsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from "./ui/select.jsx";
import { cn } from "../lib/utils.js";
import { Field, Modal } from "./shared.jsx";
import { ConnectionStatusChipRow } from "./header-chips.jsx";
import {
  CODEX_CLI_INHERIT_MODEL_VALUE,
  normalizeClaudeCodeEffortLevel,
  normalizeFactoryDroidReasoningEffort,
  isCodexCliInheritModelBinding
} from "../../../shared/coding-tool-bindings.js";

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

function withCurrentManagedRouteOptions(options = [], values = []) {
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

function BackupFileIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 3.5h5.25L15 7.25V16A1.5 1.5 0 0 1 13.5 17.5h-7A1.5 1.5 0 0 1 5 16V5A1.5 1.5 0 0 1 6.5 3.5H6Z" />
      <path d="M11 3.5V7.5H15" />
      <path d="M7 12.25a3 3 0 1 1 2.85 2.99" />
      <path d="M8.5 10.25h1.5v1.5" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function buildCodexCliGuideContent({
  bindingValue = "",
  thinkingLevel = "",
  configFilePath = "",
  endpointUrl = ""
} = {}) {
  const normalizedBindingValue = String(bindingValue || "").trim();
  const normalizedThinkingLevel = String(thinkingLevel || "").trim();
  const normalizedConfigFilePath = String(configFilePath || "").trim();
  const normalizedEndpointUrl = String(endpointUrl || "").trim();
  const inheritMode = isCodexCliInheritModelBinding(normalizedBindingValue);

  const modeBadgeLabel = inheritMode
    ? "Mode: Inherit Codex model"
    : normalizedBindingValue
      ? `Mode: Pinned to ${normalizedBindingValue}`
      : "Mode: Choose a route";
  const callout = inheritMode
    ? {
        variant: "success",
        title: "Inherit mode keeps Codex-native model picks intact.",
        body: (
          <>
            Codex CLI still chooses its own model name. Create a same-name alias in the <span className="font-medium">Alias &amp; Fallback</span> tab so LLM Router can resolve that name to the real upstream target you want.
          </>
        )
      }
    : normalizedBindingValue
      ? {
          variant: "info",
          title: "Pinned mode forces one router target.",
          body: (
            <>
              LLM Router writes <code>model={normalizedBindingValue}</code> into Codex CLI config. That is the simplest setup when every Codex session should use one managed route or alias.
            </>
          )
        }
      : {
          variant: "warning",
          title: "Choose your model strategy before you connect.",
          body: (
            <>
              Pick <span className="font-medium">Inherit Codex CLI model</span> if Codex should keep using its built-in model names, or pick one managed route/alias if you want a single fixed target.
            </>
          )
        };

  return {
    title: "Codex CLI guide",
    description: "Quick setup for routing Codex CLI through LLM Router while keeping model routing easy to inspect and change later.",
    badges: [
      { label: modeBadgeLabel, variant: inheritMode ? "success" : normalizedBindingValue ? "info" : "outline" },
      { label: normalizedThinkingLevel ? `Thinking: ${normalizedThinkingLevel}` : "Thinking: Codex default", variant: "outline" },
      { label: normalizedConfigFilePath ? "Config file detected" : "User config: ~/.codex/config.toml", variant: "outline" }
    ],
    callout,
    highlights: [
      {
        eyebrow: "1. Connect",
        title: "Point Codex CLI at LLM Router",
        body: normalizedEndpointUrl
          ? (
              <>
                When connected, Codex sends requests to <code>{normalizedEndpointUrl}</code>. LLM Router then handles upstream auth, alias resolution, and failover.
              </>
            )
          : (
              <>
                Click <span className="font-medium">Connect</span> to patch Codex CLI so it talks to LLM Router instead of a provider directly.
              </>
            )
      },
      {
        eyebrow: "2. Route",
        title: "Choose between inherit and pinned mode",
        body: inheritMode
          ? (
              <>
                Keep Codex model names such as <code>gpt-5.4</code>, then create matching aliases in LLM Router, for example <code>gpt-5.4</code> -&gt; <code>demo/gpt-4o-mini</code>.
              </>
            )
          : (
              <>
                Select one managed route or alias in <span className="font-medium">Default model</span> when you want every Codex request to land on the same router target.
              </>
            )
      },
      {
        eyebrow: "3. Tune",
        title: "Optional reasoning control",
        body: (
          <>
            <span className="font-medium">Thinking level</span> writes Codex CLI <code>model_reasoning_effort</code> with the official values <code>minimal</code>, <code>low</code>, <code>medium</code>, <code>high</code>, or <code>xhigh</code>.
          </>
        )
      }
    ],
    sections: [
      {
        title: "Quick start",
        items: [
          <>Set a <code>masterKey</code> in LLM Router first. The <span className="font-medium">Connect</span> button stays disabled until gateway auth is ready.</>,
          <>Click <span className="font-medium">Connect</span> to patch the Codex CLI config file and router base URL.</>,
          inheritMode
            ? <>Leave <span className="font-medium">Default model</span> on <span className="font-medium">Inherit Codex CLI model</span>, then create aliases that match the Codex model names you actually use.</>
            : normalizedBindingValue
              ? <>Your current default is pinned to <code>{normalizedBindingValue}</code>. Change it only when you want Codex to use a different managed route or alias.</>
              : <>Choose either <span className="font-medium">Inherit Codex CLI model</span> or one managed route/alias in <span className="font-medium">Default model</span> before you start using Codex through the router.</>,
          <>Set <span className="font-medium">Thinking level</span> only when you want LLM Router to write <code>model_reasoning_effort</code>; leave it unset to keep Codex CLI defaults.</>
        ]
      },
      {
        title: "Choose the right model strategy",
        items: [
          <>Use <span className="font-medium">Inherit Codex CLI model</span> when you want Codex-native model names and model-specific UI/options to remain visible.</>,
          <>Use a fixed route or alias when your team wants one centrally managed target regardless of what Codex would otherwise choose.</>,
          <>If Codex-specific options disappear after pinning a route, switch back to inherit mode and route those same model names through aliases instead.</>
        ]
      },
      {
        title: "Where these settings land",
        items: [
          normalizedConfigFilePath
            ? <>This page is currently managing <code>{normalizedConfigFilePath}</code>.</>
            : <>Codex CLI usually stores user settings in <code>~/.codex/config.toml</code>. Trusted projects can also add overrides in <code>.codex/config.toml</code>.</>,
          <>The router-managed bindings in this panel map to Codex CLI <code>model</code> and <code>model_reasoning_effort</code>.</>,
          <>Use <span className="font-medium">Open Codex CLI Config File</span> whenever you want to inspect the exact generated config.</>
        ]
      },
      {
        title: "Quick verify",
        items: [
          <>Open the config file from this page and confirm the values match the mode you intended.</>,
          <>Start Codex CLI and run a small prompt. If inherit mode is on, make sure the Codex model you selected has a same-name alias in LLM Router.</>,
          <>If requests fail after switching models, check the <span className="font-medium">Alias &amp; Fallback</span> tab first because the alias behind that model name may be missing or pointed at the wrong target.</>
        ]
      }
    ]
  };
}

export function buildClaudeCodeGuideContent({
  bindings = {},
  settingsFilePath = "",
  endpointUrl = ""
} = {}) {
  const primaryModel = String(bindings?.primaryModel || "").trim();
  const defaultOpusModel = String(bindings?.defaultOpusModel || "").trim();
  const defaultSonnetModel = String(bindings?.defaultSonnetModel || "").trim();
  const defaultHaikuModel = String(bindings?.defaultHaikuModel || "").trim();
  const subagentModel = String(bindings?.subagentModel || "").trim();
  const normalizedLevel = normalizeClaudeCodeEffortLevel(bindings?.thinkingLevel);
  const normalizedSettingsFilePath = String(settingsFilePath || "").trim();
  const normalizedEndpointUrl = String(endpointUrl || "").trim();
  const activeOverrideCount = [
    primaryModel,
    defaultOpusModel,
    defaultSonnetModel,
    defaultHaikuModel,
    subagentModel,
    normalizedLevel
  ].filter(Boolean).length;

  const callout = primaryModel
    ? {
        variant: "info",
        title: "Primary model override is active.",
        body: (
          <>
            LLM Router is currently writing <code>ANTHROPIC_MODEL={primaryModel}</code>. Leave that field blank if you want Claude Code to keep choosing its own primary model.
          </>
        )
      }
    : activeOverrideCount > 0
      ? {
          variant: "info",
          title: "Only filled fields are overridden.",
          body: (
            <>
              Claude Code continues to inherit its normal defaults for every blank field. This is useful when you only want to steer alias models, subagents, or effort level through LLM Router.
            </>
          )
        }
      : {
          variant: "success",
          title: "Blank fields are a valid setup.",
          body: (
            <>
              You do not need to fill every binding. Leave fields empty unless you want LLM Router to override that specific Claude Code setting.
            </>
          )
        };

  return {
    title: "Claude Code guide",
    description: "Quick setup for routing Claude Code through LLM Router while keeping only the model and effort level overrides you actually want.",
    badges: [
      { label: activeOverrideCount > 0 ? `${activeOverrideCount} override${activeOverrideCount === 1 ? "" : "s"} active` : "No router overrides", variant: activeOverrideCount > 0 ? "info" : "outline" },
      { label: normalizedLevel ? `Effort: ${normalizedLevel}` : "Effort: Claude adaptive default", variant: "outline" },
      { label: normalizedSettingsFilePath ? "Settings file detected" : "Settings scope: local/project/user", variant: "outline" }
    ],
    callout,
    highlights: [
      {
        eyebrow: "1. Connect",
        title: "Point Claude Code at the router",
        body: normalizedEndpointUrl
          ? (
              <>
                When connected, Claude Code sends requests to <code>{normalizedEndpointUrl}</code>. LLM Router then handles upstream auth, route selection, and failover.
              </>
            )
          : (
              <>
                Click <span className="font-medium">Connect</span> to patch Claude Code so it uses the router Anthropic endpoint instead of a provider directly.
              </>
            )
      },
      {
        eyebrow: "2. Override",
        title: "Set only the bindings you need",
        body: (
          <>
            Leave fields blank to inherit Claude Code defaults. Fill <code>ANTHROPIC_MODEL</code>, the Opus/Sonnet/Haiku defaults, or <code>CLAUDE_CODE_SUBAGENT_MODEL</code> only when you want LLM Router to manage those values.
          </>
        )
      },
      {
        eyebrow: "3. Effort",
        title: "Set thinking effort level",
        body: (
          <>
            The <span className="font-medium">Effort level</span> dropdown writes <code>CLAUDE_CODE_EFFORT_LEVEL</code> to your shell profile. If the shell profile cannot be updated, <code>effortLevel</code> is set in <code>settings.json</code> as a fallback (only &quot;high&quot; is supported there).
          </>
        )
      }
    ],
    sections: [
      {
        title: "Quick start",
        items: [
          <>Click <span className="font-medium">Connect</span> to patch Claude Code toward the router and keep provider credentials centralized inside LLM Router.</>,
          <>Leave <span className="font-medium">Current model override</span> empty unless you explicitly want to replace Claude Code&apos;s own main model selection.</>,
          <>Use <span className="font-medium">Default Opus</span>, <span className="font-medium">Default Sonnet</span>, and <span className="font-medium">Default Haiku</span> when you want Claude Code&apos;s built-in alias names to resolve to managed routes or aliases.</>,
          <>Use <span className="font-medium">Sub-agent model</span> when background workers or helper agents should run on a different route than the main session.</>,
          <>Use <span className="font-medium">Effort level</span> to set <code>CLAUDE_CODE_EFFORT_LEVEL</code> in your shell profile; leave it unset to keep Claude Code&apos;s adaptive default. The <code>effortLevel</code> key in <code>settings.json</code> (only &quot;high&quot;) acts as a fallback when the shell profile cannot be updated.</>
        ]
      },
      {
        title: "What each binding controls",
        items: [
          <><code>ANTHROPIC_MODEL</code>: overrides the main model for the active Claude Code session.</>,
          <><code>ANTHROPIC_DEFAULT_OPUS_MODEL</code>, <code>ANTHROPIC_DEFAULT_SONNET_MODEL</code>, and <code>ANTHROPIC_DEFAULT_HAIKU_MODEL</code>: remap Claude Code&apos;s built-in alias names to managed routes or aliases.</>,
          <><code>CLAUDE_CODE_SUBAGENT_MODEL</code>: routes subagents and background workers to a specific managed model.</>,
          normalizedLevel
            ? <><code>CLAUDE_CODE_EFFORT_LEVEL</code>: currently set to <span className="font-medium">{normalizedLevel}</span> in your shell profile.</>
            : <><code>CLAUDE_CODE_EFFORT_LEVEL</code>: stays unset unless you choose an effort level.</>
        ]
      },
      {
        title: "Settings scope and precedence",
        items: [
          <>Claude Code settings apply in this order: <code>managed-settings.json</code>, CLI arguments, <code>.claude/settings.local.json</code>, <code>.claude/settings.json</code>, then <code>~/.claude/settings.json</code>.</>,
          normalizedSettingsFilePath
            ? <>This page is currently managing <code>{normalizedSettingsFilePath}</code>.</>
            : <>Claude Code can read from project-local, project-shared, or user settings files depending on what exists in your environment.</>,
          <>If a value seems ignored, check whether a higher-precedence file or command-line flag is overriding it.</>
        ]
      },
      {
        title: "Quick verify",
        items: [
          <>Open the settings file from this page and confirm the <code>env</code> block contains only the overrides you meant to set.</>,
          <>Launch Claude Code and test both the main session and any subagents if you changed <code>CLAUDE_CODE_SUBAGENT_MODEL</code>.</>,
          <>If thinking behavior is not what you expected, remember this UI writes <code>CLAUDE_CODE_EFFORT_LEVEL</code> to your shell profile; clearing the field returns control to Claude Code&apos;s own default behavior.</>
        ]
      }
    ]
  };
}

export function buildFactoryDroidGuideContent({
  bindings = {},
  settingsFilePath = "",
  endpointUrl = ""
} = {}) {
  const defaultModel = String(bindings?.defaultModel || "").trim();
  const reasoningEffort = normalizeFactoryDroidReasoningEffort(bindings?.reasoningEffort);
  const normalizedSettingsFilePath = String(settingsFilePath || "").trim();
  const normalizedEndpointUrl = String(endpointUrl || "").trim();

  const callout = defaultModel
    ? {
        variant: "info",
        title: "Default model is set.",
        body: (
          <>
            LLM Router is writing <code>model={defaultModel}</code> and injecting a <code>customModels</code> entry into your Factory Droid settings. All requests route through the gateway.
          </>
        )
      }
    : {
        variant: "success",
        title: "Factory Droid connected via custom model entry.",
        body: (
          <>
            LLM Router injects a managed <code>customModels</code> entry pointing at the gateway. Select a default model below or use Factory Droid&apos;s <code>/model</code> command to pick the routed model at runtime.
          </>
        )
      };

  return {
    title: "Factory Droid guide",
    description: "Quick setup for routing Factory Droid through LLM Router via a managed custom model entry.",
    badges: [
      { label: defaultModel ? `Model: ${defaultModel}` : "No model override", variant: defaultModel ? "info" : "outline" },
      { label: reasoningEffort ? `Reasoning: ${reasoningEffort}` : "Reasoning: Droid default", variant: "outline" },
      { label: normalizedSettingsFilePath ? "Settings file detected" : "User config: ~/.factory/settings.json", variant: "outline" }
    ],
    callout,
    highlights: [
      {
        eyebrow: "1. Connect",
        title: "Point Factory Droid at LLM Router",
        body: normalizedEndpointUrl
          ? (
              <>
                When connected, Factory Droid sends requests to <code>{normalizedEndpointUrl}</code>. LLM Router handles upstream auth, alias resolution, and failover.
              </>
            )
          : (
              <>
                Click <span className="font-medium">Connect</span> to inject a managed custom model entry into Factory Droid settings.
              </>
            )
      },
      {
        eyebrow: "2. Route",
        title: "Set the default model",
        body: (
          <>
            Pick a managed route or alias in <span className="font-medium">Default model</span> to control which upstream model Factory Droid uses.
          </>
        )
      },
      {
        eyebrow: "3. Tune",
        title: "Optional reasoning control",
        body: (
          <>
            <span className="font-medium">Reasoning effort</span> writes Factory Droid <code>reasoningEffort</code>. Values: <code>off</code>, <code>none</code>, <code>low</code>, <code>medium</code>, or <code>high</code>.
          </>
        )
      }
    ],
    sections: [
      {
        title: "Quick start",
        items: [
          <>Set a <code>masterKey</code> in LLM Router first. The <span className="font-medium">Connect</span> button stays disabled until gateway auth is ready.</>,
          <>Click <span className="font-medium">Connect</span> to inject a managed <code>customModels</code> entry into <code>~/.factory/settings.json</code>.</>,
          defaultModel
            ? <>Your default model is set to <code>{defaultModel}</code>. Change it any time from this panel.</>
            : <>Choose a managed route or alias in <span className="font-medium">Default model</span> to route all Factory Droid requests.</>,
          <>Set <span className="font-medium">Reasoning effort</span> only when you want LLM Router to write <code>reasoningEffort</code>; leave it unset to keep Factory Droid defaults.</>
        ]
      },
      {
        title: "How it works",
        items: [
          <>LLM Router adds a <code>customModels</code> entry with <code>provider: &quot;openai&quot;</code> and the gateway base URL. Factory Droid treats it as a standard OpenAI-compatible endpoint.</>,
          <>The injected entry has a <code>_llmRouterManaged</code> marker so it can be cleanly updated or removed without touching your other custom models.</>,
          <>Disconnecting removes only the managed entry and restores any backed-up model or reasoning settings.</>
        ]
      },
      {
        title: "Where these settings land",
        items: [
          normalizedSettingsFilePath
            ? <>This page is managing <code>{normalizedSettingsFilePath}</code>.</>
            : <>Factory Droid stores user settings in <code>~/.factory/settings.json</code>.</>,
          <>The router-managed bindings map to Factory Droid <code>model</code> and <code>reasoningEffort</code> fields.</>,
          <>Use <span className="font-medium">Open Config File</span> to inspect the generated settings.</>
        ]
      },
      {
        title: "Quick verify",
        items: [
          <>Open the settings file from this page and confirm the <code>customModels</code> array contains the LLM Router entry.</>,
          <>Launch Factory Droid and run a small prompt. Use <code>/model</code> to confirm the routed model is available.</>,
          <>If requests fail, check the <span className="font-medium">Alias &amp; Fallback</span> tab first to ensure the alias behind your model exists.</>
        ]
      }
    ]
  };
}

export function getGuideCalloutClasses(variant = "outline") {
  switch (variant) {
    case "success":
      return "border-emerald-200 bg-emerald-50";
    case "warning":
      return "border-amber-200 bg-amber-50";
    case "danger":
      return "border-rose-200 bg-rose-50";
    case "info":
      return "border-sky-200 bg-sky-50";
    default:
      return "border-border/70 bg-background/70";
  }
}

export function getGuideCalloutTextClasses(variant = "outline") {
  switch (variant) {
    case "success":
      return "text-emerald-950";
    case "warning":
      return "text-amber-950";
    case "danger":
      return "text-rose-950";
    case "info":
      return "text-sky-950";
    default:
      return "text-foreground";
  }
}

export function PanelGuideButton({ guideContent }) {
  const [open, setOpen] = useState(false);
  const title = String(guideContent?.title || "").trim() || "Guide";
  const description = String(guideContent?.description || "").trim();
  const badges = Array.isArray(guideContent?.badges)
    ? guideContent.badges.filter(Boolean)
    : [];
  const highlights = Array.isArray(guideContent?.highlights)
    ? guideContent.highlights.filter(Boolean)
    : [];
  const sections = Array.isArray(guideContent?.sections)
    ? guideContent.sections.filter(Boolean)
    : [];
  const callout = guideContent?.callout && guideContent.callout.body
    ? guideContent.callout
    : null;
  const calloutVariant = callout?.variant || "outline";

  if (highlights.length === 0 && sections.length === 0 && !callout) return null;

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={title}
        onClick={() => setOpen(true)}
      >
        Guide
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={description}
        contentClassName="max-h-[92vh] max-w-4xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
        bodyClassName="max-h-[calc(92vh-5.5rem)]"
      >
        <div className="space-y-4">
          {badges.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {badges.map((badge, index) => (
                <Badge
                  key={`${title}-badge-${index}`}
                  variant={badge?.variant || "outline"}
                >
                  {badge?.label}
                </Badge>
              ))}
            </div>
          ) : null}

          {callout ? (
            <div className={cn("rounded-2xl border p-4", getGuideCalloutClasses(calloutVariant))}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={["success", "warning", "danger", "info"].includes(calloutVariant) ? calloutVariant : "outline"}>
                  {calloutVariant === "success"
                    ? "Current best fit"
                    : calloutVariant === "warning"
                      ? "Needs attention"
                      : calloutVariant === "info"
                        ? "Current behavior"
                        : "Guide note"}
                </Badge>
                <div className={cn("text-sm font-medium", getGuideCalloutTextClasses(calloutVariant))}>
                  {callout.title}
                </div>
              </div>
              <div className={cn("mt-3 text-sm leading-6", getGuideCalloutTextClasses(calloutVariant))}>
                {callout.body}
              </div>
            </div>
          ) : null}

          {highlights.length > 0 ? (
            <div className={cn("grid gap-4", highlights.length > 2 ? "md:grid-cols-3" : "md:grid-cols-2")}>
              {highlights.map((entry, index) => (
                <div key={`${title}-highlight-${index}`} className="rounded-2xl border border-border/70 bg-background/70 p-4">
                  {entry?.eyebrow ? (
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{entry.eyebrow}</div>
                  ) : null}
                  <div className="mt-2 text-sm font-medium text-foreground">{entry?.title}</div>
                  <div className="mt-2 text-sm leading-6 text-muted-foreground">{entry?.body}</div>
                </div>
              ))}
            </div>
          ) : null}

          {sections.map((section, sectionIndex) => {
            const items = Array.isArray(section?.items) ? section.items.filter(Boolean) : [];
            return (
              <div key={`${title}-section-${sectionIndex}`} className="rounded-2xl border border-border/70 bg-background/70 p-4">
                <div className="text-sm font-medium text-foreground">{section?.title}</div>
                {section?.description ? (
                  <div className="mt-2 text-sm leading-6 text-muted-foreground">{section.description}</div>
                ) : null}
                {items.length > 0 ? (
                  <div className="mt-3 space-y-3">
                    {items.map((item, itemIndex) => (
                      <div key={`${title}-section-${sectionIndex}-item-${itemIndex}`} className="flex gap-3 text-sm leading-6 text-foreground">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/50" />
                        <div className="min-w-0">{item}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Modal>
    </>
  );
}

export function BindingValueSelect({ field, routeOptions, disabled = false, onValueChange }) {
  const selectValue = String(field?.value || "").trim() || (field?.allowUnset ? "__unset__" : "");
  const selectOptions = useMemo(() => {
    const routeDrivenOptions = field?.usesRouteOptions === false ? [] : routeOptions;
    const explicitOptions = Array.isArray(field?.options) ? field.options : [];
    const extraOptions = Array.isArray(field?.extraOptions) ? field.extraOptions : [];
    return field?.allowUnset
      ? [{ value: "__unset__", label: "Inherit tool default", hint: "" }, ...extraOptions, ...explicitOptions, ...routeDrivenOptions]
      : [...extraOptions, ...explicitOptions, ...routeDrivenOptions];
  }, [field?.allowUnset, field?.extraOptions, field?.options, field?.usesRouteOptions, routeOptions]);

  return (
    <Select value={selectValue} onValueChange={onValueChange} disabled={disabled || selectOptions.length === 0}>
      <SelectTrigger>
        <SelectValue placeholder={field.placeholder || "Select a route"} />
      </SelectTrigger>
      <SelectContent>
        {selectOptions.length > 0 ? renderSelectOptionNodes(selectOptions, {
          keyPrefix: field.id || "binding-option"
        }) : (
          <SelectItem value="__no-route-options" disabled>No routes available</SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

export function CodingToolSettingsPanel({
  toolName,
  toolState,
  endpointUrl,
  routeOptions,
  connectionBusy,
  bindingBusy,
  onToggleRouting,
  onBindingChange,
  hasMasterKey,
  disabledReason,
  onOpenPrimaryPath,
  onOpenSecondaryPath,
  secondaryPathLabel = "Backup file",
  secondaryPathIcon = <BackupFileIcon className="h-3 w-3" />,
  bindingFields = [],
  guideContent = null
}) {
  const routingEnabled = toolState?.routedViaRouter === true;
  const routingError = String(toolState?.error || "").trim();
  const canEnableRouting = Boolean(hasMasterKey && endpointUrl && !disabledReason && !routingError);
  const currentManagedBindingValues = useMemo(() => {
    const reservedValues = new Set(["__unset__"]);
    for (const field of bindingFields) {
      for (const option of (Array.isArray(field?.extraOptions) ? field.extraOptions : [])) {
        const value = String(option?.value || "").trim();
        if (value) reservedValues.add(value);
      }
      for (const option of (Array.isArray(field?.options) ? field.options : [])) {
        const value = String(option?.value || "").trim();
        if (value) reservedValues.add(value);
      }
    }

    return bindingFields
      .filter((field) => field?.usesRouteOptions !== false)
      .map((field) => String(field?.value || "").trim())
      .filter((value) => value && !reservedValues.has(value));
  }, [bindingFields]);
  const resolvedRouteOptions = withCurrentManagedRouteOptions(
    routeOptions,
    currentManagedBindingValues
  );

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 p-4 pb-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <CardTitle className="flex items-center gap-2">
            <span>{`Use ${toolName} via LLM Router`}</span>
          </CardTitle>
          <ConnectionStatusChipRow
            primaryLabel="Config file"
            primaryValue={toolState?.configFilePath || toolState?.settingsFilePath || ""}
            onOpenPrimary={onOpenPrimaryPath}
            secondaryLabel={secondaryPathLabel}
            secondaryValue={toolState?.backupFilePath || ""}
            secondaryIcon={secondaryPathIcon}
            onOpenSecondary={onOpenSecondaryPath}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {guideContent ? <PanelGuideButton guideContent={guideContent} /> : null}
          <Button
            type="button"
            size="sm"
            variant={routingEnabled ? "outline" : undefined}
            onClick={onToggleRouting}
            disabled={connectionBusy !== "" || (!routingEnabled && !canEnableRouting)}
          >
            {connectionBusy === "enable"
              ? "Connecting…"
              : connectionBusy === "disable"
                ? "Disconnecting…"
                : routingEnabled
                  ? "Disconnect"
                  : "Connect"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {routingError ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{routingError}</div>
        ) : null}
        {!routingEnabled && !hasMasterKey ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Set <code>masterKey</code> first to connect {toolName}.
          </div>
        ) : null}
        {disabledReason ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{disabledReason}</div>
        ) : null}

        <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
          <div>
            <div>
              <div className="text-sm font-medium text-foreground">Model bindings</div>
              <div className="mt-1 text-xs text-muted-foreground">Prefer LLM Router aliases here so you can retarget models later from the Alias &amp; Fallback tab.</div>
            </div>
          </div>

          {bindingFields.length === 0 ? (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              No tool bindings are available yet.
            </div>
          ) : (
            <div className="mt-4 grid gap-3">
              {bindingFields.map((field) => {
                return (
                  <div key={field.id} className="rounded-xl border border-border/70 bg-background/80 p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm font-medium text-foreground">{field.label}</div>
                      <Badge variant="outline">{field.envKey}</Badge>
                    </div>
                    <div className="mb-3 text-xs leading-5 text-muted-foreground">{field.description}</div>
                    <BindingValueSelect
                      field={field}
                      routeOptions={resolvedRouteOptions}
                      disabled={field.standaloneWhenDisconnected ? bindingBusy : (!routingEnabled || bindingBusy)}
                      onValueChange={(value) => onBindingChange(field.id, value === "__unset__" ? "" : value)}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
