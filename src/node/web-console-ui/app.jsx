import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "./components/ui/badge.jsx";
import { Button } from "./components/ui/button.jsx";
import { Card, CardContent } from "./components/ui/card.jsx";
import { Switch } from "./components/ui/switch.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.jsx";
import { cn } from "./lib/utils.js";
import {
  applyModelAliasEdits,
  applyProviderInlineEdits,
  applyProviderModelEdits,
  removeModelAlias
} from "./config-editor-utils.js";
import { validateRateLimitDraftRows } from "./rate-limit-utils.js";
import { CODEX_SUBSCRIPTION_MODELS, CLAUDE_CODE_SUBSCRIPTION_MODELS } from "../../runtime/subscription-constants.js";
import { DEFAULT_MODEL_ALIAS_ID } from "../../runtime/config.js";
import { LOCAL_ROUTER_ORIGIN, LOCAL_ROUTER_PORT } from "../../shared/local-router-defaults.js";
import {
  CODEX_CLI_INHERIT_MODEL_VALUE,
  normalizeClaudeCodeEffortLevel,
  normalizeFactoryDroidReasoningEffort,
  isCodexCliInheritModelBinding
} from "../../shared/coding-tool-bindings.js";

import {
  JSON_HEADERS,
  GITHUB_REPO_URL,
  GITHUB_SPONSORS_URL,
  QUICK_START_FALLBACK_USER_AGENT,
  LIVE_UPDATES_RETRY_MS,
  QUICK_START_PROVIDER_ID_PATTERN,
  CONTEXT_LOOKUP_SUGGESTION_LIMIT,
  CODEX_THINKING_LEVEL_OPTIONS,
  CLAUDE_THINKING_LEVEL_OPTIONS,
  FACTORY_DROID_REASONING_EFFORT_OPTIONS
} from "./constants.js";

import {
  FolderIcon,
  GitHubIcon,
  HeartIcon,
  PlayIcon,
  PauseIcon,
  PowerIcon,
  CopyIcon
} from "./icons.jsx";

import { initPresetModels } from "./provider-presets.js";

import {
  tryParseConfigObject,
  parseDraftConfigText,
  detectValidationVariant,
  safeClone,
  normalizeUniqueTrimmedValues,
  mergeChipValuesAndDraft,
  isLikelyHttpEndpoint,
  hasDuplicateTrimmedValues,
  collectProviderModelIds,
  resolveRateLimitDraftRows,
  createMasterKey,
  looksLikeEnvVarName
} from "./utils.js";

import {
  ensureAmpDraftConfigShape,
  buildAmpEntityRows,
  updateAmpEditableRouteConfig,
  createAmpEditableRoute,
  removeAmpEditableRoute,
  maskShortSecret
} from "./amp-utils.js";

import {
  ensureWebSearchConfigShape,
  buildWebSearchProviderRows,
  buildClaudeCodeWebSearchProviderOptions,
  buildHostedWebSearchCandidateGroups,
  buildHostedWebSearchProviderId,
  normalizeWebSearchProviderKey,
  updateWebSearchConfig,
  updateWebSearchProviderConfig,
  addHostedWebSearchProviderConfig,
  removeWebSearchProviderConfig,
  moveWebSearchProviderConfig,
  shouldImmediateAutosaveWebSearchProviderChange
} from "./web-search-utils.js";

import { normalizeContextWindowInput } from "./context-window-utils.js";

import {
  attachLocalModel,
  fetchJson,
  fetchJsonLineStream,
  locateLocalModel,
  probeFreeTierModels,
  reconcileLocalModels,
  removeLocalModel,
  lookupLiteLlmContextWindow,
  downloadManagedGguf,
  saveLocalModelVariant
} from "./api-client.js";

import {
  collectQuickStartEndpoints,
  getDraftProviderCredentialPayload,
  inferQuickStartConnectionType,
  pickFallbackDefaultModel,
  removeProviderFromConfig,
  hasCompletedProviderSetup,
  pickFreeTierProbeModels
} from "./quick-start-utils.js";

import { buildManagedRouteOptions, withCurrentManagedRouteOptions } from "./route-utils.jsx";

import { Modal } from "./components/shared.jsx";
import { ConnectedIndicatorDot, HeaderAccessGroup } from "./components/header-chips.jsx";
import { ToastStack } from "./components/toast.jsx";
import { ModelAliasSection } from "./components/model-alias-section.jsx";
import { ProviderModelsSection } from "./components/provider-card.jsx";
import { OllamaSettingsPanel } from "./components/ollama-settings.jsx";
import { LocalModelsPanel } from "./components/local-models-panel.jsx";
import { AmpSettingsPanel } from "./components/amp-settings.jsx";
import { WebSearchSettingsPanel } from "./components/web-search-settings.jsx";
import { buildCodexCliGuideContent, buildClaudeCodeGuideContent, buildFactoryDroidGuideContent, CodingToolSettingsPanel } from "./components/coding-tool-settings.jsx";
import { LogList } from "./components/log-list.jsx";
import { QuickStartWizard } from "./components/quick-start-wizard.jsx";
import { buildLocalModelsSummary } from "./local-models-utils.js";

