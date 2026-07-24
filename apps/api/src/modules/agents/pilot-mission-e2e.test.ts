import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import {
  agentSuccess,
  agentFailure,
  classifyError,
  buildEventEnvelope,
  buildIdempotencyKey,
  AgentError,
  type AgentExecutor,
  type AgentExecutionContext,
  type LLMProvider,
  type LLMCompletionResult,
} from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { createOrMergeHumanReviewRequest } from "../human-review/service";
import { Orchestrator } from "./orchestrator";
import { EventDispatcher } from "../../core/events/dispatcher";
import { registerPipelineHandlers } from "./pipeline-handlers";
import { createQualityAgentExecutor } from "./executors/quality.executor";
import { createDraftExecutor } from "./executors/draft.executor";
import { discoveryTaskInputSchema, type DiscoveryTaskInput } from "./executors/discovery.executor";
import { contactIntelligenceTaskInputSchema, type ContactIntelligenceTaskInput } from "./executors/contact-intelligence.executor";
import { executeDiscoveryPlan, type DiscoveryExecutionReport } from "./mission-executor";
import { emptyResult, type ProviderCandidate, type ProviderSearchResult } from "./tools/discovery-providers/types";
import type { DiscoveryProviderPort } from "./mission-executor";
import { emptyWebsiteIntelligenceResult } from "./tools/website-intelligence/types";
import type { WebsiteIntelligencePort } from "./company-enrichment";
import { enrichCompanyWithDecisionContacts, type ContactEnrichmentReport } from "./contact-enrichment";
import type { ContactProviderPort } from "./contact-enrichment";
import type { ContactCandidate } from "./tools/contact-providers/types";
import { createPilotMission } from "./mission-producer";
import { getMissionTimeline } from "./observability";
import type { PipelineFlags } from "../../core/pipeline-flags";

/**
 * F25.2 (activación controlada, Prioridad 6): prueba end-to-end LOCAL
 * y real contra Postgres del pipeline completo -- misión piloto ->
 * AgentTask -> claim del Orchestrator -> Discovery -> evento ->
 * EventDispatcher -> Contact Intelligence -> Draft (F26, LLM inyectado)
 * -> Quality -> timeline. Cero llamadas externas reales (global.fetch
 * bloqueado a propósito, mismo patrón que mission-executor.test.ts) --
 * los AgentExecutor de Discovery/Contact Intelligence de ESTE archivo
 * son variantes locales que inyectan proveedores sintéticos (la forma
 * real -- createDiscoveryExecutor/createContactIntelligenceExecutor --
 * no expone esa inyección a propósito, porque un AgentTask.input real es
 * JSON puro, nunca puede llevar una función); createDraftExecutor SÍ
 * expone la inyección del LLMProvider (mismo criterio que
 * MissingApiKeyProvider en task-executor.ts), así que acá se usa la
 * forma REAL, no una variante local.
 */

const originalFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("pilot-mission-e2e.test.ts: intento de llamada de red real -- los proveedores deben inyectarse mockeados.");
}) as typeof fetch;

const TEST_PREFIX = "F25-2-E2E";
const createdTenantIds: string[] = [];

after(async () => {
  globalThis.fetch = originalFetch;
  if (createdTenantIds.length) {
    await prisma.humanReviewRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.domainEvent.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.lead.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.contact.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  createdTenantIds.push(tenant.id);
  for (const key of ["discovery", "contact_intelligence", "quality", "sales"]) {
    const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key } });
    await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: definition.id, isActive: true } });
  }
  return tenant.id;
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["missions.create"] }, fn);
}

function allFlagsOn(): PipelineFlags {
  return {
    autonomousWorkerEnabled: true,
    missionTaskProductionEnabled: true,
    discoveryAgentEnabled: true,
    contactIntelligenceAgentEnabled: true,
    qualityAgentEnabled: true,
    eventHandlersEnabled: true,
    draftAgentEnabled: true,
    externalActionsEnabled: false,
    autonomousSendingEnabled: false,
  };
}

// ---------- fixtures sintéticos (mismo patrón que mission-executor.test.ts / contact-enrichment.test.ts) ----------

