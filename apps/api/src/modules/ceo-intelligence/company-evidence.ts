import type { HiringStatus } from "./hiring-signals";
import type { BestContactRankingTier } from "./opportunity-recommendation";

/**
 * F16: `CompanyEvidence` -- el único objeto central que representa TODA
 * la evidencia acumulada sobre una empresa candidata a lo largo del
 * pipeline de descubrimiento. Existe para eliminar de raíz la regresión
 * de F15 (business-validation.ts dependía del texto de la query de
 * búsqueda que encontró al candidato -- una query "QTS data center
 * electrical contractor" nunca debía decidir si la empresa es realmente
 * una contratista eléctrica real, eso solo lo puede decidir evidencia de
 * LA EMPRESA misma).
 *
 * Regla de dirección de datos (nunca romperla en un cambio futuro):
 *   - Discovery (mission-executor.ts, discovery-providers/*)  SOLO AGREGA evidencia.
 *   - Business/Hiring Validation (business-validation.ts, hiring-confidence.ts) SOLO LEE evidencia.
 *   - Enrichment (company-enrichment.ts, contact-enrichment.ts, hiring-signals.ts) SOLO AGREGA evidencia.
 *   - Commercial Conversion (conversion-policy.ts, discovery-conversion.ts) SOLO LEE evidencia (nunca el candidato crudo ni la query).
 *
 * Ninguna etapa lee directamente de otra etapa -- todas leen/escriben
 * este mismo modelo. Un cambio futuro en CÓMO se buscan candidatos
 * (nuevas queries, nuevos clientes, nuevas industrias, nuevos mercados)
 * nunca puede romper la validación de negocio, porque la validación
 * nunca ve la estrategia de búsqueda -- ni siquiera existe un campo acá
 * para guardarla. Ver el test de compilación en business-validation.test.ts
 * que falla si alguien reintroduce un campo de texto de búsqueda.
 */
export interface CompanyEvidence {
  // ---- Identidad -- provista por Discovery, nunca reinterpretada ----
  candidateName: string | null;
  website: string | null;
  description: string | null;
  city: string | null;
  state: string | null;

  // ---- Evidencia de negocio (leída por business-validation.ts) ----
  // Categorías reales que el proveedor de discovery le asigna a la
  // empresa -- Google Places las llama `place.types` (ej. "electrician",
  // "general_contractor"). Evidencia de primera mano: el proveedor
  // categorizó así a la empresa, nunca es texto de búsqueda nuestro.
  // Pesa tanto como el nombre del candidato (ver business-validation.ts).
  googlePlaceTypes: string[];
  // Labels de actividad de negocio declarados en la StructuredIntent de
  // la misión (ej. "electrical work") -- evidencia más débil que
  // googlePlaceTypes/website porque no viene de la empresa misma, viene
  // de lo que el usuario escribió en su instrucción.
  businessActivities: string[];
  // Servicios/frases reales extraídas del sitio de la empresa durante el
  // crawl de enrichment (F7.4 Parte B) -- se suma DESPUÉS del gate
  // inicial, evidencia real de contenido publicado por la empresa.
  websiteServices: string[];

  taxonomyKey: string;
  missionExclusions: string[];

  // ---- Clasificación cliente-vs-contratista (F16) ----
  // true cuando el nombre del candidato coincide con un cliente de
  // infraestructura crítica conocido (QTS, Meta, Google...) -- nunca se
  // descarta automáticamente por esto, solo se clasifica. La misión (o
  // una fase futura) decide si ese candidato se incluye como operador de
  // infraestructura o se excluye por ser el cliente y no un contratista.
  isClientOwnerCandidate: boolean;
  clientAssociations: string[];

  // ---- Evidencia de contratabilidad (leída por hiring-confidence.ts) ----
  hiringSignalStatus: HiringStatus | null;
  hiringSignalTitlesMatched: string[];
  hasCareersPage: boolean;
  organizationalEmailsVerified: number;
  organizationalEmailsRisky: number;
  namedContactsFound: number;
  bestContactRankingTier: BestContactRankingTier;
}

export function emptyCompanyEvidence(taxonomyKey: string): CompanyEvidence {
  return {
    candidateName: null,
    website: null,
    description: null,
    city: null,
    state: null,
    googlePlaceTypes: [],
    businessActivities: [],
    websiteServices: [],
    taxonomyKey,
    missionExclusions: [],
    isClientOwnerCandidate: false,
    clientAssociations: [],
    hiringSignalStatus: null,
    hiringSignalTitlesMatched: [],
    hasCareersPage: false,
    organizationalEmailsVerified: 0,
    organizationalEmailsRisky: 0,
    namedContactsFound: 0,
    bestContactRankingTier: null,
  };
}
