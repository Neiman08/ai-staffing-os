import * as cheerio from "cheerio";
import type { WebsiteCareersEvidence, WebsiteContactFormInfo, WebsiteGenericEmail, WebsiteGenericPhone, WebsiteNamedPerson } from "./types";

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

// F22 Fase 2: frases reales que confirman una página de careers/jobs por
// CONTENIDO, no solo por path -- caso real: una empresa que publica sus
// vacantes en "/opportunities" o en la home misma, sin que el path
// contenga "career"/"jobs". Vocabulario cerrado, nunca inferido por LLM.
const CAREERS_CONTENT_PHRASES = [
  "we are hiring",
  "we're hiring",
  "now hiring",
  "join our team",
  "open positions",
  "current openings",
  "career opportunities",
  "employment opportunities",
  "apply today",
  "view openings",
];

function findCareersEvidencePhrase(visibleText: string): string | null {
  const lower = visibleText.toLowerCase();
  for (const phrase of CAREERS_CONTENT_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

export interface PageExtraction {
  genericEmails: WebsiteGenericEmail[];
  namedPeople: WebsiteNamedPerson[];
  genericPhones: WebsiteGenericPhone[];
  hasContactForm: boolean;
  // F7.5: texto visible de la página, acotado (ver MAX_VISIBLE_TEXT_CHARS)
  // -- aditivo, ningún consumidor existente de PageExtraction lo usaba
  // antes de F7.5. Fuente para Hiring Signal Intelligence (hiring-signals.ts):
  // nunca se re-crawlea el sitio para buscar señales de contratación, se
  // reutiliza el mismo texto ya bajado para emails/teléfonos/tarjetas.
  visibleText: string;
  // F22 Fase 2: TODOS los formularios reales de esta página (nunca solo
  // uno) -- se registran aunque la página no traiga ningún email.
  contactForms: WebsiteContactFormInfo[];
  // F22 Fase 2: evidencia real de careers por contenido (además del path,
  // que se sigue evaluando en crawler.ts vía isCareersPath).
  careersEvidencePhrase: string | null;
  // F22 Fase 2: LinkedIn corporativo real, solo si aparece en ESTA página
  // (link directo o JSON-LD `sameAs`) -- nunca de una búsqueda externa.
  linkedinUrl: string | null;
  // F22 Fase 2: cuántos emails de los de arriba vinieron específicamente
  // de JSON-LD/schema.org -- para observabilidad (Fase 5), no cambia
  // dónde se persisten (siguen siendo genericEmails/namedPeople normales).
  structuredDataEmailsFound: number;
}

/**
 * F22 Fase 2: JSON-LD (`<script type="application/ld+json">`) -- fuente
 * estructurada, machine-readable, que muchos sitios ya incluyen para SEO
 * (schema.org Organization/LocalBusiness/Person/ContactPoint). Nunca se
 * infiere nada que el JSON no traiga literal; un bloque que no parsea
 * como JSON válido simplemente se ignora (nunca rompe el resto del
 * extract). `sameAs` es el campo real donde schema.org espera perfiles
 * sociales (incluido LinkedIn) -- se revisa como fuente adicional de
 * LinkedIn corporativo, siempre del propio sitio.
 */
function extractJsonLd(
  $: cheerio.CheerioAPI,
  pageUrl: string,
): { emails: WebsiteGenericEmail[]; phones: WebsiteGenericPhone[]; linkedinUrl: string | null } {
  const emails: WebsiteGenericEmail[] = [];
  const phones: WebsiteGenericPhone[] = [];
  let linkedinUrl: string | null = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw || !raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // JSON-LD inválido -- se ignora, nunca rompe el resto del crawl
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      collectJsonLdNode(node, pageUrl, emails, phones, (url) => {
        if (!linkedinUrl) linkedinUrl = url;
      });
    }
  });

  return { emails, phones, linkedinUrl };
}

