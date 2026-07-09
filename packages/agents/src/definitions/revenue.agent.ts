import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";
import { scoreOpportunityTool, suggestFollowUpTool } from "../tools/sales-tools";

export const revenueAgent: AgentDefinitionStub = {
  key: "revenue",
  name: "Revenue Agent",
  tools: [scoreOpportunityTool, suggestFollowUpTool],
};
