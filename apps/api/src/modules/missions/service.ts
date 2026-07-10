import type { AgentTaskDetail, MissionActionInput, MissionDetail, MissionListItem } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { applyMissionAction, launchMission } from "../agents/mission-orchestrator";
import { toAgentTaskDetail } from "../agents/task-executor";

function toListItem(task: AgentTaskDetail): MissionListItem {
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
  };
}

/** POST /missions — lanza una Daily Revenue Mission a partir de una instrucción en lenguaje natural. */
export async function createMission(instruction: string): Promise<MissionListItem> {
  const task = await launchMission(instruction);
  return toListItem(task);
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
  return details.map(toListItem);
}

export async function getMissionDetail(id: string): Promise<MissionDetail> {
  const task = await scopedDb.agentTask.findUnique({ where: { id } });
  if (!task || task.type !== "daily_revenue_mission") throw AppError.notFound("Mission not found");

  const [detail, childTasks] = await Promise.all([
    toAgentTaskDetail(task),
    scopedDb.agentTask.findMany({ where: { parentTaskId: id }, orderBy: { createdAt: "asc" } }),
  ]);

  const listItem = toListItem(detail);
  const output = (detail.output ?? {}) as { report?: string | null };
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

  // F4.6: cadena de métricas de Contact Intelligence — agregada de las
  // tareas find_contacts reales que esta misión delegó, nunca estimada.
  const discoverTasks = childTasks.filter((t) => t.type === "discover_companies" && t.output);
  const companiesDiscovered = discoverTasks.reduce(
    (sum, t) => sum + ((t.output as { companiesCreated?: unknown[] } | null)?.companiesCreated?.length ?? 0),
    0,
  );

  const findContactsTasks = childTasks.filter((t) => t.type === "find_contacts");
  const findContactsTaskIds = findContactsTasks.map((t) => t.id);
  const costUsdFromContacts = findContactsTasks.reduce((sum, t) => sum + Number(t.costUsd ?? 0), 0);
  const durationMs = findContactsTasks.some((t) => t.completedAt)
    ? findContactsTasks.reduce((sum, t) => (t.completedAt ? sum + (t.completedAt.getTime() - t.createdAt.getTime()) : sum), 0)
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
    selectedCompanies: campaignCompanies.map((cc) => ({
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
  };
}

export async function decideMissionAction(id: string, input: MissionActionInput): Promise<MissionListItem> {
  const task = await applyMissionAction(id, input.action);
  return toListItem(task);
}
