import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCriticalInfrastructureClients } from "./critical-infrastructure-clients";

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
