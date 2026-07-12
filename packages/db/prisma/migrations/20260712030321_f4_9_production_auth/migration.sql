-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('NOT_INVITED', 'PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "clerkOrganizationId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "invitationStatus" "InvitationStatus" NOT NULL DEFAULT 'NOT_INVITED',
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_clerkOrganizationId_key" ON "Tenant"("clerkOrganizationId");
