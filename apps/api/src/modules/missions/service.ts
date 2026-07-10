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

  return {
    ...listItem,
    unrecognizedTerms: input.unrecognizedTerms ?? [],
    report: output.report ?? null,
    childTasks: await Promise.all(childTasks.map((t) => toAgentTaskDetail(t))),
  };
}

export async function decideMissionAction(id: string, input: MissionActionInput): Promise<MissionListItem> {
  const task = await applyMissionAction(id, input.action);
  return toListItem(task);
}
