import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCitiesAndStates } from "./geo";

/**
 * F28 (restricción geográfica estricta, hallazgo real -- misiones
 * roofing/landscaping, 2026-07-27): "en Illinois" nunca debe producir
 * más que IL por sí solo. La expansión regional exige una autorización
 * explícita real en el texto ("estados vecinos"/"neighboring states",
 * "Midwest") -- nunca automática solo porque el estado pedido tiene
 * vecinos soportados.
 */

test("'en Illinois' produce ÚNICAMENTE IL -- nunca expande a estados vecinos por su cuenta", () => {
  const { states } = detectCitiesAndStates("Busca 25 empresas de roofing en Illinois.");
  assert.deepEqual(states, ["IL"]);
});

test("'en Iowa' produce ÚNICAMENTE IA -- mismo criterio, otro estado", () => {
  const { states } = detectCitiesAndStates("Busca empresas de landscaping en Iowa.");
  assert.deepEqual(states, ["IA"]);
});

test("'Illinois y estados vecinos' SÍ expande, usando la adyacencia geográfica real", () => {
  const { states } = detectCitiesAndStates("Busca empresas de roofing en Illinois y estados vecinos.");
  assert.ok(states.includes("IL"));
  assert.ok(states.includes("IN"));
  assert.ok(states.includes("WI"));
  assert.ok(states.includes("IA"));
  assert.ok(states.includes("MO"));
});

test("'Illinois and neighboring states' (inglés) también expande", () => {
  const { states } = detectCitiesAndStates("Find roofing companies in Illinois and neighboring states.");
  assert.ok(states.includes("IL"));
  assert.ok(states.includes("IN"));
});

test("'Midwest' expande a los 8 estados reales soportados de la región -- nunca Texas, que no es Midwest", () => {
  const { states } = detectCitiesAndStates("Busca empresas de roofing en el Midwest.");
  for (const expected of ["IL", "IN", "IA", "NE", "WI", "MI", "OH", "MO"]) {
    assert.ok(states.includes(expected), `Midwest debía incluir ${expected}`);
  }
  assert.ok(!states.includes("TX"), "Texas no es Midwest, nunca debe expandirse ahí");
});

test("'estados vecinos' sin ningún estado base detectado en el texto no inventa ninguno", () => {
  const { states } = detectCitiesAndStates("Busca empresas de roofing en estados vecinos.");
  assert.deepEqual(states, []);
});

test("sin ninguna mención geográfica, states queda vacío -- nunca un default inventado", () => {
  const { states } = detectCitiesAndStates("Busca empresas de roofing.");
  assert.deepEqual(states, []);
});

test("una ciudad conocida infiere su estado sin mencionar el estado explícitamente (comportamiento preexistente, sin expansión)", () => {
  const { states, cities } = detectCitiesAndStates("Busca empresas de roofing en Chicago.");
  assert.deepEqual(states, ["IL"]);
  assert.deepEqual(cities, ["Chicago"]);
});
