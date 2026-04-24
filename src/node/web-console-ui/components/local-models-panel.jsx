import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.jsx";
import { LlamacppSettingsPanel } from "./llamacpp-settings.jsx";
import { OllamaSettingsPanel } from "./ollama-settings.jsx";

export function LocalModelsPanel({ summary, llamacpp, ollama }) {
  const [activeSection, setActiveSection] = useState("ollama");

  return (
    <Tabs value={activeSection} onValueChange={setActiveSection} className="space-y-4">
      <TabsList>
        <TabsTrigger value="ollama">Ollama</TabsTrigger>
        <TabsTrigger value="llamacpp">llama.cpp</TabsTrigger>
      </TabsList>
      <TabsContent value="ollama">
        <OllamaSettingsPanel {...ollama} embedded />
      </TabsContent>
      <TabsContent value="llamacpp">
        <LlamacppSettingsPanel {...llamacpp} />
      </TabsContent>
    </Tabs>
  );
}
