import { useEffect, useState } from "react";
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
import { Field, Modal, CredentialInput, TransientIntegerInput, MoveUpButton, MoveDownButton, ProviderStatusDot } from "./shared.jsx";
import { formatTime } from "../utils.js";
import { AMP_WEB_SEARCH_STRATEGY_OPTIONS } from "../constants.js";
import { buildHostedWebSearchProviderId } from "../web-search-utils.js";

function PlusIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 3.5v9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function HostedWebSearchEndpointModal({
  open = false,
  onClose = () => {},
  candidates = [],
  onTestAndAdd = async () => {},
  disabledReason = ""
}) {
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState("");
  const providerOptions = Array.isArray(candidates) ? candidates : [];
  const selectedProvider = providerOptions.find((provider) => provider.providerId === selectedProviderId) || providerOptions[0] || null;
  const modelOptions = Array.isArray(selectedProvider?.models) ? selectedProvider.models : [];

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setIssue("");
      return;
    }

    const defaultProviderId = providerOptions[0]?.providerId || "";
    setSelectedProviderId((current) => {
      const currentExists = providerOptions.some((provider) => provider.providerId === current);
      return currentExists ? current : defaultProviderId;
    });
  }, [open, providerOptions]);

  useEffect(() => {
    const nextModelId = modelOptions[0]?.value || "";
    setSelectedModelId((current) => {
      const currentExists = modelOptions.some((model) => model.value === current);
      return currentExists ? current : nextModelId;
    });
  }, [modelOptions]);

  const routeId = buildHostedWebSearchProviderId(selectedProviderId, selectedModelId);
  const canSubmit = open && !busy && !disabledReason && selectedProviderId && selectedModelId;

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setIssue("");
    try {
      await onTestAndAdd({
        providerId: selectedProviderId,
        modelId: selectedModelId
      });
      onClose();
    } catch (error) {
      setIssue(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      title="Add ChatGPT Search Endpoint"
      description="Choose a configured OpenAI-compatible GPT route. Test runs a live Responses API request with the native web search tool, then saves the route on success."
      contentClassName="max-h-[92vh] max-w-3xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
      showCloseButton={false}
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {busy ? "Testing…" : "Test connection"}
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        {disabledReason ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {disabledReason}
          </div>
        ) : null}

        {!disabledReason && providerOptions.length === 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            No configured OpenAI-compatible GPT providers are available yet. Add a provider with a GPT model first.
          </div>
        ) : null}

        {providerOptions.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Provider" hint="Configured provider or ChatGPT subscription" stacked>
              <Select value={selectedProviderId || undefined} onValueChange={setSelectedProviderId} disabled={busy || Boolean(disabledReason)}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose provider" />
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((provider) => (
                    <SelectItem key={provider.providerId} value={provider.providerId}>
                      {provider.providerLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="GPT model" hint="Only GPT models on OpenAI-compatible routes are listed" stacked>
              <Select value={selectedModelId || undefined} onValueChange={setSelectedModelId} disabled={busy || Boolean(disabledReason) || modelOptions.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose model" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((model) => (
                    <SelectItem key={model.routeId} value={model.value}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        ) : null}

        {routeId ? (
          <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Saved route id</div>
            <div className="mt-1 text-sm font-medium text-foreground">{routeId}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">This route stores only the provider/model reference. No separate API key or quota is saved here.</div>
          </div>
        ) : null}

        {issue ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {issue}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function WebSearchSettingsPanel({
  webSearchConfig,
  webSearchProviders,
  hostedSearchCandidates,
  onWebSearchStrategyChange,
  onWebSearchProviderChange,
  onWebSearchProviderMove,
  onRemoveWebSearchProvider,
  onAddHostedSearchEndpoint,
  disabledReason,
  autosaveState
}) {
  const [hostedSearchModalOpen, setHostedSearchModalOpen] = useState(false);
  const searchStrategy = String(webSearchConfig?.strategy || "ordered").trim() === "quota-balance" ? "quota-balance" : "ordered";
  const canAddHostedSearchEndpoint = Array.isArray(hostedSearchCandidates) && hostedSearchCandidates.some((provider) => Array.isArray(provider?.models) && provider.models.length > 0);
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
        : "";

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-4 p-4 pb-0 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-1">
            <CardTitle>Web Search</CardTitle>
            <CardDescription className="text-xs leading-5">
              Shared web search routing for AMP and other router-managed tools.
            </CardDescription>
            {statusMessage ? <div className="text-xs text-muted-foreground">{statusMessage}</div> : null}
          </div>

          <div className="flex w-full shrink-0 flex-wrap items-end justify-end gap-3 xl:w-auto">
            <div className="min-w-[12rem] space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Routing strategy</div>
              <Select value={searchStrategy} onValueChange={onWebSearchStrategyChange} disabled={Boolean(disabledReason)}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose strategy" />
                </SelectTrigger>
                <SelectContent>
                  {AMP_WEB_SEARCH_STRATEGY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => setHostedSearchModalOpen(true)}
              disabled={Boolean(disabledReason) || !canAddHostedSearchEndpoint}
            >
              <PlusIcon className="h-3.5 w-3.5" />
              <span>Endpoint</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-4">
          <div className="space-y-3">
            {(webSearchProviders || []).map((provider) => {
              if (provider.kind === "hosted") {
                const runtimeIssue = provider.runtimeState && provider.runtimeState.ready === false
                  ? "This provider/model route is no longer available or is not OpenAI-compatible."
                  : "";
                return (
                  <div key={provider.key} className="rounded-2xl border border-border/70 bg-background/80 p-4">
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <ProviderStatusDot active={provider.active} />
                            <div className="text-sm font-medium text-foreground">{provider.label}</div>
                            <Badge variant="outline">GPT Search</Badge>
                          </div>
                          <div className="mt-1 text-xs break-all text-muted-foreground">{provider.routeId}</div>
                          <div className="mt-2 text-xs leading-5 text-muted-foreground">Uses the provider&apos;s native OpenAI Responses web search tool. No local API key or quota is stored here.</div>
                        </div>
                        <div className="flex items-center gap-2 self-start">
                          <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/70 p-1">
                            <MoveUpButton
                              disabled={Boolean(disabledReason) || provider.displayIndex <= 0}
                              label={`Move ${provider.routeId} up`}
                              onClick={() => onWebSearchProviderMove(provider.id, "up")}
                            />
                            <MoveDownButton
                              disabled={Boolean(disabledReason) || provider.displayIndex >= provider.displayCount - 1}
                              label={`Move ${provider.routeId} down`}
                              onClick={() => onWebSearchProviderMove(provider.id, "down")}
                            />
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => onRemoveWebSearchProvider(provider.id)}
                            disabled={Boolean(disabledReason)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>

                      {runtimeIssue ? (
                        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                          {runtimeIssue}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              }

              const credentialField = provider.credentialField;
              const credentialValue = String(provider?.credentialValue || "").trim();
              return (
                <div key={provider.key} className="rounded-2xl border border-border/70 bg-background/80 p-4">
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <ProviderStatusDot active={provider.active} />
                          <div className="text-sm font-medium text-foreground">{provider.label}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-start rounded-xl border border-border/70 bg-background/70 p-1">
                        <MoveUpButton
                          disabled={Boolean(disabledReason) || provider.displayIndex <= 0}
                          label={`Move ${provider.label} up`}
                          onClick={() => onWebSearchProviderMove(provider.id, "up")}
                        />
                        <MoveDownButton
                          disabled={Boolean(disabledReason) || provider.displayIndex >= provider.displayCount - 1}
                          label={`Move ${provider.label} down`}
                          onClick={() => onWebSearchProviderMove(provider.id, "down")}
                        />
                      </div>
                    </div>

                    <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.35fr)]">
                      <Field
                        label={provider.credentialLabel}
                        hint={provider.credentialField === "url" ? "Required to enable this backend." : "Required to enable this backend. Stored in router config."}
                        stacked
                        className="gap-1"
                        headerClassName="min-h-0"
                        hintClassName="leading-4"
                      >
                        <CredentialInput
                          buffered
                          value={credentialValue}
                          placeholder={provider.credentialPlaceholder}
                          onValueChange={(value) => onWebSearchProviderChange(provider.id, credentialField, value)}
                          disabled={Boolean(disabledReason)}
                          isEnvVar={provider.credentialField === "url"}
                        />
                      </Field>

                      <div className="grid gap-3 sm:grid-cols-3">
                        <Field
                          label="Result per call"
                          hint="Empty keeps the default of 5."
                          stacked
                          className="gap-1"
                          headerClassName="min-h-0"
                          hintClassName="leading-4"
                        >
                          <TransientIntegerInput
                            value={provider.resultPerCallInput}
                            placeholder="Default: 5"
                            allowEmptyCommit
                            onValueChange={(value) => onWebSearchProviderChange(provider.id, "count", value)}
                            disabled={Boolean(disabledReason)}
                          />
                        </Field>

                        <Field
                          label="Monthly limit"
                          hint="0 keeps quotas self-managed."
                          stacked
                          className="gap-1"
                          headerClassName="min-h-0"
                          hintClassName="leading-4"
                        >
                          <TransientIntegerInput
                            value={String(provider.limit || 0)}
                            onValueChange={(value) => onWebSearchProviderChange(provider.id, "limit", value)}
                            disabled={Boolean(disabledReason)}
                          />
                        </Field>

                        <Field
                          label="Synced remaining"
                          hint="Adjust after manual upstream sync."
                          stacked
                          className="gap-1"
                          headerClassName="min-h-0"
                          hintClassName="leading-4"
                        >
                          <TransientIntegerInput
                            value={String(provider.remaining || 0)}
                            onValueChange={(value) => onWebSearchProviderChange(provider.id, "remaining", value)}
                            disabled={Boolean(disabledReason)}
                          />
                        </Field>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <HostedWebSearchEndpointModal
        open={hostedSearchModalOpen}
        onClose={() => setHostedSearchModalOpen(false)}
        candidates={hostedSearchCandidates}
        onTestAndAdd={onAddHostedSearchEndpoint}
        disabledReason={disabledReason}
      />
    </>
  );
}
