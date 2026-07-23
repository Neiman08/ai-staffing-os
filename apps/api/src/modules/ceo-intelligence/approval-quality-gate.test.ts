import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateApprovalQualityGate, type ApprovalQualityGateInput } from "./approval-quality-gate";

function baseInput(overrides: Partial<ApprovalQualityGateInput> = {}): ApprovalQualityGateInput {
  return {
    companyOrigin: "API_PROVIDER",
    companyCommercialStatus: "COMMERCIAL_VALIDATED",
    to: "contact@realcompany.example",
    subject: "Asunto real",
    body: "Cuerpo real, sin placeholders.",
    hasOtherActiveDuplicateApproval: false,
    ...overrides,
  };
}

test("pasa cuando todo está en orden", () => {
  const r = evaluateApprovalQualityGate(baseInput());
  assert.equal(r.passed, true);
  assert.deepEqual(r.failures, []);
});

test("falla: company_valid -- DEMO_SEED", () => {
  const r = evaluateApprovalQualityGate(baseInput({ companyOrigin: "DEMO_SEED" }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.check === "company_valid"));
});

test("falla: classification_valid -- DISCOVERY_CANDIDATE", () => {
  const r = evaluateApprovalQualityGate(baseInput({ companyCommercialStatus: "DISCOVERY_CANDIDATE" }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.check === "classification_valid"));
});

test("falla: contact_valid -- sin destinatario", () => {
  const r = evaluateApprovalQualityGate(baseInput({ to: null }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.check === "contact_valid"));
});

test("falla: email_valid -- sintaxis inválida", () => {
  const r = evaluateApprovalQualityGate(baseInput({ to: "not-an-email" }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.check === "email_valid"));
});

test("falla: email_valid -- contaminado con teléfono (caso real Essence Suites)", () => {
  const r = evaluateApprovalQualityGate(baseInput({ to: "7084033300romance@essencesuites.com" }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.check === "email_valid" && /telefónica/.test(f.reason)));
});

test("falla: no_placeholders -- inglés y español", () => {
  const r1 = evaluateApprovalQualityGate(baseInput({ body: "Best regards,\n[Your Name]" }));
  assert.ok(r1.failures.some((f) => f.check === "no_placeholders"));
  const r2 = evaluateApprovalQualityGate(baseInput({ body: "Saludos,\n[Tu Nombre]" }));
  assert.ok(r2.failures.some((f) => f.check === "no_placeholders"));
});

test("falla: no_duplicates", () => {
  const r = evaluateApprovalQualityGate(baseInput({ hasOtherActiveDuplicateApproval: true }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.check === "no_duplicates"));
});

test("falla: content_complete -- asunto vacío", () => {
  const r = evaluateApprovalQualityGate(baseInput({ subject: "   " }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.check === "content_complete"));
});

test("falla: content_complete -- cuerpo vacío", () => {
  const r = evaluateApprovalQualityGate(baseInput({ body: "" }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.check === "content_complete"));
});

test("falla: minimal_metadata -- sin Company resoluble en absoluto", () => {
  const r = evaluateApprovalQualityGate(baseInput({ companyOrigin: null, companyCommercialStatus: null }));
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.check === "minimal_metadata"));
});

test("reporta TODOS los fallos a la vez, no solo el primero", () => {
  const r = evaluateApprovalQualityGate(
    baseInput({ companyOrigin: "DEMO_SEED", to: null, body: "", subject: "" }),
  );
  const checks = r.failures.map((f) => f.check);
  assert.ok(checks.includes("company_valid"));
  assert.ok(checks.includes("contact_valid"));
  assert.ok(checks.includes("content_complete"));
});
