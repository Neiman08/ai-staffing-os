import { z } from "zod";
import type { AgentTool } from "../core/AgentTool";
import { NotImplementedError } from "../core/AgentRuntime";

function notImplemented<TInput, TOutput>(): (input: TInput) => Promise<TOutput> {
  return async () => {
    throw new NotImplementedError("F4");
  };
}

/**
 * F4: CEO Agent — deja de ser stub (tools: [] desde F0). Ver
 * F4_AUTONOMOUS_OUTREACH_PLAN.md, addendum "Daily Revenue Mission".
 *
 * interpretDailyDirective es el ÚNICO tool de este agente con LLM real.
 * Su salida es estructurada y validada contra el vocabulario cerrado de
 * industrias/categorías reales del tenant — el LLM nunca decide qué tool
 * llamar ni en qué orden; eso lo hace una secuencia fija en código
 * (mission-orchestrator.ts, apps/api). El CEO Agent es un orquestador
 * acotado y determinista, no un planificador libre.
 */
export const businessObjectiveSchema = z.object({
  type: z.enum(["meetings", "new_clients", "companies_found", "pipeline_increase", "custom"]),
  target: z.number().positive().nullable(),
  unit: z.string(),
  rawText: z.string(),
});
export type BusinessObjective = z.infer<typeof businessObjectiveSchema>;

export const interpretDailyDirectiveInputSchema = z.object({
  rawInstruction: z.string().min(1).max(2000),
});
export interface InterpretDailyDirectiveResult {
  industryNames: string[];
  state: string | null;
  city: string | null;
  categoryNames: string[];
  desiredVolume: number | null;
  businessObjective: BusinessObjective;
  unrecognizedTerms: string[];
}
export const interpretDailyDirectiveTool: AgentTool<
  z.infer<typeof interpretDailyDirectiveInputSchema>,
  InterpretDailyDirectiveResult
> = {
  name: "interpretDailyDirective",
  description:
    "Interpreta una instrucción diaria en lenguaje natural en criterios estructurados (industria/ubicación/categorías/volumen/objetivo de negocio), usando solo nombres reales del tenant — nunca inventa una industria o categoría.",
  inputSchema: interpretDailyDirectiveInputSchema,
  execute: notImplemented(),
};

export const objectiveProgressSchema = z.object({
  type: businessObjectiveSchema.shape.type,
  target: z.number().nullable(),
  unit: z.string(),
  current: z.number(),
  percentComplete: z.number().nullable(),
  rawText: z.string(),
});
export type ObjectiveProgress = z.infer<typeof objectiveProgressSchema>;

export const closeDailyMissionInputSchema = z.object({
  missionTaskId: z.string(),
});
export interface CloseDailyMissionResult {
  report: string;
  objectiveProgress: ObjectiveProgress;
}
export const closeDailyMissionTool: AgentTool<z.infer<typeof closeDailyMissionInputSchema>, CloseDailyMissionResult> = {
  name: "closeDailyMission",
  description:
    "Genera el Executive Report de cierre de una Daily Revenue Mission: agrega los resultados reales de sus tareas hijas y declara el cumplimiento del business objective.",
  inputSchema: closeDailyMissionInputSchema,
  execute: notImplemented(),
};
