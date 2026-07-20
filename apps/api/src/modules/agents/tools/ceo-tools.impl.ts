import { z } from "zod";
import {
  CEO_AGENT_SYSTEM_PROMPT,
  DEFAULT_MODEL,
  businessObjectiveSchema,
  closeDailyMissionTool as closeDailyMissionToolStub,
  closeDailyMissionInputSchema,
  interpretDailyDirectiveTool as interpretDailyDirectiveToolStub,
  interpretDailyDirectiveInputSchema,
  missionRestrictionsSchema,
  mergeMissionRestrictions,
  type AgentTool,
  type InterpretDailyDirectiveResult,
  type LLMProvider,
  type ObjectiveProgress,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { AppError } from "../../../core/errors";
import type { UsageAccumulator } from "../usage";
import { interpretBusinessIntent } from "../../ceo-intelligence/intent-interpreter";
import { normalizeText } from "../../ceo-intelligence/text-normalize";
import { detectCriticalInfrastructureClients } from "../../ceo-intelligence/critical-infrastructure-clients";

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

export interface MissionContactCoverage {
  companiesConsidered: number;
  companiesWithContactPoint: number;
  companiesWithoutContactPoint: number;
  providersOmitted: string[];
}

/**
 * Corrección estructural (misión Iowa, 2026-07-13): antes, el cierre de
 * la misión (closeMission) siempre marcaba COMPLETED sin mirar si en
 * verdad se encontró algo de lo que la instrucción pedía. Esto agrega el
 * dato real que le falta: de las Company que esta misión realmente
 * intentó enriquecer con contactos (find_contacts/find_email), cuántas
 * terminaron con al menos un punto de contacto real — un Contact
 * nombrado O un email organizacional en Company.email (§6 del pedido:
 * ambos cuentan, nunca se descarta un email real solo porque no tiene un
 * nombre asociado) — y cuántas se quedaron sin nada, y por qué (créditos
 * agotados, proveedor no configurado, etc., nunca "no se sabe").
 */
export async function computeContactCoverage(missionTaskId: string): Promise<MissionContactCoverage> {
  const children = await scopedDb.agentTask.findMany({ where: { parentTaskId: missionTaskId } });
  const findContactsTasks = children.filter((t) => t.type === "find_contacts");
  const findEmailTasks = children.filter((t) => t.type === "find_email");
  const intelligenceTasks = [...findContactsTasks, ...findEmailTasks];

  const companyIds = Array.from(
    new Set(
      intelligenceTasks
        .map((t) => (t.input as { companyId?: string } | null)?.companyId)
        .filter((id): id is string => !!id),
    ),
  );

  const providersOmitted = new Set<string>();
  for (const t of intelligenceTasks) {
    const output = t.output as { providerStatus?: string; hunterProviderStatus?: string } | null;
    if (output?.providerStatus && output.providerStatus !== "AVAILABLE") {
      providersOmitted.add(`People Data Labs: ${output.providerStatus}`);
    }
    if (output?.hunterProviderStatus && output.hunterProviderStatus !== "AVAILABLE") {
      providersOmitted.add(`Hunter.io: ${output.hunterProviderStatus}`);
    }
  }

  if (companyIds.length === 0) {
    return {
      companiesConsidered: 0,
      companiesWithContactPoint: 0,
      companiesWithoutContactPoint: 0,
      providersOmitted: Array.from(providersOmitted),
    };
  }

  const [contactRows, companies] = await Promise.all([
    scopedDb.contact.findMany({ where: { companyId: { in: companyIds } }, select: { companyId: true } }),
    scopedDb.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, email: true } }),
  ]);
  const companiesWithNamedContact = new Set(contactRows.map((c) => c.companyId));
  const companiesWithOrgEmail = new Set(companies.filter((c) => !!c.email).map((c) => c.id));
  const companiesWithContactPoint = new Set([...companiesWithNamedContact, ...companiesWithOrgEmail]);

  return {
    companiesConsidered: companyIds.length,
    companiesWithContactPoint: companiesWithContactPoint.size,
    companiesWithoutContactPoint: companyIds.length - companiesWithContactPoint.size,
    providersOmitted: Array.from(providersOmitted),
  };
}

