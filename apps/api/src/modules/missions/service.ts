import type { AgentTaskDetail, MissionActionInput, MissionDetail, MissionListItem } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { applyMissionAction, launchMission } from "../agents/mission-orchestrator";
import { planMissionOnly } from "../agents/mission-planning";
import { toAgentTaskDetail } from "../agents/task-executor";

// F14: ID legible humano MIS-YYYYMMDD-NNNN -- NUNCA reemplaza el id
// interno (cuid, sigue siendo la clave real para todas las rutas/FKs),
// solo un alias legible para mostrar en UI/reportes. NNNN es el rango
// 1-based de esta misión entre las lanzadas ese mismo día calendario
// (UTC) para este tenant.
function formatMissionCode(createdAtIso: string, rank: number): string {
  const compact = createdAtIso.slice(0, 10).replace(/-/g, "");
  return `MIS-${compact}-${String(rank).padStart(4, "0")}`;
}

// F14: resuelve userId -> {name, email} en lote -- nunca N+1 queries
// para una lista de misiones. Ids ausentes (misión lanzada antes de
// este fix, o usuario borrado) simplemente no aparecen en el mapa.
async function resolveLaunchedByMap(userIds: string[]): Promise<Map<string, { name: string; email: string }>> {
  const uniqueIds = Array.from(new Set(userIds));
  if (uniqueIds.length === 0) return new Map();
  const users = await scopedDb.user.findMany({ where: { id: { in: uniqueIds } } });
  return new Map(users.map((u) => [u.id, { name: `${u.firstName} ${u.lastName}`.trim(), email: u.email }]));
}

interface MissionMetadata {
  missionCode: string;
  durationMs: number | null;
  launchedByUserId: string | null;
  launchedByName: string | null;
  launchedByEmail: string | null;
}

function toListItem(task: AgentTaskDetail, meta: MissionMetadata): MissionListItem {
  const input = task.input as {
    rawInstruction: string;
    industryNames?: string[];
    state?: string | null;
    city?: string | null;
    categoryNames?: string[];
    desiredVolume?: number | null;
    businessObjective?: MissionListItem["businessObjective"];
  };
  const output = (task.output ?? {}) as Partial<MissionListItem> & { missionState?: string };

  return {
    missionCode: meta.missionCode,
    durationMs: meta.durationMs,
    launchedByUserId: meta.launchedByUserId,
    launchedByName: meta.launchedByName,
    launchedByEmail: meta.launchedByEmail,
    id: task.id,
    rawInstruction: input.rawInstruction,
    industryNames: input.industryNames ?? [],
    state: input.state ?? null,
    city: input.city ?? null,
    categoryNames: input.categoryNames ?? [],
    desiredVolume: input.desiredVolume ?? null,
    businessObjective: input.businessObjective ?? {
      type: "custom",
      target: null,
      unit: "",
      rawText: "",
    },
    missionState: (output.missionState as MissionListItem["missionState"]) ?? "RUNNING",
    companiesTargeted: output.companiesTargeted ?? 0,
    leadsCreated: output.leadsCreated ?? 0,
    opportunitiesCreated: output.opportunitiesCreated ?? 0,
    sequencesPlanned: output.sequencesPlanned ?? 0,
    draftsAwaitingApproval: output.draftsAwaitingApproval ?? 0,
    costUsdSoFar: output.costUsdSoFar ?? 0,
    objectiveProgress: (output as { objectiveProgress?: MissionListItem["objectiveProgress"] }).objectiveProgress ?? {
      type: "custom",
      target: null,
      unit: "",
      current: 0,
      percentComplete: null,
      rawText: "",
    },
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    progressUpdatedAt: (output as { progressUpdatedAt?: string | null }).progressUpdatedAt ?? null,
    error: (output as { error?: string | null }).error ?? (task.status === "FAILED" ? task.errorMessage : null),
    // Corrección estructural (misión Iowa, 2026-07-13): null/[] en
    // misiones lanzadas antes de este fix — no tenían este campo.
    appliedRestrictions:
      (output as { appliedRestrictions?: MissionListItem["appliedRestrictions"] }).appliedRestrictions ?? null,
    restrictionNotes: (output as { restrictionNotes?: string[] }).restrictionNotes ?? [],
    // F7.2: null en toda misión que no pasó por planMissionOnly (todas
    // las anteriores, y cualquier misión real vieja) — se interpreta
    // como "EXECUTING" por compatibilidad, nunca inferido a la fuerza.
    missionPhase: (output as { missionPhase?: MissionListItem["missionPhase"] }).missionPhase ?? null,
  };
}

