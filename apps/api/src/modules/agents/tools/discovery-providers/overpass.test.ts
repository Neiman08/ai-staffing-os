import { test } from "node:test";
import assert from "node:assert/strict";
import { searchOverpass } from "./overpass";

/**
 * F31 (hallazgo real, MIS-20260730-0007, 2026-07-30): una misión real de
 * "Landscaping & Lawn Care" con Google Places omitido (presupuesto
 * agotado) terminó en NO_RESULTS en <1s, $0.0000, 4 queries con
 * error=null/provider=null -- indistinguible de "se intentó Overpass de
 * verdad y no encontró nada". Causa raíz real: OVERPASS_PATTERNS solo
 * tenía 3 industrias (Manufacturing/Warehouse-Logistics/Construction) --
 * "Landscaping & Lawn Care" no estaba, así que el loop de searchOverpass
 * nunca corría ni un solo fetch real, mientras
 * mission-planner.ts:buildFallbackStrategy declaraba Overpass como
 * respaldo real para CUALQUIER misión con discover_companies, sin saber
 * qué industrias tienen cobertura real acá -- el plan anunciaba un
 * fallback que el ejecutor nunca intentaba.
 *
 * Este archivo no tenía ninguna prueba directa antes (mission-executor.test.ts
 * siempre inyecta un DiscoveryProviderPort fake, nunca ejercita
 * searchOverpass real) -- estas pruebas ejercitan la función real.
 */

test("searchOverpass: industria SIN patrones OSM soportados -- nunca intenta un fetch real, reporta honestamente por qué (nunca silencio)", async () => {
  const result = await searchOverpass({
    taskId: "f31-test-no-pattern",
    industryName: "Hospitality", // sigue sin cobertura real hoy
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

test("searchOverpass: 'Landscaping & Lawn Care' (caso real MIS-20260730-0007) ahora SÍ tiene un patrón OSM real -- intenta un fetch de verdad contra Overpass (llamada real)", async () => {
  const result = await searchOverpass({
    taskId: "f31-test-landscaping",
    industryName: "Landscaping & Lawn Care",
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
    "Landscaping & Lawn Care ya tiene un patrón real (craft=gardener) -- nunca debe caer en el camino de 'sin patrones'",
  );
  assert.ok(
    result.candidates.length > 0 || result.patternsFailed.some((f) => f.includes("craft=gardener")),
    "debe haber evidencia real de un intento -- candidatos reales, o un patternsFailed que prueba que el patrón craft=gardener se intentó de verdad (nunca silencio total)",
  );
});
