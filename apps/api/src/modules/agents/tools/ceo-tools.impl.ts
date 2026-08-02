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
import { CRITICAL_INFRASTRUCTURE_CLIENTS, detectCriticalInfrastructureClients } from "../../ceo-intelligence/critical-infrastructure-clients";
import { isKnownNonIndustryTerm } from "../../ceo-intelligence/semantic-normalization";

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
  // F28 (reportes limitados a la misión actual, hallazgo real
  // 2026-07-27): conteo real de envíos -- distinto de
  // draftsAwaitingApproval (borrador creado, PENDING) y de
  // companiesWithContactPoint (MissionContactCoverage, contacto
  // encontrado). Cuenta ApprovalRequest.status="SENT" cuyo agentTaskId
  // es un personalize_message HIJO de esta misión -- la única fuente
  // real de "se envió un correo de verdad", nunca inferida de otro
  // número. Usado para que el Executive Report nunca pueda decir
  // "empresas contactadas" cuando esto es 0.
  emailsSentCount: number;
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

  // F28 (misión real de Hospitality, 2026-07-28): una misión que corrió
  // por el camino dinámico (runDynamicDiscoveryMission -> executeDiscoveryPlan
  // con convertToCommercialActions=true, ver mission-executor.ts) crea
  // Company/Lead/Opportunity/ApprovalRequest reales DENTRO de la única
  // AgentTask "discover_companies" (discovery-conversion.ts,
  // convertDiscoveredCompany) -- nunca como AgentTask hijas separadas de
  // tipo create_lead/create_opportunity/select_target_companies/
  // personalize_message. El pipeline clásico (loop estático de
  // mission-orchestrator.ts) sí crea esas hijas, así que las cuentas de
  // abajo seguían siendo correctas para ese camino -- pero para el
  // dinámico, el Executive Report reportaba "0 empresas, 0 oportunidades"
  // pese a que existían Companies/Leads/Opportunities/Drafts reales,
  // porque este cómputo nunca miraba esa otra fuente real. Se suma acá,
  // vía Lead/Opportunity/Company.createdByAgentTaskId /
  // discoveredByAgentTaskId (ambos ya reales, puestos por
  // discovery-conversion.ts) -- nunca estimado, siempre contra la tabla
  // real.
  // Invariante #8 (endurecimiento del motor, hallazgo real
  // MIS-20260802-0002): ANTES este filtro exigía status==="DONE" --
  // executeDiscoveryPlan crea Company/Lead/Opportunity/Draft reales UNA
  // POR UNA dentro de su propio loop (mission-executor.ts), así que un
  // fallo tardío (ej. en la última empresa del batch) dejaba el AgentTask
  // en FAILED aunque las empresas anteriores ya se hubieran persistido
  // de verdad -- este cómputo las ignoraba por completo, reportando "0
  // empresas/leads/opportunities" pese a que sí existían filas reales en
  // la base (exactamente lo reportado en MIS-20260802-0002). Se toman
  // TODOS los discover_companies hijos sin importar su status final --
  // las tablas reales (Company.discoveredByAgentTaskId/Lead
  // .createdByAgentTaskId/Opportunity.createdByAgentTaskId) son la única
  // fuente de verdad; un task id que nunca corrió simplemente no tiene
  // ninguna fila real asociada, así que no hace falta filtrar acá.
  const discoverCompaniesTaskIds = children.filter((t) => t.type === "discover_companies").map((t) => t.id);
  // F28 (misión real de Hospitality, 2026-07-29, doble conteo real
  // encontrado en producción): cuando el descubrimiento externo real
  // corre (fallback o dinámico) Y DESPUÉS el loop clásico estático
  // selecciona esas MISMAS Company vía select_target_companies -- el
  // camino híbrido, hoy el más común desde que F28 hizo que
  // hasSpecificTradeMatch dispare discovery real para cualquier trade
  // específico -- una Company terminaba contada dos veces: una por
  // select_target_companies.addedCount, otra por
  // discoveredByAgentTaskId. Se corrige tomando la UNIÓN de ids reales
  // de ambas fuentes (nunca la suma de conteos) -- una misma Company
  // nunca puede contar más de una vez, sin importar cuántos de los dos
  // caminos la tocaron.
  const dynamicCompanyIds = discoverCompaniesTaskIds.length
    ? (await scopedDb.company.findMany({ where: { discoveredByAgentTaskId: { in: discoverCompaniesTaskIds } }, select: { id: true } })).map((c) => c.id)
    : [];
  const dynamicLeadsCreated = discoverCompaniesTaskIds.length
    ? await scopedDb.lead.count({ where: { createdByAgentTaskId: { in: discoverCompaniesTaskIds } } })
    : 0;
  const dynamicOpportunities = discoverCompaniesTaskIds.length
    ? await scopedDb.opportunity.findMany({ where: { createdByAgentTaskId: { in: discoverCompaniesTaskIds } }, select: { id: true, estimatedRevenue: true } })
    : [];

  const selectTargetCompanyIds = children
    .filter((t) => t.type === "select_target_companies" && t.status === "DONE")
    .flatMap((t) => (t.output as { companyIds?: string[] } | null)?.companyIds ?? []);

  const companiesTargeted = new Set([...selectTargetCompanyIds, ...dynamicCompanyIds]).size;

  const leadsCreated = children.filter((t) => t.type === "create_lead" && t.status === "DONE").length + dynamicLeadsCreated;
  const opportunityTasks = children.filter((t) => t.type === "create_opportunity" && t.status === "DONE");
  const sequencesPlanned = children.filter((t) => t.type === "plan_sequence" && t.status === "DONE").length;

  // discovery-conversion.ts (convertDiscoveredCompany) crea el
  // ApprovalRequest del borrador con agentTaskId=discover_companies.id
  // (nunca un personalize_message aparte) -- se incluye acá para que
  // draftsAwaitingApproval/emailsSentCount de abajo (ya reales, ya
  // consultan ApprovalRequest de verdad) también vean esos borradores.
  const personalizeMessageTaskIds = children
    .filter((t) => t.type === "personalize_message" || t.type === "discover_companies")
    .map((t) => t.id);
  const draftsAwaitingApproval =
    personalizeMessageTaskIds.length > 0
      ? await scopedDb.approvalRequest.count({
          where: { agentTaskId: { in: personalizeMessageTaskIds }, status: "PENDING" },
        })
      : 0;
  // F28: mismo universo real (ApprovalRequest generados por los
  // personalize_message de ESTA misión), status="SENT" -- la única
  // fuente real de "se envió un correo de verdad" (nunca "READY_TO_SEND"
  // ni "PENDING", esos todavía no salieron).
  const emailsSentCount =
    personalizeMessageTaskIds.length > 0
      ? await scopedDb.approvalRequest.count({
          where: { agentTaskId: { in: personalizeMessageTaskIds }, status: "SENT" },
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
  const pipelineValueUsd = [...opportunities, ...dynamicOpportunities].reduce((sum, o) => sum + Number(o.estimatedRevenue ?? 0), 0);
  const opportunitiesCreated = opportunityTasks.length + dynamicOpportunities.length;

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
    opportunitiesCreated,
    pipelineValueUsd,
    sequencesPlanned,
    draftsAwaitingApproval,
    emailsSentCount,
    costUsdSoFar,
    objectiveProgress,
  };
}

