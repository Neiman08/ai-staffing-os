import { scopedDb } from "./tenancy/prisma-extension";

/**
 * Shared resolver for the polymorphic entityType/entityId pattern used by
 * both Activity and FollowUp. Batches one query per distinct entityType
 * present in the input instead of querying per-row.
 */
export async function labelEntities(
  rows: Array<{ entityType: string; entityId: string }>,
): Promise<Map<string, string>> {
  const idsByType = new Map<string, string[]>();
  for (const r of rows) {
    if (!idsByType.has(r.entityType)) idsByType.set(r.entityType, []);
    idsByType.get(r.entityType)!.push(r.entityId);
  }

  const labels = new Map<string, string>();

  const companyIds = idsByType.get("company");
  if (companyIds?.length) {
    const companies = await scopedDb.company.findMany({ where: { id: { in: companyIds } } });
    for (const c of companies) labels.set(`company:${c.id}`, c.name);
  }

  const leadIds = idsByType.get("lead");
  if (leadIds?.length) {
    const leads = await scopedDb.lead.findMany({
      where: { id: { in: leadIds } },
      include: { company: true },
    });
    for (const l of leads) labels.set(`lead:${l.id}`, l.company?.name ?? `Lead ${l.id.slice(-6)}`);
  }

  const opportunityIds = idsByType.get("opportunity");
  if (opportunityIds?.length) {
    const opportunities = await scopedDb.opportunity.findMany({ where: { id: { in: opportunityIds } } });
    for (const o of opportunities) labels.set(`opportunity:${o.id}`, o.title);
  }

  const contactIds = idsByType.get("contact");
  if (contactIds?.length) {
    const contacts = await scopedDb.contact.findMany({ where: { id: { in: contactIds } } });
    for (const c of contacts) labels.set(`contact:${c.id}`, `${c.firstName} ${c.lastName}`);
  }

  return labels;
}

export function entityLabelKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}
