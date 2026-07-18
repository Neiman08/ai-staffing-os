import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateComplianceRules,
  selectApplicableRules,
  describeComplianceStatus,
  COMPLIANCE_RULES_VERSION,
  type ComplianceRuleDefinition,
  type ComplianceEvaluationContext,
  type DocumentCheckInput,
} from "./compliance-rules";

const NOW = new Date("2026-07-17T00:00:00.000Z");

function rule(overrides: Partial<ComplianceRuleDefinition> = {}): ComplianceRuleDefinition {
  return {
    id: "rule-1",
    name: "Forklift base requirements",
    scope: { state: null, industryId: null, companyId: null, jobCategoryId: null, assignmentType: null },
    requiredDocumentTypeKeys: ["forklift_cert"],
    active: true,
    ...overrides,
  };
}

function ctx(overrides: Partial<ComplianceEvaluationContext> = {}): ComplianceEvaluationContext {
  return { state: "IL", industryId: "ind-1", companyId: "co-1", jobCategoryId: "cat-1", assignmentType: "W2", ...overrides };
}

test("selectApplicableRules: a rule with all-null scope applies universally", () => {
  const selected = selectApplicableRules([rule()], ctx());
  assert.equal(selected.length, 1);
});

test("selectApplicableRules: a non-null scope field must match exactly", () => {
  const stateRule = rule({ scope: { state: "IL", industryId: null, companyId: null, jobCategoryId: null, assignmentType: null } });
  assert.equal(selectApplicableRules([stateRule], ctx({ state: "IL" })).length, 1);
  assert.equal(selectApplicableRules([stateRule], ctx({ state: "TX" })).length, 0);
});

test("selectApplicableRules: inactive rules are never selected", () => {
  assert.equal(selectApplicableRules([rule({ active: false })], ctx()).length, 0);
});

test("selectApplicableRules: multiple scope fields must ALL match (AND, not OR)", () => {
  const specific = rule({ scope: { state: "IL", industryId: null, companyId: "co-1", jobCategoryId: null, assignmentType: null } });
  assert.equal(selectApplicableRules([specific], ctx({ state: "IL", companyId: "co-1" })).length, 1);
  assert.equal(selectApplicableRules([specific], ctx({ state: "IL", companyId: "co-2" })).length, 0);
});

test("evaluateComplianceRules: READY when every required document is VERIFIED and worker is COMPLIANT", () => {
  const result = evaluateComplianceRules([rule()], [{ documentTypeKey: "forklift_cert", status: "VERIFIED" }], "COMPLIANT", NOW);
  assert.equal(result.complianceStatus, "READY");
  assert.deepEqual(result.satisfiedChecks, ["forklift_cert"]);
  assert.deepEqual(result.missingChecks, []);
});

test("evaluateComplianceRules: INCOMPLETE when a required document is missing entirely, no blockers", () => {
  const result = evaluateComplianceRules([rule()], [], "COMPLIANT", NOW);
  assert.equal(result.complianceStatus, "INCOMPLETE");
  assert.deepEqual(result.missingChecks, ["forklift_cert"]);
  assert.equal(result.blockers.length, 0);
});

test("evaluateComplianceRules: BLOCKED when a required document is EXPIRED", () => {
  const result = evaluateComplianceRules([rule()], [{ documentTypeKey: "forklift_cert", status: "EXPIRED" }], "COMPLIANT", NOW);
  assert.equal(result.complianceStatus, "BLOCKED");
  assert.deepEqual(result.expiredChecks, ["forklift_cert"]);
  assert.ok(result.blockers.some((b) => b.includes("Expired")));
});

test("evaluateComplianceRules: BLOCKED when Worker.complianceStatus is BLOCKED, regardless of documents", () => {
  const result = evaluateComplianceRules([rule()], [{ documentTypeKey: "forklift_cert", status: "VERIFIED" }], "BLOCKED", NOW);
  assert.equal(result.complianceStatus, "BLOCKED");
});

test("evaluateComplianceRules: NEEDS_REVIEW when a required document is UNDER_REVIEW and nothing else blocks", () => {
  const result = evaluateComplianceRules([rule()], [{ documentTypeKey: "forklift_cert", status: "UNDER_REVIEW" }], "COMPLIANT", NOW);
  assert.equal(result.complianceStatus, "NEEDS_REVIEW");
  assert.ok(result.manualReviewFlags.length > 0);
});

test("evaluateComplianceRules: PENDING worker compliance is a warning, not a blocker", () => {
  const result = evaluateComplianceRules([rule()], [{ documentTypeKey: "forklift_cert", status: "VERIFIED" }], "PENDING", NOW);
  assert.equal(result.complianceStatus, "READY");
  assert.ok(result.warnings.some((w) => w.includes("PENDING")));
});

test("evaluateComplianceRules: requiredChecks is the union of keys across all applicable rules, deduplicated", () => {
  const ruleA = rule({ id: "a", requiredDocumentTypeKeys: ["forklift_cert", "drug_test"] });
  const ruleB = rule({ id: "b", requiredDocumentTypeKeys: ["drug_test", "background_check"] });
  const result = evaluateComplianceRules([ruleA, ruleB], [], "COMPLIANT", NOW);
  assert.deepEqual(result.requiredChecks, ["background_check", "drug_test", "forklift_cert"]);
});

test("evaluateComplianceRules: zero applicable rules produces trivially READY with no requirements", () => {
  const result = evaluateComplianceRules([], [], "COMPLIANT", NOW);
  assert.equal(result.complianceStatus, "READY");
  assert.deepEqual(result.requiredChecks, []);
});

test("evaluateComplianceRules is deterministic: same input twice produces an identical result", () => {
  const docs: DocumentCheckInput[] = [{ documentTypeKey: "forklift_cert", status: "VERIFIED" }];
  assert.deepEqual(evaluateComplianceRules([rule()], docs, "COMPLIANT", NOW), evaluateComplianceRules([rule()], docs, "COMPLIANT", NOW));
});

test("rulesVersion and evaluatedAt are always present", () => {
  const result = evaluateComplianceRules([rule()], [], "COMPLIANT", NOW);
  assert.equal(result.rulesVersion, COMPLIANCE_RULES_VERSION);
  assert.equal(result.evaluatedAt, NOW.toISOString());
});

test("describeComplianceStatus: never asserts legal compliance -- text avoids 'legally compliant' entirely", () => {
  const statuses = ["NOT_EVALUATED", "INCOMPLETE", "NEEDS_REVIEW", "BLOCKED", "READY"] as const;
  for (const s of statuses) {
    const text = describeComplianceStatus(s).toLowerCase();
    assert.ok(!text.includes("legally compliant"));
    assert.ok(!text.includes("legal compliance"));
  }
});

test("describeComplianceStatus: READY uses 'operationally ready' / 'checklist completed' wording", () => {
  const text = describeComplianceStatus("READY").toLowerCase();
  assert.ok(text.includes("operationally ready") || text.includes("checklist completed"));
});
