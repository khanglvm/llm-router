import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.jsx";
import { LocalModelsOverview } from "./local-models-overview.jsx";
import { LlamacppSettingsPanel } from "./llamacpp-settings.jsx";
import { OllamaSettingsPanel } from "./ollama-settings.jsx";

export function LocalModelsPanel({ summary, llamacpp, ollama }) {
  const [activeSection, setActiveSection] = useState("overview");

  return (
    <Tabs value={activeSection} onValueChange={setActiveSection} className="space-y-4">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="llamacpp">llama.cpp</TabsTrigger>
        <TabsTrigger value="ollama">Ollama</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <LocalModelsOverview summary={summary} onOpenSection={setActiveSection} />
      </TabsContent>
      <TabsContent value="llamacpp">
        <LlamacppSettingsPanel {...llamacpp} />
      </TabsContent>
      <TabsContent value="ollama">
        <OllamaSettingsPanel {...ollama} embedded />
      </TabsContent>
    </Tabs>
  );
}
