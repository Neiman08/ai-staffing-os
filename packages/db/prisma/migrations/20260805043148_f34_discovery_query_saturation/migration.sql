-- CreateTable
CREATE TABLE "DiscoveryQueryExecution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "missionTaskId" TEXT,
    "normalizedQuery" TEXT NOT NULL,
    "rawQuery" TEXT NOT NULL,
    "taxonomyKey" TEXT,
    "crmIndustryBucket" TEXT,
    "state" TEXT,
    "provider" TEXT NOT NULL,
    "rawResultCount" INTEGER NOT NULL,
    "acceptedCount" INTEGER NOT NULL,
    "duplicateCount" INTEGER NOT NULL,
    "rejectedCount" INTEGER NOT NULL,
    "costUsd" DECIMAL(10,4),
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryQueryExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscoveryQueryExecution_tenantId_normalizedQuery_state_exec_idx" ON "DiscoveryQueryExecution"("tenantId", "normalizedQuery", "state", "executedAt");

-- CreateIndex
CREATE INDEX "DiscoveryQueryExecution_tenantId_taxonomyKey_state_executed_idx" ON "DiscoveryQueryExecution"("tenantId", "taxonomyKey", "state", "executedAt");
