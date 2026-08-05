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

// F34 (auditoría arquitectónica transversal, hallazgo real
// MIS-20260805-0002, 2026-08-05): "property maintenance", "apartment
// maintenance", "facility maintenance" y "building maintenance" -- 4
// tipos de empresa que el usuario pidió explícitamente, EXACTAMENTE en
// una cláusula "empresas nuevas de X" -- terminaban descartados por
// completo por este módulo, porque "Maintenance" (jobTitle suelto de la
// entrada de Hospitality en taxonomy.ts, agregado para hiring signals,
// nunca pensado como vocabulario de exclusión de tipos de empresa)
// aparecía como SUBSTRING de cada uno de los 4 términos -- la
// comparación bidireccional `containsWord` de abajo (versión anterior)
// clasificaba "contiene la palabra 'maintenance' en cualquier lugar"
// como "es un rol", sin importar que el resto del término ("property",
// "apartment", "facility", "building") fuera vocabulario de negocio
// real y nunca apareciera en ningún rol/objeto/acción conocido. Esto
// dejó literalCompanyTypeTerms=[], searchTerms=[], plannedSteps sin
// discover_companies -- la misión completa nunca ejecutó descubrimiento
// real y select_target_companies terminó reutilizando en silencio 20
// empresas de industrias completamente ajenas (ver mission-orchestrator.ts,
// industryTargets=[null] cuando industries.length===0 &&
// searchQueries.length===0).
//
// Fix estructural (no una lista de palabras nueva): un término deja de
// clasificarse como rol/objeto/acción/capacidad por CONTENER una palabra
// conocida -- ahora debe estar COMPUESTO ÍNTEGRAMENTE por palabras que
// pertenecen a UN MISMO término conocido (candidateWords ⊆ knownWords de
// ALGÚN término de la lista, nunca la unión de todos). "property
// maintenance" ({property, maintenance}) nunca es subconjunto de
// {maintenance} solo -- "property" no es vocabulario de rol/acción/
// objeto/capacidad conocido bajo ninguna entrada, así que el término
// completo sobrevive como candidato real a tipo de empresa. "Quality
// Inspectors" ({quality, inspector}) SÍ es subconjunto del jobTitle real
// "Quality Control Inspector" ({quality, control, inspector}) -- sigue
// clasificándose como rol correctamente, sin agregar ninguna palabra
// nueva al vocabulario cerrado.
export function tokenizeToWords(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .map((w) => singularizeForComparison(w));
}

/**
 * True si TODAS las palabras de `term` (normalizadas, singularizadas)
 * están contenidas en el conjunto de palabras de ALGÚN término único de
 * `knownTerms` -- nunca en la unión de todos, para que dos términos
 * conocidos distintos ("Property Manager" + "Maintenance") nunca puedan
 * combinarse para "cubrir" un tercer término real no relacionado
 * ("Property Maintenance"). Candidato vacío nunca matchea.
 */
/**
 * True si TODAS las palabras de `term` (normalizadas, singularizadas)
 * están contenidas en el conjunto de palabras de ALGÚN término único de
 * `knownTerms` -- nunca en la unión de todos, para que dos términos
 * conocidos distintos ("Property Manager" + "Maintenance") nunca puedan
 * combinarse para "cubrir" un tercer término real no relacionado
 * ("Property Maintenance"). Candidato vacío nunca matchea.
 *
 * Deliberadamente de UNA sola dirección (candidato ⊆ conocido, nunca al
 * revés) -- usado tanto para "¿term es un rol/objeto/acción/capacidad
 * conocida?" (classifyNonIndustryTerm) como para cruces entre campos de
 * una misma misión (ej. "¿este candidato a tipo de empresa es en
 * realidad el mismo puesto/decisor que esta misión ya nombró en su
 * propia cláusula de contratación/contacto?", ver intent-interpreter.ts
 * F34). La dirección inversa (conocido ⊆ candidato) reintroduciría el
 * mismo bug real que este módulo corrige: "property maintenance"
 * ({property, maintenance}) nunca debe matchear contra un puesto
 * "Maintenance" suelto ({maintenance}) solo porque {maintenance} ⊆
 * {property, maintenance} -- el candidato agrega una palabra propia
 * ("property") que el puesto no tiene, así que es un concepto distinto,
 * sin importar que el puesto sea un subconjunto literal del candidato.
 */
