-- CreateEnum
CREATE TYPE "ClientJobRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'CONVERTED_TO_JOB_ORDER', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ClientJobRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestedTitle" TEXT NOT NULL,
    "location" JSONB,
    "headcount" INTEGER NOT NULL,
    "shift" "ShiftType",
    "schedule" TEXT,
    "payRateExpectation" DECIMAL(10,2),
    "billBudget" DECIMAL(10,2),
    "desiredStartDate" TIMESTAMP(3) NOT NULL,
    "duration" TEXT,
    "requiredSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "certifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languageRequirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "physicalRequirements" TEXT,
    "notes" TEXT,
    "urgency" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "status" "ClientJobRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "reviewedById" TEXT,
    "reviewNotes" TEXT,
    "convertedJobOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientJobRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientJobRequest_convertedJobOrderId_key" ON "ClientJobRequest"("convertedJobOrderId");

-- CreateIndex
CREATE INDEX "ClientJobRequest_tenantId_companyId_status_idx" ON "ClientJobRequest"("tenantId", "companyId", "status");

-- CreateIndex
CREATE INDEX "ClientJobRequest_tenantId_status_idx" ON "ClientJobRequest"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "ClientJobRequest" ADD CONSTRAINT "ClientJobRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientJobRequest" ADD CONSTRAINT "ClientJobRequest_convertedJobOrderId_fkey" FOREIGN KEY ("convertedJobOrderId") REFERENCES "JobOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
