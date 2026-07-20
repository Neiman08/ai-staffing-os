import { containsWord, normalizeText } from "./text-normalize";

/**
 * F15 (hallazgo real del PO): una misión real dijo "Prioriza empresas
 * relacionadas con QTS, Meta, Google, Microsoft, Amazon AWS, Compass
 * Datacenters..." y el sistema reportó esos nombres como "términos no
 * reconocidos" -- ninguno de ellos es un sector/industria (por eso
 * nunca matchean business-taxonomy.ts), son EMPRESAS CLIENTE reales de
 * infraestructura crítica (hyperscalers/operadores de data center) para
 * las que un contratista (eléctrico, construcción, HVAC, etc.) puede
 * trabajar como subcontratista de sus proyectos. "Buscar contratistas
 * de QTS" nunca significa "buscar empresas que SEAN QTS" -- significa
 * "buscar contratistas que trabajen EN proyectos de QTS".
 *
 * Vocabulario cerrado, igual que business-taxonomy.ts -- nunca se
 * inventa un cliente nuevo dinámicamente. Lista inicial acotada a los
 * hyperscalers/operadores de data center más comunes en el mercado real
 * de EE.UU. -- extensible agregando entradas nuevas, nunca reemplazando
 * el mecanismo. Alias de una sola palabra ambigua (ej. "Switch",
 * "Vantage", "Aligned" son también palabras comunes del idioma) se
 * evitan a propósito -- solo se agregan cuando el alias corto es
 * inequívocamente una marca (ej. "QTS", "AWS").
 */
export interface CriticalInfrastructureClient {
  /** Nombre canónico, el que se usa para armar queries de búsqueda. */
  name: string;
  aliases: string[];
  // F16 debt fix (hallazgo real del PO: "Compass, Vantage, Aligned,
  // STACK y Switch" seguían sin reconocerse pese a QTS/Meta/Google/etc.
  // sí resolver): alias cortos que SOLOS son palabras comunes del idioma
  // ("switch", "stack", "vantage", "aligned") -- nunca se reconocen
  // sueltos (evita falsos positivos reales, ej. una misión que
  // literalmente pide "instala un switch de red" no debe activar Switch
  // Data Centers). Solo se resuelven cuando el mismo texto TAMBIÉN
  // menciona contexto real de infraestructura crítica/data centers (ver
  // CRITICAL_INFRASTRUCTURE_CONTEXT_PHRASES) -- exactamente el contexto
  // en el que el PO los usó realmente ("Compass, Vantage, STACK, Aligned,
  // Switch" en una misión sobre "infraestructura crítica y proyectos de
  // data centers").
  contextualAliases?: string[];
}

export const CRITICAL_INFRASTRUCTURE_CLIENTS: CriticalInfrastructureClient[] = [
  { name: "QTS", aliases: ["QTS", "QTS Data Centers", "QTS Realty"] },
  { name: "Meta", aliases: ["Meta", "Facebook"] },
  { name: "Google", aliases: ["Google", "Google Cloud"] },
  { name: "Microsoft", aliases: ["Microsoft", "Azure", "Microsoft Azure"] },
  { name: "Amazon Web Services", aliases: ["Amazon AWS", "AWS", "Amazon Web Services", "Amazon"] },
  { name: "Compass Datacenters", aliases: ["Compass Datacenters", "Compass Data Centers"], contextualAliases: ["Compass"] },
  { name: "Digital Realty", aliases: ["Digital Realty"] },
  { name: "Equinix", aliases: ["Equinix"] },
  { name: "CyrusOne", aliases: ["CyrusOne", "Cyrus One"] },
  { name: "NTT Global Data Centers", aliases: ["NTT", "NTT Data", "NTT Global Data Centers"] },
  {
    name: "Vantage Data Centers",
    aliases: ["Vantage Data Centers"],
    contextualAliases: ["Vantage"],
  },
  {
    name: "Aligned Data Centers",
    aliases: ["Aligned Data Centers"],
    contextualAliases: ["Aligned"],
  },
  {
    name: "Switch Data Centers",
    aliases: ["Switch Data Centers", "Switch Datacenters"],
    contextualAliases: ["Switch"],
  },
  {
    name: "STACK Infrastructure",
    aliases: ["STACK Infrastructure", "Stack Infra"],
    contextualAliases: ["STACK", "Stack"],
  },
  { name: "Iron Mountain Data Centers", aliases: ["Iron Mountain Data Centers", "Iron Mountain"] },
];

