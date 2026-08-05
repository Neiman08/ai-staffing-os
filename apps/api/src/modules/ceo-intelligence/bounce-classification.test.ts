import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBounceEvidence } from "./bounce-classification";

// ============================================================
// F34 (auditoría arquitectónica transversal, hallazgo real: 6 de 82
// envíos reales rebotaron -- ninguno se clasificó, todos guardados bajo
// un único BOUNCED genérico, y ninguno marcó el Contact como inválido
// permanentemente). Estos tests usan el texto REAL de los 6 NDRs
// encontrados en la auditoría (ver ceo-agent-audit.md, Sección 10).
// ============================================================

test("regresión real 1/6: A.M. Woodland Outdoor Design -- 'Hop count exceeded – possible mail loop' -> DOMAIN_ISSUE, reintentable, NUNCA inválido permanente", () => {
  const r = classifyBounceEvidence({ ndrDetail: "Diagnostic information for administrators: Hop count exceeded – possible mail loop" });
  assert.equal(r.classification, "DOMAIN_ISSUE");
  assert.equal(r.isPermanentlyInvalid, false);
  assert.equal(r.allowsFutureRetry, true);
});

test("regresión real 2/6: Planned Packaging of Illinois -- 'info wasn't found... Unknown To address' -> HARD_BOUNCE, inválido permanente", () => {
  const r = classifyBounceEvidence({ ndrDetail: "Your message wasn't delivered because the recipient's email address was not found. info wasn't found at plannedpackaging.com. Unknown To address" });
  assert.equal(r.classification, "HARD_BOUNCE");
  assert.equal(r.isPermanentlyInvalid, true);
  assert.equal(r.allowsFutureRetry, false);
});

test("regresión real 3/6 y 5/6: Creative Packaging Company y TCCI Manufacturing -- 'suspects your message is spam' -> DELIVERY_BLOCKED, NUNCA marcado como email inválido", () => {
  for (const ndr of [
    "Your message couldn't be delivered because the recipient's email server suspects your message is spam.",
    "550 5.7.1 The recipient's server suspects your message is spam and has rejected it.",
  ]) {
    const r = classifyBounceEvidence({ ndrDetail: ndr });
    assert.equal(r.classification, "DELIVERY_BLOCKED");
    assert.equal(r.isPermanentlyInvalid, false, "un spam block nunca debe marcar el email como inválido -- el problema es de reputación/contenido, no de la dirección");
    assert.equal(r.allowsFutureRetry, true);
  }
});

test("regresión real 4/6: Breakthru Beverage Distribution -- '550 5.4.1 Recipient address rejected' -> HARD_BOUNCE, inválido permanente", () => {
  const r = classifyBounceEvidence({ ndrDetail: "550 5.4.1 Recipient address rejected: Access denied." });
  assert.equal(r.classification, "HARD_BOUNCE");
  assert.equal(r.isPermanentlyInvalid, true);
});

test("regresión real 6/6: Urban Collective Boutique Hotel -- '226.8686bookings wasn't found' (email contaminado con teléfono, además de hard bounce real) -> HARD_BOUNCE", () => {
  const r = classifyBounceEvidence({ ndrDetail: "Your message wasn't delivered. 226.8686bookings wasn't found at urbancollectivehotel.com." });
  assert.equal(r.classification, "HARD_BOUNCE");
  assert.equal(r.isPermanentlyInvalid, true);
});

// ---------- códigos SMTP explícitos pedidos por el usuario ----------

test("5.1.1 user unknown -> HARD_BOUNCE, inválido permanente", () => {
  const r = classifyBounceEvidence({ ndrDetail: "550 5.1.1 User unknown" });
  assert.equal(r.classification, "HARD_BOUNCE");
  assert.equal(r.isPermanentlyInvalid, true);
});

test("5.4.1 recipient rejected SIN evidencia de política -> HARD_BOUNCE (permanente por defecto)", () => {
  const r = classifyBounceEvidence({ ndrDetail: "550 5.4.1 Recipient address rejected" });
  assert.equal(r.classification, "HARD_BOUNCE");
});

test("5.4.1 recipient rejected CON evidencia de política/spam en el mismo NDR -> DELIVERY_BLOCKED (la política prevalece)", () => {
  const r = classifyBounceEvidence({ ndrDetail: "550 5.4.1 Recipient address rejected: this message was blocked by our spam policy" });
  assert.equal(r.classification, "DELIVERY_BLOCKED");
  assert.equal(r.isPermanentlyInvalid, false);
});

test("5.7.x spam/policy -> DELIVERY_BLOCKED, nunca HARD_BOUNCE aunque sea clase 5", () => {
  const r = classifyBounceEvidence({ ndrDetail: "550 5.7.1 Message rejected due to policy restrictions" });
  assert.equal(r.classification, "DELIVERY_BLOCKED");
});

test("mailbox full -> RETRYABLE", () => {
  const r = classifyBounceEvidence({ ndrDetail: "452 4.2.2 Mailbox full, quota exceeded" });
  assert.equal(r.classification, "RETRYABLE");
  assert.equal(r.isPermanentlyInvalid, false);
  assert.equal(r.allowsFutureRetry, true);
});

test("transient 4xx genérico -> RETRYABLE", () => {
  const r = classifyBounceEvidence({ ndrDetail: "421 4.3.2 Service temporarily unavailable, try again later" });
  assert.equal(r.classification, "RETRYABLE");
});

test("loop/domain routing -> DOMAIN_ISSUE", () => {
  const r = classifyBounceEvidence({ ndrDetail: "554 Too many hops, possible mail loop detected" });
  assert.equal(r.classification, "DOMAIN_ISSUE");
});

test("sin ninguna evidencia real -> UNKNOWN, nunca inventa una categoría, pero no permite reintento sin evidencia", () => {
  const r = classifyBounceEvidence({ ndrDetail: null });
  assert.equal(r.classification, "UNKNOWN");
  assert.equal(r.isPermanentlyInvalid, false);
  assert.equal(r.allowsFutureRetry, false);
});

test("solo código HTTP 5xx sin texto -> tratado como HARD_BOUNCE por precaución", () => {
  const r = classifyBounceEvidence({ ndrDetail: null, httpStatusCode: 550 });
  assert.equal(r.classification, "HARD_BOUNCE");
  assert.equal(r.isPermanentlyInvalid, true);
});

test("solo código HTTP 4xx sin texto -> RETRYABLE", () => {
  const r = classifyBounceEvidence({ ndrDetail: null, httpStatusCode: 421 });
  assert.equal(r.classification, "RETRYABLE");
});

test("determinismo: mismo input siempre produce el mismo resultado", () => {
  const input = { ndrDetail: "550 5.1.1 User unknown" };
  assert.deepEqual(classifyBounceEvidence(input), classifyBounceEvidence(input));
});
