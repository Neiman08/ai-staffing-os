import { test } from "node:test";
import assert from "node:assert/strict";
import { matchTitleToPlannedRole } from "./contact-role-match";

function fakeMapper(overrides: Record<string, string | null> = {}): (title: string | null) => string | null {
  return (title) => {
    if (!title) return null;
    const lower = title.toLowerCase();
    for (const [key, role] of Object.entries(overrides)) {
      if (lower.includes(key)) return role;
    }
    return null;
  };
}

test("substring: un título más largo que contiene el rol planificado matchea", () => {
  const result = matchTitleToPlannedRole("Senior HR Manager, Midwest Region", ["HR Manager"], fakeMapper());
  assert.equal(result, "HR Manager");
});

test("substring: un rol planificado más largo que contiene el título también matchea", () => {
  const result = matchTitleToPlannedRole("HR Manager", ["Senior HR Manager"], fakeMapper());
  assert.equal(result, "Senior HR Manager");
});

test("sin título, nunca matchea (nunca inventa)", () => {
  assert.equal(matchTitleToPlannedRole(null, ["HR Manager"], fakeMapper()), null);
});

test("sin roles planificados, nunca matchea", () => {
  assert.equal(matchTitleToPlannedRole("HR Manager", [], fakeMapper()), null);
});

test("fallback: título y rol planificado distintos en texto pero mismo decisionRole matchean", () => {
  const mapper = fakeMapper({ "talent acquisition specialist": "TALENT_ACQUISITION", recruiter: "TALENT_ACQUISITION" });
  const result = matchTitleToPlannedRole("Talent Acquisition Specialist", ["Recruiter"], mapper);
  assert.equal(result, "Recruiter");
});

test("ningún criterio matchea -> null, nunca un match forzado", () => {
  const mapper = fakeMapper({ "plant manager": "PLANT_MANAGER" });
  const result = matchTitleToPlannedRole("Accounts Receivable Associate", ["HR Manager", "Plant Manager"], mapper);
  assert.equal(result, null);
});

test("devuelve el targetRole tal como vino, nunca una versión normalizada", () => {
  const result = matchTitleToPlannedRole("hr manager", ["  HR Manager  "], fakeMapper());
  assert.equal(result, "  HR Manager  ");
});

test("determinismo: misma entrada siempre produce el mismo resultado", () => {
  const mapper = fakeMapper({ "plant manager": "PLANT_MANAGER" });
  const a = matchTitleToPlannedRole("Plant Manager", ["Plant Manager", "HR Manager"], mapper);
  const b = matchTitleToPlannedRole("Plant Manager", ["Plant Manager", "HR Manager"], mapper);
  assert.equal(a, b);
});