// F14: metadata de UNA misión (rango del día vía COUNT real, launchedBy
// vía lookup único) -- usado por createMission/createMissionPlan/
// getMissionDetail, donde no vale la pena el batching de listMissions.
async function computeMissionMetadata(task: AgentTaskDetail): Promise<MissionMetadata> {
  const createdAt = new Date(task.createdAt);
  const completedAt = task.completedAt ? new Date(task.completedAt) : null;
  const dayStart = new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate()));
  const rank = await scopedDb.agentTask.count({
    where: { type: "daily_revenue_mission", createdAt: { gte: dayStart, lte: createdAt } },
  });
  const launchedByUserId = (task.input as { launchedByUserId?: string | null }).launchedByUserId ?? null;
  const launchedByMap = await resolveLaunchedByMap(launchedByUserId ? [launchedByUserId] : []);
  const launchedBy = launchedByUserId ? launchedByMap.get(launchedByUserId) : undefined;
  return {
    missionCode: formatMissionCode(task.createdAt, rank),
    durationMs: completedAt ? completedAt.getTime() - createdAt.getTime() : null,
    launchedByUserId,
    launchedByName: launchedBy?.name ?? null,
    launchedByEmail: launchedBy?.email ?? null,
  };
}

/** POST /missions — lanza una Daily Revenue Mission a partir de una instrucción en lenguaje natural. */
export async function createMission(instruction: string): Promise<MissionListItem> {
  const task = await launchMission(instruction);
  return toListItem(task, await computeMissionMetadata(task));
}

/**
 * F7.2: POST /missions/plan — crea una misión en modo SOLO
 * PLANIFICACIÓN (interpreta + arma el Mission Plan, nunca ejecuta nada).
 * Camino separado de createMission/launchMission — ver la estrategia de
 * coexistencia documentada en mission-planning.ts.
 */
export async function createMissionPlan(instruction: string): Promise<MissionListItem> {
  const task = await planMissionOnly(instruction);
  return toListItem(task, await computeMissionMetadata(task));
}

