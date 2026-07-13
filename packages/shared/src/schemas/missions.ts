import { z } from "zod";
import { agentTaskListItemSchema } from "./agents";
import { companyOriginSchema, companyVerificationStatusSchema, contactVerificationStatusSchema } from "./crm";

// ============================================================
// F4: Daily Revenue Mission — ver F4_AUTONOMOUS_OUTREACH_PLAN.md,
// addendum "Daily Revenue Mission y camino hacia autonomía externa".
// NO tiene modelo propio: es un AgentTask raíz (type:
// "daily_revenue_mission") con parentTaskId plano hacia sus tareas
// delegadas. Objetivo/filtros viven en AgentTask.input; progreso/reporte
// viven en AgentTask.output — estos schemas describen esa forma para la
// API, no una tabla nueva.
// ============================================================

// Corrección estructural (misión Iowa, 2026-07-13): espejo de
// packages/agents/src/tools/mission-restrictions.ts — packages/shared no
// puede importar de packages/agents (dependencia va al revés, ver
// package.json), así que este shape simple (4 booleanos) se duplica acá
// a propósito, mismo criterio ya usado para otros enums espejados entre
// capas en este proyecto.
export const missionRestrictionsSchema = z.object({
  allowCampaignCreation: z.boolean(),
  allowOpportunityCreation: z.boolean(),
  allowOutreach: z.boolean(),
  allowMessageSending: z.boolean(),
});
export type MissionRestrictions = z.infer<typeof missionRestrictionsSchema>;

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
// existente); los sub-estados de PAUSED_*/CANCELLED/COMPLETED/FAILED/
// PARTIAL viven dentro de output.missionState (Json), no en una columna
// nueva — ver la decisión explícita en el addendum de no ensanchar
// AgentTaskStatus. FAILED (bugfix de ciclo de vida): una misión que se
// cae por una excepción real, un timeout global, o el watchdog de
// inactividad, transiciona acá — nunca se queda en RUNNING para siempre.
// PARTIAL (corrección estructural, misión Iowa 2026-07-13): el pipeline
// corrió de punta a punta sin excepciones, pero no logró lo que la
// instrucción pedía (ej. "buscá contactos" y quedaron empresas sin
// ningún punto de contacto, real o organizacional) — antes esto se
// reportaba como COMPLETED sin ninguna distinción, presentando un
// resultado incompleto como si fuera un éxito total. Ver
// contactCoverage en missionDetailSchema para el detalle honesto de qué
// faltó y por qué.
export const missionStateSchema = z.enum([
  "RUNNING",
  "PAUSED_BY_USER",
  "PAUSED_BUDGET",
  "CANCELLED",
  "COMPLETED",
  "PARTIAL",
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
  // Corrección estructural (misión Iowa, 2026-07-13): qué restricciones
  // pidió la instrucción y qué se saltó por eso — nunca silencioso. null
  // en misiones lanzadas antes de este fix (no tenían este campo).
  appliedRestrictions: missionRestrictionsSchema.nullable(),
  restrictionNotes: z.array(z.string()),
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

// F4.6: contacto encontrado por el Contact Intelligence Agent para una
// empresa que ESTA misión descubrió — mismo principio de transparencia.
export const missionContactSchema = z.object({
  contactId: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  title: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  source: z.string().nullable(),
  confidenceScore: z.number().nullable(),
  verificationStatus: contactVerificationStatusSchema,
  discoveredAt: z.string().nullable(),
});
export type MissionContact = z.infer<typeof missionContactSchema>;

// F4.6: cadena de métricas de Mission Detail — "Empresas descubiertas →
// Contactos encontrados → Contactos verificados → Emails encontrados →
// LinkedIn encontrados → Costo → Tiempo", todo real, agregado de las
// tareas find_contacts que esta misión delegó.
export const missionContactStatsSchema = z.object({
  companiesDiscovered: z.number(),
  contactsFound: z.number(),
  contactsVerified: z.number(),
  emailsFound: z.number(),
  linkedinFound: z.number(),
  costUsd: z.number(),
  durationMs: z.number().nullable(), // null si no hubo ninguna tarea find_contacts todavía
});
export type MissionContactStats = z.infer<typeof missionContactStatsSchema>;

// Corrección estructural (misión Iowa, 2026-07-13): antes, "0 contactos"
// no se distinguía de "no se buscaron contactos" ni de "el proveedor no
// pudo responder" — esto lo hace explícito. companiesWithContactPoint
// cuenta tanto Contact nombrados como Company.email organizacional
// (ver §6 del pedido: un email genérico real sin persona identificada
// también cuenta como punto de contacto).
export const missionContactCoverageSchema = z.object({
  companiesConsidered: z.number(),
  companiesWithContactPoint: z.number(),
  companiesWithoutContactPoint: z.number(),
  providersOmitted: z.array(z.string()),
});
export type MissionContactCoverage = z.infer<typeof missionContactCoverageSchema>;

export const missionDetailSchema = missionListItemSchema.extend({
  unrecognizedTerms: z.array(z.string()),
  report: z.string().nullable(), // Executive Report — null mientras RUNNING/PAUSED_*
  childTasks: z.array(agentTaskListItemSchema),
  selectedCompanies: z.array(missionCompanySchema),
  contacts: z.array(missionContactSchema),
  contactStats: missionContactStatsSchema,
  contactCoverage: missionContactCoverageSchema.nullable(),
});
export type MissionDetail = z.infer<typeof missionDetailSchema>;