export const CRITICAL_INFRASTRUCTURE_CLIENTS_VERSION = 2;

// F16 debt fix: vocabulario cerrado de frases que señalan que la misión
// realmente está hablando de infraestructura crítica/data centers --
// mismo criterio que el resto de este módulo (nunca una heurística de
// LLM, siempre texto cerrado). Solo estas frases habilitan los alias
// cortos ambiguos (contextualAliases) de arriba.
const CRITICAL_INFRASTRUCTURE_CONTEXT_PHRASES = [
  "data center",
  "data centers",
  "datacenter",
  "datacenters",
  "centro de datos",
  "centros de datos",
  "infraestructura critica",
  "critical infrastructure",
  "hyperscale",
  "colocation",
  "colocacion",
  "mission critical",
  "critical facilities",
];

function hasCriticalInfrastructureContext(normalizedText: string): boolean {
  return CRITICAL_INFRASTRUCTURE_CONTEXT_PHRASES.some((phrase) => normalizedText.includes(normalizeText(phrase)));
}

/**
 * Detecta menciones literales de clientes de infraestructura crítica en
 * texto libre -- mismo criterio de coincidencia de palabra completa que
 * business-taxonomy.ts (containsWord), nunca substring suelto. Devuelve
 * nombres CANÓNICOS únicos (nunca el alias tal como vino), en el mismo
 * orden en que aparecen en CRITICAL_INFRASTRUCTURE_CLIENTS. Los alias
 * cortos ambiguos (contextualAliases) solo cuentan cuando el mismo texto
 * también trae una señal real de contexto (ver
 * CRITICAL_INFRASTRUCTURE_CONTEXT_PHRASES) -- fuera de ese contexto,
 * "Switch"/"Vantage"/"STACK"/"Aligned"/"Compass" sueltos siguen sin
 * resolver (son palabras comunes, resolverlos siempre generaría falsos
 * positivos reales).
 */
export function detectCriticalInfrastructureClients(rawText: string): string[] {
  const normalized = normalizeText(rawText);
  const contextPresent = hasCriticalInfrastructureContext(normalized);
  const found: string[] = [];
  for (const client of CRITICAL_INFRASTRUCTURE_CLIENTS) {
    const matchedFullAlias = client.aliases.some((alias) => containsWord(normalized, normalizeText(alias)));
    const matchedContextualAlias =
      contextPresent && (client.contextualAliases ?? []).some((alias) => containsWord(normalized, normalizeText(alias)));
    if (matchedFullAlias || matchedContextualAlias) found.push(client.name);
  }
  return found;
}

/**
 * F16: clasifica (nunca descarta) un candidato descubierto cuyo NOMBRE
 * coincide con un cliente de infraestructura crítica conocido -- ej. un
 * candidato literalmente llamado "QTS Richmond Data Center" o "Meta
 * Platforms Inc." Antes de F16, Candidate Selection no distinguía este
 * caso -- el candidato solo pasaba (o no) por los mismos matches de
 * negocio que cualquier otro. La regla explícita del PO: nunca
 * auto-excluir -- clasificar como CLIENT_OWNER y dejar que la misión (o
 * una fase futura) decida si un operador de infraestructura crítica se
 * incluye o se excluye. Esto permite que el mismo motor sirva tanto para
 * buscar contratistas de esos clientes como para buscar directamente a
 * los operadores de infraestructura, sin dos pipelines distintos.
 */
export function detectClientOwnerMatch(candidateName: string | null): string[] {
  if (!candidateName || !candidateName.trim()) return [];
  const normalized = normalizeText(candidateName);
  const found: string[] = [];
  for (const client of CRITICAL_INFRASTRUCTURE_CLIENTS) {
    const matched = client.aliases.some((alias) => containsWord(normalized, normalizeText(alias)));
    if (matched) found.push(client.name);
  }
  return found;
}