/**
 * F14 (hallazgo real: "Industrial", "Commercial", "data centers",
 * "infraestructura eléctrica" reportados como unrecognizedTerms pese a
 * haber generado búsquedas reales). El LLM de arriba corre dos
 * evaluaciones del mismo término EN LA MISMA RESPUESTA: puede convertirlo
 * en una frase de externalSearchTerms (según sus propias instrucciones
 * del prompt) Y SEPARADAMENTE listarlo en unrecognizedTerms si no
 * coincide con el vocabulario cerrado de industryNames/categoryNames
 * (que son solo los 5 buckets reales del CRM) — el prompt le pide no
 * hacer esto, pero un LLM no es 100% consistente con sus propias reglas.
 * "Unrecognized" para el usuario final debería significar "el sistema
 * no entendió esto en absoluto", no "no coincide con el nombre exacto
 * de una Industry del CRM" — un término que SÍ generó una query real
 * (vía externalSearchTerms) o que el intérprete determinista de
 * taxonomía (misma fuente de verdad que building/mission-planner.ts
 * usa para las queries reales, ver intent-interpreter.ts) reconoce por
 * separado, nunca debe aparecer acá. Mismo criterio de "defensa en
 * profundidad, nunca confiar ciegamente en el LLM" que ya usa este
 * archivo para industryNames/categoryNames arriba.
 *
 * F15 (hallazgo real: "QTS, Meta, Google, Microsoft, Amazon AWS, Compass
 * Datacenters" reportados como unrecognizedTerms): esos nombres nunca
 * matchean business-taxonomy.ts (no son un sector) pero SÍ son clientes
 * de infraestructura crítica reales, reconocidos por su propia base de
 * conocimiento (critical-infrastructure-clients.ts) — nunca deben
 * aparecer como "no reconocidos" solo porque no son una industria.
 */
export function filterActuallyUnrecognizedTerms(unrecognizedTerms: string[], externalSearchTerms: string[]): string[] {
  const normalizedSearchPhrases = externalSearchTerms.map((t) => normalizeText(t));
  return unrecognizedTerms.filter((term) => {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) return false;
    // (a) el propio LLM ya lo convirtió en una frase de búsqueda real —
    // aparece como substring de alguna, en cualquier dirección (el
    // término del usuario puede ser más corto o más largo que la frase
    // en inglés generada, ej. "industrial" vs "industrial automation").
    const coveredBySearchTerm = normalizedSearchPhrases.some(
      (phrase) => phrase.includes(normalizedTerm) || normalizedTerm.includes(phrase),
    );
    if (coveredBySearchTerm) return false;
    // (b) el intérprete determinista de taxonomía (fuente de verdad real
    // de qué sectores el sistema sabe buscar) lo reconoce por su cuenta,
    // evaluado en el contexto de la instrucción completa de arriba nunca
    // pasa acá — evaluado aislado, exactamente como lo reportaría un
    // humano leyendo solo esa palabra suelta.
    const recognizedByTaxonomy = interpretBusinessIntent(term).matchedTaxonomyKeys.length > 0;
    if (recognizedByTaxonomy) return false;
    // (c) F15: es un cliente de infraestructura crítica conocido (QTS,
    // Meta, Google...) -- nunca un sector, pero tampoco "no reconocido".
    const recognizedAsCriticalInfrastructureClient = detectCriticalInfrastructureClients(term).length > 0;
    return !recognizedAsCriticalInfrastructureClient;
  });
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
  "externalSearchTerms": [<SOLO cuando useExternalDiscovery es true Y la instrucción menciona sectores/trades específicos que van más allá de una sola industria genérica del CRM (ej. "empresas de manufactura" NO necesita esto, industryNames alcanza). Dos casos típicos, cada uno con su propia frase — NUNCA colapsados en una sola:
     (a) Sectores de construcción/infraestructura especializada de Data Centers — "data center", "data centers", "mission critical", "colocation", "hyperscale", "critical facilities" son SIEMPRE frases de búsqueda propias acá (NUNCA solo industryNames=["Construction"] genérico) — ej. "data center construction", "colocation facility", "hyperscale data center construction", "critical facilities contractor", "mission critical construction".
     (b) Contratistas/trades específicos — ej. "contratistas eléctricos, baja tensión, fibra óptica, automatización industrial, HVAC, Mission Critical" son 6 frases distintas: "electrical contractor", "low voltage contractor", "fiber optic contractor", "industrial automation", "HVAC contractor", "mission critical contractor". Mismo criterio para "mechanical contractor", "controls contractor", "industrial electrical contractor".
     Cada elemento es una frase de búsqueda corta EN INGLÉS lista para un buscador tipo Google Places — una frase por cada sector/trade distinto que el usuario nombró, NUNCA una sola frase que intente resumir todos. Si no aplica ninguno de los dos casos (instrucción de una sola industria genérica, sin sectores especializados), array vacío.],
  "missionRestrictions": { "allowCampaignCreation": <false ÚNICAMENTE si la instrucción dice explícitamente algo como "no crear campañas"/"sin crear campañas"/"no campaigns" — default true>, "allowOpportunityCreation": <false ÚNICAMENTE si dice "no crear oportunidades"/"no opportunities" — default true>, "allowOutreach": <false ÚNICAMENTE si dice "no enviar correos/mensajes/emails", "no contactar a nadie", "no outreach" — default true>, "allowMessageSending": <mismo criterio que allowOutreach — si se prohíbe uno, el otro también, default true> }
}

