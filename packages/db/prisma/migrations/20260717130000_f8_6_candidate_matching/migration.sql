-- CreateEnum
CREATE TYPE "MatchConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "CandidateMatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobOrderId" TEXT NOT NULL,
    "qualificationStatus" "QualificationStatus" NOT NULL,
    "recommendable" BOOLEAN NOT NULL,
    "needsReview" BOOLEAN NOT NULL,
    "hardConstraints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "softPreferences" JSONB NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "normalizedScore" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER,
    "explanation" TEXT NOT NULL,
    "confidence" "MatchConfidence" NOT NULL,
    "missingData" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "risks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rulesVersion" INTEGER NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CandidateMatch_tenantId_jobOrderId_rank_idx" ON "CandidateMatch"("tenantId", "jobOrderId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateMatch_candidateId_jobOrderId_key" ON "CandidateMatch"("candidateId", "jobOrderId");

-- AddForeignKey
ALTER TABLE "CandidateMatch" ADD CONSTRAINT "CandidateMatch_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateMatch" ADD CONSTRAINT "CandidateMatch_jobOrderId_fkey" FOREIGN KEY ("jobOrderId") REFERENCES "JobOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

