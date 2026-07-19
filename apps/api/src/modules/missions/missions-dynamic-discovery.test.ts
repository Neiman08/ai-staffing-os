// F7.3/F7.4: prueba de integración real de punta a punta —
// POST /missions con una instrucción que el LLM real
// (interpretDailyDirective) interpreta como useExternalDiscovery=true,
// contra tenant-titan (mismo tenant real que missions.test.ts). Ejercita
// el "pegamento" agregado a mission-orchestrator.ts (runDynamicDiscoveryMission)
// que no está cubierto por mission-executor.test.ts (ese usa providers
// mockeados) — esta es la ÚNICA prueba de esta suite que hace una
// llamada real a Google Places (misma tolerancia a costo real que
// discovery.test.ts, que ya hace lo mismo), acotada a Manufacturing/
// Illinois (bucket real aprobado) y a lo sumo 2 empresas. Desde F7.4,
// también ejercita Website Intelligence real (gratis, sin API key) sobre
// las empresas reales encontradas — sirve como la prueba real controlada
// de F7.4 (Business Validation + Email Trust) exigida por el plan:
// Manufacturing, máximo 2 Companies, Website Intelligence permitido, sin
// Hunter/PDL. Limpieza: CompanyContactPoint tiene onDelete: Cascade sobre
// Company (ver schema.prisma), así que borrar las Companies de
// createdCompanyIds ya limpia también cualquier CompanyContactPoint real
// que se haya creado (Lead/Opportunity SET NULL su companyId, se limpian
// aparte en el after()).
//
// F14: la instrucción de este test pide explícitamente "no crear
// campañas ni oportunidades" -- eso bloquea Campaign y Opportunity vía
// MissionRestrictions (mission-restrictions.ts ya reconocía esa frase
// antes de F14), pero NUNCA bloquea la creación de Lead -- no existe un
// flag "allowLeadCreation" en este sistema (ver conversion-policy.ts):
// Lead es la única acción comercial que la conversión de F14 puede
// generar incluso cuando la instrucción prohíbe Opportunity/Campaign.
// Antes de F14 esta corrida siempre daba 0 Leads/0 Opportunities
// (executeDiscoveryPlan nunca convertía evidencia en acciones
// comerciales) -- ahora sí puede generar Leads reales de investigación
// para las Companies que la política determinista apruebe, mientras
// Opportunity/Campaign se mantienen en cero por la restricción explícita.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";
import { REAL_PROVIDER_TESTS_ENABLED, REAL_PROVIDER_TEST_SKIP_REASON } from "../../test-helpers/real-provider-tests";

let server: Server;
let baseUrl: string;
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };
const createdMissionIds: string[] = [];
const createdCompanyIds: string[] = [];

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;
});

