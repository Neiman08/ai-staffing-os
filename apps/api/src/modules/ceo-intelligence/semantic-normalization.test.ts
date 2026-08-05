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

// ============================================================
// F34 (auditoría arquitectónica transversal, hallazgo real
// MIS-20260805-0002, 2026-08-05): "property maintenance"/"apartment
// maintenance"/"facility maintenance"/"building maintenance" -- 4 tipos
// de empresa pedidos explícitamente en una misión real -- se
// clasificaban como "role" (¡falso positivo!) solo porque "Maintenance"
// (jobTitle suelto de Hospitality en taxonomy.ts, pensado para hiring
// signals, nunca para exclusión de tipos de empresa) aparecía como
// SUBSTRING de cada término bajo la comparación bidireccional anterior.
// Esto vació literalCompanyTypeTerms/searchTerms/plannedSteps por
// completo -- la misión nunca ejecutó discover_companies y
// select_target_companies reutilizó en silencio 20 empresas de
// industrias ajenas. Fix: un candidato multi-palabra solo se clasifica
// como rol/objeto/acción/capacidad si TODAS sus palabras pertenecen al
// conjunto de palabras de UN MISMO término conocido (composición
// completa) -- nunca por compartir una sola palabra con un término más
// corto. Estos tests fallan sin el fix y pasan con él.
// ============================================================
test("regresión CRÍTICA MIS-20260805-0002: un tipo de empresa que agrega una palabra propia a un puesto conocido NUNCA se clasifica como rol", () => {
  for (const term of ["property maintenance", "apartment maintenance", "facility maintenance", "building maintenance"]) {
    assert.equal(
      classifyNonIndustryTerm(term),
      null,
      `"${term}" es un tipo de empresa real (contiene "maintenance", un jobTitle suelto de Hospitality, pero agrega una palabra propia real) -- nunca debería clasificarse como rol`,
    );
    assert.ok(!isKnownNonIndustryTerm(term), `"${term}" no debería marcarse como término no-industria conocido`);
  }
});

test("F34: un candidato SÍ se clasifica como rol cuando está compuesto ÍNTEGRAMENTE por las palabras de un jobTitle real de la taxonomía (ninguna palabra nueva agregada al vocabulario)", () => {
  // "Quality Control Inspector" es un jobTitle real de manufacturing en
  // taxonomy.ts -- "Quality Inspectors" (mismo concepto, sin "Control",
  // pluralizado) debe seguir clasificándose como rol: ninguna de sus
  // palabras ("quality", "inspector") es ajena al jobTitle conocido.
  assert.equal(classifyNonIndustryTerm("Quality Inspectors"), "role");
  assert.equal(classifyNonIndustryTerm("Quality Inspector"), "role");
});

test("F34: dos términos conocidos DISTINTOS nunca se combinan para cubrir un tercer término real no relacionado", () => {
  // "Office Manager" (EXTRA_ROLE_TERMS) y "Maintenance" (jobTitle) son
  // dos entradas conocidas DISTINTAS -- "Office Maintenance" nunca debe
  // clasificarse como rol solo porque cada una de sus palabras aparece
  // en ALGÚN término conocido distinto (unión ilegítima entre términos).
  assert.equal(classifyNonIndustryTerm("Office Maintenance"), null);
});
