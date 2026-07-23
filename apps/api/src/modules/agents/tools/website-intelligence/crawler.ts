import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { env } from "../../../../core/env";
import { extractFromPage, findTargetLinks, isCareersPath, assessHeadlessRenderNeed, COMMON_PATH_CANDIDATES } from "./extract";
import { emptyWebsiteIntelligenceResult, type WebsiteIntelligenceResult, type PageDiscoveryMethod } from "./types";
import { REAL_HEADLESS_RENDERER, type HeadlessRendererPort } from "./headless-renderer";

/**
 * F4.7 §1 / F22 (Contact Acquisition Engine): crawler mínimo y acotado
 * del propio sitio de una Company — nunca un scraper agresivo. Límites
 * duros (no configurables por la IA, ver docs/F4_7_EMAIL_INTELLIGENCE_PLAN.md
 * §1.2 y docs/F22_CONTACT_ACQUISITION_ANALYSIS.md):
 *   - profundidad máxima 2 (home → página objetivo)
 *   - máximo 6 páginas EXITOSAS por Company (home + hasta 5)
 *   - hasta 10 intentos totales de páginas candidatas (éxito o no) para
 *     acotar el peor caso de latencia cuando se prueban rutas comunes
 *   - timeout 10s por request (15s para renderizado headless)
 *   - máximo 2MB por página
 *   - 1 reintento (no 3 — un sitio de PyME caído probablemente sigue caído)
 *   - robots.txt siempre respetado, también para el sitemap
 *   - 1 request concurrente por dominio, 500ms mínimo entre requests
 *   - máximo 2 páginas por Company con renderizado headless (Fase 3)
 */
const REQUEST_TIMEOUT_MS = 10_000;
const HEADLESS_TIMEOUT_MS = 15_000;
const MAX_PAGES = 6;
const MAX_CANDIDATE_ATTEMPTS = 10;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MIN_DELAY_BETWEEN_REQUESTS_MS = 500;
const MAX_HEADLESS_PAGES = 2;
// F22 Fase 2: nunca se procesa un sitemap gigante -- "no indexar miles de
// URLs". Se leen como máximo estas <loc> crudas ANTES de filtrar a
// páginas realmente útiles.
const MAX_SITEMAP_ENTRIES_READ = 500;

// F22 Fase 2: mismo vocabulario que TARGET_PATH_PATTERNS (extract.ts) —
// usado para filtrar qué URLs de un sitemap real son "útiles" (nunca se
// analizan las miles de URLs de blog/producto que un sitemap real suele
// traer).
const RELEVANT_PATH_KEYWORDS = ["contact", "about", "team", "leadership", "careers", "career", "jobs", "staff", "people", "company", "location"];

function isRelevantSitemapPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return RELEVANT_PATH_KEYWORDS.some((k) => lower.includes(k));
}

// F4.7 §1.2: identificable, con contacto configurable — nunca hardcodea
// una marca todavía no decidida (ver instrucción explícita del usuario).
// Sin WEBSITE_INTELLIGENCE_CONTACT_EMAIL configurado, se omite la
// cláusula de contacto en vez de inventar una.
function buildUserAgent(): string {
  const contact = env.WEBSITE_INTELLIGENCE_CONTACT_EMAIL;
  return contact
    ? `AIStaffingOS-WebsiteIntelligence/1.0 (+contacto: ${contact})`
    : "AIStaffingOS-WebsiteIntelligence/1.0";
}

