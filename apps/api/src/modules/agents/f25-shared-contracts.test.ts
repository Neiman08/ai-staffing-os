import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_STAGES,
  isAgentStage,
  AGENT_TASK_EXECUTION_STATUSES,
  toPrismaAgentTaskStatus,
  AGENT_CAPABILITIES,
  isAgentCapability,
  HIGH_RISK_CAPABILITIES,
  policyEnvelopeSchema,
  DEFAULT_POLICY_ENVELOPE,
  agentEventEnvelopeSchema,
  buildEventEnvelope,
  allow,
  deny,
  AGENT_ERROR_CATEGORIES,
  isRetryableCategory,
  classifyError,
  computeBackoffMs,
  AgentError,
  buildIdempotencyKey,
  rootCorrelationId,
  deriveCorrelationId,
  hasCapability,
} from "@ai-staffing-os/agents";

/**
 * F25 Fase 1: pruebas de los fundamentos compartidos de la
 * organización autónoma -- puros, sin DB/red, mismo criterio que el
 * resto de ceo-intelligence/ ya establece en este repo.
 */

// ---------- AgentStage ----------

test("AGENT_STAGES tiene exactamente las 18 etapas pedidas por la instrucción maestra, sin duplicados", () => {
  assert.equal(AGENT_STAGES.length, 18);
  assert.equal(new Set(AGENT_STAGES).size, 18);
});

test("isAgentStage distingue etapas válidas de inválidas", () => {
  assert.equal(isAgentStage("DISCOVERY"), true);
  assert.equal(isAgentStage("NOT_A_STAGE"), false);
});

// ---------- AgentTaskExecutionStatus ----------

test("toPrismaAgentTaskStatus cubre los 11 estados nuevos sin lanzar", () => {
  for (const status of AGENT_TASK_EXECUTION_STATUSES) {
    const mapped = toPrismaAgentTaskStatus(status);
    assert.ok(["QUEUED", "RUNNING", "AWAITING_APPROVAL", "DONE", "FAILED"].includes(mapped), `${status} -> ${mapped} debe ser un valor real de AgentTaskStatus`);
  }
});

test("el mapeo preserva el significado ya establecido hoy: COMPLETED->DONE, QUEUED->QUEUED, HUMAN_REVIEW->AWAITING_APPROVAL", () => {
  assert.equal(toPrismaAgentTaskStatus("COMPLETED"), "DONE");
  assert.equal(toPrismaAgentTaskStatus("QUEUED"), "QUEUED");
  assert.equal(toPrismaAgentTaskStatus("HUMAN_REVIEW"), "AWAITING_APPROVAL");
  assert.equal(toPrismaAgentTaskStatus("FAILED_RETRYABLE"), "FAILED");
  assert.equal(toPrismaAgentTaskStatus("FAILED_FINAL"), "FAILED");
});

// ---------- AgentCapability ----------

test("isAgentCapability distingue capacidades válidas de inválidas", () => {
  assert.equal(isAgentCapability("SEND_EMAIL"), true);
  assert.equal(isAgentCapability("DELETE_EVERYTHING"), false);
});

test("SEND_EMAIL y BOOK_MEETING son las únicas HIGH_RISK_CAPABILITIES", () => {
  assert.deepEqual([...HIGH_RISK_CAPABILITIES].sort(), ["BOOK_MEETING", "SEND_EMAIL"]);
  for (const cap of HIGH_RISK_CAPABILITIES) {
    assert.ok((AGENT_CAPABILITIES as readonly string[]).includes(cap));
  }
});

// ---------- PolicyEnvelope ----------

test("DEFAULT_POLICY_ENVELOPE es válido contra su propio schema", () => {
  const result = policyEnvelopeSchema.safeParse(DEFAULT_POLICY_ENVELOPE);
  assert.equal(result.success, true);
});

