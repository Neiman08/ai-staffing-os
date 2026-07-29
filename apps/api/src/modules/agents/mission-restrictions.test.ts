import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMissionRestrictionsFromText, mergeMissionRestrictions, DEFAULT_MISSION_RESTRICTIONS } from "@ai-staffing-os/agents";
import {
  classifyProviderHttpStatus,
  getProviderHealth,
  markProviderStatus,
  resetProviderHealthForTests,
} from "./tools/provider-health";
import { buildRestrictionNotes } from "./mission-orchestrator";

/**
 * Corrección estructural (misión Iowa, 2026-07-13): la misión real pidió
 * explícitamente "no crear campañas; no crear oportunidades; no enviar
 * correos; no contactar a nadie" y el sistema creó una Campaign de todas
 * formas — mission-orchestrator.ts nunca leía ninguna restricción. Estos
 * tests cubren el detector determinista en aislamiento (sin LLM, sin
 * costo) — la garantía real de que "no crear X" bloquea X sin depender
 * de que un modelo lo recuerde.
 */

test("detectMissionRestrictionsFromText: sin ninguna restricción mencionada, todo permitido por default", () => {
  const r = detectMissionRestrictionsFromText("Busca 25 empresas de manufactura en Iowa.");
  assert.deepEqual(r, DEFAULT_MISSION_RESTRICTIONS);
});

test("detectMissionRestrictionsFromText: 'no crear campañas' bloquea únicamente allowCampaignCreation", () => {
  const r = detectMissionRestrictionsFromText("Busca empresas en Iowa. No crear campañas.");
  assert.equal(r.allowCampaignCreation, false);
  assert.equal(r.allowOpportunityCreation, true);
  assert.equal(r.allowOutreach, true);
  assert.equal(r.allowMessageSending, true);
});

test("detectMissionRestrictionsFromText: 'no crear oportunidades' bloquea únicamente allowOpportunityCreation", () => {
  const r = detectMissionRestrictionsFromText("Encuentra empresas de construcción. No crear oportunidades.");
  assert.equal(r.allowCampaignCreation, true);
  assert.equal(r.allowOpportunityCreation, false);
  assert.equal(r.allowOutreach, true);
});

test("detectMissionRestrictionsFromText: 'no enviar correos'/'no contactar a nadie' bloquea outreach y envío de mensajes", () => {
  const r1 = detectMissionRestrictionsFromText("Busca contactos. No enviar correos.");
  assert.equal(r1.allowOutreach, false);
  assert.equal(r1.allowMessageSending, false);
  assert.equal(r1.allowCampaignCreation, true, "no debe bloquear campañas — no se mencionó");

  const r2 = detectMissionRestrictionsFromText("Busca contactos. No contactar a nadie.");
  assert.equal(r2.allowOutreach, false);
  assert.equal(r2.allowMessageSending, false);
});

test("detectMissionRestrictionsFromText: combinación real de la misión de Iowa — las 3 restricciones a la vez", () => {
  const r = detectMissionRestrictionsFromText(
    "Busca 25 empresas reales en Iowa. No enviar correos; no crear campañas; no crear oportunidades; no contactar a nadie.",
  );
  assert.equal(r.allowCampaignCreation, false);
  assert.equal(r.allowOpportunityCreation, false);
  assert.equal(r.allowOutreach, false);
  assert.equal(r.allowMessageSending, false);
});

test("detectMissionRestrictionsFromText: acentos y mayúsculas no afectan la detección", () => {
  const r = detectMissionRestrictionsFromText("NO CREAR CAMPAÑAS ni oportunidades para esta búsqueda.");
  assert.equal(r.allowCampaignCreation, false);
});

test("mergeMissionRestrictions: el detector determinista puede volver más restrictivo lo que el LLM interpretó, nunca al revés", () => {
  // El LLM "olvida" la restricción (todo true) pero el texto sí la tiene.
  const merged = mergeMissionRestrictions(
    { allowCampaignCreation: true, allowOpportunityCreation: true, allowOutreach: true, allowMessageSending: true },
    "No crear campañas bajo ninguna circunstancia.",
  );
  assert.equal(merged.allowCampaignCreation, false, "el detector determinista debe ganar aunque el LLM diga true");
});

