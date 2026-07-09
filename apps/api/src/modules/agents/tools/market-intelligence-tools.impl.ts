import { z } from "zod";
import {
  DEFAULT_MODEL,
  MARKET_INTELLIGENCE_SYSTEM_PROMPT,
  analyzeIndustryTool as analyzeIndustryToolStub,
  analyzeIndustryInputSchema,
  type AgentTool,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { AppError } from "../../../core/errors";
import { recordIndustryAnalysis } from "../memory";
import type { UsageAccumulator } from "../usage";

function tryParseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const parsed: unknown = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    return schema.parse(parsed);
  } catch {
    return null;
  }
}

export interface MarketIntelligenceToolDeps {
  taskId: string;
  agentInstanceId: string;
  llmProvider: LLMProvider;
  usage: UsageAccumulator;
}

/**
 * F3: primer tool real del Market Intelligence Agent. Agregados
 * deterministas sobre TODAS las Company de una industria (a diferencia
 * de scoreCompany, que opera sobre una empresa puntual) + LLM que
 * redacta el resumen (mismo patrón híbrido D8). Persiste en AgentMemory
 * para que el Prospecting Agent lo pueda leer después.
 */
export function createMarketIntelligenceTools(deps: MarketIntelligenceToolDeps): AgentTool[] {
  return [
    {
      ...analyzeIndustryToolStub,
      async execute(input: z.infer<typeof analyzeIndustryInputSchema>) {
        const industry = await scopedDb.industry.findUnique({ where: { id: input.industryId } });
        if (!industry) throw AppError.notFound("Industry not found");

        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

        const [companies, openJobOrders, wonOpportunities] = await Promise.all([
          scopedDb.company.findMany({
            where: { industryId: input.industryId },
            select: { status: true, commercialScore: true },
          }),
          scopedDb.jobOrder.count({
            where: { status: { in: ["OPEN", "PARTIALLY_FILLED"] }, company: { industryId: input.industryId } },
          }),
          scopedDb.opportunity.findMany({
            where: { stage: "WON", updatedAt: { gte: ninetyDaysAgo }, company: { industryId: input.industryId } },
            select: { estimatedRevenue: true },
          }),
        ]);

        const activeCompanies = companies.filter((c) => c.status !== "INACTIVE").length;
        const scored = companies.filter((c) => c.commercialScore != null);
        const averageScore = scored.length
          ? scored.reduce((sum, c) => sum + (c.commercialScore ?? 0), 0) / scored.length
          : null;
        const wonRevenueLast90dUsd = wonOpportunities.reduce((sum, o) => sum + Number(o.estimatedRevenue ?? 0), 0);

        const metrics = {
          activeCompanies,
          averageScore,
          openJobOrders,
          wonOpportunitiesLast90d: wonOpportunities.length,
          wonRevenueLast90dUsd,
        };

        const prompt = `Industria: ${industry.name}
Empresas activas: ${activeCompanies}
Score comercial promedio: ${averageScore != null ? averageScore.toFixed(1) : "sin datos"}
Job orders abiertos: ${openJobOrders}
Oportunidades ganadas (últimos 90 días): ${wonOpportunities.length}
Ingresos ganados últimos 90 días: $${wonRevenueLast90dUsd.toFixed(2)}

Responde ÚNICAMENTE con un JSON de la forma {"summary": "<2-3 frases en español resumiendo el potencial comercial de esta industria, basadas solo en los datos de arriba>"}. No inventes datos que no estén listados arriba.`;

        const completion = await deps.llmProvider.complete({
          model: DEFAULT_MODEL,
          messages: [
            { role: "system", content: MARKET_INTELLIGENCE_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        });
        deps.usage.record(completion);

        const parsed = tryParseJson(completion.content, z.object({ summary: z.string().min(1) }));
        const summary =
          parsed?.summary ??
          `Resumen no disponible (el modelo no devolvió una respuesta válida). Métricas: activeCompanies=${activeCompanies}, averageScore=${averageScore ?? "—"}, openJobOrders=${openJobOrders}.`;

        await recordIndustryAnalysis(deps.agentInstanceId, input.industryId, summary);

        return { summary, metrics };
      },
    },
  ];
}
