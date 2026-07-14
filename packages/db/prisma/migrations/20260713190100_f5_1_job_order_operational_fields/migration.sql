-- AlterTable
ALTER TABLE "JobOrder" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "description" TEXT,
ALTER COLUMN "status" SET DEFAULT 'DRAFT';