test("mergeMissionRestrictions: si el LLM es más restrictivo que el texto, también gana (AND lógico)", () => {
  const merged = mergeMissionRestrictions(
    { allowCampaignCreation: false, allowOpportunityCreation: true, allowOutreach: true, allowMessageSending: true },
    "Busca empresas de manufactura en Iowa.", // texto no menciona ninguna restricción
  );
  assert.equal(merged.allowCampaignCreation, false, "el LLM también puede restringir, el AND nunca reactiva");
});

test("mergeMissionRestrictions: parseo nulo/parcial del LLM se completa con el default permisivo antes del AND", () => {
  const merged = mergeMissionRestrictions(null, "No enviar mensajes.");
  assert.equal(merged.allowMessageSending, false);
  assert.equal(merged.allowCampaignCreation, true);
});

// F7.2 — bug confirmado: "no crear campañas ni oportunidades" no
// bloqueaba allowOpportunityCreation (el verbo "crear" nunca quedaba
// adyacente a "oportunidad(es)" en esa construcción con conector "ni"/
// "o"). Regresión mínima: exactamente las expresiones confirmadas por
// el PO, nada más.

test("detectMissionRestrictionsFromText: 'no crear campañas ni oportunidades' bloquea AMBOS flags (bug F7.2)", () => {
  const r = detectMissionRestrictionsFromText("Busca hoteles en Illinois. No crear campañas ni oportunidades.");
  assert.equal(r.allowCampaignCreation, false);
  assert.equal(r.allowOpportunityCreation, false);
});

test("detectMissionRestrictionsFromText: 'no crear campañas o oportunidades' bloquea AMBOS flags (bug F7.2)", () => {
  const r = detectMissionRestrictionsFromText("Busca hoteles en Illinois. No crear campañas o oportunidades.");
  assert.equal(r.allowCampaignCreation, false);
  assert.equal(r.allowOpportunityCreation, false);
});

// F28 (corrección real, misiones roofing/landscaping 2026-07-27): "no
// preparar mensajes" ahora bloquea EXCLUSIVAMENTE allowDraftCreation --
// hasta F27 también apagaba allowMessageSending/allowOutreach, que era
// exactamente la causa de que "no enviar" y "no redactar" quedaran
// mezclados. "No preparar mensajes" SÍ es una negación explícita de
// redactar, así que allowDraftCreation debe apagarse -- pero no implica
// nada sobre outreach/envío, que esta instrucción ni menciona.
test("detectMissionRestrictionsFromText: 'no preparar mensajes' bloquea únicamente allowDraftCreation (F28, corrige F7.2)", () => {
  const r = detectMissionRestrictionsFromText("Encuentra contactos. No preparar mensajes.");
  assert.equal(r.allowDraftCreation, false);
  assert.equal(r.allowMessageSending, true, "no preparar borradores no implica prohibir el envío");
  assert.equal(r.allowOutreach, true, "no preparar borradores no implica prohibir la secuencia de outreach");
});

test("detectMissionRestrictionsFromText: 'no crear campañas ni oportunidades' no afecta outreach (aislamiento del fix)", () => {
  const r = detectMissionRestrictionsFromText("Busca hoteles en Illinois. No crear campañas ni oportunidades.");
  assert.equal(r.allowOutreach, true);
  assert.equal(r.allowMessageSending, true);
});

// ---- F28: "no enviar" nunca debe convertirse en "no redactar" --
// frases equivalentes en español e inglés, exactamente el caso real de
// las misiones roofing/landscaping (2026-07-27): "Crea Leads,
// Opportunities y Drafts únicamente. No envíes correos automáticamente."