test("DEFAULT_POLICY_ENVELOPE prohíbe explícitamente SEND_EMAIL y BOOK_MEETING -- coincide con el comportamiento real del sistema hoy", () => {
  assert.ok(DEFAULT_POLICY_ENVELOPE.prohibitedActions.includes("SEND_EMAIL"));
  assert.ok(DEFAULT_POLICY_ENVELOPE.prohibitedActions.includes("BOOK_MEETING"));
  assert.equal(DEFAULT_POLICY_ENVELOPE.autonomyLevel, 1);
  assert.equal(DEFAULT_POLICY_ENVELOPE.humanApprovalRequirement, "ALWAYS");
});

test("policyEnvelopeSchema rechaza un autonomyLevel fuera de 0-5", () => {
  const result = policyEnvelopeSchema.safeParse({ ...DEFAULT_POLICY_ENVELOPE, autonomyLevel: 6 });
  assert.equal(result.success, false);
});

test("policyEnvelopeSchema rechaza un approvedSenderIdentity con email inválido", () => {
  const result = policyEnvelopeSchema.safeParse({
    ...DEFAULT_POLICY_ENVELOPE,
    approvedSenderIdentity: { name: "DreiStaff", email: "not-an-email" },
  });
  assert.equal(result.success, false);
});

// ---------- AgentEventEnvelope ----------

test("agentEventEnvelopeSchema acepta un eventType versionado válido y rechaza uno sin versión", () => {
  const base = {
    eventId: "evt_1",
    tenantId: "tenant-titan",
    correlationId: "mission_1",
    causationId: null,
    actorType: "AGENT" as const,
    actorId: "agentinstance_1",
    entityType: "company",
    entityId: "company_1",
    occurredAt: new Date().toISOString(),
    payload: { foo: "bar" },
    metadata: {},
    idempotencyKey: "key_1",
  };
  assert.equal(agentEventEnvelopeSchema.safeParse({ ...base, eventType: "company.discovered.v1" }).success, true);
  assert.equal(agentEventEnvelopeSchema.safeParse({ ...base, eventType: "company.discovered" }).success, false, "sin .vN debe rechazarse");
  assert.equal(agentEventEnvelopeSchema.safeParse({ ...base, eventType: "CompanyDiscovered.v1" }).success, false, "mayúsculas deben rechazarse");
});

test("buildEventEnvelope completa eventId/occurredAt y produce un sobre válido", () => {
  const envelope = buildEventEnvelope({
    eventType: "company.discovered.v1",
    tenantId: "tenant-titan",
    correlationId: "mission_1",
    causationId: null,
    actorType: "AGENT",
    actorId: "agentinstance_1",
    entityType: "company",
    entityId: "company_1",
    payload: { companyId: "company_1" },
    idempotencyKey: "mission_1:company.discovered.v1:company_1",
  });
  assert.ok(envelope.eventId.startsWith("evt_"));
  assert.ok(envelope.occurredAt);
  const result = agentEventEnvelopeSchema.safeParse(envelope);
  assert.equal(result.success, true);
});

// ---------- AgentDecisionResult ----------

test("allow() produce allowed=true con reasons vacío", () => {
  const r = allow({ x: 1 });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.metadata, { x: 1 });
});

test("deny() acepta una razón sola o un array, siempre normaliza a array", () => {
  const r1 = deny("motivo único", {});
  assert.deepEqual(r1.reasons, ["motivo único"]);
  const r2 = deny(["a", "b"], {});
  assert.deepEqual(r2.reasons, ["a", "b"]);
  assert.equal(r1.allowed, false);
});

// ---------- AgentError / classifyError / backoff ----------

test("classifyError reconoce patrones de red/timeout/rate-limit/proveedor/auth/presupuesto", () => {
  assert.equal(classifyError(new Error("ECONNRESET")), "RETRYABLE_NETWORK");
  assert.equal(classifyError(new Error("Request timed out")), "RETRYABLE_TIMEOUT");
  assert.equal(classifyError(new Error("429 Too Many Requests")), "RETRYABLE_RATE_LIMIT");
  assert.equal(classifyError(new Error("503 Service Unavailable")), "RETRYABLE_PROVIDER");
  assert.equal(classifyError(new Error("401 Unauthorized")), "PERMANENT_PROVIDER_ERROR");
  assert.equal(classifyError(new Error("Presupuesto mensual de IA excedido")), "POLICY_BLOCKED");
  assert.equal(classifyError(new Error("algo totalmente inesperado")), "UNKNOWN");
});

