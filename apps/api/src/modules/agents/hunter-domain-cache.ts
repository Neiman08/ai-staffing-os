import { scopedDb } from "../../core/tenancy/prisma-extension";
import type { EmailCandidate } from "./tools/email-providers/types";
import type { ProviderHealthStatus } from "./tools/provider-health";

/**
 * F27 Fase 7: Hunter.io Domain Search corre en el free tier aprobado por
 * el PO -- 25 búsquedas/mes TOTAL (ver hunter.ts), no por registro como
 * PDL. Sin ninguna caché, cada reintento real de find_contacts (worker
 * caído a mitad de camino, retry manual) o cada misión distinta que vuelve
 * a tocar la misma Company gasta OTRA búsqueda real por el MISMO dominio
 * -- el dominio de una empresa real no cambia de un día para otro, así
 * que repetir la consulta no aporta nada nuevo casi nunca.
 *
 * Esta caché guarda el resultado REAL de la última consulta (mismo shape
 * EmailCandidate[] que hunter.ts ya mapea) por (tenant, dominio) -- un
 * "cache hit" dentro de la ventana de frescura devuelve exactamente lo
 * que Hunter dijo la última vez, nunca inventa ni actualiza datos sin una
 * consulta real. Vencida la ventana, la próxima llamada real refresca la
 * fila (upsert lógico vía findFirst+create/update, nunca la clave
 * compuesta -- ver prisma-extension.ts, el mismo motivo que en
 * reconciliation.ts).
 */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días -- el dominio/equipo de una empresa real rara vez cambia en ese plazo

export interface HunterDomainCacheHit {
  candidates: EmailCandidate[];
  patternsFailed: string[];
  providerStatus: ProviderHealthStatus;
  queriedAt: Date;
}

export async function getFreshHunterDomainCache(domain: string): Promise<HunterDomainCacheHit | null> {
  const row = await scopedDb.hunterDomainSearchCache.findFirst({ where: { domain } });
  if (!row) return null;
  if (Date.now() - row.queriedAt.getTime() > CACHE_TTL_MS) return null;
  return {
    candidates: row.candidates as unknown as EmailCandidate[],
    patternsFailed: row.patternsFailed,
    providerStatus: row.providerStatus as ProviderHealthStatus,
    queriedAt: row.queriedAt,
  };
}

export async function recordHunterDomainQuery(
  tenantId: string,
  domain: string,
  candidates: EmailCandidate[],
  patternsFailed: string[],
  providerStatus: ProviderHealthStatus,
): Promise<void> {
  const existing = await scopedDb.hunterDomainSearchCache.findFirst({ where: { domain } });
  if (existing) {
    await scopedDb.hunterDomainSearchCache.update({
      where: { id: existing.id },
      data: { queriedAt: new Date(), candidates: candidates as never, patternsFailed, providerStatus },
    });
  } else {
    await scopedDb.hunterDomainSearchCache.create({
      data: { tenantId, domain, candidates: candidates as never, patternsFailed, providerStatus },
    });
  }
}
