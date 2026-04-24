import { useState, useCallback } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs.jsx";
import { Input } from "./ui/input.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.jsx";
import { Button } from "./ui/button.jsx";
import { Badge } from "./ui/badge.jsx";
import { Textarea } from "./ui/textarea.jsx";
import { Field } from "./shared.jsx";
import { FieldMappingEditor } from "./FieldMappingEditor.jsx";
import { JsonPathPicker } from "./JsonPathPicker.jsx";
import { LiveSnapshotPanel } from "./LiveSnapshotPanel.jsx";
import { testQuotaProbe, refreshQuotaProbe, saveQuotaProbeConfig } from "../api-client.js";

/**
 * Build a local draft from the normalized quotaProbe config on a provider.
 * The draft mirrors the config schema shape so it can be sent to the server as-is.
 */
function buildDraft(config) {
  if (!config) return {
    enabled: false,
    capKind: "dollars",
    combinator: "AND",
    enforce: "gate",
    safetyMargin: { dollars: 0, percent: 0 },
    mode: "http",
    http: {
      method: "GET",
      url: "",
      headers: [{ key: "Authorization", value: "Bearer {{providerApiKey}}" }],
      body: null,
      timeoutMs: 5000,
      mapping: {}
    },
    custom: { source: "", timeoutMs: 2000 }
  };
  return {
    enabled: Boolean(config.enabled),
    capKind: config.capKind || "dollars",
    combinator: config.combinator || "AND",
    enforce: config.enforce || "gate",
    safetyMargin: {
      dollars: Number(config.safetyMargin?.dollars) || 0,
      percent: Number(config.safetyMargin?.percent) || 0
    },
    mode: config.mode || "http",
    http: {
      method: config.http?.method || "GET",
      url: config.http?.url || "",
      headers: Array.isArray(config.http?.headers) && config.http.headers.length > 0
        ? config.http.headers.map((h) => ({ key: h.key || "", value: h.value || "" }))
        : [{ key: "Authorization", value: "Bearer {{providerApiKey}}" }],
      body: config.http?.body ?? null,
      timeoutMs: config.http?.timeoutMs || 5000,
      mapping: config.http?.mapping || {}
    },
    custom: {
      source: config.custom?.source || "",
      timeoutMs: config.custom?.timeoutMs || 2000
    }
  };
}

