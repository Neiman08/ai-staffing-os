import { test } from "node:test";
import assert from "node:assert/strict";
import { computePipelineFlags, PIPELINE_FLAGS, type PipelineFlagSource } from "./pipeline-flags";

/**
 * F25.2 (activación controlada): externalActionsEnabled/
 * autonomousSendingEnabled deben quedar en `false` sin importar qué
 * traiga la fuente -- son la restricción absoluta de esta sesión.
 */

function allOn(): PipelineFlagSource {
  return {
    PIPELINE_KILL_SWITCH: false,
    AUTONOMOUS_WORKER_ENABLED: true,
    MISSION_TASK_PRODUCTION_ENABLED: true,
    DISCOVERY_AGENT_ENABLED: true,
    CONTACT_INTELLIGENCE_AGENT_ENABLED: true,
    QUALITY_AGENT_ENABLED: true,
    EVENT_HANDLERS_ENABLED: true,
    DRAFT_AGENT_ENABLED: true,
  };
}

test("externalActionsEnabled y autonomousSendingEnabled son SIEMPRE false, incluso con todo lo demás en true", () => {
  const flags = computePipelineFlags(allOn());
  assert.equal(flags.externalActionsEnabled, false);
  assert.equal(flags.autonomousSendingEnabled, false);
});

test("PIPELINE_KILL_SWITCH=true apaga todos los flags graduales de una sola vez", () => {
  const flags = computePipelineFlags({ ...allOn(), PIPELINE_KILL_SWITCH: true });
  assert.equal(flags.autonomousWorkerEnabled, false);
  assert.equal(flags.missionTaskProductionEnabled, false);
  assert.equal(flags.discoveryAgentEnabled, false);
  assert.equal(flags.contactIntelligenceAgentEnabled, false);
  assert.equal(flags.qualityAgentEnabled, false);
  assert.equal(flags.eventHandlersEnabled, false);
  assert.equal(flags.draftAgentEnabled, false);
});

test("cada flag gradual respeta su propia fuente cuando el kill switch está apagado", () => {
  const flags = computePipelineFlags({ ...allOn(), MISSION_TASK_PRODUCTION_ENABLED: false });
  assert.equal(flags.missionTaskProductionEnabled, false);
  assert.equal(flags.discoveryAgentEnabled, true, "los demás flags no se ven afectados por uno apagado");
});

test("PIPELINE_FLAGS (singleton real, derivado de env) nunca habilita acciones externas", () => {
  assert.equal(PIPELINE_FLAGS.externalActionsEnabled, false);
  assert.equal(PIPELINE_FLAGS.autonomousSendingEnabled, false);
});
