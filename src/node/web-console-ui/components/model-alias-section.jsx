import { useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader } from "./ui/card.jsx";
import { Modal } from "./shared.jsx";
import { createPendingAliasSeed } from "../utils.js";
import { ModelAliasCard } from "./model-alias-card.jsx";
import { ModelAliasStrategyModal, AliasGuideModal } from "./alias-modals.jsx";

export function ModelAliasSection({
  aliases,
  config,
  aliasIds,
  routeOptions,
  defaultModel,
  ampDefaultRoute,
  disabledReason = "",
  busy = false,
  onApplyAlias,
  onRemoveAlias,
  onCopyAliasId
}) {
  const aliasEntries = Object.entries(aliases || {});
  const disabled = Boolean(disabledReason);
  const [pendingNewAliasKey, setPendingNewAliasKey] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectedAliasId, setSelectedAliasId] = useState("");
  const pendingAliasSeed = useMemo(() => createPendingAliasSeed(), []);
  const [strategyModalState, setStrategyModalState] = useState({
    open: false,
    aliasLabel: "",
    strategy: "auto",
    entries: [],
    disabled: false,
    onSave: null
  });

  function handleCreateNewAlias() {
    if (disabled || busy) return;
    setPendingNewAliasKey(`draft-${Date.now()}`);
  }

  function handleDiscardNewAlias(key) {
    if (!key || key === pendingNewAliasKey) {
      setPendingNewAliasKey("");
    }
  }

  function handleCloseCreateAliasModal() {
    setPendingNewAliasKey("");
  }

  function handleOpenStrategyModal({ aliasLabel = "", strategy = "auto", entries = [], disabled: strategyDisabled = false, onSave = null }) {
    setStrategyModalState({
      open: true,
      aliasLabel,
      strategy,
      entries,
      disabled: strategyDisabled,
      onSave
    });
  }

  function handleCloseStrategyModal() {
    setStrategyModalState((current) => ({
      ...current,
      open: false
    }));
  }

  async function handleApplyAliasDraft(aliasId, draftAlias, options = {}) {
    const result = await onApplyAlias(aliasId, draftAlias, options);
    if (result) {
      const nextAliasId = String(draftAlias?.id || aliasId || "").trim() || aliasId;
      setSelectedAliasId(nextAliasId);
    }
    return result;
  }

  useEffect(() => {
    const availableAliasIds = aliasEntries.map(([aliasId]) => aliasId);
    if (availableAliasIds.length === 0) {
      if (selectedAliasId) setSelectedAliasId("");
      return;
    }
    if (!selectedAliasId || !availableAliasIds.includes(selectedAliasId)) {
      setSelectedAliasId(availableAliasIds[0]);
    }
  }, [aliasEntries, selectedAliasId]);

  const activeAliasEntry = aliasEntries.find(([aliasId]) => aliasId === selectedAliasId) || aliasEntries[0] || null;
  const activeAliasId = activeAliasEntry?.[0] || "";
  const activeAlias = activeAliasEntry?.[1] || null;
  const activeAliasSwitcher = aliasEntries.length > 1
    ? {
      value: activeAliasId,
      onValueChange: setSelectedAliasId,
      entries: aliasEntries
    }
    : null;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardDescription>Model aliases give clients one stable route across multiple provider/models, so you can swap, balance, and fail over without changing client config.</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setHelpOpen(true)}>
                Help
              </Button>
              <Button type="button" size="sm" onClick={handleCreateNewAlias} disabled={disabled || busy}>
                {busy ? "Saving…" : "Add alias"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {disabled ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{disabledReason}</div> : null}

          {aliasEntries.length > 0 ? (
            activeAliasId && activeAlias ? (
              <ModelAliasCard
                key={activeAliasId}
                aliasId={activeAliasId}
                alias={activeAlias}
                aliasIds={aliasIds}
                routeOptions={routeOptions}
                defaultModel={defaultModel}
                ampDefaultRoute={ampDefaultRoute}
                disabled={disabled}
                disabledReason={disabledReason}
                busy={busy}
                onApply={handleApplyAliasDraft}
                onRemove={onRemoveAlias}
                onCopyAliasId={onCopyAliasId}
                onOpenStrategyModal={handleOpenStrategyModal}
                aliasSwitcher={activeAliasSwitcher}
                framed={false}
              />
            ) : null
          ) : (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">No model aliases yet. Add one to expose stable routes like <code>coding</code> or <code>chat.fast</code> in the Web UI.</div>
          )}
        </CardContent>
      </Card>

      <Modal
        open={Boolean(pendingNewAliasKey)}
        onClose={handleCloseCreateAliasModal}
        title="Add alias"
        description="Set a stable client-facing route, choose its strategy, and order the targets it should use."
        showCloseButton={false}
        contentClassName="max-h-[92vh] max-w-5xl rounded-2xl border border-border/70 bg-background/98 shadow-[0_32px_120px_rgba(15,23,42,0.48)]"
        bodyClassName="max-h-[calc(92vh-5.5rem)]"
      >
        {pendingNewAliasKey ? (
          <ModelAliasCard
            key={pendingNewAliasKey}
            aliasId={pendingNewAliasKey}
            alias={pendingAliasSeed}
            aliasIds={aliasIds}
            routeOptions={routeOptions}
            defaultModel={defaultModel}
            ampDefaultRoute={ampDefaultRoute}
            disabled={disabled}
            disabledReason={disabledReason}
            busy={busy}
            onApply={handleApplyAliasDraft}
            onRemove={onRemoveAlias}
            onCopyAliasId={onCopyAliasId}
            isNew
            alwaysShowAliasIdInput
            showIssueOnSubmitOnly
            onDiscard={handleDiscardNewAlias}
            onOpenStrategyModal={handleOpenStrategyModal}
            framed={false}
          />
        ) : null}
      </Modal>

      <ModelAliasStrategyModal
        open={strategyModalState.open}
        onClose={handleCloseStrategyModal}
        onSave={(strategy) => strategyModalState.onSave?.(strategy)}
        aliasLabel={strategyModalState.aliasLabel}
        initialStrategy={strategyModalState.strategy}
        entries={strategyModalState.entries}
        disabled={strategyModalState.disabled}
      />

      <AliasGuideModal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        config={config}
      />
    </>
  );
}
