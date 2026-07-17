-- CreateEnum
CREATE TYPE "QualificationStatus" AS ENUM ('QUALIFIED', 'POSSIBLY_QUALIFIED', 'NEEDS_REVIEW', 'NOT_QUALIFIED');

-- CreateTable
CREATE TABLE "CandidateQualification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobOrderId" TEXT NOT NULL,
    "status" "QualificationStatus" NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hardDisqualifiers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rulesVersion" INTEGER NOT NULL,
    "evaluatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateQualification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CandidateQualification_tenantId_status_idx" ON "CandidateQualification"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateQualification_candidateId_jobOrderId_key" ON "CandidateQualification"("candidateId", "jobOrderId");

-- AddForeignKey
ALTER TABLE "CandidateQualification" ADD CONSTRAINT "CandidateQualification_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateQualification" ADD CONSTRAINT "CandidateQualification_jobOrderId_fkey" FOREIGN KEY ("jobOrderId") REFERENCES "JobOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

