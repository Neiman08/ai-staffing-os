-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "availabilityNotes" TEXT,
ADD COLUMN     "skills" TEXT[] DEFAULT ARRAY[]::TEXT[];
