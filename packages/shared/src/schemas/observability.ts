import { z } from "zod";

/**
 * F25.2 (consolidación): shape real de GET
 * /api/v1/agents/orchestrator/health (apps/api/src/modules/agents/
 * observability.ts) -- usada por la UI (AIDashboard.tsx) para tipar la
 * respuesta.
 */
export const orchestratorHealthSchema = z.object({
  tasksByStatus: z.record(z.string(), z.number()),
  queueDepth: z.number(),
  oldestQueuedTaskAgeMs: z.number().nullable(),
  expiredLeases: z.number(),
  unprocessedEvents: z.number(),
});
export type OrchestratorHealth = z.infer<typeof orchestratorHealthSchema>;