function candidateFixture(overrides: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    name: "Acme Electrical Contractors Inc",
    fields: {
      website: { status: "CONFIRMED", value: "https://www.acme-electrical-fixture.example" },
      phone: { status: "CONFIRMED", value: "(312) 555-0199" },
      city: { status: "CONFIRMED", value: "Chicago" },
      email: { status: "NOT_FOUND", value: null },
      state: { status: "CONFIRMED", value: "IL" },
      address: { status: "NOT_FOUND", value: null },
    },
    sourceUrl: "https://www.google.com/maps/place/?q=place_id:E2E-PLACE-1",
    providerTypes: ["electrician"],
    ...overrides,
  };
}

function googleResult(candidates: ProviderCandidate[]): ProviderSearchResult {
  return { candidates, costUsd: 0.032, sourcesUsed: ["Google Places (fixture E2E)"], patternsFailed: [], cancelled: false };
}

const NO_OP_WEBSITE_INTELLIGENCE: WebsiteIntelligencePort = { runWebsiteIntelligence: async () => emptyWebsiteIntelligenceResult() };

function fakeDiscoveryProviders(): DiscoveryProviderPort {
  let called = false;
  return {
    searchGooglePlaces: async () => {
      if (called) return emptyResult();
      called = true;
      return googleResult([candidateFixture()]);
    },
    searchOverpass: async () => emptyResult(),
  };
}

function contactCandidateFixture(overrides: Partial<ContactCandidate> = {}): ContactCandidate {
  return {
    firstName: "Jane",
    lastName: "Doe",
    title: "Operations Manager",
    fields: {
      firstName: { status: "CONFIRMED", value: "Jane" },
      lastName: { status: "CONFIRMED", value: "Doe" },
      title: { status: "CONFIRMED", value: "Operations Manager" },
      linkedinUrl: { status: "NOT_FOUND", value: null },
      email: { status: "CONFIRMED", value: "jane.doe@acme-electrical-fixture.example" },
      phone: { status: "NOT_FOUND", value: null },
    },
    sourceUrl: null,
    ...overrides,
  };
}

function fakeContactProviders(): ContactProviderPort {
  return {
    searchPeopleDataLabs: async () => ({
      candidates: [contactCandidateFixture()],
      costUsd: 0.01,
      sourcesUsed: ["People Data Labs (fixture E2E)"],
      patternsFailed: [],
      cancelled: false,
      providerStatus: "AVAILABLE",
    }),
  };
}

/**
 * Variante LOCAL (solo de este test) del AgentExecutor de Discovery --
 * misma forma exacta que createDiscoveryExecutor real
 * (discovery.executor.ts), con la ÚNICA diferencia de inyectar
 * proveedores sintéticos. Reusa executeDiscoveryPlan real sin
 * modificarlo -- "no reescribas la lógica" sigue aplicando.
 */
function createTestDiscoveryExecutor(): AgentExecutor<DiscoveryTaskInput, DiscoveryExecutionReport> {
  return {
    taskType: "discover_companies",
    stage: "DISCOVERY",
    inputSchema: discoveryTaskInputSchema,
    execute: async (context: AgentExecutionContext, input: DiscoveryTaskInput) => {
      try {
        const report = await executeDiscoveryPlan({
          missionTaskId: input.missionTaskId,
          plan: input.plan,
          restrictions: input.restrictions,
          businessActivities: input.businessActivities,
          targetJobTitles: input.targetJobTitles,
          decisionRoles: input.decisionRoles,
          providers: fakeDiscoveryProviders(),
          websiteIntelligence: NO_OP_WEBSITE_INTELLIGENCE,
          googlePlacesApiKey: "fake-key-for-e2e-test",
        });

        const createdCompanies =
          report.createdCompanyIds.length > 0
            ? await scopedDb.company.findMany({ where: { id: { in: report.createdCompanyIds } } })
            : [];

        const events = createdCompanies.map((company) =>
          buildEventEnvelope({
            eventType: "company.discovered.v1",
            tenantId: context.tenantId,
            correlationId: context.correlationId,
            causationId: context.causationId,
            actorType: "AGENT" as const,
            actorId: context.agentInstanceId,
            entityType: "company",
            entityId: company.id,
            payload: { companyId: company.id, origin: company.origin },
            idempotencyKey: buildIdempotencyKey(context.correlationId, "company.discovered.v1", company.id),
          }),
        );

        for (const company of createdCompanies) {
          const meta = (company.discoveryMetadata ?? {}) as { isClientOwnerCandidate?: boolean; clientOwnerAssociations?: string[] };
          if (!meta.isClientOwnerCandidate) continue;
          await createOrMergeHumanReviewRequest({
            type: "POLICY_EXCEPTION",
            priority: "HIGH",
            entityType: "company",
            entityId: company.id,
            summary: `${company.name}: posible cliente actual`,
            evidence: [{ clientOwnerAssociations: (meta.clientOwnerAssociations ?? []).join(", ") }],
            requestedDecision: "Autorizar o bloquear la prospección de esta empresa.",
            options: [
              { label: "Autorizar", consequence: "Continúa el pipeline." },
              { label: "Bloquear", consequence: "Se excluye del outreach automático." },
            ],
            recommendation: null,
            impact: "Bloqueada por defecto sin decisión.",
            correlationId: context.correlationId,
          });
        }

        return agentSuccess(report, events);
      } catch (err) {
        return agentFailure(new AgentError(classifyError(err), err instanceof Error ? err.message : String(err), err));
      }
    },
  };
}