export function isFullyComposedOfKnownWords(term: string, knownTerms: Iterable<string>): boolean {
  const candidateWords = tokenizeToWords(term);
  if (candidateWords.length === 0) return false;
  for (const known of knownTerms) {
    const knownWords = new Set(tokenizeToWords(known));
    if (knownWords.size === 0) continue;
    if (candidateWords.every((w) => knownWords.has(w))) return true;
  }
  return false;
}

/**
 * True si `term` es un rol/objeto/acción/capacidad conocida -- nunca
 * una industria, sin importar cuán desconocida sea la industria real.
 * Ver isFullyComposedOfKnownWords -- composición completa de palabras
 * contra UN término conocido, nunca substring parcial suelto.
 */
export function isKnownNonIndustryTerm(term: string): boolean {
  const normalized = normalizeText(term.trim());
  if (!normalized) return true; // string vacío nunca es una industria real
  return classifyNonIndustryTerm(term) !== null;
}

// F34: comparación bidireccional clásica (substring con límite de
// palabra, en cualquier dirección) -- SOLO para capability/crm_object/
// action. Estas 3 categorías son frases de producto/pipeline de bajo
// riesgo de colisión real contra un nombre de negocio genuino (ningún
// candidato real a tipo de empresa se llama "Contact Intelligence" o
// "señales de contratación") y, a diferencia de los roles humanos,
// necesitan reconocer construcciones elípticas reales del español
// ("señales de contratación O crecimiento" == "señales de contratación"
// + "señales de crecimiento" con el sujeto compartido elidido) que la
// composición estricta de palabras (ver isFullyComposedOfKnownWords) no
// puede cubrir sin arriesgar exactamente el bug que esa función corrige
// para roles (dos términos DISTINTOS combinándose para cubrir un
// tercero no relacionado). El vocabulario de roles (`role`, ver abajo)
// es el único que usa la composición estricta -- ahí SÍ vive el riesgo
// real de colisión (F34, "property maintenance" vs. jobTitle suelto
// "Maintenance").
function matchesAnyBidirectional(term: string, list: string[]): boolean {
  const normalized = normalizeText(term.trim());
  return list.some((known) => {
    const nw = normalizeText(known);
    return normalized === nw || containsWord(normalized, nw) || containsWord(nw, normalized);
  });
}

/**
 * Clasifica un término por función -- devuelve null si no es ninguna de
 * las categorías cerradas conocidas (candidato real a tipo de empresa/
 * actividad de negocio, sea o no reconocido por BUSINESS_TAXONOMY).
 */
export function classifyNonIndustryTerm(term: string): NonIndustryTermCategory | null {
  const normalized = normalizeText(term.trim());
  if (!normalized) return null;
  // Capacidades primero -- son frases más específicas (ej. "Contact
  // Intelligence") que de otro modo matchearían por substring contra un
  // objeto del CRM más genérico ("contact"). Precisión sobre recall acá
  // no importa para el uso real (ambas categorías excluyen igual de una
  // industria desconocida), pero un rótulo más específico es más útil
  // para debugging/logs.
  if (matchesAnyBidirectional(term, CAPABILITY_TERMS)) return "capability";
  // F34: única categoría con composición ESTRICTA (candidato compuesto
  // ÍNTEGRAMENTE por las palabras de UN rol conocido) -- ver el
  // comentario de diseño en isFullyComposedOfKnownWords.
  if (isFullyComposedOfKnownWords(term, [...TAXONOMY_ROLE_VOCAB, ...EXTRA_ROLE_TERMS])) return "role";
  if (matchesAnyBidirectional(term, CRM_OBJECT_TERMS)) return "crm_object";
  if (matchesAnyBidirectional(term, ACTION_TERMS)) return "action";
  return null;
}
