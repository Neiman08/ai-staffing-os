import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateHiringSignals, type HiringSignalInput } from "./hiring-signals";

function baseInput(overrides: Partial<HiringSignalInput> = {}): HiringSignalInput {
  return {
    companyId: "company-1",
    hasWebsite: true,
    crawlBlocked: false,
    hasCareersPage: false,
    careersPageUrl: null,
    pageTexts: [],
    targetJobTitles: [],
    taxonomyJobTitles: [],
    ...overrides,
  };
}

test("sin website -> BLOCKED", () => {
  const result = evaluateHiringSignals(baseInput({ hasWebsite: false }));
  assert.equal(result.hiringStatus, "BLOCKED");
  assert.equal(result.confidence, 0);
});

test("crawl bloqueado por robots.txt -> BLOCKED", () => {
  const result = evaluateHiringSignals(baseInput({ crawlBlocked: true }));
  assert.equal(result.hiringStatus, "BLOCKED");
});

test("sin texto de página -> UNKNOWN", () => {
  const result = evaluateHiringSignals(baseInput({ pageTexts: [] }));
  assert.equal(result.hiringStatus, "UNKNOWN");
});

test("careers page + target title coincide -> CONFIRMED_HIRING", () => {
  const result = evaluateHiringSignals(
    baseInput({
      hasCareersPage: true,
      careersPageUrl: "https://acme.com/careers",
      pageTexts: [{ url: "https://acme.com/careers", text: "We are looking for a Forklift Operator to join our warehouse team." }],
      targetJobTitles: ["Forklift Operator"],
    }),
  );
  assert.equal(result.hiringStatus, "CONFIRMED_HIRING");
  assert.deepEqual(result.targetTitlesMatched, ["Forklift Operator"]);
  assert.equal(result.openingsFound, 1);
  assert.ok(result.confidence > 0.8);
});

test("careers page + frase generica sin titulo especifico -> LIKELY_HIRING", () => {
  const result = evaluateHiringSignals(
    baseInput({
      hasCareersPage: true,
      careersPageUrl: "https://acme.com/careers",
      pageTexts: [{ url: "https://acme.com/careers", text: "We're hiring! Check out our open positions." }],
      targetJobTitles: ["Plant Manager"],
    }),
  );
  assert.equal(result.hiringStatus, "LIKELY_HIRING");
  assert.deepEqual(result.targetTitlesMatched, []);
});

test("sin careers page, pero titulo mencionado en cualquier pagina -> POSSIBLE_HIRING", () => {
  const result = evaluateHiringSignals(
    baseInput({
      hasCareersPage: false,
      pageTexts: [{ url: "https://acme.com/", text: "Our team includes several Machine Operators working across two shifts." }],
      targetJobTitles: ["Machine Operator"],
    }),
  );
  assert.equal(result.hiringStatus, "POSSIBLE_HIRING");
});

test("sin ninguna evidencia -> NO_SIGNAL", () => {
  const result = evaluateHiringSignals(
    baseInput({
      pageTexts: [{ url: "https://acme.com/", text: "We manufacture high quality industrial parts since 1990." }],
      targetJobTitles: ["Plant Manager"],
    }),
  );
  assert.equal(result.hiringStatus, "NO_SIGNAL");
  assert.equal(result.confidence, 0.1);
});

test("taxonomyJobTitles tambien cuentan como evidencia, no solo targetJobTitles", () => {
  const result = evaluateHiringSignals(
    baseInput({
      hasCareersPage: true,
      pageTexts: [{ url: "https://acme.com/careers", text: "Hiring Production Workers for our facility." }],
      targetJobTitles: [],
      taxonomyJobTitles: ["Production Worker"],
    }),
  );
  assert.equal(result.hiringStatus, "CONFIRMED_HIRING");
  assert.deepEqual(result.targetTitlesMatched, ["Production Worker"]);
});

test("evidencia trae la URL real de la pagina donde se encontro", () => {
  const result = evaluateHiringSignals(
    baseInput({
      hasCareersPage: true,
      pageTexts: [{ url: "https://acme.com/careers", text: "Now hiring Forklift Operators." }],
      targetJobTitles: ["Forklift Operator"],
    }),
  );
  assert.ok(result.sourceUrls.includes("https://acme.com/careers"));
  assert.ok(result.evidence.some((e) => e.includes("https://acme.com/careers")));
});

test("plural regular en ingles se detecta igual (Forklift Operators vs Forklift Operator)", () => {
  const result = evaluateHiringSignals(
    baseInput({
      hasCareersPage: true,
      // F34: careersPageUrl debe coincidir con pageTexts[].url para que
      // el match cuente como evidencia en la página de careers (antes
      // este fixture solo seteaba el booleano hasCareersPage, nunca la
      // URL -- el matching viejo no cruzaba ambos datos, el nuevo sí).
      careersPageUrl: "https://acme.com/careers",
      pageTexts: [{ url: "https://acme.com/careers", text: "We need Forklift Operators immediately." }],
      targetJobTitles: ["Forklift Operator"],
    }),
  );
  assert.deepEqual(result.targetTitlesMatched, ["Forklift Operator"]);
});

test("nunca inventa evidencia -- providersUsed vacio cuando no hay crawl real (BLOCKED/UNKNOWN)", () => {
  const blocked = evaluateHiringSignals(baseInput({ hasWebsite: false }));
  assert.deepEqual(blocked.providersUsed, []);
  const unknown = evaluateHiringSignals(baseInput({ pageTexts: [] }));
  assert.deepEqual(unknown.providersUsed, []);
});

