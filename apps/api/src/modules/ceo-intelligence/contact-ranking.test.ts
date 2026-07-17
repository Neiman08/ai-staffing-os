import { test } from "node:test";
import assert from "node:assert/strict";
import { rankContact, classifyAuthorityLevel, type ContactRankingInput } from "./contact-ranking";

function baseInput(overrides: Partial<ContactRankingInput> = {}): ContactRankingInput {
  return {
    companyMatch: true,
    domainTrust: "VERIFIED",
    roleMatch: true,
    rolePriority: 1,
    authorityLevel: "SPECIALIST",
    emailVerificationStatus: "NOT_VERIFIED",
    discoveryConfidenceScore: 0.7,
    providerStatus: "AVAILABLE",
    discoveredAt: new Date().toISOString(),
    now: new Date().toISOString(),
    ...overrides,
  };
}

test("companyMatch false siempre fuerza REJECTED, sin importar el resto de la evidencia", () => {
  const result = rankContact(baseInput({ companyMatch: false, domainTrust: "VERIFIED", roleMatch: true, rolePriority: 1, authorityLevel: "EXECUTIVE" }));
  assert.equal(result.tier, "REJECTED");
  assert.equal(result.score, 0);
});

test("domainTrust INVALID siempre fuerza REJECTED", () => {
  const result = rankContact(baseInput({ domainTrust: "INVALID" }));
  assert.equal(result.tier, "REJECTED");
});

test("emailVerificationStatus INVALID siempre fuerza REJECTED", () => {
  const result = rankContact(baseInput({ emailVerificationStatus: "INVALID" }));
  assert.equal(result.tier, "REJECTED");
});

test("evidencia completa y fuerte -> HIGH_CONFIDENCE", () => {
  const result = rankContact(
    baseInput({
      domainTrust: "VERIFIED",
      roleMatch: true,
      rolePriority: 1,
      authorityLevel: "EXECUTIVE",
      emailVerificationStatus: "VERIFIED",
      discoveryConfidenceScore: 1,
      providerStatus: "AVAILABLE",
    }),
  );
  assert.equal(result.tier, "HIGH_CONFIDENCE");
  assert.ok(result.score >= 0.75);
});

test("evidencia minima sin rol matcheado -> LOW_CONFIDENCE, nunca REJECTED por si solo", () => {
  const result = rankContact(
    baseInput({
      domainTrust: "UNKNOWN",
      roleMatch: false,
      rolePriority: null,
      authorityLevel: "UNKNOWN",
      emailVerificationStatus: "NOT_VERIFIED",
      discoveryConfidenceScore: 0.5,
      providerStatus: "AVAILABLE",
    }),
  );
  assert.equal(result.tier, "LOW_CONFIDENCE");
  assert.notEqual(result.tier, "REJECTED");
});

test("evidencia intermedia (rol matcheado, sin verificacion de email) -> MEDIUM_CONFIDENCE", () => {
  const result = rankContact(
    baseInput({
      domainTrust: "UNKNOWN",
      roleMatch: true,
      rolePriority: 3,
      authorityLevel: "SPECIALIST",
      emailVerificationStatus: "NOT_VERIFIED",
      discoveryConfidenceScore: 0.5,
    }),
  );
  assert.equal(result.tier, "MEDIUM_CONFIDENCE");
});

test("rolePriority 1 puntua mas que rolePriority 2, que puntua mas que sin bono de prioridad", () => {
  const p1 = rankContact(baseInput({ rolePriority: 1 }));
  const p2 = rankContact(baseInput({ rolePriority: 2 }));
  const p5 = rankContact(baseInput({ rolePriority: 5 }));
  assert.ok(p1.score > p2.score);
  assert.ok(p2.score > p5.score);
});

test("cada nivel de autoridad aporta mas score que el anterior: EXECUTIVE > MANAGER > SPECIALIST > UNKNOWN", () => {
  // Resto de factores deliberadamente bajo para que ningun caso sature
  // el score en 1 (lo que ocultaria la diferencia que aporta SOLO la
  // autoridad).
  const weak = { domainTrust: "UNKNOWN" as const, rolePriority: 5, emailVerificationStatus: "NOT_VERIFIED" as const, discoveryConfidenceScore: 0.3 };
  const exec = rankContact(baseInput({ ...weak, authorityLevel: "EXECUTIVE" }));
  const manager = rankContact(baseInput({ ...weak, authorityLevel: "MANAGER" }));
  const specialist = rankContact(baseInput({ ...weak, authorityLevel: "SPECIALIST" }));
  const unknown = rankContact(baseInput({ ...weak, authorityLevel: "UNKNOWN" }));
  assert.ok(exec.score > manager.score);
  assert.ok(manager.score > specialist.score);
  assert.ok(specialist.score > unknown.score);
});

test("recencia: descubierto hace mas de 90 dias puntua menos que uno reciente, nunca fuerza REJECTED", () => {
  const recent = rankContact(baseInput({ discoveredAt: new Date().toISOString() }));
  const stale = rankContact(
    baseInput({ discoveredAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString() }),
  );
  assert.ok(recent.score > stale.score);
  assert.notEqual(stale.tier, "REJECTED");
});

test("score siempre acotado entre 0 y 1", () => {
  const max = rankContact(
    baseInput({ domainTrust: "VERIFIED", roleMatch: true, rolePriority: 1, authorityLevel: "EXECUTIVE", emailVerificationStatus: "VERIFIED", discoveryConfidenceScore: 1 }),
  );
  assert.ok(max.score <= 1);
});

test("classifyAuthorityLevel: nunca inventa una categoria para un decisionRole no reconocido o null", () => {
  assert.equal(classifyAuthorityLevel("OWNER"), "EXECUTIVE");
  assert.equal(classifyAuthorityLevel("HR"), "SPECIALIST");
  assert.equal(classifyAuthorityLevel("OPERATIONS_MANAGER"), "MANAGER");
  assert.equal(classifyAuthorityLevel("OTHER"), "UNKNOWN");
  assert.equal(classifyAuthorityLevel(null), "UNKNOWN");
  assert.equal(classifyAuthorityLevel("SOME_UNKNOWN_VALUE"), "UNKNOWN");
});

test("reasons siempre no vacio -- toda decision es auditable", () => {
  const result = rankContact(baseInput());
  assert.ok(result.reasons.length > 0);
});

test("determinismo: misma entrada siempre produce el mismo resultado", () => {
  const input = baseInput({ now: "2026-07-17T00:00:00.000Z", discoveredAt: "2026-07-01T00:00:00.000Z" });
  assert.deepEqual(rankContact(input), rankContact(input));
});

test("rankingVersion siempre presente y estable", () => {
  assert.equal(rankContact(baseInput()).rankingVersion, 1);
});
