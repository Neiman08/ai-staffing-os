-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('INVITED', 'IN_PROGRESS', 'DOCUMENTS_PENDING', 'COMPLIANCE_REVIEW', 'READY', 'ACTIVE', 'BLOCKED', 'OFFBOARDED');

-- CreateTable
CREATE TABLE "WorkerOnboarding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobOrderId" TEXT NOT NULL,
    "workerId" TEXT,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'INVITED',
    "progress" INTEGER NOT NULL,
    "blockers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nextBestAction" TEXT NOT NULL,
    "rulesVersion" INTEGER NOT NULL,
    "startedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkerOnboarding_tenantId_jobOrderId_status_idx" ON "WorkerOnboarding"("tenantId", "jobOrderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerOnboarding_candidateId_jobOrderId_key" ON "WorkerOnboarding"("candidateId", "jobOrderId");

-- AddForeignKey
ALTER TABLE "WorkerOnboarding" ADD CONSTRAINT "WorkerOnboarding_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerOnboarding" ADD CONSTRAINT "WorkerOnboarding_jobOrderId_fkey" FOREIGN KEY ("jobOrderId") REFERENCES "JobOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerOnboarding" ADD CONSTRAINT "WorkerOnboarding_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

