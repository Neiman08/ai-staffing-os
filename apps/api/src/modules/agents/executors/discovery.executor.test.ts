import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { DEFAULT_MISSION_RESTRICTIONS, DEFAULT_POLICY_ENVELOPE } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../../core/tenancy/context";
import type { MissionPlan } from "../../ceo-intelligence/contracts";
import { createDiscoveryExecutor } from "./discovery.executor";

/**
 * F25.2 Fase 6: prueba el WRAPPER (adaptación de forma + publicación de
 * eventos), nunca la lógica de discovery en sí -- esa ya tiene su
 * batería completa en mission-executor.test.ts. "No reescribas la
 * lógica" implica tampoco re-probarla acá.
 */

const TEST_PREFIX = "F25-2-DISCOVERY-EXEC";
const createdTenantIds: string[] = [];
const originalFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = originalFetch;
  if (createdTenantIds.length) {
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupTenant(suffix: string): Promise<{ tenantId: string; agentInstanceId: string; missionTaskId: string }> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  createdTenantIds.push(tenant.id);
  const discoveryDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "discovery" } });
  const instance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: discoveryDefinition.id, isActive: true } });
  const missionTask = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: instance.id, type: "daily_revenue_mission", input: {}, status: "RUNNING", triggeredBy: "USER" },
  });
  return { tenantId: tenant.id, agentInstanceId: instance.id, missionTaskId: missionTask.id };
}

function basePlan(overrides: Partial<MissionPlan> = {}): MissionPlan {
  return {
    schemaVersion: 1,
    objective: { type: "find_companies", targetCompanyCount: 1, rawText: "fixture" },
    searchQueries: [],
    exclusions: [],
    specificTaxonomyKeys: [],
    cities: [],
    states: ["IL"],
    steps: [],
    requiredSteps: [],
    optionalSteps: [],
    stopConditions: { maxCompanies: 1, maxCostUsd: 3, maxDurationMinutes: 60 },
    dedupStrategy: ["providerPlaceId", "canonicalDomain", "normalizedPhone", "normalizedNameCityState"],
    fallbackStrategy: [{ provider: "Google Places", whenUnavailable: "Usar Overpass." }],
    restrictions: DEFAULT_MISSION_RESTRICTIONS,
    rationale: "fixture",
    ...overrides,
  };
}

function fakeContext(tenantId: string, agentInstanceId: string) {
  return {
    tenantId,
    agentInstanceId,
    taskId: "task_test",
    triggeredBy: "AGENT" as const,
    correlationId: "mission_test",
    causationId: null,
    capabilities: [],
    policyEnvelope: DEFAULT_POLICY_ENVELOPE,
  };
}

test("createDiscoveryExecutor declara taskType/stage consistentes con el catálogo real", () => {
  const executor = createDiscoveryExecutor();
  assert.equal(executor.taskType, "discover_companies");
  assert.equal(executor.stage, "DISCOVERY");
});

test("execute() sobre un plan sin discover_companies delega a executeDiscoveryPlan real (reporte BLOCKED inmediato, cero red) y lo envuelve en agentSuccess sin eventos", async () => {
  const { tenantId, agentInstanceId, missionTaskId } = await setupTenant("empty-plan");
  const executor = createDiscoveryExecutor();

  const result = await runWithTenancyContext({ tenantId, userId: "test", permissions: [] }, () =>
    executor.execute(fakeContext(tenantId, agentInstanceId), {
      missionTaskId,
      plan: basePlan({ steps: [] }),
      restrictions: DEFAULT_MISSION_RESTRICTIONS,
    }),
  );

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.stopReason, "El plan no declara ningún paso/query de descubrimiento de empresas.");
  assert.equal(result.output.companiesCreated, 0);
  assert.deepEqual(result.events, []);
});

test("execute() convierte una falla real de executeDiscoveryPlan en un AgentResult clasificado -- nunca una excepción sin capturar", async () => {
  const { tenantId, agentInstanceId, missionTaskId } = await setupTenant("provider-error");
  const executor = createDiscoveryExecutor();
  const plan = basePlan({ steps: ["discover_companies"], requiredSteps: ["discover_companies"] });

  // Nota: los proveedores reales (google-places.ts) ya capturan sus
  // propios errores de red y los reflejan en el reporte en vez de
  // tirar -- bloquear fetch acá NO alcanza para forzar una excepción
  // real. La falla real y reproducible del wrapper es estructural:
  // executeDiscoveryPlan requiere tenancy context (getTenancyContext(),
  // igual que cualquier otro código de negocio de este proyecto) --
  // llamar execute() SIN runWithTenancyContext dispara exactamente el
  // mismo AppError.unauthorized() que dispararía en producción si el
  // Orchestrator tuviera un bug y ejecutara una tarea fuera de su
  // wrapper de tenancy.
  const result = await executor.execute(fakeContext(tenantId, agentInstanceId), {
    missionTaskId,
    plan,
    restrictions: DEFAULT_MISSION_RESTRICTIONS,
    googlePlacesApiKey: "fake-key-for-tests",
  });

  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.category, "PERMANENT_PROVIDER_ERROR");
});
