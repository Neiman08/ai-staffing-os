-- CreateEnum
CREATE TYPE "ContactRankingTier" AS ENUM ('HIGH_CONFIDENCE', 'MEDIUM_CONFIDENCE', 'LOW_CONFIDENCE', 'REJECTED');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "rankedAt" TIMESTAMP(3),
ADD COLUMN     "rankingReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "rankingScore" DOUBLE PRECISION,
ADD COLUMN     "rankingTier" "ContactRankingTier";

-- CreateIndex
CREATE INDEX "Contact_tenantId_rankingTier_idx" ON "Contact"("tenantId", "rankingTier");

