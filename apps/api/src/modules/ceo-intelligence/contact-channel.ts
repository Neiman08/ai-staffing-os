/**
 * F21 Fase 2 (estrategia de contacto por prioridad, pedido explícito del
 * PO): People Data Labs puede devolver 402 (créditos agotados) y
 * Hunter.io puede devolver 429 (rate limit) -- la cascada de
 * contact-enrichment.ts/company-enrichment.ts ya sigue adelante sin
 * detenerse ante esos fallos (ver providersOmitted/patternsFailed en
 * ambos módulos). Lo que faltaba era una única función, pura y
 * determinista, que decida CUÁL es el mejor canal disponible para
 * contactar una Company, en el orden de prioridad exacto pedido:
 *
 *   1. Contacto personal verificado (Contact.email + emailVerificationStatus VERIFIED)
 *   2. Email corporativo verificado (CompanyContactPoint.verificationStatus VERIFIED)
 *   3. Email organizacional encontrado en el sitio oficial (sin verificar todavía)
 *   4. Formulario de contacto (website-intelligence, contactFormUrl)
 *   5. Página de careers/jobs (website-intelligence, careersPageUrl)
 *   6. LinkedIn corporativo (Contact.linkedinUrl real, nunca inventado)
 *   7. Teléfono principal (Company.phone)
 *
 * Nunca inventa un email/nombre/cargo -- cada tier solo mira evidencia
 * ya persistida por un proveedor real. Cuando ningún canal está
 * disponible, el resultado es NONE (nunca se descarta la Company del
 * CRM por esto -- la ausencia de canal es un hecho a reportar, no un
 * motivo de eliminación).
 */

import { FREE_EMAIL_PROVIDERS } from "./email-trust";

export type ContactChannelType =
  | "VERIFIED_PERSON_EMAIL"
  | "VERIFIED_ORG_EMAIL"
  | "WEBSITE_ORG_EMAIL"
  | "CONTACT_FORM"
  | "CAREERS_PAGE"
  | "LINKEDIN"
  | "PHONE"
  | "NONE";

// Tiers 1-3 son los únicos con un email real utilizable para redactar un
// borrador -- tiers 4-7 son canales alternativos reales, pero
// personalizeMessage (outreach-tools.impl.ts) nunca intenta redactar un
// "email" para un formulario/careers page/LinkedIn/teléfono.
const EMAIL_CAPABLE_CHANNELS = new Set<ContactChannelType>(["VERIFIED_PERSON_EMAIL", "VERIFIED_ORG_EMAIL", "WEBSITE_ORG_EMAIL"]);

export interface ContactChannelResolution {
  channel: ContactChannelType;
  /** Email, URL de formulario/careers/LinkedIn, o número de teléfono -- según el channel. Null solo cuando channel === "NONE". */
  value: string | null;
  reason: string;
  isEmailCapable: boolean;
}

export interface ContactChannelContactInput {
  email: string | null;
  emailVerificationStatus: string | null;
  linkedinUrl: string | null;
  // F24 (auditoría de producción): Contact.verificationStatus (procedencia
  // del CONTACTO, no de la entregabilidad del email) -- "CONFIRMED"
  // significa que un humano proveyó este contacto explícitamente (ej.
  // CSV/import manual), nunca inferido/scrapeado. Un contacto humano-
  // confirmado con email es tan confiable como uno con emailVerificationStatus
  // VERIFIED aunque ningún proveedor de verificación lo haya tocado
  // todavía -- nunca se equipara un contacto INFERRED/UNVERIFIED (scraping)
  // con uno que un humano tipeó a mano.
  verificationStatus?: string | null;
}

export interface ContactChannelContactPointInput {
  email: string;
  verificationStatus: string;
}

export interface ContactChannelInput {
  contacts: ContactChannelContactInput[];
  contactPoints: ContactChannelContactPointInput[];
  companyEmail: string | null;
  companyPhone: string | null;
  careersPageUrl: string | null;
  contactFormUrl: string | null;
  // F22 (Contact Acquisition Engine, Fase 4): LinkedIn CORPORATIVO
  // encontrado por el crawler en el propio sitio oficial (link real o
  // JSON-LD `sameAs`) -- distinto de un LinkedIn de un Contact/persona
  // real. Cualquiera de los dos alcanza para el tier LINKEDIN, nunca se
  // inventa uno a partir del otro.
  companyLinkedinUrl: string | null;
}

// F24 (auditoría de producción, hallazgo real): el crawler de Website
// Intelligence a veces concatena un número de teléfono adyacente en el
// texto de la página con el email real que le sigue (sin espacio de por
// medio) -- ej. "romance@essencesuites.com" terminaba guardado también
// como "7084033300romance@essencesuites.com" y "states7084033300romance@
// essencesuites.com". Ambas variantes contaminadas quedaban con el mismo
// verificationStatus que la limpia, y `contactPoints[0]` (orden de
// inserción, no de calidad) podía elegir cualquiera de las tres. Esta
// regex detecta una corrida de 6+ dígitos (con separadores . o - entre
// ellos tolerados) en CUALQUIER posición del local-part -- ni un año de
// 4 dígitos ni una extensión corta de 2-3 dígitos disparan un falso
// positivo, pero un teléfono real (7-10 dígitos, con o sin separadores)
// siempre lo hace.
const PHONE_CONTAMINATION_RE = /(?:\d[.\-]?){6,}/;

