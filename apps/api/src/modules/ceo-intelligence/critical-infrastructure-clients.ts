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
}

export const CRITICAL_INFRASTRUCTURE_CLIENTS: CriticalInfrastructureClient[] = [
  { name: "QTS", aliases: ["QTS", "QTS Data Centers", "QTS Realty"] },
  { name: "Meta", aliases: ["Meta", "Facebook"] },
  { name: "Google", aliases: ["Google", "Google Cloud"] },
  { name: "Microsoft", aliases: ["Microsoft", "Azure", "Microsoft Azure"] },
  { name: "Amazon Web Services", aliases: ["Amazon AWS", "AWS", "Amazon Web Services", "Amazon"] },
  { name: "Compass Datacenters", aliases: ["Compass Datacenters", "Compass Data Centers"] },
  { name: "Digital Realty", aliases: ["Digital Realty"] },
  { name: "Equinix", aliases: ["Equinix"] },
  { name: "CyrusOne", aliases: ["CyrusOne", "Cyrus One"] },
  { name: "NTT Global Data Centers", aliases: ["NTT", "NTT Data", "NTT Global Data Centers"] },
  // "Vantage"/"Aligned"/"Switch" solos son palabras comunes -- solo se
  // reconoce la marca completa, nunca el alias corto ambiguo.
  { name: "Vantage Data Centers", aliases: ["Vantage Data Centers"] },
  { name: "Aligned Data Centers", aliases: ["Aligned Data Centers"] },
  { name: "Switch Data Centers", aliases: ["Switch Data Centers", "Switch Datacenters"] },
  { name: "STACK Infrastructure", aliases: ["STACK Infrastructure", "Stack Infra"] },
  { name: "Iron Mountain Data Centers", aliases: ["Iron Mountain Data Centers", "Iron Mountain"] },
];

export const CRITICAL_INFRASTRUCTURE_CLIENTS_VERSION = 1;

/**
 * Detecta menciones literales de clientes de infraestructura crítica en
 * texto libre -- mismo criterio de coincidencia de palabra completa que
 * business-taxonomy.ts (containsWord), nunca substring suelto. Devuelve
 * nombres CANÓNICOS únicos (nunca el alias tal como vino), en el mismo
 * orden en que aparecen en CRITICAL_INFRASTRUCTURE_CLIENTS.
 */
export function detectCriticalInfrastructureClients(rawText: string): string[] {
  const normalized = normalizeText(rawText);
  const found: string[] = [];
  for (const client of CRITICAL_INFRASTRUCTURE_CLIENTS) {
    const matched = client.aliases.some((alias) => containsWord(normalized, normalizeText(alias)));
    if (matched) found.push(client.name);
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
