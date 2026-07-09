-- CreateEnum
CREATE TYPE "CompanySize" AS ENUM ('MICRO', 'SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "ContactDecisionRole" AS ENUM ('OWNER', 'HR', 'OPERATIONS_MANAGER', 'PROJECT_MANAGER', 'PLANT_MANAGER', 'RECRUITER', 'OTHER');

-- CreateEnum
CREATE TYPE "FollowUpType" AS ENUM ('CALL', 'EMAIL', 'LINKEDIN', 'MEETING');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'DONE', 'SNOOZED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "LeadStatus" ADD VALUE 'INTERESTED';

-- AlterEnum
BEGIN;
CREATE TYPE "OpportunityStage_new" AS ENUM ('MEETING_SCHEDULED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON', 'LOST');
ALTER TABLE "Opportunity" ALTER COLUMN "stage" DROP DEFAULT;
ALTER TABLE "Opportunity" ALTER COLUMN "stage" TYPE "OpportunityStage_new" USING ("stage"::text::"OpportunityStage_new");
ALTER TYPE "OpportunityStage" RENAME TO "OpportunityStage_old";
ALTER TYPE "OpportunityStage_new" RENAME TO "OpportunityStage";
DROP TYPE "OpportunityStage_old";
ALTER TABLE "Opportunity" ALTER COLUMN "stage" SET DEFAULT 'MEETING_SCHEDULED';
COMMIT;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "city" TEXT,
ADD COLUMN     "commercialScore" DOUBLE PRECISION,
ADD COLUMN     "estimatedSize" "CompanySize",
ADD COLUMN     "state" TEXT;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "decisionRole" "ContactDecisionRole",
ADD COLUMN     "linkedinUrl" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "city" TEXT,
ADD COLUMN     "industryId" TEXT,
ADD COLUMN     "priority" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "state" TEXT;

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "estimatedBillRate" DECIMAL(10,2),
ADD COLUMN     "estimatedPayRate" DECIMAL(10,2),
ALTER COLUMN "stage" SET DEFAULT 'MEETING_SCHEDULED';

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" "FollowUpType" NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "priority" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "assignedToId" TEXT,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "reminderAt" TIMESTAMP(3),
    "notes" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CompanyPossibleCategories" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "FollowUp_tenantId_status_dueDate_idx" ON "FollowUp"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "FollowUp_tenantId_entityType_entityId_idx" ON "FollowUp"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "_CompanyPossibleCategories_AB_unique" ON "_CompanyPossibleCategories"("A", "B");

-- CreateIndex
CREATE INDEX "_CompanyPossibleCategories_B_index" ON "_CompanyPossibleCategories"("B");

-- CreateIndex
CREATE INDEX "Company_tenantId_state_idx" ON "Company"("tenantId", "state");

-- CreateIndex
CREATE INDEX "Lead_tenantId_industryId_idx" ON "Lead"("tenantId", "industryId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "JobCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CompanyPossibleCategories" ADD CONSTRAINT "_CompanyPossibleCategories_A_fkey" FOREIGN KEY ("A") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CompanyPossibleCategories" ADD CONSTRAINT "_CompanyPossibleCategories_B_fkey" FOREIGN KEY ("B") REFERENCES "JobCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

