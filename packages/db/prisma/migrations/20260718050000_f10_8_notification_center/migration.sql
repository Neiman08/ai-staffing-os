-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'JOB_REQUEST_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'JOB_REQUEST_NEEDS_INFORMATION';
ALTER TYPE "NotificationType" ADD VALUE 'SHORTLIST_READY';
ALTER TYPE "NotificationType" ADD VALUE 'DOCUMENT_REQUIRED';
ALTER TYPE "NotificationType" ADD VALUE 'DOCUMENT_EXPIRING';
ALTER TYPE "NotificationType" ADD VALUE 'ONBOARDING_BLOCKED';
ALTER TYPE "NotificationType" ADD VALUE 'ASSIGNMENT_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'SCHEDULE_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'TIME_ENTRY_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'TIME_ENTRY_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'INCIDENT_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'COMPLIANCE_ACTION_REQUIRED';
ALTER TYPE "NotificationType" ADD VALUE 'PLACEMENT_READY';
ALTER TYPE "NotificationType" ADD VALUE 'SYSTEM_NOTICE';

-- AlterTable
ALTER TABLE "Notification" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "Notification" ADD COLUMN     "recipientRole" TEXT,
ADD COLUMN     "entityType" TEXT,
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "priority" "Severity" NOT NULL DEFAULT 'MEDIUM';

-- CreateIndex
CREATE INDEX "Notification_tenantId_recipientRole_readAt_idx" ON "Notification"("tenantId", "recipientRole", "readAt");

-- CreateIndex
CREATE INDEX "Notification_tenantId_entityType_entityId_idx" ON "Notification"("tenantId", "entityType", "entityId");
