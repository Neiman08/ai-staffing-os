-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AssignmentStatus" ADD VALUE 'DRAFT';
ALTER TYPE "AssignmentStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "AssignmentStatus" ADD VALUE 'PAUSED';
ALTER TYPE "AssignmentStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "placementId" TEXT;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "Placement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

