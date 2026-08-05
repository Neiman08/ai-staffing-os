import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateEmailEligibility } from "./email-eligibility-gate";

test("email limpio, sin historial de bounce -> elegible", () => {
  const r = evaluateEmailEligibility({ email: "hr@acme.com" });
  assert.equal(r.eligible, true);
  assert.equal(r.blockReason, null);
});

test("sin email -> no elegible, INVALID_SYNTAX", () => {
  assert.equal(evaluateEmailEligibility({ email: null }).blockReason, "INVALID_SYNTAX");
  assert.equal(evaluateEmailEligibility({ email: "" }).blockReason, "INVALID_SYNTAX");
});

test("sintaxis inválida -> no elegible, INVALID_SYNTAX", () => {
  const r = evaluateEmailEligibility({ email: "not-an-email" });
  assert.equal(r.eligible, false);
  assert.equal(r.blockReason, "INVALID_SYNTAX");
});

// F34: regresión real -- el email contaminado real encontrado en
// producción (Urban Collective Boutique Hotel, ver bounce-classification.test.ts).
test("regresión real: email contaminado con teléfono -- '226.8686bookings@...' -> nunca elegible", () => {
  const r = evaluateEmailEligibility({ email: "226.8686bookings@urbancollectivehotel.com" });
  assert.equal(r.eligible, false);
  assert.equal(r.blockReason, "PHONE_CONTAMINATED");
});

test("doNotContact=true -> nunca elegible, sin importar el resto del estado", () => {
  const r = evaluateEmailEligibility({ email: "hr@acme.com", doNotContact: true });
  assert.equal(r.eligible, false);
  assert.equal(r.blockReason, "DO_NOT_CONTACT");
});

test("unsubscribedAt presente -> nunca elegible", () => {
  const r = evaluateEmailEligibility({ email: "hr@acme.com", unsubscribedAt: "2026-01-01" });
  assert.equal(r.eligible, false);
  assert.equal(r.blockReason, "UNSUBSCRIBED");
});

// F34: invariante explícita del usuario -- "los hard bounces deben
// marcar el email como inválido permanentemente".
test("regresión: hard bounce confirmado (permanentlyInvalidAt) -> nunca elegible, sin ventana de tiempo, sin importar cuán viejo sea", () => {
  const r = evaluateEmailEligibility({ email: "hr@acme.com", permanentlyInvalidAt: "2020-01-01" });
  assert.equal(r.eligible, false);
  assert.equal(r.blockReason, "PERMANENTLY_INVALID");
});

// F34: invariante explícita -- "los spam blocks deben marcarse como
// DELIVERY_BLOCKED, no como email inválido" -- nunca permanentemente
// inválido, pero sí respeta una ventana real de no reintento inmediato.
test("regresión: spam block reciente (DELIVERY_BLOCKED) -> no elegible dentro de la ventana de 30 días, pero NUNCA marcado PERMANENTLY_INVALID", () => {
  const now = new Date("2026-08-05T00:00:00Z");
  const r = evaluateEmailEligibility({
    email: "hr@acme.com",
    lastBounceClassification: "DELIVERY_BLOCKED",
    lastBounceAt: "2026-07-20T00:00:00Z", // 16 días antes
    now,
  });
  assert.equal(r.eligible, false);
  assert.equal(r.blockReason, "DELIVERY_BLOCKED_NO_RETRY");
});

test("spam block antiguo (fuera de la ventana de 30 días) -> vuelve a ser elegible", () => {
  const now = new Date("2026-08-05T00:00:00Z");
  const r = evaluateEmailEligibility({
    email: "hr@acme.com",
    lastBounceClassification: "DELIVERY_BLOCKED",
    lastBounceAt: "2026-05-01T00:00:00Z", // >30 días antes
    now,
  });
  assert.equal(r.eligible, true);
});

test("RETRYABLE (mailbox full/transitorio) nunca bloquea -- siempre elegible de nuevo, sin ventana de tiempo", () => {
  const r = evaluateEmailEligibility({
    email: "hr@acme.com",
    lastBounceClassification: "RETRYABLE",
    lastBounceAt: new Date().toISOString(),
  });
  assert.equal(r.eligible, true);
});

test("DOMAIN_ISSUE nunca bloquea -- problema del lado del destino, no de la dirección", () => {
  const r = evaluateEmailEligibility({
    email: "hr@acme.com",
    lastBounceClassification: "DOMAIN_ISSUE",
    lastBounceAt: new Date().toISOString(),
  });
  assert.equal(r.eligible, true);
});

test("PHONE_CONTAMINATED se evalúa antes que cualquier estado de bounce -- nunca elegible aunque el historial de bounce esté limpio", () => {
  const r = evaluateEmailEligibility({ email: "7084033300hr@acme.com", lastBounceClassification: null });
  assert.equal(r.eligible, false);
  assert.equal(r.blockReason, "PHONE_CONTAMINATED");
});

test("determinismo: mismo input siempre produce el mismo resultado", () => {
  const input = { email: "hr@acme.com", permanentlyInvalidAt: "2020-01-01" };
  assert.deepEqual(evaluateEmailEligibility(input), evaluateEmailEligibility(input));
});
