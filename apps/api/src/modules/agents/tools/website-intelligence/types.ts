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

export interface WebsiteIntelligenceResult {
  namedPeople: WebsiteNamedPerson[];
  genericEmails: WebsiteGenericEmail[];
  genericPhones: WebsiteGenericPhone[];
  hasContactForm: boolean;
  contactFormUrl: string | null;
  hasCareersPage: boolean;
  careersPageUrl: string | null;
  pagesVisited: string[];
  // F7.5: texto visible por página visitada -- aditivo, cero impacto en
  // consumidores existentes (email-providers/website-public-email.ts no
  // lo lee). Fuente para hiring-signals.ts, nunca para un re-crawl.
  pageTexts: WebsitePageText[];
  patternsFailed: string[];
  cancelled: boolean;
  blockedByRobots: boolean;
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
  };
}
