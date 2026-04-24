import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.jsx";
import { Input } from "./ui/input.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "./ui/select.jsx";
import { cn } from "../lib/utils.js";
import {
  Field,
  ToggleField,
  CredentialInput,
  InlineSpinner
} from "./shared.jsx";
import {
  slugifyProviderId,
  looksLikeEnvVarName,
  isLikelyHttpEndpoint,
  mergeChipValuesAndDraft,
  resolveRateLimitDraftRows
} from "../utils.js";
import { QUICK_START_CONNECTION_CATEGORIES, QUICK_START_FALLBACK_USER_AGENT } from "../constants.js";
import {
  createQuickStartState,
  applyQuickStartConnectionPreset,
  buildQuickStartConfig,
  buildQuickStartApiSignature,
  getQuickStartStepError,
  headerRowsToObject,
  syncQuickStartAliasModelIds,
  resolveQuickStartSubscriptionProfile,
  hasCompletedProviderSetup,
  getQuickStartConnectionLabel,
  findQuickStartAliasEntry,
  detectPresetHostFromEndpoints,
  buildPresetFreeTierRateLimitRows,
  getQuickStartSuggestedModelIds
} from "../quick-start-utils.js";
import { buildLiteLlmModelContextWindowMap } from "../context-window-utils.js";
import { findPresetByKey, getPresetOptionsByCategory, initPresetModels, presetModelCache } from "../provider-presets.js";
import { DEFAULT_MODEL_ALIAS_ID } from "../../../runtime/config.js";
import { ChipInput } from "./chip-input.jsx";
import { appendRateLimitDraftRow, RateLimitBucketsEditor } from "./rate-limit-editor.jsx";
import { HeaderEditor, AliasTargetEditor } from "./header-editor.jsx";

import {
  fetchJson,
  fetchJsonLineStream,
  probeFreeTierModels,
  lookupLiteLlmContextWindow
} from "../api-client.js";