test("classifyError respeta la categoría ya explícita de un AgentError, sin reinterpretar el mensaje", () => {
  const err = new AgentError("DATA_INSUFFICIENT", "sin evidencia suficiente");
  assert.equal(classifyError(err), "DATA_INSUFFICIENT");
});

test("isRetryableCategory distingue exactamente los 4 RETRYABLE_* del resto", () => {
  const retryable = AGENT_ERROR_CATEGORIES.filter(isRetryableCategory);
  assert.deepEqual(retryable.sort(), ["RETRYABLE_NETWORK", "RETRYABLE_PROVIDER", "RETRYABLE_RATE_LIMIT", "RETRYABLE_TIMEOUT"].sort());
});

test("computeBackoffMs crece con el intento y nunca excede el tope máximo", () => {
  const attempt0 = computeBackoffMs({ attempt: 0, baseMs: 1000, jitterMs: 0, maxMs: 60_000 });
  const attempt3 = computeBackoffMs({ attempt: 3, baseMs: 1000, jitterMs: 0, maxMs: 60_000 });
  assert.ok(attempt3 > attempt0, "más intentos debe dar más espera");
  const attemptHuge = computeBackoffMs({ attempt: 30, baseMs: 1000, jitterMs: 0, maxMs: 60_000 });
  assert.ok(attemptHuge <= 60_000, "nunca debe exceder maxMs");
});

// ---------- idempotency / correlation ----------

test("buildIdempotencyKey concatena las partes con ':' y rechaza partes vacías o con ':' dentro", () => {
  assert.equal(buildIdempotencyKey("mission_1", "company.discovered.v1", "company_1"), "mission_1:company.discovered.v1:company_1");
  assert.throws(() => buildIdempotencyKey());
  assert.throws(() => buildIdempotencyKey("a", ""));
  assert.throws(() => buildIdempotencyKey("a:b", "c"));
});

test("rootCorrelationId/deriveCorrelationId son la identidad -- el correlationId nunca se transforma", () => {
  assert.equal(rootCorrelationId("mission_1"), "mission_1");
  assert.equal(deriveCorrelationId("mission_1"), "mission_1");
  assert.equal(deriveCorrelationId(rootCorrelationId("mission_1")), "mission_1");
});

// ---------- capability-check ----------

test("hasCapability permite cuando está declarada y no está prohibida", () => {
  const r = hasCapability(["DISCOVER_COMPANY", "READ_COMPANY"], DEFAULT_POLICY_ENVELOPE, "DISCOVER_COMPANY");
  assert.equal(r.allowed, true);
});

test("hasCapability rechaza cuando el agente no la declara", () => {
  const r = hasCapability(["READ_COMPANY"], DEFAULT_POLICY_ENVELOPE, "DISCOVER_COMPANY");
  assert.equal(r.allowed, false);
  assert.match(r.reasons[0]!, /no declara/);
});

test("hasCapability rechaza SEND_EMAIL incluso si el agente la declara -- el PolicyEnvelope default la prohíbe", () => {
  const r = hasCapability(["SEND_EMAIL"], DEFAULT_POLICY_ENVELOPE, "SEND_EMAIL");
  assert.equal(r.allowed, false);
  assert.match(r.reasons[0]!, /prohibida/);
});

test("hasCapability permite SEND_EMAIL solo si un PolicyEnvelope explícito la habilita (nunca por default)", () => {
  const permissive = { ...DEFAULT_POLICY_ENVELOPE, prohibitedActions: DEFAULT_POLICY_ENVELOPE.prohibitedActions.filter((a) => a !== "SEND_EMAIL") };
  const r = hasCapability(["SEND_EMAIL"], permissive, "SEND_EMAIL");
  assert.equal(r.allowed, true);
});
