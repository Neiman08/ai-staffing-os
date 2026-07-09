import type { AgentInstanceListItem } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";

export async function listAgentInstances(): Promise<AgentInstanceListItem[]> {
  const instances = await scopedDb.agentInstance.findMany({
    include: { definition: true },
    orderBy: { createdAt: "asc" },
  });

  return instances.map((instance) => ({
    id: instance.id,
    key: instance.definition.key,
    name: instance.definition.name,
    description: instance.definition.description,
    autonomyLevel: instance.autonomyLevel,
    isActive: instance.isActive,
    metrics: instance.metrics as Record<string, unknown>,
  }));
}
