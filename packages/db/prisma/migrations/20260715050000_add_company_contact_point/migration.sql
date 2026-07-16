-- CreateEnum
CREATE TYPE "CompanyContactPointType" AS ENUM ('INFO', 'SALES', 'HR', 'RECRUITING', 'CAREERS', 'SUPPORT', 'PRESS', 'BILLING', 'PROCUREMENT', 'OTHER');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "discoveryMetadata" JSONB;

-- CreateTable
CREATE TABLE "CompanyContactPoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "type" "CompanyContactPointType" NOT NULL DEFAULT 'OTHER',
    "sourceUrl" TEXT,
    "discoveryProvider" TEXT,
    "verificationProvider" TEXT,
    "verificationStatus" "EmailVerificationStatus" NOT NULL DEFAULT 'NOT_VERIFIED',
    "confidenceScore" DOUBLE PRECISION,
    "discoveredAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyContactPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyContactPoint_tenantId_idx" ON "CompanyContactPoint"("tenantId");

-- CreateIndex
CREATE INDEX "CompanyContactPoint_tenantId_verificationStatus_idx" ON "CompanyContactPoint"("tenantId", "verificationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyContactPoint_companyId_email_key" ON "CompanyContactPoint"("companyId", "email");

-- AddForeignKey
ALTER TABLE "CompanyContactPoint" ADD CONSTRAINT "CompanyContactPoint_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
