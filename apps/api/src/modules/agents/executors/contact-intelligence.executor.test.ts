import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY_ENVELOPE } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../../core/tenancy/context";
import { createContactIntelligenceExecutor } from "./contact-intelligence.executor";

/**
 * F25.2 Fase 7: prueba el WRAPPER, nunca la lógica de enriquecimiento
 * de contactos en sí -- esa ya tiene su batería completa en
 * contact-enrichment.test.ts/contact-intelligence.test.ts.
 */

const FAKE_CONTEXT_BASE = {
  agentInstanceId: "agentinstance_test",
  taskId: "task_test",
  triggeredBy: "AGENT" as const,
  correlationId: "mission_test",
  causationId: null,
  capabilities: [],
  policyEnvelope: DEFAULT_POLICY_ENVELOPE,
};

test("createContactIntelligenceExecutor declara taskType/stage consistentes con el catálogo real", () => {
  const executor = createContactIntelligenceExecutor();
  assert.equal(executor.taskType, "find_contacts");
  assert.equal(executor.stage, "CONTACT_INTELLIGENCE");
});

test("execute() con rolePlan=null delega a enrichCompanyWithDecisionContacts real (reporte vacío inmediato, cero red) y lo envuelve en agentSuccess sin eventos", async () => {
  const executor = createContactIntelligenceExecutor();
  const tenantId = "tenant-titan";

  const result = await runWithTenancyContext({ tenantId, userId: "test", permissions: [] }, () =>
    executor.execute(
      { tenantId, ...FAKE_CONTEXT_BASE },
      {
        taskId: "task_test",
        companyId: "company_test",
        companyName: "Acme Test Co",
        companyWebsite: null,
        companyState: "IL",
        companyCity: "Chicago",
        industryName: "Manufacturing",
        rolePlan: null,
      },
    ),
  );

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.contactsCreated.length, 0);
  assert.deepEqual(result.events, []);
  assert.ok(result.output.patternsFailed.some((m) => m.includes("rolePlan sin roles planificados")));
});

test("execute() con rolePlan real y cero contactos resueltos -- falla con DATA_INSUFFICIENT, nunca inventa un contacto", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("execute() DATA_INSUFFICIENT test: intento de llamada de red real -- los proveedores deben inyectarse mockeados.");
  }) as typeof fetch;

  try {
    const executor = createContactIntelligenceExecutor();
    const tenantId = "tenant-titan";

    const result = await runWithTenancyContext({ tenantId, userId: "test", permissions: [] }, () =>
      executor.execute(
        { tenantId, ...FAKE_CONTEXT_BASE },
        {
          taskId: "task_test",
          companyId: "company_test",
          companyName: "Acme Test Co",
          companyWebsite: null,
          companyState: "IL",
          companyCity: "Chicago",
          industryName: "Manufacturing",
          rolePlan: {
            companyId: "company_test",
            targetRoles: [{ role: "HR Manager", priority: 1, rationale: "fixture", source: "taxonomy" }],
            excludedRoles: [],
            confidence: 1,
            taxonomySource: "fixture",
            hiringSignalSource: null,
            planVersion: 1,
          },
        },
      ),
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.error.category, "DATA_INSUFFICIENT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("execute() convierte una falla estructural real (tenancy context ausente) en un AgentResult clasificado -- nunca una excepción sin capturar", async () => {
  const executor = createContactIntelligenceExecutor();

  const result = await executor.execute(
    { tenantId: "tenant-titan", ...FAKE_CONTEXT_BASE },
    {
      taskId: "task_test",
      companyId: "company_test",
      companyName: "Acme Test Co",
      companyWebsite: null,
      companyState: "IL",
      companyCity: "Chicago",
      industryName: "Manufacturing",
      rolePlan: null,
    },
  );

  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.category, "PERMANENT_PROVIDER_ERROR");
});
