/**
 * F7.4 Parte B: Email Trust -- puro, determinista, sin Prisma/fetch/LLM
 * (mismo criterio que el resto de ceo-intelligence/). Resuelve
 * específicamente el bug real reportado por el PO: un email encontrado
 * en una página cualquiera (ej. editor@collegefencing360.com) terminaba
 * escrito en Company.email de una empresa completamente distinta
 * (generalmanufacturing.net) sin ninguna comparación de dominio — ver
 * contact-intelligence-tools.impl.ts líneas 355-369 (findEmailTool),
 * NO modificado en esta fase (ver alcance F7.4: solo se conecta la
 * validación nueva al flujo NUEVO de mission-executor.ts).
 *
 * El vocabulario de estados (`EmailTrustOutcome`) espeja literalmente
 * `EmailVerificationOutcome` de apps/api/src/modules/agents/tools/
 * email-verification-providers/types.ts — mismo significado exacto
 * (VERIFIED/RISKY/INVALID/UNKNOWN), mismo enum real de Prisma
 * (EmailVerificationStatus) del otro lado. Se duplica el shape acá en
 * vez de importarlo: ceo-intelligence/ nunca depende de apps/api/
 * modules/agents/ (ese sí depende de Prisma/env) — mismo criterio de
 * "mirror the shape, not the dependency" ya establecido en
 * discovery-identity.ts (F7.3) y en missionRestrictionsSchema (F7.2).
 * Reutiliza también el mismo criterio de normalización ya escrito y
 * probado en packages/db/scripts/illinois-backfill-lib.mjs
 * (normalizeEmail/PLACEHOLDER_DOMAINS/canonicalDomain).
 */

export const EMAIL_TRUST_VALIDATION_VERSION = 1;

export const emailTrustOutcomes = ["VERIFIED", "RISKY", "INVALID", "UNKNOWN"] as const;
export type EmailTrustOutcome = (typeof emailTrustOutcomes)[number];

// Mismo criterio que illinois-backfill-lib.mjs -- domains de ejemplo/
// placeholder que nunca son un email real encontrado.
const PLACEHOLDER_DOMAINS = ["example.com", "example.org", "yourdomain.com", "domain.com", "email.com", "sentry.io", "wixpress.com"];

// Proveedores de email gratuito/personal -- una empresa real PUEDE
// usarlos, pero nunca son evidencia de dominio propio, así que nunca
// pueden llegar a VERIFIED (ver regla explícita del PO).
const FREE_EMAIL_PROVIDERS = [
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "aol.com",
  "icloud.com",
  "live.com",
  "msn.com",
  "protonmail.com",
  "mail.com",
];

const EMAIL_RE = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export interface NormalizedEmail {
  value: string | null;
  valid: boolean;
  reason: "empty" | "invalid_syntax" | "placeholder_domain" | null;
  wasUrlEncoded: boolean;
  domain: string | null;
}

/**
 * Normalización pura: elimina "mailto:", parámetros (?subject=...), URL-
 * decodifica de forma segura (nunca tira si falla), quita espacios y
 * comillas/ángulos envolventes, minúsculas, valida sintaxis, rechaza
 * dominios placeholder conocidos.
 */
