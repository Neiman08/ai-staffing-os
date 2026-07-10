import { z } from "zod";
import { agentTaskListItemSchema } from "./agents";
import { companyOriginSchema, companyVerificationStatusSchema } from "./crm";

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
// existente); los sub-estados de PAUSED_*/CANCELLED/COMPLETED/FAILED
// viven dentro de output.missionState (Json), no en una columna nueva —
// ver la decisión explícita en el addendum de no ensanchar
// AgentTaskStatus. FAILED (bugfix de ciclo de vida): una misión que se
// cae por una excepción real, un timeout global, o el watchdog de
// inactividad, transiciona acá — nunca se queda en RUNNING para siempre.
export const missionStateSchema = z.enum([
  "RUNNING",
  "PAUSED_BY_USER",
  "PAUSED_BUDGET",
  "CANCELLED",
  "COMPLETED",
  "FAILED",
]);
export type MissionState = z.infer<typeof missionStateSchema>;

export const launchMissionInputSchema = z.object({
  instruction: z.string().min(1).max(2000),
});
export type LaunchMissionInput = z.infer<typeof launchMissionInputSchema>;

// "recover" (bugfix de ciclo de vida): herramienta administrativa para
// una misión atascada en RUNNING sin actividad — fuerza la transición a
// FAILED sin depender de ninguna llamada externa (ni siquiera al LLM del
// Executive Report), justamente porque el objetivo es recuperar un caso
// donde algo externo ya no responde.
export const missionActionInputSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "close_now", "recover"]),
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
  // bugfix de ciclo de vida: heartbeat — se actualiza en cada paso real
  // del pipeline; el watchdog del scheduler compara esto contra "ahora"
  // para distinguir una misión activa de una atascada sin inventar un
  // plazo fijo basado en el día calendario.
  progressUpdatedAt: z.string().nullable(),
  // bugfix de ciclo de vida: mensaje de error real cuando missionState
  // es FAILED — nunca null en ese caso, siempre explica qué pasó.
  error: z.string().nullable(),
});
export type MissionListItem = z.infer<typeof missionListItemSchema>;

// F4.5: transparencia — empresa seleccionada por la misión, con su
// procedencia y fuente, para que nunca haya duda de dónde salió cada una.
// F4.5A agrega website/phone/email/confidence/verification — mismos datos
// que Company ya tiene, mostrados acá para no obligar a abrir cada
// registro para ver qué encontró el Discovery Agent.
export const missionCompanySchema = z.object({
  companyId: z.string(),
  companyName: z.string(),
  industryName: z.string(),
  origin: companyOriginSchema,
  sourceUrl: z.string().nullable(),
  website: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  confidenceScore: z.number().nullable(),
  verificationStatus: companyVerificationStatusSchema,
});
export type MissionCompany = z.infer<typeof missionCompanySchema>;

export const missionDetailSchema = missionListItemSchema.extend({
  unrecognizedTerms: z.array(z.string()),
  report: z.string().nullable(), // Executive Report — null mientras RUNNING/PAUSED_*
  childTasks: z.array(agentTaskListItemSchema),
  selectedCompanies: z.array(missionCompanySchema),
});
export type MissionDetail = z.infer<typeof missionDetailSchema>;
