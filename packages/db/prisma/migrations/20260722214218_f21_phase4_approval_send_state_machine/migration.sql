-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalStatus" ADD VALUE 'READY_TO_SEND';
ALTER TYPE "ApprovalStatus" ADD VALUE 'SENDING';
ALTER TYPE "ApprovalStatus" ADD VALUE 'SENT';
ALTER TYPE "ApprovalStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "sentById" TEXT;