function collectJsonLdNode(
  node: unknown,
  pageUrl: string,
  emails: WebsiteGenericEmail[],
  phones: WebsiteGenericPhone[],
  onLinkedin: (url: string) => void,
  depth = 0,
): void {
  if (!node || typeof node !== "object" || depth > 3) return;
  const obj = node as Record<string, unknown>;

  if (typeof obj.email === "string" && EMAIL_RE.test(obj.email) && isPlausibleEmail(obj.email)) {
    emails.push({ email: obj.email.toLowerCase(), sourceUrl: pageUrl });
  }
  if (typeof obj.telephone === "string") {
    const digits = obj.telephone.replace(/\D/g, "");
    if (digits.length >= 10) phones.push({ phone: obj.telephone, sourceUrl: pageUrl });
  }
  const sameAs = obj.sameAs;
  const sameAsList = Array.isArray(sameAs) ? sameAs : typeof sameAs === "string" ? [sameAs] : [];
  for (const url of sameAsList) {
    if (typeof url === "string" && /linkedin\.com\/(company|school)\//i.test(url)) onLinkedin(url);
  }
  // `contactPoint` puede ser un objeto único o un array -- recorrido
  // recursivo acotado (depth) para no bajar infinito en JSON malformado.
  if (obj.contactPoint) {
    const points = Array.isArray(obj.contactPoint) ? obj.contactPoint : [obj.contactPoint];
    for (const p of points) collectJsonLdNode(p, pageUrl, emails, phones, onLinkedin, depth + 1);
  }
  if (obj["@graph"] && Array.isArray(obj["@graph"])) {
    for (const g of obj["@graph"]) collectJsonLdNode(g, pageUrl, emails, phones, onLinkedin, depth + 1);
  }
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
  // JSON-LD ya se removió arriba junto con el resto de <script> -- se lee
  // ANTES de esa remoción, ver más abajo (se recarga un DOM separado sin
  // eliminar scripts, solo para JSON-LD).
  const $withScripts = cheerio.load(html);

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

  // 2) Emails en texto plano (regex sobre el body renderizado, cubre
  // header/footer al ser el texto completo del <body>) — solo si no
  // vinieron ya de un mailto: (evita duplicar la misma dirección).
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

  // 4) JSON-LD / schema.org -- fuente adicional de emails/teléfonos/LinkedIn,
  // sobre el DOM original (con <script> todavía presentes).
  const jsonLd = extractJsonLd($withScripts, pageUrl);
  let structuredDataEmailsFound = 0;
  for (const e of jsonLd.emails) {
    if (!genericEmailSet.has(e.email)) {
      genericEmailSet.set(e.email, e);
      structuredDataEmailsFound++;
    }
  }
  for (const p of jsonLd.phones) {
    const digits = p.phone.replace(/\D/g, "");
    if (digits.length >= 10 && !genericPhoneSet.has(digits)) genericPhoneSet.set(digits, p);
  }

  // 5) Formularios de contacto -- TODOS, con método/action reales, nunca
  // solo un booleano. Se registran aunque la página no tenga ningún email.
  const contactForms: WebsiteContactFormInfo[] = [];
  const seenForms = new Set<string>();
  $("form").each((_, el) => {
    const method = ($(el).attr("method") ?? "GET").toUpperCase();
    const rawAction = $(el).attr("action");
    let action: string | null = null;
    if (rawAction) {
      try {
        action = new URL(rawAction, pageUrl).toString();
      } catch {
        action = null;
      }
    }
    const key = `${method}::${action ?? pageUrl}`;
    if (seenForms.has(key)) return;
    seenForms.add(key);
    contactForms.push({ url: pageUrl, method, action });
  });

  // 6) LinkedIn corporativo -- link real en la página, o el que ya vino
  // de JSON-LD arriba. Nunca una búsqueda fuera del dominio del sitio.
  let linkedinUrl: string | null = jsonLd.linkedinUrl;
  if (!linkedinUrl) {
    const linkedinHref = $('a[href*="linkedin.com/company/"], a[href*="linkedin.com/school/"]').first().attr("href");
    if (linkedinHref) {
      try {
        linkedinUrl = new URL(linkedinHref, pageUrl).toString();
      } catch {
        linkedinUrl = null;
      }
    }
  }

  return {
    genericEmails: Array.from(genericEmailSet.values()),
    namedPeople,
    genericPhones: Array.from(genericPhoneSet.values()),
    hasContactForm: contactForms.length > 0,
    visibleText: bodyText.replace(/\s+/g, " ").trim().slice(0, MAX_VISIBLE_TEXT_CHARS),
    contactForms,
    careersEvidencePhrase: findCareersEvidencePhrase(bodyText),
    linkedinUrl,
    structuredDataEmailsFound,
  };
}

const MAX_VISIBLE_TEXT_CHARS = 5000;

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

// F22 Fase 2: rutas comunes reales pedidas explícitamente por el PO --
// vocabulario cerrado, se prueban SOLO cuando no hay sitemap.xml
// utilizable (ver crawler.ts). Nunca se agrega una ruta nueva acá sin
// pedido explícito -- mismo criterio de "vocabulario cerrado, nunca
// inventado" que el resto del código de discovery.
export const COMMON_PATH_CANDIDATES = [
  "/contact",
  "/contact-us",
  "/contacto",
  "/about",
  "/about-us",
  "/team",
  "/staff",
  "/careers",
  "/jobs",
  "/employment",
  "/company",
  "/locations",
];

// F22 Fase 3: heurística determinista para decidir si una página necesita
// renderizado headless -- NUNCA se lanza un browser "por si acaso". Todas
// estas señales son sobre el HTML crudo ya descargado (nunca se decide
// antes de intentar el fetch plano primero, que sigue siendo gratis).
const SPA_ROOT_SELECTORS = ["#root", "#app", "#__next", "#___gatsby", "[data-reactroot]"];
const MIN_MEANINGFUL_TEXT_CHARS = 200;

export interface HeadlessNeedAssessment {
  needed: boolean;
  reason: string | null;
}

export function assessHeadlessRenderNeed(html: string): HeadlessNeedAssessment {
  const trimmed = html.trim();
  if (trimmed.length === 0) {
    return { needed: true, reason: "HTML vacío" };
  }
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const visibleText = $("body").text().replace(/\s+/g, " ").trim();

  if (visibleText.length < MIN_MEANINGFUL_TEXT_CHARS) {
    // Root de SPA conocido (React/Next/Gatsby/Vue-generic) con casi nada
    // de texto real -- el contenido real se arma en el cliente, el
    // fetch plano nunca lo va a ver.
    const hasSpaRoot = SPA_ROOT_SELECTORS.some((sel) => $(sel).length > 0);
    if (hasSpaRoot) {
      return { needed: true, reason: `root de SPA detectado (${SPA_ROOT_SELECTORS.find((sel) => $(sel).length > 0)}) con solo ${visibleText.length} caracteres de texto visible` };
    }
    return { needed: true, reason: `contenido principal casi vacío (${visibleText.length} caracteres de texto visible, mínimo esperado ${MIN_MEANINGFUL_TEXT_CHARS})` };
  }

  // <noscript> con contenido real y sustancial es una señal explícita del
  // propio sitio de "sin JS no hay nada" -- caso real de SPAs que sí
  // dejan algo de texto base pero avisan que el resto depende de JS.
  const noscriptWithContent = cheerio.load(html)("noscript").text().trim();
  if (noscriptWithContent.length > 60 && /enable javascript|requires javascript|turn on javascript/i.test(noscriptWithContent)) {
    return { needed: true, reason: "el sitio declara explícitamente en <noscript> que depende de JavaScript" };
  }

  return { needed: false, reason: null };
}
