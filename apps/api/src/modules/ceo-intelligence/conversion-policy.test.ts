import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCompanyConversion, evaluateDraftEligibility, type ConversionEvidence } from "./conversion-policy";

function evidence(overrides: Partial<ConversionEvidence> = {}): ConversionEvidence {
  return {
    businessConfidence: "EXACT",
    hiringStatus: "CONFIRMED_HIRING",
    hiringEvidenceConcrete: true,
    hasVerifiedOrgEmail: true,
    hasRiskyOrgEmail: false,
    hasConfirmedPhone: false,
    hasConfirmedWebsite: false,
    hasRealPersonContact: false,
    ...overrides,
  };
}

test("EXACT + CONFIRMED_HIRING + email verificado -> Lead + Opportunity, revisión estándar", () => {
  const d = decideCompanyConversion(evidence());
  assert.equal(d.createLead, true);
  assert.equal(d.createOpportunity, true);
  assert.equal(d.opportunityReviewRequired, false);
  assert.equal(d.rule, "EXACT_CONFIRMED_OR_LIKELY_HIRING");
});

test("EXACT + LIKELY_HIRING + solo teléfono confirmado (sin email) -> Lead + Opportunity igual", () => {
  const d = decideCompanyConversion(
    evidence({ hiringStatus: "LIKELY_HIRING", hasVerifiedOrgEmail: false, hasConfirmedPhone: true }),
  );
  assert.equal(d.createLead, true);
  assert.equal(d.createOpportunity, true);
  assert.equal(d.opportunityReviewRequired, false);
  assert.equal(d.rule, "EXACT_CONFIRMED_OR_LIKELY_HIRING");
});

test("EXACT + POSSIBLE_HIRING + puestos detectados (evidencia concreta) -> Lead + Opportunity REVIEW_REQUIRED", () => {
  const d = decideCompanyConversion(
    evidence({ hiringStatus: "POSSIBLE_HIRING", hiringEvidenceConcrete: true, hasVerifiedOrgEmail: false, hasConfirmedWebsite: true }),
  );
  assert.equal(d.createLead, true);
  assert.equal(d.createOpportunity, true);
  assert.equal(d.opportunityReviewRequired, true);
  assert.equal(d.rule, "EXACT_POSSIBLE_HIRING_WITH_EVIDENCE");
});

test("EXACT + POSSIBLE_HIRING + solo sitio confirmado (sin puestos ni teléfono) -> igual genera Lead + Opportunity REVIEW_REQUIRED", () => {
  const d = decideCompanyConversion(
    evidence({ hiringStatus: "POSSIBLE_HIRING", hiringEvidenceConcrete: false, hasConfirmedWebsite: true, hasVerifiedOrgEmail: false }),
  );
  assert.equal(d.createLead, true);
  assert.equal(d.createOpportunity, true);
  assert.equal(d.opportunityReviewRequired, true);
  assert.equal(d.rule, "EXACT_POSSIBLE_HIRING_WITH_EVIDENCE");
});

test("EXACT + POSSIBLE_HIRING SIN evidencia concreta (solo un email como canal) -> evidencia insuficiente, sin acción", () => {
  const d = decideCompanyConversion(
    evidence({ hiringStatus: "POSSIBLE_HIRING", hiringEvidenceConcrete: false, hasConfirmedWebsite: false, hasConfirmedPhone: false, hasVerifiedOrgEmail: true }),
  );
  assert.equal(d.createLead, false);
  assert.equal(d.createOpportunity, false);
  assert.equal(d.rule, "INSUFFICIENT_EVIDENCE");
});

test("APPROXIMATE + POSSIBLE_HIRING + canal real -> Lead de investigación, Opportunity condicionada a revisión manual", () => {
  const d = decideCompanyConversion(
    evidence({ businessConfidence: "APPROXIMATE", hiringStatus: "POSSIBLE_HIRING", hasVerifiedOrgEmail: true }),
  );
  assert.equal(d.createLead, true);
  assert.equal(d.createOpportunity, true);
  assert.equal(d.opportunityReviewRequired, true);
  assert.equal(d.rule, "APPROXIMATE_SIGNAL_WITH_EVIDENCE");
});

test("STRONG (un escalón bajo EXACT) + CONFIRMED_HIRING + canal -> mismo tratamiento que APPROXIMATE, nunca el fast-track de EXACT", () => {
  const d = decideCompanyConversion(evidence({ businessConfidence: "STRONG" }));
  assert.equal(d.createLead, true);
  assert.equal(d.createOpportunity, true);
  assert.equal(d.opportunityReviewRequired, true);
  assert.equal(d.rule, "APPROXIMATE_SIGNAL_WITH_EVIDENCE");
});

