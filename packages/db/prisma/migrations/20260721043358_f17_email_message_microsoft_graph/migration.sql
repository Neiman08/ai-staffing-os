-- CreateEnum
CREATE TYPE "EmailMessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'RETRYABLE');

-- CreateEnum
CREATE TYPE "EmailSenderProfile" AS ENUM ('COMMERCIAL', 'GENERAL', 'RECRUITING');

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "approvalRequestId" TEXT,
    "leadId" TEXT,
    "opportunityId" TEXT,
    "companyId" TEXT,
    "contactId" TEXT,
    "senderProfile" "EmailSenderProfile" NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "ccEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bccEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "replyTo" TEXT,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "bodyText" TEXT,
    "provider" TEXT NOT NULL,
    "status" "EmailMessageStatus" NOT NULL DEFAULT 'PENDING',
    "providerMessageId" TEXT,
    "conversationId" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailMessage_tenantId_status_idx" ON "EmailMessage"("tenantId", "status");

-- CreateIndex
CREATE INDEX "EmailMessage_tenantId_approvalRequestId_idx" ON "EmailMessage"("tenantId", "approvalRequestId");

-- CreateIndex
CREATE INDEX "EmailMessage_tenantId_leadId_idx" ON "EmailMessage"("tenantId", "leadId");

-- CreateIndex
CREATE INDEX "EmailMessage_tenantId_opportunityId_idx" ON "EmailMessage"("tenantId", "opportunityId");
