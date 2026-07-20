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
  const result = filterActuallyUnrecognizedTerms(["industrial"], ["industrial automation company"], "Busca empresas industrial en Texas");
  assert.deepEqual(result, []);
});

test("Commercial cubierto por 'commercial electrical contractor' como externalSearchTerm", () => {
  const result = filterActuallyUnrecognizedTerms(["Commercial"], ["commercial electrical contractor"], "Busca contratistas Commercial en Texas");
  assert.deepEqual(result, []);
});

test("data centers cubierto por su propia externalSearchTerm exacta", () => {
  const result = filterActuallyUnrecognizedTerms(["data centers"], ["data centers"], "Busca empresas de data centers en Texas");
  assert.deepEqual(result, []);
});

test("infraestructura eléctrica: cubierto porque aparece como substring (normalizado, sin acentos) de una externalSearchTerm real ya generada", () => {
  const result = filterActuallyUnrecognizedTerms(
    ["infraestructura eléctrica"],
    ["contratista de infraestructura electrica"],
    "Busca contratistas de infraestructura eléctrica en Texas",
  );
  assert.deepEqual(result, []);
});

test("data centers: reconocido de forma standalone por el intérprete determinista de taxonomía (data_centers), sin necesitar externalSearchTerms", () => {
  const result = filterActuallyUnrecognizedTerms(["data centers"], [], "Busca empresas de data centers en Texas");
  assert.deepEqual(result, []);
});

test("un término genuinamente desconocido (ni cubierto por query, ni por taxonomía) SÍ queda como unrecognized", () => {
  const result = filterActuallyUnrecognizedTerms(
    ["xyzzy-nonexistent-sector-42"],
    ["manufacturing company"],
    "Busca xyzzy-nonexistent-sector-42 en Texas",
  );
  assert.deepEqual(result, ["xyzzy-nonexistent-sector-42"]);
});

test("cadena vacía nunca se reporta como unrecognized", () => {
  const result = filterActuallyUnrecognizedTerms([""], [], "Busca empresas en Texas");
  assert.deepEqual(result, []);
});

// ---------- F15: clientes de infraestructura crítica (hallazgo real) ----------
// "Prioriza empresas relacionadas con QTS, Meta, Google, Microsoft,
// Amazon AWS, Compass Datacenters" -- el sistema los reportó como
// "términos no reconocidos" pese a ser clientes reales de
// infraestructura crítica (ver critical-infrastructure-clients.ts).
// Ninguno de estos matchea business-taxonomy.ts (no son un sector) --
// por eso necesitan su propio chequeo (c), separado del de taxonomía (b).

test("QTS, Meta, Google, Microsoft, Amazon AWS y Compass Datacenters nunca quedan como unrecognized, aunque el LLM nunca los haya convertido en externalSearchTerms", () => {
  const rawInstruction = "Prioriza empresas relacionadas con QTS, Meta, Google, Microsoft, Amazon AWS, Compass Datacenters en Texas.";
  const result = filterActuallyUnrecognizedTerms(
    ["QTS", "Meta", "Google", "Microsoft", "Amazon AWS", "Compass Datacenters"],
    [], // el LLM no generó ninguna query real para ellos -- exactamente el bug reportado
    rawInstruction,
  );
  assert.deepEqual(result, []);
});

test("un cliente de infraestructura crítica mezclado con un término genuinamente desconocido -- solo el desconocido queda", () => {
  const result = filterActuallyUnrecognizedTerms(
    ["QTS", "xyzzy-nonexistent-sector-42"],
    [],
    "Prioriza empresas relacionadas con QTS y xyzzy-nonexistent-sector-42 en Texas.",
  );
  assert.deepEqual(result, ["xyzzy-nonexistent-sector-42"]);
});

// ---------- F16 debt fix: alias cortos ambiguos resueltos con el CONTEXTO COMPLETO de la instrucción ----------
// Hallazgo real del PO: "Compass, Vantage, STACK, Aligned, Switch" seguían
// apareciendo como unrecognizedTerms pese a que critical-infrastructure-
// clients.ts ya sabía resolverlos contextualmente -- el bug real estaba
// acá: este filtro evaluaba cada término aislado, sin el resto de la
// frase donde vivía el contexto ("infraestructura crítica y data
// centers").

test("F16 debt fix: Compass, Vantage, STACK, Aligned y Switch (alias cortos) NUNCA quedan como unrecognized cuando la instrucción completa menciona infraestructura crítica/data centers -- caso real reportado por el PO", () => {
  const rawInstruction =
    "Busca contratistas eléctricos reales que trabajen en infraestructura crítica y proyectos de data centers en Texas. Prioriza empresas relacionadas con QTS, Meta, Google, Microsoft, Amazon AWS, Compass, Digital Realty, Equinix, CyrusOne, Vantage, STACK, Aligned, NTT, Switch, Iron Mountain.";
  const result = filterActuallyUnrecognizedTerms(["Compass", "Vantage", "STACK", "Aligned", "Switch"], [], rawInstruction);
  assert.deepEqual(result, []);
});

test("F16 debt fix: los mismos alias cortos SÍ quedan como unrecognized sin ningún contexto de infraestructura crítica/data centers en la instrucción -- nunca un falso positivo por defecto", () => {
  const rawInstruction = "Busca contratistas eléctricos reales en Texas. Prioriza empresas relacionadas con Compass, Vantage, STACK, Aligned, Switch.";
  const result = filterActuallyUnrecognizedTerms(["Compass", "Vantage", "STACK", "Aligned", "Switch"], [], rawInstruction);
  assert.deepEqual(result, ["Compass", "Vantage", "STACK", "Aligned", "Switch"]);
});
