// Lógica compartida entre el script de estabilización de la cohorte de
// Illinois y sus tests — funciones puras (sin DB) + helpers que reciben
// un cliente Prisma ya conectado por parámetro (nunca instancian uno
// propio, para que los tests puedan pasar cualquier cliente, real o de
// un fixture desechable).
//
// Objetivo del script que usa este módulo: crear AgentMemory
// (entityType="company") para las Companies de la cohorte de Illinois
// que el scheduler de prospección (getUnprocessedCompanyIds, en
// apps/api/src/modules/agents/memory.ts) todavía considera elegibles,
// para que deje de crearles Leads/Opportunities/AgentTasks/Activities
// mientras se rediseña el backfill de deduplicación. NO se toca
// Company/Lead/Opportunity/Activity/AgentTask ni el código del
// scheduler — solo se reutiliza exactamente el mismo modelo y forma
// que markCompanyProcessed() ya usa para marcar una Company como
// procesada.

export const STABILIZATION_MARKER = "illinois-backfill-stabilization";
export const STABILIZATION_REASON = "mission_restrictions_and_pending_dedup_backfill";

// AgentMemory.content es un String libre (no hay campo Json
// estructurado en el modelo real) — los campos "estructurados" que se
// pidió preservar (processedBy/reason/missionTaskId/createdAt) se
// codifican como tokens `clave=valor` dentro de esta misma cadena, de
// modo que sigan siendo identificables/parseables (ej. vía `content: {
// contains: STABILIZATION_MARKER }`) sin inventar un mecanismo nuevo.
export function buildStabilizationContent({ missionTaskId, createdAt }) {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : createdAt;
  return (
    `[${STABILIZATION_MARKER}] Excluida temporalmente del scheduler de prospección ` +
    `mientras se rediseña el backfill de deduplicación de la misión de Illinois. ` +
    `Esta Company NO fue prospectada realmente por este registro. ` +
    `processedBy=${STABILIZATION_MARKER} reason=${STABILIZATION_REASON} missionTaskId=${missionTaskId} createdAt=${iso}`
  );
}

// Misma forma exacta que markCompanyProcessed(): scope ENTITY,
// entityType "company", entityId el id real de la Company, importance
// 0.5 (el mismo default que usa la función real — no se inventa un
// valor especial para distinguir estas filas, esa distinción vive
// únicamente en el contenido de `content`).
export function buildStabilizationMemoryData({ tenantId, agentInstanceId, companyId, missionTaskId, createdAt }) {
  return {
    tenantId,
    agentInstanceId,
    scope: "ENTITY",
    entityType: "company",
    entityId: companyId,
    content: buildStabilizationContent({ missionTaskId, createdAt }),
    importance: 0.5,
  };
}

// Misma condición de elegibilidad exacta que getUnprocessedCompanyIds
// en apps/api/src/modules/agents/memory.ts: status IN (LEAD,PROSPECT) Y
// sin ninguna AgentMemory con entityType="company" para ese id — sin
// límite (a diferencia del scheduler, que solo pide un lote acotado;
// aquí se necesita la cohorte elegible completa para poder validarla
// contra el conteo esperado antes de escribir nada).
export function computeEligibleCompanies(companies, processedEntityIds) {
  const processed = new Set(processedEntityIds);
  return companies.filter((c) => ["LEAD", "PROSPECT"].includes(c.status) && !processed.has(c.id));
}

export function buildStabilizationGuardReport(actual, expected) {
  const failures = [];
  const checks = [
    ["tenantId", actual.tenantId, expected.tenantId],
    ["eligibleCount", actual.eligibleCount, expected.eligibleCount],
  ];
  for (const [name, act, exp] of checks) {
    if (act !== exp) failures.push({ check: name, expected: exp, actual: act });
  }
  return { ok: failures.length === 0, failures };
}

// Deriva los AgentTask "discover_companies" hijos directos de la
// misión — misma cadena de identificación fuerte usada por el dry-run
// del backfill (discoveredByAgentTaskId), nunca una lista manual de
// ids ni una ventana temporal.
export async function resolveDiscoverTaskIds(prisma, tenantId, missionTaskId) {
  const tasks = await prisma.agentTask.findMany({
    where: { tenantId, parentTaskId: missionTaskId, type: "discover_companies" },
    select: { id: true },
  });
  return tasks.map((t) => t.id);
}

export async function loadCohortCompanies(prisma, discoverTaskIds) {
  if (discoverTaskIds.length === 0) return [];
  return prisma.company.findMany({
    where: { discoveredByAgentTaskId: { in: discoverTaskIds } },
    orderBy: { createdAt: "asc" },
  });
}

export async function loadExistingCompanyMemories(prisma, companyIds) {
  if (companyIds.length === 0) return [];
  return prisma.agentMemory.findMany({
    where: { entityType: "company", entityId: { in: companyIds } },
  });
}

// Resuelve el AgentInstance real del Prospecting Agent para el tenant
// — mismo mecanismo de resolución por (tenantId, definition.key) que
// usa el resto del pipeline; nunca se hardcodea un id ni se crea una
// AgentInstance nueva.
export async function resolveProspectingAgentInstanceId(prisma, tenantId) {
  const instance = await prisma.agentInstance.findFirst({
    where: { tenantId, definition: { key: "prospecting" } },
    select: { id: true },
  });
  if (!instance) {
    throw new Error(`No se encontró AgentInstance del Prospecting Agent para tenant ${tenantId}.`);
  }
  return instance.id;
}
