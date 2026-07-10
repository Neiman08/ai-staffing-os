import { z } from "zod";

// ============================================================
// F4.5A: External Discovery Pilot — panel de métricas reales, agregadas
// desde los AgentTask type="discover_companies" (agentKey="discovery").
// Sin missionId agrega todo el histórico del tenant; con missionId, solo
// las tareas de descubrimiento delegadas por esa misión (parentTaskId).
// ============================================================

export const discoverySummaryQuerySchema = z.object({
  missionId: z.string().optional(),
});
export type DiscoverySummaryQuery = z.infer<typeof discoverySummaryQuerySchema>;

export const discoverySummarySchema = z.object({
  companiesFound: z.number(), // candidatos vistos en la fuente externa, antes de dedup/filtrado
  newCompaniesCreated: z.number(),
  duplicatesSkipped: z.number(),
  companiesVerified: z.number(), // verificationStatus=CONFIRMED entre las descubiertas
  insufficientDataSkipped: z.number(), // encontradas en la fuente pero sin nombre usable
  websitesFound: z.number(),
  phonesFound: z.number(),
  publicEmailsFound: z.number(),
  publicContactsFound: z.number(), // honesto: 0 en este piloto, OSM no da nombres de personas
  costUsd: z.number(),
  costPerUsefulCompanyUsd: z.number().nullable(),
  missionDurationMs: z.number().nullable(), // solo cuando se filtra por missionId
  sourcesUsed: z.array(z.string()),
  averageConfidence: z.number().nullable(),
});
export type DiscoverySummary = z.infer<typeof discoverySummarySchema>;