function log(taskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[website-intelligence] ${event}`, JSON.stringify({ taskId, ...data }));
}

// Rate limit por dominio, en memoria del proceso — evita que dos
// corridas concurrentes (dos misiones a la vez) golpeen el mismo
// dominio sin pausa entre requests.
const lastRequestAtByHost = new Map<string, number>();

async function waitForDomainSlot(hostname: string): Promise<void> {
  const last = lastRequestAtByHost.get(hostname);
  const now = Date.now();
  if (last !== undefined) {
    const elapsed = now - last;
    if (elapsed < MIN_DELAY_BETWEEN_REQUESTS_MS) {
      await new Promise((r) => setTimeout(r, MIN_DELAY_BETWEEN_REQUESTS_MS - elapsed));
    }
  }
  lastRequestAtByHost.set(hostname, Date.now());
}

async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buf.toString("utf-8");
}

interface FetchOutcome {
  html: string | null;
  error: string | null;
  cancelled: boolean;
  status: number | null;
}

async function fetchPage(
  taskId: string,
  url: string,
  userAgent: string,
  abortSignal: AbortSignal | undefined,
  acceptHeader = "text/html,application/xhtml+xml",
): Promise<FetchOutcome> {
  const hostname = new URL(url).hostname;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (abortSignal?.aborted) return { html: null, error: "cancelled by user", cancelled: true, status: null };
    await waitForDomainSlot(hostname);

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal;

    try {
      log(taskId, "page requested", { url, attempt });
      const res = await fetch(url, {
        headers: { "user-agent": userAgent, accept: acceptHeader },
        signal,
        redirect: "follow",
      });
      log(taskId, "page response", { url, attempt, status: res.status, ok: res.ok });

      if (!res.ok) {
        if (attempt < 2 && res.status >= 500) continue; // 1 reintento solo en error de servidor
        return { html: null, error: `HTTP ${res.status}`, cancelled: false, status: res.status };
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("html") && !contentType.includes("xml")) {
        return { html: null, error: `contenido no-HTML (${contentType || "sin content-type"})`, cancelled: false, status: res.status };
      }
      const html = await readCappedText(res, MAX_PAGE_BYTES);
      return { html, error: null, cancelled: false, status: res.status };
    } catch (err) {
      if (abortSignal?.aborted) return { html: null, error: "cancelled by user", cancelled: true, status: null };
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const errorLabel = timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err instanceof Error ? err.message : "unknown fetch error";
      log(taskId, "page response", { url, attempt, error: errorLabel });
      if (attempt < 2) continue;
      return { html: null, error: errorLabel, cancelled: false, status: null };
    }
  }
  return { html: null, error: "exhausted retries", cancelled: false, status: null };
}

async function loadRobots(taskId: string, origin: string, userAgent: string): Promise<ReturnType<typeof robotsParser> | null> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetch(robotsUrl, { headers: { "user-agent": userAgent }, signal: timeoutSignal });
    if (!res.ok) {
      log(taskId, "robots.txt not found, assuming allowed", { robotsUrl, status: res.status });
      return null;
    }
    const body = await res.text();
    return robotsParser(robotsUrl, body);
  } catch (err) {
    log(taskId, "robots.txt fetch failed, assuming allowed", { robotsUrl, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

interface SitemapResult {
  found: boolean;
  sitemapUrl: string | null;
  relevantUrls: string[];
}

/**
 * F22 Fase 2, regla 1: si existe /sitemap.xml, usarlo para descubrir
 * páginas relevantes -- "no indexar miles de URLs, limitar el análisis a
 * páginas útiles". Se leen como máximo MAX_SITEMAP_ENTRIES_READ <loc>
 * crudas, filtradas de inmediato a las que matchean RELEVANT_PATH_KEYWORDS
 * y son del mismo dominio -- nunca se procesa el sitemap completo de un
 * sitio grande. Soporta un nivel de sitemap-index (<sitemapindex>) --
 * toma el PRIMER sub-sitemap listado, nunca todos (acotar el costo real).
 */
async function fetchSitemap(taskId: string, base: URL, userAgent: string, robots: ReturnType<typeof robotsParser> | null): Promise<SitemapResult> {
  const sitemapUrl = `${base.origin}/sitemap.xml`;
  if (robots && robots.isDisallowed(sitemapUrl, userAgent) === true) {
    return { found: false, sitemapUrl: null, relevantUrls: [] };
  }

  const outcome = await fetchPage(taskId, sitemapUrl, userAgent, undefined, "application/xml,text/xml,text/html");
  if (!outcome.html) return { found: false, sitemapUrl: null, relevantUrls: [] };

  const locs = parseSitemapLocs(outcome.html);
  if (locs.length === 0) return { found: false, sitemapUrl: null, relevantUrls: [] };

  const isIndex = /<sitemapindex/i.test(outcome.html);
  let candidateLocs = locs;

  if (isIndex) {
    // Sitemap-index real -- se toma SOLO el primer sub-sitemap listado
    // (nunca todos, para acotar el costo de requests reales).
    const firstSubSitemap = locs[0];
    if (!firstSubSitemap) return { found: true, sitemapUrl, relevantUrls: [] };
    const subOutcome = await fetchPage(taskId, firstSubSitemap, userAgent, undefined, "application/xml,text/xml,text/html");
    candidateLocs = subOutcome.html ? parseSitemapLocs(subOutcome.html) : [];
  }

  const capped = candidateLocs.slice(0, MAX_SITEMAP_ENTRIES_READ);
  const relevant: string[] = [];
  const seen = new Set<string>();
  for (const raw of capped) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.hostname !== base.hostname) continue; // nunca un dominio distinto
    if (!isRelevantSitemapPath(url.pathname)) continue;
    url.hash = "";
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    relevant.push(key);
  }

  log(taskId, "sitemap parsed", { sitemapUrl, rawEntriesRead: capped.length, isIndex, relevantFound: relevant.length });
  return { found: true, sitemapUrl, relevantUrls: relevant };
}

function parseSitemapLocs(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const locs: string[] = [];
  $("loc").each((_, el) => {
    const text = $(el).text().trim();
    if (text) locs.push(text);
  });
  return locs;
}

export interface RunWebsiteIntelligenceParams {
  taskId: string;
  website: string;
  abortSignal?: AbortSignal;
  // F22 Fase 3: inyección para tests -- nunca se llama a Playwright real
  // en un test unitario/integración. Default: el módulo real
  // (headless-renderer.ts).
  headlessRenderer?: HeadlessRendererPort;
}

interface Candidate {
  url: string;
  method: PageDiscoveryMethod;
}

function dedupeCandidates(lists: Candidate[][], exclude: string): Candidate[] {
  const seen = new Set<string>([exclude]);
  const out: Candidate[] = [];
  for (const list of lists) {
    for (const c of list) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
  }
  return out;
}

/**
 * Punto de entrada único de Website Intelligence — visita como máximo
 * MAX_PAGES páginas EXITOSAS del dominio de `website` (home + objetivo),
 * respeta robots.txt siempre, y devuelve únicamente datos literales
 * encontrados en el HTML (o en el HTML renderizado por headless cuando
 * aplica, Fase 3 — sigue siendo el HTML real del sitio, nunca inventado).
 *
 * F22 Fase 2, reglas 1/2: prioridad real de descubrimiento de páginas —
 * si /sitemap.xml existe y aporta URLs relevantes, se usa esa lista
 * (más los links reales de la home, que siguen siendo gratis). Si NO hay
 * sitemap útil, se agregan como respaldo las rutas comunes conocidas
 * (COMMON_PATH_CANDIDATES) — se intentan, nunca se asume que existen.
 */
export async function runWebsiteIntelligence(params: RunWebsiteIntelligenceParams): Promise<WebsiteIntelligenceResult> {
  const result = emptyWebsiteIntelligenceResult();
  const headlessRenderer = params.headlessRenderer ?? REAL_HEADLESS_RENDERER;

  let base: URL;
  try {
    base = new URL(params.website.startsWith("http") ? params.website : `https://${params.website}`);
  } catch {
    result.patternsFailed.push(`website inválida: ${params.website}`);
    return result;
  }

  const userAgent = buildUserAgent();
  const robots = await loadRobots(params.taskId, base.origin, userAgent);

  if (robots && robots.isDisallowed(base.toString(), userAgent) === true) {
    log(params.taskId, "blocked by robots.txt", { website: base.toString() });
    result.blockedByRobots = true;
    result.patternsFailed.push("robots.txt bloquea el acceso a este sitio");
    return result;
  }

  // 1) Home
  const homeOutcome = await fetchPage(params.taskId, base.toString(), userAgent, params.abortSignal);
  if (homeOutcome.cancelled) {
    result.cancelled = true;
    return result;
  }
  if (!homeOutcome.html) {
    result.patternsFailed.push(`home:${homeOutcome.error ?? "sin contenido"}`);
    return result;
  }

  let headlessBudget = MAX_HEADLESS_PAGES;
  const homeHtml = await maybeRenderHeadless(params.taskId, base.toString(), homeOutcome.html, userAgent, headlessRenderer, result, () => headlessBudget-- > 0);

  result.pagesVisited.push(base.toString());
  result.pageDiscoveryMethod[base.toString()] = "home";
  const homeExtraction = extractFromPage(homeHtml, base.toString());
  mergeExtraction(result, homeExtraction, base.toString());

  // 2) Sitemap (regla 1) + links de la home (comportamiento previo, gratis)
  const sitemapResult = await fetchSitemap(params.taskId, base, userAgent, robots);
  result.sitemapFound = sitemapResult.found;
  result.sitemapUrl = sitemapResult.sitemapUrl;

  const homeLinkCandidates: Candidate[] = findTargetLinks(homeHtml, base.toString()).map((url) => ({ url, method: "home_link" }));

  let candidates: Candidate[];
  if (sitemapResult.relevantUrls.length > 0) {
    const sitemapCandidates: Candidate[] = sitemapResult.relevantUrls.map((url) => ({ url, method: "sitemap" }));
    candidates = dedupeCandidates([sitemapCandidates, homeLinkCandidates], base.toString());
  } else {
    // Regla 2: sin sitemap útil -- respaldo de rutas comunes conocidas.
    const commonPathCandidates: Candidate[] = COMMON_PATH_CANDIDATES.map((path) => ({ url: new URL(path, base).toString(), method: "common_path_guess" }));
    candidates = dedupeCandidates([homeLinkCandidates, commonPathCandidates], base.toString());
  }

  // 3) Visitar candidatas en orden de prioridad hasta agotar el
  // presupuesto de páginas EXITOSAS (MAX_PAGES-1) o de intentos totales
  // (MAX_CANDIDATE_ATTEMPTS) -- lo que se cumpla primero. Un 404/error de
  // una ruta común "adivinada" cuenta como intento, nunca como página
  // exitosa -- así una PyME sin /careers no le come el presupuesto real
  // a /contact.
  let successfulExtra = 0;
  let attempts = 0;
  for (const candidate of candidates) {
    if (successfulExtra >= MAX_PAGES - 1) break;
    if (attempts >= MAX_CANDIDATE_ATTEMPTS) break;
    if (params.abortSignal?.aborted) {
      result.cancelled = true;
      break;
    }
    if (robots && robots.isDisallowed(candidate.url, userAgent) === true) {
      log(params.taskId, "page blocked by robots.txt, skipped", { link: candidate.url });
      continue;
    }
    attempts++;
    const outcome = await fetchPage(params.taskId, candidate.url, userAgent, params.abortSignal);
    if (outcome.cancelled) {
      result.cancelled = true;
      break;
    }
    if (!outcome.html) {
      // Un 404 real en una ruta ADIVINADA es información honesta, nunca
      // un error a reportar como falla del crawler.
      if (candidate.method !== "common_path_guess" || (outcome.status && outcome.status !== 404)) {
        result.patternsFailed.push(`${candidate.url}:${outcome.error ?? "sin contenido"}`);
      }
      continue;
    }
    const html = await maybeRenderHeadless(params.taskId, candidate.url, outcome.html, userAgent, headlessRenderer, result, () => headlessBudget-- > 0);
    result.pagesVisited.push(candidate.url);
    result.pageDiscoveryMethod[candidate.url] = candidate.method;
    successfulExtra++;
    const extraction = extractFromPage(html, candidate.url);
    mergeExtraction(result, extraction, candidate.url);
  }

  log(params.taskId, "run completed", {
    pagesVisited: result.pagesVisited.length,
    genericEmails: result.genericEmails.length,
    namedPeople: result.namedPeople.length,
    sitemapFound: result.sitemapFound,
    contactForms: result.contactForms.length,
    careersEvidence: result.careersEvidence.length,
    linkedinUrl: result.linkedinUrl,
    headlessPagesRendered: result.headlessPagesRendered.length,
  });

  return result;
}

