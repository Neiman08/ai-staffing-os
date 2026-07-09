import type { AgentContext } from "./AgentContext";
import type { ToolRegistry } from "./ToolRegistry";
import type { LLMProvider } from "./LLMProvider";

export class NotImplementedError extends Error {
  constructor(phase: string) {
    super(`AgentRuntime.run() is not implemented until ${phase}`);
    this.name = "NotImplementedError";
  }
}

/**
 * Loop ReAct: prompt → tool calls → resultado (Architecture §6.1).
 * Esqueleto sin dependencias de red — la implementación real llega en F3.
 */
export class AgentRuntime {
  constructor(
    private readonly llmProvider: LLMProvider,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async run(_context: AgentContext, _input: unknown): Promise<never> {
    void this.llmProvider;
    void this.toolRegistry;
    throw new NotImplementedError("F3");
  }
}
