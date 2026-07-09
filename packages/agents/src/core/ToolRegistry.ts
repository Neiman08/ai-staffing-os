import type { AgentTool } from "./AgentTool";

/**
 * Registro de tools disponibles por agente. Sin implementación en F0.
 */
export interface ToolRegistry {
  register(tool: AgentTool): void;
  get(name: string): AgentTool | undefined;
  list(): AgentTool[];
}
