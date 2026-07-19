-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "conversionRule" TEXT,
ADD COLUMN     "reviewRequired" BOOLEAN NOT NULL DEFAULT false;
