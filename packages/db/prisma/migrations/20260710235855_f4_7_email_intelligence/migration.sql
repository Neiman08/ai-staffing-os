-- CreateEnum
CREATE TYPE "EmailVerificationStatus" AS ENUM ('NOT_VERIFIED', 'VERIFIED', 'RISKY', 'INVALID', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "bouncedAt" TIMESTAMP(3),
ADD COLUMN     "doNotContact" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailConfidenceScore" DOUBLE PRECISION,
ADD COLUMN     "emailDiscoveredAt" TIMESTAMP(3),
ADD COLUMN     "emailDiscoveryProvider" TEXT,
ADD COLUMN     "emailSource" TEXT,
ADD COLUMN     "emailSourceUrl" TEXT,
ADD COLUMN     "emailVerificationProvider" TEXT,
ADD COLUMN     "emailVerificationStatus" "EmailVerificationStatus" NOT NULL DEFAULT 'NOT_VERIFIED',
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "unsubscribedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Contact_tenantId_emailVerificationStatus_idx" ON "Contact"("tenantId", "emailVerificationStatus");