// F28 (reportes limitados a la misión actual, hallazgo real
// 2026-07-27): un LLM que genera texto libre no es 100% consistente con
// sus propias instrucciones ("nunca inventes un número que no esté
// listado" en el prompt de abajo) -- el hallazgo real fue un Executive
// Report que decía "29 empresas contactadas" cuando emailsSentCount
// real era 0. Defensa en profundidad determinista, mismo criterio que
// filterActuallyUnrecognizedTerms/industryNames de este archivo: nunca
// confiar ciegamente en el LLM, verificar contra el dato real después.
// Vocabulario deliberadamente amplio (ES/EN) -- un falso negativo acá
// (una frase de "contactado" que no se detecta) es mucho peor que un
// falso positivo (fuerza el fallback determinista de más abajo, que
// sigue siendo 100% honesto, solo menos narrativo).
const CONTACTED_CLAIM_RE = /\bcontact(ad[ao]s?|ando)\b|\bcontacted\b|\bcorreos?\s+enviados\b|\bemails?\s+sent\b/i;

export function reportClaimsContactWithoutRealSends(report: string, emailsSentCount: number): boolean {
  return emailsSentCount === 0 && CONTACTED_CLAIM_RE.test(report);
}

function buildDeterministicReport(progress: MissionProgress, contactCoverageLine: string): string {
  return `Objetivo: ${progress.objectiveProgress.rawText} — progreso: ${progress.objectiveProgress.current} ${progress.objectiveProgress.unit}${progress.objectiveProgress.percentComplete != null ? ` (${progress.objectiveProgress.percentComplete.toFixed(0)}%)` : ""}. Empresas: ${progress.companiesTargeted}, leads: ${progress.leadsCreated}, oportunidades: ${progress.opportunitiesCreated}, borradores pendientes de aprobación: ${progress.draftsAwaitingApproval}, correos realmente enviados: ${progress.emailsSentCount}. ${contactCoverageLine}`;
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
 * consideró, cuántas terminaron con al menos un punto de contacto real —
 * un Contact nombrado O un email organizacional en Company.email (§6 del
 * pedido: ambos cuentan, nunca se descarta un email real solo porque no
 * tiene un nombre asociado) — y cuántas se quedaron sin nada, y por qué
 * (créditos agotados, proveedor no configurado, etc., nunca "no se sabe").
 *
 * F16 debt fix (hallazgo real del PO: el Executive Report decía "no se
 * buscaron contactos" en una misión que sí ejecutó Hunter.io/People Data
 * Labs y creó Contacts reales): esta función buscaba AgentTask hijos de
 * type "find_contacts"/"find_email" -- esos tipos NUNCA existen como
 * AgentTask real en este código (confirmado: 0 filas en toda la base,
 * ver también DATA_PROVIDER_TASK_TYPES en data-provider-budget.ts, que
 * tiene el mismo problema). Contact Intelligence corre desde F7.7 DENTRO
 * de discover_companies (mission-executor.ts, enrichCompanyWithDecisionContacts),
 * sin crear un AgentTask propio por compañía -- así que companyIds
 * siempre quedaba vacío y esto siempre devolvía companiesConsidered=0,
 * sin importar cuántos Contacts reales se hubieran creado. Se reemplaza
 * por las DOS fuentes reales de "compañías que esta misión consideró":
 * select_target_companies (pipeline clásico, campaignId->companyIds) y
 * discover_companies (F7.3/F13/F14, vía Company.discoveredByAgentTaskId
 * -- el mismo vínculo que ya usa missions/service.ts para "empresas
 * seleccionadas"). providersOmitted sale del discoveryExecution/
 * discoveryFallback ya persistido en el output de esta misión (población
 * real hecha por executeDiscoveryPlan), no de un task output que nunca
 * existió.
 */
export async function computeContactCoverage(missionTaskId: string): Promise<MissionContactCoverage> {
  const [missionTask, children] = await Promise.all([
    scopedDb.agentTask.findUnique({ where: { id: missionTaskId } }),
    scopedDb.agentTask.findMany({ where: { parentTaskId: missionTaskId } }),
  ]);

  const selectTargetCompanyIds = children
    .filter((t) => t.type === "select_target_companies" && t.status === "DONE")
    .flatMap((t) => (t.output as { companyIds?: string[] } | null)?.companyIds ?? []);

  // Invariante #8/#9: mismo criterio que computeMissionProgress arriba --
  // no filtrar por status="DONE" acá, las Company reales ya persistidas
  // (discoveredByAgentTaskId) son la fuente de verdad, no el status final
  // del AgentTask que las creó (ver MIS-20260802-0002).
  const discoverTaskIds = children.filter((t) => t.type === "discover_companies").map((t) => t.id);
  const discoveredCompanies =
    discoverTaskIds.length > 0
      ? await scopedDb.company.findMany({
          where: { discoveredByAgentTaskId: { in: discoverTaskIds } },
          select: { id: true },
        })
      : [];

  const companyIds = Array.from(new Set([...selectTargetCompanyIds, ...discoveredCompanies.map((c) => c.id)]));

  const missionOutput = (missionTask?.output ?? {}) as {
    discoveryExecution?: { providersOmitted?: string[] };
    discoveryFallback?: { providersOmitted?: string[] };
  };
  const providersOmitted = new Set<string>([
    ...(missionOutput.discoveryExecution?.providersOmitted ?? []),
    ...(missionOutput.discoveryFallback?.providersOmitted ?? []),
  ]);

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
 *
 * F16 debt fix (hallazgo real: "Compass, Vantage, STACK, Aligned, Switch"
 * SEGUÍAN apareciendo como unrecognizedTerms pese a que
 * detectCriticalInfrastructureClients ya sabe resolverlos
 * CONTEXTUALMENTE cuando la instrucción menciona infraestructura
 * crítica/data centers): el bug estaba acá, no en critical-infrastructure-
 * clients.ts -- este filtro evaluaba cada término COMPLETAMENTE AISLADO
 * (ej. la palabra suelta "Compass", sin el resto de la frase), así que
 * el chequeo contextual nunca podía ver "infraestructura crítica" en
 * ningún lado. Se resuelve la lista de clientes UNA sola vez contra la
 * instrucción COMPLETA (rawInstruction, con todo su contexto real), y
 * cada término se compara contra los alias (completos Y contextuales) de
 * esos clientes ya resueltos -- nunca se vuelve a evaluar el término
 * solo para esto.
 */
export function filterActuallyUnrecognizedTerms(
  unrecognizedTerms: string[],
  externalSearchTerms: string[],
  rawInstruction: string,
): string[] {
  const normalizedSearchPhrases = externalSearchTerms.map((t) => normalizeText(t));
  const clientsRecognizedInFullContext = new Set(detectCriticalInfrastructureClients(rawInstruction));
  const recognizedClientAliasesNormalized = new Set(
    CRITICAL_INFRASTRUCTURE_CLIENTS.filter((c) => clientsRecognizedInFullContext.has(c.name))
      .flatMap((c) => [...c.aliases, ...(c.contextualAliases ?? [])])
      .map((alias) => normalizeText(alias)),
  );

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
    // (c) F15/F16: es un cliente de infraestructura crítica conocido (QTS,
    // Meta, Google... o un alias corto contextual como "Compass"/
    // "Vantage" cuando la instrucción completa ya trae contexto real de
    // infraestructura crítica/data centers) -- nunca un sector, pero
    // tampoco "no reconocido". Comparado contra los alias YA resueltos
    // arriba con el contexto completo, nunca reevaluado aislado.
    if (recognizedClientAliasesNormalized.has(normalizedTerm)) return false;
    // (d) F28/F32: capacidad/objeto/rol/acción real del producto o del
    // pipeline (Discovery, Leads, Opportunity, Drafts, Owner, HR,
    // Recruiting, hiring signals, "crear"/"verificar"/"buscar"...) --
    // nunca un sector, nunca "no reconocido". Antes esto solo cubría
    // capacidades del producto con una lista propia y comparación de
    // substring cruda (bug real: "Opportunity" nunca matcheaba
    // "opportunities" -- "opportunities" no contiene "opportunity" como
    // substring). isKnownNonIndustryTerm (semantic-normalization.ts,
    // única fuente de verdad compartida con intent-interpreter.ts) cubre
    // capacidades + roles de decisión (incluye los que vienen sueltos,
    // ej. "HR"/"Recruiting", hallazgo real MIS-20260731-0003) + objetos
    // del CRM + acciones del pipeline, y normaliza plurales simples
    // antes de comparar.
    if (isKnownNonIndustryTerm(term)) return false;
    return true;
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
  "externalSearchTerms": [<SOLO cuando useExternalDiscovery es true Y la instrucción del USUARIO menciona EXPLÍCITAMENTE sectores/trades específicos que van más allá de una sola industria genérica del CRM (ej. "empresas de manufactura" NO necesita esto, industryNames alcanza). Nunca agregues acá un sector/trade que la instrucción no nombró — en particular, nunca agregues frases de infraestructura crítica/Data Centers salvo que el usuario las haya pedido explícitamente. Ej. "contratistas eléctricos, baja tensión, fibra óptica, automatización industrial, HVAC" son 5 frases distintas: "electrical contractor", "low voltage contractor", "fiber optic contractor", "industrial automation", "HVAC contractor". Mismo criterio para cualquier otro trade nombrado explícitamente (ej. "mechanical contractor", "controls contractor", "roofing contractor", "data center electrical contractor" -- este último SOLO si el usuario mencionó "data center" o similar).
     Cada elemento es una frase de búsqueda corta EN INGLÉS lista para un buscador tipo Google Places — una frase por cada sector/trade distinto que el usuario nombró, NUNCA una sola frase que intente resumir todos, y NUNCA un sector que el usuario no mencionó. Si la instrucción es de una sola industria genérica sin sectores especializados nombrados, array vacío.],
  "missionRestrictions": { "allowCampaignCreation": <false ÚNICAMENTE si la instrucción dice explícitamente algo como "no crear campañas"/"sin crear campañas"/"no campaigns" — default true>, "allowOpportunityCreation": <false ÚNICAMENTE si dice "no crear oportunidades"/"no opportunities" — default true>, "allowOutreach": <false ÚNICAMENTE si dice "no contactar a nadie"/"no outreach"/"no contact" — una prohibición AMPLIA de alcanzar a alguien, default true>, "allowMessageSending": <false ÚNICAMENTE si dice explícitamente "no enviar/no mandar correos/mensajes/emails" (el envío), "don't send emails", o lo mismo que allowOutreach — default true>, "allowDraftCreation": <false ÚNICAMENTE si la instrucción prohíbe explícitamente REDACTAR/PREPARAR el contenido del mensaje (ej. "no prepares mensajes", "no redactes borradores", "don't draft messages") — default true. CRÍTICO: "no enviar correos automáticamente"/"don't send emails automatically" NUNCA debe poner esto en false — enviar y redactar son acciones DISTINTAS, y una instrucción que pide explícitamente "Crea... Drafts" junto con "no envíes correos" quiere el borrador creado pero NUNCA enviado solo>, "requireHiringSignal": <true ÚNICAMENTE si la instrucción exige EXPLÍCITAMENTE que las empresas estén contratando/reclutando (ej. "que estén contratando", "actively hiring", "that are hiring") — default false. Nunca actives esto solo porque la instrucción menciona "hiring signals" como parte del proceso a ejecutar (eso es un paso del pipeline, no un filtro) — solo cuando pide explícitamente que sea un CRITERIO de selección> }
}

Regla crítica: cuando la instrucción lista varios sectores/trades/sub-sectores distintos, CADA UNO debe quedar como su propia frase en externalSearchTerms — está PROHIBIDO colapsar varios sectores en una sola industria inventada o en un solo string. Regla crítica de aislamiento: NUNCA mezcles industrias -- externalSearchTerms/industryNames deben reflejar ÚNICAMENTE lo que el usuario pidió en ESTA instrucción, nunca un sector relacionado o adyacente que no nombró (ej. una instrucción de hoteles nunca debe producir términos de Data Centers/Construction/Electrical/Manufacturing/Logistics, y viceversa). Si no podés convertir un término a una frase de búsqueda razonable Y tampoco coincide con una industria/categoría real, listalo tal cual en unrecognizedTerms — nunca lo descartes en silencio. Excepción: nombres de capacidades/objetos reales del producto (Discovery, Company Enrichment, Contact Intelligence, Email Verification, Leads, Opportunities, Drafts, hiring signals, growth signals, o sus equivalentes en español) NUNCA van en unrecognizedTerms — no son sectores/industrias, son partes del propio sistema que la instrucción está invocando explícitamente.

Regla crítica sobre missionRestrictions: estos 5 flags son SIEMPRE true salvo que la instrucción los prohíba EXPLÍCITAMENTE con una frase negativa clara — nunca los pongas en false por inferencia o por precaución tuya. allowDraftCreation es INDEPENDIENTE de allowOutreach/allowMessageSending — nunca los acoples entre sí, cada uno responde únicamente a su propia negación explícita en el texto. Esta interpretación es solo una de dos señales que se combinan en código; una segunda verificación determinista revisa el texto literal después, así que es más importante que seas preciso (no le agregues restricciones que el texto no pidió) que "seguro" por las dudas.`;

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
            input.rawInstruction,
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
Borradores pendientes de aprobación (creados, NUNCA enviados): ${progress.draftsAwaitingApproval}
Correos realmente enviados (aprobación humana + envío real confirmado): ${progress.emailsSentCount}
Costo de IA de la misión: $${progress.costUsdSoFar.toFixed(4)}
${contactCoverageLine}

Responde ÚNICAMENTE con un JSON de la forma {"report": "<párrafo ejecutivo de 3-5 frases en español, declarando explícitamente el objetivo y su cumplimiento con los números de arriba — si companiesWithoutContactPoint > 0 o hay proveedores no disponibles, decilo explícitamente y con honestidad (nunca lo presentes como éxito total) — nunca inventes un número que no esté listado. CRÍTICO: nunca digas 'empresas contactadas' ni ninguna variante de 'contactado/enviado' salvo que 'Correos realmente enviados' arriba sea mayor a 0 -- un borrador creado (draftsAwaitingApproval) NUNCA es una empresa contactada, todavía no salió nada.>"}.`;

        const completion = await deps.llmProvider.complete({
          model: DEFAULT_MODEL,
          messages: [
            { role: "system", content: CEO_AGENT_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        });
        deps.usage.record(completion);

        const parsed = tryParseJson(completion.content, z.object({ report: z.string().min(1) }));
        // F28: defensa en profundidad determinista -- si el LLM devolvió
        // texto inválido, O devolvió texto que viola el invariante real
        // "sin envíos reales, nunca 'contactadas'", se usa el reporte
        // 100% determinista (nunca la prosa del LLM en ninguno de los
        // dos casos) -- ver buildDeterministicReport/
        // reportClaimsContactWithoutRealSends arriba.
        const report =
          parsed?.report && !reportClaimsContactWithoutRealSends(parsed.report, progress.emailsSentCount)
            ? parsed.report
            : buildDeterministicReport(progress, contactCoverageLine);

        return { report, objectiveProgress };
      },
    },
  ];
}
