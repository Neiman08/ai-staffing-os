import { BUSINESS_TAXONOMY } from "./taxonomy";
import { normalizeText, containsWord } from "./text-normalize";

/**
 * F32 (auditoría arquitectónica, hallazgo real MIS-20260731-0002/0003,
 * 2026-07-31): capa general de normalización semántica -- reemplaza
 * pequeños parches ad-hoc dispersos (KNOWN_CAPABILITY_TERMS en
 * ceo-tools.impl.ts, comparaciones de substring sueltas) por una sola
 * fuente de verdad, reutilizable por CUALQUIER consumidor que necesite
 * distinguir "esto es un tipo de empresa/industria potencial" de "esto
 * es un rol, un objeto del CRM, una acción del pipeline, o una
 * capacidad del producto -- nunca una industria, sin importar cuán
 * desconocida sea la industria real".
 *
 * Deliberadamente NO intenta resolver industrias -- BUSINESS_TAXONOMY
 * (taxonomy.ts) sigue siendo la única fuente de verdad para eso. Este
 * módulo solo sabe reconocer el vocabulario CERRADO y genuinamente
 * pequeño de roles/objetos/acciones/capacidades que NUNCA debe
 * confundirse con una industria -- estos sí son un conjunto cerrado
 * legítimo (los roles de decisión, los objetos del CRM, los verbos del
 * pipeline no cambian tan seguido como las industrias reales del
 * mercado), a diferencia del vocabulario de industrias, que es
 * abierto por naturaleza.
 */

// Vocabulario derivado de la propia taxonomía -- nunca un catálogo
// paralelo. Cualquier decisionMaker/jobTitle ya declarado en cualquier
// entrada de BUSINESS_TAXONOMY es, por definición, un rol humano, nunca
// una industria -- sin importar si la entrada que lo declaró matcheó o
// no en una instrucción dada.
const TAXONOMY_ROLE_VOCAB = new Set(
  BUSINESS_TAXONOMY.flatMap((entry) => [...entry.decisionMakers, ...entry.jobTitles]).map((t) => normalizeText(t)),
);

// F32: roles/fragmentos de rol reales que aparecen sueltos en
// instrucciones reales (ej. "HR" sin "Manager", "Recruiting" sin
// "-er") -- ninguno está cubierto por el vocabulario de la taxonomía de
// arriba porque esta guarda formas completas ("HR Manager", "Recruiter").
// Vocabulario cerrado deliberado -- roles de decisión/contratación son
// un dominio genuinamente acotado, a diferencia de industrias.
const EXTRA_ROLE_TERMS = [
  "owner",
  "president",
  "ceo",
  "cfo",
  "coo",
  "hr",
  "human resources",
  "recruiting",
  "recruiter",
  "talent acquisition",
  "operations manager",
  "office manager",
  "branch manager",
  "general manager",
  "plant manager",
  "project manager",
  "facilities manager",
  "hiring manager",
  "decision maker",
  "responsable de contratacion",
  "responsables de contratacion",
];

// Objetos reales del CRM/producto -- nunca una industria. Incluye forma
// singular Y plural explícita (nunca se infiere pluralización acá, ver
// singularizeForComparison más abajo para la comparación real).
const CRM_OBJECT_TERMS = [
  "company",
  "companies",
  "contact",
  "contacts",
  "lead",
  "leads",
  "opportunity",
  "opportunities",
  "draft",
  "drafts",
  "campaign",
  "campaigns",
  "sequence",
  "sequences",
  "email draft",
  "email drafts",
  "approval request",
  "mission",
  "misiones",
];

// Acciones/verbos del pipeline -- nunca un tipo de empresa.
const ACTION_TERMS = [
  "crear",
  "crea",
  "verificar",
  "verifica",
  "enriquecer",
  "enriquece",
  "buscar",
  "busca",
  "encuentra",
  "encontrar",
  "identifica",
  "identificar",
  "generar",
  "genera",
  "excluye",
  "excluir",
  "prioriza",
  "priorizar",
  "create",
  "verify",
  "enrich",
  "find",
  "search",
  "identify",
  "generate",
  "exclude",
  "prioritize",
  "emails validos",
  "valid emails",
  "senales de contratacion",
  "hiring signals",
];