function localPart(email: string): string {
  return email.split("@")[0] ?? "";
}

function domainPart(email: string): string {
  return (email.split("@")[1] ?? "").toLowerCase();
}

function isPhoneContaminated(email: string): boolean {
  return PHONE_CONTAMINATION_RE.test(localPart(email));
}

function isFreeEmailProvider(email: string): boolean {
  return (FREE_EMAIL_PROVIDERS as readonly string[]).includes(domainPart(email));
}

/**
 * F24: dentro de un mismo tier, elige el mejor candidato real por
 * scoring en vez de confiar en el orden del array (que es orden de
 * inserción/crawl, no de calidad):
 *   1. Descarta cualquier email contaminado con una secuencia telefónica
 *      -- nunca se usa, ni siquiera como último recurso (nunca se
 *      inventa/corrige, se prefiere degradar de tier antes que enviar a
 *      un alias roto).
 *   2. Opcionalmente descarta proveedores de email personal/gratuito
 *      (gmail.com...) -- nunca es evidencia de dominio propio de la
 *      empresa (mismo criterio que email-trust.ts).
 *   3. Entre los que sobreviven, prefiere el local-part más corto --
 *      cuando dos variantes representan el mismo alias real (ej.
 *      "romance@" vs "7084033300romance@"), la más corta es casi
 *      siempre la limpia. Empate final: orden alfabético, para que el
 *      resultado sea determinista sin importar el orden de entrada.
 */
function pickBestEmail(candidates: string[], opts: { excludeFreeProviders: boolean }): string | null {
  const clean = candidates.filter((email) => email && !isPhoneContaminated(email) && (!opts.excludeFreeProviders || !isFreeEmailProvider(email)));
  if (clean.length === 0) return null;
  return clean.slice().sort((a, b) => localPart(a).length - localPart(b).length || a.localeCompare(b))[0]!;
}

export function resolveBestContactChannel(input: ContactChannelInput): ContactChannelResolution {
  const verifiedPersonEmail = pickBestEmail(
    input.contacts
      .filter((c) => c.email && (c.emailVerificationStatus === "VERIFIED" || c.verificationStatus === "CONFIRMED"))
      .map((c) => c.email!),
    { excludeFreeProviders: false },
  );
  if (verifiedPersonEmail) {
    return {
      channel: "VERIFIED_PERSON_EMAIL",
      value: verifiedPersonEmail,
      reason: "Contacto personal real con email verificado o explícitamente confirmado por un humano -- el canal más confiable disponible.",
      isEmailCapable: true,
    };
  }

  const verifiedOrgEmail = pickBestEmail(
    input.contactPoints.filter((cp) => cp.verificationStatus === "VERIFIED").map((cp) => cp.email),
    { excludeFreeProviders: true },
  );
  if (verifiedOrgEmail) {
    return {
      channel: "VERIFIED_ORG_EMAIL",
      value: verifiedOrgEmail,
      reason: "Email organizacional (info@/hr@/careers@...) verificado.",
      isEmailCapable: true,
    };
  }

  const websiteOrgEmail = pickBestEmail(
    [...input.contactPoints.map((cp) => cp.email), ...(input.companyEmail ? [input.companyEmail] : [])],
    { excludeFreeProviders: true },
  );
  if (websiteOrgEmail) {
    return {
      channel: "WEBSITE_ORG_EMAIL",
      value: websiteOrgEmail,
      reason: "Email organizacional encontrado en el sitio oficial, sin verificación de entregabilidad todavía.",
      isEmailCapable: true,
    };
  }

  if (input.contactFormUrl) {
    return {
      channel: "CONTACT_FORM",
      value: input.contactFormUrl,
      reason: "Sin ningún email disponible -- formulario de contacto real encontrado en el sitio oficial.",
      isEmailCapable: false,
    };
  }

  if (input.careersPageUrl) {
    return {
      channel: "CAREERS_PAGE",
      value: input.careersPageUrl,
      reason: "Sin ningún email ni formulario disponible -- página de careers/jobs real encontrada en el sitio oficial.",
      isEmailCapable: false,
    };
  }

  const linkedinContact = input.contacts.find((c) => c.linkedinUrl);
  if (linkedinContact || input.companyLinkedinUrl) {
    return {
      channel: "LINKEDIN",
      value: linkedinContact?.linkedinUrl ?? input.companyLinkedinUrl,
      reason: linkedinContact
        ? "Sin email, formulario ni careers page -- LinkedIn real de un contacto encontrado."
        : "Sin email, formulario ni careers page -- LinkedIn corporativo real encontrado en el sitio oficial.",
      isEmailCapable: false,
    };
  }

  if (input.companyPhone) {
    return {
      channel: "PHONE",
      value: input.companyPhone,
      reason: "Sin email, formulario, careers page ni LinkedIn -- solo queda el teléfono principal de la empresa.",
      isEmailCapable: false,
    };
  }

  return {
    channel: "NONE",
    value: null,
    reason: "Ningún canal de contacto real disponible todavía -- requiere investigación manual. La Company sigue siendo válida en el CRM.",
    isEmailCapable: false,
  };
}

export function isEmailCapableChannel(channel: ContactChannelType): boolean {
  return EMAIL_CAPABLE_CHANNELS.has(channel);
}
