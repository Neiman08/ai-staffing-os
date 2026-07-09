import type { AgentTool } from "./AgentTool";
import type { ToolRegistry } from "./ToolRegistry";

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }
}
