import { z } from "zod";

/**
 * F25.2 Fase 5: vocabulario del Human Review Center -- espeja
 * HumanReviewType/HumanReviewPriority de packages/db/prisma/schema.prisma
 * 1:1 (única fuente de verdad semántica es el schema Prisma, esto solo
 * permite validar/tipar el mismo vocabulario en el borde HTTP sin
 * importar el cliente de Prisma en el frontend). Ver
 * docs/F25_AUTONOMY_POLICY_MODEL.md §8 para el contrato completo.
 */
export const HUMAN_REVIEW_TYPES = [
  "INVALID_CLASSIFICATION",
  "CONTACT_AMBIGUOUS",
  "CONTENT_RISK",
  "POLICY_EXCEPTION",
  "HIGH_VALUE_OPPORTUNITY",
  "NEGOTIATION_REQUIRED",
  "UNSAFE_REPLY",
  "MEETING_CONFLICT",
  "LEARNING_PROPOSAL",
  "SYSTEM_FAILURE",
] as const;

export type HumanReviewTypeValue = (typeof HUMAN_REVIEW_TYPES)[number];

export const HUMAN_REVIEW_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export type HumanReviewPriorityValue = (typeof HUMAN_REVIEW_PRIORITIES)[number];

// F25.2 (consolidación): shape real de GET /api/v1/human-review -- usada
// por la UI (apps/web/src/pages/HumanReview.tsx) para tipar la
// respuesta sin importar el cliente de Prisma en el frontend.
export const humanReviewRequestListItemSchema = z.object({
  id: z.string(),
  type: z.enum(HUMAN_REVIEW_TYPES),
  priority: z.enum(HUMAN_REVIEW_PRIORITIES),
  deadline: z.string().nullable(),
  entityType: z.string(),
  entityId: z.string(),
  summary: z.string(),
  evidence: z.array(z.record(z.string(), z.unknown())),
  requestedDecision: z.string(),
  options: z.array(z.object({ label: z.string(), consequence: z.string() })),
  recommendation: z.string().nullable(),
  impact: z.string(),
  correlationId: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedById: z.string().nullable(),
  resolution: z.string().nullable(),
});
export type HumanReviewRequestListItem = z.infer<typeof humanReviewRequestListItemSchema>;
