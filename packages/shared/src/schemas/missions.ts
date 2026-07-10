import { z } from "zod";
import { agentTaskListItemSchema } from "./agents";
import { companyOriginSchema } from "./crm";

// ============================================================
// F4: Daily Revenue Mission — ver F4_AUTONOMOUS_OUTREACH_PLAN.md,
// addendum "Daily Revenue Mission y camino hacia autonomía externa".
// NO tiene modelo propio: es un AgentTask raíz (type:
// "daily_revenue_mission") con parentTaskId plano hacia sus tareas
// delegadas. Objetivo/filtros viven en AgentTask.input; progreso/reporte
// viven en AgentTask.output — estos schemas describen esa forma para la
// API, no una tabla nueva.
// ============================================================

export const businessObjectiveTypeSchema = z.enum([
  "meetings",
  "new_clients",
  "companies_found",
  "pipeline_increase",
  "custom",
]);

export const businessObjectiveSchema = z.object({
  type: businessObjectiveTypeSchema,
  target: z.number().positive().nullable(),
  unit: z.string(),
  rawText: z.string(),
});
export type BusinessObjective = z.infer<typeof businessObjectiveSchema>;

export const objectiveProgressSchema = z.object({
  type: businessObjectiveTypeSchema,
  target: z.number().nullable(),
  unit: z.string(),
  current: z.number(),
  percentComplete: z.number().nullable(),
  rawText: z.string(),
});
export type ObjectiveProgress = z.infer<typeof objectiveProgressSchema>;

// "RUNNING"/"DONE"/"FAILED" son el AgentTask.status real (enum ya
// existente); los sub-estados de PAUSED_*/CANCELLED/COMPLETED viven
// dentro de output.missionState (Json), no en una columna nueva — ver
// la decisión explícita en el addendum de no ensanchar AgentTaskStatus.
export const missionStateSchema = z.enum([
  "RUNNING",
  "PAUSED_BY_USER",
  "PAUSED_BUDGET",
  "CANCELLED",
  "COMPLETED",
]);
export type MissionState = z.infer<typeof missionStateSchema>;

export const launchMissionInputSchema = z.object({
  instruction: z.string().min(1).max(2000),
});
export type LaunchMissionInput = z.infer<typeof launchMissionInputSchema>;

export const missionActionInputSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "close_now"]),
});
export type MissionActionInput = z.infer<typeof missionActionInputSchema>;

export const missionListItemSchema = z.object({
  id: z.string(),
  rawInstruction: z.string(),
  industryNames: z.array(z.string()),
  state: z.string().nullable(),
  city: z.string().nullable(),
  categoryNames: z.array(z.string()),
  desiredVolume: z.number().nullable(),
  businessObjective: businessObjectiveSchema,
  missionState: missionStateSchema,
  companiesTargeted: z.number(),
  leadsCreated: z.number(),
  opportunitiesCreated: z.number(),
  sequencesPlanned: z.number(),
  draftsAwaitingApproval: z.number(),
  costUsdSoFar: z.number(),
  objectiveProgress: objectiveProgressSchema,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type MissionListItem = z.infer<typeof missionListItemSchema>;

// F4.5: transparencia — empresa seleccionada por la misión, con su
// procedencia y fuente, para que nunca haya duda de dónde salió cada una.
export const missionCompanySchema = z.object({
  companyId: z.string(),
  companyName: z.string(),
  industryName: z.string(),
  origin: companyOriginSchema,
  sourceUrl: z.string().nullable(),
});
export type MissionCompany = z.infer<typeof missionCompanySchema>;

export const missionDetailSchema = missionListItemSchema.extend({
  unrecognizedTerms: z.array(z.string()),
  report: z.string().nullable(), // Executive Report — null mientras RUNNING/PAUSED_*
  childTasks: z.array(agentTaskListItemSchema),
  selectedCompanies: z.array(missionCompanySchema),
});
export type MissionDetail = z.infer<typeof missionDetailSchema>;
