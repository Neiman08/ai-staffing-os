import { z } from "zod";
import {
  discoverCompaniesTool as discoverCompaniesToolStub,
  discoverCompaniesInputSchema,
  type AgentTool,
  type DiscoveredCompany,
  type DiscoveredField,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../../core/tenancy/context";
import { AppError } from "../../../core/errors";
import { env } from "../../../core/env";
import type { UsageAccumulator } from "../usage";
import { getDataProviderBudgetStatus } from "../data-provider-budget";
import { searchGooglePlaces } from "./discovery-providers/google-places";
import { searchOverpass } from "./discovery-providers/overpass";
import { emptyResult, type ProviderSearchResult } from "./discovery-providers/types";

// Re-exportados para no romper discovery.test.ts ni nada que ya importe
// estos nombres desde acá — la lógica real vive en discovery-providers/.
export { extractFieldsFromOsmTags as extractFields } from "./discovery-providers/overpass";

/**
 * F4.5: Discovery Agent — orquesta proveedores de descubrimiento externo.
 * A partir de F4.5, Google Places (comercial) es el proveedor PRIMARIO;
 * Overpass (OpenStreetMap, gratis) queda como respaldo — solo se consulta
 * si Google Places no está configurada, se quedó sin presupuesto, o no
 * encontró nada para esa industria. Ver
 * docs/F4_5_EXTERNAL_DISCOVERY_AND_EMAIL_PLAN.md.
 */

function log(taskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[discovery] ${event}`, JSON.stringify({ taskId, ...data }));
}

// Solo los estados que ya aparecen en los datos del CRM (seed) — una
// misión que pida un estado fuera de este mapa falla explícitamente en
// vez de adivinar el nombre completo para el filtro de área de Overpass
// (Google Places funcionaría con solo el código de estado, pero se
// mantiene el mismo gate para los dos proveedores — un solo lugar que
// mantener, mismo alcance declarado en el piloto).
const US_STATE_NAMES: Record<string, string> = {
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  NE: "Nebraska",
  WI: "Wisconsin",
  MI: "Michigan",
  OH: "Ohio",
  MO: "Missouri",
};

/** Score determinista (nunca lo decide el LLM) — igual para cualquier proveedor. */
export function computeConfidenceScore(fields: Record<string, DiscoveredField>): number {
  let score = 0.5; // confirmado que existe, con nombre
  if (fields.website?.status === "CONFIRMED") score += 0.15;
  if (fields.phone?.status === "CONFIRMED") score += 0.15;
  if (fields.address?.status === "CONFIRMED") score += 0.1;
  if (fields.email?.status === "CONFIRMED") score += 0.1;
  return Math.min(1, score);
}

async function auditAgentAction(params: {
  agentInstanceId: string;
  action: string;
  entityType: string;
  entityId: string;
  after?: unknown;
}) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  await scopedDb.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorType: "AGENT",
      actorId: params.agentInstanceId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      after: params.after as never,
    },
  });
}

export interface DiscoveryToolDeps {
  taskId: string;
  agentInstanceId: string;
  llmProvider: LLMProvider;
  usage: UsageAccumulator;
  // bugfix de ciclo de vida: si la misión que disparó esta tarea se
  // cancela mientras la llamada HTTP está en vuelo, esta señal la corta
  // de verdad (ver cancellation.ts) en vez de dejarla terminar sola.
  abortSignal?: AbortSignal;
}

export function createDiscoveryTools(deps: DiscoveryToolDeps): AgentTool[] {
  return [
    {
      ...discoverCompaniesToolStub,
      async execute(input: z.infer<typeof discoverCompaniesInputSchema>) {
        const ctx = getTenancyContext();
        if (!ctx) throw AppError.unauthorized();

        log(deps.taskId, "discovery started", { industryNames: input.industryNames, state: input.state, limit: input.limit });

        const stateName = US_STATE_NAMES[input.state.toUpperCase()];
        if (!stateName) {
          throw new AppError(
            400,
            "UNSUPPORTED_DISCOVERY_STATE",
            `El piloto de descubrimiento externo no tiene mapeo de área para el estado "${input.state}" — solo: ${Object.keys(US_STATE_NAMES).join(", ")}.`,
          );
        }

        const industries = await scopedDb.industry.findMany({ where: { name: { in: input.industryNames } } });
        const industryByName = new Map(industries.map((i) => [i.name, i]));
        const limit = Math.min(input.limit ?? 50, 50);

        const companiesCreated: DiscoveredCompany[] = [];
        const sourcesUsed = new Set<string>();
        const patternsFailed: string[] = [];
        let candidatesFound = 0;
        let duplicatesSkipped = 0;
        let insufficientDataSkipped = 0;
        let searchesExecuted = 0;
        let cancelled = false;

        outer: for (const industryName of input.industryNames) {
          const industry = industryByName.get(industryName);
          if (!industry) continue; // nunca se inventa una industria que no existe en el CRM
          if (companiesCreated.length >= limit) break outer;

          // Bugfix multi-sector: si vienen frases de búsqueda libres
          // (ej. "electrical contractor", "low voltage contractor"), cada
          // una es una búsqueda INDEPENDIENTE, todas archivadas bajo esta
          // misma industry — nunca se colapsan en una sola. Sin
          // searchTerms, se preserva el comportamiento de siempre: una
          // sola búsqueda usando el nombre de la industria tal cual.
          const queryTerms = input.searchTerms?.length ? input.searchTerms : [industryName];

          for (let termIndex = 0; termIndex < queryTerms.length; termIndex++) {
            const queryTerm = queryTerms[termIndex]!;
            if (companiesCreated.length >= limit) break outer;

            // Reparte el cupo restante entre los términos que todavía
            // faltan correr — SIN esto, un primer término con muchos
            // resultados agotaba el límite global y los términos
            // siguientes nunca llegaban ni a ejecutarse (justo el bug
            // reportado: "20 contratistas eléctricos" de un solo trade
            // en vez de cobertura repartida entre los 6 sectores
            // pedidos). Mínimo 1 — todo término pedido se busca de
            // verdad, nunca se salta en silencio por falta de cupo.
            const termsRemaining = queryTerms.length - termIndex;
            const remaining = Math.max(1, Math.ceil((limit - companiesCreated.length) / termsRemaining));
            let result: ProviderSearchResult = emptyResult();
            let origin: "API_PROVIDER" | "EXTERNAL_DISCOVERY" = "EXTERNAL_DISCOVERY";

            // 1. Google Places primero — solo si está configurada la key y
            // no se pasó el presupuesto mensual del proveedor de datos.
            if (env.GOOGLE_PLACES_API_KEY) {
              const budgetStatus = await getDataProviderBudgetStatus(ctx.tenantId);
              if (budgetStatus.exceeded) {
                log(deps.taskId, "data provider budget exceeded, falling back to Overpass", { ...budgetStatus });
                patternsFailed.push(`${queryTerm}: presupuesto de proveedor de datos excedido ($${budgetStatus.spentUsd.toFixed(2)}/$${budgetStatus.budgetUsd.toFixed(2)}), usando Overpass`);
              } else {
                searchesExecuted++;
                const placesResult = await searchGooglePlaces(
                  {
                    taskId: deps.taskId,
                    industryName,
                    queryPhrase: queryTerm !== industryName ? queryTerm : undefined,
                    stateCode: input.state.toUpperCase(),
                    stateName,
                    city: input.city,
                    limit: remaining,
                    abortSignal: deps.abortSignal,
                  },
                  env.GOOGLE_PLACES_API_KEY,
                );
                if (placesResult.costUsd > 0) deps.usage.recordExternalCost(placesResult.costUsd);
                if (placesResult.cancelled) {
                  cancelled = true;
                  break outer;
                }
                patternsFailed.push(...placesResult.patternsFailed);
                if (placesResult.candidates.length > 0) {
                  result = placesResult;
                  origin = "API_PROVIDER";
                }
              }
            }

            // 2. Overpass como respaldo — solo si Google Places no estaba
            // configurada, se quedó sin presupuesto, o no encontró nada.
            // Overpass no soporta texto libre (requiere tags OSM
            // estructurados por industryName) — un queryTerm custom que
            // no matchea ningún patrón conocido simplemente no aporta acá,
            // degradación honesta, no un error.
            if (result.candidates.length === 0) {
              if (!env.GOOGLE_PLACES_API_KEY) searchesExecuted++;
              const overpassResult = await searchOverpass({
                taskId: deps.taskId,
                industryName,
                stateCode: input.state.toUpperCase(),
                stateName,
                city: input.city,
                limit: remaining,
                abortSignal: deps.abortSignal,
              });
              if (overpassResult.cancelled) {
                cancelled = true;
                break outer;
              }
              patternsFailed.push(...overpassResult.patternsFailed);
              if (overpassResult.candidates.length > 0) {
                result = overpassResult;
                origin = "EXTERNAL_DISCOVERY";
              }
            }

            for (const s of result.sourcesUsed) sourcesUsed.add(s);

            for (const candidate of result.candidates) {
              if (companiesCreated.length >= limit) break;
              candidatesFound++;

              if (!candidate.name) {
                insufficientDataSkipped++;
                continue;
              }

              const existing = await scopedDb.company.findFirst({
                where: { name: { equals: candidate.name, mode: "insensitive" }, industryId: industry.id },
              });
              if (existing) {
                duplicatesSkipped++;
                log(deps.taskId, "duplicates discarded", { name: candidate.name, existingCompanyId: existing.id });
                continue;
              }

              const confidenceScore = computeConfidenceScore(candidate.fields);
              const website = candidate.fields.website?.status === "CONFIRMED" ? (candidate.fields.website.value as string) : null;
              const phone = candidate.fields.phone?.status === "CONFIRMED" ? (candidate.fields.phone.value as string) : null;
              const email = candidate.fields.email?.status === "CONFIRMED" ? (candidate.fields.email.value as string) : null;
              const city = candidate.fields.city?.status === "CONFIRMED" ? (candidate.fields.city.value as string) : null;

              const company = await scopedDb.company.create({
                data: {
                  tenantId: ctx.tenantId,
                  name: candidate.name,
                  industryId: industry.id,
                  status: "LEAD",
                  website,
                  phone,
                  email,
                  city,
                  state: input.state.toUpperCase(),
                  origin,
                  sourceUrl: candidate.sourceUrl,
                  discoveredAt: new Date(),
                  discoveredByAgentTaskId: deps.taskId,
                  verificationStatus: "CONFIRMED",
                  confidenceScore,
                  lastVerifiedAt: new Date(),
                },
              });

              await auditAgentAction({
                agentInstanceId: deps.agentInstanceId,
                action: "company.discovered_by_agent",
                entityType: "company",
                entityId: company.id,
                after: { name: candidate.name, sourceUrl: candidate.sourceUrl, confidenceScore, origin },
              });

              log(deps.taskId, "records persisted", { companyId: company.id, name: candidate.name, confidenceScore, origin });
              companiesCreated.push({ companyId: company.id, name: candidate.name, fields: candidate.fields, sourceUrl: candidate.sourceUrl, confidenceScore });
            }
          }
        }

        log(deps.taskId, cancelled ? "discovery cancelled" : "discovery completed", {
          companiesCreated: companiesCreated.length,
          candidatesFound,
          duplicatesSkipped,
          insufficientDataSkipped,
          searchesExecuted,
        });

        // Cancelación cooperativa: si la misión se canceló mientras esta
        // tarea corría, se lo hacemos saber al que la ejecuta lanzando en
        // vez de devolver un resultado normal — task-executor.ts la marca
        // FAILED con este mensaje, en vez de un DONE engañoso con datos
        // parciales sin avisar que se cortó a mitad de camino.
        if (cancelled) {
          throw new AppError(499, "DISCOVERY_CANCELLED", "Descubrimiento cancelado por el usuario.");
        }

        return {
          companiesCreated,
          candidatesFound,
          duplicatesSkipped,
          insufficientDataSkipped,
          sourcesUsed: Array.from(sourcesUsed),
          patternsFailed,
          searchesExecuted,
        };
      },
    },
  ];
}
