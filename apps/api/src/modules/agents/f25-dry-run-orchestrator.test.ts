import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryTaskStore,
  InMemoryEventBus,
  DryRunOrchestrator,
  agentSuccess,
  agentFailure,
  AgentError,
  buildEventEnvelope,
  buildIdempotencyKey,
  type DryRunTask,
  type DryRunHandler,
} from "@ai-staffing-os/agents";

/**
 * F25 Fase H: prototipo dry-run del Orchestrator -- workflow simulado
 * completo, 100% en memoria, cero llamadas a proveedores/DB/LLM
 * reales. Demuestra el requisito explícito de la instrucción maestra:
 * aceptar una misión sintética, producir un plan, crear tareas
 * sintéticas, ejecutar handlers mock, emitir eventos, manejar una
 * falla reintentable, manejar una tarea bloqueada, completar un
 * workflow simulado.
 */

const MISSION_ID = "mission_synthetic_001";

test("workflow simulado completo: discover -> score (con 1 falla reintentable) -> outreach (bloqueado por política) -- nunca envía nada", async () => {
  const store = new InMemoryTaskStore();
  const bus = new InMemoryEventBus();

  // ---- Handlers mock -- nunca tocan una API/DB/LLM real ----

  const discoverHandler: DryRunHandler = async (task) => {
    const event = buildEventEnvelope({
      eventType: "company.discovered.v1",
      tenantId: "tenant-synthetic",
      correlationId: task.correlationId,
      // La tarea raíz no fue causada por ningún evento previo -- null es correcto acá.
      causationId: task.causationId,
      actorType: "AGENT",
      actorId: "agentinstance_discovery_synthetic",
      entityType: "company",
      entityId: "company_synthetic_001",
      payload: { companyId: "company_synthetic_001", origin: "API_PROVIDER" },
      idempotencyKey: buildIdempotencyKey(task.correlationId, "company.discovered.v1", "company_synthetic_001"),
    });
    return agentSuccess({ companyId: "company_synthetic_001" }, [event]);
  };

  // Simula un proveedor real fallando la primera vez (RETRYABLE_PROVIDER)
  // y funcionando la segunda -- exactamente el caso real de PDL/Hunter
  // devolviendo 429 y luego funcionando, ya observado en producción hoy.
  let scoreAttempts = 0;
  const scoreHandler: DryRunHandler = async (task) => {
    scoreAttempts += 1;
    if (task.attempt === 0) {
      return agentFailure(new AgentError("RETRYABLE_PROVIDER", "503 Service Unavailable (proveedor sintético)"));
    }
    const event = buildEventEnvelope({
      eventType: "company.qualified.v1",
      tenantId: "tenant-synthetic",
      correlationId: task.correlationId,
      // Encadena al evento company.discovered.v1 que causó la creación de ESTA tarea (ver bus.subscribe abajo).
      causationId: task.causationId,
      actorType: "AGENT",
      actorId: "agentinstance_qualification_synthetic",
      entityType: "company",
      entityId: "company_synthetic_001",
      payload: { companyId: "company_synthetic_001", score: 72, recommendation: "PURSUE" },
      idempotencyKey: buildIdempotencyKey(task.correlationId, "company.qualified.v1", "company_synthetic_001"),
    });
    return agentSuccess({ score: 72 }, [event]);
  };

  // Simula el Quality/Policy gate bloqueando -- nunca debe llegar a
  // "enviar" nada, ni siquiera en este prototipo 100% sintético.
  const outreachHandler: DryRunHandler = async () => {
    return agentFailure(new AgentError("POLICY_BLOCKED", "PolicyEnvelope.prohibitedActions incluye SEND_EMAIL -- bloqueado antes de redactar"));
  };

  const handlers = new Map<string, DryRunHandler>([
    ["discover_companies", discoverHandler],
    ["score_company", scoreHandler],
    ["draft_outreach", outreachHandler],
  ]);

  const orchestrator = new DryRunOrchestrator(store, bus, handlers, () => 1 /* backoff casi nulo -- test, no producción */);

  // ---- Reacción a eventos: el bus encadena la siguiente tarea, nunca el handler anterior directamente ----
  bus.subscribe("company.discovered.v1", (event) => {
    store.create({
      type: "score_company",
      stage: "QUALIFICATION",
      input: event.payload,
      correlationId: event.correlationId,
      causationId: event.eventId,
      parentTaskId: null,
    });
  });
  bus.subscribe("company.qualified.v1", (event) => {
    store.create({
      type: "draft_outreach",
      stage: "OUTREACH_DRAFTING",
      input: event.payload,
      correlationId: event.correlationId,
      causationId: event.eventId,
      parentTaskId: null,
    });
  });

  // ---- Misión sintética: 1 sola tarea raíz ----
  const rootTask = store.create({
    type: "discover_companies",
    stage: "DISCOVERY",
    input: { objective: "Busca 1 empresa sintética de prueba" },
    correlationId: MISSION_ID,
    causationId: null,
    parentTaskId: null,
  });
  assert.equal(rootTask.status, "QUEUED");

  await orchestrator.runUntilIdle({ maxTicks: 100, tickDelayMs: 2 });

  // ---- Verificaciones del workflow completo ----
  const allTasks = store.all();
  assert.equal(allTasks.length, 3, "discover_companies + score_company + draft_outreach");

  const discover = allTasks.find((t) => t.type === "discover_companies")!;
  assert.equal(discover.status, "COMPLETED");

  const score = allTasks.find((t) => t.type === "score_company")!;
  assert.equal(score.status, "COMPLETED");
  assert.equal(score.attempt, 1, "debe haber reintentado exactamente una vez");
  assert.equal(scoreAttempts, 2, "el handler debe haberse invocado 2 veces (falla + éxito)");
  assert.equal(score.lastErrorCategory, "RETRYABLE_PROVIDER", "conserva la categoría del último error aunque terminó bien");

  const outreach = allTasks.find((t) => t.type === "draft_outreach")!;
  assert.equal(outreach.status, "BLOCKED", "nunca debe completarse ni reintentar -- POLICY_BLOCKED no es retryable");
  assert.equal(outreach.attempt, 0, "un bloqueo de política nunca reintenta");

  // ---- Trazabilidad: correlationId igual en las 3, causationId encadena ----
  assert.ok(allTasks.every((t) => t.correlationId === MISSION_ID));

  const published = bus.getPublished();
  assert.equal(published.length, 2, "company.discovered.v1 + company.qualified.v1 -- nunca un evento de outreach.sent, nada se envió");
  assert.equal(published[0]!.eventType, "company.discovered.v1");
  assert.equal(published[0]!.causationId, null, "el evento raíz de la misión no tiene causa previa");
  assert.equal(published[1]!.eventType, "company.qualified.v1");
  assert.equal(
    published[1]!.causationId,
    published[0]!.eventId,
    "trazabilidad real: company.qualified.v1 encadena exactamente al eventId de company.discovered.v1 que causó la tarea score_company",
  );

  // Nunca ningún evento de envío real -- la garantía estructural más importante del prototipo.
  assert.ok(!published.some((e) => e.eventType.startsWith("outreach.sent") || e.eventType.startsWith("outreach.approved")));
});