/* ── Headers editor: one compact row per header ────────────────────── */
function HeadersEditor({ headers, onChange }) {
  function updateRow(index, field, value) {
    onChange(headers.map((h, i) => i === index ? { ...h, [field]: value } : h));
  }
  function addRow() { onChange([...headers, { key: "", value: "" }]); }
  function removeRow(index) { onChange(headers.filter((_, i) => i !== index)); }

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Request headers
        <span className="ml-2 normal-case tracking-normal text-[11px] text-muted-foreground/70">
          Use {"{{providerApiKey}}"} to inject the provider's API key.
        </span>
      </div>
      {headers.map((h, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={h.key}
            onChange={(e) => updateRow(i, "key", e.target.value)}
            placeholder="Header name"
            className="h-7 w-40 shrink-0 font-mono text-xs"
          />
          <span className="text-xs text-muted-foreground/50 select-none">:</span>
          <Input
            value={h.value}
            onChange={(e) => updateRow(i, "value", e.target.value)}
            placeholder="Header value"
            className="h-7 flex-1 font-mono text-xs"
          />
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground/60 hover:text-destructive" onClick={() => removeRow(i)}>
            <span className="text-xs">{"\u2715"}</span>
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={addRow}>+ Add header</Button>
    </div>
  );
}

export function QuotaProbeCard({ providerId, probeConfig, snapshot, onSave }) {
  const [draft, setDraft] = useState(() => buildDraft(probeConfig));
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");
  const [liveSnapshot, setLiveSnapshot] = useState(snapshot);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");

  const updateDraft = useCallback((path, value) => {
    setDraft((d) => {
      const parts = path.split(".");
      if (parts.length === 1) return { ...d, [path]: value };
      if (parts.length === 2) return { ...d, [parts[0]]: { ...d[parts[0]], [parts[1]]: value } };
      return d;
    });
  }, []);

  async function handleTest() {
    if (testing) return;
    setTesting(true);
    setTestError("");
    setTestResult(null);
    try {
      const result = await testQuotaProbe(providerId, {
        mode: draft.mode,
        capKind: draft.capKind,
        http: draft.mode === "http" ? draft.http : undefined,
        custom: draft.mode === "custom" ? draft.custom : undefined
      });
      setTestResult(result);
    } catch (err) {
      setTestError(err?.message || "Test failed.");
    } finally {
      setTesting(false);
    }
  }

  async function handleRefresh() {
    try {
      const result = await refreshQuotaProbe(providerId);
      if (result?.snapshot) setLiveSnapshot(result.snapshot);
    } catch { /* non-critical */ }
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setSaveStatus("");
    try {
      const isEnabled = (draft.mode === "http" && draft.http.url.trim() !== "")
        || (draft.mode === "custom" && draft.custom.source.trim() !== "");
      const payload = { ...draft, enabled: isEnabled };
      await saveQuotaProbeConfig(providerId, payload);
      onSave?.(payload);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus(""), 2000);
      // Auto-re-test after save to replace stale test results with fresh snapshot
      const hasUrl = draft.mode === "http" && draft.http.url.trim();
      const hasSource = draft.mode === "custom" && draft.custom.source.trim();
      if (hasUrl || hasSource) {
        try {
          const result = await testQuotaProbe(providerId, {
            mode: draft.mode,
            capKind: draft.capKind,
            http: draft.mode === "http" ? draft.http : undefined,
            custom: draft.mode === "custom" ? draft.custom : undefined
          });
          setTestResult(result);
          setTestError("");
        } catch { /* non-critical — stale result stays */ }
      }
    } catch (err) {
      setSaveStatus(err?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <LiveSnapshotPanel snapshot={liveSnapshot} circuitOpen={false} onRefresh={handleRefresh} />

      <Tabs value={draft.mode} onValueChange={(v) => updateDraft("mode", v)}>
        <TabsList>
          <TabsTrigger value="http">Simple mapping</TabsTrigger>
          <TabsTrigger value="custom">Custom function</TabsTrigger>
        </TabsList>

        <TabsContent value="http" className="space-y-4 pt-2">
          {/* Method + URL — single row, method narrow */}
          <div className="space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Endpoint
              <span className="ml-2 normal-case tracking-normal text-[11px] text-muted-foreground/70">
                The provider's usage or billing endpoint.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Select value={draft.http.method} onValueChange={(v) => updateDraft("http.method", v)}>
                <SelectTrigger className="h-9 w-24 shrink-0"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={draft.http.url}
                onChange={(e) => updateDraft("http.url", e.target.value)}
                placeholder="https://open-claude.com/v1/usage"
                className="h-9 flex-1 font-mono text-xs"
              />
              <Button type="button" variant="outline" className="h-9 shrink-0" onClick={handleTest} disabled={testing || !draft.http.url}>
                {testing ? "Testing\u2026" : "Test"}
              </Button>
              {testResult?.latencyMs != null ? <Badge variant="outline" className="shrink-0">{testResult.latencyMs}ms</Badge> : null}
            </div>
          </div>

          {/* Headers */}
          <HeadersEditor
            headers={draft.http.headers}
            onChange={(headers) => setDraft((d) => ({ ...d, http: { ...d.http, headers } }))}
          />

          {/* Pre-test hint */}
          {!testResult && !testError ? (
            <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              Hit <strong>Test</strong> to fetch the endpoint. The JSON response will appear below — click any row to map it to a snapshot field.
            </div>
          ) : null}

          {/* Test error from fetch failure (network, CORS, etc.) */}
          {testError ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-900/30 dark:bg-rose-950/30 dark:text-rose-300">{testError}</div>
          ) : null}

          {/* After test: show probe error if any */}
          {testResult?.snapshot?.state === "errored" ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/30 dark:bg-amber-950/30 dark:text-amber-300">
              <strong>Probe returned an error:</strong> {testResult.snapshot.error?.message || "Unknown error"}
              {testResult.raw ? " \u2014 see the response body below." : " \u2014 the endpoint did not return a JSON body."}
            </div>
          ) : null}

          {/* After test: response JSON viewer (shows on success OR error with body) */}
          {testResult?.raw ? (
            <JsonPathPicker
              raw={testResult.raw}
              mapping={draft.http.mapping}
              onAssign={(fieldKey, jsonPath) => {
                setDraft((d) => ({
                  ...d,
                  http: {
                    ...d.http,
                    mapping: {
                      ...d.http.mapping,
                      [fieldKey]: { ...(d.http.mapping[fieldKey] || {}), path: jsonPath }
                    }
                  }
                }));
              }}
            />
          ) : null}

          {/* Field mapping editor — always show after any test so user can configure paths */}
          {testResult ? (
            <FieldMappingEditor
              mapping={draft.http.mapping}
              testResult={testResult.snapshot}
              rawResponse={testResult.raw}
              onChange={(m) => setDraft((d) => ({ ...d, http: { ...d.http, mapping: m } }))}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="custom" className="space-y-4 pt-2">
          <Field label="Custom function" hint="Define async function fetchUsage(ctx) returning { used, limit, remaining, resetAt, isUnlimited }. ctx provides fetch, providerApiKey, providerBaseUrl, providerId." stacked>
            <Textarea
              value={draft.custom.source}
              onChange={(e) => updateDraft("custom.source", e.target.value)}
              placeholder={`async function fetchUsage(ctx) {\n  const res = await ctx.fetch("https://open-claude.com/v1/usage", {\n    headers: { Authorization: \`Bearer \${ctx.providerApiKey}\` }\n  });\n  const json = await res.json();\n  return { capKind: "dollars", used: json.quota.used_dollars, limit: json.quota.limit_dollars };\n}`}
              className="min-h-40 font-mono text-xs"
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={handleTest} disabled={testing || !draft.custom.source}>
              {testing ? "Testing\u2026" : "Test"}
            </Button>
            {testResult?.latencyMs != null ? <Badge variant="outline">{testResult.latencyMs}ms</Badge> : null}
          </div>
          {testError ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-900/30 dark:bg-rose-950/30 dark:text-rose-300">{testError}</div>
          ) : null}
        </TabsContent>
      </Tabs>

      {/* Cap configuration */}
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Cap kind" hint="Unit the provider reports usage in." stacked>
          <Select value={draft.capKind} onValueChange={(v) => updateDraft("capKind", v)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="dollars">Dollars</SelectItem>
              <SelectItem value="tokens">Tokens</SelectItem>
              <SelectItem value="requests">Requests</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Enforce" hint="Gate blocks routing; observe logs only." stacked>
          <Select value={draft.enforce} onValueChange={(v) => updateDraft("enforce", v)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="gate">Gate routing</SelectItem>
              <SelectItem value="observe">Observability only</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Combinator" hint="How probe combines with local rate limits." stacked>
          <Select value={draft.combinator} onValueChange={(v) => updateDraft("combinator", v)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="AND">AND (both must allow)</SelectItem>
              <SelectItem value="OR">OR (either allows)</SelectItem>
              <SelectItem value="REPLACE">REPLACE (probe only)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      {/* Safety margin */}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Safety margin (dollars)" hint="Gate when remaining drops below this amount." stacked>
          <Input
            type="number" min="0" step="0.01"
            value={draft.safetyMargin.dollars}
            onChange={(e) => updateDraft("safetyMargin.dollars", Number(e.target.value) || 0)}
          />
        </Field>
        <Field label="Safety margin (%)" hint="Gate below this % of limit. Larger margin wins." stacked>
          <Input
            type="number" min="0" max="100" step="1"
            value={draft.safetyMargin.percent}
            onChange={(e) => updateDraft("safetyMargin.percent", Number(e.target.value) || 0)}
          />
        </Field>
      </div>

      <div className="flex items-center justify-end gap-2">
        {saveStatus === "saved" ? <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved</span> : null}
        {saveStatus && saveStatus !== "saved" ? <span className="text-xs text-rose-600 dark:text-rose-400">{saveStatus}</span> : null}
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? "Saving\u2026" : "Save probe config"}
        </Button>
      </div>
    </div>
  );
}
