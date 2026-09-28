import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";

// The real Pi TUI uses this local scripted provider; it never makes a network request.
export default function register(pi: ExtensionAPI) {
  const faux = createFauxCore({ api: "usage-e2e-faux", provider: "usage-e2e", models: [{ id: "scripted", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  faux.setResponses([fauxAssistantMessage("SETTLED-USAGE-E2E-7F3A")]);
  pi.registerProvider("usage-e2e", {
    api: faux.api,
    baseUrl: "http://localhost:0",
    apiKey: "scripted-only",
    models: [{ id: "scripted", name: "Scripted local model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple: faux.streamSimple,
  });
}
