-- CreateEnum
CREATE TYPE "ShortlistReviewStatus" AS ENUM ('DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'HOLD', 'REMOVED');

-- CreateTable
CREATE TABLE "CandidateShortlistEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobOrderId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "normalizedScore" DOUBLE PRECISION NOT NULL,
    "qualificationStatus" "QualificationStatus" NOT NULL,
    "confidence" "MatchConfidence" NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gaps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "risks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewStatus" "ShortlistReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "addedById" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateShortlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CandidateShortlistEntry_tenantId_jobOrderId_rank_idx" ON "CandidateShortlistEntry"("tenantId", "jobOrderId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateShortlistEntry_candidateId_jobOrderId_key" ON "CandidateShortlistEntry"("candidateId", "jobOrderId");

-- AddForeignKey
ALTER TABLE "CandidateShortlistEntry" ADD CONSTRAINT "CandidateShortlistEntry_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateShortlistEntry" ADD CONSTRAINT "CandidateShortlistEntry_jobOrderId_fkey" FOREIGN KEY ("jobOrderId") REFERENCES "JobOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

