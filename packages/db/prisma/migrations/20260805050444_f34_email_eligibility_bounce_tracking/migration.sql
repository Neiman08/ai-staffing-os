-- AlterTable
ALTER TABLE "CompanyContactPoint" ADD COLUMN     "lastBounceAt" TIMESTAMP(3),
ADD COLUMN     "lastBounceClassification" TEXT,
ADD COLUMN     "permanentlyInvalidAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "lastBounceAt" TIMESTAMP(3),
ADD COLUMN     "lastBounceClassification" TEXT;
