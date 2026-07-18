-- CreateEnum
CREATE TYPE "PlacementStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'READY_FOR_ONBOARDING', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Placement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "workerId" TEXT,
    "companyId" TEXT NOT NULL,
    "jobOrderId" TEXT NOT NULL,
    "payRate" DECIMAL(10,2),
    "billRate" DECIMAL(10,2),
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "shiftType" "ShiftType",
    "status" "PlacementStatus" NOT NULL DEFAULT 'DRAFT',
    "blockers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approverId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Placement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Placement_tenantId_jobOrderId_status_idx" ON "Placement"("tenantId", "jobOrderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Placement_candidateId_jobOrderId_key" ON "Placement"("candidateId", "jobOrderId");

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_jobOrderId_fkey" FOREIGN KEY ("jobOrderId") REFERENCES "JobOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