// Capacidades/objetos reales del propio producto -- nunca un sector
// (F28, ver ceo-tools.impl.ts, ahora centralizado acá).
const CAPABILITY_TERMS = [
  "discovery",
  "descubrimiento",
  "company enrichment",
  "enriquecimiento de empresas",
  "enriquecimiento de companias",
  "contact intelligence",
  "inteligencia de contactos",
  "email verification",
  "verificacion de email",
  "verificacion de correo",
  "verificacion de emails",
  "hiring signals",
  "senales de contratacion",
  "growth signals",
  "senales de crecimiento",
];

const CLOSED_NON_INDUSTRY_VOCAB = new Set(
  [...TAXONOMY_ROLE_VOCAB, ...EXTRA_ROLE_TERMS, ...CRM_OBJECT_TERMS, ...ACTION_TERMS, ...CAPABILITY_TERMS].map((t) =>
    normalizeText(t),
  ),
);

export type NonIndustryTermCategory = "role" | "crm_object" | "action" | "capability";

/**
 * Normaliza un plural regular simple (inglés/español) para comparación
 * -- nunca para mostrar al usuario. Cubre los patrones reales
 * encontrados en producción ("Opportunity" vs "opportunities" nunca
 * matcheaba por comparación de substring cruda, ver ceo-tools.impl.ts
 * F32) -- deliberadamente conservador (nunca stemming agresivo que
 * pueda confundir dos palabras distintas).
 */
export function singularizeForComparison(term: string): string {
  const normalized = normalizeText(term.trim());
  if (normalized.endsWith("ies") && normalized.length > 4) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith("es") && normalized.length > 3) return normalized.slice(0, -2);
  if (normalized.endsWith("s") && normalized.length > 2) return normalized.slice(0, -1);
  return normalized;
}

/**
 * True si `term` es un rol/objeto/acción/capacidad conocida -- nunca
 * una industria, sin importar cuán desconocida sea la industria real.
 * Comparación bidireccional y tolerante a plural simple, mismo criterio
 * que el resto de este módulo (ver singularizeForComparison).
 */
export function isKnownNonIndustryTerm(term: string): boolean {
  const normalized = normalizeText(term.trim());
  if (!normalized) return true; // string vacío nunca es una industria real
  const singular = singularizeForComparison(term);

  for (const known of CLOSED_NON_INDUSTRY_VOCAB) {
    const knownSingular = singularizeForComparison(known);
    if (
      normalized === known ||
      singular === knownSingular ||
      containsWord(normalized, known) ||
      containsWord(known, normalized)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Clasifica un término por función -- devuelve null si no es ninguna de
 * las categorías cerradas conocidas (candidato real a tipo de empresa/
 * actividad de negocio, sea o no reconocido por BUSINESS_TAXONOMY).
 */
export function classifyNonIndustryTerm(term: string): NonIndustryTermCategory | null {
  const normalized = normalizeText(term.trim());
  if (!normalized) return null;
  const matchesAny = (list: string[]) => list.some((w) => {
    const nw = normalizeText(w);
    return normalized === nw || containsWord(normalized, nw) || containsWord(nw, normalized);
  });
  // Capacidades primero -- son frases más específicas (ej. "Contact
  // Intelligence") que de otro modo matchearían por substring contra un
  // objeto del CRM más genérico ("contact"). Precisión sobre recall acá
  // no importa para el uso real (ambas categorías excluyen igual de una
  // industria desconocida), pero un rótulo más específico es más útil
  // para debugging/logs.
  if (matchesAny(CAPABILITY_TERMS)) return "capability";
  if (matchesAny([...TAXONOMY_ROLE_VOCAB, ...EXTRA_ROLE_TERMS])) return "role";
  if (matchesAny(CRM_OBJECT_TERMS)) return "crm_object";
  if (matchesAny(ACTION_TERMS)) return "action";
  return null;
}
