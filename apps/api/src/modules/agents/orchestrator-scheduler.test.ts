import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProductionOrchestrator,
  buildProductionEventDispatcher,
  runAutonomousWorkerTick,
  startAutonomousWorkers,
  stopAutonomousWorkers,
} from "./orchestrator-scheduler";

/**
 * F25.2 (consolidación): el worker autónomo real -- confirma que
 * registra exactamente los 3 AgentExecutor seguros (ninguno envía
 * email/agenda reunión, ver docstring del módulo) y que un tick
 * completo corre sin lanzar incluso con la cola vacía (el caso real
 * hoy: nada encola AgentTask de estos tipos todavía).
 */

test("buildProductionOrchestrator registra exactamente los 3 AgentExecutor seguros", () => {
  const orchestrator = buildProductionOrchestrator();
  assert.equal(orchestrator.hasExecutor("discover_companies"), true);
  assert.equal(orchestrator.hasExecutor("find_contacts"), true);
  assert.equal(orchestrator.hasExecutor("evaluate_draft_quality"), true);

  // Ningún ejecutor de envío/reunión existe -- ni siquiera podría
  // registrarse por error, porque no hay ningún AgentExecutor de ese
  // tipo construido en el proyecto todavía.
  assert.equal(orchestrator.hasExecutor("send_email"), false);
  assert.equal(orchestrator.hasExecutor("book_meeting"), false);
});

test("runAutonomousWorkerTick corre las 3 sub-operaciones sin lanzar, incluso con la cola vacía", async () => {
  const orchestrator = buildProductionOrchestrator();
  const dispatcher = buildProductionEventDispatcher();

  const result = await runAutonomousWorkerTick(orchestrator, dispatcher);

  assert.equal(typeof result.orchestrator.claimed, "number");
  assert.equal(typeof result.eventDispatch.claimed, "number");
  assert.ok(Array.isArray(result.reclaimedTaskIds));
});

test("startAutonomousWorkers/stopAutonomousWorkers: idempotentes, el segundo start no duplica el timer", () => {
  startAutonomousWorkers();
  startAutonomousWorkers(); // no debe crear un segundo interval
  stopAutonomousWorkers();
  stopAutonomousWorkers(); // no debe lanzar al parar dos veces
});
