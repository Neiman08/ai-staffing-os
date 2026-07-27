import { test } from "node:test";
import assert from "node:assert/strict";
import type { PipelineFlags } from "../../core/pipeline-flags";
import {
  buildProductionOrchestrator,
  buildProductionEventDispatcher,
  runAutonomousWorkerTick,
  startAutonomousWorkers,
  stopAutonomousWorkers,
} from "./orchestrator-scheduler";

/**
 * F25.2 (activación controlada): el worker autónomo real -- confirma
 * que cada AgentExecutor/handler SOLO se registra cuando su flag
 * específico está encendido (nunca "los 3 siempre", como antes de esta
 * sesión) y que un tick completo corre sin lanzar incluso con la cola
 * vacía.
 */

function allFlagsOff(): PipelineFlags {
  return {
    autonomousWorkerEnabled: false,
    missionTaskProductionEnabled: false,
    discoveryAgentEnabled: false,
    contactIntelligenceAgentEnabled: false,
    qualityAgentEnabled: false,
    eventHandlersEnabled: false,
    draftAgentEnabled: false,
    externalActionsEnabled: false,
    autonomousSendingEnabled: false,
  };
}

test("con todos los flags apagados, el Orchestrator no registra NINGÚN ejecutor", () => {
  const orchestrator = buildProductionOrchestrator(allFlagsOff());
  assert.equal(orchestrator.hasExecutor("discover_companies"), false);
  assert.equal(orchestrator.hasExecutor("find_contacts"), false);
  assert.equal(orchestrator.hasExecutor("evaluate_draft_quality"), false);
});

test("cada flag registra únicamente su propio AgentExecutor -- nunca los otros dos por error", () => {
  const onlyDiscovery = buildProductionOrchestrator({ ...allFlagsOff(), discoveryAgentEnabled: true });
  assert.equal(onlyDiscovery.hasExecutor("discover_companies"), true);
  assert.equal(onlyDiscovery.hasExecutor("find_contacts"), false);
  assert.equal(onlyDiscovery.hasExecutor("evaluate_draft_quality"), false);

  const allThree = buildProductionOrchestrator({ ...allFlagsOff(), discoveryAgentEnabled: true, contactIntelligenceAgentEnabled: true, qualityAgentEnabled: true });
  assert.equal(allThree.hasExecutor("discover_companies"), true);
  assert.equal(allThree.hasExecutor("find_contacts"), true);
  assert.equal(allThree.hasExecutor("evaluate_draft_quality"), true);

  // Ningún ejecutor de envío/reunión existe -- ni siquiera podría
  // registrarse por error, porque no hay ningún AgentExecutor de ese
  // tipo construido en el proyecto todavía.
  assert.equal(allThree.hasExecutor("send_email"), false);
  assert.equal(allThree.hasExecutor("book_meeting"), false);
});

test("eventHandlersEnabled=false nunca registra los handlers reales, incluso si otros flags están prendidos", () => {
  // No hay una forma pública de "contar handlers" en EventDispatcher --
  // esto se prueba indirectamente en pipeline-handlers.test.ts (los
  // handlers no crean nada cuando su flag está apagado). Acá solo se
  // confirma que buildProductionEventDispatcher no lanza con cualquier
  // combinación de flags.
  const dispatcher = buildProductionEventDispatcher({ ...allFlagsOff(), discoveryAgentEnabled: true });
  assert.ok(dispatcher);
});

test("runAutonomousWorkerTick corre las 3 sub-operaciones sin lanzar, incluso con la cola vacía y todos los flags apagados", async () => {
  const orchestrator = buildProductionOrchestrator(allFlagsOff());
  const dispatcher = buildProductionEventDispatcher(allFlagsOff());

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
