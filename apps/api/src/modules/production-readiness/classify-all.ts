import { scopedDb } from "../../core/tenancy/prisma-extension";
import {
  classifyAgentTaskBySourcesUsed,
  classifyByCompanyRelation,
  classifyCompanyOrigin,
  classifyContactOrigin,
  extractCampaignCompanyIdFromTaskInput,
  extractCampaignIdFromTaskInput,
  extractCompanyIdFromTaskInput,
  extractLeadIdFromTaskInput,
  type DataOrigin,
} from "./origin-classifier";

export interface ClassifiedRecord {
  id: string;
  origin: DataOrigin;
}

/**
 * F4.7.5: barrido único de clasificación de origen — de solo lectura,
 * corre UNA vez por request y lo reusan tanto la auditoría (§1, cuenta)
 * como el plan de limpieza (§3, filtra por DEMO y junta IDs) sin volver
 * a recorrer la base dos veces. Toda la lógica de "cómo se clasifica
 * cada entidad" vive acá — audit.ts y cleanup-plan.ts nunca reimplementan
 * las reglas, solo consumen el resultado.
 */
export interface ClassifiedRecords {
  companies: ClassifiedRecord[];
  contacts: ClassifiedRecord[];
  leads: ClassifiedRecord[];
  opportunities: ClassifiedRecord[];
  campaigns: ClassifiedRecord[];
  activities: ClassifiedRecord[];
  agentTasks: ClassifiedRecord[];
  approvals: ClassifiedRecord[];
}

