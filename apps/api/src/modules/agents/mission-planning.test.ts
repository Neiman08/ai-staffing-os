import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import {
  ceoStructuredIntentSchema,
  ceoMissionPlanSchema,
  ceoIntentMetaSchema,
  agentTaskDetailSchema,
} from "@ai-staffing-os/shared";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { planMissionOnly } from "./mission-planning";
import { getMissionDetail } from "../missions/service";

// F7.2: tests de integración de planMissionOnly — el módulo puro F7.1
// (apps/api/src/modules/ceo-intelligence/) ya tiene su propia batería de
// 44 tests de interpretación/planificación; acá se prueba la
// INTEGRACIÓN: persistencia real en AgentTask, cero efectos
// secundarios, restricciones, tenancy, serialización, compatibilidad
// con misiones viejas. Cero llamadas externas (interpretBusinessIntent/
// buildMissionPlan son puras) — solo Prisma real, contra tenants
// sintéticos desechables creados/borrados acá mismo.

const TEST_PREFIX = "F72-PLAN-TEST";
const createdTenantIds: string[] = [];
const createdTaskIds: { tenantId: string; taskId: string }[] = [];

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
  await prisma.agentInstance.create({
    data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true },
  });
  createdTenantIds.push(tenant.id);
  return tenant.id;
}

async function plan(tenantId: string, instruction: string) {
  return runWithTenancyContext(
    { tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["missions.create", "missions.view"] },
    async () => {
      const detail = await planMissionOnly(instruction);
      createdTaskIds.push({ tenantId, taskId: detail.id });
      return detail;
    },
  );
}

