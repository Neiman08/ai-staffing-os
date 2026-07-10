-- CreateEnum
CREATE TYPE "CompanyOrigin" AS ENUM ('DEMO_SEED', 'MANUAL', 'CSV_IMPORT', 'EXTERNAL_DISCOVERY', 'API_PROVIDER');

-- CreateEnum
CREATE TYPE "CompanyVerificationStatus" AS ENUM ('UNVERIFIED', 'CONFIRMED', 'INFERRED');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "confidenceScore" DOUBLE PRECISION,
ADD COLUMN     "discoveredAt" TIMESTAMP(3),
ADD COLUMN     "discoveredByAgentTaskId" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "lastVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "origin" "CompanyOrigin" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sourceUrl" TEXT,
ADD COLUMN     "verificationStatus" "CompanyVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED';

-- CreateIndex
CREATE INDEX "Company_tenantId_origin_idx" ON "Company"("tenantId", "origin");
