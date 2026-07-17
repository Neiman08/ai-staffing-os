-- CreateTable
CREATE TABLE "ScreeningPlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobOrderId" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "allowedDisqualifiers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "manualReviewFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingInformation" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rulesVersion" INTEGER NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL,
    "generatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScreeningPlan_tenantId_jobOrderId_idx" ON "ScreeningPlan"("tenantId", "jobOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningPlan_candidateId_jobOrderId_key" ON "ScreeningPlan"("candidateId", "jobOrderId");

-- AddForeignKey
ALTER TABLE "ScreeningPlan" ADD CONSTRAINT "ScreeningPlan_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningPlan" ADD CONSTRAINT "ScreeningPlan_jobOrderId_fkey" FOREIGN KEY ("jobOrderId") REFERENCES "JobOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