Regla crítica: cuando la instrucción lista varios sectores/trades/sub-sectores de Data Center distintos, CADA UNO debe quedar como su propia frase en externalSearchTerms — está PROHIBIDO colapsar varios sectores en una sola industria inventada o en un solo string. Si no podés convertir un término a una frase de búsqueda razonable Y tampoco coincide con una industria/categoría real, listalo tal cual en unrecognizedTerms — nunca lo descartes en silencio.

Regla crítica sobre missionRestrictions: estos 4 flags son SIEMPRE true salvo que la instrucción los prohíba EXPLÍCITAMENTE con una frase negativa clara — nunca los pongas en false por inferencia o por precaución tuya. Esta interpretación es solo una de dos señales que se combinan en código; una segunda verificación determinista revisa el texto literal después, así que es más importante que seas preciso (no le agregues restricciones que el texto no pidió) que "seguro" por las dudas.`;

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
            // Corrección estructural: opcional y parcial en el parseo — si
            // el LLM omite el campo (o alguna de sus 4 claves), se
            // completa con el default permisivo (true) ANTES de combinar
            // con el detector determinista (mergeMissionRestrictions),
            // nunca se descarta la interpretación completa por esto.
            missionRestrictions: missionRestrictionsSchema.partial().nullable().optional(),
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
          unrecognizedTerms: filterActuallyUnrecognizedTerms(
            [...parsed.unrecognizedTerms, ...droppedTerms],
            parsed.externalSearchTerms ?? [],
          ),
          useExternalDiscovery: parsed.useExternalDiscovery ?? false,
          externalSearchTerms: parsed.externalSearchTerms ?? [],
          // Corrección estructural: el AND del detector determinista con lo
          // que el LLM interpretó — nunca al revés. Ver mission-restrictions.ts.
          missionRestrictions: mergeMissionRestrictions(parsed.missionRestrictions, input.rawInstruction),
        };
      },
    },

    // ---- closeDailyMission: híbrido D8 — Executive Report ----
    {
      ...closeDailyMissionToolStub,
      async execute(input: z.infer<typeof closeDailyMissionInputSchema>) {
        const progress = await computeMissionProgress(input.missionTaskId);
        const contactCoverage = await computeContactCoverage(input.missionTaskId);
        const { objectiveProgress } = progress;

        const contactCoverageLine =
          contactCoverage.companiesConsidered > 0
            ? `Cobertura de contacto: ${contactCoverage.companiesWithContactPoint}/${contactCoverage.companiesConsidered} empresas con al menos un punto de contacto real (Contact nombrado o email organizacional)${contactCoverage.companiesWithoutContactPoint > 0 ? `; ${contactCoverage.companiesWithoutContactPoint} sin ninguno` : ""}.${contactCoverage.providersOmitted.length > 0 ? ` Proveedores no disponibles durante esta misión: ${contactCoverage.providersOmitted.join(", ")}.` : ""}`
            : "No se buscaron contactos en esta misión.";

        const prompt = `Objetivo de negocio: "${objectiveProgress.rawText}" (${objectiveProgress.target ?? "sin número objetivo"} ${objectiveProgress.unit})
Progreso hacia el objetivo: ${objectiveProgress.current} ${objectiveProgress.unit}${objectiveProgress.percentComplete != null ? ` (${objectiveProgress.percentComplete.toFixed(0)}%)` : ""}
Campañas involucradas: ${progress.campaignCount}
Empresas targeteadas: ${progress.companiesTargeted}
Leads creados: ${progress.leadsCreated}
Oportunidades creadas: ${progress.opportunitiesCreated} (pipeline estimado $${progress.pipelineValueUsd.toFixed(2)})
Secuencias planificadas: ${progress.sequencesPlanned}
Borradores pendientes de aprobación: ${progress.draftsAwaitingApproval}
Costo de IA de la misión: $${progress.costUsdSoFar.toFixed(4)}
${contactCoverageLine}

Responde ÚNICAMENTE con un JSON de la forma {"report": "<párrafo ejecutivo de 3-5 frases en español, declarando explícitamente el objetivo y su cumplimiento con los números de arriba — si companiesWithoutContactPoint > 0 o hay proveedores no disponibles, decilo explícitamente y con honestidad (nunca lo presentes como éxito total) — nunca inventes un número que no esté listado>"}.`;

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
