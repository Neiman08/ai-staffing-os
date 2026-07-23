import type { z } from "zod";
import type { AgentExecutionContext } from "./AgentExecutionContext";
import type { AgentResult } from "./AgentResult";
import type { AgentStage } from "./AgentStage";

/**
 * F25 Fase 1: contrato que el futuro Orchestrator (F25.5) usa para
 * invocar un handler de tarea -- distinto de `AgentTool` (F2, sin
 * modificar), que es el contrato de "una tool que un LLM puede
 * invocar dentro de un AgentRuntime.run() ya en curso". Un
 * `AgentExecutor` es un nivel más arriba: lo que la COLA reclama y
 * ejecuta, típicamente envolviendo uno o más `AgentTool` (ver
 * roadmap F25.7-F25.13, "envolver la lógica ya real como handler").
 *
 * `stage` declara a qué etapa del pipeline pertenece (AgentStage.ts)
 * -- usado para logging/observabilidad y, en el futuro, para que el
 * Orchestrator pueda reclamar tareas filtrando por etapa
 * (`claimNextTasks(workerId, limit, stages: ['DISCOVERY'])`).
 */
export interface AgentExecutor<TInput = unknown, TOutput = unknown> {
  taskType: string; // mismo vocabulario que TASK_TYPE_TO_TOOL_NAME hoy (task-executor.ts) -- nunca un vocabulario paralelo
  stage: AgentStage;
  inputSchema: z.ZodType<TInput>;
  execute(context: AgentExecutionContext, input: TInput): Promise<AgentResult<TOutput>>;
}
