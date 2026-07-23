/**
 * F4.7 §1: shape de solo-lectura devuelto por Website Intelligence — nunca
 * un dato inventado, cada campo trae su URL exacta de origen. No es un
 * "proveedor" en el sentido de contact-providers/discovery-providers (no
 * cobra, no tiene API key) — igual se le da forma de resultado consistente
 * porque email-providers/website-public-email.ts lo envuelve como fuente
 * #1 del contrato de email discovery (ver docs/F4_7_EMAIL_INTELLIGENCE_PLAN.md §1.4).
 */
export interface WebsiteNamedPerson {
  firstName: string;
  lastName: string;
  title: string | null;
  email: string | null; // solo si el mailto:/texto de la misma tarjeta lo trae
  sourceUrl: string;
}

export interface WebsiteGenericEmail {
  email: string;
  sourceUrl: string;
}

export interface WebsiteGenericPhone {
  phone: string;
  sourceUrl: string;
}

// F7.5: texto visible de una página ya crawleada, acotado -- ver
// PageExtraction.visibleText en extract.ts para el porqué.
export interface WebsitePageText {
  url: string;
  text: string;
}

// F22 Fase 2/5 (Contact Acquisition Engine): cómo se descubrió CADA página
// visitada -- nunca un solo booleano global, para poder medir qué
// estrategia de descubrimiento realmente aporta (Fase 5, observabilidad).
export type PageDiscoveryMethod = "home" | "sitemap" | "home_link" | "common_path_guess";

// F22 Fase 2: formulario de contacto real -- se registra SIEMPRE que
// exista, aunque no haya ningún email en la misma página (regla explícita
// del PO: "Registrar... aunque no exista email"). `action` es la URL
// absoluta resuelta del atributo `action` del <form> -- null cuando el
// form no declara uno (submit a la misma página) o el valor no es una URL
// válida, nunca inventado.
export interface WebsiteContactFormInfo {
  url: string;
  method: string;
  action: string | null;
}

// F22 Fase 2: evidencia real de una página de careers -- no solo el path
// (contact-channel.ts ya usaba eso), también contenido literal
// ("we are hiring", "open positions"...) para casos donde la URL no seria
// obvia pero el contenido sí lo es.
export interface WebsiteCareersEvidence {
  url: string;
  evidence: string;
  hasContactForm: boolean;
}

export interface WebsiteIntelligenceResult {
  namedPeople: WebsiteNamedPerson[];
  genericEmails: WebsiteGenericEmail[];
  genericPhones: WebsiteGenericPhone[];
  hasContactForm: boolean;
  contactFormUrl: string | null;
  hasCareersPage: boolean;
  careersPageUrl: string | null;
  // F7.5: texto visible por página visitada -- aditivo, cero impacto en
  // consumidores existentes (email-providers/website-public-email.ts no
  // lo lee). Fuente para hiring-signals.ts, nunca para un re-crawl.
  pageTexts: WebsitePageText[];
  patternsFailed: string[];
  cancelled: boolean;
  blockedByRobots: boolean;

  // ---------- F22 Fase 2: descubrimiento de páginas ----------
  sitemapFound: boolean;
  sitemapUrl: string | null;
  pagesVisited: string[];
  // Método real por el que se descubrió CADA url de pagesVisited (mismo
  // orden/claves) -- "home" siempre para la primera.
  pageDiscoveryMethod: Record<string, PageDiscoveryMethod>;

  // ---------- F22 Fase 2: canales alternativos, NUNCA se descarta ninguno ----------
  // Todos los formularios/evidencia de careers/LinkedIn encontrados, no
  // solo el "mejor" -- "nunca eliminar canales inferiores" (Fase 4).
  contactForms: WebsiteContactFormInfo[];
  careersEvidence: WebsiteCareersEvidence[];
  // LinkedIn corporativo -- SOLO si viene de un link real en el propio
  // sitio oficial (o de su JSON-LD `sameAs`) -- nunca de una búsqueda en
  // Google (la regla lo prohíbe explícitamente, y estructuralmente este
  // módulo nunca hace una request fuera del dominio de la Company).
  linkedinUrl: string | null;
  linkedinSourceUrl: string | null;
  structuredDataEmailsFound: number;

  // ---------- F22 Fase 3: renderizado headless ----------
  headlessPagesRendered: string[];
  headlessRenderDurationMs: number;
}

export function emptyWebsiteIntelligenceResult(): WebsiteIntelligenceResult {
  return {
    namedPeople: [],
    genericEmails: [],
    genericPhones: [],
    hasContactForm: false,
    contactFormUrl: null,
    hasCareersPage: false,
    careersPageUrl: null,
    pagesVisited: [],
    pageTexts: [],
    patternsFailed: [],
    cancelled: false,
    blockedByRobots: false,
    sitemapFound: false,
    sitemapUrl: null,
    pageDiscoveryMethod: {},
    contactForms: [],
    careersEvidence: [],
    linkedinUrl: null,
    linkedinSourceUrl: null,
    structuredDataEmailsFound: 0,
    headlessPagesRendered: [],
    headlessRenderDurationMs: 0,
  };
}
