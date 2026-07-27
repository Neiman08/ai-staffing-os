-- CreateEnum
CREATE TYPE "HumanReviewType" AS ENUM ('INVALID_CLASSIFICATION', 'CONTACT_AMBIGUOUS', 'CONTENT_RISK', 'POLICY_EXCEPTION', 'HIGH_VALUE_OPPORTUNITY', 'NEGOTIATION_REQUIRED', 'UNSAFE_REPLY', 'MEETING_CONFLICT', 'LEARNING_PROPOSAL', 'SYSTEM_FAILURE');

-- CreateEnum
CREATE TYPE "HumanReviewPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "HumanReviewRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "HumanReviewType" NOT NULL,
    "priority" "HumanReviewPriority" NOT NULL,
    "deadline" TIMESTAMP(3),
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "requestedDecision" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "recommendation" TEXT,
    "impact" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,

    CONSTRAINT "HumanReviewRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HumanReviewRequest_tenantId_resolvedAt_priority_idx" ON "HumanReviewRequest"("tenantId", "resolvedAt", "priority");

-- CreateIndex
CREATE INDEX "HumanReviewRequest_tenantId_entityType_entityId_type_idx" ON "HumanReviewRequest"("tenantId", "entityType", "entityId", "type");

-- CreateIndex
CREATE INDEX "HumanReviewRequest_tenantId_correlationId_idx" ON "HumanReviewRequest"("tenantId", "correlationId");

-- F25.2 Fase 5: dedup real a nivel de DB (docs/F25_AUTONOMY_POLICY_MODEL.md
-- §8: "nunca dos HumanReviewRequest abiertos para el mismo (entityType,
-- entityId, type) simultáneamente"). Índice único PARCIAL (solo filas con
-- resolvedAt NULL) -- Prisma no soporta índices únicos parciales en su DSL
-- (mismo patrón ya usado en F24 para ApprovalRequest_tenantId_companyId_active_unique),
-- por eso se agrega a mano acá. Un caso ya resuelto para la misma entidad+tipo
-- puede volver a abrirse más tarde sin chocar contra este constraint.
CREATE UNIQUE INDEX "HumanReviewRequest_open_dedup_unique"
  ON "HumanReviewRequest" ("tenantId", "entityType", "entityId", "type")
  WHERE "resolvedAt" IS NULL;
