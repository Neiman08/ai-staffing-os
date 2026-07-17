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