after(async () => {
  // Limpieza en orden: AuditLog/Activity -> AgentTask -> AgentInstance -> Tenant.
  for (const { taskId } of createdTaskIds) {
    await prisma.auditLog.deleteMany({ where: { entityId: taskId } });
    await prisma.activity.deleteMany({ where: { entityId: taskId } });
  }
  if (createdTaskIds.length) {
    await prisma.agentTask.deleteMany({ where: { id: { in: createdTaskIds.map((t) => t.taskId) } } });
  }
  if (createdTenantIds.length) {
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

// ---------- Batería representativa de las 18 instrucciones pedidas ----------

const REQUIRED_CASES: Array<{ label: string; instruction: string }> = [
  { label: "1. Hoteles + housekeeping", instruction: "Busca hoteles en Illinois que necesiten housekeeping." },
  { label: "2. Hospitales + environmental services", instruction: "Busca hospitales que necesiten environmental services." },
  { label: "3. Manufacturing + production workers", instruction: "Busca empresas manufactureras que contraten Production Workers." },
  { label: "4. Warehouses + forklift operators", instruction: "Busca warehouses con Forklift Operators." },
  { label: "5. Janitorial + commercial cleaning", instruction: "Busca empresas de janitorial services y commercial cleaning." },
  { label: "6. Roofing", instruction: "Busca roofing contractors en Illinois." },
  { label: "7. Landscaping", instruction: "Busca empresas de landscaping." },
  { label: "8. Data centers + electricians", instruction: "Busca data centers que necesiten electricistas." },
  { label: "9. Food manufacturing", instruction: "Busca empresas manufactureras de alimentos en Illinois." },
  { label: "10. Restaurants + dishwashers", instruction: "Busca restaurantes que necesiten Dishwashers." },
  { label: "11. Varias ciudades", instruction: "Busca manufactura en Chicago y Aurora." },
  { label: "12. Exclusiones", instruction: "Busca hoteles pero excluye staffing." },
  { label: "13. No campañas ni oportunidades", instruction: "Busca hoteles en Illinois. No crear campañas ni oportunidades." },
  { label: "14. No mensajes ni outreach", instruction: "Busca hoteles en Illinois. No preparar mensajes. No contactar a nadie." },
  { label: "15. Instrucción solo de contactos", instruction: "Encuentra HR Manager o Executive Housekeeper." },
  { label: "16. Instrucción ambigua", instruction: "Busca empresas interesantes que puedan necesitar ayuda." },
  { label: "17. Instrucción sin categoría reconocida", instruction: "Busca proveedores de software empresarial." },
  { label: "18. Instrucción completamente inválida", instruction: "asdkjaslkdj qwoeiqwoe zxcvzxcv" },
];

test("batería de 18 casos obligatorios: cada uno persiste un AgentTask DONE con missionState PLANNED, contratos válidos", async () => {
  const tenantId = await setupTenant("battery");
  for (const { label, instruction } of REQUIRED_CASES) {
    const detail = await plan(tenantId, instruction);
    assert.equal(detail.status, "DONE", `${label}: status debe ser DONE`);
    const output = detail.output as {
      missionState: string;
      missionPhase: string;
      ceoIntent: unknown;
      missionPlan: unknown;
      ceoIntentMeta: unknown;
    };
    assert.equal(output.missionState, "PLANNED", `${label}: missionState`);
    assert.equal(output.missionPhase, "PLANNED", `${label}: missionPhase`);

    // Serialización/deserialización real: simula lo que la API haría
    // (JSON.stringify + JSON.parse) y valida contra los contratos
    // espejo de packages/shared (los que consume el frontend).
    const roundTripped = JSON.parse(JSON.stringify(output)) as typeof output;
    const intentResult = ceoStructuredIntentSchema.safeParse(roundTripped.ceoIntent);
    assert.ok(intentResult.success, `${label}: ceoIntent inválido tras round-trip: ${JSON.stringify(intentResult.error?.format())}`);
    const planResult = ceoMissionPlanSchema.safeParse(roundTripped.missionPlan);
    assert.ok(planResult.success, `${label}: missionPlan inválido tras round-trip: ${JSON.stringify(planResult.error?.format())}`);
    const metaResult = ceoIntentMetaSchema.safeParse(roundTripped.ceoIntentMeta);
    assert.ok(metaResult.success, `${label}: ceoIntentMeta inválido tras round-trip`);

    const fullDetailResult = agentTaskDetailSchema.safeParse(JSON.parse(JSON.stringify(detail)));
    assert.ok(fullDetailResult.success, `${label}: AgentTaskDetail completo inválido`);
  }
});

test("caso 13 (no campañas ni oportunidades) y 14 (no mensajes/outreach): restricciones realmente aplicadas end-to-end", async () => {
  const tenantId = await setupTenant("restrictions");
  const d13 = await plan(tenantId, "Busca hoteles en Illinois. No crear campañas ni oportunidades.");
  const o13 = d13.output as { appliedRestrictions: Record<string, boolean> };
  assert.equal(o13.appliedRestrictions.allowCampaignCreation, false);
  assert.equal(o13.appliedRestrictions.allowOpportunityCreation, false);
  assert.equal(o13.appliedRestrictions.allowOutreach, true);

  const d14 = await plan(tenantId, "Busca hoteles en Illinois. No preparar mensajes. No contactar a nadie.");
  const o14 = d14.output as { appliedRestrictions: Record<string, boolean> };
  assert.equal(o14.appliedRestrictions.allowOutreach, false);
  assert.equal(o14.appliedRestrictions.allowMessageSending, false);
  assert.equal(o14.appliedRestrictions.allowCampaignCreation, true);
});

test("caso 16/17 (ambigua / sin categoría): confianza baja y warning de fallback documentado, nunca ejecutado", async () => {
  const tenantId = await setupTenant("fallback");
  const detail = await plan(tenantId, "Busca proveedores de software empresarial.");
  const output = detail.output as { ceoIntent: { confidence: number }; ceoIntentMeta: { warnings: string[] } };
  assert.ok(output.ceoIntent.confidence < 0.5);
  assert.ok(
    output.ceoIntentMeta.warnings.some((w) => w.includes("fallback") && w.includes("OpenAI")),
    "debe documentar cuándo se usaría el fallback a interpretDailyDirective, sin ejecutarlo",
  );
});

test("cero efectos secundarios: zero Company/Lead/Opportunity/Campaign/Contact/CompanyContactPoint/AgentTask-hijo creados por planMissionOnly", async () => {
  const tenantId = await setupTenant("side-effects");

  const [companiesBefore, leadsBefore, opportunitiesBefore, campaignsBefore, contactsBefore, contactPointsBefore] =
    await Promise.all([
      prisma.company.count({ where: { tenantId } }),
      prisma.lead.count({ where: { tenantId } }),
      prisma.opportunity.count({ where: { tenantId } }),
      prisma.campaign.count({ where: { tenantId } }),
      prisma.contact.count({ where: { tenantId } }),
      prisma.companyContactPoint.count({ where: { tenantId } }),
    ]);

  const detail = await plan(tenantId, "Busca hoteles en Illinois que necesiten housekeeping. Encuentra HR Manager.");

  const [
    companiesAfter,
    leadsAfter,
    opportunitiesAfter,
    campaignsAfter,
    contactsAfter,
    contactPointsAfter,
    childTasks,
    activities,
    auditLogs,
  ] = await Promise.all([
    prisma.company.count({ where: { tenantId } }),
    prisma.lead.count({ where: { tenantId } }),
    prisma.opportunity.count({ where: { tenantId } }),
    prisma.campaign.count({ where: { tenantId } }),
    prisma.contact.count({ where: { tenantId } }),
    prisma.companyContactPoint.count({ where: { tenantId } }),
    prisma.agentTask.findMany({ where: { tenantId, parentTaskId: detail.id } }),
    prisma.activity.findMany({ where: { tenantId } }),
    prisma.auditLog.findMany({ where: { tenantId } }),
  ]);

  assert.equal(companiesAfter, companiesBefore, "cero Company creada");
  assert.equal(leadsAfter, leadsBefore, "cero Lead creado");
  assert.equal(opportunitiesAfter, opportunitiesBefore, "cero Opportunity creada");
  assert.equal(campaignsAfter, campaignsBefore, "cero Campaign creada");
  assert.equal(contactsAfter, contactsBefore, "cero Contact creado");
  assert.equal(contactPointsAfter, contactPointsBefore, "cero CompanyContactPoint creado");
  assert.equal(childTasks.length, 0, "cero AgentTask hijo (cero discovery/contact-intelligence delegado)");

  // La única Activity/AuditLog real es la de planificación misma —
  // nunca un evento "comercial" (company.discovered_by_agent, etc.).
  assert.equal(activities.length, 1);
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0]!.action, "mission.planned");
});

test("tenancy: un plan creado en un tenant no es visible desde otro tenant (getMissionDetail lanza notFound)", async () => {
  const tenantA = await setupTenant("tenancy-a");
  const tenantB = await setupTenant("tenancy-b");

  const detail = await plan(tenantA, "Busca hoteles en Illinois.");

  await assert.rejects(
    () =>
      runWithTenancyContext(
        { tenantId: tenantB, userId: `${TEST_PREFIX}-user-b`, permissions: ["missions.view"] },
        () => getMissionDetail(detail.id),
      ),
    /not found/i,
  );

  // Confirmado desde el tenant correcto, sin problema.
  const ownDetail = await runWithTenancyContext(
    { tenantId: tenantA, userId: `${TEST_PREFIX}-user-a`, permissions: ["missions.view"] },
    () => getMissionDetail(detail.id),
  );
  assert.equal(ownDetail.id, detail.id);
});

test("compatibilidad con misiones antiguas: una misión real ya existente (sin ceoIntent/missionPlan) se sigue leyendo sin romperse", async () => {
  const ctx = { tenantId: "tenant-titan", userId: "compat-test-user", permissions: ["missions.view"] };
  const oldMission = await prisma.agentTask.findFirst({
    where: { tenantId: "tenant-titan", type: "daily_revenue_mission" },
    orderBy: { createdAt: "asc" },
  });
  if (!oldMission) return; // entorno sin datos reales — no aplica, no se inventa un fixture para esto.

  const detail = await runWithTenancyContext(ctx, () => getMissionDetail(oldMission.id));
  assert.equal(detail.ceoIntent, null);
  assert.equal(detail.missionPlan, null);
  assert.equal(detail.ceoIntentMeta, null);
  // missionPhase puede ser null (misión previa a F7.2) — nunca debe tirar.
  assert.ok(detail.missionPhase === null || detail.missionPhase === "PLANNED" || detail.missionPhase === "EXECUTING");
});
