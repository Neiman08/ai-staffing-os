import { test } from "node:test";
import assert from "node:assert/strict";
import { isKnownNonIndustryTerm, classifyNonIndustryTerm, singularizeForComparison } from "./semantic-normalization";

// F32 (auditoría arquitectónica, hallazgo real MIS-20260731-0003,
// 2026-07-31): "Owner", "Operations Manager", "HR", "Recruiting",
// "Opportunity" aparecían como unrecognizedTerms en una misión real --
// roles/objetos del CRM/acciones del pipeline NUNCA deben clasificarse
// como industrias desconocidas, sin importar cuán desconocida sea la
// industria real que sí se pidió.

test("roles de decisión (formas completas y sueltas) se clasifican como 'role', nunca como industria desconocida", () => {
  for (const term of ["Owner", "Operations Manager", "HR", "Recruiting", "HR Manager", "President", "CEO", "Hiring Manager"]) {
    assert.equal(classifyNonIndustryTerm(term), "role", `"${term}" debería clasificarse como rol`);
    assert.ok(isKnownNonIndustryTerm(term));
  }
});

test("objetos del CRM (singular y plural) se clasifican como 'crm_object'", () => {
  // "Contact"/"Company" quedan afuera a propósito -- también matchean
  // "Contact Intelligence"/"Company Enrichment" (capability), ambigüedad
  // real e inofensiva (las dos categorías excluyen igual a una industria
  // desconocida, ver la aserción de abajo para la invariante real que
  // importa).
  for (const term of ["Lead", "Leads", "Opportunity", "Opportunities", "Draft", "Drafts", "Campaign"]) {
    assert.equal(classifyNonIndustryTerm(term), "crm_object", `"${term}" debería clasificarse como objeto del CRM`);
  }
  assert.ok(isKnownNonIndustryTerm("Contact"));
  assert.ok(isKnownNonIndustryTerm("Company"));
});

test("acciones del pipeline se clasifican como 'action'", () => {
  for (const term of ["crear", "verificar", "enriquecer", "buscar", "create", "verify", "enrich", "find"]) {
    assert.equal(classifyNonIndustryTerm(term), "action", `"${term}" debería clasificarse como acción`);
  }
});

test("capacidades del producto se clasifican como 'capability'", () => {
  for (const term of ["Discovery", "Contact Intelligence", "hiring signals", "growth signals"]) {
    assert.equal(classifyNonIndustryTerm(term), "capability", `"${term}" debería clasificarse como capacidad`);
  }
});

test("un tipo de empresa real y desconocido (nunca en la taxonomía) NO se clasifica como rol/objeto/acción/capacidad", () => {
  for (const term of ["HVAC", "refrigeración comercial", "servicios mecánicos", "commercial drone repair", "acuicultura comercial"]) {
    assert.equal(classifyNonIndustryTerm(term), null, `"${term}" es un tipo de empresa real -- nunca debería clasificarse como no-industria`);
    assert.ok(!isKnownNonIndustryTerm(term));
  }
});

test("singularizeForComparison: bug real -- 'Opportunity' vs 'opportunities' (comparación de substring cruda nunca los igualaba)", () => {
  assert.equal(singularizeForComparison("Opportunity"), singularizeForComparison("opportunities"));
  assert.equal(singularizeForComparison("Lead"), singularizeForComparison("leads"));
  assert.equal(singularizeForComparison("Company"), singularizeForComparison("companies"));
});

test("cero llamadas externas: funciones puras y deterministas", () => {
  assert.equal(classifyNonIndustryTerm("HR"), classifyNonIndustryTerm("HR"));
  assert.equal(isKnownNonIndustryTerm("Owner"), true);
});
