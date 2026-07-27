-- CreateEnum
CREATE TYPE "AgentErrorCategory" AS ENUM ('RETRYABLE_NETWORK', 'RETRYABLE_PROVIDER', 'RETRYABLE_RATE_LIMIT', 'RETRYABLE_TIMEOUT', 'INVALID_INPUT', 'POLICY_BLOCKED', 'DATA_INSUFFICIENT', 'PERMANENT_PROVIDER_ERROR', 'HUMAN_ACTION_REQUIRED', 'UNKNOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentTaskStatus" ADD VALUE 'CLAIMED';
ALTER TYPE "AgentTaskStatus" ADD VALUE 'RETRY_SCHEDULED';
ALTER TYPE "AgentTaskStatus" ADD VALUE 'BLOCKED';
ALTER TYPE "AgentTaskStatus" ADD VALUE 'CANCELED';

-- AlterTable
ALTER TABLE "AgentTask" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "canceledAt" TIMESTAMP(3),
ADD COLUMN     "canceledBy" TEXT,
ADD COLUMN     "causationId" TEXT,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedBy" TEXT,
ADD COLUMN     "correlationId" TEXT,
ADD COLUMN     "lastErrorCategory" "AgentErrorCategory",
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AgentTask_status_nextAttemptAt_idx" ON "AgentTask"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AgentTask_tenantId_correlationId_idx" ON "AgentTask"("tenantId", "correlationId");
