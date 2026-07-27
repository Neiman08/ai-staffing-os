-- F27 Fase 11 (reconciliación retroactiva de mensajes legados SENT):
-- nuevo estado RESOLVED, distinto de ACKNOWLEDGED (ese es una decisión
-- humana) -- este es el reconciliador encontrando, de forma automática,
-- el EmailMessage real que explica una alerta. Aditiva -- ningún valor
-- ni fila existente se toca.

ALTER TYPE "EmailReconciliationAlertStatus" ADD VALUE 'RESOLVED';

ALTER TABLE "EmailReconciliationAlert" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "EmailReconciliationAlert" ADD COLUMN "resolvedEmailMessageId" TEXT;
