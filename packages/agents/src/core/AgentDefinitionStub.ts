import type { AgentTool } from "./AgentTool";

export interface AgentDefinitionStub {
  key: string;
  name: string;
  tools: AgentTool[];
  // F2: versionado en código (revisable en PRs), sincronizado al seed.
  // Vacío ("") para agentes que siguen siendo stubs sin LLM real.
  systemPromptTemplate?: string;
}
