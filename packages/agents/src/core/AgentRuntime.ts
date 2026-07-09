import type { AgentContext } from "./AgentContext";
import type { ToolRegistry } from "./ToolRegistry";

export class NotImplementedError extends Error {
  constructor(phase: string) {
    super(`AgentRuntime.run() is not implemented until ${phase}`);
    this.name = "NotImplementedError";
  }
}

export class UnknownToolError extends Error {
  constructor(toolName: string) {
    super(`No tool registered with name "${toolName}"`);
    this.name = "UnknownToolError";
  }
}

export interface AgentRunInput {
  toolName: string;
  toolInput: unknown;
}

/**
 * F2: primera implementación real. Cada AgentTask ya llega con un `type`
 * que mapea 1:1 a un tool (ver packages/shared agentTaskTypeSchema) — el
 * humano o el trigger elige la acción, no el modelo. Esto es una versión
 * acotada del "loop ReAct" de Architecture §6.1: un solo tool call
 * determinístico por tarea, no un planificador multi-turno que elige entre
 * tools. Es la opción más segura y auditable para el primer agente con LLM
 * real (F2 regla: "toda recomendación debe explicar por qué"); un
 * planificador libre queda para cuando haya más de un agente con
 * autonomía real que lo justifique.
 */
export class AgentRuntime {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  async run(_context: AgentContext, input: AgentRunInput): Promise<unknown> {
    const tool = this.toolRegistry.get(input.toolName);
    if (!tool) throw new UnknownToolError(input.toolName);

    const parsedInput = tool.inputSchema.parse(input.toolInput);
    return tool.execute(parsedInput);
  }
}