async function copyTextToClipboard(value) {
  const text = String(value || "");
  if (!text) return;

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is not available in this environment.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function formatHostForOrigin(host = "127.0.0.1") {
  const normalizedHost = String(host || "127.0.0.1").trim() || "127.0.0.1";
  return normalizedHost.includes(":") && !normalizedHost.startsWith("[")
    ? `[${normalizedHost}]`
    : normalizedHost;
}

function buildLocalRouterOrigin(settings = {}) {
  const host = formatHostForOrigin(settings?.host || "127.0.0.1");
  const port = Number.isInteger(Number(settings?.port)) ? Number(settings.port) : LOCAL_ROUTER_PORT;
  return `http://${host}:${port}`;
}

function DevModeBanner({
  currentConfigPath = "",
  productionConfigPath = "",
  routerPort = LOCAL_ROUTER_PORT,
  canSyncProductionConfig = false,
  syncBusy = false,
  onSyncProductionConfig
}) {
  return (
    <div className="overflow-hidden rounded-[1.75rem] border border-amber-300/80 bg-[linear-gradient(135deg,rgba(255,247,237,0.98),rgba(255,251,235,0.97),rgba(254,243,199,0.82))] shadow-[0_20px_60px_rgba(180,83,9,0.12)]">
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="warning" className="border-amber-300 bg-amber-100 text-amber-950">Dev Mode</Badge>
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-900/80">Isolated router sandbox</span>
          </div>
          <div className="space-y-1">
            <div className="text-base font-semibold text-amber-950 sm:text-lg">
              Dev console runs on router port {routerPort} and leaves the production startup service alone.
            </div>
            <div className="max-w-3xl text-sm leading-6 text-amber-950/75">
              Use the sync action to clone the current production config into this dev workspace without changing the dev router binding.
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-amber-300/70 bg-white/75 px-3 py-1.5 font-medium text-amber-950/80">
              Dev config: <span className="font-semibold">{currentConfigPath || "Not resolved"}</span>
            </span>
            <span className="rounded-full border border-amber-300/60 bg-amber-50/70 px-3 py-1.5 font-medium text-amber-950/75">
              Production source: <span className="font-semibold">{productionConfigPath || "Not resolved"}</span>
            </span>
          </div>
        </div>
        {canSyncProductionConfig ? (
          <div className="flex shrink-0 items-center">
            <Button
              size="sm"
              variant="outline"
              className="border-amber-300 bg-white/85 text-amber-950 hover:bg-amber-100 hover:text-amber-950"
              onClick={onSyncProductionConfig}
              disabled={syncBusy}
              aria-label={syncBusy ? "Syncing production config" : "Sync production config into this dev workspace"}
              title={syncBusy ? "Syncing production config" : "Sync production config into this dev workspace"}
            >
              <CopyIcon className="h-3.5 w-3.5" />
              <span>{syncBusy ? "Syncing production config…" : "Sync production config"}</span>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [draftText, setDraftText] = useState("");
  const [baselineText, setBaselineText] = useState("");
  const [validation, setValidation] = useState(null);
  const [notices, setNotices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [openEditorBusy, setOpenEditorBusy] = useState(false);
  const [routerBusy, setRouterBusy] = useState("");
  const [startupBusy, setStartupBusy] = useState("");
  const [syncProductionBusy, setSyncProductionBusy] = useState(false);
  const [activeTab, setActiveTab] = useState("model-alias");
  const [remoteConfigUpdated, setRemoteConfigUpdated] = useState(false);
  const [providerWizardOpen, setProviderWizardOpen] = useState(false);
  const [providerWizardKey, setProviderWizardKey] = useState(0);
  const [ampRoutingBusy, setAmpRoutingBusy] = useState("");
  const [codexRoutingBusy, setCodexRoutingBusy] = useState("");
  const [claudeRoutingBusy, setClaudeRoutingBusy] = useState("");
  const [factoryDroidRoutingBusy, setFactoryDroidRoutingBusy] = useState("");
  const [codexBindingsBusy, setCodexBindingsBusy] = useState(false);
  const [claudeBindingsBusy, setClaudeBindingsBusy] = useState(false);
  const [factoryDroidBindingsBusy, setFactoryDroidBindingsBusy] = useState(false);
  const [activityLogBusy, setActivityLogBusy] = useState("");
  const [activityFilter, setActivityFilter] = useState("usage");
  const [ampAutosaveRequest, setAmpAutosaveRequest] = useState(null);
  const [ampAutosaveState, setAmpAutosaveState] = useState({
    status: "idle",
    message: "",
    savedAt: ""
  });

  const draftRef = useRef("");
  const baselineRef = useRef("");
  const eventSourceRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const ampAutosaveTimerRef = useRef(null);
  const ampAutosaveSequenceRef = useRef(0);
  const masterKeyBootstrapRef = useRef("");
  const noticeIdRef = useRef(0);

  useEffect(() => {
    draftRef.current = draftText;
  }, [draftText]);

  useEffect(() => {
    baselineRef.current = baselineText;
  }, [baselineText]);

  useEffect(() => () => {
    if (ampAutosaveTimerRef.current) {
      clearTimeout(ampAutosaveTimerRef.current);
      ampAutosaveTimerRef.current = null;
    }
  }, []);

  const isDirty = draftText !== baselineText;
  const configDocument = snapshot?.config?.document;
  const validationSummary = validation?.summary || snapshot?.config || {};
  const validationMessages = validation?.validationMessages || snapshot?.config?.validationMessages || [];
  const persistedConfig = useMemo(
    () => tryParseConfigObject(snapshot?.config?.rawText || "{}", snapshot?.config?.document || {}),
    [snapshot?.config?.rawText, snapshot?.config?.document]
  );
  const parsedDraftState = useMemo(() => parseDraftConfigText(draftText, persistedConfig), [draftText, persistedConfig]);
  const parsedDraftConfig = useMemo(() => tryParseConfigObject(draftText, persistedConfig), [draftText, persistedConfig]);
  const editableConfig = parsedDraftState.parseError ? persistedConfig : parsedDraftState.value;
  const providers = useMemo(() => Array.isArray(editableConfig?.providers) ? editableConfig.providers : [], [editableConfig]);
  const modelAliases = useMemo(
    () => editableConfig?.modelAliases && typeof editableConfig.modelAliases === "object" && !Array.isArray(editableConfig.modelAliases)
      ? editableConfig.modelAliases
      : {},
    [editableConfig]
  );
  const managedRouteOptions = useMemo(() => buildManagedRouteOptions(editableConfig), [editableConfig]);
  const providerEditorDisabledReason = parsedDraftState.parseError ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}` : "";
  const ampEditableConfig = editableConfig;
  const resolvedLocalServerSettings = snapshot?.config?.localServer || snapshot?.startup?.defaults || null;
  const ampClientUrl = useMemo(
    () => buildLocalRouterOrigin(resolvedLocalServerSettings || {}),
    [resolvedLocalServerSettings?.host, resolvedLocalServerSettings?.port]
  );
  const ampClientGlobal = snapshot?.ampClient?.global || {};
  const webSearchSnapshot = snapshot?.webSearch || snapshot?.ampWebSearch || null;
  const codexCliState = snapshot?.codingTools?.codexCli || {};
  const claudeCodeState = snapshot?.codingTools?.claudeCode || {};
  const factoryDroidState = snapshot?.codingTools?.factoryDroid || {};
  const ampTabConnected = ampClientGlobal?.routedViaRouter === true;
  const codexTabConnected = codexCliState?.routedViaRouter === true;
  const claudeTabConnected = claudeCodeState?.routedViaRouter === true;
  const factoryDroidTabConnected = factoryDroidState?.routedViaRouter === true;
  const ollamaSnapshot = snapshot?.ollama || null;
  const ollamaTabConnected = ollamaSnapshot?.connected === true;
  const [ollamaModels, setOllamaModels] = useState([]);
  const localModelsMetadata = editableConfig?.metadata?.localModels || {};
  const localModelsState = useMemo(() => ({
    runtime: {
      ...(localModelsMetadata?.runtime || {}),
      ollama: {
        ...(localModelsMetadata?.runtime?.ollama || {}),
        status: ollamaTabConnected ? "running" : "stopped"
      }
    },
    library: localModelsMetadata?.library || {},
    variants: localModelsMetadata?.variants || {}
  }), [localModelsMetadata, ollamaTabConnected]);
  const localModelsSummary = useMemo(
    () => buildLocalModelsSummary(localModelsState),
    [localModelsState]
  );
  const [ollamaBusy, setOllamaBusy] = useState({});
  const [ollamaRefreshing, setOllamaRefreshing] = useState(false);
  const activityLogState = snapshot?.activityLog || { enabled: true };
  const activityLogEnabled = activityLogState?.enabled !== false;
  const ampRouteOptions = useMemo(() => buildManagedRouteOptions(ampEditableConfig), [ampEditableConfig]);
  const ampRows = useMemo(() => buildAmpEntityRows(ampEditableConfig), [ampEditableConfig]);
  const webSearchConfig = useMemo(
    () => ensureWebSearchConfigShape(ensureAmpDraftConfigShape(ampEditableConfig)),
    [ampEditableConfig]
  );
  const webSearchProviders = useMemo(
    () => buildWebSearchProviderRows(ampEditableConfig, webSearchSnapshot),
    [ampEditableConfig, webSearchSnapshot]
  );
  const claudeWebSearchProviderOptions = useMemo(
    () => buildClaudeCodeWebSearchProviderOptions(
      webSearchProviders,
      claudeCodeState?.webSearchProvider || ""
    ),
    [webSearchProviders, claudeCodeState?.webSearchProvider]
  );
  const hostedSearchCandidates = useMemo(() => {
    const existingIds = new Set(
      (Array.isArray(webSearchConfig?.providers) ? webSearchConfig.providers : [])
        .map((provider) => normalizeWebSearchProviderKey(provider?.id))
        .filter(Boolean)
    );
    return buildHostedWebSearchCandidateGroups(ampEditableConfig, existingIds);
  }, [ampEditableConfig, webSearchConfig]);
  const ampDisabledReason = parsedDraftState.parseError
    ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`
    : (ampRouteOptions.length === 0 ? "Add at least one alias or provider/model route before configuring AMP." : "");
  const webSearchDisabledReason = parsedDraftState.parseError
    ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`
    : "";
  const codingToolDisabledReason = parsedDraftState.parseError
    ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`
    : (managedRouteOptions.length === 0 ? "Add at least one alias or provider/model route before configuring coding-tool bindings." : "");
  const codexRouteOptions = useMemo(
    () => withCurrentManagedRouteOptions(
      managedRouteOptions,
      isCodexCliInheritModelBinding(codexCliState?.bindings?.defaultModel) ? [] : [codexCliState?.bindings?.defaultModel]
    ),
    [managedRouteOptions, codexCliState?.bindings?.defaultModel]
  );
  const claudeRouteOptions = useMemo(
    () => withCurrentManagedRouteOptions(managedRouteOptions, [
      claudeCodeState?.bindings?.primaryModel,
      claudeCodeState?.bindings?.defaultOpusModel,
      claudeCodeState?.bindings?.defaultSonnetModel,
      claudeCodeState?.bindings?.defaultHaikuModel,
      claudeCodeState?.bindings?.subagentModel
    ]),
    [
      managedRouteOptions,
      claudeCodeState?.bindings?.primaryModel,
      claudeCodeState?.bindings?.defaultOpusModel,
      claudeCodeState?.bindings?.defaultSonnetModel,
      claudeCodeState?.bindings?.defaultHaikuModel,
      claudeCodeState?.bindings?.subagentModel
    ]
  );
  const factoryDroidRouteOptions = useMemo(
    () => withCurrentManagedRouteOptions(managedRouteOptions, [
      factoryDroidState?.bindings?.defaultModel,
      factoryDroidState?.bindings?.missionOrchestratorModel,
      factoryDroidState?.bindings?.missionWorkerModel,
      factoryDroidState?.bindings?.missionValidatorModel
    ]),
    [
      managedRouteOptions,
      factoryDroidState?.bindings?.defaultModel,
      factoryDroidState?.bindings?.missionOrchestratorModel,
      factoryDroidState?.bindings?.missionWorkerModel,
      factoryDroidState?.bindings?.missionValidatorModel
    ]
  );
  const ampDefaultRoute = String(ampEditableConfig?.amp?.defaultRoute || ampEditableConfig?.defaultModel || pickFallbackDefaultModel(ampEditableConfig) || "").trim();
  const effectiveMasterKey = String(ampEditableConfig?.masterKey || snapshot?.config?.document?.masterKey || "").trim();
  const maskedMasterKey = useMemo(() => maskShortSecret(effectiveMasterKey), [effectiveMasterKey]);
  const hasProviders = providers.length > 0;
  const showProviderWizardModal = hasProviders && providerWizardOpen;
  const routerRunning = snapshot?.router?.running === true;
  const startupInstalled = snapshot?.startup?.installed === true;
  const devModeEnabled = snapshot?.environment?.devMode === true;
  const currentConfigPath = String(snapshot?.config?.path || snapshot?.environment?.configPath || "").trim();
  const productionConfigPath = String(snapshot?.environment?.productionConfigPath || "").trim();
  const canSyncProductionConfig = snapshot?.environment?.canSyncProductionConfig === true;
  const routerDisplayPort = Number.isInteger(Number(snapshot?.config?.localServer?.port))
    ? Number(snapshot.config.localServer.port)
    : (Number.isInteger(Number(snapshot?.router?.port)) ? Number(snapshot.router.port) : LOCAL_ROUTER_PORT);
  const routerActionLabel = routerBusy === "start"
    ? "Starting…"
    : routerBusy === "stop"
      ? "Stopping…"
      : routerRunning
        ? "Stop server"
        : "Start server";
  const startupActionLabel = startupBusy === "enable"
    ? "Enabling OS startup…"
    : startupBusy === "disable"
      ? "Disabling OS startup…"
      : startupInstalled
        ? "Disable OS startup"
        : "Enable OS startup";
  const routerStatusMessage = snapshot?.router?.portBusy
    ? (snapshot?.router?.portBusyReason
      || `Port ${routerDisplayPort} is occupied${snapshot?.router?.listenerPids?.length > 0 ? ` by PID${snapshot.router.listenerPids.length === 1 ? "" : "s"} ${snapshot.router.listenerPids.join(", ")}` : ""}.`)
    : String(snapshot?.router?.lastError || "").trim();
  const showOnboarding = !hasCompletedProviderSetup(editableConfig);
  const wizardEligibleProviders = providers.filter((p) => p?.type !== "ollama");
  const onboardingSeedMode = wizardEligibleProviders.length > 0 ? "existing" : "blank";
  const onboardingTargetProviderId = wizardEligibleProviders[0]?.id || "";
  const defaultProviderUserAgent = snapshot?.defaults?.providerUserAgent || QUICK_START_FALLBACK_USER_AGENT;

  useEffect(() => {
    if (loading || saving || parsedDraftState.parseError) return;
    if (effectiveMasterKey) {
      masterKeyBootstrapRef.current = "";
      return;
    }

    const bootstrapSignature = String(snapshot?.config?.rawText || baselineText || "__empty__");
    if (masterKeyBootstrapRef.current === bootstrapSignature) return;
    masterKeyBootstrapRef.current = bootstrapSignature;
    void ensureMasterKeyExists({ showSuccessNotice: false });
  }, [baselineText, effectiveMasterKey, loading, parsedDraftState.parseError, saving, snapshot?.config?.rawText]);

  useEffect(() => {
    if (ampAutosaveTimerRef.current) {
      clearTimeout(ampAutosaveTimerRef.current);
      ampAutosaveTimerRef.current = null;
    }
    if (!ampAutosaveRequest) return;

    const delayMs = ampAutosaveRequest.immediate === true ? 0 : 450;
    ampAutosaveTimerRef.current = setTimeout(() => {
      ampAutosaveTimerRef.current = null;
      const currentSequence = ampAutosaveRequest.sequence;
      setAmpAutosaveState((current) => ({
        ...current,
        status: "saving",
        message: ""
      }));

      void (async () => {
        try {
          const payload = await fetchJson("/api/amp/apply", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({
              rawText: ampAutosaveRequest.rawText,
              source: "autosave"
            })
          });
          if (currentSequence !== ampAutosaveSequenceRef.current) return;
          applySnapshot(payload, {
            preserveDraft: draftRef.current !== ampAutosaveRequest.rawText
          });
          setAmpAutosaveState({
            status: "saved",
            message: "",
            savedAt: new Date().toISOString()
          });
        } catch (error) {
          if (currentSequence !== ampAutosaveSequenceRef.current) return;
          const message = error instanceof Error ? error.message : String(error);
          setAmpAutosaveState({
            status: "error",
            message,
            savedAt: ""
          });
          showNotice("error", message);
        }
      })();
    }, delayMs);

    return () => {
      if (ampAutosaveTimerRef.current) {
        clearTimeout(ampAutosaveTimerRef.current);
        ampAutosaveTimerRef.current = null;
      }
    };
  }, [ampAutosaveRequest]);

  function openProviderWizard() {
    setProviderWizardOpen(true);
    setProviderWizardKey((current) => current + 1);
  }

  function handleOpenQuickStart() {
    openProviderWizard();
  }

  function handleHideQuickStart() {
    setProviderWizardOpen(false);
  }

  useEffect(() => {
    if (!hasProviders && providerWizardOpen) setProviderWizardOpen(false);
  }, [hasProviders, providerWizardOpen]);

  function showNotice(tone, message) {
    noticeIdRef.current += 1;
    setNotices((current) => [...current, { id: `notice-${noticeIdRef.current}`, tone, message }]);
  }

  function dismissNotice(noticeId) {
    setNotices((current) => current.filter((notice) => notice.id !== noticeId));
  }

  function applySnapshot(nextSnapshot, { preserveDraft = false } = {}) {
    setSnapshot(nextSnapshot);

    const nextRawText = String(nextSnapshot?.config?.rawText || "");
    if (!preserveDraft || draftRef.current === baselineRef.current) {
      setDraftText(nextRawText);
      setBaselineText(nextRawText);
      setRemoteConfigUpdated(false);
      setValidation({
        rawText: nextRawText,
        summary: nextSnapshot?.config,
        validationMessages: nextSnapshot?.config?.validationMessages || []
      });
      return;
    }

    setBaselineText(nextRawText);
    if (nextRawText !== baselineRef.current) {
      setRemoteConfigUpdated(true);
    }
  }

  async function loadState({ preserveDraft = false } = {}) {
    const payload = await fetchJson("/api/state");
    applySnapshot(payload, { preserveDraft });
  }

  useEffect(() => {
    let cancelled = false;

    function closeEventSource() {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    }

    function clearReconnectTimer() {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function scheduleReconnect() {
      if (cancelled || reconnectTimerRef.current) return;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectEventSource({ isReconnect: true });
      }, LIVE_UPDATES_RETRY_MS);
    }

    function connectEventSource({ isReconnect = false } = {}) {
      if (cancelled) return;
      clearReconnectTimer();
      closeEventSource();
      const source = new EventSource("/api/events");
      eventSourceRef.current = source;

      source.onopen = () => {
        if (cancelled || eventSourceRef.current !== source) return;
        if (isReconnect) {
          void loadState({
            preserveDraft: draftRef.current !== baselineRef.current
          }).catch(() => {});
        }
      };

      source.addEventListener("state", (event) => {
        if (cancelled || eventSourceRef.current !== source) return;
        try {
          const payload = JSON.parse(event.data);
          if (payload?.snapshot) {
            applySnapshot(payload.snapshot, {
              preserveDraft: true
            });
          }
        } catch (error) {
          showNotice("error", error instanceof Error ? error.message : String(error));
        }
      });

      source.addEventListener("log", (event) => {
        if (cancelled || eventSourceRef.current !== source) return;
        try {
          const entry = JSON.parse(event.data);
          setSnapshot((current) => current ? {
            ...current,
            logs: [entry, ...(current.logs || [])].slice(0, 150)
          } : current);
        } catch {
        }
      });

      source.addEventListener("logs", (event) => {
        if (cancelled || eventSourceRef.current !== source) return;
        try {
          const payload = JSON.parse(event.data);
          setSnapshot((current) => current ? {
            ...current,
            ...(payload?.activityLog ? { activityLog: payload.activityLog } : {}),
            logs: Array.isArray(payload?.logs) ? payload.logs : []
          } : current);
        } catch {
        }
      });

      source.onerror = () => {
        if (cancelled || eventSourceRef.current !== source) return;
        closeEventSource();
        scheduleReconnect();
      };
    }

    (async () => {
      try {
        await loadState();
      } catch (error) {
        if (!cancelled) {
          showNotice("error", error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          connectEventSource();
        }
      }
    })();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      closeEventSource();
    };
  }, []);


  async function validateDraftText(rawText, { silent = false } = {}) {
    setValidating(true);
    try {
      const payload = await fetchJson("/api/config/validate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ rawText })
      });
      setValidation({ rawText, summary: payload.summary, validationMessages: payload.validationMessages || [] });
      if (!silent) {
        showNotice(detectValidationVariant(payload.summary) === "success" ? "success" : "warning", payload.summary.validationSummary);
      }
      return payload;
    } catch (error) {
      if (!silent) {
        showNotice("error", error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      setValidating(false);
    }
  }

  async function saveDraftText(rawText, { successMessage = "Config saved.", showSuccessNotice = true } = {}) {
    setSaving(true);
    try {
      const payload = await fetchJson("/api/config/save", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ rawText })
      });
      applySnapshot(payload, {
        preserveDraft: draftRef.current !== rawText
      });
      if (showSuccessNotice && successMessage) {
        showNotice("success", successMessage);
      }
      return payload;
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setSaving(false);
    }
  }

  async function handleSyncProductionConfig() {
    if (!canSyncProductionConfig || syncProductionBusy) return;
    if (isDirty && typeof window !== "undefined" && typeof window.confirm === "function") {
      const confirmed = window.confirm("Replace the current dev draft with the production config file? Unsaved edits in this dev session will be lost.");
      if (!confirmed) return;
    }

    setSyncProductionBusy(true);
    try {
      const payload = await fetchJson("/api/config/sync-production", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}"
      });
      applySnapshot(payload, { preserveDraft: false });
      showNotice("success", payload?.message || "Production config synced into the dev workspace.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setSyncProductionBusy(false);
    }
  }

  function queueAmpAutosave(rawText, { immediate = false } = {}) {
    const sequence = ampAutosaveSequenceRef.current + 1;
    ampAutosaveSequenceRef.current = sequence;
    setAmpAutosaveRequest({
      sequence,
      rawText,
      immediate: immediate === true
    });
    setAmpAutosaveState((current) => ({
      status: "pending",
      message: "",
      savedAt: current.savedAt
    }));
  }

  function handleDraftChange(value) {
    setDraftText(value);
    setValidation(null);
  }

  async function saveInlineConfigObject(nextConfig, successMessage, options = {}) {
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    setRemoteConfigUpdated(false);
    await saveDraftText(rawText, { successMessage, ...options });
  }

  async function testNewProviderModels({
    providerId,
    endpoints,
    newModelIds,
    credentialPayload,
    headers,
    onModelTestStateChange
  }) {
    if (!Array.isArray(newModelIds) || newModelIds.length === 0) {
      onModelTestStateChange?.({
        phase: "",
        modelStates: {},
        failedModelIds: [],
        message: ""
      });
      return { ok: true };
    }

    const modelStates = Object.fromEntries(newModelIds.map((modelId) => [modelId, "pending"]));
    const emitState = ({ phase = "testing", message = "", failedModelIds = [] } = {}) => {
      onModelTestStateChange?.({
        phase,
        modelStates: { ...modelStates },
        failedModelIds,
        message
      });
    };
    const buildTestingMessage = () => {
      const completedCount = newModelIds.filter((modelId) => modelStates[modelId] === "success" || modelStates[modelId] === "error").length;
      return `Testing ${completedCount}/${newModelIds.length} new model${newModelIds.length === 1 ? "" : "s"} for ${providerId}.`;
    };

    emitState({ phase: "testing", message: buildTestingMessage() });

    try {
      const result = await fetchJsonLineStream("/api/config/test-provider-stream", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          endpoints,
          models: newModelIds,
          ...credentialPayload,
          ...(headers && typeof headers === "object" && !Array.isArray(headers) ? { headers } : {})
        })
      }, {
        onMessage: (message) => {
          if (message?.type !== "progress") return;
          const event = message.event || {};
          if (event.phase !== "model-done") return;
          const modelId = String(event.model || "").trim();
          if (!modelId || !Object.prototype.hasOwnProperty.call(modelStates, modelId)) return;
          modelStates[modelId] = event.confirmed ? "success" : "error";
          emitState({ phase: "testing", message: buildTestingMessage() });
        }
      });

      const confirmedModels = new Set(Array.isArray(result?.models) ? result.models : []);
      const unresolvedModels = newModelIds.filter((modelId) => !confirmedModels.has(modelId));
      for (const modelId of newModelIds) {
        modelStates[modelId] = confirmedModels.has(modelId) ? "success" : "error";
      }
      if (!result?.ok || unresolvedModels.length > 0) {
        const warningMessage = unresolvedModels.length > 0
          ? `New model test failed for ${providerId}: ${unresolvedModels.join(", ")}.`
          : (result?.warnings || []).join(" ") || `New model test failed for ${providerId}.`;
        emitState({
          phase: "",
          failedModelIds: unresolvedModels,
          message: warningMessage
        });
        showNotice("warning", warningMessage);
        return {
          ok: false,
          failedModelIds: unresolvedModels,
          result
        };
      }

      emitState({
        phase: "saving",
        message: `Saving ${newModelIds.length} confirmed new model${newModelIds.length === 1 ? "" : "s"} for ${providerId}.`
      });
      return {
        ok: true,
        failedModelIds: [],
        result
      };
    } catch (error) {
      for (const modelId of newModelIds) {
        if (modelStates[modelId] !== "success") modelStates[modelId] = "error";
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failedModelIds = newModelIds.filter((modelId) => modelStates[modelId] === "error");
      emitState({
        phase: "",
        failedModelIds,
        message: errorMessage
      });
      showNotice("error", errorMessage);
      return {
        ok: false,
        failedModelIds
      };
    }
  }

  async function handleApplyProviderDetails(providerId, draftProvider, { showSuccessNotice = true } = {}) {
    if (providerEditorDisabledReason) {
      showNotice("warning", providerEditorDisabledReason);
      return false;
    }

    const resolvedProviderId = String(draftProvider?.id || "").trim();
    const resolvedProviderName = String(draftProvider?.name || "").trim();
    const resolvedEndpoints = Array.isArray(draftProvider?.endpoints)
      ? normalizeUniqueTrimmedValues(draftProvider.endpoints)
      : mergeChipValuesAndDraft([], draftProvider?.endpoint || "");
    const resolvedRateLimitRows = Array.isArray(draftProvider?.rateLimitRows)
      ? resolveRateLimitDraftRows(draftProvider.rateLimitRows)
      : [];
    const existingProvider = providers.find((entry) => entry?.id === providerId);
    const isApiProvider = inferQuickStartConnectionType(existingProvider) === "api";
    const knownModelIds = collectProviderModelIds(existingProvider);

    if (!resolvedProviderId) {
      showNotice("warning", "Provider id is required.");
      return false;
    }
    if (!QUICK_START_PROVIDER_ID_PATTERN.test(resolvedProviderId)) {
      showNotice("warning", "Provider id must start with a letter and use lowercase letters, digits, or dashes only.");
      return false;
    }
    if (!resolvedProviderName) {
      showNotice("warning", "Provider name is required.");
      return false;
    }
    if (resolvedProviderId !== providerId && providers.some((entry) => entry?.id === resolvedProviderId)) {
      showNotice("warning", `Provider id "${resolvedProviderId}" already exists.`);
      return false;
    }
    if (isApiProvider && resolvedEndpoints.length === 0) {
      showNotice("warning", "API Key providers require at least one valid http(s) endpoint.");
      return false;
    }
    if (isApiProvider && resolvedEndpoints.some((endpoint) => !isLikelyHttpEndpoint(endpoint))) {
      showNotice("warning", "One or more endpoints are invalid. Use full http:// or https:// URLs.");
      return false;
    }
    const rateLimitIssue = isApiProvider
      ? validateRateLimitDraftRows(resolvedRateLimitRows, {
          knownModelIds,
          requireAtLeastOne: true
        })
      : "";
    if (rateLimitIssue) {
      showNotice("warning", rateLimitIssue);
      return false;
    }

    const nextConfig = applyProviderInlineEdits(parsedDraftState.value || persistedConfig, providerId, {
      ...draftProvider,
      endpoints: resolvedEndpoints,
      rateLimitRows: resolvedRateLimitRows
    });
    try {
      await saveInlineConfigObject(nextConfig, `Updated provider ${resolvedProviderId}.`, { showSuccessNotice });
      return true;
    } catch {
      return false;
    }
  }

  async function handleSaveProviderEditorChanges(
    providerId,
    { providerDraft = null, modelRows = null, showSuccessNotice = true, onModelTestStateChange = null } = {}
  ) {
    if (providerEditorDisabledReason) {
      showNotice("warning", providerEditorDisabledReason);
      return false;
    }

    const existingProvider = providers.find((entry) => entry?.id === providerId);
    if (!existingProvider) {
      showNotice("error", `Provider '${providerId}' was not found.`);
      return false;
    }

    const hasProviderDraft = Boolean(providerDraft && typeof providerDraft === "object");
    const hasModelRows = Array.isArray(modelRows);
    if (!hasProviderDraft && !hasModelRows) return true;

    const isApiProvider = inferQuickStartConnectionType(existingProvider) === "api";
    const resolvedProviderId = hasProviderDraft ? String(providerDraft?.id || "").trim() : providerId;
    const resolvedProviderName = hasProviderDraft
      ? String(providerDraft?.name || "").trim()
      : String(existingProvider?.name || providerId).trim();
    const resolvedEndpoints = hasProviderDraft
      ? (Array.isArray(providerDraft?.endpoints)
        ? normalizeUniqueTrimmedValues(providerDraft.endpoints)
        : mergeChipValuesAndDraft([], providerDraft?.endpoint || ""))
      : collectQuickStartEndpoints(existingProvider);
    const resolvedRateLimitRows = hasProviderDraft && Array.isArray(providerDraft?.rateLimitRows)
      ? resolveRateLimitDraftRows(providerDraft.rateLimitRows)
      : [];
    const nextRows = hasModelRows
      ? modelRows
        .map((row) => ({
          ...row,
          id: String(row?.id || "").trim(),
          contextWindow: normalizeContextWindowInput(row?.contextWindow || "")
        }))
        .filter((row) => row.id)
      : [];

    if (hasProviderDraft) {
      const knownModelIds = hasModelRows
        ? nextRows.map((row) => row.id)
        : collectProviderModelIds(existingProvider);

      if (!resolvedProviderId) {
        showNotice("warning", "Provider id is required.");
        return false;
      }
      if (!QUICK_START_PROVIDER_ID_PATTERN.test(resolvedProviderId)) {
        showNotice("warning", "Provider id must start with a letter and use lowercase letters, digits, or dashes only.");
        return false;
      }
      if (!resolvedProviderName) {
        showNotice("warning", "Provider name is required.");
        return false;
      }
      if (resolvedProviderId !== providerId && providers.some((entry) => entry?.id === resolvedProviderId)) {
        showNotice("warning", `Provider id "${resolvedProviderId}" already exists.`);
        return false;
      }
      if (isApiProvider && resolvedEndpoints.length === 0) {
        showNotice("warning", "API Key providers require at least one valid http(s) endpoint.");
        return false;
      }
      if (isApiProvider && resolvedEndpoints.some((endpoint) => !isLikelyHttpEndpoint(endpoint))) {
        showNotice("warning", "One or more endpoints are invalid. Use full http:// or https:// URLs.");
        return false;
      }
      const rateLimitIssue = isApiProvider
        ? validateRateLimitDraftRows(resolvedRateLimitRows, {
            knownModelIds,
            requireAtLeastOne: true
          })
        : "";
      if (rateLimitIssue) {
        showNotice("warning", rateLimitIssue);
        return false;
      }
    }

    if (hasModelRows) {
      if (nextRows.length === 0) {
        showNotice("warning", "Keep at least one model id on the provider.");
        return false;
      }
      if (hasDuplicateTrimmedValues(nextRows.map((row) => row.id))) {
        showNotice("warning", "Model ids must be unique for each provider.");
        return false;
      }
      const hasInvalidContextWindow = nextRows.some((row) => {
        const rawValue = String(row?.contextWindow || "").trim();
        if (!rawValue) return false;
        const parsed = Number.parseInt(rawValue, 10);
        return !Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== rawValue;
      });
      if (hasInvalidContextWindow) {
        showNotice("warning", "Context windows must be positive integers when set.");
        return false;
      }

      const currentModelIds = collectProviderModelIds(existingProvider);
      const newModelIds = nextRows
        .map((row) => row.id)
        .filter((modelId) => !currentModelIds.includes(modelId));

      if (isApiProvider && newModelIds.length > 0) {
        if (resolvedEndpoints.length === 0) {
          showNotice("warning", `Provider '${resolvedProviderId}' needs at least one endpoint before testing new models.`);
          return false;
        }

        const credentialPayload = getDraftProviderCredentialPayload(providerDraft, existingProvider);
        if (!credentialPayload.apiKey && !credentialPayload.apiKeyEnv) {
          showNotice("warning", `Provider '${resolvedProviderId}' needs an API key or env before testing new models.`);
          return false;
        }

        const testOutcome = await testNewProviderModels({
          providerId: resolvedProviderId,
          endpoints: resolvedEndpoints,
          newModelIds,
          credentialPayload,
          headers: existingProvider?.headers,
          onModelTestStateChange
        });
        if (!testOutcome.ok) {
          return false;
        }
      }
    }

    let nextConfig = parsedDraftState.value || persistedConfig;
    if (hasProviderDraft) {
      nextConfig = applyProviderInlineEdits(nextConfig, providerId, {
        ...providerDraft,
        endpoints: resolvedEndpoints,
        rateLimitRows: resolvedRateLimitRows
      });
    }
    if (hasModelRows) {
      nextConfig = applyProviderModelEdits(nextConfig, hasProviderDraft ? resolvedProviderId : providerId, nextRows);
    }

    const successMessage = hasProviderDraft && hasModelRows
      ? `Updated provider ${resolvedProviderId} and saved its model list.`
      : hasProviderDraft
        ? `Updated provider ${resolvedProviderId}.`
        : (() => {
          const currentModelIds = collectProviderModelIds(existingProvider);
          const newModelIds = nextRows
            .map((row) => row.id)
            .filter((modelId) => !currentModelIds.includes(modelId));
          return newModelIds.length > 0
            ? `Tested ${newModelIds.length} new model${newModelIds.length === 1 ? "" : "s"} and updated ${resolvedProviderId}.`
            : `Updated models for ${resolvedProviderId}.`;
        })();

    try {
      await saveInlineConfigObject(nextConfig, successMessage, { showSuccessNotice });
      onModelTestStateChange?.({
        phase: "",
        modelStates: {},
        failedModelIds: [],
        message: ""
      });
      return true;
    } catch {
      return false;
    }
  }

  async function ensureMasterKeyExists({ showSuccessNotice = false } = {}) {
    if (parsedDraftState.parseError) return false;
    if (String((parsedDraftState.value || persistedConfig || {}).masterKey || "").trim()) return false;

    const nextConfig = safeClone(parsedDraftState.value || persistedConfig || {});
    nextConfig.masterKey = createMasterKey();

    try {
      await saveInlineConfigObject(nextConfig, "Gateway key ready.", { showSuccessNotice });
      return true;
    } catch {
      return false;
    }
  }

  async function handleCopyMasterKey() {
    if (!effectiveMasterKey) {
      showNotice("warning", "Gateway key is still generating. Try again in a second.");
      return;
    }

    try {
      await copyTextToClipboard(effectiveMasterKey);
      showNotice("success", "Gateway key copied to clipboard.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleCopyApiEndpoint() {
    if (!ampClientUrl) {
      showNotice("warning", "API endpoint is not ready yet.");
      return;
    }

    try {
      await copyTextToClipboard(ampClientUrl);
      showNotice("success", "API endpoint copied to clipboard.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleCopyAliasId(aliasId) {
    const value = String(aliasId || "").trim();
    if (!value) {
      showNotice("warning", "Alias id is not ready yet.");
      return;
    }

    try {
      await copyTextToClipboard(value);
      showNotice("success", `Alias id ${value} copied to clipboard.`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleOpenFilePath(pathValue, label, {
    ensureMode = "none",
    successMessage = ""
  } = {}) {
    const value = String(pathValue || "").trim();
    if (!value) {
      showNotice("warning", `${label} is not resolved yet.`);
      return;
    }

    try {
      await fetchJson("/api/file/open", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          editorId: "default",
          filePath: value,
          ensureMode
        })
      });
      showNotice("success", successMessage || `Opened ${label} in the default app.`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleCopyProviderModelId(modelId) {
    const value = String(modelId || "").trim();
    if (!value) {
      showNotice("warning", "Model id is not ready yet.");
      return;
    }

    try {
      await copyTextToClipboard(value);
      showNotice("success", `Model id ${value} copied to clipboard.`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleRotateMasterKey() {
    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm("Rotate the gateway key? Existing clients using the old key will need the new one. Linked tools like AMP, Codex CLI, and Claude Code will auto-update to the new key.");
    if (!confirmed) return;

    const nextConfig = safeClone(parsedDraftState.value || persistedConfig || {});
    nextConfig.masterKey = createMasterKey();
    try {
      await saveInlineConfigObject(nextConfig, "Rotated gateway key. Linked tools like AMP, Codex CLI, and Claude Code refreshed automatically.");
    } catch {
    }
  }

  async function handleApplyProviderModels(providerId, rows, { providerDraft = null, onModelTestStateChange = null } = {}) {
    if (providerEditorDisabledReason) {
      showNotice("warning", providerEditorDisabledReason);
      return false;
    }

    const existingProvider = providers.find((entry) => entry?.id === providerId);
    if (!existingProvider) {
      showNotice("error", `Provider '${providerId}' was not found.`);
      return false;
    }

    const nextRows = (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        ...row,
        id: String(row?.id || "").trim()
      }))
      .filter((row) => row.id);
    const resolvedProviderId = providerDraft ? String(providerDraft?.id || "").trim() || providerId : providerId;
    const endpoints = providerDraft
      ? (Array.isArray(providerDraft?.endpoints)
        ? normalizeUniqueTrimmedValues(providerDraft.endpoints)
        : mergeChipValuesAndDraft([], providerDraft?.endpoint || ""))
      : collectQuickStartEndpoints(existingProvider);
    const currentModelIds = (Array.isArray(existingProvider?.models) ? existingProvider.models : [])
      .map((model) => String(model?.id || "").trim())
      .filter(Boolean);
    const newModelIds = nextRows
      .map((row) => row.id)
      .filter((modelId) => !currentModelIds.includes(modelId));

    if (inferQuickStartConnectionType(existingProvider) === "api" && newModelIds.length > 0) {
      if (endpoints.length === 0) {
        showNotice("warning", `Provider '${resolvedProviderId}' needs at least one endpoint before testing new models.`);
        return false;
      }

      const credentialPayload = getDraftProviderCredentialPayload(providerDraft, existingProvider);
      if (!credentialPayload.apiKey && !credentialPayload.apiKeyEnv) {
        showNotice("warning", `Provider '${resolvedProviderId}' needs an API key or env before testing new models.`);
        return false;
      }

      const testOutcome = await testNewProviderModels({
        providerId: resolvedProviderId,
        endpoints,
        newModelIds,
        credentialPayload,
        headers: existingProvider?.headers,
        onModelTestStateChange
      });
      if (!testOutcome.ok) {
        return false;
      }
    }

    const nextConfig = applyProviderModelEdits(parsedDraftState.value || persistedConfig, providerId, nextRows);
    try {
      const successMessage = newModelIds.length > 0
        ? `Tested ${newModelIds.length} new model${newModelIds.length === 1 ? "" : "s"} and updated ${providerId}.`
        : `Updated models for ${providerId}.`;
      await saveInlineConfigObject(nextConfig, successMessage);
      onModelTestStateChange?.({
        phase: "",
        modelStates: {},
        failedModelIds: [],
        message: ""
      });
      return true;
    } catch {
      return false;
    }
  }

  async function handleApplyModelAlias(aliasId, draftAlias, options = {}) {
    if (providerEditorDisabledReason) {
      showNotice("warning", providerEditorDisabledReason);
      return false;
    }

    const nextConfig = applyModelAliasEdits(parsedDraftState.value || persistedConfig, aliasId, draftAlias);
    const resolvedAliasId = String(draftAlias?.id || aliasId || "").trim() || aliasId;
    try {
      await saveInlineConfigObject(nextConfig, options.successMessage || `Updated alias ${resolvedAliasId}.`, {
        showSuccessNotice: options.showSuccessNotice !== false
      });
      return true;
    } catch {
      return false;
    }
  }

  async function handleRemoveModelAlias(aliasId) {
    if (providerEditorDisabledReason) {
      showNotice("warning", providerEditorDisabledReason);
      return;
    }

    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm(`Remove alias "${aliasId}" from the config?`);
    if (!confirmed) return;

    const nextConfig = removeModelAlias(parsedDraftState.value || persistedConfig, aliasId);
    try {
      await saveInlineConfigObject(nextConfig, `Removed alias ${aliasId}.`);
    } catch {
    }
  }

  async function handleCopyEndpoint(endpoint) {
    try {
      await copyTextToClipboard(endpoint?.url || "");
      showNotice("success", `${endpoint?.label || "Endpoint"} copied to clipboard.`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleToggleAmpGlobalRouting() {
    const routingEnabled = ampClientGlobal?.routedViaRouter === true;
    const shouldEnable = !routingEnabled;

    if (shouldEnable) {
      if (ampDisabledReason) {
        showNotice("warning", ampDisabledReason);
        return;
      }
      if (!effectiveMasterKey) {
        showNotice("warning", "Gateway key is still generating. Try again in a second.");
        return;
      }
      if (!ampClientUrl) {
        showNotice("warning", "API endpoint is not ready yet.");
        return;
      }
    }

    setAmpRoutingBusy(shouldEnable ? "enable" : "disable");
    try {
      let usedCompatFallback = false;
      let payload;
      try {
        payload = await fetchJson("/api/amp/global-route", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            enabled: shouldEnable,
            rawText: shouldEnable ? draftText : undefined,
            endpointUrl: ampClientUrl
          })
        });
      } catch (error) {
        if (error?.statusCode === 404 && shouldEnable) {
          usedCompatFallback = true;
          payload = await fetchJson("/api/amp/apply", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({
              rawText: draftText,
              source: "amp-global-route-compat",
              patchScope: "global",
              endpointUrl: ampClientUrl
            })
          });
        } else if (error?.statusCode === 404) {
          throw new Error("Restart the web console so the AMP routing endpoint is available.");
        } else {
          throw error;
        }
      }
      await loadState({ preserveDraft: !shouldEnable });
      const successMessage = shouldEnable ? "AMP connected." : "AMP disconnected.";
      showNotice("success", usedCompatFallback ? `${successMessage} Restart the web console if the AMP status does not refresh.` : successMessage);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setAmpRoutingBusy("");
    }
  }

  function handleAmpInboundChange(entryId, value) {
    if (ampDisabledReason) {
      showNotice("warning", ampDisabledReason);
      return;
    }

    const normalizedValue = String(value || "").trim();
    const duplicateEntry = ampRows.find((entry) => entry.id !== entryId && String(entry?.inbound || "").trim() === normalizedValue);
    if (normalizedValue && duplicateEntry) {
      showNotice("warning", `AMP inbound match "${normalizedValue}" already exists.`);
      return;
    }

    const nextConfig = updateAmpEditableRouteConfig(parsedDraftState.value || persistedConfig, entryId, { inbound: value });
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText);
  }

  function handleAmpOutboundChange(entryId, value) {
    if (ampDisabledReason) {
      showNotice("warning", ampDisabledReason);
      return;
    }

    const nextConfig = updateAmpEditableRouteConfig(parsedDraftState.value || persistedConfig, entryId, {
      outbound: value === "__default__" ? "" : value
    });
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText);
  }

  function handleWebSearchStrategyChange(value) {
    if (webSearchDisabledReason) {
      showNotice("warning", webSearchDisabledReason);
      return;
    }

    const nextConfig = updateWebSearchConfig(parsedDraftState.value || persistedConfig, {
      strategy: value
    });
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText);
  }

  function handleWebSearchProviderChange(providerId, field, value) {
    if (webSearchDisabledReason) {
      showNotice("warning", webSearchDisabledReason);
      return;
    }

    const nextConfig = updateWebSearchProviderConfig(parsedDraftState.value || persistedConfig, providerId, {
      [field]: value
    });
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText, {
      immediate: shouldImmediateAutosaveWebSearchProviderChange(providerId, field, value)
    });
  }

  function handleWebSearchProviderMove(providerId, direction) {
    if (webSearchDisabledReason) {
      showNotice("warning", webSearchDisabledReason);
      return;
    }

    const nextConfig = moveWebSearchProviderConfig(parsedDraftState.value || persistedConfig, providerId, direction);
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText);
  }

  function handleRemoveWebSearchProvider(providerId) {
    if (webSearchDisabledReason) {
      showNotice("warning", webSearchDisabledReason);
      return;
    }

    const nextConfig = removeWebSearchProviderConfig(parsedDraftState.value || persistedConfig, providerId);
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText, { immediate: true });
  }

  async function handleAddHostedSearchEndpoint({ providerId, modelId }) {
    if (webSearchDisabledReason) {
      throw new Error(webSearchDisabledReason);
    }

    const routeId = buildHostedWebSearchProviderId(providerId, modelId);
    if (!routeId) {
      throw new Error("Choose a provider and GPT model before testing.");
    }

    const existingIds = new Set(
      (Array.isArray(webSearchConfig?.providers) ? webSearchConfig.providers : [])
        .map((provider) => normalizeWebSearchProviderKey(provider?.id))
        .filter(Boolean)
    );
    if (existingIds.has(normalizeWebSearchProviderKey(routeId))) {
      throw new Error(`Web search route '${routeId}' is already configured.`);
    }

    const payload = await fetchJson("/api/config/test-web-search-provider", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        providerId,
        modelId,
        rawText: draftText
      })
    });

    const nextConfig = addHostedWebSearchProviderConfig(parsedDraftState.value || persistedConfig, providerId, modelId);
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);
    queueAmpAutosave(rawText, { immediate: true });
    showNotice("success", `Added ${routeId} to shared web search routing.`);
    return payload?.result || null;
  }

  async function handleCreateAmpEntry({ inbound, outbound }) {
    if (ampDisabledReason) {
      showNotice("warning", ampDisabledReason);
      return false;
    }

    const normalizedInbound = String(inbound || "").trim();
    if (normalizedInbound && ampRows.some((entry) => String(entry?.inbound || "").trim() === normalizedInbound)) {
      showNotice("warning", `AMP inbound match "${normalizedInbound}" already exists.`);
      return false;
    }

    const nextConfig = createAmpEditableRoute(parsedDraftState.value || persistedConfig, {
      inbound,
      outbound
    });
    try {
      await saveInlineConfigObject(nextConfig, `Added AMP route ${String(inbound || "").trim()}.`);
      return true;
    } catch {
      return false;
    }
  }

  async function handleRemoveAmpEntry(entryId) {
    const entry = findAmpEditableRouteEntry(parsedDraftState.value || persistedConfig, entryId);
    if (!entry?.removable) return;

    const label = entry.source === "raw"
      ? entry.inbound || entry.label
      : entry.routeKey || entry.label;
    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm(`Remove AMP route mapping "${label}"?`);
    if (!confirmed) return;

    const nextConfig = removeAmpEditableRoute(parsedDraftState.value || persistedConfig, entryId);
    try {
      await saveInlineConfigObject(nextConfig, `Removed AMP route ${label}.`);
    } catch {
    }
  }

  function handleResetDraft() {
    setDraftText(baselineText);
    setValidation({ rawText: baselineText, summary: snapshot?.config, validationMessages: snapshot?.config?.validationMessages || [] });
    setRemoteConfigUpdated(false);
    showNotice("success", "Editor reset to the latest disk version.");
  }

  function handleApplyQuickStartDraft(rawText) {
    handleDraftChange(rawText);
    setRemoteConfigUpdated(false);
    showNotice("success", "Quick-start config loaded into the editor.");
  }

  async function handleValidateQuickStart(rawText) {
    handleDraftChange(rawText);
    try {
      await validateDraftText(rawText);
    } catch {
    }
  }

  async function handleSaveQuickStart(rawText) {
    handleDraftChange(rawText);
    let validationPayload;
    try {
      validationPayload = await validateDraftText(rawText, { silent: true });
    } catch {
      return null;
    }

    const summary = validationPayload?.summary || {};
    if (summary.parseError) {
      showNotice("warning", summary.validationSummary || "Quick-start config contains invalid JSON.");
      return null;
    }

    try {
      const result = await saveDraftText(rawText, { successMessage: "Quick-start config saved." });
      if ((summary.validationErrors || []).length > 0) {
        showNotice("warning", summary.validationSummary);
      }
      return result;
    } catch {
      return null;
    }
  }

  async function handleSaveAndStartQuickStart(rawText) {
    const savedSnapshot = await handleSaveQuickStart(rawText);
    if (!savedSnapshot) return false;

    setActiveTab("activity");

    if (savedSnapshot.router?.running) {
      showNotice("success", "Quick-start config saved. Router is already running.");
      return true;
    }

    showNotice("success", "Quick-start config saved. Starting router…");
    setTimeout(() => {
      void runRouterAction("start");
    }, 0);
    return true;
  }

  async function handleSaveQuickStartAndClose(rawText) {
    const savedSnapshot = await handleSaveQuickStart(rawText);
    if (savedSnapshot) handleHideQuickStart();
    return Boolean(savedSnapshot);
  }

  async function handleSaveAndStartQuickStartAndClose(rawText) {
    const saved = await handleSaveAndStartQuickStart(rawText);
    if (saved) handleHideQuickStart();
    return saved;
  }

  async function handleOpenConfigFileDefault() {
    setOpenEditorBusy(true);
    try {
      await fetchJson("/api/config/open", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ editorId: "default" })
      });
      showNotice("success", "Opened config file in the default app.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setOpenEditorBusy(false);
    }
  }

  async function handleToggleCodexCliRouting() {
    const routingEnabled = codexCliState?.routedViaRouter === true;
    const shouldEnable = !routingEnabled;

    if (shouldEnable) {
      if (codingToolDisabledReason) {
        showNotice("warning", codingToolDisabledReason);
        return;
      }
      if (!effectiveMasterKey) {
        showNotice("warning", "Gateway key is still generating. Try again in a second.");
        return;
      }
      if (!ampClientUrl) {
        showNotice("warning", "API endpoint is not ready yet.");
        return;
      }
    }

    setCodexRoutingBusy(shouldEnable ? "enable" : "disable");
    try {
      await fetchJson("/api/codex-cli/global-route", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          enabled: shouldEnable,
          rawText: shouldEnable ? draftText : undefined,
          endpointUrl: ampClientUrl,
          bindings: shouldEnable ? {
            defaultModel: codexCliState?.bindings?.defaultModel || ampDefaultRoute,
            thinkingLevel: codexCliState?.bindings?.thinkingLevel || ""
          } : undefined
        })
      });
      await loadState({ preserveDraft: !shouldEnable });
      showNotice("success", shouldEnable ? "Codex CLI connected." : "Codex CLI disconnected.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setCodexRoutingBusy("");
    }
  }

  async function handleToggleClaudeCodeRouting() {
    const routingEnabled = claudeCodeState?.routedViaRouter === true;
    const shouldEnable = !routingEnabled;

    if (shouldEnable) {
      if (codingToolDisabledReason) {
        showNotice("warning", codingToolDisabledReason);
        return;
      }
      if (!effectiveMasterKey) {
        showNotice("warning", "Gateway key is still generating. Try again in a second.");
        return;
      }
      if (!ampClientUrl) {
        showNotice("warning", "API endpoint is not ready yet.");
        return;
      }
    }

    setClaudeRoutingBusy(shouldEnable ? "enable" : "disable");
    try {
      await fetchJson("/api/claude-code/global-route", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          enabled: shouldEnable,
          rawText: shouldEnable ? draftText : undefined,
          endpointUrl: ampClientUrl,
          bindings: shouldEnable ? {
            primaryModel: claudeCodeState?.bindings?.primaryModel || "",
            defaultOpusModel: claudeCodeState?.bindings?.defaultOpusModel || "",
            defaultSonnetModel: claudeCodeState?.bindings?.defaultSonnetModel || "",
            defaultHaikuModel: claudeCodeState?.bindings?.defaultHaikuModel || "",
            subagentModel: claudeCodeState?.bindings?.subagentModel || "",
            thinkingLevel: claudeCodeState?.bindings?.thinkingLevel || ""
          } : undefined
        })
      });
      await loadState({ preserveDraft: !shouldEnable });
      showNotice("success", shouldEnable ? "Claude Code connected." : "Claude Code disconnected.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setClaudeRoutingBusy("");
    }
  }

  async function handleCodexBindingChange(fieldId, value) {
    const nextBindings = {
      defaultModel: codexCliState?.bindings?.defaultModel || ampDefaultRoute,
      thinkingLevel: codexCliState?.bindings?.thinkingLevel || ""
    };
    nextBindings[fieldId] = value;

    setCodexBindingsBusy(true);
    try {
      await fetchJson("/api/codex-cli/model-bindings", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          bindings: nextBindings
        })
      });
      await loadState({ preserveDraft: true });
      showNotice("success", "Codex CLI bindings updated.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setCodexBindingsBusy(false);
    }
  }

  async function handleClaudeBindingChange(fieldId, value) {
    if (fieldId === "webSearchProvider") {
      setClaudeBindingsBusy(true);
      try {
        const payload = await fetchJson("/api/claude-code/search-provider", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            webSearchProvider: value,
            rawText: draftText
          })
        });
        applySnapshot(payload, { preserveDraft: false });
        showNotice("success", value ? "Claude Code search capability updated." : "Claude Code search capability cleared.");
      } catch (error) {
        showNotice("error", error instanceof Error ? error.message : String(error));
      } finally {
        setClaudeBindingsBusy(false);
      }
      return;
    }

    const isRoutedViaRouter = claudeCodeState?.routedViaRouter === true;

    if (fieldId === "thinkingLevel" && !isRoutedViaRouter) {
      setClaudeBindingsBusy(true);
      try {
        await fetchJson("/api/claude-code/effort-level", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ effortLevel: value })
        });
        await loadState({ preserveDraft: true });
        showNotice("success", value ? `Effort level set to ${value}.` : "Effort level cleared.");
      } catch (error) {
        showNotice("error", error instanceof Error ? error.message : String(error));
      } finally {
        setClaudeBindingsBusy(false);
      }
      return;
    }

    const nextBindings = {
      primaryModel: claudeCodeState?.bindings?.primaryModel || "",
      defaultOpusModel: claudeCodeState?.bindings?.defaultOpusModel || "",
      defaultSonnetModel: claudeCodeState?.bindings?.defaultSonnetModel || "",
      defaultHaikuModel: claudeCodeState?.bindings?.defaultHaikuModel || "",
      subagentModel: claudeCodeState?.bindings?.subagentModel || "",
      thinkingLevel: claudeCodeState?.bindings?.thinkingLevel || ""
    };
    nextBindings[fieldId] = value;

    setClaudeBindingsBusy(true);
    try {
      await fetchJson("/api/claude-code/model-bindings", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          bindings: nextBindings
        })
      });
      await loadState({ preserveDraft: true });
      showNotice("success", "Claude Code model bindings updated.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setClaudeBindingsBusy(false);
    }
  }

  async function handleToggleFactoryDroidRouting() {
    const routingEnabled = factoryDroidState?.routedViaRouter === true;
    const shouldEnable = !routingEnabled;

    if (shouldEnable) {
      if (codingToolDisabledReason) {
        showNotice("warning", codingToolDisabledReason);
        return;
      }
      if (!effectiveMasterKey) {
        showNotice("warning", "Gateway key is still generating. Try again in a second.");
        return;
      }
      if (!ampClientUrl) {
        showNotice("warning", "API endpoint is not ready yet.");
        return;
      }
    }

    setFactoryDroidRoutingBusy(shouldEnable ? "enable" : "disable");
    try {
      await fetchJson("/api/factory-droid/global-route", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          enabled: shouldEnable,
          rawText: shouldEnable ? draftText : undefined,
          endpointUrl: ampClientUrl,
          bindings: shouldEnable ? {
            defaultModel: factoryDroidState?.bindings?.defaultModel || "",
            missionOrchestratorModel: factoryDroidState?.bindings?.missionOrchestratorModel || "",
            missionWorkerModel: factoryDroidState?.bindings?.missionWorkerModel || "",
            missionValidatorModel: factoryDroidState?.bindings?.missionValidatorModel || "",
            reasoningEffort: factoryDroidState?.bindings?.reasoningEffort || ""
          } : undefined
        })
      });
      await loadState({ preserveDraft: !shouldEnable });
      showNotice("success", shouldEnable ? "Factory Droid connected." : "Factory Droid disconnected.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setFactoryDroidRoutingBusy("");
    }
  }

  async function handleFactoryDroidBindingChange(fieldId, value) {
    const nextBindings = {
      defaultModel: factoryDroidState?.bindings?.defaultModel || "",
      missionOrchestratorModel: factoryDroidState?.bindings?.missionOrchestratorModel || "",
      missionWorkerModel: factoryDroidState?.bindings?.missionWorkerModel || "",
      missionValidatorModel: factoryDroidState?.bindings?.missionValidatorModel || "",
      reasoningEffort: factoryDroidState?.bindings?.reasoningEffort || ""
    };
    nextBindings[fieldId] = value;

    setFactoryDroidBindingsBusy(true);
    try {
      await fetchJson("/api/factory-droid/model-bindings", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          bindings: nextBindings
        })
      });
      await loadState({ preserveDraft: true });
      showNotice("success", "Factory Droid model bindings updated.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setFactoryDroidBindingsBusy(false);
    }
  }

  async function runRouterAction(action) {
    setRouterBusy(action);
    try {
      const payload = await fetchJson(`/api/router/${action}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}"
      });
      applySnapshot(payload, { preserveDraft: true });
      showNotice("success", payload.message || `Router ${action}ed.`);
    } catch (error) {
      await loadState({ preserveDraft: true }).catch(() => {});
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setRouterBusy("");
    }
  }

  async function runStartupAction(action) {
    setStartupBusy(action);
    try {
      const payload = await fetchJson(`/api/startup/${action}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}"
      });
      applySnapshot(payload, { preserveDraft: true });
      showNotice("success", payload.message || `Startup ${action}d.`);
    } catch (error) {
      await loadState({ preserveDraft: true }).catch(() => {});
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setStartupBusy("");
    }
  }

  async function handleToggleActivityLog() {
    const nextEnabled = !activityLogEnabled;
    setActivityLogBusy("toggle");
    try {
      const payload = await fetchJson("/api/activity-log/settings", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: nextEnabled })
      });
      applySnapshot(payload, { preserveDraft: true });
      showNotice("success", payload.message || `Activity log ${nextEnabled ? "enabled" : "disabled"}.`);
    } catch (error) {
      await loadState({ preserveDraft: true }).catch(() => {});
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setActivityLogBusy("");
    }
  }

  async function handleClearActivityLog() {
    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm("Clear the shared activity log file? This also clears the Activity tab for connected web console sessions.");
    if (!confirmed) return;

    setActivityLogBusy("clear");
    try {
      const payload = await fetchJson("/api/activity-log/clear", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}"
      });
      applySnapshot(payload, { preserveDraft: true });
      showNotice("success", payload.message || "Activity log cleared.");
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
    } finally {
      setActivityLogBusy("");
    }
  }

  async function handleRemoveProvider(providerId) {
    const provider = providers.find((entry) => entry.id === providerId);
    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm(`Remove provider "${provider?.name || providerId}" from the config?`);
    if (!confirmed) return;

    const nextConfig = removeProviderFromConfig(snapshot?.config?.document || parsedDraftConfig || {}, providerId);
    const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    handleDraftChange(rawText);

    try {
      await saveDraftText(rawText, { successMessage: `Removed provider ${provider?.name || providerId}.` });
    } catch {
    }
  }

  async function handleSaveLocalVariant(variantDraft) {
    if (parsedDraftState.parseError) {
      showNotice("warning", `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`);
      return false;
    }
    if (draftRef.current !== baselineRef.current) {
      showNotice("warning", "Save or discard the current config draft before changing local models.");
      return false;
    }

    try {
      await saveLocalModelVariant(variantDraft);
      await loadState({ preserveDraft: false });
      showNotice("success", `Saved local variant ${String(variantDraft?.name || variantDraft?.id || "").trim() || "draft"}.`);
      return true;
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function handleRefreshLocalModels({ silent = false } = {}) {
    if (parsedDraftState.parseError) {
      if (!silent) showNotice("warning", `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`);
      return false;
    }
    if (draftRef.current !== baselineRef.current) {
      if (!silent) showNotice("warning", "Save or discard the current config draft before changing local models.");
      return false;
    }

    try {
      await reconcileLocalModels();
      await loadState({ preserveDraft: false });
      if (!silent) showNotice("success", "Local model status refreshed.");
      return true;
    } catch (error) {
      if (!silent) showNotice("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function handleAttachLocalModel(request) {
    if (parsedDraftState.parseError) {
      showNotice("warning", `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`);
      return false;
    }
    if (draftRef.current !== baselineRef.current) {
      showNotice("warning", "Save or discard the current config draft before changing local models.");
      return false;
    }

    try {
      await attachLocalModel(request);
      await loadState({ preserveDraft: false });
      showNotice("success", `Attached local model ${String(request?.displayName || request?.id || "").trim() || "draft"}.`);
      return true;
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function handleLocateLocalModel(request) {
    if (parsedDraftState.parseError) {
      showNotice("warning", `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`);
      return false;
    }
    if (draftRef.current !== baselineRef.current) {
      showNotice("warning", "Save or discard the current config draft before changing local models.");
      return false;
    }

    try {
      await locateLocalModel(request);
      await loadState({ preserveDraft: false });
      showNotice("success", "Updated local model path.");
      return true;
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function handleRemoveLocalModel(baseModelId) {
    if (parsedDraftState.parseError) {
      showNotice("warning", `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`);
      return false;
    }
    if (draftRef.current !== baselineRef.current) {
      showNotice("warning", "Save or discard the current config draft before changing local models.");
      return false;
    }

    try {
      await removeLocalModel(baseModelId);
      await loadState({ preserveDraft: false });
      showNotice("success", "Removed local model.");
      return true;
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function handleDownloadManagedLocalModel(request, { onMessage } = {}) {
    if (parsedDraftState.parseError) {
      showNotice("warning", `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`);
      return false;
    }
    if (draftRef.current !== baselineRef.current) {
      showNotice("warning", "Save or discard the current config draft before changing local models.");
      return false;
    }

    try {
      await downloadManagedGguf(request, { onMessage });
      await loadState({ preserveDraft: false });
      showNotice("success", `Downloaded ${String(request?.displayName || request?.file || "").trim() || "managed GGUF"}.`);
      return true;
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  // ── Ollama handlers ──────────────────────────────────────────────
  async function refreshOllamaModels() {
    setOllamaRefreshing(true);
    try {
      const res = await fetch("/api/ollama/models", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = await res.json();
      if (data?.models) setOllamaModels(data.models);
    } catch { /* ignore */ } finally { setOllamaRefreshing(false); }
  }
  useEffect(() => { if (activeTab === "local-models" && ollamaTabConnected) refreshOllamaModels(); }, [activeTab, ollamaTabConnected]);

  function setOllamaBusyKey(model, key, value) {
    setOllamaBusy((prev) => ({ ...prev, [model]: { ...(prev[model] || {}), [key]: value } }));
  }
  async function handleOllamaLoad(model) {
    setOllamaBusyKey(model, "loading", true);
    try { await fetch("/api/ollama/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) }); await refreshOllamaModels(); } finally { setOllamaBusyKey(model, "loading", false); }
  }
  async function handleOllamaUnload(model) {
    setOllamaBusyKey(model, "unloading", true);
    try { await fetch("/api/ollama/unload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) }); await refreshOllamaModels(); } finally { setOllamaBusyKey(model, "unloading", false); }
  }
  async function handleOllamaPin(model, pinned) {
    setOllamaBusyKey(model, "pinning", true);
    try { await fetch("/api/ollama/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, pinned }) }); await refreshOllamaModels(); } finally { setOllamaBusyKey(model, "pinning", false); }
  }
  async function handleOllamaKeepAlive(model, keepAlive) {
    await fetch("/api/ollama/keep-alive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, keepAlive }) });
    await refreshOllamaModels();
  }
  async function handleOllamaContextLength(model, contextLength) {
    await fetch("/api/ollama/context-length", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, contextLength }) });
    await refreshOllamaModels();
  }
  async function handleOllamaAddToRouter(model) {
    await fetch("/api/ollama/add-model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
    await refreshOllamaModels();
  }
  async function handleOllamaRemoveFromRouter(model) {
    await fetch("/api/ollama/remove-model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
    await refreshOllamaModels();
  }
  async function handleOllamaAutoLoad(model, autoLoad) {
    await fetch("/api/ollama/auto-load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, autoLoad }) });
  }
  async function handleOllamaSaveSettings(settings) {
    await fetch("/api/ollama/save-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
  }
  async function handleOllamaInstall() {
    setOllamaBusy((prev) => ({ ...prev, _install: true }));
    try { await fetch("/api/ollama/install", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } finally { setOllamaBusy((prev) => ({ ...prev, _install: false })); }
  }
  async function handleOllamaStartServer() {
    setOllamaBusy((prev) => ({ ...prev, _startServer: true }));
    try { await fetch("/api/ollama/start-server", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } finally { setOllamaBusy((prev) => ({ ...prev, _startServer: false })); }
  }
  async function handleOllamaStopServer() {
    await fetch("/api/ollama/stop-server", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  }
  async function handleOllamaSyncRouter() {
    setOllamaBusy((prev) => ({ ...prev, _syncRouter: true }));
    try { await fetch("/api/ollama/sync-router", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await refreshOllamaModels(); } finally { setOllamaBusy((prev) => ({ ...prev, _syncRouter: false })); }
  }

  if (loading) {
    return (
      <div className="console-shell flex min-h-screen items-center justify-center px-6 py-10">
        <Card className="w-full max-w-lg">
          <CardContent className="space-y-3 p-6 text-center">
            <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">LLM Router</div>
            <div className="text-xl font-semibold text-foreground">Loading web console…</div>
            <div className="text-sm text-muted-foreground">Preparing config state, router controls, and live activity.</div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (showOnboarding) {
    return (
      <div className="console-shell min-h-screen px-4 py-6 md:px-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          <ToastStack notices={notices} onDismiss={dismissNotice} />
          {devModeEnabled ? (
            <DevModeBanner
              currentConfigPath={currentConfigPath}
              productionConfigPath={productionConfigPath}
              routerPort={routerDisplayPort}
              canSyncProductionConfig={canSyncProductionConfig}
              syncBusy={syncProductionBusy}
              onSyncProductionConfig={handleSyncProductionConfig}
            />
          ) : null}
          <div id="quick-start-wizard">
            <QuickStartWizard
              key={`onboarding-wizard-${onboardingSeedMode}-${onboardingTargetProviderId || "new"}`}
              baseConfig={parsedDraftConfig}
              seedMode={onboardingSeedMode}
              mode="onboarding"
              targetProviderId={onboardingTargetProviderId}
              defaultProviderUserAgent={defaultProviderUserAgent}
              onApplyDraft={handleApplyQuickStartDraft}
              onValidateDraft={handleValidateQuickStart}
              onSaveDraft={handleSaveQuickStart}
              onSaveAndStart={handleSaveAndStartQuickStart}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="console-shell min-h-screen px-4 py-4 md:px-6 md:py-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        {devModeEnabled ? (
          <DevModeBanner
            currentConfigPath={currentConfigPath}
            productionConfigPath={productionConfigPath}
            routerPort={routerDisplayPort}
            canSyncProductionConfig={canSyncProductionConfig}
            syncBusy={syncProductionBusy}
            onSyncProductionConfig={handleSyncProductionConfig}
          />
        ) : null}
        <Card className="overflow-hidden">
          <CardContent className="p-5">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h1 className="inline-flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
                    <span>LLM Router Web Console</span>
                    <ConnectedIndicatorDot connected={routerRunning} size="md" srLabel="Router running" />
                    {devModeEnabled ? <Badge variant="warning" className="border-amber-300 bg-amber-100 text-amber-950">Dev Mode</Badge> : null}
                  </h1>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <a
                    href={GITHUB_SPONSORS_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex h-8 items-center gap-2 rounded-lg border border-amber-300 bg-amber-50/90 px-3 text-xs font-medium uppercase tracking-[0.16em] text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-label="Support LLM Router via GitHub Sponsors"
                    title="Support LLM Router"
                  >
                    <HeartIcon className="h-3.5 w-3.5" />
                    <span>Buy me a coffee</span>
                  </a>
                  <a
                    href={GITHUB_REPO_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-background/80 px-3 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-label="Open the LLM Router GitHub repository"
                    title="Open GitHub repository"
                  >
                    <GitHubIcon className="h-3.5 w-3.5" />
                    <span>Repo</span>
                  </a>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={routerRunning ? "outline" : undefined}
                    className="px-2 sm:px-3"
                    onClick={() => runRouterAction(routerRunning ? "stop" : "start")}
                    disabled={routerBusy !== ""}
                    aria-label={routerActionLabel}
                    title={routerActionLabel}
                  >
                    {routerRunning ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">{routerActionLabel}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="px-2 sm:px-3"
                    onClick={handleOpenConfigFileDefault}
                    disabled={openEditorBusy}
                    aria-label={openEditorBusy ? "Opening config file" : "Open config file"}
                    title={openEditorBusy ? "Opening config file" : "Open config file"}
                  >
                    <FolderIcon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{openEditorBusy ? "Opening…" : "Open config file"}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="px-2 sm:px-3"
                    onClick={() => runStartupAction(startupInstalled ? "disable" : "enable")}
                    disabled={startupBusy !== ""}
                    aria-label={startupActionLabel}
                    title={startupActionLabel}
                  >
                    <PowerIcon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{startupActionLabel}</span>
                  </Button>
                </div>
                <HeaderAccessGroup
                  endpointValue={ampClientUrl || LOCAL_ROUTER_ORIGIN}
                  endpointDisabled={!ampClientUrl}
                  gatewayValue={effectiveMasterKey ? maskedMasterKey : "Generating…"}
                  gatewayPending={!effectiveMasterKey}
                  gatewayDisabled={!effectiveMasterKey || saving}
                  rotateDisabled={saving}
                  onCopyEndpoint={handleCopyApiEndpoint}
                  onCopyGatewayKey={handleCopyMasterKey}
                  onRotateKey={handleRotateMasterKey}
                />
              </div>
              {(saving || validating) ? (
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full bg-secondary px-2.5 py-1">{saving ? "Saving changes…" : "Validating…"}</span>
                </div>
              ) : null}
              {!routerRunning && snapshot?.router?.portBusy && !snapshot?.router?.portBusySelf ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => runRouterAction("reclaim")} disabled={routerBusy !== ""}>
                    {routerBusy === "reclaim" ? "Reclaiming…" : `Reclaim port ${routerDisplayPort}`}
                  </Button>
                </div>
              ) : null}
              {routerStatusMessage ? (
                <div className={cn(
                  "rounded-xl border px-3 py-2 text-sm",
                  snapshot?.router?.portBusy
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : "border-rose-200 bg-rose-50 text-rose-800"
                )}>
                  {routerStatusMessage}
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <ToastStack notices={notices} onDismiss={dismissNotice} />

        <div className="space-y-4">
          <ProviderModelsSection
            providers={providers.filter((p) => p?.type !== "ollama")}
            onAddProvider={handleOpenQuickStart}
            onRemove={handleRemoveProvider}
            onCopyModelId={handleCopyProviderModelId}
            onApplyProviderDetails={handleApplyProviderDetails}
            onApplyProviderModels={handleApplyProviderModels}
            onSaveAndCloseEditor={handleSaveProviderEditorChanges}
            disabledReason={providerEditorDisabledReason}
            busy={saving}
          />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-0">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <TabsList>
              <TabsTrigger value="model-alias">Alias &amp; Fallback</TabsTrigger>
              <TabsTrigger value="amp">
                <span className="inline-flex items-center gap-2">
                  <span>AMP</span>
                  <ConnectedIndicatorDot connected={ampTabConnected} srLabel="AMP connected" />
                </span>
              </TabsTrigger>
              <TabsTrigger value="codex-cli">
                <span className="inline-flex items-center gap-2">
                  <span>Codex CLI</span>
                  <ConnectedIndicatorDot connected={codexTabConnected} srLabel="Codex CLI connected" />
                </span>
              </TabsTrigger>
              <TabsTrigger value="claude-code">
                <span className="inline-flex items-center gap-2">
                  <span>Claude Code</span>
                  <ConnectedIndicatorDot connected={claudeTabConnected} srLabel="Claude Code connected" />
                </span>
              </TabsTrigger>
              <TabsTrigger value="factory-droid">
                <span className="inline-flex items-center gap-2">
                  <span>Factory Droid</span>
                  <ConnectedIndicatorDot connected={factoryDroidTabConnected} srLabel="Factory Droid connected" />
                </span>
              </TabsTrigger>
              <TabsTrigger value="local-models">
                <span className="inline-flex items-center gap-2">
                  <span>Local Models</span>
                  <ConnectedIndicatorDot connected={localModelsSummary.runningRuntimes > 0} srLabel="Local runtime connected" />
                </span>
              </TabsTrigger>
              <TabsTrigger value="web-search">Web Search</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="model-alias" className="space-y-4">
            <ModelAliasSection
              aliases={modelAliases}
              config={editableConfig}
              aliasIds={Object.keys(modelAliases)}
              routeOptions={managedRouteOptions}
              defaultModel={String(editableConfig?.defaultModel || "").trim()}
              ampDefaultRoute={ampDefaultRoute}
              disabledReason={providerEditorDisabledReason}
              busy={saving}
              onApplyAlias={handleApplyModelAlias}
              onRemoveAlias={handleRemoveModelAlias}
              onCopyAliasId={handleCopyAliasId}
            />
          </TabsContent>

          <TabsContent value="amp" className="space-y-4">
            <AmpSettingsPanel
              rows={ampRows}
              routeOptions={ampRouteOptions}
              webSearchSnapshot={webSearchSnapshot}
              ampClientUrl={ampClientUrl}
              ampClientGlobal={ampClientGlobal}
              routingBusy={ampRoutingBusy}
              onToggleGlobalRouting={handleToggleAmpGlobalRouting}
              onInboundChange={handleAmpInboundChange}
              onOutboundChange={handleAmpOutboundChange}
              onCreateEntry={handleCreateAmpEntry}
              onRemoveEntry={handleRemoveAmpEntry}
              onOpenWebSearchTab={() => setActiveTab("web-search")}
              onOpenConfigPath={() => handleOpenFilePath(ampClientGlobal?.settingsFilePath, "AMP config file", {
                ensureMode: "jsonObject",
                successMessage: "Opened AMP config file in the default app."
              })}
              onOpenSecretsPath={() => handleOpenFilePath(ampClientGlobal?.secretsFilePath, "AMP secrets file", {
                ensureMode: "jsonObject",
                successMessage: "Opened AMP secrets file in the default app."
              })}
              hasMasterKey={Boolean(String(ampEditableConfig?.masterKey || "").trim())}
              disabledReason={ampDisabledReason}
              autosaveState={ampAutosaveState}
            />
          </TabsContent>

          <TabsContent value="codex-cli" className="space-y-4">
            <CodingToolSettingsPanel
              toolName="Codex CLI"
              toolState={codexCliState}
              endpointUrl={codexCliState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/openai/v1` : ""}`}
              routeOptions={codexRouteOptions}
              connectionBusy={codexRoutingBusy}
              bindingBusy={codexBindingsBusy}
              onToggleRouting={handleToggleCodexCliRouting}
              onBindingChange={handleCodexBindingChange}
              hasMasterKey={Boolean(effectiveMasterKey)}
              disabledReason={codingToolDisabledReason}
              onOpenPrimaryPath={() => handleOpenFilePath(codexCliState?.configFilePath, "Codex CLI config file", {
                ensureMode: "text",
                successMessage: "Opened Codex CLI config file in the default app."
              })}
              onOpenSecondaryPath={() => handleOpenFilePath(codexCliState?.backupFilePath, "Codex CLI backup file", {
                ensureMode: "jsonObject",
                successMessage: "Opened Codex CLI backup file in the default app."
              })}
              guideContent={buildCodexCliGuideContent({
                bindingValue: codexCliState?.bindings?.defaultModel,
                thinkingLevel: codexCliState?.bindings?.thinkingLevel,
                configFilePath: codexCliState?.configFilePath,
                endpointUrl: codexCliState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/openai/v1` : ""}`
              })}
              bindingFields={[
                {
                  id: "defaultModel",
                  label: "Default model",
                  description: "Choose a managed route/alias to set Codex CLI `model`, or use Inherit Codex CLI model to keep Codex built-in model names and route them through same-name LLM Router aliases.",
                  envKey: "model",
                  value: codexCliState?.bindings?.defaultModel || "",
                  allowUnset: false,
                  placeholder: "Select a default route",
                  extraOptions: [{
                    value: CODEX_CLI_INHERIT_MODEL_VALUE,
                    label: "Inherit Codex CLI model",
                    hint: "Keep Codex built-in model names; route them via same-name aliases in LLM Router"
                  }]
                },
                {
                  id: "thinkingLevel",
                  label: "Thinking level",
                  description: "Maps to Codex CLI `model_reasoning_effort`. Official values are `minimal`, `low`, `medium`, `high`, and `xhigh` (`xhigh` is model-dependent).",
                  envKey: "model_reasoning_effort",
                  value: codexCliState?.bindings?.thinkingLevel || "",
                  allowUnset: true,
                  usesRouteOptions: false,
                  placeholder: "Inherit Codex default",
                  options: CODEX_THINKING_LEVEL_OPTIONS
                }
              ]}
            />
          </TabsContent>

          <TabsContent value="claude-code" className="space-y-4">
            <CodingToolSettingsPanel
              toolName="Claude Code"
              toolState={claudeCodeState}
              endpointUrl={claudeCodeState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/anthropic` : ""}`}
              routeOptions={claudeRouteOptions}
              connectionBusy={claudeRoutingBusy}
              bindingBusy={claudeBindingsBusy}
              onToggleRouting={handleToggleClaudeCodeRouting}
              onBindingChange={handleClaudeBindingChange}
              hasMasterKey={Boolean(effectiveMasterKey)}
              disabledReason={codingToolDisabledReason}
              onOpenPrimaryPath={() => handleOpenFilePath(claudeCodeState?.settingsFilePath, "Claude Code config file", {
                ensureMode: "jsonObject",
                successMessage: "Opened Claude Code config file in the default app."
              })}
              onOpenSecondaryPath={() => handleOpenFilePath(claudeCodeState?.backupFilePath, "Claude Code backup file", {
                ensureMode: "jsonObject",
                successMessage: "Opened Claude Code backup file in the default app."
              })}
              guideContent={buildClaudeCodeGuideContent({
                bindings: claudeCodeState?.bindings,
                settingsFilePath: claudeCodeState?.settingsFilePath,
                endpointUrl: claudeCodeState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/anthropic` : ""}`
              })}
              bindingFields={[
                {
                  id: "primaryModel",
                  label: "Current model override",
                  description: "Optional. Set `ANTHROPIC_MODEL` only when you want to override Claude Code’s own `model` setting with a managed route or alias.",
                  envKey: "ANTHROPIC_MODEL",
                  value: claudeCodeState?.bindings?.primaryModel || "",
                  allowUnset: true,
                  placeholder: "Inherit Claude Code default"
                },
                {
                  id: "defaultOpusModel",
                  label: "Default Opus",
                  description: "Maps `ANTHROPIC_DEFAULT_OPUS_MODEL` so Claude Code’s `opus` alias points to a managed route or alias.",
                  envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL",
                  value: claudeCodeState?.bindings?.defaultOpusModel || "",
                  allowUnset: true,
                  placeholder: "Select an Opus route"
                },
                {
                  id: "defaultSonnetModel",
                  label: "Default Sonnet",
                  description: "Maps `ANTHROPIC_DEFAULT_SONNET_MODEL` so Claude Code’s `sonnet` alias points to a managed route or alias.",
                  envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
                  value: claudeCodeState?.bindings?.defaultSonnetModel || "",
                  allowUnset: true,
                  placeholder: "Select a Sonnet route"
                },
                {
                  id: "defaultHaikuModel",
                  label: "Default Haiku",
                  description: "Maps `ANTHROPIC_DEFAULT_HAIKU_MODEL` so Claude Code’s `haiku` alias points to a managed route or alias.",
                  envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                  value: claudeCodeState?.bindings?.defaultHaikuModel || "",
                  allowUnset: true,
                  placeholder: "Select a Haiku route"
                },
                {
                  id: "subagentModel",
                  label: "Sub-agent model",
                  description: "Maps `CLAUDE_CODE_SUBAGENT_MODEL` for Claude Code sub-agents and background workers.",
                  envKey: "CLAUDE_CODE_SUBAGENT_MODEL",
                  value: claudeCodeState?.bindings?.subagentModel || "",
                  allowUnset: true,
                  placeholder: "Select a sub-agent route"
                },
                {
                  id: "webSearchProvider",
                  label: "Search capability",
                  description: "Choose which configured router web-search backend powers Claude Code’s native Anthropic web tools like `web_search_*`. Native `web_fetch_*` page retrieval is intercepted locally by LLM Router and does not use this provider selection.",
                  envKey: "claudeCode.webSearchProvider",
                  value: claudeCodeState?.webSearchProvider || "",
                  allowUnset: true,
                  usesRouteOptions: false,
                  standaloneWhenDisconnected: true,
                  placeholder: "Use default router web-search order",
                  options: claudeWebSearchProviderOptions
                },
                {
                  id: "thinkingLevel",
                  label: "Effort level",
                  description: "Sets `CLAUDE_CODE_EFFORT_LEVEL` in your shell profile (~/.zshrc or ~/.bashrc). Falls back to `effortLevel` in settings.json (only \"high\") if shell profile cannot be updated.",
                  envKey: "CLAUDE_CODE_EFFORT_LEVEL",
                  value: claudeCodeState?.bindings?.thinkingLevel || "",
                  allowUnset: true,
                  usesRouteOptions: false,
                  standaloneWhenDisconnected: true,
                  placeholder: "Inherit Claude Code adaptive default",
                  options: CLAUDE_THINKING_LEVEL_OPTIONS
                }
              ]}
            />
          </TabsContent>

          <TabsContent value="factory-droid" className="space-y-4">
            <CodingToolSettingsPanel
              toolName="Factory Droid"
              toolState={factoryDroidState}
              endpointUrl={factoryDroidState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/openai/v1` : ""}`}
              routeOptions={factoryDroidRouteOptions}
              connectionBusy={factoryDroidRoutingBusy}
              bindingBusy={factoryDroidBindingsBusy}
              onToggleRouting={handleToggleFactoryDroidRouting}
              onBindingChange={handleFactoryDroidBindingChange}
              hasMasterKey={Boolean(effectiveMasterKey)}
              disabledReason={codingToolDisabledReason}
              onOpenPrimaryPath={() => handleOpenFilePath(factoryDroidState?.settingsFilePath, "Factory Droid config file", {
                ensureMode: "jsonObject",
                successMessage: "Opened Factory Droid config file in the default app."
              })}
              onOpenSecondaryPath={() => handleOpenFilePath(factoryDroidState?.backupFilePath, "Factory Droid backup file", {
                ensureMode: "jsonObject",
                successMessage: "Opened Factory Droid backup file in the default app."
              })}
              guideContent={buildFactoryDroidGuideContent({
                bindings: factoryDroidState?.bindings,
                settingsFilePath: factoryDroidState?.settingsFilePath,
                endpointUrl: factoryDroidState?.configuredBaseUrl || `${ampClientUrl ? `${ampClientUrl}/openai/v1` : ""}`
              })}
              bindingFields={[
                {
                  id: "defaultModel",
                  label: "Normal mode model",
                  description: "Choose a managed route or alias for normal Factory sessions. LLM Router writes both the legacy `model` field and current `sessionDefaultSettings.model` default.",
                  envKey: "sessionDefaultSettings.model",
                  value: factoryDroidState?.bindings?.defaultModel || "",
                  allowUnset: true,
                  placeholder: "Select a default route"
                },
                {
                  id: "missionOrchestratorModel",
                  label: "Mission orchestrator",
                  description: "Choose the managed route or alias used for Factory mission orchestration.",
                  envKey: "missionOrchestratorModel",
                  value: factoryDroidState?.bindings?.missionOrchestratorModel || "",
                  allowUnset: true,
                  placeholder: "Use Factory orchestrator default"
                },
                {
                  id: "missionWorkerModel",
                  label: "Mission worker",
                  description: "Choose the managed route or alias used for Factory mission workers.",
                  envKey: "missionModelSettings.workerModel",
                  value: factoryDroidState?.bindings?.missionWorkerModel || "",
                  allowUnset: true,
                  placeholder: "Use Factory worker default"
                },
                {
                  id: "missionValidatorModel",
                  label: "Mission validator",
                  description: "Choose the managed route or alias used for Factory validation workers.",
                  envKey: "missionModelSettings.validationWorkerModel",
                  value: factoryDroidState?.bindings?.missionValidatorModel || "",
                  allowUnset: true,
                  placeholder: "Use Factory validator default"
                },
                {
                  id: "reasoningEffort",
                  label: "Reasoning effort",
                  description: "Maps to Factory Droid `reasoningEffort` setting. Controls the depth of extended thinking for supported models.",
                  envKey: "reasoningEffort",
                  value: factoryDroidState?.bindings?.reasoningEffort || "",
                  allowUnset: true,
                  usesRouteOptions: false,
                  placeholder: "Inherit Factory Droid default",
                  options: FACTORY_DROID_REASONING_EFFORT_OPTIONS
                }
              ]}
            />
          </TabsContent>

          <TabsContent value="local-models" className="space-y-4">
            <LocalModelsPanel
              summary={localModelsSummary}
              llamacpp={{
                runtime: localModelsState.runtime?.llamacpp || {},
                library: Object.fromEntries(
                  Object.entries(localModelsState.library || {}).filter(([, entry]) => String(entry?.source || "").startsWith("llamacpp"))
                ),
                variants: Object.fromEntries(
                  Object.entries(localModelsState.variants || {}).filter(([, variant]) => variant?.runtime === "llamacpp")
                ),
                disableEditsReason: parsedDraftState.parseError
                  ? `Fix the raw JSON parse error first: ${parsedDraftState.parseError}`
                  : (draftRef.current !== baselineRef.current
                    ? "Save or discard the current config draft before changing local models."
                    : ""),
                onSaveVariant: handleSaveLocalVariant,
                onRefreshLibrary: handleRefreshLocalModels,
                onAttachModel: handleAttachLocalModel,
                onLocateModel: handleLocateLocalModel,
                onRemoveModel: handleRemoveLocalModel,
                onDownloadManagedModel: handleDownloadManagedLocalModel
              }}
              ollama={{
                connected: ollamaTabConnected,
                snapshot: ollamaSnapshot,
                models: ollamaModels,
                busy: ollamaBusy,
                refreshing: ollamaRefreshing,
                config: editableConfig,
                onRefresh: refreshOllamaModels,
                onLoad: handleOllamaLoad,
                onUnload: handleOllamaUnload,
                onPin: handleOllamaPin,
                onKeepAlive: handleOllamaKeepAlive,
                onContextLength: handleOllamaContextLength,
                onAddToRouter: handleOllamaAddToRouter,
                onRemoveFromRouter: handleOllamaRemoveFromRouter,
                onAutoLoad: handleOllamaAutoLoad,
                onSaveSettings: handleOllamaSaveSettings,
                onInstall: handleOllamaInstall,
                onStartServer: handleOllamaStartServer,
                onStopServer: handleOllamaStopServer,
                onSyncRouter: handleOllamaSyncRouter
              }}
            />
          </TabsContent>

          <TabsContent value="web-search" className="space-y-4">
            <WebSearchSettingsPanel
              webSearchConfig={webSearchConfig}
              webSearchProviders={webSearchProviders}
              hostedSearchCandidates={hostedSearchCandidates}
              onWebSearchStrategyChange={handleWebSearchStrategyChange}
              onWebSearchProviderChange={handleWebSearchProviderChange}
              onWebSearchProviderMove={handleWebSearchProviderMove}
              onRemoveWebSearchProvider={handleRemoveWebSearchProvider}
              onAddHostedSearchEndpoint={handleAddHostedSearchEndpoint}
              disabledReason={webSearchDisabledReason}
              autosaveState={ampAutosaveState}
            />
          </TabsContent>

          <TabsContent value="activity">
            <LogList
              logs={snapshot?.logs || []}
              activityLogEnabled={activityLogEnabled}
              activityFilter={activityFilter}
              busyAction={activityLogBusy}
              onActivityFilterChange={setActivityFilter}
              onToggleEnabled={handleToggleActivityLog}
              onClear={handleClearActivityLog}
            />
          </TabsContent>
        </Tabs>

        <Modal
          open={showProviderWizardModal}
          onClose={handleHideQuickStart}
          title="Add provider"
          contentClassName="max-h-[92vh] max-w-5xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
          closeOnBackdrop={false}
          bodyClassName="max-h-[calc(92vh-5.5rem)]"
        >
          <QuickStartWizard
            key={`provider-wizard-modal-${providerWizardKey}`}
            baseConfig={parsedDraftConfig}
            seedMode="blank"
            mode="add"
            targetProviderId=""
            defaultProviderUserAgent={defaultProviderUserAgent}
            onApplyDraft={handleApplyQuickStartDraft}
            onValidateDraft={handleValidateQuickStart}
            onSaveDraft={handleSaveQuickStartAndClose}
            onSaveAndStart={handleSaveAndStartQuickStartAndClose}
            framed={false}
            showHeader={false}
          />
        </Modal>
      </div>
    </div>
  );
}
