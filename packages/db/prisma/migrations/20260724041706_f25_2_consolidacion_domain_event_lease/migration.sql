-- AlterTable
ALTER TABLE "DomainEvent" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedBy" TEXT,
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "DomainEvent_processedAt_leaseExpiresAt_idx" ON "DomainEvent"("processedAt", "leaseExpiresAt");
