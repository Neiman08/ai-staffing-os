-- CreateEnum
CREATE TYPE "CompanyCommercialStatus" AS ENUM ('DISCOVERY_CANDIDATE', 'COMMERCIAL_VALIDATED');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "commercialStatus" "CompanyCommercialStatus" NOT NULL DEFAULT 'COMMERCIAL_VALIDATED';

-- CreateIndex
CREATE INDEX "Company_tenantId_commercialStatus_idx" ON "Company"("tenantId", "commercialStatus");
