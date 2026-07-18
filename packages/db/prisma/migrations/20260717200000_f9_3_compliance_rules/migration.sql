-- CreateEnum
CREATE TYPE "ComplianceEvaluationStatus" AS ENUM ('NOT_EVALUATED', 'INCOMPLETE', 'NEEDS_REVIEW', 'BLOCKED', 'READY');

-- CreateTable
CREATE TABLE "ComplianceRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT,
    "industryId" TEXT,
    "companyId" TEXT,
    "jobCategoryId" TEXT,
    "assignmentType" "EmploymentType",
    "requiredDocumentTypeKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceRuleEvaluation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "jobOrderId" TEXT NOT NULL,
    "requiredChecks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "satisfiedChecks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingChecks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiredChecks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "manualReviewFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "complianceStatus" "ComplianceEvaluationStatus" NOT NULL,
    "rulesVersion" INTEGER NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "evaluatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceRuleEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplianceRule_tenantId_active_idx" ON "ComplianceRule"("tenantId", "active");

-- CreateIndex
CREATE INDEX "ComplianceRuleEvaluation_tenantId_jobOrderId_complianceStat_idx" ON "ComplianceRuleEvaluation"("tenantId", "jobOrderId", "complianceStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRuleEvaluation_workerId_jobOrderId_key" ON "ComplianceRuleEvaluation"("workerId", "jobOrderId");

-- AddForeignKey
ALTER TABLE "ComplianceRule" ADD CONSTRAINT "ComplianceRule_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRule" ADD CONSTRAINT "ComplianceRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRule" ADD CONSTRAINT "ComplianceRule_jobCategoryId_fkey" FOREIGN KEY ("jobCategoryId") REFERENCES "JobCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRuleEvaluation" ADD CONSTRAINT "ComplianceRuleEvaluation_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRuleEvaluation" ADD CONSTRAINT "ComplianceRuleEvaluation_jobOrderId_fkey" FOREIGN KEY ("jobOrderId") REFERENCES "JobOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

