import { classifyAllRecords } from "./classify-all";
import { emptyOriginCounts, type DataOrigin } from "./origin-classifier";

export interface EntityOriginAudit {
  entity: string;
  total: number;
  byOrigin: Record<DataOrigin, number>;
}

export interface ProductionAuditReport {
  generatedAt: string;
  entities: EntityOriginAudit[];
}

function tally(records: Array<{ origin: DataOrigin }>): Record<DataOrigin, number> {
  const counts = emptyOriginCounts();
  for (const r of records) counts[r.origin] += 1;
  return counts;
}

/**
 * F4.7.5 §1: auditoría real de procedencia — de solo lectura, nunca
 * escribe nada. Tally sobre el barrido único de classify-all.ts para
 * las 8 entidades pedidas por el PO.
 */
export async function generateProductionAudit(): Promise<ProductionAuditReport> {
  const records = await classifyAllRecords();

  return {
    generatedAt: new Date().toISOString(),
    entities: [
      { entity: "Company", total: records.companies.length, byOrigin: tally(records.companies) },
      { entity: "Contact", total: records.contacts.length, byOrigin: tally(records.contacts) },
      { entity: "Lead", total: records.leads.length, byOrigin: tally(records.leads) },
      { entity: "Opportunity", total: records.opportunities.length, byOrigin: tally(records.opportunities) },
      { entity: "Campaign", total: records.campaigns.length, byOrigin: tally(records.campaigns) },
      { entity: "Activity", total: records.activities.length, byOrigin: tally(records.activities) },
      { entity: "AgentTask", total: records.agentTasks.length, byOrigin: tally(records.agentTasks) },
      { entity: "ApprovalRequest", total: records.approvals.length, byOrigin: tally(records.approvals) },
    ],
  };
}
