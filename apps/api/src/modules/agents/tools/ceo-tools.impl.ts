import { z } from "zod";
import {
  CEO_AGENT_SYSTEM_PROMPT,
  DEFAULT_MODEL,
  businessObjectiveSchema,
  closeDailyMissionTool as closeDailyMissionToolStub,
  closeDailyMissionInputSchema,
  interpretDailyDirectiveTool as interpretDailyDirectiveToolStub,
  interpretDailyDirectiveInputSchema,
  type AgentTool,
  type InterpretDailyDirectiveResult,
  type LLMProvider,
  type ObjectiveProgress,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { AppError } from "../../../core/errors";
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

export interface CeoToolDeps {
  taskId: string;
  agentInstanceId: string;
  llmProvider: LLMProvider;
  usage: UsageAccumulator;
}

export interface MissionProgress {
  campaignCount: number;
  companiesTargeted: number;
  leadsCreated: number;
  opportunitiesCreated: number;
  pipelineValueUsd: number;
  sequencesPlanned: number;
  draftsAwaitingApproval: number;
  costUsdSoFar: number;
  objectiveProgress: ObjectiveProgress;
}

/**
 * F4: rollup real de una Daily Revenue Mission — recorre sus tareas hijas
 * (parentTaskId plano, ver el addendum) sin recursión ni Json-path
 * queries. Compartido entre closeDailyMission (le agrega el Executive
 * Report narrado) y mission-orchestrator.ts (lo usa para refrescar
 * AgentTask.output mientras la misión sigue RUNNING).
 */
export async function computeMissionProgress(missionTaskId: string): Promise<MissionProgress> {
  const missionTask = await scopedDb.agentTask.findUnique({ where: { id: missionTaskId } });
  if (!missionTask) throw AppError.notFound("Mission not found");

  const children = await scopedDb.agentTask.findMany({ where: { parentTaskId: missionTaskId } });
  const missionInput = missionTask.input as { businessObjective: z.infer<typeof businessObjectiveSchema> };

  const campaignIds = children
    .filter((t) => t.type === "create_campaign" && t.status === "DONE")
    .map((t) => (t.output as { campaignId: string } | null)?.campaignId)
    .filter((id): id is string => !!id);

  const companiesTargeted = children
    .filter((t) => t.type === "select_target_companies" && t.status === "DONE")
    .reduce((sum, t) => sum + ((t.output as { addedCount?: number } | null)?.addedCount ?? 0), 0);

  const leadsCreated = children.filter((t) => t.type === "create_lead" && t.status === "DONE").length;
  const opportunityTasks = children.filter((t) => t.type === "create_opportunity" && t.status === "DONE");
  const sequencesPlanned = children.filter((t) => t.type === "plan_sequence" && t.status === "DONE").length;

  const personalizeMessageTaskIds = children.filter((t) => t.type === "personalize_message").map((t) => t.id);
  const draftsAwaitingApproval =
    personalizeMessageTaskIds.length > 0
      ? await scopedDb.approvalRequest.count({
          where: { agentTaskId: { in: personalizeMessageTaskIds }, status: "PENDING" },
        })
      : 0;

  const costUsdSoFar = Number(missionTask.costUsd ?? 0) + children.reduce((sum, t) => sum + Number(t.costUsd ?? 0), 0);

  const opportunityIds = opportunityTasks
    .map((t) => (t.output as { opportunityId: string } | null)?.opportunityId)
    .filter((id): id is string => !!id);
  const opportunities =
    opportunityIds.length > 0
      ? await scopedDb.opportunity.findMany({ where: { id: { in: opportunityIds } }, select: { estimatedRevenue: true } })
      : [];
  const pipelineValueUsd = opportunities.reduce((sum, o) => sum + Number(o.estimatedRevenue ?? 0), 0);

  const companyIds = children
    .filter((t) => t.type === "select_target_companies" && t.status === "DONE")
    .flatMap((t) => (t.output as { companyIds?: string[] } | null)?.companyIds ?? []);
  const newClients =
    companyIds.length > 0 ? await scopedDb.company.count({ where: { id: { in: companyIds }, status: "CLIENT" } }) : 0;
  const meetingsScheduled =
    companyIds.length > 0
      ? await scopedDb.followUp.count({ where: { entityType: "company", entityId: { in: companyIds }, type: "MEETING" } })
      : 0;

  const objective = missionInput.businessObjective;
  let current = 0;
  if (objective.type === "meetings") current = meetingsScheduled;
  else if (objective.type === "new_clients") current = newClients;
  else if (objective.type === "companies_found" || objective.type === "custom") current = companiesTargeted;
  else if (objective.type === "pipeline_increase") current = pipelineValueUsd;

  const objectiveProgress: ObjectiveProgress = {
    type: objective.type,
    target: objective.target,
    unit: objective.unit,
    current,
    percentComplete: objective.target ? Math.min(100, (current / objective.target) * 100) : null,
    rawText: objective.rawText,
  };

  return {
    campaignCount: campaignIds.length,
    companiesTargeted,
    leadsCreated,
    opportunitiesCreated: opportunityTasks.length,
    pipelineValueUsd,
    sequencesPlanned,
    draftsAwaitingApproval,
    costUsdSoFar,
    objectiveProgress,
  };
}

/**
 * F4: los dos únicos tools del CEO Agent. Ambos corren DIRECTAMENTE
 * contra la misión raíz (vía runCeoToolDirectly en task-executor.ts), no
 * como tareas hijas — ver F4_AUTONOMOUS_OUTREACH_PLAN.md, addendum
 * "Daily Revenue Mission".
 */
export function createCeoTools(deps: CeoToolDeps): AgentTool[] {
  return [
    // ---- interpretDailyDirective: único tool con LLM real del CEO Agent ----
    {
      ...interpretDailyDirectiveToolStub,
      async execute(input: z.infer<typeof interpretDailyDirectiveInputSchema>): Promise<InterpretDailyDirectiveResult> {
        const [industries, categories] = await Promise.all([
          scopedDb.industry.findMany(),
          scopedDb.jobCategory.findMany(),
        ]);

        const prompt = `Industrias disponibles en este tenant: ${industries.map((i) => i.name).join(", ") || "ninguna"}
Categorías de trabajo disponibles en este tenant: ${categories.map((c) => c.name).join(", ") || "ninguna"}

Instrucción del usuario: "${input.rawInstruction}"

Responde ÚNICAMENTE con un JSON de la forma {
  "industryNames": ["<SOLO nombres de la lista de industrias de arriba que apliquen — nunca inventes uno nuevo, puede quedar vacío. IMPORTANTE si vas a llenar externalSearchTerms (ver abajo): igual elegí acá la industria real más cercana de la lista de arriba (ej. 'Construction' para contratistas/trades de construcción) — se usa solo para archivar las empresas encontradas en el CRM, no reemplaza a externalSearchTerms como texto de búsqueda>"],
  "state": "<código de 2 letras, ej. IL>" o null,
  "city": "<ciudad>" o null,
  "categoryNames": ["<SOLO de la lista de categorías de arriba>"],
  "desiredVolume": <número de empresas deseado> o null,
  "businessObjective": { "type": "meetings"|"new_clients"|"companies_found"|"pipeline_increase"|"custom", "target": <número> o null, "unit": "<palabra corta, SIEMPRE un string aunque target sea null — ej. 'reuniones', 'clientes', 'empresas', 'USD'>", "rawText": "<frase literal de la instrucción que describe el objetivo — si no hay un objetivo explícito, usa la instrucción completa>" },
  "unrecognizedTerms": ["<términos que el usuario mencionó que NO coinciden con ninguna industria/categoría de arriba NI se pudieron convertir en una frase de externalSearchTerms — ver abajo>"],
  "useExternalDiscovery": <true ÚNICAMENTE si la instrucción menciona EXPLÍCITAMENTE que las empresas deben buscarse FUERA del CRM o que el sistema no las tiene todavía — frases como "fuera del CRM", "que no tengamos en el CRM/sistema", "que no conozcamos todavía", "búsqueda externa", "en internet", "fuentes externas". Es false (default, el caso normal) para CUALQUIER instrucción que solo diga "busca/encuentra empresas de <industria> en <lugar>" sin esa mención explícita — eso significa buscar entre las empresas YA existentes en el CRM, el comportamiento de siempre. La palabra "nueva/nuevas" SOLA (ej. "encontrar 1 empresa nueva") NO activa esto — en el CRM significa "una empresa todavía no targeteada en esta campaña", no "una empresa fuera del CRM". Ante la duda, false.>,
  "externalSearchTerms": [<SOLO cuando useExternalDiscovery es true Y la instrucción enumera VARIOS tipos de negocio/trade específicos que van más allá de una sola industria genérica (ej. "contratistas eléctricos, baja tensión, fibra óptica, automatización industrial, HVAC, Mission Critical" — eso son 6 frases distintas, NUNCA una sola industria inventada que las mezcle todas). Cada elemento es una frase de búsqueda corta EN INGLÉS lista para un buscador tipo Google Places (ej. "electrical contractor", "low voltage contractor", "fiber optic contractor", "industrial automation", "HVAC contractor", "mission critical contractor", "mechanical contractor", "controls contractor", "industrial electrical contractor") — una frase por cada tipo de negocio distinto que el usuario nombró, NUNCA una sola frase que intente resumir todos. Si la instrucción ya describe una sola industria/sector claro (ej. "empresas de manufactura", "construcción de data centers"), dejá esto vacío — ese caso ya lo cubre industryNames como siempre. Si no aplica, array vacío.]
}

Regla crítica: cuando la instrucción lista varios sectores/trades distintos, CADA UNO debe quedar como su propia frase en externalSearchTerms — está PROHIBIDO colapsar varios sectores en una sola industria inventada o en un solo string. Si no podés convertir un término a una frase de búsqueda razonable Y tampoco coincide con una industria/categoría real, listalo tal cual en unrecognizedTerms — nunca lo descartes en silencio.`;

        const completion = await deps.llmProvider.complete({
          model: DEFAULT_MODEL,
          messages: [
            { role: "system", content: CEO_AGENT_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        });
        deps.usage.record(completion);

        // El schema de parseo es deliberadamente más permisivo que
        // businessObjectiveSchema en "unit" — el LLM a veces devuelve
        // null ahí cuando no hay un objetivo numérico explícito (target
        // también null). Se normaliza después, nunca se descarta la
        // interpretación completa por ese detalle.
        const parsed = tryParseJson(
          completion.content,
          z.object({
            industryNames: z.array(z.string()),
            state: z.string().nullable(),
            city: z.string().nullable(),
            categoryNames: z.array(z.string()),
            desiredVolume: z.number().nullable(),
            businessObjective: businessObjectiveSchema.extend({ unit: z.string().nullable() }),
            unrecognizedTerms: z.array(z.string()),
            useExternalDiscovery: z.boolean().nullable().optional(),
            // Bugfix multi-sector: opcional en el parseo (el LLM a veces
            // omite el campo por completo en vez de devolver []) — se
            // normaliza a array vacío más abajo, nunca se descarta la
            // interpretación completa por esto.
            externalSearchTerms: z.array(z.string()).nullable().optional(),
          }),
        );
        if (!parsed) {
          throw AppError.internal("El CEO Agent no pudo interpretar la instrucción. Intenta de nuevo.");
        }

        // Defensa en profundidad: aunque el prompt ya fija el vocabulario
        // cerrado, se vuelve a filtrar contra los nombres reales — nunca
        // se confía ciegamente en que el LLM respetó la instrucción.
        const realIndustryNames = new Set(industries.map((i) => i.name));
        const realCategoryNames = new Set(categories.map((c) => c.name));
        const validIndustryNames = parsed.industryNames.filter((n) => realIndustryNames.has(n));
        const validCategoryNames = parsed.categoryNames.filter((n) => realCategoryNames.has(n));
        const droppedTerms = [
          ...parsed.industryNames.filter((n) => !realIndustryNames.has(n)),
          ...parsed.categoryNames.filter((n) => !realCategoryNames.has(n)),
        ];

        return {
          industryNames: validIndustryNames,
          state: parsed.state,
          city: parsed.city,
          categoryNames: validCategoryNames,
          desiredVolume: parsed.desiredVolume,
          businessObjective: { ...parsed.businessObjective, unit: parsed.businessObjective.unit ?? "empresas" },
          unrecognizedTerms: [...parsed.unrecognizedTerms, ...droppedTerms],
          useExternalDiscovery: parsed.useExternalDiscovery ?? false,
          externalSearchTerms: parsed.externalSearchTerms ?? [],
        };
      },
    },

    // ---- closeDailyMission: híbrido D8 — Executive Report ----
    {
      ...closeDailyMissionToolStub,
      async execute(input: z.infer<typeof closeDailyMissionInputSchema>) {
        const progress = await computeMissionProgress(input.missionTaskId);
        const { objectiveProgress } = progress;

        const prompt = `Objetivo de negocio: "${objectiveProgress.rawText}" (${objectiveProgress.target ?? "sin número objetivo"} ${objectiveProgress.unit})
Progreso hacia el objetivo: ${objectiveProgress.current} ${objectiveProgress.unit}${objectiveProgress.percentComplete != null ? ` (${objectiveProgress.percentComplete.toFixed(0)}%)` : ""}
Campañas involucradas: ${progress.campaignCount}
Empresas targeteadas: ${progress.companiesTargeted}
Leads creados: ${progress.leadsCreated}
Oportunidades creadas: ${progress.opportunitiesCreated} (pipeline estimado $${progress.pipelineValueUsd.toFixed(2)})
Secuencias planificadas: ${progress.sequencesPlanned}
Borradores pendientes de aprobación: ${progress.draftsAwaitingApproval}
Costo de IA de la misión: $${progress.costUsdSoFar.toFixed(4)}

Responde ÚNICAMENTE con un JSON de la forma {"report": "<párrafo ejecutivo de 3-4 frases en español, declarando explícitamente el objetivo y su cumplimiento con los números de arriba — nunca inventes un número que no esté listado>"}.`;

        const completion = await deps.llmProvider.complete({
          model: DEFAULT_MODEL,
          messages: [
            { role: "system", content: CEO_AGENT_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        });
        deps.usage.record(completion);

        const parsed = tryParseJson(completion.content, z.object({ report: z.string().min(1) }));
        const report =
          parsed?.report ??
          `Reporte no disponible (el modelo no devolvió una respuesta válida). Objetivo: ${objectiveProgress.rawText} — progreso: ${objectiveProgress.current} ${objectiveProgress.unit}. Empresas: ${progress.companiesTargeted}, leads: ${progress.leadsCreated}, oportunidades: ${progress.opportunitiesCreated}.`;

        return { report, objectiveProgress };
      },
    },
  ];
}
