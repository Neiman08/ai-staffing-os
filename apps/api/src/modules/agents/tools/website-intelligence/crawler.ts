import robotsParser from "robots-parser";
import { env } from "../../../../core/env";
import { extractFromPage, findTargetLinks, isCareersPath } from "./extract";
import { emptyWebsiteIntelligenceResult, type WebsiteIntelligenceResult } from "./types";

/**
 * F4.7 §1: crawler mínimo y acotado del propio sitio de una Company —
 * nunca un scraper agresivo. Límites duros (no configurables por la IA,
 * ver docs/F4_7_EMAIL_INTELLIGENCE_PLAN.md §1.2):
 *   - profundidad máxima 2 (home → página enlazada)
 *   - máximo 6 páginas por Company (home + hasta 5 objetivo)
 *   - timeout 10s por request
 *   - máximo 2MB por página
 *   - 1 reintento (no 3 — un sitio de PyME caído probablemente sigue caído)
 *   - robots.txt siempre respetado
 *   - 1 request concurrente por dominio, 500ms mínimo entre requests
 */
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAGES = 6;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MIN_DELAY_BETWEEN_REQUESTS_MS = 500;

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
}

async function fetchPage(
  taskId: string,
  url: string,
  userAgent: string,
  abortSignal: AbortSignal | undefined,
): Promise<FetchOutcome> {
  const hostname = new URL(url).hostname;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (abortSignal?.aborted) return { html: null, error: "cancelled by user", cancelled: true };
    await waitForDomainSlot(hostname);

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal;

    try {
      log(taskId, "page requested", { url, attempt });
      const res = await fetch(url, {
        headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml" },
        signal,
        redirect: "follow",
      });
      log(taskId, "page response", { url, attempt, status: res.status, ok: res.ok });

      if (!res.ok) {
        if (attempt < 2 && res.status >= 500) continue; // 1 reintento solo en error de servidor
        return { html: null, error: `HTTP ${res.status}`, cancelled: false };
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("html")) {
        return { html: null, error: `contenido no-HTML (${contentType || "sin content-type"})`, cancelled: false };
      }
      const html = await readCappedText(res, MAX_PAGE_BYTES);
      return { html, error: null, cancelled: false };
    } catch (err) {
      if (abortSignal?.aborted) return { html: null, error: "cancelled by user", cancelled: true };
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const errorLabel = timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err instanceof Error ? err.message : "unknown fetch error";
      log(taskId, "page response", { url, attempt, error: errorLabel });
      if (attempt < 2) continue;
      return { html: null, error: errorLabel, cancelled: false };
    }
  }
  return { html: null, error: "exhausted retries", cancelled: false };
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

export interface RunWebsiteIntelligenceParams {
  taskId: string;
  website: string;
  abortSignal?: AbortSignal;
}

/**
 * Punto de entrada único de Website Intelligence — visita como máximo
 * MAX_PAGES páginas del dominio de `website` (home + páginas objetivo
 * enlazadas desde la home), respeta robots.txt siempre, y devuelve
 * únicamente datos literales encontrados en el HTML.
 */
export async function runWebsiteIntelligence(params: RunWebsiteIntelligenceParams): Promise<WebsiteIntelligenceResult> {
  const result = emptyWebsiteIntelligenceResult();

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
  result.pagesVisited.push(base.toString());
  const homeExtraction = extractFromPage(homeOutcome.html, base.toString());
  mergeExtraction(result, homeExtraction, base.toString());

  // 2) Páginas objetivo enlazadas desde la home (profundidad 2), tope MAX_PAGES-1
  const targetLinks = findTargetLinks(homeOutcome.html, base.toString()).slice(0, MAX_PAGES - 1);
  for (const link of targetLinks) {
    if (params.abortSignal?.aborted) {
      result.cancelled = true;
      break;
    }
    if (robots && robots.isDisallowed(link, userAgent) === true) {
      log(params.taskId, "page blocked by robots.txt, skipped", { link });
      continue;
    }
    const outcome = await fetchPage(params.taskId, link, userAgent, params.abortSignal);
    if (outcome.cancelled) {
      result.cancelled = true;
      break;
    }
    if (!outcome.html) {
      result.patternsFailed.push(`${link}:${outcome.error ?? "sin contenido"}`);
      continue;
    }
    result.pagesVisited.push(link);
    const extraction = extractFromPage(outcome.html, link);
    mergeExtraction(result, extraction, link);
  }

  log(params.taskId, "run completed", {
    pagesVisited: result.pagesVisited.length,
    genericEmails: result.genericEmails.length,
    namedPeople: result.namedPeople.length,
  });

  return result;
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
  if (extraction.hasContactForm && !result.hasContactForm) {
    result.hasContactForm = true;
    result.contactFormUrl = pageUrl;
  }
  if (isCareersPath(pageUrl) && !result.hasCareersPage) {
    result.hasCareersPage = true;
    result.careersPageUrl = pageUrl;
  }
  if (extraction.visibleText) result.pageTexts.push({ url: pageUrl, text: extraction.visibleText });
}
