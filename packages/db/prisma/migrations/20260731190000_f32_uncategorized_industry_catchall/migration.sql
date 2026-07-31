-- F32 (auditoría arquitectónica, hallazgo real MIS-20260731-0002/0003,
-- decisión explícita del PO 2026-07-31): Company.industryId es NOT NULL,
-- así que ningún candidato con crmIndustryBucket=null (cualquier entrada
-- de BUSINESS_TAXONOMY con ese valor -- healthcare/janitorial/
-- commercial_cleaning/restaurants/retail -- o cualquier término literal
-- que la taxonomía no reconoce todavía) podía persistirse jamás, sin
-- importar cuán buena fuera su evidencia real.
--
-- Este catch-all ya se agregó a prisma/seed.ts (id fijo
-- "industry-uncategorized", isGlobal, tenantId=null, mismo patrón que
-- Hospitality/Landscaping & Lawn Care en su momento) -- correr el seed
-- manualmente contra producción requiere acceso a Render Shell, un paso
-- humano que no siempre está disponible de inmediato. Esta migración
-- entrega el mismo dato de forma idempotente y automática: Render ya
-- corre `prisma migrate deploy` en cada build/deploy (ver
-- docs/RENDER_DEPLOYMENT.md), así que este INSERT aditivo llega solo,
-- sin depender de un paso manual adicional -- consistente con el resto
-- del historial de migraciones. ON CONFLICT DO NOTHING la hace segura
-- de re-ejecutar (no pisa una fila ya sembrada manualmente con el mismo
-- id).
INSERT INTO "Industry" ("id", "tenantId", "name", "isGlobal")
VALUES ('industry-uncategorized', NULL, 'Uncategorized', true)
ON CONFLICT ("id") DO NOTHING;
