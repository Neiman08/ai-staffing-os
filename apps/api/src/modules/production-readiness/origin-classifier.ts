/**
 * F4.7.5 §1: clasificador de procedencia de datos — deriva el origen
 * real de cada registro a partir de campos que YA EXISTEN (Company.origin,
 * Contact.source/emailDiscoveryProvider/emailSource, AgentTask.input/
 * output, relaciones a Company). Nunca se agrega una columna nueva para
 * esto — es 100% derivado, de solo lectura.
 *
 * Vocabulario cerrado pedido explícitamente por el PO. "DEMO" y "SEED"
 * colapsan al mismo valor real hoy (`CompanyOrigin.DEMO_SEED` es un
 * único enum, el schema nunca distinguió "es una demo" de "vino del
 * script de seed" — siempre fueron la misma fila) — se reporta bajo
 * "DEMO" (coincide con el badge ya visible en la UI, `CompanyOriginBadge`)
 * y "SEED" queda en 0 por diseño, documentado acá para que nunca se lea
 * como un bug.
 */
export const DATA_ORIGINS = [
  "DEMO",
  "SEED",
  "MANUAL",
  "GOOGLE_PLACES",
  "PEOPLE_DATA_LABS",
  "WEBSITE",
  "HUNTER",
  "API_PROVIDER",
  "IMPORT",
  "USER_CREATED",
  "UNKNOWN",
] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];

export function emptyOriginCounts(): Record<DataOrigin, number> {
  return Object.fromEntries(DATA_ORIGINS.map((o) => [o, 0])) as Record<DataOrigin, number>;
}

/** Company: mapeo directo desde CompanyOrigin, el único campo real de procedencia — nunca se re-adivina. */
export function classifyCompanyOrigin(company: { origin: string; sourceUrl: string | null }): DataOrigin {
  switch (company.origin) {
    case "DEMO_SEED":
      return "DEMO";
    case "MANUAL":
      return "MANUAL";
    case "CSV_IMPORT":
      return "IMPORT";
    case "API_PROVIDER":
      // Hoy el único proveedor real detrás de API_PROVIDER es Google
      // Places (ver F4.5 addendum 2) — se confirma mirando el dominio
      // real de sourceUrl, nunca se asume solo por el nombre del enum.
      return company.sourceUrl?.includes("google.com") ? "GOOGLE_PLACES" : "API_PROVIDER";
    case "EXTERNAL_DISCOVERY":
      // Overpass/OpenStreetMap, respaldo gratuito de F4.5A — el
      // vocabulario pedido no tiene un bucket propio para OSM, queda en
      // el genérico API_PROVIDER (es, después de todo, una fuente
      // externa autorizada, solo que no es ninguno de los proveedores
      // pagos nombrados explícitamente).
      return "API_PROVIDER";
    default:
      return "UNKNOWN";
  }
}

/**
 * Contact: prioridad a las señales propias del contacto (cómo se
 * encontró EL CONTACTO, no la empresa) — solo cae a heredar el origen de
 * la Company cuando el contacto no tiene ninguna señal propia (fue
 * cargado a mano junto con la empresa, o la empresa es demo).
 */
export function classifyContactOrigin(
  contact: { source: string | null; emailDiscoveryProvider: string | null; emailSource: string | null },
  companyOrigin: DataOrigin,
): DataOrigin {
  if (companyOrigin === "DEMO") return "DEMO"; // un contacto de una empresa demo es demo, sin excepción
  if (contact.source === "People Data Labs") return "PEOPLE_DATA_LABS";
  if (contact.emailDiscoveryProvider === "Hunter.io") return "HUNTER";
  if (contact.emailSource?.startsWith("Website")) return "WEBSITE";
  if (contact.source) return "UNKNOWN"; // un source real pero no reconocido — nunca se lo fuerza a un bucket que no le corresponde
  // Sin source de contacto propio: hereda de la empresa (import CSV con
  // columnas de contacto, o carga manual junto con la empresa).
  return companyOrigin === "IMPORT" ? "IMPORT" : "MANUAL";
}

/**
 * Lead/Opportunity/Campaign/Activity: no tienen su propio campo de
 * procedencia — son datos DERIVADOS de una Company, así que heredan la
 * clasificación de la Company relacionada. Sin Company (Lead.companyId
 * es nullable), se usa la mejor señal disponible sin inventar nada:
 * createdByAgentTaskId presente y sin trazabilidad -> UNKNOWN (no se
 * puede afirmar de dónde salió); sin agente y sin empresa -> USER_CREATED
 * (un humano lo tuvo que haber tipeado directamente).
 */
export function classifyByCompanyRelation(params: {
  companyOrigin: DataOrigin | null;
  createdByAgentTaskId?: string | null;
}): DataOrigin {
  if (params.companyOrigin) return params.companyOrigin;
  if (params.createdByAgentTaskId) return "UNKNOWN";
  return "USER_CREATED";
}

/**
 * AgentTask/ApprovalRequest: se intenta extraer un companyId real del
 * input (la mayoría de los tools de F4.5-F4.7 lo tienen) para heredar la
 * clasificación de esa Company. discover_companies es la única
 * excepción real — no tiene un companyId de entrada (busca N empresas
 * nuevas), así que se clasifica mirando el output.sourcesUsed real (los
 * mismos strings literales "Google Places (...)"/"Hunter.io (...)" que
 * ya se loguean y persisten desde F4.5-F4.7, nunca inventados acá).
 */
function extractStringField(input: unknown, field: string): string | null {
  if (input && typeof input === "object" && field in input) {
    const v = (input as Record<string, unknown>)[field];
    if (typeof v === "string") return v;
  }
  return null;
}

export function extractCompanyIdFromTaskInput(input: unknown): string | null {
  return extractStringField(input, "companyId");
}

// F4.7.5: varios tools de F2-F4 no reciben companyId directo — reciben
// una referencia un nivel más lejos (leadId, campaignCompanyId,
// campaignId) que igual se puede resolver a una Company real, ver
// audit.ts (que arma los mapas de resolución necesarios). Ninguno de
// estos se inventa — todos son campos reales de input ya persistidos.
export function extractLeadIdFromTaskInput(input: unknown): string | null {
  return extractStringField(input, "leadId");
}
export function extractCampaignCompanyIdFromTaskInput(input: unknown): string | null {
  return extractStringField(input, "campaignCompanyId");
}
export function extractCampaignIdFromTaskInput(input: unknown): string | null {
  return extractStringField(input, "campaignId");
}

export function classifyAgentTaskBySourcesUsed(sourcesUsed: unknown): DataOrigin | null {
  if (!Array.isArray(sourcesUsed) || sourcesUsed.length === 0) return null;
  const joined = sourcesUsed.filter((s): s is string => typeof s === "string").join(" | ");
  if (joined.includes("Google Places")) return "GOOGLE_PLACES";
  if (joined.includes("People Data Labs")) return "PEOPLE_DATA_LABS";
  if (joined.includes("Hunter.io")) return "HUNTER";
  if (joined.includes("Website")) return "WEBSITE";
  if (joined.includes("Overpass") || joined.length > 0) return "API_PROVIDER";
  return null;
}
