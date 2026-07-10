-- CreateEnum
CREATE TYPE "ContactVerificationStatus" AS ENUM ('UNVERIFIED', 'CONFIRMED', 'INFERRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ContactDecisionRole" ADD VALUE 'TALENT_ACQUISITION';
ALTER TYPE "ContactDecisionRole" ADD VALUE 'WAREHOUSE_MANAGER';
ALTER TYPE "ContactDecisionRole" ADD VALUE 'GENERAL_MANAGER';
ALTER TYPE "ContactDecisionRole" ADD VALUE 'PURCHASING_MANAGER';
ALTER TYPE "ContactDecisionRole" ADD VALUE 'DIRECTOR_OF_OPERATIONS';

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "confidenceScore" DOUBLE PRECISION,
ADD COLUMN     "discoveredAt" TIMESTAMP(3),
ADD COLUMN     "discoveredByAgentTaskId" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "verificationStatus" "ContactVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED';
