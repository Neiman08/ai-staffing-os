-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TimeEntryStatus" ADD VALUE 'DRAFT';
ALTER TYPE "TimeEntryStatus" ADD VALUE 'SUBMITTED';
ALTER TYPE "TimeEntryStatus" ADD VALUE 'NEEDS_REVIEW';
ALTER TYPE "TimeEntryStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "clockInAt" TIMESTAMP(3),
ADD COLUMN     "clockOutAt" TIMESTAMP(3),
ADD COLUMN     "discrepancyFlag" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "discrepancyNotes" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "overtimeFlag" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rejectionReason" TEXT;

