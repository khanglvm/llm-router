import { useState } from "react";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Card, CardContent } from "./ui/card.jsx";
import { Input } from "./ui/input.jsx";
import { Switch } from "./ui/switch.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "./ui/select.jsx";
import { OLLAMA_KEEP_ALIVE_OPTIONS } from "../constants.js";

export function OllamaSettingsPanel({
  connected, snapshot, models, busy, refreshing, config,
  onRefresh, onLoad, onUnload, onPin, onKeepAlive, onContextLength,
  onAddToRouter, onRemoveFromRouter, onAutoLoad, onSaveSettings,
  onInstall, onStartServer, onStopServer, onSyncRouter
}) {
  const ollamaConfig = config?.ollama || {};
  const [settingsBaseUrl, setSettingsBaseUrl] = useState(ollamaConfig.baseUrl || "http://localhost:11434");
  const [settingsAutoConnect, setSettingsAutoConnect] = useState(ollamaConfig.autoConnect !== false);
  const [settingsDefaultKeepAlive, setSettingsDefaultKeepAlive] = useState(ollamaConfig.defaultKeepAlive || "5m");

  const isInstalled = snapshot?.installed === true;

  return (
    <div className="space-y-4">
      {/* Connection Section */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="font-medium">Ollama Connection</h3>
              {connected ? (
                <Badge variant="success">Connected</Badge>
              ) : (
                <Badge variant="outline">Disconnected</Badge>
              )}
            </div>
            <div className="flex gap-2">
              {!isInstalled && (
                <Button size="sm" onClick={onInstall} disabled={busy._install}>
                  {busy._install ? "Installing…" : "Install Ollama"}
                </Button>
              )}
              {isInstalled && !connected && (
                <Button size="sm" onClick={onStartServer} disabled={busy._startServer}>
                  {busy._startServer ? "Starting…" : "Start Server"}
                </Button>
              )}
              {connected && (
                <Button size="sm" variant="outline" onClick={onStopServer}>Stop Server</Button>
              )}
            </div>
          </div>
          {snapshot?.version && <p className="text-xs text-muted-foreground">Version: {snapshot.version}</p>}
        </CardContent>
      </Card>

      {/* Model List Section */}
      {connected && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Models</h3>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={onSyncRouter} disabled={busy._syncRouter}>
                  {busy._syncRouter ? "Syncing…" : "Sync All to Router"}
                </Button>
                <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
                  {refreshing ? "Refreshing…" : "Reload Models"}
                </Button>
              </div>
            </div>
            {models.length === 0 && !refreshing && (
              <p className="text-sm text-muted-foreground">No models found. Pull models with <code className="text-xs bg-muted px-1 py-0.5 rounded">ollama pull &lt;model&gt;</code></p>
            )}
            <div className="space-y-2">
              {models.map((model) => (
                <OllamaModelRow
                  key={model.name}
                  model={model}
                  busy={busy[model.name] || {}}
                  onLoad={onLoad}
                  onUnload={onUnload}
                  onPin={onPin}
                  onKeepAlive={onKeepAlive}
                  onContextLength={onContextLength}
                  onAddToRouter={onAddToRouter}
                  onRemoveFromRouter={onRemoveFromRouter}
                  onAutoLoad={onAutoLoad}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Settings Section */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-medium">Settings</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Base URL</label>
              <Input
                value={settingsBaseUrl}
                onChange={(e) => setSettingsBaseUrl(e.target.value)}
                placeholder="http://localhost:11434"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Default Keep Alive</label>
              <Select value={settingsDefaultKeepAlive} onValueChange={setSettingsDefaultKeepAlive}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OLLAMA_KEEP_ALIVE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm text-foreground">Auto-connect on startup</label>
            <Switch checked={settingsAutoConnect} onCheckedChange={setSettingsAutoConnect} />
          </div>
          <Button
            size="sm"
            onClick={() => onSaveSettings({ baseUrl: settingsBaseUrl, autoConnect: settingsAutoConnect, defaultKeepAlive: settingsDefaultKeepAlive })}
          >Save Settings</Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function OllamaModelRow({ model, busy, onLoad, onUnload, onPin, onKeepAlive, onContextLength, onAddToRouter, onRemoveFromRouter, onAutoLoad }) {
  const [localContextLength, setLocalContextLength] = useState(model.contextLength || 0);

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm font-medium">{model.name}</span>
          <Badge variant="outline">{model.parameterSize || "?"}</Badge>
          <Badge variant="outline">{model.quantizationLevel || "?"}</Badge>
          {model.loaded ? (
            <Badge variant="success">Loaded{model.sizeVramFormatted ? ` (${model.sizeVramFormatted})` : ""}</Badge>
          ) : (
            <Badge variant="default">Available</Badge>
          )}
          {model.isPinned && <Badge variant="warning">Pinned</Badge>}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {!model.loaded ? (
            <Button size="sm" variant="outline" onClick={() => onLoad(model.name)} disabled={busy.loading}>
              {busy.loading ? "Loading…" : "Load"}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => onUnload(model.name)} disabled={busy.unloading}>
              {busy.unloading ? "Unloading…" : "Unload"}
            </Button>
          )}
          <Button
            size="sm"
            variant={model.isPinned ? "default" : "outline"}
            onClick={() => onPin(model.name, !model.isPinned)}
            disabled={busy.pinning}
            title={model.isPinned ? "Unpin (allow auto-unload)" : "Pin in memory (blocks eviction)"}
          >
            {model.isPinned ? "Unpin" : "Pin"}
          </Button>
          {model.inRouter ? (
            <Button size="sm" variant="outline" onClick={() => onRemoveFromRouter(model.name)} className="text-red-600 hover:text-red-700">Remove from Router</Button>
          ) : (
            <Button size="sm" variant="default" onClick={() => onAddToRouter(model.name)}>Add to Router</Button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4 flex-wrap text-xs">
        <div className="flex items-center gap-1.5">
          <label className="text-muted-foreground whitespace-nowrap">Keep Alive:</label>
          <Select value={model.keepAlive || "5m"} onValueChange={(v) => onKeepAlive(model.name, v)}>
            <SelectTrigger className="h-7 w-[160px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {OLLAMA_KEEP_ALIVE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-muted-foreground whitespace-nowrap">Context:</label>
          <Input
            type="number"
            className="h-7 w-24 text-xs"
            value={localContextLength}
            onChange={(e) => setLocalContextLength(Number(e.target.value))}
            onBlur={() => { if (localContextLength !== model.contextLength) onContextLength(model.name, localContextLength); }}
            min={0}
            step={1024}
          />
          {model.contextLength > 0 && <span className="text-muted-foreground">max: {model.contextLength.toLocaleString()}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={model.autoLoad}
            onCheckedChange={(checked) => onAutoLoad(model.name, checked)}
          />
          <label className="text-muted-foreground">Auto-load on start</label>
        </div>
        {model.estimatedVram && <span className="text-muted-foreground">Est. VRAM: {model.estimatedVram}</span>}
      </div>
    </div>
  );
}
