-- CreateEnum
CREATE TYPE "PlacementReadinessStatus" AS ENUM ('NOT_READY', 'NEEDS_REVIEW', 'CONDITIONALLY_READY', 'READY_FOR_APPROVAL');

-- CreateTable
CREATE TABLE "PlacementReadiness" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobOrderId" TEXT NOT NULL,
    "readinessStatus" "PlacementReadinessStatus" NOT NULL,
    "score" INTEGER NOT NULL,
    "blockers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "completedChecks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pendingChecks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingInformation" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nextBestAction" TEXT NOT NULL,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "rulesVersion" INTEGER NOT NULL,
    "evaluatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlacementReadiness_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlacementReadiness_tenantId_jobOrderId_readinessStatus_idx" ON "PlacementReadiness"("tenantId", "jobOrderId", "readinessStatus");

-- CreateIndex
CREATE UNIQUE INDEX "PlacementReadiness_candidateId_jobOrderId_key" ON "PlacementReadiness"("candidateId", "jobOrderId");

-- AddForeignKey
ALTER TABLE "PlacementReadiness" ADD CONSTRAINT "PlacementReadiness_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlacementReadiness" ADD CONSTRAINT "PlacementReadiness_jobOrderId_fkey" FOREIGN KEY ("jobOrderId") REFERENCES "JobOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