test("NO_SIGNAL con confianza EXACT y canal real -> Lead de investigación, NUNCA Opportunity automática", () => {
  const d = decideCompanyConversion(evidence({ hiringStatus: "NO_SIGNAL" }));
  assert.equal(d.createLead, true);
  assert.equal(d.createOpportunity, false);
  assert.equal(d.rule, "NO_SIGNAL_LEAD_ONLY");
});

test("NO_SIGNAL con confianza APPROXIMATE y canal real -> también Lead de investigación, nunca Opportunity", () => {
  const d = decideCompanyConversion(evidence({ businessConfidence: "APPROXIMATE", hiringStatus: "NO_SIGNAL" }));
  assert.equal(d.createLead, true);
  assert.equal(d.createOpportunity, false);
  assert.equal(d.rule, "NO_SIGNAL_LEAD_ONLY");
});

test("hiringStatus UNKNOWN (Website Intelligence no pudo evaluar) se trata igual que NO_SIGNAL", () => {
  const d = decideCompanyConversion(evidence({ hiringStatus: "UNKNOWN" }));
  assert.equal(d.createLead, true);
  assert.equal(d.createOpportunity, false);
  assert.equal(d.rule, "NO_SIGNAL_LEAD_ONLY");
});

test("businessConfidence WEAK nunca crea Lead ni Opportunity, aunque haya señal de contratación confirmada y canal", () => {
  const d = decideCompanyConversion(evidence({ businessConfidence: "WEAK" }));
  assert.equal(d.createLead, false);
  assert.equal(d.createOpportunity, false);
  assert.equal(d.rule, "BLOCKED_OR_DUBIOUS_IDENTITY");
});

test("businessConfidence REJECTED (identidad dudosa) nunca crea Lead ni Opportunity", () => {
  const d = decideCompanyConversion(evidence({ businessConfidence: "REJECTED" }));
  assert.equal(d.createLead, false);
  assert.equal(d.createOpportunity, false);
  assert.equal(d.rule, "BLOCKED_OR_DUBIOUS_IDENTITY");
});

test("hiringStatus BLOCKED nunca crea Lead ni Opportunity, aunque la validación de negocio sea EXACT", () => {
  const d = decideCompanyConversion(evidence({ hiringStatus: "BLOCKED" }));
  assert.equal(d.createLead, false);
  assert.equal(d.createOpportunity, false);
  assert.equal(d.rule, "BLOCKED_OR_DUBIOUS_IDENTITY");
});

test("EXACT + CONFIRMED_HIRING pero sin ningún canal real (ni email, ni teléfono, ni sitio, ni contacto) -> sin acción", () => {
  const d = decideCompanyConversion(
    evidence({ hasVerifiedOrgEmail: false, hasRiskyOrgEmail: false, hasConfirmedPhone: false, hasConfirmedWebsite: false, hasRealPersonContact: false }),
  );
  assert.equal(d.createLead, false);
  assert.equal(d.createOpportunity, false);
  assert.equal(d.rule, "NO_MINIMUM_EVIDENCE");
  assert.equal(d.hasAnyChannel, false);
});

test("un email RISKY (nunca VERIFIED) igual cuenta como canal para habilitar Lead/Opportunity, pero no para Draft", () => {
  const d = decideCompanyConversion(
    evidence({ hasVerifiedOrgEmail: false, hasRiskyOrgEmail: true }),
  );
  assert.equal(d.createLead, true);
  assert.equal(d.createOpportunity, true);
  assert.equal(d.hasAnyChannel, true);
});

test("cada decisión trae una razón legible no vacía", () => {
  for (const conf of ["EXACT", "STRONG", "APPROXIMATE", "WEAK", "REJECTED"] as const) {
    const d = decideCompanyConversion(evidence({ businessConfidence: conf }));
    assert.ok(d.reason.length > 0, `sin razón para ${conf}`);
  }
});

// ---------- evaluateDraftEligibility ----------

test("draft: sin Opportunity creada, nunca es elegible", () => {
  const r = evaluateDraftEligibility({ opportunityCreated: false, hasVerifiedOrgEmail: true, hasRealPersonContactWithEmail: true });
  assert.equal(r.eligible, false);
});

test("draft: Opportunity + email organizacional verificado -> elegible", () => {
  const r = evaluateDraftEligibility({ opportunityCreated: true, hasVerifiedOrgEmail: true, hasRealPersonContactWithEmail: false });
  assert.equal(r.eligible, true);
});

test("draft: Opportunity + contacto real con email -> elegible aunque no haya email organizacional", () => {
  const r = evaluateDraftEligibility({ opportunityCreated: true, hasVerifiedOrgEmail: false, hasRealPersonContactWithEmail: true });
  assert.equal(r.eligible, true);
});

test("draft: Opportunity creada pero sin ningún canal de email verificado -> nunca elegible, la Opportunity queda sin canal de email", () => {
  const r = evaluateDraftEligibility({ opportunityCreated: true, hasVerifiedOrgEmail: false, hasRealPersonContactWithEmail: false });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /llamada|investigación|manual/i);
});