export function normalizeEmail(raw: string | null | undefined): NormalizedEmail {
  if (!raw || !raw.trim()) return { value: null, valid: false, reason: "empty", wasUrlEncoded: false, domain: null };

  const withoutMailto = raw.trim().replace(/^mailto:/i, "");
  const withoutParams = withoutMailto.split("?")[0]!;

  let decoded = withoutParams;
  try {
    decoded = decodeURIComponent(withoutParams);
  } catch {
    // decode inválido -- se sigue con el crudo, la validación de sintaxis lo rechaza si corresponde
  }

  const cleaned = decoded
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^["'<]+|["'>]+$/g, "");

  if (!EMAIL_RE.test(cleaned)) {
    return { value: null, valid: false, reason: "invalid_syntax", wasUrlEncoded: decoded !== withoutParams, domain: null };
  }

  const domain = cleaned.split("@")[1] ?? null;
  if (domain && PLACEHOLDER_DOMAINS.includes(domain)) {
    return { value: null, valid: false, reason: "placeholder_domain", wasUrlEncoded: decoded !== withoutParams, domain };
  }

  return { value: cleaned, valid: true, reason: null, wasUrlEncoded: decoded !== withoutParams, domain };
}

/** Dominio canónico de una URL de website (sin "www.", minúsculas) -- mismo criterio que discovery-identity.ts's normalizeDomain, duplicado a propósito (ese vive en un archivo distinto de este módulo, ambos puros). */
export function normalizeWebsiteDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const url = new URL(website.startsWith("http") ? website : `https://${website}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isSubdomainOf(child: string, parent: string): boolean {
  return child !== parent && child.endsWith(`.${parent}`);
}

export const companyContactPointTypes = [
  "INFO",
  "SALES",
  "HR",
  "RECRUITING",
  "CAREERS",
  "SUPPORT",
  "PRESS",
  "BILLING",
  "PROCUREMENT",
  "OTHER",
] as const;
export type CompanyContactPointTypeValue = (typeof companyContactPointTypes)[number];

const LOCAL_PART_TYPE_RULES: Array<{ keywords: string[]; type: CompanyContactPointTypeValue }> = [
  { keywords: ["recruit", "talent"], type: "RECRUITING" },
  { keywords: ["career", "jobs"], type: "CAREERS" },
  { keywords: ["hr", "humanresources", "people"], type: "HR" },
  { keywords: ["sales"], type: "SALES" },
  { keywords: ["support", "help", "helpdesk"], type: "SUPPORT" },
  { keywords: ["press", "media"], type: "PRESS" },
  { keywords: ["billing", "accounting", "invoice"], type: "BILLING" },
  { keywords: ["procurement", "purchasing", "vendor"], type: "PROCUREMENT" },
  { keywords: ["info", "contact", "hello", "general", "office"], type: "INFO" },
];

// Palabras clave de 3 letras o menos ("hr") solo cuentan como match si
// son el TOKEN completo -- de lo contrario "hr" matchearía dentro de
// "chris@acme.com" via substring. Palabras de 4+ letras toleran ser un
// prefijo del token (ej. "recruiting" via "recruit", "helpdesk" via
// "help") -- mismo espíritu que containsWord (text-normalize.ts), pero
// acá por TOKEN (separado por . _ + -) en vez de por límite de palabra
// de texto libre, porque un local-part no tiene espacios reales.
function tokenMatchesKeyword(token: string, keyword: string): boolean {
  if (token === keyword) return true;
  return keyword.length >= 4 && token.startsWith(keyword);
}

/** Clasifica el local-part (antes del @) de un email organizacional ya normalizado -- nunca infiere un nombre de persona, solo el rol declarado en la dirección misma. */
export function classifyContactPointType(normalizedEmail: string): CompanyContactPointTypeValue {
  const localPart = normalizedEmail.split("@")[0] ?? "";
  const tokens = localPart.split(/[._+-]+/).filter(Boolean);
  for (const rule of LOCAL_PART_TYPE_RULES) {
    if (tokens.some((token) => rule.keywords.some((keyword) => tokenMatchesKeyword(token, keyword)))) {
      return rule.type;
    }
  }
  return "OTHER";
}

export interface EmailTrustInput {
  rawEmail: string;
  companyWebsite: string | null;
  // Dominios alternativos con evidencia pública explícita de estar
  // controlados por la misma empresa (ej. un rebrand documentado) --
  // vacío por default. Ningún proveedor conectado en F7.4 los detecta
  // todavía (limitación documentada, no resuelta en esta fase).
  knownAlternateDomains?: string[];
  // Señal opcional de que la fuente es un catch-all sin verificación
  // dedicada (ningún proveedor conectado en F7.4 la detecta todavía) --
  // cuando viene true, nunca deja llegar a VERIFIED aunque el dominio
  // coincida.
  isCatchAll?: boolean;
}

export interface EmailTrustResult {
  normalizedEmail: string | null;
  status: EmailTrustOutcome;
  type: CompanyContactPointTypeValue;
  confidenceScore: number;
  reasons: string[];
  domain: string | null;
  matchedOfficialDomain: boolean;
  isFreeEmailProvider: boolean;
  validationVersion: number;
}

const CONFIDENCE_BY_STATUS: Record<EmailTrustOutcome, number> = {
  VERIFIED: 0.95,
  RISKY: 0.5,
  INVALID: 0,
  UNKNOWN: 0.2,
};

/**
 * Evalúa un email organizacional real contra el dominio oficial de la
 * Company que lo originó. Determinista: mismo input siempre produce el
 * mismo resultado. Nunca infiere una relación de dominio sin evidencia
 * literal (mismo dominio, subdominio real, o alternado EXPLÍCITAMENTE
 * conocido) -- "dominio claramente ajeno" siempre es INVALID, nunca
 * Confirmed, exactamente el bug reportado por el PO
 * (editor@collegefencing360.com contra generalmanufacturing.net).
 */
export function validateEmailTrust(input: EmailTrustInput): EmailTrustResult {
  const normalized = normalizeEmail(input.rawEmail);
  const knownAlternateDomains = (input.knownAlternateDomains ?? []).map((d) => d.toLowerCase());

  if (!normalized.valid) {
    const status: EmailTrustOutcome = normalized.reason === "empty" ? "UNKNOWN" : "INVALID";
    const reasons =
      normalized.reason === "empty"
        ? ["Sin email para evaluar."]
        : normalized.reason === "placeholder_domain"
          ? [`Dominio placeholder/de ejemplo: "${normalized.domain}".`]
          : ["Sintaxis de email inválida."];
    return {
      normalizedEmail: null,
      status,
      type: "OTHER",
      confidenceScore: CONFIDENCE_BY_STATUS[status],
      reasons,
      domain: normalized.domain,
      matchedOfficialDomain: false,
      isFreeEmailProvider: false,
      validationVersion: EMAIL_TRUST_VALIDATION_VERSION,
    };
  }

  const emailDomain = normalized.domain!;
  const companyDomain = normalizeWebsiteDomain(input.companyWebsite);
  const isFree = FREE_EMAIL_PROVIDERS.includes(emailDomain);
  const type = classifyContactPointType(normalized.value!);

  if (isFree) {
    return {
      normalizedEmail: normalized.value,
      status: "RISKY",
      type,
      confidenceScore: CONFIDENCE_BY_STATUS.RISKY,
      reasons: [`Proveedor de email gratuito/personal: "${emailDomain}" -- nunca es evidencia de dominio propio.`],
      domain: emailDomain,
      matchedOfficialDomain: false,
      isFreeEmailProvider: true,
      validationVersion: EMAIL_TRUST_VALIDATION_VERSION,
    };
  }

  if (!companyDomain) {
    return {
      normalizedEmail: normalized.value,
      status: "UNKNOWN",
      type,
      confidenceScore: CONFIDENCE_BY_STATUS.UNKNOWN,
      reasons: ["La empresa no tiene un website conocido -- no se puede comparar el dominio del email."],
      domain: emailDomain,
      matchedOfficialDomain: false,
      isFreeEmailProvider: false,
      validationVersion: EMAIL_TRUST_VALIDATION_VERSION,
    };
  }

  const exactMatch = emailDomain === companyDomain;
  const subdomainMatch = isSubdomainOf(emailDomain, companyDomain) || isSubdomainOf(companyDomain, emailDomain);
  const alternateMatch = knownAlternateDomains.includes(emailDomain);
  const matchedOfficialDomain = exactMatch || subdomainMatch || alternateMatch;

  if (matchedOfficialDomain && !input.isCatchAll) {
    const reason = exactMatch
      ? `El dominio coincide exactamente con el sitio oficial "${companyDomain}".`
      : subdomainMatch
        ? `El dominio es un subdominio real del sitio oficial "${companyDomain}".`
        : `El dominio coincide con un dominio alternativo confirmado explícitamente de esta empresa.`;
    return {
      normalizedEmail: normalized.value,
      status: "VERIFIED",
      type,
      confidenceScore: CONFIDENCE_BY_STATUS.VERIFIED,
      reasons: [reason],
      domain: emailDomain,
      matchedOfficialDomain: true,
      isFreeEmailProvider: false,
      validationVersion: EMAIL_TRUST_VALIDATION_VERSION,
    };
  }

  if (matchedOfficialDomain && input.isCatchAll) {
    return {
      normalizedEmail: normalized.value,
      status: "RISKY",
      type,
      confidenceScore: CONFIDENCE_BY_STATUS.RISKY,
      reasons: ["El dominio coincide, pero la fuente es un catch-all sin verificación dedicada."],
      domain: emailDomain,
      matchedOfficialDomain: true,
      isFreeEmailProvider: false,
      validationVersion: EMAIL_TRUST_VALIDATION_VERSION,
    };
  }

  // Dominio claramente ajeno -- ningún match real con el sitio oficial ni
  // con un alternado explícitamente conocido. Nunca queda VERIFIED/RISKY
  // solo porque el texto "parece" un email de empresa real (exactamente
  // el bug reportado: editor@collegefencing360.com nunca debe quedar
  // Confirmed para generalmanufacturing.net).
  return {
    normalizedEmail: normalized.value,
    status: "INVALID",
    type,
    confidenceScore: CONFIDENCE_BY_STATUS.INVALID,
    reasons: [`Dominio "${emailDomain}" claramente ajeno al sitio oficial "${companyDomain}" -- sin evidencia de relación real.`],
    domain: emailDomain,
    matchedOfficialDomain: false,
    isFreeEmailProvider: false,
    validationVersion: EMAIL_TRUST_VALIDATION_VERSION,
  };
}
