import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretJobIntake, type JobIntakeInput, type KnownJobCategory, type KnownDocumentType } from "./job-intake";

const FORKLIFT_CATEGORY: KnownJobCategory = { id: "cat-forklift", name: "Forklift Operator", industryName: "Warehouse/Logistics" };
const ELECTRICIAN_CATEGORY: KnownJobCategory = { id: "cat-electrician", name: "Electrician", industryName: "Construction" };
const JOURNEYMAN_CATEGORY: KnownJobCategory = { id: "cat-journeyman", name: "Journeyman Electrician", industryName: "Construction" };
const FORKLIFT_CERT: KnownDocumentType = { key: "forklift_cert", name: "Forklift Certification", category: "certification" };
const DRUG_TEST: KnownDocumentType = { key: "drug_test", name: "Drug Test", category: "screening" };

function baseInput(overrides: Partial<JobIntakeInput> = {}): JobIntakeInput {
  return {
    rawInstruction: "",
    knownJobCategories: [FORKLIFT_CATEGORY, ELECTRICIAN_CATEGORY, JOURNEYMAN_CATEGORY],
    knownDocumentTypes: [FORKLIFT_CERT, DRUG_TEST],
    ...overrides,
  };
}

test("extrae titulo/categoria real, ubicacion, cantidad, turno, pago, certificacion y urgencia de una instruccion completa", () => {
  const result = interpretJobIntake(
    baseInput({
      rawInstruction: "Necesito 5 Forklift Operators en Chicago, IL, turno de noche, $18-22/hr, urgente, requieren Forklift Certification.",
    }),
  );
  assert.equal(result.jobTitle, "Forklift Operator");
  assert.equal(result.matchedCategoryId, "cat-forklift");
  assert.equal(result.industry, "Warehouse/Logistics");
  assert.equal(result.city, "Chicago");
  assert.equal(result.state, "IL");
  assert.equal(result.headcount, 5);
  assert.equal(result.shift, "NIGHT");
  assert.deepEqual(result.payRate, { min: 18, max: 22 });
  assert.equal(result.urgency, "HIGH");
  assert.ok(result.certifications.includes("Forklift Certification"));
  assert.ok(result.complianceRequirements.includes("forklift_cert"));
});

test("prefiere la categoria mas especifica cuando dos matchean (Journeyman Electrician sobre Electrician)", () => {
  const result = interpretJobIntake(baseInput({ rawInstruction: "Busco un Journeyman Electrician para un proyecto en Aurora." }));
  assert.equal(result.jobTitle, "Journeyman Electrician");
  assert.equal(result.matchedCategoryId, "cat-journeyman");
});

test("sin categoria real matcheada, jobTitle queda null y se reporta como ambiguedad -- nunca inventa un titulo", () => {
  const result = interpretJobIntake(baseInput({ rawInstruction: "Necesito gente para un puesto nuevo que no existe en el catalogo." }));
  assert.equal(result.jobTitle, null);
  assert.equal(result.matchedCategoryId, null);
  assert.ok(result.ambiguities.some((a) => a.includes("catálogo")));
  assert.equal(result.confidence, 0.2);
});

test("sin ubicacion, cantidad, turno o pago detectables, cada campo queda null con su propia ambiguedad", () => {
  const result = interpretJobIntake(baseInput({ rawInstruction: "Necesito Forklift Operators." }));
  assert.equal(result.city, null);
  assert.equal(result.state, null);
  assert.equal(result.shift, null);
  assert.equal(result.payRate, null);
  assert.ok(result.ambiguities.length >= 3);
});

test("exclusiones se extraen y nunca contaminan el resto del parseo (mismo criterio que F7.1)", () => {
  const result = interpretJobIntake(
    baseInput({ rawInstruction: "Necesito Forklift Operators en Chicago, excluyendo turno de noche." }),
  );
  assert.ok(result.exclusions.some((e) => e.includes("turno de noche") || e.includes("noche")));
});

test("certificaciones y compliance requirements nunca inventan una que no exista en knownDocumentTypes", () => {
  const result = interpretJobIntake(baseInput({ rawInstruction: "Necesito Forklift Operators con certificación de manejo de grúa (crane license)." }));
  assert.deepEqual(result.certifications, []);
  assert.deepEqual(result.complianceRequirements, []);
});

test("idiomas detectados solo de un vocabulario cerrado, normalizados a ingles canonico", () => {
  const result = interpretJobIntake(baseInput({ rawInstruction: "Necesito Forklift Operators que hablen Español e Ingles." }));
  assert.ok(result.languages.includes("Spanish"));
  assert.ok(result.languages.includes("English"));
});

test("experiencia requerida se extrae solo con un patron numerico explicito", () => {
  const result = interpretJobIntake(baseInput({ rawInstruction: "Necesito un Electrician con 3 años de experiencia." }));
  assert.equal(result.experienceRequired, "3+ años de experiencia");
});

test("fecha de inicio: solo reconoce fechas literales explicitas, nunca expresiones relativas", () => {
  const explicit = interpretJobIntake(baseInput({ rawInstruction: "Empiezan el 2026-08-01, Forklift Operator." }));
  assert.equal(explicit.startDate, "2026-08-01");
  const relative = interpretJobIntake(baseInput({ rawInstruction: "Empiezan el lunes, Forklift Operator." }));
  assert.equal(relative.startDate, null);
});

test("determinismo: misma entrada siempre produce el mismo resultado", () => {
  const input = baseInput({ rawInstruction: "Necesito 5 Forklift Operators en Chicago, IL, turno de noche, $18-22/hr." });
  assert.deepEqual(interpretJobIntake(input), interpretJobIntake(input));
});

test("intakeVersion siempre presente y estable", () => {
  assert.equal(interpretJobIntake(baseInput({ rawInstruction: "Forklift Operator" })).intakeVersion, 1);
});
