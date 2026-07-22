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
}

export function resolveBestContactChannel(input: ContactChannelInput): ContactChannelResolution {
  const verifiedPersonEmail = input.contacts.find((c) => c.email && c.emailVerificationStatus === "VERIFIED");
  if (verifiedPersonEmail) {
    return {
      channel: "VERIFIED_PERSON_EMAIL",
      value: verifiedPersonEmail.email,
      reason: "Contacto personal real con email verificado -- el canal más confiable disponible.",
      isEmailCapable: true,
    };
  }

  const verifiedOrgEmail = input.contactPoints.find((cp) => cp.verificationStatus === "VERIFIED");
  if (verifiedOrgEmail) {
    return {
      channel: "VERIFIED_ORG_EMAIL",
      value: verifiedOrgEmail.email,
      reason: "Email organizacional (info@/hr@/careers@...) verificado.",
      isEmailCapable: true,
    };
  }

  const websiteOrgEmail = input.contactPoints[0]?.email ?? input.companyEmail;
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
  if (linkedinContact) {
    return {
      channel: "LINKEDIN",
      value: linkedinContact.linkedinUrl,
      reason: "Sin email, formulario ni careers page -- LinkedIn real de un contacto encontrado.",
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