/** Variante LOCAL del AgentExecutor de Contact Intelligence -- mismo criterio que arriba. */
function createTestContactIntelligenceExecutor(): AgentExecutor<ContactIntelligenceTaskInput, ContactEnrichmentReport> {
  return {
    taskType: "find_contacts",
    stage: "CONTACT_INTELLIGENCE",
    inputSchema: contactIntelligenceTaskInputSchema,
    execute: async (context: AgentExecutionContext, input: ContactIntelligenceTaskInput) => {
      try {
        const report = await enrichCompanyWithDecisionContacts({
          taskId: input.taskId,
          companyId: input.companyId,
          companyName: input.companyName,
          companyWebsite: input.companyWebsite,
          companyState: input.companyState,
          companyCity: input.companyCity,
          industryName: input.industryName,
          rolePlan: input.rolePlan,
          contactProvider: fakeContactProviders(),
          peopleDataLabsApiKey: "fake-key-for-e2e-test",
        });

        const events = report.contactsCreated.flatMap((contact) => {
          const discovered = buildEventEnvelope({
            eventType: "contact.discovered.v1",
            tenantId: context.tenantId,
            correlationId: context.correlationId,
            causationId: context.causationId,
            actorType: "AGENT" as const,
            actorId: context.agentInstanceId,
            entityType: "contact",
            entityId: contact.contactId,
            payload: { contactId: contact.contactId, companyId: input.companyId, matchedRole: contact.matchedRole },
            idempotencyKey: buildIdempotencyKey(context.correlationId, "contact.discovered.v1", contact.contactId),
          });
          if (!contact.emailDomainTrust) return [discovered];
          const verified = buildEventEnvelope({
            eventType: "contact.verified.v1",
            tenantId: context.tenantId,
            correlationId: context.correlationId,
            causationId: context.causationId,
            actorType: "AGENT" as const,
            actorId: context.agentInstanceId,
            entityType: "contact",
            entityId: contact.contactId,
            payload: { contactId: contact.contactId, companyId: input.companyId, emailVerificationStatus: contact.emailDomainTrust },
            idempotencyKey: buildIdempotencyKey(context.correlationId, "contact.verified.v1", contact.contactId),
          });
          return [discovered, verified];
        });

        return agentSuccess(report, events);
      } catch (err) {
        return agentFailure(new AgentError(classifyError(err), err instanceof Error ? err.message : String(err), err));
      }
    },
  };
}

function fakeLLMProvider(response: { subject: string; body: string } = { subject: "Ayuda con personal para tu operación", body: "Hola equipo,\n\nBest regards,\nDreiStaff Team" }): LLMProvider {
  return {
    complete: async (): Promise<LLMCompletionResult> => ({ content: JSON.stringify(response), tokensUsed: 42 }),
  };
}

async function runUntilIdle(orchestrator: Orchestrator, dispatcher: EventDispatcher, maxRounds = 15): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const orch = await orchestrator.runOnce("e2e-worker", 10);
    const disp = await dispatcher.runOnce(25);
    if (orch.claimed === 0 && disp.claimed === 0) return;
  }
}

