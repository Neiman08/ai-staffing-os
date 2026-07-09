import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";

/**
 * F3 §7: AgentMemory sin pgvector (sigue diferido) — dos usos funcionales
 * concretos, no decorativos: dedup del scheduler ("empresas ya
 * analizadas") y memoria de industria para que el Prospecting Agent
 * priorice dónde buscar. Todo lo demás que el pedido original mencionaba
 * como "memoria" (correos ya preparados, decisiones humanas) ya es
 * consultable vía AgentTask/ApprovalRequest — no se duplica acá.
 */

export async function markCompanyProcessed(agentInstanceId: string, companyId: string, summary: string): Promise<void> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  await scopedDb.agentMemory.create({
    data: {
      tenantId: ctx.tenantId,
      agentInstanceId,
      scope: "ENTITY",
      entityType: "company",
      entityId: companyId,
      content: summary,
      importance: 0.5,
    },
  });
}

export async function getUnprocessedCompanyIds(limit: number): Promise<string[]> {
  const candidates = await scopedDb.company.findMany({
    where: { status: { in: ["LEAD", "PROSPECT"] } },
    orderBy: { createdAt: "asc" },
    take: limit * 3, // overfetch — se filtra contra AgentMemory abajo
    select: { id: true },
  });
  if (candidates.length === 0) return [];

  const processed = await scopedDb.agentMemory.findMany({
    where: { entityType: "company", entityId: { in: candidates.map((c) => c.id) } },
    select: { entityId: true },
  });
  const processedIds = new Set(processed.map((m) => m.entityId));

  return candidates
    .map((c) => c.id)
    .filter((id) => !processedIds.has(id))
    .slice(0, limit);
}

/**
 * Empresas cuya última marca de "procesada" tiene más de `olderThanDays`
 * — candidatas a recalcular score (F3 §6, scheduler paso 2).
 */
export async function getStaleProcessedCompanyIds(olderThanDays: number, limit: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const memories = await scopedDb.agentMemory.findMany({
    where: { entityType: "company" },
    orderBy: { createdAt: "desc" },
    select: { entityId: true, createdAt: true },
  });

  const latestByCompany = new Map<string, Date>();
  for (const m of memories) {
    if (!m.entityId) continue; // siempre viene seteado para entityType "company" (ver markCompanyProcessed)
    if (!latestByCompany.has(m.entityId)) latestByCompany.set(m.entityId, m.createdAt);
  }

  return [...latestByCompany.entries()]
    .filter(([, lastProcessedAt]) => lastProcessedAt < cutoff)
    .map(([companyId]) => companyId)
    .slice(0, limit);
}

export async function recordIndustryAnalysis(agentInstanceId: string, industryId: string, summary: string): Promise<void> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  await scopedDb.agentMemory.create({
    data: {
      tenantId: ctx.tenantId,
      agentInstanceId,
      scope: "ENTITY",
      entityType: "industry",
      entityId: industryId,
      content: summary,
      importance: 0.6,
    },
  });
}

export async function getLatestIndustryAnalysis(industryId: string) {
  return scopedDb.agentMemory.findFirst({
    where: { entityType: "industry", entityId: industryId },
    orderBy: { createdAt: "desc" },
  });
}