const NO_AUTO_SEND_EQUIVALENT_PHRASES: Array<{ label: string; instruction: string }> = [
  { label: "ES - no envíes correos automáticamente", instruction: "Crea Leads, Opportunities y Drafts únicamente. No envíes correos automáticamente." },
  { label: "ES - no enviar correos", instruction: "Busca 25 empresas de roofing en Illinois. No enviar correos." },
  { label: "ES - no mandes emails", instruction: "Busca empresas de landscaping. No mandes emails a nadie." },
  { label: "EN - do not send emails automatically", instruction: "Create Leads, Opportunities and Drafts only. Do not send emails automatically." },
  { label: "EN - don't send messages", instruction: "Find roofing companies in Illinois. Don't send messages." },
  { label: "EN - no automatic sending", instruction: "Create Drafts only. No sending emails automatically." },
];

for (const { label, instruction } of NO_AUTO_SEND_EQUIVALENT_PHRASES) {
  test(`detectMissionRestrictionsFromText: [${label}] bloquea el envío pero NUNCA la redacción de Drafts`, () => {
    const r = detectMissionRestrictionsFromText(instruction);
    assert.equal(r.allowMessageSending, false, `${label}: debe bloquear el envío`);
    assert.equal(r.allowDraftCreation, true, `${label}: "no enviar" nunca debe bloquear la creación de Drafts`);
  });
}

test("detectMissionRestrictionsFromText: modelo de capacidades independientes -- draftCreationAllowed=true, emailSendingAllowed=false, sin acoplar uno con el otro", () => {
  const r = detectMissionRestrictionsFromText(
    "Ejecuta Discovery, Company Enrichment, Contact Intelligence y Email Verification. Crea Leads, Opportunities y Drafts únicamente. No envíes correos automáticamente.",
  );
  assert.equal(r.allowDraftCreation, true, "draftCreationAllowed");
  assert.equal(r.allowMessageSending, false, "emailSendingAllowed (negado)");
  assert.equal(r.allowCampaignCreation, true, "la instrucción no prohibió campañas");
  assert.equal(r.allowOpportunityCreation, true, "la instrucción no prohibió oportunidades");
});

test("detectMissionRestrictionsFromText: frases equivalentes ES/EN de 'no redactar' SÍ bloquean allowDraftCreation", () => {
  const es = detectMissionRestrictionsFromText("Busca empresas de roofing. No redactes borradores.");
  assert.equal(es.allowDraftCreation, false);

  const en = detectMissionRestrictionsFromText("Find roofing companies. Do not draft messages.");
  assert.equal(en.allowDraftCreation, false);
});

// ---- provider-health.ts: distingue "sin datos para esta empresa" de
// "la cuenta del proveedor no puede responder nada ahora" ----

test("classifyProviderHttpStatus: 402/401/403/429/5xx se clasifican correctamente, 2xx/4xx normales quedan AVAILABLE", () => {
  assert.equal(classifyProviderHttpStatus(402), "CREDIT_EXHAUSTED");
  assert.equal(classifyProviderHttpStatus(401), "UNAUTHORIZED");
  assert.equal(classifyProviderHttpStatus(403), "UNAUTHORIZED");
  assert.equal(classifyProviderHttpStatus(429), "UNAVAILABLE");
  assert.equal(classifyProviderHttpStatus(503), "UNAVAILABLE");
  assert.equal(classifyProviderHttpStatus(404), "AVAILABLE");
  assert.equal(classifyProviderHttpStatus(400), "AVAILABLE");
});

test("provider-health: marcar un proveedor CREDIT_EXHAUSTED lo mantiene marcado hasta que se resetea o expira", () => {
  resetProviderHealthForTests();
  assert.equal(getProviderHealth("test_provider"), null);
  markProviderStatus("test_provider", "CREDIT_EXHAUSTED", "HTTP 402: account maximum for search");
  const health = getProviderHealth("test_provider");
  assert.ok(health);
  assert.equal(health?.status, "CREDIT_EXHAUSTED");
  markProviderStatus("test_provider", "AVAILABLE", "");
  assert.equal(getProviderHealth("test_provider"), null, "marcar AVAILABLE limpia el estado");
  resetProviderHealthForTests();
});