export function QuickStartWizard({
  baseConfig,
  onApplyDraft,
  onValidateDraft,
  onSaveDraft,
  onSaveAndStart,
  seedMode = "blank",
  mode = "add",
  targetProviderId = "",
  defaultProviderUserAgent = QUICK_START_FALLBACK_USER_AGENT,
  framed = true,
  showHeader = true
}) {

  const [stepIndex, setStepIndex] = useState(0);
  const [busyAction, setBusyAction] = useState("");
  const [quickStart, setQuickStart] = useState(() => createQuickStartState(baseConfig, { seedMode, targetProviderId, defaultProviderUserAgent }));
  const [testedConfig, setTestedConfig] = useState(null);
  const [testError, setTestError] = useState("");
  const [modelTestStates, setModelTestStates] = useState({});
  const [hasAdvancedPastStep1, setHasAdvancedPastStep1] = useState(false);
  const [modelDiscovery, setModelDiscovery] = useState(null);
  const [modelDiscoveryError, setModelDiscoveryError] = useState("");
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [completedOAuthSignature, setCompletedOAuthSignature] = useState("");
  const isFirstTestRef = useRef(true);
  const prevApiSigRef = useRef("");
  const autofillNonceRef = useRef(Math.random().toString(36).slice(2, 10));
  const isEditMode = mode === "edit";
  const isAdditionalProviderFlow = !isEditMode && seedMode === "blank" && hasCompletedProviderSetup(baseConfig);
  const endpointInputName = `llr-qs-endpoint-${autofillNonceRef.current}`;
  const endpointInputId = `llr-qs-endpoint-input-${autofillNonceRef.current}`;
  const credentialInputName = `llr-qs-credential-${autofillNonceRef.current}`;
  const credentialInputId = `llr-qs-credential-input-${autofillNonceRef.current}`;

  const steps = [
    { title: "Provider", detail: "Choose API Key or OAuth first, then enter the provider details needed for that connection type." },
    { title: "Models", detail: "Add model ids, then configure one or more rate limits for all models or selected models. API Key providers are tested before continue." },
    { title: "Default", detail: "Order the models behind the fixed `default` route before you finish." }
  ];

  const modelIds = mergeChipValuesAndDraft(quickStart.modelIds, quickStart.modelDraft);
  const aliasModelIds = syncQuickStartAliasModelIds(quickStart.aliasModelIds, modelIds);
  const endpoints = quickStart.connectionType === "api"
    ? mergeChipValuesAndDraft(quickStart.endpoints, quickStart.endpointDraft)
    : [];
  const resolvedQuickStart = useMemo(() => ({
    ...quickStart,
    endpoints,
    modelIds,
    aliasModelIds,
    rateLimitRows: resolveRateLimitDraftRows(quickStart.rateLimitRows)
  }), [quickStart, endpoints, modelIds, aliasModelIds]);
  const customHeaders = useMemo(() => headerRowsToObject(quickStart.headerRows || []), [quickStart.headerRows]);
  const credentialInput = String(quickStart.apiKeyEnv || "").trim();
  const apiConnectionSignature = useMemo(() => buildQuickStartApiSignature(resolvedQuickStart), [resolvedQuickStart]);
  const activeDiscoveryResult = modelDiscovery?.signature === apiConnectionSignature ? modelDiscovery.result : null;
  const suggestedModelIds = activeDiscoveryResult?.models?.length > 0
    ? activeDiscoveryResult.models
    : getQuickStartSuggestedModelIds(quickStart.selectedConnection || "custom");
  const normalizedProviderId = slugifyProviderId(quickStart.providerId || quickStart.providerName || "my-provider") || "my-provider";
  const resolvedSubscriptionProfile = resolveQuickStartSubscriptionProfile(quickStart);
  const subscriptionLoginSignature = JSON.stringify({
    connectionType: quickStart.connectionType,
    selectedConnection: quickStart.selectedConnection,
    subscriptionProfile: resolvedSubscriptionProfile
  });
  const failedModelIds = modelIds.filter(id => modelTestStates[id] === "error");
  const passedModelIds = modelIds.filter(id => modelTestStates[id] === "success");
  const hasRunTest = modelIds.some(id => modelTestStates[id] === "success" || modelTestStates[id] === "error");
  const allCurrentModelsPass = modelIds.length > 0 && modelIds.every(id => modelTestStates[id] === "success");
  const hasAnyPass = passedModelIds.length > 0;
  const hasAnyFail = failedModelIds.length > 0;
  const hasUntested = modelIds.some(id => !modelTestStates[id] || modelTestStates[id] === "default");
  const activeTestResult = testedConfig?.signature === apiConnectionSignature ? testedConfig.result : null;
  const hasFreshApiTest = quickStart.connectionType !== "api" || hasAnyPass;
  const previewConfig = useMemo(
    () => buildQuickStartConfig(baseConfig, resolvedQuickStart, activeTestResult, { targetProviderId }),
    [baseConfig, resolvedQuickStart, activeTestResult, targetProviderId]
  );
  const previewText = useMemo(() => `${JSON.stringify(previewConfig, null, 2)}
`, [previewConfig]);
  const defaultRoute = DEFAULT_MODEL_ALIAS_ID;
  const activeStep = steps[stepIndex];
  const stepError = getQuickStartStepError(stepIndex, resolvedQuickStart, baseConfig, { targetProviderId });

  useEffect(() => { initPresetModels(); }, []);

  useEffect(() => {
    const apiSigChanged = prevApiSigRef.current !== "" && prevApiSigRef.current !== apiConnectionSignature;
    prevApiSigRef.current = apiConnectionSignature;
    if (apiSigChanged && quickStart.connectionType === "api") {
      setModelTestStates({});
      setTestedConfig(null);
      setTestError("");
      isFirstTestRef.current = true;
      setHasAdvancedPastStep1(false);
    }
    if (quickStart.connectionType !== "api") {
      if (testedConfig !== null) setTestedConfig(null);
      if (testError) setTestError("");
      if (Object.keys(modelTestStates).length > 0) setModelTestStates({});
      if (modelDiscovery !== null) setModelDiscovery(null);
      if (modelDiscoveryError) setModelDiscoveryError("");
      return;
    }
    if (modelDiscovery?.signature && modelDiscovery.signature !== apiConnectionSignature) {
      setModelDiscovery(null);
      setModelDiscoveryError("");
    }
  }, [quickStart.connectionType, apiConnectionSignature, testedConfig, testError, modelTestStates, modelDiscovery, modelDiscoveryError]);

  function updateQuickStart(field, value) {
    setQuickStart((current) => ({ ...current, [field]: value }));
  }

  function handleProviderNameChange(value) {
    setQuickStart((current) => {
      const previousGenerated = slugifyProviderId(current.providerName || "");
      const nextGenerated = slugifyProviderId(value || "") || "my-provider";
      const shouldSyncProviderId = !current.providerId || current.providerId === previousGenerated;
      return {
        ...current,
        providerName: value,
        providerId: shouldSyncProviderId ? nextGenerated : current.providerId
      };
    });
  }

  function handleConnectionChange(nextCategory) {
    setTestError("");
    setTestedConfig(null);
    setModelTestStates({});
    setModelDiscovery(null);
    setModelDiscoveryError("");
    isFirstTestRef.current = true;
    setHasAdvancedPastStep1(false);

    const defaultPresetKey = nextCategory === "api" ? "custom" : "oauth-gpt";
    applyPreset(nextCategory, defaultPresetKey);
  }

  function handlePresetChange(nextPresetKey) {
    setTestError("");
    setTestedConfig(null);
    setModelTestStates({});
    setModelDiscovery(null);
    setModelDiscoveryError("");
    isFirstTestRef.current = true;
    setHasAdvancedPastStep1(false);

    const preset = findPresetByKey(nextPresetKey);
    applyPreset(preset.category, nextPresetKey);
  }

  function applyPreset(nextCategory, nextPresetKey) {
    setQuickStart((current) => applyQuickStartConnectionPreset(current, {
      baseConfig,
      nextCategory,
      nextPresetKey,
      defaultProviderUserAgent
    }));
  }

  async function runModelDiscovery({ force = false, silent = false } = {}) {
    if (quickStart.connectionType !== "api") return false;
    if (endpoints.length === 0 || !credentialInput) {
      if (!silent) {
        setModelDiscoveryError("Add endpoints and an API key or env before checking the model list API.");
      }
      return false;
    }
    if (!force && modelDiscovery?.signature === apiConnectionSignature) {
      return Boolean((modelDiscovery?.result?.models || []).length);
    }

    setDiscoveringModels(true);
    if (!silent) setModelDiscoveryError("");
    try {
      const payload = await fetchJson("/api/config/discover-provider-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoints,
          ...(looksLikeEnvVarName(credentialInput)
            ? { apiKeyEnv: credentialInput }
            : { apiKey: credentialInput }),
          ...(Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {})
        })
      });
      let discoveredModelIds = (payload.result?.models || [])
        .map((modelId) => String(modelId || "").trim())
        .filter(Boolean);
      let discoveredModelContextWindows = {};

      if (discoveredModelIds.length > 0) {
        const activePresetKey = quickStart.selectedConnection;
        if (activePresetKey) presetModelCache.set(activePresetKey, discoveredModelIds);
        const presetHost = detectPresetHostFromEndpoints(endpoints);
        if (presetHost) {
          const freeTierModels = await probeFreeTierModels(
            endpoints[0] || "",
            credentialInput,
            discoveredModelIds.filter((id) => !id.includes("embed") && !id.includes("tts") && !id.includes("image") && !id.includes("lyria") && !id.includes("veo"))
          );
          if (freeTierModels) {
            discoveredModelIds = freeTierModels;
          }
        }
        try {
          const contextResults = await lookupLiteLlmContextWindow(discoveredModelIds);
          discoveredModelContextWindows = buildLiteLlmModelContextWindowMap(contextResults);
        } catch {
          discoveredModelContextWindows = {};
        }
      }

      const nextDiscoveryResult = {
        ...(payload.result && typeof payload.result === "object" ? payload.result : {}),
        modelContextWindows: discoveredModelContextWindows
      };
      setModelDiscovery({ signature: apiConnectionSignature, result: nextDiscoveryResult });

      if (discoveredModelIds.length > 0) {
        setQuickStart((current) => {
          if (buildQuickStartApiSignature(current) !== apiConnectionSignature || current.connectionType !== "api") return current;
          const currentModelIds = Array.isArray(current.modelIds) ? current.modelIds : [];
          const nextModelIds = force && currentModelIds.length > 0
            ? Array.from(new Set([...currentModelIds, ...discoveredModelIds]))
            : currentModelIds.length > 0
              ? currentModelIds
              : discoveredModelIds;
          const nextModelContextWindows = {
            ...(current.modelContextWindows && typeof current.modelContextWindows === "object" ? current.modelContextWindows : {}),
            ...discoveredModelContextWindows
          };
          const presetHost = detectPresetHostFromEndpoints(current.endpoints);
          const presetRateLimitRows = presetHost
            ? buildPresetFreeTierRateLimitRows(presetHost, nextModelIds)
            : null;
          if (
            JSON.stringify(nextModelIds) === JSON.stringify(currentModelIds)
            && JSON.stringify(nextModelContextWindows) === JSON.stringify(current.modelContextWindows || {})
            && !presetRateLimitRows
          ) {
            return current;
          }
          return {
            ...current,
            modelIds: nextModelIds,
            modelContextWindows: nextModelContextWindows,
            ...(presetRateLimitRows ? { rateLimitRows: presetRateLimitRows } : {})
          };
        });
        setModelDiscoveryError("");
        return true;
      }
      const warningMessage = (payload.result?.warnings || []).join(" ") || "Model list API did not return any models. Add model ids manually if needed.";
      setModelDiscoveryError(warningMessage);
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setModelDiscoveryError(message);
      return false;
    } finally {
      setDiscoveringModels(false);
    }
  }

  async function runConfigTest({ onlyModels = null } = {}) {
    if (quickStart.connectionType !== "api") return true;
    const modelsToTest = onlyModels || modelIds;
    setBusyAction("test");
    setTestError("");
    setModelTestStates((current) => {
      const next = { ...current };
      for (const id of modelsToTest) next[id] = "pending";
      return next;
    });
    try {
      const result = await fetchJsonLineStream("/api/config/test-provider-stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoints,
          models: modelsToTest,
          ...(looksLikeEnvVarName(credentialInput)
            ? { apiKeyEnv: credentialInput }
            : { apiKey: credentialInput }),
          ...(Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {})
        })
      }, {
        onMessage: (message) => {
          if (message?.type !== "progress") return;
          const event = message.event || {};
          if (event.phase !== "model-done") return;
          setModelTestStates((current) => ({
            ...current,
            [event.model]: event.confirmed ? "success" : "error"
          }));
        }
      });
      const newConfirmed = new Set(result?.models || []);
      const prevResult = testedConfig?.signature === apiConnectionSignature ? testedConfig.result : null;
      const allConfirmed = new Set(prevResult?.models || []);
      for (const id of modelsToTest) {
        if (newConfirmed.has(id)) allConfirmed.add(id);
        else allConfirmed.delete(id);
      }
      const mergedResult = {
        ...(prevResult || {}),
        ...result,
        models: Array.from(allConfirmed),
        workingFormats: Array.from(new Set([...(prevResult?.workingFormats || []), ...(result?.workingFormats || [])])),
        ok: modelIds.every(id => allConfirmed.has(id))
      };
      setTestedConfig({ signature: apiConnectionSignature, result: mergedResult });
      setModelTestStates((current) => {
        const next = { ...current };
        for (const id of modelsToTest) {
          next[id] = newConfirmed.has(id) ? "success" : "error";
        }
        return next;
      });
      const testedFailures = modelsToTest.filter(id => !newConfirmed.has(id));
      if (testedFailures.length > 0) {
        setTestError((result?.warnings || []).join(" ") || `${testedFailures.length} model(s) failed the provider test.`);
        return false;
      }
      return true;
    } catch (error) {
      setModelTestStates((current) => {
        const next = { ...current };
        for (const id of modelsToTest) {
          if (!next[id] || next[id] === "pending") next[id] = "error";
        }
        return next;
      });
      setTestError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusyAction("");
    }
  }

  useEffect(() => {
    if (stepIndex !== 1 || quickStart.connectionType !== "api") return;
    if (modelIds.length > 0 || !credentialInput || endpoints.length === 0) return;
    if (discoveringModels || modelDiscovery?.signature === apiConnectionSignature) return;
    void runModelDiscovery({ silent: true });
  }, [stepIndex, quickStart.connectionType, modelIds.length, credentialInput, endpoints.length, discoveringModels, modelDiscovery, apiConnectionSignature]);

  async function runSubscriptionLogin({ force = false } = {}) {
    if (quickStart.connectionType === "api") return true;
    if (!force && completedOAuthSignature === subscriptionLoginSignature) return true;

    const activePreset = findPresetByKey(quickStart.selectedConnection || "oauth-gpt");
    setBusyAction("oauth-login");
    setTestError("");
    try {
      await fetchJson("/api/subscription/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId: resolvedSubscriptionProfile,
          providerId: normalizedProviderId,
          subscriptionType: activePreset.subscriptionType || "chatgpt-codex"
        })
      });
      setCompletedOAuthSignature(subscriptionLoginSignature);
      return true;
    } catch (error) {
      setTestError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusyAction("");
    }
  }

  async function handleContinue() {
    if (stepIndex === 0 && quickStart.connectionType === "subscription") {
      const ok = await runSubscriptionLogin();
      if (!ok) return;
    }
    if (stepIndex === 1) setHasAdvancedPastStep1(true);
    setStepIndex((current) => Math.min(current + 1, steps.length - 1));
  }

  async function handleTestClick() {
    const modelsNeedingTest = modelIds.filter(id => modelTestStates[id] !== "success");
    const isFirst = isFirstTestRef.current;
    isFirstTestRef.current = false;
    const allPassed = await runConfigTest({
      onlyModels: modelsNeedingTest.length < modelIds.length ? modelsNeedingTest : null
    });
    if (allPassed && isFirst && !hasAdvancedPastStep1) {
      setHasAdvancedPastStep1(true);
      setStepIndex((s) => Math.min(s + 1, steps.length - 1));
    }
  }

  async function handleTestAgain() {
    const currentFailed = modelIds.filter(id => modelTestStates[id] === "error");
    if (currentFailed.length === 0) return;
    await runConfigTest({ onlyModels: currentFailed });
  }

  function handleSkipFailedAndContinue() {
    const currentFailed = modelIds.filter(id => modelTestStates[id] === "error");
    setQuickStart((current) => ({
      ...current,
      modelIds: (current.modelIds || []).filter(id => !currentFailed.includes(id))
    }));
    setModelTestStates((current) => {
      const next = { ...current };
      for (const id of currentFailed) delete next[id];
      return next;
    });
    setTestError("");
    setHasAdvancedPastStep1(true);
    setStepIndex((s) => Math.min(s + 1, steps.length - 1));
  }

  async function runWizardAction(action) {
    if ((action === "save" || action === "save-start") && quickStart.connectionType === "api" && !hasFreshApiTest) {
      setTestError("Finish is available after the provider test succeeds.");
      return;
    }

    setBusyAction(action);
    try {
      if (action === "apply") {
        await onApplyDraft(previewText);
        return;
      }
      if (action === "validate") {
        await onValidateDraft(previewText);
        return;
      }
      if (action === "save") {
        await onSaveDraft(previewText);
        return;
      }
      if (action === "save-start") {
        await onSaveAndStart(previewText);
      }
    } finally {
      setBusyAction("");
    }
  }

  const footerMessage = testError
    || stepError
    || (stepIndex === 0 && quickStart.connectionType === "subscription" && completedOAuthSignature !== subscriptionLoginSignature
      ? "Continue opens the browser sign-in flow for this provider."
      : stepIndex === 1 && quickStart.connectionType === "api" && !hasRunTest
        ? "Test the provider against the entered endpoints and model ids using your API key or env."
        : stepIndex === 1 && quickStart.connectionType === "api" && hasAnyFail && !allCurrentModelsPass
          ? `${passedModelIds.length} of ${modelIds.length} model(s) confirmed. Fix or skip failed model(s) to continue.`
          : steps[stepIndex].detail);
  const modelHelperText = quickStart.selectedConnection === "oauth-claude"
    ? "Examples: claude-opus-4-6 claude-sonnet-4-6 claude-haiku-4-5"
    : quickStart.selectedConnection === "oauth-gpt"
      ? "Examples: gpt-5.3-codex gpt-5.2-codex gpt-5.1-codex-mini"
      : (
        <>
          <span>
            Examples: gpt-4o-mini gpt-4.1-mini
            {Object.keys(activeDiscoveryResult?.modelContextWindows || {}).length > 0
              ? ` · ${Object.keys(activeDiscoveryResult?.modelContextWindows || {}).length} context size${Object.keys(activeDiscoveryResult?.modelContextWindows || {}).length === 1 ? "" : "s"} ready`
              : ""}
          </span>
          <span className="ml-2 text-amber-700">
            Auto-discovered model ids may be incomplete or inaccurate if the provider is misconfigured. Verify the list and add or remove model ids yourself.
          </span>
        </>
      );
  const headingTitle = isEditMode ? "Edit provider" : isAdditionalProviderFlow ? "Add provider" : "Quick start wizard";
  const headingDescription = isEditMode
    ? "Update this provider in place. Change endpoints, model ids, rate limits, alias, or provider id, then save the refreshed config."
    : isAdditionalProviderFlow
      ? "Add another provider with endpoints, model ids, rate limits, and a stable alias. API Key providers are auto-tested before save."
      : "";
  const stepBar = (
    <div className="flex items-center gap-1">
      {steps.map((step, index) => {
        const isActive = index === stepIndex;
        const isDone = index < stepIndex;
        return (
          <Fragment key={step.title}>
            {index > 0 ? (
              <span className="text-[10px] text-muted-foreground/40 select-none">/</span>
            ) : null}
            <button
              type="button"
              disabled={!isDone}
              onClick={() => { if (isDone) setStepIndex(index); }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : isDone
                    ? "text-emerald-700 hover:bg-emerald-50"
                    : "text-muted-foreground/50"
              )}
            >
              <span className={cn(
                "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none",
                isActive
                  ? "bg-primary-foreground/20"
                  : isDone
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-muted"
              )}>
                {index + 1}
              </span>
              {step.title}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
  const wizardContent = (
    <div className="space-y-5">
      {stepIndex === 0 ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            {QUICK_START_CONNECTION_CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                type="button"
                className={cn(
                  "rounded-2xl border px-4 py-3 text-left transition",
                  quickStart.connectionType === cat.value
                    ? "border-ring bg-background shadow-sm"
                    : "border-border/70 bg-background/70 hover:border-border"
                )}
                onClick={() => handleConnectionChange(cat.value)}
              >
                <div className="text-sm font-medium text-foreground">{cat.label}</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">{cat.description}</div>
              </button>
            ))}
          </div>

          <Field label="Provider preset">
            <Select
              value={quickStart.selectedConnection || (quickStart.connectionType === "api" ? "custom" : "oauth-gpt")}
              onValueChange={handlePresetChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {getPresetOptionsByCategory(quickStart.connectionType === "subscription" ? "subscription" : "api").map((preset) => (
                  <SelectItem key={preset.key} value={preset.key}>
                    {preset.label}
                    <span className="ml-2 text-muted-foreground">{preset.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Provider name">
              <Input
                value={quickStart.providerName}
                onChange={(event) => handleProviderNameChange(event.target.value)}
                placeholder={findPresetByKey(quickStart.selectedConnection || "custom").providerName}
              />
            </Field>
            <Field label="Provider id" hint="lowercase-hyphenated">
              <Input
                value={quickStart.providerId}
                onChange={(event) => updateQuickStart("providerId", event.target.value)}
                onBlur={() => updateQuickStart("providerId", slugifyProviderId(quickStart.providerId || quickStart.providerName || "my-provider") || "my-provider")}
                placeholder={findPresetByKey(quickStart.selectedConnection || "custom").providerId}
              />
            </Field>
          </div>

          {quickStart.connectionType === "api" ? (
            <>
              <Field label="Endpoints" hint="comma, space, or newline turns into chips">
                <ChipInput
                  values={quickStart.endpoints}
                  onChange={(value) => updateQuickStart("endpoints", value)}
                  draftValue={quickStart.endpointDraft}
                  onDraftValueChange={(value) => updateQuickStart("endpointDraft", value)}
                  commitOnBlur
                  isValueValid={isLikelyHttpEndpoint}
                  placeholder="Example: https://api.openai.com/v1"
                  helperText="Paste one or more endpoints"
                  inputProps={{
                    id: endpointInputId,
                    name: endpointInputName,
                    autoComplete: "off",
                    autoCapitalize: "none",
                    autoCorrect: "off",
                    spellCheck: false,
                    inputMode: "url",
                    "data-form-type": "other"
                  }}
                />
              </Field>
              <Field label="API key or env">
                <CredentialInput
                  value={quickStart.apiKeyEnv}
                  onChange={(event) => updateQuickStart("apiKeyEnv", event.target.value)}
                  placeholder="Example: OPENAI_API_KEY or sk-..."
                  isEnvVar={looksLikeEnvVarName(quickStart.apiKeyEnv)}
                  maskMode="obscured-text"
                  inputProps={{
                    id: credentialInputId,
                    name: credentialInputName,
                    autoComplete: "new-password",
                    autoCapitalize: "none",
                    autoCorrect: "off",
                    spellCheck: false,
                    "data-form-type": "other",
                    "data-lpignore": "true",
                    "data-1p-ignore": "true"
                  }}
                />
              </Field>
              <Field label="Custom headers" hint="User-Agent included by default">
                <HeaderEditor
                  rows={quickStart.headerRows}
                  onChange={(value) => updateQuickStart("headerRows", value)}
                />
              </Field>
            </>
          ) : (
            <div className="space-y-3">
              <div className="rounded-2xl border border-border/70 bg-secondary/45 px-4 py-3 text-sm leading-6 text-muted-foreground">
                {quickStart.selectedConnection === "oauth-claude"
                  ? "Continue opens the Claude sign-in page in your browser and stores the login for this provider automatically."
                  : "Continue opens the ChatGPT sign-in page in your browser and stores the login for this provider automatically."}
              </div>
              {quickStart.selectedConnection === "oauth-claude" ? (
                <div className="rounded-2xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 text-xs leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-300">
                  <span className="font-medium">Heads up:</span> Claude Code OAuth routes through Anthropic&apos;s API with your subscription credentials. Usage will count against your Claude Max/Pro plan&apos;s extra usage quota, not the included subscription messages. Make sure you have extra usage enabled on your Claude plan to avoid request failures.
                </div>
              ) : (
                <div className="rounded-2xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 text-xs leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-300">
                  <span className="font-medium">Heads up:</span> ChatGPT subscriptions (Plus / Pro / Team) are separate from the OpenAI API and are intended for use within OpenAI&apos;s own apps. Routing requests through your subscription here may violate OpenAI&apos;s terms of service and could result in account restrictions.
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {stepIndex === 1 ? (
        <div className="space-y-4">
          <Field label="Models" hint="comma, space, or newline turns into chips">
            <ChipInput
              values={quickStart.modelIds}
              onChange={(value) => updateQuickStart("modelIds", value)}
              draftValue={quickStart.modelDraft}
              onDraftValueChange={(value) => updateQuickStart("modelDraft", value)}
              commitOnBlur
              disabled={busyAction === "test"}
              valueStates={quickStart.connectionType === "api" ? modelTestStates : {}}
              placeholder="Paste model ids"
              helperText={modelHelperText}
              suggestedValues={suggestedModelIds}
            />
          </Field>
          {quickStart.connectionType === "api" && discoveringModels ? (
            <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              <div className="flex items-center gap-2 font-medium">
                <InlineSpinner />
                Loading provider models
              </div>
              <div className="mt-1 text-xs leading-5 text-sky-800/90">
                LLM Router is checking the provider model list and matching context sizes for the discovered models.
              </div>
            </div>
          ) : null}
          {quickStart.connectionType === "api" ? (
            <>
              <Field
                label="Rate limit"
                stacked
                headerAction={(
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => updateQuickStart("rateLimitRows", appendRateLimitDraftRow(quickStart.rateLimitRows))}
                    disabled={busyAction === "test"}
                  >
                    Add rate limit
                  </Button>
                )}
              >
                <RateLimitBucketsEditor
                  rows={quickStart.rateLimitRows}
                  onChange={(value) => updateQuickStart("rateLimitRows", value)}
                  availableModelIds={modelIds}
                  disabled={busyAction === "test"}
                />
              </Field>
              <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm leading-6 text-muted-foreground">
                The first model becomes the primary direct route. Add caps for <code>all</code> models or target individual model ids when you need a narrower quota bucket.
              </div>
            </>
          ) : null}
          {quickStart.connectionType === "api" ? (
            <div className={cn(
              "rounded-2xl border px-4 py-3 text-sm leading-6",
              allCurrentModelsPass && hasRunTest
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : hasAnyFail
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : hasAnyPass
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                    : "border-border/70 bg-background/80 text-muted-foreground"
            )}>
              <div className="text-xs font-medium uppercase tracking-[0.16em]">Provider test</div>
              <div className="mt-2">
                {allCurrentModelsPass && hasRunTest
                  ? `Confirmed ${passedModelIds.length} model(s) across ${(activeTestResult?.workingFormats || []).join(", ") || "detected formats"}.`
                  : hasAnyFail
                    ? `${passedModelIds.length} of ${modelIds.length} model(s) confirmed. ${failedModelIds.length} failed: ${failedModelIds.join(", ")}.`
                    : hasAnyPass
                      ? `Confirmed ${passedModelIds.length} of ${modelIds.length} model(s) across ${(activeTestResult?.workingFormats || []).join(", ") || "detected formats"}.`
                      : "Test the provider before continuing so the wizard can auto-detect the working endpoint format(s)."}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {stepIndex === 2 ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            {isAdditionalProviderFlow || isEditMode ? (
              <ToggleField
                label="Use this provider order for the default route"
                hint="Updates the fixed `default` alias"
                checked={quickStart.useAliasAsDefault}
                onCheckedChange={(checked) => updateQuickStart("useAliasAsDefault", checked)}
              />
            ) : (
              <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm text-muted-foreground md:col-span-2">
                The fixed <code>default</code> route is created automatically. Arrange this provider&apos;s models in the order you want clients to try first.
              </div>
            )}
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Model order</div>
            <div className="mt-3">
              <AliasTargetEditor
                providerId={normalizedProviderId}
                values={aliasModelIds}
                onChange={(value) => updateQuickStart("aliasModelIds", value)}
              />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Provider</div>
              <div className="mt-2 text-sm font-medium text-foreground">{normalizedProviderId}</div>
              <div className="mt-1 text-xs text-muted-foreground">{quickStart.providerName}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Connection</div>
              <div className="mt-2 text-sm font-medium text-foreground">{getQuickStartConnectionLabel(quickStart.selectedConnection || "custom")}</div>
              <div className="mt-1 text-xs text-muted-foreground break-all">
                {quickStart.connectionType === "api"
                  ? `${endpoints.length} endpoint candidate(s)`
                  : "Browser sign-in flow"}
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Models</div>
              <div className="mt-2 text-sm font-medium text-foreground">{modelIds.length} configured</div>
              <div className="mt-1 text-xs text-muted-foreground break-all">{modelIds.join(", ") || "No models yet"}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Default route</div>
              <div className="mt-2 text-sm font-medium text-foreground break-all">{defaultRoute}</div>
              <div className="mt-1 text-xs text-muted-foreground">{quickStart.useAliasAsDefault ? "Requests to `default` and `smart` use this ordered list." : "This provider keeps its direct routes only until you opt it into the fixed default route."}</div>
            </div>
          </div>
          {quickStart.connectionType === "api" ? (
            <div className={cn(
              "rounded-2xl border px-4 py-3 text-sm leading-6",
              hasFreshApiTest ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"
            )}>
              <div className="text-xs font-medium uppercase tracking-[0.16em]">Provider test</div>
              <div className="mt-2">
                {hasFreshApiTest
                  ? `Using ${(activeTestResult?.workingFormats || []).join(", ") || "detected formats"}. The saved provider keeps the tested endpoint selection and confirmed models.`
                  : "Finish is available after the provider test succeeds."}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 border-t border-border/70 pt-4 md:flex-row md:items-start md:justify-between md:gap-4">
        <div className={cn("min-w-0 flex-1 text-sm md:max-w-2xl", stepError || testError ? "text-amber-700" : "text-muted-foreground")}>
          {footerMessage}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
          {stepIndex > 0 ? <Button variant="ghost" onClick={() => setStepIndex((current) => Math.max(current - 1, 0))}>Back</Button> : null}
          {stepIndex < steps.length - 1 ? (
            stepIndex === 1 && quickStart.connectionType === "api" ? (
              hasAdvancedPastStep1 ? (
                <>
                  <Button variant="outline" onClick={() => void handleTestClick()} disabled={Boolean(stepError) || busyAction !== ""}>
                    {busyAction === "test" ? <><InlineSpinner />Testing…</> : "Test"}
                  </Button>
                  <Button onClick={() => void handleContinue()} disabled={Boolean(stepError) || busyAction !== "" || !hasAnyPass}>
                    Continue
                  </Button>
                </>
              ) : !hasRunTest || hasUntested ? (
                <Button onClick={() => void handleTestClick()} disabled={Boolean(stepError) || busyAction !== ""}>
                  {busyAction === "test" ? <><InlineSpinner />Testing provider…</> : "Test"}
                </Button>
              ) : allCurrentModelsPass ? (
                <Button onClick={() => void handleContinue()} disabled={Boolean(stepError) || busyAction !== ""}>
                  Continue
                </Button>
              ) : hasAnyFail ? (
                <>
                  <Button variant="outline" onClick={() => void handleTestAgain()} disabled={Boolean(stepError) || busyAction !== ""}>
                    {busyAction === "test" ? <><InlineSpinner />Re-testing…</> : "Test again"}
                  </Button>
                  {hasAnyPass ? (
                    <Button onClick={() => void handleSkipFailedAndContinue()} disabled={busyAction !== ""}>
                      Skip failed model(s) and continue
                    </Button>
                  ) : null}
                </>
              ) : (
                <Button onClick={() => void handleTestClick()} disabled={Boolean(stepError) || busyAction !== ""}>
                  {busyAction === "test" ? <><InlineSpinner />Testing provider…</> : "Test"}
                </Button>
              )
            ) : (
              <Button onClick={() => void handleContinue()} disabled={Boolean(stepError) || busyAction !== ""}>
                {busyAction === "oauth-login" ? (
                  <><InlineSpinner />Signing in…</>
                ) : "Continue"}
              </Button>
            )
          ) : (
            <Button onClick={() => void runWizardAction("save-start")} disabled={Boolean(stepError) || busyAction !== "" || (quickStart.connectionType === "api" && !hasFreshApiTest)}>
              {busyAction === "save-start" ? (
                <><InlineSpinner />Finishing…</>
              ) : "Finish"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  if (!framed) {
    return (
      <div>
        <div className="-mx-5 -mt-4 flex items-center gap-3 border-b border-border/70 bg-muted/30 px-5 py-2">
          {stepBar}
        </div>
        <div className="space-y-5 pt-5">
          {showHeader ? (
            <div>
              <div className="text-base font-semibold text-foreground">{headingTitle}</div>
              <div className="mt-1 text-sm leading-6 text-muted-foreground">{headingDescription}</div>
            </div>
          ) : null}
          {wizardContent}
        </div>
      </div>
    );
  }

  return (
    <Card className="border-dashed">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          {showHeader ? <CardTitle>{headingTitle}</CardTitle> : null}
          {stepBar}
        </div>
        {showHeader ? <CardDescription>{headingDescription}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-5">
        {wizardContent}
      </CardContent>
    </Card>
  );
}
