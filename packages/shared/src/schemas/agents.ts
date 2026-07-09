import { z } from "zod";

export const agentInstanceListItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  autonomyLevel: z.string(),
  isActive: z.boolean(),
  metrics: z.record(z.string(), z.unknown()),
});
export type AgentInstanceListItem = z.infer<typeof agentInstanceListItemSchema>;
