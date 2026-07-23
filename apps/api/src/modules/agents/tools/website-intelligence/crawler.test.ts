import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runWebsiteIntelligence } from "./crawler";
import type { HeadlessRendererPort } from "./headless-renderer";

/**
 * F22 (Contact Acquisition Engine) — pruebas del crawler real, cero red
 * real: `globalThis.fetch` se reemplaza por un dispatcher en memoria que
 * responde según un mapa de URL -> respuesta fijado por cada test. Nunca
 * se apunta a un sitio real, ni siquiera en un test que "pasa" por
 * accidente si la red estuviera disponible -- una URL no registrada en
 * el mapa siempre devuelve 404, así que un fetch real filtrado por error
 * fallaría el test en vez de pasar en silencio.
 */

type MockResponse = { status: number; contentType?: string; body: string };
let responses: Map<string, MockResponse>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  responses = new Map();
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const normalized = url.replace(/\/$/, "");
    const match = responses.get(normalized) ?? responses.get(url);
    if (!match) {
      return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return new Response(match.body, { status: match.status, headers: { "content-type": match.contentType ?? "text/html" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mock(url: string, body: string, opts: Partial<MockResponse> = {}) {
  responses.set(url.replace(/\/$/, ""), { status: 200, body, ...opts });
}

function robotsAllowAll(origin: string) {
  mock(`${origin}/robots.txt`, "User-agent: *\nAllow: /");
}

// Relleno realista -- un fixture de test con 2-3 tags cortos queda muy
// por debajo del mínimo de texto visible real de una página (ver
// MIN_MEANINGFUL_TEXT_CHARS en extract.ts), lo que dispararía headless
// por accidente en tests que no lo están probando a propósito. Se agrega
// SIEMPRE salvo en los fixtures de SPA (que construyen su HTML a mano,
// sin este helper, justamente para simular contenido casi vacío real).
const REALISTIC_FILLER =
  "<p>Somos una empresa establecida con más de veinte años de experiencia sirviendo a nuestra comunidad local con dedicación y compromiso hacia la excelencia en cada proyecto que emprendemos. Contamos con un equipo profesional dedicado a brindar el mejor servicio posible a cada uno de nuestros clientes, todos los días del año, sin excepción alguna.</p>";

function homePage(body: string) {
  // Espacio real entre bloques -- HTML real casi siempre trae whitespace/
  // indentación entre tags; sin él, cheerio concatena el texto de <p>
  // adyacentes sin separador, lo que puede pegar un dígito final con la
  // primera letra del siguiente bloque y romper el \b de PHONE_RE (mismo
  // comportamiento que tendría un sitio real así de compacto, pero acá
  // sería un artefacto del fixture, no del crawler).
  return `<html><body>${body}\n${REALISTIC_FILLER}</body></html>`;
}

const NO_HEADLESS: HeadlessRendererPort = {
  render: async () => {
    throw new Error("crawler.test.ts: headless nunca debe invocarse en este test");
  },
};

test("sitio sin website: nunca intenta ninguna request", async () => {
  const result = await runWebsiteIntelligence({ taskId: "t1", website: "" });
  assert.ok(result.patternsFailed.length > 0);
  assert.equal(result.pagesVisited.length, 0);
});

test("sitio bloqueado por robots.txt: no visita ninguna página", async () => {
  const origin = "https://blocked.example.com";
  mock(`${origin}/robots.txt`, "User-agent: *\nDisallow: /");
  const result = await runWebsiteIntelligence({ taskId: "t2", website: origin, headlessRenderer: NO_HEADLESS });
  assert.equal(result.blockedByRobots, true);
  assert.equal(result.pagesVisited.length, 0);
});

test("sitio con mailto: extrae el email real y lo asocia a nombre+cargo si están en el mismo bloque", async () => {
  const origin = "https://mailto.example.com";
  robotsAllowAll(origin);
  mock(
    origin,
    homePage(`<div><p>Jane Doe</p><p>HR Manager</p><a href="mailto:jane@mailto.example.com">Email</a></div>`),
  );
  const result = await runWebsiteIntelligence({ taskId: "t3", website: origin, headlessRenderer: NO_HEADLESS });
  assert.ok(result.genericEmails.some((e) => e.email === "jane@mailto.example.com"));
  assert.ok(result.namedPeople.some((p) => p.firstName === "Jane" && p.lastName === "Doe" && p.email === "jane@mailto.example.com"));
});

test("sitio con formulario de contacto: se registra URL/método/action AUNQUE no haya ningún email", async () => {
  const origin = "https://formonly.example.com";
  robotsAllowAll(origin);
  mock(origin, homePage(`<form method="post" action="/submit-contact"><input name="email"/></form>`));
  const result = await runWebsiteIntelligence({ taskId: "t4", website: origin, headlessRenderer: NO_HEADLESS });
  assert.equal(result.hasContactForm, true);
  assert.equal(result.genericEmails.length, 0);
  assert.equal(result.contactForms.length, 1);
  assert.equal(result.contactForms[0]!.method, "POST");
  assert.equal(result.contactForms[0]!.action, `${origin}/submit-contact`);
});

test("sitio con careers: detecta por path Y por evidencia de contenido, ambas registradas", async () => {
  const origin = "https://careers.example.com";
  robotsAllowAll(origin);
  mock(origin, homePage(`<a href="/careers">Careers</a>`));
  mock(`${origin}/careers`, homePage(`<h1>We are hiring!</h1><p>View openings below.</p>`));
  const result = await runWebsiteIntelligence({ taskId: "t5", website: origin, headlessRenderer: NO_HEADLESS });
  assert.equal(result.hasCareersPage, true);
  assert.equal(result.careersPageUrl, `${origin}/careers`);
  assert.ok(result.careersEvidence.some((e) => e.url === `${origin}/careers`));
});

test("sitio con LinkedIn corporativo: se guarda SOLO si viene de un link real del propio sitio", async () => {
  const origin = "https://linkedin.example.com";
  robotsAllowAll(origin);
  mock(origin, homePage(`<footer><a href="https://www.linkedin.com/company/acme-corp">LinkedIn</a></footer>`));
  const result = await runWebsiteIntelligence({ taskId: "t6", website: origin, headlessRenderer: NO_HEADLESS });
  assert.equal(result.linkedinUrl, "https://www.linkedin.com/company/acme-corp");
  // new URL(origin).toString() normaliza agregando "/" -- mismo criterio
  // que pageUrl en todo el resto del crawler (base.toString()).
  assert.equal(result.linkedinSourceUrl, `${origin}/`);
});

test("sitio con LinkedIn vía JSON-LD sameAs: también cuenta, misma fuente (el propio sitio)", async () => {
  const origin = "https://jsonld.example.com";
  robotsAllowAll(origin);
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    email: "info@jsonld.example.com",
    sameAs: ["https://www.linkedin.com/company/jsonld-corp", "https://twitter.com/jsonldcorp"],
  });
  mock(origin, homePage(`<script type="application/ld+json">${jsonLd}</script>`));
  const result = await runWebsiteIntelligence({ taskId: "t7", website: origin, headlessRenderer: NO_HEADLESS });
  assert.equal(result.linkedinUrl, "https://www.linkedin.com/company/jsonld-corp");
  assert.ok(result.genericEmails.some((e) => e.email === "info@jsonld.example.com"));
  assert.ok(result.structuredDataEmailsFound >= 1);
});

test("sitio solo con teléfono: sin email, sin form, sin careers, sin LinkedIn -- solo teléfono en texto plano", async () => {
  const origin = "https://phoneonly.example.com";
  robotsAllowAll(origin);
  mock(origin, homePage(`<p>Call us at (312) 555-0100</p>`));
  const result = await runWebsiteIntelligence({ taskId: "t8", website: origin, headlessRenderer: NO_HEADLESS });
  assert.equal(result.genericEmails.length, 0);
  assert.equal(result.hasContactForm, false);
  assert.equal(result.hasCareersPage, false);
  assert.equal(result.linkedinUrl, null);
  assert.ok(result.genericPhones.some((p) => p.phone.includes("555-0100")));
});

test("sitio CON sitemap.xml: las páginas relevantes del sitemap se visitan, sin adivinar rutas comunes", async () => {
  const origin = "https://sitemap.example.com";
  robotsAllowAll(origin);
  mock(origin, homePage(`<p>Home sin links</p>`));
  mock(
    `${origin}/sitemap.xml`,
    `<?xml version="1.0"?><urlset><url><loc>${origin}/contact</loc></url><url><loc>${origin}/blog/post-1</loc></url><url><loc>${origin}/about</loc></url></urlset>`,
    { contentType: "application/xml" },
  );
  mock(`${origin}/contact`, homePage(`<a href="mailto:hello@sitemap.example.com">Email</a>`));
  mock(`${origin}/about`, homePage(`<p>About us</p>`));
  const result = await runWebsiteIntelligence({ taskId: "t9", website: origin, headlessRenderer: NO_HEADLESS });
  assert.equal(result.sitemapFound, true);
  assert.ok(result.pagesVisited.includes(`${origin}/contact`));
  assert.ok(result.pagesVisited.includes(`${origin}/about`));
  // /blog/post-1 nunca se visita -- no matchea RELEVANT_PATH_KEYWORDS, "no indexar miles de URLs".
  assert.ok(!result.pagesVisited.includes(`${origin}/blog/post-1`));
  assert.equal(result.pageDiscoveryMethod[`${origin}/contact`], "sitemap");
  assert.ok(result.genericEmails.some((e) => e.email === "hello@sitemap.example.com"));
});

test("sitio SIN sitemap.xml: cae al respaldo de rutas comunes conocidas", async () => {
  const origin = "https://nositemap.example.com";
  robotsAllowAll(origin);
  mock(origin, homePage(`<p>Home sin links a otras páginas</p>`)); // sin sitemap.xml registrado -> 404
  mock(`${origin}/contact`, homePage(`<a href="mailto:hi@nositemap.example.com">Email</a>`));
  const result = await runWebsiteIntelligence({ taskId: "t10", website: origin, headlessRenderer: NO_HEADLESS });
  assert.equal(result.sitemapFound, false);
  assert.ok(result.pagesVisited.includes(`${origin}/contact`));
  assert.equal(result.pageDiscoveryMethod[`${origin}/contact`], "common_path_guess");
  assert.ok(result.genericEmails.some((e) => e.email === "hi@nositemap.example.com"));
});

test("SPA (HTML casi vacío con root de React): dispara headless, usa el HTML renderizado devuelto por el puerto inyectado", async () => {
  const origin = "https://spa.example.com";
  robotsAllowAll(origin);
  mock(origin, `<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);

  let headlessCalled = 0;
  const fakeHeadless: HeadlessRendererPort = {
    render: async (url) => {
      headlessCalled++;
      return { html: homePage(`<a href="mailto:rendered@spa.example.com">Email</a>`), error: null, durationMs: 42 };
    },
  };

  const result = await runWebsiteIntelligence({ taskId: "t11", website: origin, headlessRenderer: fakeHeadless });
  assert.equal(headlessCalled, 1);
  assert.ok(result.headlessPagesRendered.includes(`${origin}/`));
  assert.equal(result.headlessRenderDurationMs, 42);
  assert.ok(result.genericEmails.some((e) => e.email === "rendered@spa.example.com"));
});

test("headless nunca se lanza cuando el HTML plano ya tiene contenido real (regla: nunca 'por si acaso')", async () => {
  const origin = "https://normal.example.com";
  robotsAllowAll(origin);
  mock(
    origin,
    homePage(`<p>${"Somos una empresa real con mucho contenido real en la página, para superar el mínimo de caracteres visibles requerido y así nunca disparar el renderizado headless innecesariamente. ".repeat(3)}</p>`),
  );
  const result = await runWebsiteIntelligence({ taskId: "t12", website: origin, headlessRenderer: NO_HEADLESS });
  assert.equal(result.headlessPagesRendered.length, 0);
});

test("si el renderizado headless falla (paquete no disponible/error real), se degrada al HTML plano sin romper el crawl", async () => {
  const origin = "https://spafail.example.com";
  robotsAllowAll(origin);
  mock(origin, `<html><body><div id="app"></div></body></html>`);
  const failingHeadless: HeadlessRendererPort = {
    render: async () => ({ html: null, error: "Cannot find module 'playwright'", durationMs: 5 }),
  };
  const result = await runWebsiteIntelligence({ taskId: "t13", website: origin, headlessRenderer: failingHeadless });
  assert.equal(result.headlessPagesRendered.length, 0);
  assert.ok(result.patternsFailed.some((p) => p.includes("headless render falló")));
  assert.equal(result.cancelled, false); // el crawl sigue, nunca se aborta por esto
});