test("misión piloto end-to-end real: Discovery -> evento -> Contact Intelligence -> Draft real (F26) -> Quality -> timeline", async () => {
  const tenantId = await setupTenant("full-pipeline");

  const orchestrator = new Orchestrator();
  orchestrator.registerExecutor(createTestDiscoveryExecutor());
  orchestrator.registerExecutor(createTestContactIntelligenceExecutor());
  orchestrator.registerExecutor(createDraftExecutor(fakeLLMProvider()));
  orchestrator.registerExecutor(createQualityAgentExecutor());

  const dispatcher = new EventDispatcher();
  registerPipelineHandlers(dispatcher, allFlagsOn());

  // ---------- 1-2. crear misión piloto -> AgentTask real ----------
  const idempotencyKey = `e2e-pilot-${tenantId}`;
  const mission = await withTenant(tenantId, () =>
    createPilotMission({
      name: "E2E Pilot Electrical Contractors Illinois",
      industry: "CONSTRUCTION",
      trade: "electrical contractors",
      region: { state: "IL", cities: ["Chicago"] },
      companyLimit: 1,
      autonomyLevel: 1,
      dryRun: false,
      idempotencyKey,
    }),
  );
  assert.equal(mission.dryRun, false);
  assert.ok(mission.missionTaskId);
  const correlationId = mission.correlationId;

  // ---------- 3-7. claim -> Discovery -> evento -> EventDispatcher -> Contact Intelligence ----------
  await runUntilIdle(orchestrator, dispatcher);

  const discoveryTask = await prisma.agentTask.findUniqueOrThrow({ where: { id: mission.missionTaskId } });
  assert.equal(discoveryTask.status, "DONE", "Discovery debe completarse con el proveedor sintético inyectado");
  assert.equal(discoveryTask.correlationId, correlationId);

  const company = await prisma.company.findFirstOrThrow({ where: { tenantId } });
  assert.equal(company.name, "Acme Electrical Contractors Inc");

  const companyDiscoveredEvent = await prisma.domainEvent.findFirstOrThrow({ where: { tenantId, type: "company.discovered.v1" } });
  assert.equal(companyDiscoveredEvent.correlationId, correlationId, "correlationId estable de punta a punta");
  assert.ok(companyDiscoveredEvent.processedAt, "el EventDispatcher debe haberlo marcado processed");

  const contactTask = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "find_contacts" } });
  assert.equal(contactTask.status, "DONE");
  assert.equal(contactTask.causationId, companyDiscoveredEvent.id, "causationId encadena al evento que lo causó");

  const contact = await prisma.contact.findFirstOrThrow({ where: { tenantId, companyId: company.id } });
  assert.equal(contact.firstName, "Jane");

  // Nota: el HumanReviewRequest real por isClientOwnerCandidate (Prioridad
  // 2, "posible cliente actual") ya está cubierto a nivel más preciso por
  // critical-infrastructure-clients.test.ts + draft-creation-gate.test.ts
  // + draft.executor.test.ts ("CLIENT_OWNER_REVIEW") -- acá se usa
  // deliberadamente una empresa que NO matchea ningún cliente crítico,
  // para poder probar el camino feliz completo hasta un Draft real.

  // ---------- 8. Draft real (contact.verified.v1 -> draft_outreach, LLM inyectado) -> Quality ----------
  const contactVerifiedEvent = await prisma.domainEvent.findFirstOrThrow({ where: { tenantId, type: "contact.verified.v1" } });
  assert.equal(contactVerifiedEvent.correlationId, correlationId, "contact.verified.v1 también propaga el correlationId de la misión");

  await runUntilIdle(orchestrator, dispatcher);

  const draftTask = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "draft_outreach" } });
  assert.equal(draftTask.status, "DONE", "el Draft real (LLM inyectado) debe completarse");
  assert.equal(draftTask.causationId, contactVerifiedEvent.id, "causationId encadena hasta contact.verified.v1");

  const lead = await prisma.lead.findFirstOrThrow({ where: { tenantId, companyId: company.id } });
  assert.equal(lead.source, "pilot-mission");

  const approval = await prisma.approvalRequest.findFirstOrThrow({ where: { tenantId, companyId: company.id } });
  assert.equal(approval.status, "PENDING", "el Draft nunca se auto-aprueba -- espera decisión humana");
  const proposedAction = approval.proposedAction as { to: string; leadId: string };
  assert.equal(proposedAction.to, "jane.doe@acme-electrical-fixture.example", "usa el email real resuelto por Contact Intelligence, nunca uno inventado");
  assert.equal(proposedAction.leadId, lead.id);

  const draftCreatedEvent = await prisma.domainEvent.findFirstOrThrow({ where: { tenantId, type: "outreach.draft_created.v1" } });
  assert.equal(draftCreatedEvent.correlationId, correlationId);

  const qualityTask = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "evaluate_draft_quality" } });
  assert.equal(qualityTask.status, "DONE", "un borrador válido (PASS) completa la tarea normalmente");
  assert.equal(qualityTask.causationId, draftCreatedEvent.id);

  const qualityEvent = await prisma.domainEvent.findFirstOrThrow({ where: { tenantId, type: "outreach.quality_passed.v1" } });
  assert.equal((qualityEvent.payload as { verdict: string }).verdict, "PASS");

  // ---------- 10. timeline final -- todo agrupado por correlationId ----------
  const timeline = await withTenant(tenantId, () => getMissionTimeline(correlationId));
  const kinds = timeline.map((e) => `${e.kind}:${e.type}`);
  assert.ok(kinds.includes("task:discover_companies"));
  assert.ok(kinds.includes("event:company.discovered.v1"));
  assert.ok(kinds.includes("task:find_contacts"));
  assert.ok(kinds.includes("event:contact.discovered.v1"));
  assert.ok(kinds.includes("event:contact.verified.v1"));
  assert.ok(kinds.includes("task:draft_outreach"));
  assert.ok(kinds.includes("event:outreach.draft_created.v1"));
  assert.ok(kinds.includes("task:evaluate_draft_quality"));
  assert.ok(kinds.includes("event:outreach.quality_passed.v1"));
  // Cronológico: el primer elemento es SIEMPRE la tarea raíz.
  assert.equal(timeline[0]!.id, mission.missionTaskId);

  // ---------- idempotencia real: segunda ejecución de la misma solicitud ----------
  const secondAttempt = await withTenant(tenantId, () =>
    createPilotMission({
      name: "Nombre distinto, misma solicitud",
      industry: "CONSTRUCTION",
      trade: "electrical contractors",
      region: { state: "IL", cities: ["Chicago"] },
      companyLimit: 1,
      autonomyLevel: 1,
      dryRun: false,
      idempotencyKey, // misma clave
    }),
  );
  assert.equal(secondAttempt.alreadyExisted, true);
  assert.equal(secondAttempt.missionTaskId, mission.missionTaskId);
  const totalRootTasks = await prisma.agentTask.count({ where: { tenantId, idempotencyKey } });
  assert.equal(totalRootTasks, 1, "la segunda ejecución nunca duplica la tarea raíz");
});

