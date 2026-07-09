import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";
import { detectHiringSignalsTool, searchCompaniesTool } from "../tools/sales-tools";

export const marketIntelligenceAgent: AgentDefinitionStub = {
  key: "market_intelligence",
  name: "Market Intelligence Agent",
  tools: [searchCompaniesTool, detectHiringSignalsTool],
};
