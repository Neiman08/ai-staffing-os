import type { DiscoverySummary } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";

interface DiscoverCompaniesTaskOutput {
  companiesCreated: Array<{ companyId: string; confidenceScore: number }>;
  candidatesFound: number;
  duplicatesSkipped: number;
  insufficientDataSkipped: number;
  sourcesUsed: string[];
}

/**
 * F4.5A: agrega métricas reales de descubrimiento externo a partir de los
 * AgentTask type="discover_companies" — nunca inventa un número, todo sale
 * de tareas ya persistidas y de las Company que efectivamente crearon.
 * Sin missionId, agrega todo el histórico del tenant; con missionId, solo
 * las tareas delegadas por esa misión (parentTaskId).
 */
export async function getDiscoverySummary(missionId?: string): Promise<DiscoverySummary> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const tasks = await scopedDb.agentTask.findMany({
    where: { type: "discover_companies", ...(missionId ? { parentTaskId: missionId } : {}) },
  });

  const outputs = tasks
    .filter((t) => t.status === "DONE" && t.output)
    .map((t) => t.output as unknown as DiscoverCompaniesTaskOutput);

  const companiesFound = outputs.reduce((sum, o) => sum + (o.candidatesFound ?? 0), 0);
  const duplicatesSkipped = outputs.reduce((sum, o) => sum + (o.duplicatesSkipped ?? 0), 0);
  const insufficientDataSkipped = outputs.reduce((sum, o) => sum + (o.insufficientDataSkipped ?? 0), 0);
  const sourcesUsed = Array.from(new Set(outputs.flatMap((o) => o.sourcesUsed ?? [])));
  const companyIds = outputs.flatMap((o) => (o.companiesCreated ?? []).map((c) => c.companyId));
  const costUsd = tasks.reduce((sum, t) => sum + Number(t.costUsd ?? 0), 0);

  const [companies, publicContactsFound, mission] = await Promise.all([
    companyIds.length > 0 ? scopedDb.company.findMany({ where: { id: { in: companyIds } } }) : Promise.resolve([]),
    companyIds.length > 0 ? scopedDb.contact.count({ where: { companyId: { in: companyIds } } }) : Promise.resolve(0),
    missionId ? scopedDb.agentTask.findUnique({ where: { id: missionId } }) : Promise.resolve(null),
  ]);

  const confidenceScores = companies.map((c) => c.confidenceScore).filter((s): s is number => s != null);

  return {
    companiesFound,
    newCompaniesCreated: companies.length,
    duplicatesSkipped,
    companiesVerified: companies.filter((c) => c.verificationStatus === "CONFIRMED").length,
    insufficientDataSkipped,
    websitesFound: companies.filter((c) => !!c.website).length,
    phonesFound: companies.filter((c) => !!c.phone).length,
    publicEmailsFound: companies.filter((c) => !!c.email).length,
    publicContactsFound,
    costUsd,
    costPerUsefulCompanyUsd: companies.length > 0 ? costUsd / companies.length : null,
    missionDurationMs: mission ? (mission.completedAt ?? new Date()).getTime() - mission.createdAt.getTime() : null,
    sourcesUsed,
    averageConfidence:
      confidenceScores.length > 0 ? confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length : null,
  };
}