test("tenant isolation real: dos misiones piloto en tenants distintos nunca comparten timeline ni Company", async () => {
  const tenantA = await setupTenant("isolation-a");
  const tenantB = await setupTenant("isolation-b");

  const orchestrator = new Orchestrator();
  orchestrator.registerExecutor(createTestDiscoveryExecutor());
  const dispatcher = new EventDispatcher();
  registerPipelineHandlers(dispatcher, allFlagsOn());

  const missionA = await withTenant(tenantA, () =>
    createPilotMission({
      name: "Tenant A",
      industry: "CONSTRUCTION",
      trade: "electrical contractors",
      region: { state: "IL", cities: ["Chicago"] },
      companyLimit: 1,
      autonomyLevel: 1,
      dryRun: false,
      idempotencyKey: `e2e-isolation-a-${tenantA}`,
    }),
  );
  const missionB = await withTenant(tenantB, () =>
    createPilotMission({
      name: "Tenant B",
      industry: "CONSTRUCTION",
      trade: "electrical contractors",
      region: { state: "IL", cities: ["Chicago"] },
      companyLimit: 1,
      autonomyLevel: 1,
      dryRun: false,
      idempotencyKey: `e2e-isolation-b-${tenantB}`,
    }),
  );

  await runUntilIdle(orchestrator, dispatcher);

  const companiesA = await prisma.company.findMany({ where: { tenantId: tenantA } });
  const companiesB = await prisma.company.findMany({ where: { tenantId: tenantB } });
  assert.equal(companiesA.length, 1);
  assert.equal(companiesB.length, 1);
  assert.notEqual(companiesA[0]!.id, companiesB[0]!.id);

  const timelineA = await withTenant(tenantA, () => getMissionTimeline(missionA.correlationId));
  const timelineB = await withTenant(tenantB, () => getMissionTimeline(missionB.correlationId));
  assert.ok(!timelineA.some((e) => e.id === missionB.missionTaskId));
  assert.ok(!timelineB.some((e) => e.id === missionA.missionTaskId));

  // scopedDb con el tenant equivocado nunca debe poder ver la Company del otro tenant.
  await withTenant(tenantA, async () => {
    const leaked = await scopedDb.company.findUnique({ where: { id: companiesB[0]!.id } });
    assert.equal(leaked, null, "tenant A nunca debe poder leer una Company de tenant B");
  });
});