/**
 * F22 Fase 3: evalúa (determinista, sobre el HTML plano ya bajado) si la
 * página necesita renderizado headless, y lo intenta SOLO en ese caso —
 * "no lanzar el navegador siempre". Si el render falla o el paquete no
 * está disponible (ver headless-renderer.ts), se sigue con el HTML plano
 * original -- nunca se aborta el crawl por esto.
 */
async function maybeRenderHeadless(
  taskId: string,
  url: string,
  plainHtml: string,
  userAgent: string,
  renderer: HeadlessRendererPort,
  result: WebsiteIntelligenceResult,
  claimBudget: () => boolean,
): Promise<string> {
  const assessment = assessHeadlessRenderNeed(plainHtml);
  if (!assessment.needed) return plainHtml;
  if (!claimBudget()) {
    log(taskId, "headless render skipped, budget exhausted", { url, reason: assessment.reason });
    return plainHtml;
  }

  log(taskId, "headless render needed", { url, reason: assessment.reason });
  const rendered = await renderer.render(url, userAgent, HEADLESS_TIMEOUT_MS);
  result.headlessRenderDurationMs += rendered.durationMs;
  if (!rendered.html) {
    log(taskId, "headless render failed, falling back to plain HTML", { url, error: rendered.error, durationMs: rendered.durationMs });
    result.patternsFailed.push(`${url}:headless render falló (${rendered.error ?? "sin detalle"}) -- se usó el HTML plano`);
    return plainHtml;
  }
  result.headlessPagesRendered.push(url);
  log(taskId, "headless render succeeded", { url, durationMs: rendered.durationMs });
  return rendered.html;
}

