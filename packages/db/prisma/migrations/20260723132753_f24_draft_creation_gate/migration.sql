-- CreateEnum
CREATE TYPE "OutreachBlockReason" AS ENUM ('NEEDS_ENRICHMENT', 'CLIENT_OWNER_REVIEW');

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "companyId" TEXT;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "outreachBlockedAt" TIMESTAMP(3),
ADD COLUMN     "outreachBlockedReason" "OutreachBlockReason";

-- CreateIndex
CREATE INDEX "ApprovalRequest_tenantId_companyId_idx" ON "ApprovalRequest"("tenantId", "companyId");

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- F24: índice único PARCIAL -- protección real a nivel de base de datos
-- contra la condición de carrera de Fase 2 (dos requests concurrentes
-- creando un ApprovalRequest para la misma Company). Prisma no soporta
-- unique constraints parciales en el DSL del schema, así que se agrega
-- acá a mano. Solo aplica cuando companyId no es null Y el status es
-- "activo" (todavía puede terminar en un envío real) -- nunca bloquea
-- crear un nuevo borrador para una Company cuyo borrador anterior ya
-- terminó su ciclo de vida (SENT/FAILED/REJECTED/EXPIRED). Filas
-- históricas con companyId NULL (creadas antes de esta migración) nunca
-- entran en este índice -- no se backfillean, no se tocan datos
-- existentes.
CREATE UNIQUE INDEX "ApprovalRequest_tenantId_companyId_active_unique"
ON "ApprovalRequest" ("tenantId", "companyId")
WHERE "companyId" IS NOT NULL AND "status" IN ('PENDING', 'READY_TO_SEND', 'SENDING');
