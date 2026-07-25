-- F27 (endurecimiento de trazabilidad de email): migración puramente
-- aditiva. Ninguna columna/valor de enum existente se toca ni se
-- renombra; todas las columnas nuevas son NULLABLE y todos los valores
-- de enum nuevos se agregan sin remover los existentes. Ninguna fila
-- existente cambia de significado.

-- 1. Nuevos valores del enum EmailMessageStatus (SENT queda legado, ver
--    comentario en schema.prisma -- ningún código nuevo lo escribe).
ALTER TYPE "EmailMessageStatus" ADD VALUE 'ACCEPTED_BY_PROVIDER';
ALTER TYPE "EmailMessageStatus" ADD VALUE 'SENT_CONFIRMED';
ALTER TYPE "EmailMessageStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "EmailMessageStatus" ADD VALUE 'BOUNCED';
ALTER TYPE "EmailMessageStatus" ADD VALUE 'DELIVERY_UNKNOWN';

-- 2. Nuevas columnas en EmailMessage -- todas opcionales.
ALTER TABLE "EmailMessage" ADD COLUMN "internetMessageId" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "correlationId" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "acceptedAt" TIMESTAMP(3);
ALTER TABLE "EmailMessage" ADD COLUMN "sentItemsConfirmedAt" TIMESTAMP(3);
ALTER TABLE "EmailMessage" ADD COLUMN "lastCheckedAt" TIMESTAMP(3);
ALTER TABLE "EmailMessage" ADD COLUMN "ndrReceivedAt" TIMESTAMP(3);
ALTER TABLE "EmailMessage" ADD COLUMN "ndrDetail" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "normalizedError" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "graphClientRequestId" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "httpStatusCode" INTEGER;
ALTER TABLE "EmailMessage" ADD COLUMN "actorType" "ActorType";
ALTER TABLE "EmailMessage" ADD COLUMN "actorId" TEXT;

CREATE UNIQUE INDEX "EmailMessage_correlationId_key" ON "EmailMessage"("correlationId");
CREATE INDEX "EmailMessage_tenantId_internetMessageId_idx" ON "EmailMessage"("tenantId", "internetMessageId");
CREATE INDEX "EmailMessage_status_acceptedAt_idx" ON "EmailMessage"("status", "acceptedAt");

-- 3. Nueva tabla: alertas de reconciliación para mensajes reales
--    encontrados en Sent Items sin EmailMessage correspondiente.
CREATE TYPE "EmailReconciliationAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'DISMISSED');

CREATE TABLE "EmailReconciliationAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "graphMessageId" TEXT NOT NULL,
    "internetMessageId" TEXT,
    "subject" TEXT,
    "toRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sentDateTime" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "EmailReconciliationAlertStatus" NOT NULL DEFAULT 'OPEN',
    "evidence" JSONB,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailReconciliationAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailReconciliationAlert_tenantId_mailbox_graphMessageId_key" ON "EmailReconciliationAlert"("tenantId", "mailbox", "graphMessageId");
CREATE INDEX "EmailReconciliationAlert_tenantId_status_idx" ON "EmailReconciliationAlert"("tenantId", "status");