test("determinismo: misma entrada siempre produce el mismo resultado (excepto checkedAt)", () => {
  const input = baseInput({
    hasCareersPage: true,
    pageTexts: [{ url: "https://acme.com/careers", text: "Now hiring Machine Operators." }],
    targetJobTitles: ["Machine Operator"],
  });
  const a = evaluateHiringSignals(input);
  const b = evaluateHiringSignals(input);
  assert.deepEqual({ ...a, checkedAt: null }, { ...b, checkedAt: null });
});

test("signalVersion siempre presente y estable", () => {
  const result = evaluateHiringSignals(baseInput());
  assert.equal(result.signalVersion, 1);
});

test("limitations siempre documenta la ausencia de integracion ATS real", () => {
  const result = evaluateHiringSignals(baseInput({ hasCareersPage: true, pageTexts: [{ url: "x", text: "hiring now" }] }));
  assert.ok(result.limitations.some((l) => l.includes("ATS")));
});

// ============================================================
// F34 (auditoría arquitectónica transversal, hallazgo real: "Apex
// Landscaping Inc"/"A.M. Woodland Outdoor Design" recibieron
// hiringSignalLevel="possible" únicamente porque "Maintenance" aparecía
// en su página de SERVICIOS ("We offer lawn maintenance, tree
// maintenance and snow removal") -- el servicio que la empresa VENDE,
// no una vacante que busca cubrir. Estos tests reproducen el patrón
// real exacto (palabra que es a la vez nombre de servicio y de puesto,
// sin ningún contexto de intención laboral cercano) -- fallan sin el
// fix (targetTitlesMatched=["Maintenance"], hiringStatus=POSSIBLE_HIRING)
// y pasan con él.
// ============================================================

test("regresión real: 'Maintenance' en una página de servicios (sin contexto de contratación) NUNCA cuenta como señal de contratación", () => {
  const result = evaluateHiringSignals(
    baseInput({
      hasCareersPage: false,
      pageTexts: [
        {
          url: "https://apexlandscaping.com/services",
          text: "We offer lawn maintenance, tree maintenance and snow removal for commercial properties across Illinois.",
        },
      ],
      targetJobTitles: ["Maintenance"],
    }),
  );
  assert.equal(result.hiringStatus, "NO_SIGNAL", `"Maintenance" mencionado como servicio vendido nunca debe producir señal de contratación (hiringStatus: ${result.hiringStatus})`);
  assert.deepEqual(result.targetTitlesMatched, []);
  assert.deepEqual(result.serviceMentionsExcluded, ["Maintenance"]);
  assert.ok(
    result.classifiedEvidence.some((e) => e.title === "Maintenance" && e.classification === "SERVICE_MENTION_ONLY"),
    "la evidencia descartada debe quedar visible y clasificada, nunca oculta en silencio",
  );
});

test("el mismo término SÍ cuenta como señal cuando tiene contexto de intención laboral cercano en el mismo texto", () => {
  const result = evaluateHiringSignals(
    baseInput({
      hasCareersPage: false,
      pageTexts: [
        {
          url: "https://apexlandscaping.com/about",
          text: "We are hiring a Maintenance position for our growing crew -- apply today.",
        },
      ],
      targetJobTitles: ["Maintenance"],
    }),
  );
  assert.deepEqual(result.targetTitlesMatched, ["Maintenance"]);
  assert.equal(result.hiringStatus, "POSSIBLE_HIRING");
  assert.ok(result.classifiedEvidence.some((e) => e.title === "Maintenance" && e.classification === "POSSIBLE_HIRING_CONTEXT"));
});

test("el mismo término en la página de careers real SIEMPRE cuenta, incluso sin frase de intención adicional", () => {
  const result = evaluateHiringSignals(
    baseInput({
      hasCareersPage: true,
      careersPageUrl: "https://apexlandscaping.com/careers",
      pageTexts: [{ url: "https://apexlandscaping.com/careers", text: "Maintenance -- Illinois -- full-time." }],
      targetJobTitles: ["Maintenance"],
    }),
  );
  assert.deepEqual(result.targetTitlesMatched, ["Maintenance"]);
  assert.equal(result.hiringStatus, "CONFIRMED_HIRING");
  assert.ok(result.classifiedEvidence.some((e) => e.title === "Maintenance" && e.classification === "CAREERS_PAGE_WITH_OPEN_ROLES"));
});

test("un job posting con marcador de ATS/fecha real se clasifica CONFIRMED_JOB_POSTING incluso fuera de la página de careers", () => {
  const result = evaluateHiringSignals(
    baseInput({
      hasCareersPage: false,
      pageTexts: [
        {
          url: "https://apexlandscaping.com/news",
          text: "Now hiring: Maintenance Technician. Req ID 4821. Apply by August 20.",
        },
      ],
      targetJobTitles: ["Maintenance Technician"],
    }),
  );
  assert.ok(result.classifiedEvidence.some((e) => e.title === "Maintenance Technician" && e.classification === "CONFIRMED_JOB_POSTING"));
});

test("cleaning/installation/repair/service -- mismo patrón que 'Maintenance', ninguno cuenta sin contexto de intención laboral", () => {
  for (const term of ["cleaning", "installation", "repair", "service"]) {
    const result = evaluateHiringSignals(
      baseInput({
        hasCareersPage: false,
        pageTexts: [{ url: "https://acme.com/services", text: `We provide professional ${term} for residential and commercial clients.` }],
        targetJobTitles: [term],
      }),
    );
    assert.equal(result.hiringStatus, "NO_SIGNAL", `"${term}" como servicio no debe generar señal de contratación`);
    assert.deepEqual(result.targetTitlesMatched, [], `"${term}" no debe quedar en targetTitlesMatched`);
  }
});
