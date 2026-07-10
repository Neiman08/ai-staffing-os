import { z } from "zod";
import {
  discoverCompaniesTool as discoverCompaniesToolStub,
  discoverCompaniesInputSchema,
  type AgentTool,
  type DiscoveredCompany,
  type DiscoveredField,
  type FieldStatus,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../../core/tenancy/context";
import { AppError } from "../../../core/errors";
import type { UsageAccumulator } from "../usage";

/**
 * F4.5A: Discovery Agent — implementación real contra OpenStreetMap
 * Overpass API (ver docs/F4_5_EXTERNAL_DISCOVERY_AND_EMAIL_PLAN.md,
 * addendum del piloto, para por qué esta fuente y no Apollo/Google Places).
 * Gratis, sin API key, sin cuenta de facturación — evita el bloqueante de
 * "necesito una credencial paga" para demostrar el flujo end-to-end.
 */
const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

// Solo los estados que ya aparecen en los datos del CRM (seed) — una
// misión que pida un estado fuera de este mapa falla explícitamente en
// vez de adivinar el nombre completo para el filtro de área de Overpass.
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

// F4.5A §"Alcance prioritario": Manufacturing, Warehouse/Logistics,
// Construction — cada uno con más de un patrón de tag porque OSM no tiene
// una única convención por industria; se prueban en orden y se degrada
// por patrón (nunca se inventa un resultado si uno falla).
const OVERPASS_PATTERNS: Record<string, Array<{ key: string; value: string }>> = {
  Manufacturing: [{ key: "office", value: "company" }],
  "Warehouse/Logistics": [
    { key: "industrial", value: "warehouse" },
    { key: "building", value: "warehouse" },
  ],
  Construction: [
    { key: "craft", value: "builder" },
    { key: "office", value: "construction_company" },
  ],
};

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
}

async function fetchOverpassPattern(
  stateName: string,
  pattern: { key: string; value: string },
  limit: number,
): Promise<{ elements: OverpassElement[] } | { error: string }> {
  const query = `[out:json][timeout:25];area["name"="${stateName}"]["admin_level"="4"]->.searchArea;(node["${pattern.key}"="${pattern.value}"](area.searchArea);way["${pattern.key}"="${pattern.value}"](area.searchArea););out center ${limit} tags;`;

  // La instancia pública comparte cuota con el resto de internet —
  // 406/429/504 observados son fair-use throttling transitorio (medido:
  // ~20-50% de éxito según el momento, la misma query exacta vuelve a
  // funcionar segundos después), no un error de sintaxis. Backoff más
  // largo que un simple retry inmediato, varios intentos.
  const BACKOFF_MS = [1500, 3000, 6000, 12000];
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      // "connection: close" fuerza una conexión TCP nueva en cada
      // intento — sin esto, fetch reutiliza keep-alive hacia el mismo
      // backend detrás del DNS round-robin de overpass-api.de, así que un
      // reintento que "vuelve a preguntarle al mismo server sobrecargado"
      // nunca cambia de resultado (medido: curl en loop, que sí abre
      // conexión nueva cada vez, tiene ~20-50% de éxito; fetch con la
      // conexión reusada quedaba pegado al mismo 406).
      const res = await fetch(OVERPASS_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        if (attempt < BACKOFF_MS.length) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
          continue;
        }
        return { error: `HTTP ${res.status}` };
      }
      const json = (await res.json()) as { elements: OverpassElement[] };
      return { elements: json.elements ?? [] };
    } catch (err) {
      if (attempt < BACKOFF_MS.length) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }
      return { error: err instanceof Error ? err.message : "unknown fetch error" };
    }
  }
  return { error: "exhausted retries" };
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value.startsWith("http") ? value : `https://${value}`);
    return true;
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function field(status: FieldStatus, value: string | number | null): DiscoveredField {
  return { status, value };
}

/**
 * Extrae campos de un elemento OSM crudo — cada campo queda CONFIRMED (si
 * el tag existe y pasa validación de formato), o NOT_FOUND. Nunca
 * INFERRED acá: OSM no da lugar a inferencia, solo lectura literal de
 * tags o ausencia. hiringSignals y contactos con nombre siempre son
 * NOT_FOUND — OSM no modela esos datos (ver addendum del plan).
 */
