import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCriticalInfrastructureClients, detectClientOwnerMatch } from "./critical-infrastructure-clients";

test("detecta QTS, Meta, Google, Microsoft, Amazon AWS y Compass Datacenters en una instrucción real", () => {
  const result = detectCriticalInfrastructureClients(
    "Prioriza empresas relacionadas con QTS, Meta, Google, Microsoft, Amazon AWS, Compass Datacenters en Texas.",
  );
  assert.deepEqual(result, ["QTS", "Meta", "Google", "Microsoft", "Amazon Web Services", "Compass Datacenters"]);
});

test("normaliza acentos/mayúsculas igual que el resto del intérprete", () => {
  const result = detectCriticalInfrastructureClients("PROYECTOS DE qts Y compass datacenters");
  assert.deepEqual(result, ["QTS", "Compass Datacenters"]);
});

test("un alias corto ambiguo (Switch/Vantage/Aligned solos) nunca dispara falso positivo", () => {
  const result = detectCriticalInfrastructureClients("Necesitamos aligned schedules y hacer switch de proveedor con vantage point");
  assert.deepEqual(result, []);
});

test("la marca completa de un alias ambiguo sí se reconoce", () => {
  const result = detectCriticalInfrastructureClients("contratistas para Vantage Data Centers y Switch Data Centers");
  assert.deepEqual(result, ["Vantage Data Centers", "Switch Data Centers"]);
});

test("sin ninguna mención, devuelve arreglo vacío -- nunca inventa un cliente", () => {
  const result = detectCriticalInfrastructureClients("Busca 15 contratistas eléctricos reales en Texas");
  assert.deepEqual(result, []);
});

test("nunca duplica el mismo cliente si aparece más de una vez", () => {
  const result = detectCriticalInfrastructureClients("QTS y otra vez QTS Data Centers en el mismo texto");
  assert.deepEqual(result, ["QTS"]);
});

// ---------- F16 debt fix: resolución contextual de alias cortos ambiguos ----------

test("con contexto real de infraestructura crítica/data centers, los 5 alias cortos ambiguos (Compass/Vantage/STACK/Aligned/Switch) SÍ resuelven -- caso real reportado por el PO", () => {
  const result = detectCriticalInfrastructureClients(
    "Busca contratistas eléctricos reales que trabajen en infraestructura crítica y proyectos de data centers en Texas. Prioriza empresas relacionadas con QTS, Meta, Google, Microsoft, Amazon AWS, Compass, Digital Realty, Equinix, CyrusOne, Vantage, STACK, Aligned, NTT, Switch, Iron Mountain.",
  );
  assert.deepEqual(result, [
    "QTS",
    "Meta",
    "Google",
    "Microsoft",
    "Amazon Web Services",
    "Compass Datacenters",
    "Digital Realty",
    "Equinix",
    "CyrusOne",
    "NTT Global Data Centers",
    "Vantage Data Centers",
    "Aligned Data Centers",
    "Switch Data Centers",
    "STACK Infrastructure",
    "Iron Mountain Data Centers",
  ]);
});

test("sin contexto de infraestructura crítica/data centers, los mismos alias cortos siguen sin resolver -- nunca un falso positivo por defecto", () => {
  const result = detectCriticalInfrastructureClients("Busca contratistas eléctricos reales en Texas. Prioriza Compass, Vantage, STACK, Aligned, Switch.");
  assert.deepEqual(result, []);
});

test("el contexto puede venir de cualquiera de las frases cerradas (colocation, hyperscale, mission critical, critical facilities)", () => {
  assert.deepEqual(detectCriticalInfrastructureClients("contratistas para proyectos de colocation con Vantage"), ["Vantage Data Centers"]);
  assert.deepEqual(detectCriticalInfrastructureClients("proyectos hyperscale con STACK"), ["STACK Infrastructure"]);
  assert.deepEqual(detectCriticalInfrastructureClients("mission critical facilities con Switch"), ["Switch Data Centers"]);
});

test("detectClientOwnerMatch (clasificación de candidatos) NUNCA usa alias cortos contextuales -- un candidato real llamado 'Switch Electric LLC' no debe clasificarse como CLIENT_OWNER solo por la palabra 'switch'", () => {
  assert.deepEqual(detectClientOwnerMatch("Switch Electric LLC"), []);
  assert.deepEqual(detectClientOwnerMatch("Switch Data Centers Reno"), ["Switch Data Centers"]);
});