test("una tarea sin handler registrado termina FAILED_FINAL, nunca queda RUNNING para siempre", async () => {
  const store = new InMemoryTaskStore();
  const bus = new InMemoryEventBus();
  const orchestrator = new DryRunOrchestrator(store, bus, new Map());

  const task = store.create({ type: "tipo_inexistente", stage: "DISCOVERY", input: {}, correlationId: "mission_x", causationId: null, parentTaskId: null });
  await orchestrator.runTask(task);

  const updated = store.get(task.id)!;
  assert.equal(updated.status, "FAILED_FINAL");
  assert.notEqual(updated.status, "RUNNING");
});

test("una tarea retryable agota maxAttempts y termina FAILED_FINAL, nunca reintenta infinito", async () => {
  const store = new InMemoryTaskStore();
  const bus = new InMemoryEventBus();
  const alwaysFails: DryRunHandler = async () => agentFailure(new AgentError("RETRYABLE_NETWORK", "ECONNRESET sintético"));
  const orchestrator = new DryRunOrchestrator(store, bus, new Map([["flaky_task", alwaysFails]]), () => 1);

  const task = store.create({ type: "flaky_task", stage: "DISCOVERY", input: {}, correlationId: "mission_y", causationId: null, parentTaskId: null, maxAttempts: 3 });
  await orchestrator.runUntilIdle({ maxTicks: 50, tickDelayMs: 2 });

  const updated = store.get(task.id)!;
  assert.equal(updated.status, "FAILED_FINAL");
  assert.equal(updated.attempt, 2, "attempt llega a maxAttempts-1 (2), el intento número 3 ya no se programa");
});

test("dos tareas QUEUED simultáneas nunca son reclamadas dos veces por el mismo drain -- claim marca CLAIMED de inmediato", () => {
  const store = new InMemoryTaskStore();
  store.create({ type: "a", stage: "DISCOVERY", input: {}, correlationId: "m", causationId: null, parentTaskId: null });
  store.create({ type: "b", stage: "DISCOVERY", input: {}, correlationId: "m", causationId: null, parentTaskId: null });

  const firstClaim = store.claimQueued(10);
  const secondClaim = store.claimQueued(10);

  assert.equal(firstClaim.length, 2);
  assert.equal(secondClaim.length, 0, "ya no quedan QUEUED/RETRY_SCHEDULED reclamables -- ambas están CLAIMED");
});