export function extractFields(
  tags: Record<string, string>,
  fallbackState: string,
): { name: string | null; fields: Record<string, DiscoveredField> } {
  const name = tags.name ?? tags.operator ?? null;

  const websiteRaw = tags.website ?? tags["contact:website"] ?? null;
  const website = websiteRaw && isValidUrl(websiteRaw) ? websiteRaw : null;

  const phoneRaw = tags.phone ?? tags["contact:phone"] ?? null;

  const emailRaw = tags.email ?? tags["contact:email"] ?? null;
  const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;

  const city = tags["addr:city"] ?? null;
  const state = tags["addr:state"] ?? fallbackState;
  const street = tags["addr:housenumber"] && tags["addr:street"] ? `${tags["addr:housenumber"]} ${tags["addr:street"]}` : (tags["addr:street"] ?? null);
  const postcode = tags["addr:postcode"] ?? null;
  const hasFullAddress = !!(street && city);

  return {
    name,
    fields: {
      name: name ? field("CONFIRMED", name) : field("NOT_FOUND", null),
      website: website ? field("CONFIRMED", website) : field("NOT_FOUND", null),
      phone: phoneRaw ? field("CONFIRMED", phoneRaw) : field("NOT_FOUND", null),
      email: email ? field("CONFIRMED", email) : field("NOT_FOUND", null),
      city: city ? field("CONFIRMED", city) : field("NOT_FOUND", null),
      state: state ? field("CONFIRMED", state) : field("NOT_FOUND", null),
      address: hasFullAddress ? field("CONFIRMED", `${street}, ${city}, ${state}${postcode ? ` ${postcode}` : ""}`) : field("NOT_FOUND", null),
      hiringSignals: field("NOT_FOUND", null),
      visiblePositions: field("NOT_FOUND", null),
      contactName: field("NOT_FOUND", null),
    },
  };
}

/** Score determinista (nunca lo decide el LLM) — ver addendum del plan. */
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
}

export function createDiscoveryTools(deps: DiscoveryToolDeps): AgentTool[] {
  return [
    {
      ...discoverCompaniesToolStub,
      async execute(input: z.infer<typeof discoverCompaniesInputSchema>) {
        const ctx = getTenancyContext();
        if (!ctx) throw AppError.unauthorized();

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

        for (const industryName of input.industryNames) {
          const industry = industryByName.get(industryName);
          if (!industry) continue; // nunca se inventa una industria que no existe en el CRM

          const patterns = OVERPASS_PATTERNS[industryName] ?? [];
          for (const pattern of patterns) {
            if (companiesCreated.length >= limit) break;

            const remaining = limit - companiesCreated.length;
            const result = await fetchOverpassPattern(stateName, pattern, remaining * 3);
            if ("error" in result) {
              patternsFailed.push(`${industryName}:${pattern.key}=${pattern.value} (${result.error})`);
              continue;
            }

            const sourceUrl = `${OVERPASS_ENDPOINT}?data=${encodeURIComponent(`[${pattern.key}=${pattern.value}] area=${stateName}`)}`;
            sourcesUsed.add(`OpenStreetMap Overpass (${pattern.key}=${pattern.value}, ${stateName})`);

            for (const element of result.elements) {
              if (companiesCreated.length >= limit) break;
              candidatesFound++;

              const tags = element.tags ?? {};
              const { name, fields } = extractFields(tags, input.state.toUpperCase());
              if (!name) {
                insufficientDataSkipped++;
                continue;
              }

              const existing = await scopedDb.company.findFirst({
                where: { name: { equals: name, mode: "insensitive" }, industryId: industry.id },
              });
              if (existing) {
                duplicatesSkipped++;
                continue;
              }

              const confidenceScore = computeConfidenceScore(fields);
              const website = fields.website?.status === "CONFIRMED" ? (fields.website.value as string) : null;
              const phone = fields.phone?.status === "CONFIRMED" ? (fields.phone.value as string) : null;
              const email = fields.email?.status === "CONFIRMED" ? (fields.email.value as string) : null;
              const city = fields.city?.status === "CONFIRMED" ? (fields.city.value as string) : null;

              const company = await scopedDb.company.create({
                data: {
                  tenantId: ctx.tenantId,
                  name,
                  industryId: industry.id,
                  status: "LEAD",
                  website,
                  phone,
                  email,
                  city,
                  state: input.state.toUpperCase(),
                  origin: "EXTERNAL_DISCOVERY",
                  sourceUrl,
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
                after: { name, sourceUrl, confidenceScore },
              });

              companiesCreated.push({ companyId: company.id, name, fields, sourceUrl, confidenceScore });
            }
          }
        }

        return {
          companiesCreated,
          candidatesFound,
          duplicatesSkipped,
          insufficientDataSkipped,
          sourcesUsed: Array.from(sourcesUsed),
          patternsFailed,
        };
      },
    },
  ];
}
