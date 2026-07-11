import * as cheerio from "cheerio";
import type { WebsiteGenericEmail, WebsiteGenericPhone, WebsiteNamedPerson } from "./types";

// F4.7 §1.3: nunca se "desofusca" un email agresivamente — solo mailto:
// reales y direcciones literales en texto plano. Un email ofuscado con
// JS/imagen queda NOT_FOUND, no se intenta adivinar.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;

// Filtra placeholders/ejemplos evidentes — no es una lista exhaustiva de
// spam-traps, solo lo obvio para no persistir "you@example.com" como si
// fuera un dato real encontrado.
const PLACEHOLDER_DOMAINS = ["example.com", "example.org", "yourdomain.com", "domain.com", "email.com", "sentry.io", "wixpress.com"];

function isPlausibleEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (PLACEHOLDER_DOMAINS.some((d) => lower.endsWith(`@${d}`))) return false;
  // extensiones de archivo que a veces matchean el patrón de email por error (ej. "logo@2x.png")
  if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(lower)) return false;
  return true;
}

// Cargos que confirman que un bloque de texto es una tarjeta de persona
// real (no una lista de servicios) — mismo espíritu de keyword-matching
// ya usado en mapTitleToDecisionRole (F4.6), acá solo para DETECTAR una
// tarjeta de persona, la clasificación de rol sigue viviendo en F4.6.
const TITLE_KEYWORDS = [
  "manager",
  "director",
  "president",
  "owner",
  "founder",
  "ceo",
  "coo",
  "cfo",
  "vp",
  "vice president",
  "officer",
  "recruiter",
  "human resources",
  "hr ",
  "talent",
  "supervisor",
  "coordinator",
  "lead",
  "superintendent",
  "controller",
];

// "First Last" o "First Middle Last" — Title Case, sin dígitos, 2–4 palabras.
const NAME_RE = /^[A-Z][a-zA-Z'.-]+(?:\s+[A-Z][a-zA-Z'.-]+){1,3}$/;

function looksLikeTitle(text: string): boolean {
  const lower = text.toLowerCase();
  return TITLE_KEYWORDS.some((k) => lower.includes(k)) && text.length < 80;
}

function looksLikeName(text: string): boolean {
  return NAME_RE.test(text.trim()) && text.trim().length < 40;
}

export interface PageExtraction {
  genericEmails: WebsiteGenericEmail[];
  namedPeople: WebsiteNamedPerson[];
  genericPhones: WebsiteGenericPhone[];
  hasContactForm: boolean;
}

/**
 * Extrae emails/teléfonos/tarjetas de persona de UNA página ya
 * descargada. Nunca infiere — un email o teléfono solo cuenta si está
 * literal en el HTML (mailto: o texto plano), una tarjeta de persona
 * solo cuenta si nombre+cargo+mailto: están en el mismo bloque chico.
 */
export function extractFromPage(html: string, pageUrl: string): PageExtraction {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const genericEmailSet = new Map<string, WebsiteGenericEmail>();
  const genericPhoneSet = new Map<string, WebsiteGenericPhone>();
  const namedPeople: WebsiteNamedPerson[] = [];

  // 1) mailto: links — la fuente más confiable de un email real.
  const mailtoEmails = new Set<string>();
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const email = href.replace(/^mailto:/i, "").split("?")[0]?.trim().toLowerCase();
    if (email && EMAIL_RE.test(email) && isPlausibleEmail(email)) {
      mailtoEmails.add(email);
      genericEmailSet.set(email, { email, sourceUrl: pageUrl });

      // Buscar nombre+cargo en el mismo bloque chico (hasta 3 ancestros)
      // — solo entonces se reporta como tarjeta de persona real.
      let container = $(el).parent();
      let found = false;
      for (let i = 0; i < 3 && container.length && !found; i++) {
        const blockText = container.text().replace(/\s+/g, " ").trim();
        if (blockText.length < 400) {
          const lines = container
            .find("*")
            .addBack()
            .contents()
            .filter((_, n) => n.type === "text")
            .map((_, n) => $(n).text().trim())
            .get()
            .filter((t) => t.length > 0);
          const nameLine = lines.find((l) => looksLikeName(l));
          const titleLine = lines.find((l) => looksLikeTitle(l));
          if (nameLine && titleLine) {
            const parts = nameLine.trim().split(/\s+/);
            const firstName = parts[0]!;
            const lastName = parts.slice(1).join(" ");
            namedPeople.push({ firstName, lastName, title: titleLine, email, sourceUrl: pageUrl });
            found = true;
          }
        }
        container = container.parent();
      }
    }
  });

  // 2) Emails en texto plano (regex sobre el body renderizado) — solo si
  // no vinieron ya de un mailto: (evita duplicar la misma dirección).
  const bodyText = $("body").text();
  const plainMatches = bodyText.match(EMAIL_RE) ?? [];
  for (const raw of plainMatches) {
    const email = raw.toLowerCase();
    if (!mailtoEmails.has(email) && isPlausibleEmail(email) && !genericEmailSet.has(email)) {
      genericEmailSet.set(email, { email, sourceUrl: pageUrl });
    }
  }

  // 3) Teléfonos — mismo criterio: texto plano, formato NANP.
  const phoneMatches = bodyText.match(PHONE_RE) ?? [];
  for (const raw of phoneMatches) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10) continue; // descarta falsos positivos cortos
    if (!genericPhoneSet.has(digits)) genericPhoneSet.set(digits, { phone: raw.trim(), sourceUrl: pageUrl });
  }

  // 4) Formulario de contacto — presencia binaria, nunca se interactúa.
  const hasContactForm = $("form").length > 0;

  return {
    genericEmails: Array.from(genericEmailSet.values()),
    namedPeople,
    genericPhones: Array.from(genericPhoneSet.values()),
    hasContactForm,
  };
}

const TARGET_PATH_PATTERNS = [
  "contact",
  "about",
  "team",
  "leadership",
  "careers",
  "career",
  "jobs",
  "staff",
  "people",
];

/**
 * Links de la home que apuntan a páginas objetivo (§1.1) — solo del
 * MISMO dominio, nunca se sigue un link externo.
 */
export function findTargetLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const found = new Map<string, string>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      return;
    }
    if (url.hostname !== base.hostname) return; // nunca un dominio distinto
    const path = url.pathname.toLowerCase();
    if (TARGET_PATH_PATTERNS.some((p) => path.includes(p))) {
      url.hash = "";
      found.set(url.toString(), url.toString());
    }
  });

  return Array.from(found.values());
}

export function isCareersPath(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  return path.includes("career") || path.includes("jobs");
}

export function isContactPath(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  return path.includes("contact");
}
