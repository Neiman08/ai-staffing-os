import { test } from "node:test";
import assert from "node:assert/strict";
import { filterActuallyUnrecognizedTerms } from "./ceo-tools.impl";

/**
 * F14 (escenario 9 de la validación pedida): "Industrial", "Commercial",
 * "data centers" e "infraestructura eléctrica" fueron reportados como
 * unrecognizedTerms por interpretDailyDirective (LLM) pese a que esos
 * mismos conceptos ya estaban presentes en company types/queries/señales
 * reales -- ver el comentario en ceo-tools.impl.ts sobre por qué el LLM
 * puede reportar un término como no reconocido Y generar una query real
 * para él en la misma respuesta.
 */

test("un término ya cubierto por una externalSearchTerm (substring en cualquier dirección) nunca queda como unrecognized", () => {
  const result = filterActuallyUnrecognizedTerms(["industrial"], ["industrial automation company"]);
  assert.deepEqual(result, []);
});

test("Commercial cubierto por 'commercial electrical contractor' como externalSearchTerm", () => {
  const result = filterActuallyUnrecognizedTerms(["Commercial"], ["commercial electrical contractor"]);
  assert.deepEqual(result, []);
});

test("data centers cubierto por su propia externalSearchTerm exacta", () => {
  const result = filterActuallyUnrecognizedTerms(["data centers"], ["data centers"]);
  assert.deepEqual(result, []);
});

test("infraestructura eléctrica: cubierto porque aparece como substring (normalizado, sin acentos) de una externalSearchTerm real ya generada", () => {
  const result = filterActuallyUnrecognizedTerms(["infraestructura eléctrica"], ["contratista de infraestructura electrica"]);
  assert.deepEqual(result, []);
});

test("data centers: reconocido de forma standalone por el intérprete determinista de taxonomía (data_centers), sin necesitar externalSearchTerms", () => {
  const result = filterActuallyUnrecognizedTerms(["data centers"], []);
  assert.deepEqual(result, []);
});

test("un término genuinamente desconocido (ni cubierto por query, ni por taxonomía) SÍ queda como unrecognized", () => {
  const result = filterActuallyUnrecognizedTerms(["xyzzy-nonexistent-sector-42"], ["manufacturing company"]);
  assert.deepEqual(result, ["xyzzy-nonexistent-sector-42"]);
});

test("cadena vacía nunca se reporta como unrecognized", () => {
  const result = filterActuallyUnrecognizedTerms([""], []);
  assert.deepEqual(result, []);
});
