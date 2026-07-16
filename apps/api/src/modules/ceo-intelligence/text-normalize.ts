// F7.1: normalizacion minima compartida por el interprete -- minusculas +
// sin acentos, mismo criterio ya usado en packages/agents/src/tools/
// mission-restrictions.ts (esa funcion es privada de ese modulo, asi
// que se replica aca en vez de exportarla desde ahi -- 3 lineas, no una
// dependencia nueva entre paquetes).
// Construido con String.fromCharCode (en vez de un literal /\uXXXX-\uYYYY/
// en el regex) a propósito -- evita cualquier ambigüedad de encoding del
// rango de marcas diacríticas combinantes de Unicode.
const COMBINING_DIACRITICS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, "g");

export function normalizeText(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(COMBINING_DIACRITICS, "");
}

/**
 * True si `needle` aparece en `haystack` en un limite de palabra real --
 * evita que "hr" matchee dentro de "chair". Tolera un plural regular en
 * ingles (una "s" final opcional) porque las instrucciones reales
 * pluralizan libremente los titulos de trabajo que la taxonomia guarda
 * en singular (ej. "Forklift Operator" vs. "Forklift Operators",
 * "Dishwasher" vs. "Dishwashers") -- variantes mas irregulares (plurales
 * en espanol con cambio de raiz, etc.) se resuelven agregando la
 * variante literal a la taxonomia misma (unica fuente de verdad), nunca
 * con reglas de stemming mas "inteligentes" y menos predecibles acá.
 */
export function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}s?(?:$|[^a-z0-9])`, "i").test(` ${haystack} `);
}
