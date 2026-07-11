import { scopedDb } from "../../core/tenancy/prisma-extension";
import { classifyAllRecords } from "./classify-all";

export interface CleanupStep {
  entity: string;
  order: number;
  count: number;
  ids: string[];
  note: string;
}

export interface CleanupBlocker {
  entity: string;
  count: number;
  companyIds: string[];
  note: string;
}

export interface CleanupPlan {
  generatedAt: string;
  totalRecordsToDelete: number;
  steps: CleanupStep[];
  blockers: CleanupBlocker[];
}

/**
 * F4.7.5 §3: PLAN de limpieza — de solo lectura, NUNCA borra nada. Junta
 * exactamente los IDs de las 8 entidades pedidas por el PO cuyo origen
 * clasifica como DEMO (ver classify-all.ts), en el orden seguro real
 * según las foreign keys reales del schema (Contact -> Company es
 * @relation(onDelete: Cascade); Lead/Opportunity/CampaignCompany -> Company
 * NO tienen cascade, deben borrarse antes que la Company o Postgres
 * rechaza el DELETE por violación de FK). AgentTask/ApprovalRequest/
 * Activity no son foreign keys reales (son referencias de texto plano
 * sin @relation, "decisión #2" del schema) — se listan igual porque el
 * PO las pidió explícitamente, en un orden lógico (no técnicamente
 * obligatorio) de "lo más downstream primero".
 *
 * No ejecuta ningún DELETE — devuelve el plan para que un humano lo
 * revise. La función que sí borraría (a implementar en una fase
 * posterior, solo tras aprobación explícita del PO) no existe todavía
 * en este commit.
 */
export async function generateCleanupPlan(): Promise<CleanupPlan> {
  const records = await classifyAllRecords();

  const demoIds = (arr: Array<{ id: string; origin: string }>) => arr.filter((r) => r.origin === "DEMO").map((r) => r.id);

  const demoCompanyIds = demoIds(records.companies);
  const demoContactIds = demoIds(records.contacts);
  const demoLeadIds = demoIds(records.leads);
  const demoOpportunityIds = demoIds(records.opportunities);
  const demoCampaignIds = demoIds(records.campaigns);
  const demoActivityIds = demoIds(records.activities);
  const demoAgentTaskIds = demoIds(records.agentTasks);
  const demoApprovalIds = demoIds(records.approvals);

  const steps: CleanupStep[] = [
    {
      entity: "ApprovalRequest",
      order: 1,
      count: demoApprovalIds.length,
      ids: demoApprovalIds,
      note: "Sin foreign key real hacia AgentTask con cascade — se borra primero por prolijidad, no por restricción técnica.",
    },
    {
      entity: "AgentTask",
      order: 2,
      count: demoAgentTaskIds.length,
      ids: demoAgentTaskIds,
      note: "discoveredByAgentTaskId/createdByAgentTaskId en otras tablas son referencias de texto plano sin @relation — borrar esto no rompe ninguna FK real, pero esas columnas quedarían apuntando a un id inexistente en filas NO demo si alguna vez se mezclara (no debería pasar: un AgentTask demo solo referencia entidades demo).",
    },
    {
      entity: "Activity",
      order: 3,
      count: demoActivityIds.length,
      ids: demoActivityIds,
      note: "Polimórfica (entityType/entityId), sin FK real — segura de borrar en cualquier momento.",
    },
    {
      entity: "Opportunity",
      order: 4,
      count: demoOpportunityIds.length,
      ids: demoOpportunityIds,
      note: "FK real hacia Company SIN cascade — debe borrarse antes que la Company o Postgres rechaza el DELETE.",
    },
    {
      entity: "Lead",
      order: 5,
      count: demoLeadIds.length,
      ids: demoLeadIds,
      note: "FK real hacia Company SIN cascade (companyId es nullable, pero si está seteado igual bloquea) — debe borrarse antes que la Company.",
    },
    {
      entity: "Campaign",
      order: 6,
      count: demoCampaignIds.length,
      ids: demoCampaignIds,
      note: "CampaignCompany (tabla de unión) SÍ tiene @relation(onDelete: Cascade) hacia Campaign — borrar la Campaign ya limpia sus CampaignCompany automáticamente, no hace falta un paso separado.",
    },
    {
      entity: "Contact",
      order: 7,
      count: demoContactIds.length,
      ids: demoContactIds,
      note: "@relation(onDelete: Cascade) hacia Company — en la práctica se borra solo al borrar la Company (paso 8); listado acá para que el conteo sea explícito, no hace falta un DELETE separado.",
    },
    {
      entity: "Company",
      order: 8,
      count: demoCompanyIds.length,
      ids: demoCompanyIds,
      note: "Último paso — requiere que Opportunity/Lead/CampaignCompany ya no la referencien (pasos 4-6), y que no existan JobOrder/Project/Contract/Invoice apuntándola (ver blockers abajo, fuera del alcance de estas 8 entidades).",
    },
  ];

  // ---- Blockers reales: JobOrder/Project/Contract/Invoice tienen FK
  // real hacia Company SIN cascade y SIN estar en la lista de 8
  // entidades pedida por el PO — si una Company demo tiene alguna de
  // estas filas, el DELETE de esa Company fallaría igual aunque se
  // ejecuten los 8 pasos de arriba. Se reportan honestamente, no se
  // agregan a "steps" porque el PO no las pidió en el alcance de F4.7.5. ----
  const [jobOrders, projects, contracts, invoices] = await Promise.all([
    scopedDb.jobOrder.findMany({ where: { companyId: { in: demoCompanyIds } }, select: { companyId: true } }),
    scopedDb.project.findMany({ where: { companyId: { in: demoCompanyIds } }, select: { companyId: true } }),
    scopedDb.contract.findMany({ where: { companyId: { in: demoCompanyIds } }, select: { companyId: true } }),
    scopedDb.invoice.findMany({ where: { companyId: { in: demoCompanyIds } }, select: { companyId: true } }),
  ]);

  const blockers: CleanupBlocker[] = [
    { entity: "JobOrder", count: jobOrders.length, companyIds: [...new Set(jobOrders.map((r) => r.companyId))], note: "FK real hacia Company sin cascade, fuera del alcance de las 8 entidades pedidas — bloquearía el DELETE de la Company si no se resuelve aparte." },
    { entity: "Project", count: projects.length, companyIds: [...new Set(projects.map((r) => r.companyId))], note: "Mismo caso que JobOrder." },
    { entity: "Contract", count: contracts.length, companyIds: [...new Set(contracts.map((r) => r.companyId))], note: "Mismo caso que JobOrder." },
    { entity: "Invoice", count: invoices.length, companyIds: [...new Set(invoices.map((r) => r.companyId))], note: "Mismo caso que JobOrder." },
  ].filter((b) => b.count > 0);

  return {
    generatedAt: new Date().toISOString(),
    totalRecordsToDelete: steps.reduce((sum, s) => sum + s.count, 0),
    steps,
    blockers,
  };
}