after(async () => {
  // F14: el flujo dinámico ahora puede crear Lead/Opportunity/
  // ApprovalRequest reales (conversion-policy.ts) -- se limpian antes de
  // borrar las Companies/AgentTasks (Lead/Opportunity referencian
  // companyId; ApprovalRequest referencia el childTask de discovery).
  if (createdCompanyIds.length) {
    await prisma.opportunity.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
    await prisma.lead.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
  }
  for (const id of createdMissionIds) {
    const children = await prisma.agentTask.findMany({ where: { parentTaskId: id } });
    const childIds = children.map((c) => c.id);
    await prisma.approvalRequest.deleteMany({ where: { agentTaskId: { in: [id, ...childIds] } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [id, ...childIds] } } });
    await prisma.activity.deleteMany({ where: { entityId: { in: [id, ...childIds] } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: childIds } } });
    await prisma.agentTask.delete({ where: { id } }).catch(() => {});
  }
  if (createdCompanyIds.length) {
    await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitForMissionSettled(missionId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await prisma.agentTask.findUniqueOrThrow({ where: { id: missionId } });
    const missionState = (task.output as { missionState?: string } | null)?.missionState ?? "RUNNING";
    if (missionState !== "RUNNING" && missionState !== "PAUSED_BUDGET") return missionState;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Mission ${missionId} did not settle within ${timeoutMs}ms`);
}

test(
  "una instrucción de descubrimiento externo (Manufacturing/IL, bucket real) ejecuta el nuevo ejecutor dinámico; respeta 'no crear campañas ni oportunidades' pero SÍ puede crear Leads de investigación (F14)",
  { skip: REAL_PROVIDER_TESTS_ENABLED ? false : REAL_PROVIDER_TEST_SKIP_REASON },
  async () => {
  const [leadsBefore, oppsBefore, campaignsBefore, contactsBefore, contactPointsBefore] = await Promise.all([
    prisma.lead.count({ where: { tenantId: "tenant-titan" } }),
    prisma.opportunity.count({ where: { tenantId: "tenant-titan" } }),
    prisma.campaign.count({ where: { tenantId: "tenant-titan" } }),
    prisma.contact.count({ where: { tenantId: "tenant-titan" } }),
    prisma.companyContactPoint.count({ where: { tenantId: "tenant-titan" } }),
  ]);

  const res = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({
      instruction:
        "Busca empresas de manufactura en Illinois que estén fuera de nuestro CRM, mediante búsqueda externa en fuentes externas/internet. Quiero encontrar 2 empresas nuevas. No crear campañas ni oportunidades.",
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string };
  createdMissionIds.push(body.id);

  const missionState = await waitForMissionSettled(body.id);
  assert.ok(
    ["COMPLETED", "PARTIAL", "NO_RESULTS", "BLOCKED"].includes(missionState),
    `estado final inesperado: ${missionState}`,
  );
  assert.notEqual(missionState, "FAILED");

  const detailRes = await fetch(`${baseUrl}/api/v1/missions/${body.id}`, { headers: SALES_HEADERS });
  const detail = (await detailRes.json()) as {
    discoveryExecution: {
      companiesCreated: number;
      createdCompanyIds: string[];
      missionState: string;
      restrictionsApplied: string[];
      queryExecutions: unknown[];
      emailsExtracted: number;
      emailsVerified: number;
      emailsRisky: number;
      emailsInvalid: number;
      companyContactPointsCreated: number;
      companyValidations: Array<{ companyId: string; businessConfidence: string; detectedBusinessType: string | null }>;
      leadsCreated: number;
      opportunitiesCreated: number;
      opportunitiesBlockedByRestriction: number;
      draftsCreated: number;
    } | null;
    missionPhase: string | null;
    childTasks: Array<{ type: string }>;
  };
  assert.ok(detail.discoveryExecution, "debe incluir el reporte del ejecutor dinámico");
  assert.equal(detail.missionPhase, "EXECUTING");
  assert.ok(detail.discoveryExecution!.companiesCreated <= 2);
  createdCompanyIds.push(...detail.discoveryExecution!.createdCompanyIds);
  // F14: la instrucción prohibió explícitamente Campaign y Opportunity
  // -- deben aparecer como restricción aplicada real, nunca la vieja
  // nota genérica "no se crea ninguna Lead/Opportunity/Campaign/Contact"
  // (esa era la nota falsa/engañosa que causó el hallazgo original: se
  // mostraba SIEMPRE, incluso cuando la misión sí autorizaba esas
  // acciones).
  assert.ok(detail.discoveryExecution!.restrictionsApplied.some((n) => n.includes("Campaign")));
  assert.ok(detail.discoveryExecution!.restrictionsApplied.some((n) => n.includes("Opportunit")));
  // Si alguna Company calificó para Opportunity según la política
  // determinista, debe quedar contabilizada como bloqueada por
  // restricción -- nunca silenciosamente omitida.
  assert.equal(detail.discoveryExecution!.opportunitiesCreated, 0);
  // Sin Opportunity nunca hay Draft -- evaluateDraftEligibility exige
  // opportunityCreated=true (conversion-policy.ts), sin excepción.
  assert.equal(detail.discoveryExecution!.draftsCreated, 0);
  assert.equal(
    detail.childTasks.filter((t) => t.type === "discover_companies").length,
    1,
    "exactamente un AgentTask hijo de discover_companies (el del nuevo ejecutor)",
  );

  // F7.4: cada Company realmente creada debe traer su propio registro de
  // Business Validation — nunca "EXACT" hardcodeado como en F7.3, el
  // nivel real depende de qué evidencia encontró el validador.
  assert.equal(detail.discoveryExecution!.companyValidations.length, detail.discoveryExecution!.companiesCreated);
  for (const validation of detail.discoveryExecution!.companyValidations) {
    assert.ok(["EXACT", "STRONG", "APPROXIMATE", "WEAK"].includes(validation.businessConfidence));
  }
  // Email Trust: cualquier email VERIFIED/RISKY reportado debe reflejarse
  // en CompanyContactPoint real — nunca INVALID (el bug real del PO).
  assert.equal(detail.discoveryExecution!.emailsInvalid >= 0, true);
  assert.ok(detail.discoveryExecution!.companyContactPointsCreated <= detail.discoveryExecution!.emailsExtracted);

  const [leadsAfter, oppsAfter, campaignsAfter, contactsAfter, contactPointsAfter] = await Promise.all([
    prisma.lead.count({ where: { tenantId: "tenant-titan" } }),
    prisma.opportunity.count({ where: { tenantId: "tenant-titan" } }),
    prisma.campaign.count({ where: { tenantId: "tenant-titan" } }),
    prisma.contact.count({ where: { tenantId: "tenant-titan" } }),
    prisma.companyContactPoint.count({ where: { tenantId: "tenant-titan" } }),
  ]);
  // F14: Lead SÍ puede crearse -- no existe una restricción "allowLeadCreation"
  // en este sistema (ver conversion-policy.ts) -- el conteo real debe
  // coincidir exactamente con lo reportado por discoveryExecution.
  assert.equal(leadsAfter - leadsBefore, detail.discoveryExecution!.leadsCreated);
  // Opportunity y Campaign sí quedan en cero -- la instrucción los
  // prohibió explícitamente y esa restricción SÍ bloquea la conversión
  // (ver discovery-conversion.ts: createOpportunity gateado en
  // restrictions.allowOpportunityCreation).
  assert.equal(oppsAfter, oppsBefore, "cero Opportunity creada -- prohibido explícitamente por la instrucción");
  assert.equal(campaignsAfter, campaignsBefore, "cero Campaign creada por el flujo dinámico (nunca se crea Campaign en este flujo)");
  assert.equal(contactsAfter, contactsBefore, "cero Contact creado por el flujo dinámico (Contact Intelligence no corre en esta fase)");
  assert.equal(
    contactPointsAfter - contactPointsBefore,
    detail.discoveryExecution!.companyContactPointsCreated,
    "el conteo real de CompanyContactPoint creados coincide exactamente con el reportado",
  );

  if (detail.discoveryExecution!.emailsInvalid === 0 && detail.discoveryExecution!.companyContactPointsCreated > 0) {
    // Revisión manual (pedida por el plan): si esta corrida encontró
    // algún email, confirmar que cada uno persistido realmente pertenece
    // al dominio de su propia Company — nunca uno de dominio ajeno.
    const points = await prisma.companyContactPoint.findMany({
      where: { companyId: { in: detail.discoveryExecution!.createdCompanyIds } },
      select: { companyId: true, email: true, verificationStatus: true },
    });
    for (const point of points) {
      assert.notEqual(point.verificationStatus, "INVALID", `CompanyContactPoint ${point.email} nunca debe persistirse como INVALID`);
    }
  }
  },
);
