import type { AgentTool } from "./AgentTool";

export interface AgentDefinitionStub {
  key: string;
  name: string;
  tools: AgentTool[];
}
