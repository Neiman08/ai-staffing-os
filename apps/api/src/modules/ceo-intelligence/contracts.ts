import { z } from "zod";
import { missionRestrictionsSchema } from "@ai-staffing-os/agents";

// F7.1: contratos de "CEO Intelligence" — Business Taxonomy + Intent
// Understanding + Mission Planner. Todo este módulo es deliberadamente
// puro (sin Prisma, sin LLMProvider, sin fetch): completamente
// determinista, tal como exige el plan aprobado
// (docs/F7_CEO_INTELLIGENCE_AND_AUTONOMOUS_CLIENT_ACQUISITION_PLAN.md).
// `missionRestrictionsSchema` se reutiliza tal cual desde
// packages/agents (ya probado, ya usado por el pipeline real de F4) —
// nunca se reinventa un schema paralelo para el mismo concepto.

// ---------- Business Taxonomy ----------

export const businessTaxonomyEntrySchema = z.object({
  // Identificador estable, nunca cambia entre versiones (ej. "hotel",
  // "food_manufacturing") — lo que sí puede cambiar es el contenido de
  // la entrada, versionado por `version`.
  key: z.string().min(1),
  label: z.string().min(1),
  // Términos en lenguaje natural (español + inglés) que activan esta
  // entrada — nunca una sola palabra aislada sin contexto real.
  synonyms: z.array(z.string().min(1)).min(1),
  // Tipos de empresa en inglés, listos para mostrar en UI/reportes.
  companyTypes: z.array(z.string().min(1)).min(1),
  // Industria REAL del CRM bajo la cual archivar (Company.industryId) —
  // null cuando ninguna de las Industry existentes hoy es un match
  // razonable (nunca se inventa una industria nueva acá, ver plan §9.4:
  // crear industrias reales es una decisión de F5/F6 territory, fuera
  // de alcance de F7.1).
  crmIndustryBucket: z.string().nullable(),
  // Frases de búsqueda listas para un proveedor tipo Google Places (texto
  // libre en inglés).
  googleSearchPhrases: z.array(z.string().min(1)).min(1),
  // Frases a buscar en el sitio/crawl de una empresa para validar que
  // realmente pertenece a este tipo de negocio (Business Validation,
  // F7.6 — acá solo se declaran, todavía no se usan).
  websitePhrases: z.array(z.string().min(1)),
  // Títulos de trabajo típicos que señalan necesidad de personal en este
  // tipo de negocio (Hiring Signal Intelligence, F7.7).
  jobTitles: z.array(z.string().min(1)),
  // Cargos de decisión típicos para prospección comercial.
  decisionMakers: z.array(z.string().min(1)).min(1),
  // Palabras que, si aparecen, sugieren que un match es falso positivo
  // (ej. "staffing agency" para una búsqueda de hoteles reales) — insumo
  // para Business Validation (F7.6), no se aplica todavía en F7.1.
  negativeKeywords: z.array(z.string().min(1)),
  // Otras keys de esta misma taxonomía relacionadas (ej. food_manufacturing
  // <-> beverage_manufacturing <-> packaging) — para sugerencias futuras,
  // nunca se auto-incluyen en una búsqueda sin que el usuario las pida.
  relatedIndustries: z.array(z.string()),
  // Reglas humanas de validación (evidencia esperada) — insumo de F7.6,
  // texto descriptivo, no código ejecutable.
  validations: z.array(z.string().min(1)).min(1),
  // F14 (refinamiento de calidad, 2026-07-19): true para categorías
  // "paraguas" genéricas (Construction, Manufacturing, Warehousing,
  // Distribution, Healthcare, Retail, Transportation) que casi siempre
  // matchean JUNTO a una entrada más específica de la misma familia
  // (ej. "electrical"/"roofing" junto a "construction"). El planner
  // (mission-planner.ts) usa esto para ordenar: TODAS las entradas
  // específicas primero, las genéricas solo al final, como último
  // recurso -- nunca al revés (hallazgo real: "contratistas eléctricos
  // en Texas" devolvía constructoras generales porque "construction
  // company" corría antes que "electrical contractor").
  isGenericFallback: z.boolean(),
  version: z.number().int().positive(),
});
export type BusinessTaxonomyEntry = z.infer<typeof businessTaxonomyEntrySchema>;

// ---------- Objetivo de la misión ----------

export const missionObjectiveTypeSchema = z.enum([
  "find_companies",
  "find_contacts",
  "find_hiring_signals",
  "custom",
]);
export type MissionObjectiveType = z.infer<typeof missionObjectiveTypeSchema>;

export const missionObjectiveSchema = z.object({
  type: missionObjectiveTypeSchema,
  targetCompanyCount: z.number().int().positive().nullable(),
  rawText: z.string(),
});
export type MissionObjective = z.infer<typeof missionObjectiveSchema>;

// ---------- Pasos posibles de un Mission Plan ----------
// Vocabulario cerrado de pasos — el mismo enum se usa tanto para
// "plannedSteps" (StructuredIntent, un resumen liviano) como para
// "steps"/"requiredSteps"/"optionalSteps" (MissionPlan, el detalle
// completo). Ninguno de estos pasos se ejecuta en F7.1 — son
// declaraciones de intención, no invocaciones reales.
export const missionPlanStepSchema = z.enum([
  "discover_companies",
  "validate_business_type",
  "find_hiring_signals",
  "find_contacts",
  "find_organizational_emails",
  "verify_emails",
]);
export type MissionPlanStep = z.infer<typeof missionPlanStepSchema>;

