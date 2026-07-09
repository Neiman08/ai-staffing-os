import type { z } from "zod";

/**
 * Herramienta tipada que un agente puede invocar (Architecture §3.3).
 * Las tools que escriben datos deben pasar por los mismos services que
 * usan los humanos — nunca ejecutan SQL directo (regla de oro, Arq. §3.3).
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  humanOnly?: boolean;
  execute(input: TInput): Promise<TOutput>;
}
