import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDecisionRolePlan, type RolePlanInput } from "./role-planning";

function baseInput(overrides: Partial<RolePlanInput> = {}): RolePlanInput {
  return {
    companyId: "company-1",
    taxonomyKey: "manufacturing",
    intentDecisionRoles: [],
    taxonomyDecisionMakers: [],
    hiringStatus: null,
    missionExclusions: [],
    ...overrides,
  };
}

test("roles pedidos explicitamente por el usuario tienen prioridad maxima", () => {
  const plan = buildDecisionRolePlan(
    baseInput({ intentDecisionRoles: ["HR Manager"], taxonomyDecisionMakers: ["Plant Manager", "Operations Manager"] }),
  );
  assert.equal(plan.targetRoles[0]!.role, "HR Manager");
  assert.equal(plan.targetRoles[0]!.priority, 1);
  assert.equal(plan.targetRoles[0]!.source, "intent");
});

test("sin roles explicitos, usa los defaults de la taxonomia", () => {
  const plan = buildDecisionRolePlan(baseInput({ taxonomyDecisionMakers: ["Plant Manager", "HR Manager"] }));
  assert.deepEqual(plan.targetRoles.map((r) => r.role), ["Plant Manager", "HR Manager"]);
  assert.ok(plan.targetRoles.every((r) => r.source === "taxonomy"));
});

test("nunca duplica un rol que aparece tanto en intent como en taxonomia", () => {
  const plan = buildDecisionRolePlan(
    baseInput({ intentDecisionRoles: ["HR Manager"], taxonomyDecisionMakers: ["HR Manager", "Plant Manager"] }),
  );
  const hrEntries = plan.targetRoles.filter((r) => r.role === "HR Manager");
  assert.equal(hrEntries.length, 1);
  assert.equal(hrEntries[0]!.source, "intent");
});

test("un rol que coincide con una exclusion de la mision nunca se planifica", () => {
  const plan = buildDecisionRolePlan(
    baseInput({ taxonomyDecisionMakers: ["Recruiter", "Plant Manager"], missionExclusions: ["recruiter"] }),
  );
  assert.ok(!plan.targetRoles.some((r) => r.role === "Recruiter"));
  assert.ok(plan.excludedRoles.includes("Recruiter"));
});

test("hiring signal confirmado prioriza roles de RRHH/reclutamiento sobre otros", () => {
  const plan = buildDecisionRolePlan(
    baseInput({
      taxonomyDecisionMakers: ["Plant Manager", "Operations Manager", "HR Manager", "Recruiter"],
      hiringStatus: "CONFIRMED_HIRING",
    }),
  );
  assert.equal(plan.targetRoles[0]!.role, "HR Manager");
  assert.equal(plan.targetRoles[1]!.role, "Recruiter");
  assert.equal(plan.targetRoles[0]!.source, "hiring_signal_boost");
  assert.ok(plan.targetRoles[0]!.rationale.includes("CONFIRMED_HIRING"));
});

test("hiring signal LIKELY_HIRING tambien activa el boost, POSSIBLE_HIRING/NO_SIGNAL no", () => {
  const likely = buildDecisionRolePlan(baseInput({ taxonomyDecisionMakers: ["Plant Manager", "HR Manager"], hiringStatus: "LIKELY_HIRING" }));
  assert.equal(likely.targetRoles[0]!.role, "HR Manager");

  const possible = buildDecisionRolePlan(baseInput({ taxonomyDecisionMakers: ["Plant Manager", "HR Manager"], hiringStatus: "POSSIBLE_HIRING" }));
  assert.equal(possible.targetRoles[0]!.role, "Plant Manager");
});

test("confidence: alta cuando el usuario pidio roles explicitos, media con solo taxonomia, baja sin nada", () => {
  const explicit = buildDecisionRolePlan(baseInput({ intentDecisionRoles: ["HR Manager"] }));
  const taxonomyOnly = buildDecisionRolePlan(baseInput({ taxonomyDecisionMakers: ["Plant Manager"] }));
  const nothing = buildDecisionRolePlan(baseInput());
  assert.equal(explicit.confidence, 0.9);
  assert.equal(taxonomyOnly.confidence, 0.6);
  assert.equal(nothing.confidence, 0.2);
});

test("confidence sube (capada en 1) cuando ademas hay hiring signal confirmado", () => {
  const plan = buildDecisionRolePlan(baseInput({ intentDecisionRoles: ["HR Manager"], hiringStatus: "CONFIRMED_HIRING" }));
  assert.equal(plan.confidence, 1);
});

test("hiringSignalSource refleja el estado real, null cuando F7.5 no corrio", () => {
  const withSignal = buildDecisionRolePlan(baseInput({ hiringStatus: "NO_SIGNAL" }));
  assert.equal(withSignal.hiringSignalSource, "NO_SIGNAL");
  const withoutSignal = buildDecisionRolePlan(baseInput());
  assert.equal(withoutSignal.hiringSignalSource, null);
});

test("nunca inventa una persona -- el contrato solo declara roles, nunca nombres/emails", () => {
  const plan = buildDecisionRolePlan(baseInput({ intentDecisionRoles: ["HR Manager"] }));
  const serialized = JSON.stringify(plan);
  assert.ok(!serialized.includes("firstName"));
  assert.ok(!serialized.includes("email"));
});

test("determinismo: misma entrada siempre produce el mismo resultado", () => {
  const input = baseInput({ intentDecisionRoles: ["HR Manager"], taxonomyDecisionMakers: ["Plant Manager"], hiringStatus: "CONFIRMED_HIRING" });
  assert.deepEqual(buildDecisionRolePlan(input), buildDecisionRolePlan(input));
});

test("planVersion siempre presente y estable", () => {
  assert.equal(buildDecisionRolePlan(baseInput()).planVersion, 1);
});
