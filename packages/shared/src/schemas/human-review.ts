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
