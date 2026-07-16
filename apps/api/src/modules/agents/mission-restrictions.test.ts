import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMissionRestrictionsFromText, mergeMissionRestrictions, DEFAULT_MISSION_RESTRICTIONS } from "@ai-staffing-os/agents";
import {
  classifyProviderHttpStatus,
  getProviderHealth,
  markProviderStatus,
  resetProviderHealthForTests,
} from "./tools/provider-health";

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

test("detectMissionRestrictionsFromText: 'no preparar mensajes' bloquea allowMessageSending/allowOutreach (bug F7.2)", () => {
  const r = detectMissionRestrictionsFromText("Encuentra contactos. No preparar mensajes.");
  assert.equal(r.allowMessageSending, false);
  assert.equal(r.allowOutreach, false);
});

test("detectMissionRestrictionsFromText: 'no crear campañas ni oportunidades' no afecta outreach (aislamiento del fix)", () => {
  const r = detectMissionRestrictionsFromText("Busca hoteles en Illinois. No crear campañas ni oportunidades.");
  assert.equal(r.allowOutreach, true);
  assert.equal(r.allowMessageSending, true);
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