// ---------- StructuredIntent (salida del intérprete) ----------

export const structuredIntentSchema = z.object({
  schemaVersion: z.literal(1),
  rawInstruction: z.string(),
  objective: missionObjectiveSchema,
  companyTypes: z.array(z.string()),
  // Nombres reales de Industry a usar como bucket de archivo — puede
  // quedar vacío cuando ninguna taxonomía matcheada tiene un
  // crmIndustryBucket real (ver businessTaxonomyEntrySchema).
  industries: z.array(z.string()),
  businessActivities: z.array(z.string()),
  searchTerms: z.array(z.string()),
  hiringSignals: z.array(z.string()),
  decisionRoles: z.array(z.string()),
  targetJobTitles: z.array(z.string()),
  // Nunca puede solaparse con searchTerms — se valida en el intérprete,
  // nunca solo se confía en que el texto de origen ya los separó bien
  // (ver regla no-negociable del PO: "no usar un término de exclusión
  // como searchTerm positivo").
  exclusions: z.array(z.string()),
  preferredCities: z.array(z.string()),
  states: z.array(z.string()),
  // Nombres de proveedor mencionados EXPLÍCITAMENTE por el usuario (ej.
  // "usa Hunter y People Data Labs") — vacío si la instrucción no nombra
  // ninguno (significa "cualquiera disponible", el default de siempre).
  providersRequested: z.array(z.string()),
  restrictions: missionRestrictionsSchema,
  // Resumen liviano de qué pasos aplican — el detalle completo (queries,
  // límites, fallback) vive en MissionPlan, generado a partir de esto.
  plannedSteps: z.array(missionPlanStepSchema),
  confidence: z.number().min(0).max(1),
  ambiguities: z.array(z.string()),
  unsupportedCapabilities: z.array(z.string()),
  // Trazabilidad: qué entradas de la taxonomía matchearon — permite
  // auditar/testear el intérprete sin adivinar su lógica interna.
  matchedTaxonomyKeys: z.array(z.string()),
});
export type StructuredIntent = z.infer<typeof structuredIntentSchema>;

// ---------- MissionPlan (salida del planner) ----------

export const missionPlanSearchQuerySchema = z.object({
  searchTerm: z.string(),
  crmIndustryBucket: z.string().nullable(),
  taxonomyKey: z.string(),
});
export type MissionPlanSearchQuery = z.infer<typeof missionPlanSearchQuerySchema>;

export const missionPlanStopConditionsSchema = z.object({
  maxCompanies: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
  maxDurationMinutes: z.number().positive(),
});
export type MissionPlanStopConditions = z.infer<typeof missionPlanStopConditionsSchema>;

export const missionPlanFallbackSchema = z.object({
  provider: z.string(),
  whenUnavailable: z.string(),
});
export type MissionPlanFallback = z.infer<typeof missionPlanFallbackSchema>;

export const dedupStrategyKeySchema = z.enum([
  "providerPlaceId",
  "canonicalDomain",
  "normalizedPhone",
  "normalizedNameCityState",
]);
export type DedupStrategyKey = z.infer<typeof dedupStrategyKeySchema>;

export const missionPlanSchema = z.object({
  schemaVersion: z.literal(1),
  objective: missionObjectiveSchema,
  searchQueries: z.array(missionPlanSearchQuerySchema),
  exclusions: z.array(z.string()),
  cities: z.array(z.string()),
  states: z.array(z.string()),
  // Orden real de ejecución — nunca se reordena en runtime, el plan ES
  // el orden.
  steps: z.array(missionPlanStepSchema),
  requiredSteps: z.array(missionPlanStepSchema),
  optionalSteps: z.array(missionPlanStepSchema),
  stopConditions: missionPlanStopConditionsSchema,
  dedupStrategy: z.array(dedupStrategyKeySchema),
  fallbackStrategy: z.array(missionPlanFallbackSchema),
  restrictions: missionRestrictionsSchema,
  // Explicación en lenguaje humano de por qué el plan es como es —
  // generada determinísticamente a partir de los campos de arriba,
  // nunca por un LLM en esta fase.
  rationale: z.string(),
})
  // Invariante dura: un paso no puede ser required y optional a la vez,
  // y todo paso en requiredSteps/optionalSteps debe estar en steps.
  .refine((plan) => {
    const stepSet = new Set(plan.steps);
    const requiredSet = new Set(plan.requiredSteps);
    const optionalSet = new Set(plan.optionalSteps);
    const allDeclared = [...plan.requiredSteps, ...plan.optionalSteps].every((s) => stepSet.has(s));
    const noOverlap = [...requiredSet].every((s) => !optionalSet.has(s));
    return allDeclared && noOverlap;
  }, { message: "requiredSteps/optionalSteps deben ser subconjuntos disjuntos de steps" });
export type MissionPlan = z.infer<typeof missionPlanSchema>;
