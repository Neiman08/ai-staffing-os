import { z } from "zod";
import type { AgentTool } from "../core/AgentTool";
import { NotImplementedError } from "../core/AgentRuntime";

function notImplemented<TInput, TOutput>(): (input: TInput) => Promise<TOutput> {
  return async () => {
    throw new NotImplementedError("F3");
  };
}

/**
 * F3: el único tool del Prospecting Agent — orquesta la cadena completa
 * scoreCompany → createLead → createOpportunity → createFollowUp →
 * draftOutreach (todas tools de Sales Agent, ya reales desde F2/F3),
 * cada paso como su propio AgentTask hijo (parentTaskId). No llama al
 * LLM directamente — cada sub-paso que lo necesita usa su propio tool.
 * Ver F3_PROSPECTING_ENGINE_PLAN.md §5.
 */
export const processCompanyPipelineInputSchema = z.object({
  companyId: z.string(),
});

export interface ProcessCompanyPipelineResult {
  leadId: string | null;
  opportunityId: string | null;
  followUpId: string | null;
  approvalRequestId: string | null;
  // Pasos que no se pudieron completar y por qué — el pipeline no revierte
  // el trabajo parcial ya hecho (F3 §5).
  skippedSteps: Array<{ step: string; reason: string }>;
}

export const processCompanyPipelineTool: AgentTool<
  z.infer<typeof processCompanyPipelineInputSchema>,
  ProcessCompanyPipelineResult
> = {
  name: "processCompanyPipeline",
  description:
    "Ejecuta la cadena completa de prospección para una empresa: califica, crea lead, crea oportunidad, crea follow-up, y prepara un borrador de contacto (que siempre termina en aprobación humana).",
  inputSchema: processCompanyPipelineInputSchema,
  execute: notImplemented(),
};
