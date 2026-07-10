-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CampaignCompanyStatus" AS ENUM ('TARGETED', 'SEQUENCING', 'HOT', 'COLD', 'RECOVERED', 'CONVERTED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "ConversationIntent" AS ENUM ('INTERESTED', 'VERY_INTERESTED', 'CALL_LATER', 'NO_BUDGET', 'HAS_PROVIDER', 'NOT_INTERESTED', 'OUT_OF_MARKET');

-- AlterTable
ALTER TABLE "FollowUp" ADD COLUMN     "campaignId" TEXT;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "industryId" TEXT,
    "state" TEXT,
    "city" TEXT,
    "minCompanySize" "CompanySize",
    "maxCompanySize" "CompanySize",
    "targetCategoryIds" JSONB NOT NULL DEFAULT '[]',
    "minScore" DOUBLE PRECISION,
    "priority" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "createdByAgentTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignCompany" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" "CampaignCompanyStatus" NOT NULL DEFAULT 'TARGETED',
    "lastIntent" "ConversationIntent",
    "lastIntentAt" TIMESTAMP(3),
    "createdByAgentTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignCompany_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_tenantId_status_idx" ON "Campaign"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CampaignCompany_tenantId_status_idx" ON "CampaignCompany"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignCompany_campaignId_companyId_key" ON "CampaignCompany"("campaignId", "companyId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCompany" ADD CONSTRAINT "CampaignCompany_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCompany" ADD CONSTRAINT "CampaignCompany_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
