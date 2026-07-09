import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";
import { createLeadTool, draftOutreachTool, identifyContactsTool, suggestFollowUpTool } from "../tools/sales-tools";

export const salesAgent: AgentDefinitionStub = {
  key: "sales",
  name: "Sales Agent",
  tools: [createLeadTool, identifyContactsTool, draftOutreachTool, suggestFollowUpTool],
};
