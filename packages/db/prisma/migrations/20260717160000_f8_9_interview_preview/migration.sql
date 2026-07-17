-- CreateEnum
CREATE TYPE "InterviewModality" AS ENUM ('PHONE', 'VIDEO', 'IN_PERSON');

-- CreateEnum
CREATE TYPE "InterviewPreviewStatus" AS ENUM ('DRAFT', 'NEEDS_AVAILABILITY', 'READY_FOR_APPROVAL', 'APPROVED_FOR_SEND', 'CANCELLED');

-- CreateTable
CREATE TABLE "InterviewPreview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobOrderId" TEXT NOT NULL,
    "status" "InterviewPreviewStatus" NOT NULL DEFAULT 'DRAFT',
    "proposedWindows" JSONB NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "modality" "InterviewModality" NOT NULL,
    "locationOrLink" TEXT,
    "participants" JSONB NOT NULL,
    "restrictions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conflicts" JSONB NOT NULL,
    "availabilityConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "missingInformation" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rulesVersion" INTEGER NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewPreview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InterviewPreview_tenantId_jobOrderId_status_idx" ON "InterviewPreview"("tenantId", "jobOrderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewPreview_candidateId_jobOrderId_key" ON "InterviewPreview"("candidateId", "jobOrderId");

-- AddForeignKey
ALTER TABLE "InterviewPreview" ADD CONSTRAINT "InterviewPreview_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewPreview" ADD CONSTRAINT "InterviewPreview_jobOrderId_fkey" FOREIGN KEY ("jobOrderId") REFERENCES "JobOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