export async function classifyAllRecords(): Promise<ClassifiedRecords> {
  // ---- Company: única fuente real de procedencia, todo lo demás hereda de acá. ----
  const companyRows = await scopedDb.company.findMany({ select: { id: true, origin: true, sourceUrl: true } });
  const companyOriginById = new Map<string, DataOrigin>();
  const companies: ClassifiedRecord[] = companyRows.map((c) => {
    const origin = classifyCompanyOrigin(c);
    companyOriginById.set(c.id, origin);
    return { id: c.id, origin };
  });

  // ---- Contact ----
  const contactRows = await scopedDb.contact.findMany({
    select: { id: true, companyId: true, source: true, emailDiscoveryProvider: true, emailSource: true },
  });
  const contactOriginById = new Map<string, DataOrigin>();
  const contacts: ClassifiedRecord[] = contactRows.map((c) => {
    const companyOrigin = companyOriginById.get(c.companyId) ?? "UNKNOWN";
    const origin = classifyContactOrigin(c, companyOrigin);
    contactOriginById.set(c.id, origin);
    return { id: c.id, origin };
  });

  // ---- Lead ----
  const leadRows = await scopedDb.lead.findMany({ select: { id: true, companyId: true, createdByAgentTaskId: true } });
  const leadOriginById = new Map<string, DataOrigin>();
  const leads: ClassifiedRecord[] = leadRows.map((l) => {
    const companyOrigin = l.companyId ? (companyOriginById.get(l.companyId) ?? null) : null;
    const origin = classifyByCompanyRelation({ companyOrigin, createdByAgentTaskId: l.createdByAgentTaskId });
    leadOriginById.set(l.id, origin);
    return { id: l.id, origin };
  });

  // ---- Opportunity ----
  const opportunityRows = await scopedDb.opportunity.findMany({
    select: { id: true, companyId: true, createdByAgentTaskId: true },
  });
  const opportunityOriginById = new Map<string, DataOrigin>();
  const opportunities: ClassifiedRecord[] = opportunityRows.map((o) => {
    const companyOrigin = companyOriginById.get(o.companyId) ?? null;
    const origin = classifyByCompanyRelation({ companyOrigin, createdByAgentTaskId: o.createdByAgentTaskId });
    opportunityOriginById.set(o.id, origin);
    return { id: o.id, origin };
  });

  // ---- Campaign: sin companyId directo — DEMO si cualquier empresa
  // vinculada es demo; si no, el origen real más común entre sus
  // empresas; sin empresas vinculadas, agente/humano sin más detalle. ----
  const campaignRows = await scopedDb.campaign.findMany({
    select: { id: true, createdByAgentTaskId: true, companies: { select: { companyId: true } } },
  });
  const campaignOriginById = new Map<string, DataOrigin>();
  const campaigns: ClassifiedRecord[] = campaignRows.map((camp) => {
    const linkedOrigins = camp.companies.map((cc) => companyOriginById.get(cc.companyId)).filter(Boolean) as DataOrigin[];
    let origin: DataOrigin;
    if (linkedOrigins.includes("DEMO")) {
      origin = "DEMO";
    } else if (linkedOrigins.length > 0) {
      const tally = new Map<DataOrigin, number>();
      for (const o of linkedOrigins) tally.set(o, (tally.get(o) ?? 0) + 1);
      origin = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    } else {
      origin = camp.createdByAgentTaskId ? "UNKNOWN" : "USER_CREATED";
    }
    campaignOriginById.set(camp.id, origin);
    return { id: camp.id, origin };
  });
  const campaignCompanyRows = await scopedDb.campaignCompany.findMany({ select: { id: true, companyId: true } });
  const campaignCompanyToCompanyId = new Map(campaignCompanyRows.map((cc) => [cc.id, cc.companyId]));

  // ---- Activity: polimórfica, resuelta contra los 4 mapas de arriba. ----
  const activityRows = await scopedDb.activity.findMany({ select: { id: true, entityType: true, entityId: true } });
  const activities: ClassifiedRecord[] = activityRows.map((a) => {
    let origin: DataOrigin = "UNKNOWN";
    if (a.entityType === "company") origin = companyOriginById.get(a.entityId) ?? "UNKNOWN";
    else if (a.entityType === "contact") origin = contactOriginById.get(a.entityId) ?? "UNKNOWN";
    else if (a.entityType === "lead") origin = leadOriginById.get(a.entityId) ?? "UNKNOWN";
    else if (a.entityType === "opportunity") origin = opportunityOriginById.get(a.entityId) ?? "UNKNOWN";
    return { id: a.id, origin };
  });

  // ---- AgentTask: companyId directo -> leadId -> campaignCompanyId ->
  // campaignId -> output.sourcesUsed -> USER_CREATED/UNKNOWN. ----
  const agentTaskRows = await scopedDb.agentTask.findMany({
    select: { id: true, input: true, output: true, triggeredBy: true },
  });
  const agentTaskOriginById = new Map<string, DataOrigin>();
  const agentTasks: ClassifiedRecord[] = agentTaskRows.map((t) => {
    let origin: DataOrigin | null = null;

    const companyId = extractCompanyIdFromTaskInput(t.input);
    if (companyId && companyOriginById.has(companyId)) origin = companyOriginById.get(companyId)!;

    if (!origin) {
      const leadId = extractLeadIdFromTaskInput(t.input);
      if (leadId && leadOriginById.has(leadId)) origin = leadOriginById.get(leadId)!;
    }
    if (!origin) {
      const ccId = extractCampaignCompanyIdFromTaskInput(t.input);
      const resolvedCompanyId = ccId ? campaignCompanyToCompanyId.get(ccId) : undefined;
      if (resolvedCompanyId && companyOriginById.has(resolvedCompanyId)) origin = companyOriginById.get(resolvedCompanyId)!;
    }
    if (!origin) {
      const campaignId = extractCampaignIdFromTaskInput(t.input);
      if (campaignId && campaignOriginById.has(campaignId)) origin = campaignOriginById.get(campaignId)!;
    }
    if (!origin) {
      origin = classifyAgentTaskBySourcesUsed((t.output as { sourcesUsed?: unknown } | null)?.sourcesUsed);
    }
    if (!origin) {
      origin = t.triggeredBy === "USER" ? "USER_CREATED" : "UNKNOWN";
    }

    agentTaskOriginById.set(t.id, origin);
    return { id: t.id, origin };
  });

  // ---- ApprovalRequest: hereda de su AgentTask. ----
  const approvalRows = await scopedDb.approvalRequest.findMany({ select: { id: true, agentTaskId: true } });
  const approvals: ClassifiedRecord[] = approvalRows.map((ap) => ({
    id: ap.id,
    origin: agentTaskOriginById.get(ap.agentTaskId) ?? "UNKNOWN",
  }));

  return { companies, contacts, leads, opportunities, campaigns, activities, agentTasks, approvals };
}
