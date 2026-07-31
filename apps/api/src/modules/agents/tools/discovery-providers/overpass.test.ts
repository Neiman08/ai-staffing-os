import { test } from "node:test";
import assert from "node:assert/strict";
import { searchOverpass, resolveOverpassPatterns, hasOverpassCoverage } from "./overpass";

/**
 * F31 (hallazgo real, MIS-20260730-0007, 2026-07-30): una misión real de
 * "Landscaping & Lawn Care" con Google Places omitido (presupuesto
 * agotado) terminó en NO_RESULTS en <1s, $0.0000, 4 queries con
 * error=null/provider=null -- indistinguible de "se intentó Overpass de
 * verdad y no encontró nada". Causa raíz real: no existía ningún patrón
 * OSM para esa industria.
 *
 * F32 (hallazgo real, MIS-20260731-0003, 2026-07-31): una query
 * ESPECÍFICA de "electrical contractor" (taxonomyKey="electrical")
 * resolvía Overpass EXCLUSIVAMENTE por crmIndustryBucket="Construction"
 * -- terminaba probando craft=builder/office=construction_company (los
 * patrones genéricos de construcción), nunca nada relacionado con
 * electricidad, pese a que el trade específico ya estaba identificado.
 * La resolución ahora prueba primero taxonomyKey (trade específico),
 * después crmIndustryBucket (bucket amplio) solo como respaldo.
 */

test("resolveOverpassPatterns: trade específico (taxonomyKey) tiene prioridad sobre el bucket amplio (crmIndustryBucket) -- caso real MIS-20260731-0003", () => {
  const electricalPatterns = resolveOverpassPatterns("electrical", "Construction");
  assert.ok(electricalPatterns.length > 0, "electrical debe tener su propio patrón OSM");
  assert.ok(
    electricalPatterns.some((p) => p.value === "electrician"),
    "debe resolver craft=electrician, NUNCA los patrones genéricos de Construction (craft=builder/office=construction_company)",
  );
  assert.ok(
    !electricalPatterns.some((p) => p.value === "builder" || p.value === "construction_company"),
    "nunca debe colarse un patrón genérico de Construction cuando el trade específico (electrical) sí tiene el suyo propio",
  );
});

test("resolveOverpassPatterns: sin patrón específico para el trade, cae al bucket amplio (respaldo, nunca al revés)", () => {
  // "roofing" SÍ tiene patrón propio -- pero un trade nuevo sin entrada
  // curada (simulado con una key inventada) debe caer al bucket.
  const patterns = resolveOverpassPatterns("some_new_construction_trade_without_own_pattern", "Construction");
  assert.ok(patterns.length > 0, "debe caer al patrón amplio de Construction como respaldo");
  assert.ok(patterns.some((p) => p.value === "builder" || p.value === "construction_company"));
});

test("resolveOverpassPatterns: término literal (prefijo 'literal:', ver mission-planner.ts) nunca tiene patrón -- degradación honesta, nunca un patrón inventado", () => {
  // mission-planner.ts SIEMPRE pasa crmIndustryBucket=null para una
  // query literal (nunca se inventa un bucket amplio para un término
  // desconocido) -- se prueba con ese caso real.
  assert.deepEqual(resolveOverpassPatterns("literal:HVAC", null), []);
  assert.equal(hasOverpassCoverage("literal:HVAC", null), false);
});

test("searchOverpass: industria SIN patrones OSM soportados -- nunca intenta un fetch real, reporta honestamente por qué (nunca silencio)", async () => {
  const result = await searchOverpass({
    taskId: "f31-test-no-pattern",
    industryName: "Hospitality",
    taxonomyKey: "hospitality", // sigue sin cobertura real hoy
    crmIndustryBucket: null,
    stateCode: "IL",
    stateName: "Illinois",
    limit: 5,
  });

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.sourcesUsed, []);
  assert.equal(result.costUsd, 0);
  assert.equal(result.cancelled, false);
  assert.equal(result.patternsFailed.length, 1, "debe explicar honestamente por qué, nunca silencio (candidates=[] sin motivo)");
  assert.match(result.patternsFailed[0]!, /sin patrones OSM soportados/);
  assert.match(result.patternsFailed[0]!, /Overpass nunca fue invocado/);
});

test("searchOverpass: 'landscaping' (caso real MIS-20260730-0007) tiene un patrón OSM real -- intenta un fetch de verdad contra Overpass (llamada real)", async () => {
  const result = await searchOverpass({
    taskId: "f31-test-landscaping",
    industryName: "Landscaping & Lawn Care",
    taxonomyKey: "landscaping",
    crmIndustryBucket: "Landscaping & Lawn Care",
    stateCode: "IL",
    stateName: "Illinois",
    limit: 3,
  });

  // No se afirma cuántos resultados reales devuelve Overpass hoy (la
  // instancia pública puede tener 0 negocios tageados craft=gardener en
  // Illinois en este momento, o puede fallar por fair-use throttling
  // real -- 406/429/504, ver el comentario de diseño en overpass.ts) --
  // lo que este test prueba es que YA NO se omite en silencio: intentó
  // un fetch real (candidates reales, O un patternsFailed que prueba que
  // SÍ hubo un intento real -- nunca el mensaje "sin patrones OSM
  // soportados", y nunca patternsFailed vacío sin haber encontrado
  // nada, que sería indistinguible de "nunca se intentó").
  assert.ok(
    !result.patternsFailed.some((f) => f.includes("sin patrones OSM soportados")),
    "landscaping ya tiene un patrón real (craft=gardener) -- nunca debe caer en el camino de 'sin patrones'",
  );
  assert.ok(
    result.candidates.length > 0 || result.patternsFailed.some((f) => f.includes("craft=gardener")),
    "debe haber evidencia real de un intento -- candidatos reales, o un patternsFailed que prueba que el patrón craft=gardener se intentó de verdad (nunca silencio total)",
  );
});

test("searchOverpass: 'electrical' (caso real MIS-20260731-0003) intenta craft=electrician, nunca los patrones genéricos de Construction (llamada real)", async () => {
  const result = await searchOverpass({
    taskId: "f32-test-electrical",
    industryName: "Construction",
    taxonomyKey: "electrical",
    crmIndustryBucket: "Construction",
    stateCode: "IL",
    stateName: "Illinois",
    limit: 3,
  });

  assert.ok(
    !result.patternsFailed.some((f) => f.includes("sin patrones OSM soportados")),
    "electrical ya tiene un patrón real (craft=electrician) -- nunca debe caer en el camino de 'sin patrones'",
  );
  assert.ok(
    !result.patternsFailed.some((f) => f.includes("craft=builder") || f.includes("construction_company")),
    "nunca debe intentar los patrones genéricos de Construction cuando el trade específico (electrical) tiene el suyo propio",
  );
  assert.ok(
    result.candidates.length > 0 || result.patternsFailed.some((f) => f.includes("craft=electrician")),
    "debe haber evidencia real de un intento contra craft=electrician",
  );
});