// ---------- F28 (F): invariante -- nunca reportar un Draft como prohibido cuando allowDraftCreation=true ----------

test("buildRestrictionNotes: allowDraftCreation=true (default) -> ninguna nota dice que no se redactó nada", () => {
  const notes = buildRestrictionNotes(DEFAULT_MISSION_RESTRICTIONS);
  assert.equal(notes.length, 0);
  assert.ok(!notes.some((n) => n.toLowerCase().includes("borrador")));
});

test("buildRestrictionNotes: 'no enviar correos automáticamente' (allowMessageSending=false, allowDraftCreation=true) -> nota de envío, NUNCA nota de borrador prohibido", () => {
  const restrictions = detectMissionRestrictionsFromText("Crea Leads, Opportunities y Drafts únicamente. No envíes correos automáticamente.");
  assert.equal(restrictions.allowDraftCreation, true);
  const notes = buildRestrictionNotes(restrictions);
  assert.ok(!notes.some((n) => n.toLowerCase().includes("no se redactó")), `no debía reportar un borrador prohibido: ${JSON.stringify(notes)}`);
});

test("buildRestrictionNotes: allowDraftCreation=false (negación explícita real) -> SÍ reporta la nota de borrador prohibido", () => {
  const restrictions = detectMissionRestrictionsFromText("Busca empresas de roofing. No redactes borradores.");
  assert.equal(restrictions.allowDraftCreation, false);
  const notes = buildRestrictionNotes(restrictions);
  assert.ok(notes.some((n) => n.toLowerCase().includes("borrador")));
});

// F28 (misión real de Hospitality, 2026-07-28, pedido explícito del PO):
// requireHiringSignal es restrictivo por default (false) y se ACTIVA con
// una frase positiva explícita -- polaridad opuesta a los flags allowX
// de arriba, así que se combina por OR (mergeMissionRestrictions), no
// por AND.

test("detectMissionRestrictionsFromText: sin ninguna mención de contratación, requireHiringSignal queda false (default)", () => {
  const r = detectMissionRestrictionsFromText("Busca hoteles en Illinois.");
  assert.equal(r.requireHiringSignal, false);
});

test("detectMissionRestrictionsFromText: 'que estén contratando' activa requireHiringSignal", () => {
  const r = detectMissionRestrictionsFromText("Busca hoteles en Illinois que estén contratando.");
  assert.equal(r.requireHiringSignal, true);
});

test("detectMissionRestrictionsFromText: 'actively hiring' (inglés) también activa requireHiringSignal", () => {
  const r = detectMissionRestrictionsFromText("Find hotels in Illinois that are actively hiring.");
  assert.equal(r.requireHiringSignal, true);
});

test("detectMissionRestrictionsFromText: 'hiring signals' (término del producto, no un pedido) NUNCA activa requireHiringSignal por sí solo", () => {
  const r = detectMissionRestrictionsFromText("Detecta señales de contratación (hiring signals) reales para cada empresa.");
  assert.equal(r.requireHiringSignal, false);
});

test("mergeMissionRestrictions: requireHiringSignal se combina por OR -- si CUALQUIERA de las dos fuentes lo detecta, se aplica", () => {
  // El LLM lo detecta, el texto determinista no (frase ambigua que el
  // regex no cubre) -- igual debe quedar true.
  const merged = mergeMissionRestrictions({ requireHiringSignal: true }, "Busca hoteles en Illinois.");
  assert.equal(merged.requireHiringSignal, true);
});

test("mergeMissionRestrictions: si ninguna de las dos fuentes lo pide, requireHiringSignal queda false", () => {
  const merged = mergeMissionRestrictions({ requireHiringSignal: false }, "Busca hoteles en Illinois.");
  assert.equal(merged.requireHiringSignal, false);
});

test("mergeMissionRestrictions: el detector determinista solo, sin nada del LLM, también activa requireHiringSignal", () => {
  const merged = mergeMissionRestrictions(null, "Busca hoteles en Illinois que estén contratando.");
  assert.equal(merged.requireHiringSignal, true);
});
