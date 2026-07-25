-- F27 Fase 7: caché real de Hunter.io Domain Search por (tenant, dominio) --
-- aditiva, ninguna columna/tabla existente se toca. Ver comentario en
-- hunter-domain-cache.ts para el motivo (free tier de 25 búsquedas/mes,
-- nunca repetir la misma consulta real dentro de la ventana de caché).

CREATE TABLE "HunterDomainSearchCache" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "queriedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "candidates" JSONB NOT NULL,
    "patternsFailed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "providerStatus" TEXT NOT NULL,

    CONSTRAINT "HunterDomainSearchCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HunterDomainSearchCache_tenantId_domain_key" ON "HunterDomainSearchCache"("tenantId", "domain");
CREATE INDEX "HunterDomainSearchCache_tenantId_queriedAt_idx" ON "HunterDomainSearchCache"("tenantId", "queriedAt");
