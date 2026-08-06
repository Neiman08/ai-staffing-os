-- DropIndex
DROP INDEX "DiscoveryQueryExecution_tenantId_normalizedQuery_state_exec_idx";

-- AlterTable
ALTER TABLE "DiscoveryQueryExecution" ADD COLUMN     "city" TEXT;

-- CreateIndex
CREATE INDEX "DiscoveryQueryExecution_tenantId_normalizedQuery_state_city_idx" ON "DiscoveryQueryExecution"("tenantId", "normalizedQuery", "state", "city", "executedAt");
