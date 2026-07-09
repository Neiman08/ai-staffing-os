import { z } from "zod";
import {
  processCompanyPipelineTool as processCompanyPipelineToolStub,
  processCompanyPipelineInputSchema,
  type AgentTool,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { AppError } from "../../../core/errors";
import { markCompanyProcessed } from "../memory";

export interface ChildTaskResult {
  id: string;
  status: string;
  output: unknown;
  errorMessage: string | null;
  approvalRequestId: string | null;
}

/**
 * Inyectado por task-executor.ts (evita un import circular: task-executor
 * ya importa este archivo para construir el ToolRegistry del Prospecting
 * Agent). Cada llamada crea+corre+espera un AgentTask hijo real, con
 * parentTaskId encadenando la corrida completa (F3 §5/§9).
 */
export interface RunChildTask {
  (params: { agentKey: string; type: string; input: unknown }): Promise<ChildTaskResult>;
}

export interface ProspectingToolDeps {
  taskId: string;
  agentInstanceId: string;
  runChildTask: RunChildTask;
}

/**
 * F3: el único tool del Prospecting Agent. Orquesta scoreCompany →
 * createLead → createOpportunity → createFollowUp → draftOutreach, todas
 * tools ya reales de Sales Agent — no llama al LLM directamente. Si un
 * paso falla, el pipeline se detiene ahí (no revierte lo ya creado) y la
 * tarea padre queda FAILED con el error de ese paso (F3 §5).
 */
export function createProspectingTools(deps: ProspectingToolDeps): AgentTool[] {
  return [
    {
      ...processCompanyPipelineToolStub,
      async execute(input: z.infer<typeof processCompanyPipelineInputSchema>) {
        const company = await scopedDb.company.findUnique({ where: { id: input.companyId } });
        if (!company) throw AppError.notFound("Company not found");

        const scoreTask = await deps.runChildTask({
          agentKey: "sales",
          type: "score_company",
          input: { companyId: input.companyId },
        });
        if (scoreTask.status === "FAILED") throw new Error(`scoreCompany: ${scoreTask.errorMessage}`);

        const leadTask = await deps.runChildTask({
          agentKey: "sales",
          type: "create_lead",
          input: {
            companyId: input.companyId,
            industryId: company.industryId,
            city: company.city ?? undefined,
            state: company.state ?? undefined,
            source: "prospecting-pipeline",
          },
        });
        if (leadTask.status === "FAILED") throw new Error(`createLead: ${leadTask.errorMessage}`);
        const leadId = (leadTask.output as { leadId: string }).leadId;

        const opportunityTask = await deps.runChildTask({
          agentKey: "sales",
          type: "create_opportunity",
          input: { leadId },
        });
        if (opportunityTask.status === "FAILED") throw new Error(`createOpportunity: ${opportunityTask.errorMessage}`);
        const opportunityId = (opportunityTask.output as { opportunityId: string }).opportunityId;

        const followUpTask = await deps.runChildTask({
          agentKey: "sales",
          type: "create_follow_up",
          input: { entityType: "lead", entityId: leadId },
        });
        if (followUpTask.status === "FAILED") throw new Error(`createFollowUp: ${followUpTask.errorMessage}`);
        const followUpId = (followUpTask.output as { followUpId: string }).followUpId;

        const draftTask = await deps.runChildTask({
          agentKey: "sales",
          type: "draft_outreach",
          input: { leadId, channel: "EMAIL" },
        });
        if (draftTask.status === "FAILED") throw new Error(`draftOutreach: ${draftTask.errorMessage}`);

        await markCompanyProcessed(
          deps.agentInstanceId,
          input.companyId,
          `Procesada por el pipeline: lead ${leadId}, opportunity ${opportunityId}, follow-up ${followUpId}.`,
        );

        return {
          leadId,
          opportunityId,
          followUpId,
          approvalRequestId: draftTask.approvalRequestId,
          skippedSteps: [],
        };
      },
    },
  ];
}