export async function listMissions(): Promise<MissionListItem[]> {
  const ceoInstance = await scopedDb.agentInstance.findFirst({ where: { definition: { key: "ceo" } } });
  if (!ceoInstance) return [];

  const tasks = await scopedDb.agentTask.findMany({
    where: { agentInstanceId: ceoInstance.id, type: "daily_revenue_mission" },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  const details = await Promise.all(tasks.map((t) => toAgentTaskDetail(t)));

  // F14: rango 1-based por día calendario (UTC), calculado SOLO entre
  // las misiones visibles acá (las 30 más recientes) -- evita N+1
  // queries de COUNT. Aproximación documentada: dado que este sistema
  // ya fuerza como mucho una Daily Revenue Mission activa por día
  // (launchMission, arriba), en la práctica esto siempre coincide con
  // el rango real; solo podría divergir si algún día tuvo más misiones
  // que las que entran en esta ventana de 30, algo que hoy no ocurre.
  const ascByCreatedAt = [...details].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const missionCodes = new Map<string, string>();
  let currentDayKey = "";
  let rank = 0;
  for (const t of ascByCreatedAt) {
    const dayKey = t.createdAt.slice(0, 10);
    if (dayKey !== currentDayKey) {
      currentDayKey = dayKey;
      rank = 0;
    }
    rank += 1;
    missionCodes.set(t.id, formatMissionCode(t.createdAt, rank));
  }

  const launchedByUserIds = details
    .map((t) => (t.input as { launchedByUserId?: string | null }).launchedByUserId)
    .filter((id): id is string => !!id);
  const launchedByMap = await resolveLaunchedByMap(launchedByUserIds);

  return details.map((t) => {
    const launchedByUserId = (t.input as { launchedByUserId?: string | null }).launchedByUserId ?? null;
    const launchedBy = launchedByUserId ? launchedByMap.get(launchedByUserId) : undefined;
    return toListItem(t, {
      missionCode: missionCodes.get(t.id)!,
      durationMs: t.completedAt ? new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime() : null,
      launchedByUserId,
      launchedByName: launchedBy?.name ?? null,
      launchedByEmail: launchedBy?.email ?? null,
    });
  });
}

export async function getMissionDetail(id: string): Promise<MissionDetail> {
  const task = await scopedDb.agentTask.findUnique({ where: { id } });
  if (!task || task.type !== "daily_revenue_mission") throw AppError.notFound("Mission not found");

  const [detail, childTasks] = await Promise.all([
    toAgentTaskDetail(task),
    scopedDb.agentTask.findMany({ where: { parentTaskId: id }, orderBy: { createdAt: "asc" } }),
  ]);

  const listItem = toListItem(detail, await computeMissionMetadata(detail));
  const output = (detail.output ?? {}) as {
    report?: string | null;
    contactCoverage?: MissionDetail["contactCoverage"];
    ceoIntent?: MissionDetail["ceoIntent"];
    missionPlan?: MissionDetail["missionPlan"];
    ceoIntentMeta?: MissionDetail["ceoIntentMeta"];
    discoveryExecution?: MissionDetail["discoveryExecution"];
    discoveryFallback?: MissionDetail["discoveryFallback"];
  };
  const input = detail.input as { unrecognizedTerms?: string[] };

  // F4.5: las empresas "seleccionadas" por la misión son las CampaignCompany
  // de las campañas que esta misión creó (child tasks type create_campaign) —
  // no hay relación directa Mission->Company en el schema, se deriva.
  const campaignIds = childTasks
    .filter((t) => t.type === "create_campaign" && t.output)
    .map((t) => (t.output as { campaignId?: string }).campaignId)
    .filter((id): id is string => Boolean(id));

  const campaignCompanies = campaignIds.length
    ? await scopedDb.campaignCompany.findMany({
        where: { campaignId: { in: campaignIds } },
        include: { company: { include: { industry: true } } },
        orderBy: { createdAt: "asc" },
      })
    : [];

  // Corrección estructural (misión Iowa, 2026-07-13): cuando la misión
  // corrió con `allowCampaignCreation=false`, no hay ninguna Campaign ni
  // CampaignCompany — antes, `selectedCompanies` dependía EXCLUSIVAMENTE
  // de CampaignCompany, así que una misión sin campaña reportaba "0
  // empresas" en Mission Detail pese a haber encontrado/procesado
  // empresas reales. Se completa con las Company que las tareas hijas
  // (discover_companies/find_contacts/find_email/score_company/
  // create_lead) tocaron realmente, sin depender de que exista campaña.
  const companyIdsFromChildTasks = new Set<string>();
  for (const t of childTasks) {
    if (t.type === "discover_companies" && t.output) {
      const created = (t.output as { companiesCreated?: Array<{ companyId: string }> }).companiesCreated ?? [];
      for (const c of created) companyIdsFromChildTasks.add(c.companyId);
    }
    if (["find_contacts", "find_email", "score_company"].includes(t.type)) {
      const companyId = (t.input as { companyId?: string } | null)?.companyId;
      if (companyId) companyIdsFromChildTasks.add(companyId);
    }
    if (t.type === "create_lead" && t.output) {
      const leadCompanyId = (t.input as { companyId?: string } | null)?.companyId;
      if (leadCompanyId) companyIdsFromChildTasks.add(leadCompanyId);
    }
  }
  // F7.3: el ejecutor dinámico (mission-executor.ts) persiste
  // createdCompanyIds en su propio AgentTask hijo "discover_companies",
  // con una forma de output distinta a la del AgentTool clásico (arriba)
  // — se suman acá para que "Empresas seleccionadas" también las
  // muestre, reusando la misma sección en vez de inventar una nueva.
  for (const companyId of output.discoveryExecution?.createdCompanyIds ?? []) {
    companyIdsFromChildTasks.add(companyId);
  }
  // F13: mismo motivo -- el fallback automático (mission-orchestrator.ts,
  // runAutoExternalDiscoveryFallback) también persiste createdCompanyIds
  // en su propio discoveryFallback, no solo en discoveryExecution.
  for (const companyId of output.discoveryFallback?.createdCompanyIds ?? []) {
    companyIdsFromChildTasks.add(companyId);
  }
  const campaignCompanyIds = new Set(campaignCompanies.map((cc) => cc.companyId));
  const extraCompanyIds = Array.from(companyIdsFromChildTasks).filter((id) => !campaignCompanyIds.has(id));
  const extraCompanies = extraCompanyIds.length
    ? await scopedDb.company.findMany({ where: { id: { in: extraCompanyIds } }, include: { industry: true } })
    : [];

  // F4.6: cadena de métricas de Contact Intelligence — agregada de las
  // tareas find_contacts reales que esta misión delegó, nunca estimada.
  const discoverTasks = childTasks.filter((t) => t.type === "discover_companies" && t.output);
  const companiesDiscovered = discoverTasks.reduce(
    (sum, t) => sum + ((t.output as { companiesCreated?: unknown[] } | null)?.companiesCreated?.length ?? 0),
    0,
  );

  const findContactsTasks = childTasks.filter((t) => t.type === "find_contacts");
  const findContactsTaskIds = findContactsTasks.map((t) => t.id);
  // F4.7: find_email es el mismo agente (Contact Intelligence, ampliado)
  // corriendo justo después de find_contacts para cada Company — se suma
  // al mismo costo/tiempo de la cadena, no es una fase aparte.
  const findEmailTasks = childTasks.filter((t) => t.type === "find_email");
  const contactIntelligenceTasks = [...findContactsTasks, ...findEmailTasks];
  const costUsdFromContacts = contactIntelligenceTasks.reduce((sum, t) => sum + Number(t.costUsd ?? 0), 0);
  const durationMs = contactIntelligenceTasks.some((t) => t.completedAt)
    ? contactIntelligenceTasks.reduce((sum, t) => (t.completedAt ? sum + (t.completedAt.getTime() - t.createdAt.getTime()) : sum), 0)
    : null;

  const missionContacts = findContactsTaskIds.length
    ? await scopedDb.contact.findMany({
        where: { discoveredByAgentTaskId: { in: findContactsTaskIds } },
        include: { company: true },
        orderBy: { discoveredAt: "asc" },
      })
    : [];

  return {
    ...listItem,
    unrecognizedTerms: input.unrecognizedTerms ?? [],
    report: output.report ?? null,
    childTasks: await Promise.all(childTasks.map((t) => toAgentTaskDetail(t))),
    selectedCompanies: [
      ...campaignCompanies.map((cc) => ({
        companyId: cc.companyId,
        companyName: cc.company.name,
        industryName: cc.company.industry.name,
        origin: cc.company.origin,
        sourceUrl: cc.company.sourceUrl,
        website: cc.company.website,
        phone: cc.company.phone,
        email: cc.company.email,
        confidenceScore: cc.company.confidenceScore,
        verificationStatus: cc.company.verificationStatus,
      })),
      ...extraCompanies.map((c) => ({
        companyId: c.id,
        companyName: c.name,
        industryName: c.industry.name,
        origin: c.origin,
        sourceUrl: c.sourceUrl,
        website: c.website,
        phone: c.phone,
        email: c.email,
        confidenceScore: c.confidenceScore,
        verificationStatus: c.verificationStatus,
      })),
    ],
    contacts: missionContacts.map((c) => ({
      contactId: c.id,
      companyId: c.companyId,
      companyName: c.company.name,
      firstName: c.firstName,
      lastName: c.lastName,
      title: c.title,
      email: c.email,
      phone: c.phone,
      linkedinUrl: c.linkedinUrl,
      source: c.source,
      confidenceScore: c.confidenceScore,
      verificationStatus: c.verificationStatus,
      discoveredAt: c.discoveredAt?.toISOString() ?? null,
    })),
    contactStats: {
      companiesDiscovered,
      contactsFound: missionContacts.length,
      contactsVerified: missionContacts.filter((c) => c.verificationStatus === "CONFIRMED").length,
      emailsFound: missionContacts.filter((c) => !!c.email).length,
      linkedinFound: missionContacts.filter((c) => !!c.linkedinUrl).length,
      costUsd: costUsdFromContacts,
      durationMs,
    },
    contactCoverage: output.contactCoverage ?? null,
    // F7.2: null en toda misión que no pasó por planMissionOnly.
    ceoIntent: output.ceoIntent ?? null,
    missionPlan: output.missionPlan ?? null,
    ceoIntentMeta: output.ceoIntentMeta ?? null,
    // F7.3: null en toda misión que no ejecutó el nuevo ejecutor dinámico
    // de descubrimiento (legacy, planned-only, o internal-CRM-search).
    discoveryExecution: output.discoveryExecution ?? null,
    // F13: null en toda misión que encontró suficiente oferta interna sin
    // necesitar el fallback automático de descubrimiento externo.
    discoveryFallback: output.discoveryFallback ?? null,
  };
}

export async function decideMissionAction(id: string, input: MissionActionInput): Promise<MissionListItem> {
  const task = await applyMissionAction(id, input.action);
  return toListItem(task, await computeMissionMetadata(task));
}
