import { scopedDb } from "../../core/tenancy/prisma-extension";
import { normalizeText } from "../ceo-intelligence/text-normalize";
import { evaluateQuerySaturation, type QuerySaturationResult, type QuerySaturationSample } from "../ceo-intelligence/query-saturation";

/**
 * F34 (auditoría arquitectónica transversal, hallazgo real: 71.9% de
 * discovery duplicado / 48.4% de queries sin ninguna empresa nueva sobre
 * 10 misiones de producción, 2026-08-05): capa de persistencia real de
 * DiscoveryQueryExecution -- único punto de este archivo con
 * Prisma/scopedDb. El scoring puro vive en ceo-intelligence/query-saturation.ts
 * (sin esta dependencia, testeable sin DB); este módulo solo sabe leer/
 * escribir filas reales y armar el input de ese scoring.
 */

const SATURATION_LOOKBACK_DAYS = 30;
const SATURATION_MAX_EXECUTIONS = 5;

export function normalizeQueryForSaturation(searchTerm: string): string {
  return normalizeText(searchTerm.trim());
}

export interface QueryIdentity {
  searchTerm: string;
  state: string | null;
  // F35b (hallazgo real, misión comercial 2026-08-06, Rockford IL
  // roofing): city es un parámetro real y distinto que el proveedor
  // (Google Places/Overpass) recibe por separado del searchTerm -- dos
  // ciudades distintas dentro del mismo estado son mercados reales
  // distintos, con negocios físicamente distintos. Sin esto, una query
  // recién ejecutada en una ciudad nueva se marcaba "ya saturada" solo
  // porque la MISMA frase ya se había buscado antes en OTRA ciudad del
  // mismo estado -- bloqueando descubrimiento real, nunca duplicado.
  city: string | null;
  taxonomyKey: string;
}

function queryIdentityKey(searchTerm: string, state: string | null, city: string | null): string {
  return `${normalizeQueryForSaturation(searchTerm)}::${state ?? ""}::${city ?? ""}`;
}

/**
 * Batch-lee el historial reciente (ventana TTL) de TODAS las queries del
 * plan de una sola vez -- nunca un query por candidato, evita N+1 real
 * contra Postgres para un plan con decenas de queries. Devuelve un Map
 * queryKey -> QuerySaturationResult, mismo `queryKey` que ya usa
 * mission-executor.ts (`${taxonomyKey}::${searchTerm}::${city}`) para que
 * el llamador no tenga que reconstruir nada.
 */
export async function getQuerySaturationMap(tenantId: string, queries: QueryIdentity[]): Promise<Map<string, QuerySaturationResult>> {
  const result = new Map<string, QuerySaturationResult>();
  if (queries.length === 0) return result;

  const since = new Date(Date.now() - SATURATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  // Agrupa por (normalizedQuery, state, city) real -- el mismo searchTerm
  // en dos estados o dos ciudades distintas nunca comparte saturación
  // (mercados distintos).
  const uniqueIdentities = new Map<string, QueryIdentity>();
  for (const q of queries) {
    const key = queryIdentityKey(q.searchTerm, q.state, q.city);
    if (!uniqueIdentities.has(key)) uniqueIdentities.set(key, q);
  }

  const normalizedQueries = Array.from(new Set(Array.from(uniqueIdentities.values()).map((q) => normalizeQueryForSaturation(q.searchTerm))));

  const rows = await scopedDb.discoveryQueryExecution.findMany({
    where: { tenantId, normalizedQuery: { in: normalizedQueries }, executedAt: { gte: since } },
    orderBy: { executedAt: "desc" },
    select: { normalizedQuery: true, state: true, city: true, rawResultCount: true, acceptedCount: true, duplicateCount: true, rejectedCount: true, executedAt: true },
  });

  const rowsByIdentity = new Map<string, QuerySaturationSample[]>();
  for (const row of rows) {
    const identityKey = queryIdentityKey(row.normalizedQuery, row.state, row.city);
    const existing = rowsByIdentity.get(identityKey) ?? [];
    if (existing.length < SATURATION_MAX_EXECUTIONS) {
      existing.push({
        rawResultCount: row.rawResultCount,
        acceptedCount: row.acceptedCount,
        duplicateCount: row.duplicateCount,
        rejectedCount: row.rejectedCount,
        executedAt: row.executedAt.toISOString(),
      });
    }
    rowsByIdentity.set(identityKey, existing);
  }

  for (const q of queries) {
    const identityKey = queryIdentityKey(q.searchTerm, q.state, q.city);
    const queryKey = `${q.taxonomyKey}::${q.searchTerm}::${q.city ?? ""}`;
    const samples = rowsByIdentity.get(identityKey) ?? [];
    result.set(queryKey, evaluateQuerySaturation({ samples }));
  }

  return result;
}

export interface QueryExecutionToRecord {
  missionTaskId: string;
  searchTerm: string;
  taxonomyKey: string;
  crmIndustryBucket: string | null;
  state: string | null;
  city: string | null;
  provider: string | null;
  rawResultCount: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  costUsd: number;
}

/**
 * Persiste UNA ejecución real de query -- append-only, nunca actualiza
 * una fila existente (ver comentario de diseño en schema.prisma). Se
 * omite por completo para queries que nunca llegaron a ejecutarse
 * (skippedForSaturation) -- nunca se inventa un resultado de una query
 * que no corrió.
 */
export async function recordQueryExecution(tenantId: string, execution: QueryExecutionToRecord): Promise<void> {
  await scopedDb.discoveryQueryExecution.create({
    data: {
      tenantId,
      missionTaskId: execution.missionTaskId,
      normalizedQuery: normalizeQueryForSaturation(execution.searchTerm),
      rawQuery: execution.searchTerm,
      taxonomyKey: execution.taxonomyKey,
      crmIndustryBucket: execution.crmIndustryBucket,
      state: execution.state,
      city: execution.city,
      provider: execution.provider ?? "unknown",
      rawResultCount: execution.rawResultCount,
      acceptedCount: execution.acceptedCount,
      duplicateCount: execution.duplicateCount,
      rejectedCount: execution.rejectedCount,
      costUsd: execution.costUsd,
    },
  });
}