function mergeExtraction(
  result: WebsiteIntelligenceResult,
  extraction: ReturnType<typeof extractFromPage>,
  pageUrl: string,
): void {
  for (const e of extraction.genericEmails) {
    if (!result.genericEmails.some((existing) => existing.email === e.email)) result.genericEmails.push(e);
  }
  for (const p of extraction.namedPeople) {
    if (
      !result.namedPeople.some(
        (existing) => existing.firstName === p.firstName && existing.lastName === p.lastName && existing.email === p.email,
      )
    ) {
      result.namedPeople.push(p);
    }
  }
  for (const ph of extraction.genericPhones) {
    if (!result.genericPhones.some((existing) => existing.phone === ph.phone)) result.genericPhones.push(ph);
  }
  // F22 Fase 4: "nunca eliminar canales inferiores" -- TODOS los
  // formularios encontrados se acumulan, no solo el primero.
  for (const form of extraction.contactForms) {
    if (!result.contactForms.some((existing) => existing.action === form.action && existing.method === form.method)) {
      result.contactForms.push(form);
    }
  }
  if (extraction.hasContactForm && !result.hasContactForm) {
    result.hasContactForm = true;
    result.contactFormUrl = extraction.contactForms[0]?.action ?? pageUrl;
  }
  const isCareersByPath = isCareersPath(pageUrl);
  if ((isCareersByPath || extraction.careersEvidencePhrase) && !result.careersEvidence.some((e) => e.url === pageUrl)) {
    result.careersEvidence.push({
      url: pageUrl,
      evidence: isCareersByPath ? "la URL coincide con un path de careers/jobs" : `contenido menciona "${extraction.careersEvidencePhrase}"`,
      hasContactForm: extraction.hasContactForm,
    });
  }
  if (isCareersByPath && !result.hasCareersPage) {
    result.hasCareersPage = true;
    result.careersPageUrl = pageUrl;
  }
  if (extraction.linkedinUrl && !result.linkedinUrl) {
    result.linkedinUrl = extraction.linkedinUrl;
    result.linkedinSourceUrl = pageUrl;
  }
  result.structuredDataEmailsFound += extraction.structuredDataEmailsFound;
  if (extraction.visibleText) result.pageTexts.push({ url: pageUrl, text: extraction.visibleText });
}
