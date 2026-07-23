import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideCompanyConversion,
  evaluateDraftEligibility,
  deriveCommercialStatus,
  evaluateBusinessIdentityGate,
  type ConversionEvidence,
  type BusinessConfidence,
} from "./conversion-policy";

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

// ---------- F18: Discovery vs. Conversión Comercial ----------
// Hallazgo real: una misión de hoteles terminó con Companies de Data
// Centers (CoreSite, Equinix, Aligned...) archivadas como si fueran
// Hospitality, porque confianza WEAK (ninguna evidencia positiva, pero
// tampoco negativa) se aceptaba igual como Company comercial. Estas
// pruebas fijan la regla nueva: WEAK/REJECTED nunca son comercialmente
// elegibles, sin importar qué industria pidió la misión.

const ALL_CONFIDENCE_LEVELS: BusinessConfidence[] = ["EXACT", "STRONG", "APPROXIMATE", "WEAK", "REJECTED"];

test("deriveCommercialStatus: EXACT/STRONG/APPROXIMATE -> COMMERCIAL_VALIDATED", () => {
  for (const level of ["EXACT", "STRONG", "APPROXIMATE"] as const) {
    assert.equal(deriveCommercialStatus(level), "COMMERCIAL_VALIDATED", `esperaba COMMERCIAL_VALIDATED para ${level}`);
  }
});

test("deriveCommercialStatus: WEAK/REJECTED -> DISCOVERY_CANDIDATE (nunca comercial)", () => {
  for (const level of ["WEAK", "REJECTED"] as const) {
    assert.equal(deriveCommercialStatus(level), "DISCOVERY_CANDIDATE", `esperaba DISCOVERY_CANDIDATE para ${level}`);
  }
});

test("evaluateBusinessIdentityGate: DISCOVERY_CANDIDATE nunca es elegible para Lead/Opportunity", () => {
  const decision = evaluateBusinessIdentityGate("DISCOVERY_CANDIDATE");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule, "BUSINESS_IDENTITY_UNVALIDATED");
});

test("evaluateBusinessIdentityGate: COMMERCIAL_VALIDATED es elegible", () => {
  const decision = evaluateBusinessIdentityGate("COMMERCIAL_VALIDATED");
  assert.equal(decision.allowed, true);
  assert.equal(decision.rule, "BUSINESS_IDENTITY_VALIDATED");
});

// F24 (auditoría de producción): 8 Companies con origin=DEMO_SEED
// (packages/db/prisma/seed.ts) terminaron con ApprovalRequest reales en
// producción porque nada chequeaba origin en este gate -- regresión
// directa contra ese hallazgo.
test("evaluateBusinessIdentityGate: origin=DEMO_SEED nunca es elegible, sin importar commercialStatus", () => {
  const decision = evaluateBusinessIdentityGate("COMMERCIAL_VALIDATED", "DEMO_SEED");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule, "DEMO_SEED_ORIGIN");
});

test("evaluateBusinessIdentityGate: origin real (API_PROVIDER/MANUAL/etc.) no se ve afectado", () => {
  for (const origin of ["API_PROVIDER", "MANUAL", "CSV_IMPORT", "EXTERNAL_DISCOVERY", undefined]) {
    const decision = evaluateBusinessIdentityGate("COMMERCIAL_VALIDATED", origin);
    assert.equal(decision.allowed, true, `origin=${origin} no debería bloquear`);
  }
});

test("cadena completa: cualquier confianza WEAK, sin importar la industria pedida, nunca llega a ser elegible para Lead/Opportunity", () => {
  for (const level of ALL_CONFIDENCE_LEVELS) {
    const status = deriveCommercialStatus(level);
    const gate = evaluateBusinessIdentityGate(status);
    if (level === "WEAK" || level === "REJECTED") {
      assert.equal(gate.allowed, false, `${level} nunca debería ser elegible`);
    } else {
      assert.equal(gate.allowed, true, `${level} debería ser elegible`);
    }
  }
});
