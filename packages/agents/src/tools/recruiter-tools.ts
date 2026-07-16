import { z } from "zod";
import type { MatchRunResult } from "@ai-staffing-os/shared";
import type { AgentTool } from "../core/AgentTool";
import { NotImplementedError } from "../core/AgentRuntime";

/**
 * F6.5: graduación del Recruiter Agent (F6.0/§4.3 — decisión ya
 * aprobada del PO: Recruiter, no Operations, es dueño del matching).
 * Mismo patrón declarativo que sales-tools.ts: solo name/description/
 * inputSchema con Zod acá — la implementación real (que llama a
 * matching/service.ts, nunca Prisma directo) vive en
 * apps/api/src/modules/agents/tools/recruiter-tools.impl.ts.
 *
 * "La IA propone, la IA no decide, la IA no crea Assignments
 * automáticamente" — este tool nunca escribe: ni Assignment, ni Worker,
 * ni JobOrder. Es de solo análisis.
 */
function notImplemented<TInput, TOutput>(): (input: TInput) => Promise<TOutput> {
  return async () => {
    throw new NotImplementedError("F6.5");
  };
}

export const matchWorkersToJobOrderInputSchema = z.object({
  jobOrderId: z.string().min(1),
  // Default true — la revisión con IA corre salvo que el usuario pida
  // explícitamente modo determinista (plan §7.6: "si el usuario
  // solicita modo determinista: no llamar LLM; llmStatus = NOT_RUN").
  withLlm: z.boolean().optional(),
});

export const matchWorkersToJobOrderTool: AgentTool<z.infer<typeof matchWorkersToJobOrderInputSchema>, MatchRunResult> = {
  name: "matchWorkersToJobOrder",
  description:
    "Evalúa y prioriza Workers elegibles para un Job Order (disponibilidad real + scoring determinista + revisión opcional de IA acotada a ±10 puntos). Nunca crea una Assignment — solo propone.",
  inputSchema: matchWorkersToJobOrderInputSchema,
  execute: notImplemented(),
};
