import { useQuery } from "@tanstack/react-query";
import type { DiscoverySummary } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatCard } from "@/components/shared/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Building2,
  CheckCircle2,
  Copy,
  Globe,
  Mail,
  Phone,
  Search,
  UserSearch,
  AlertTriangle,
  DollarSign,
  Gauge,
  Radar,
} from "lucide-react";

/**
 * F4.5A: panel de External Discovery — agrega GET /discovery/summary,
 * todo dato real (nunca estimado ni inventado). Ver
 * docs/F4_5_EXTERNAL_DISCOVERY_AND_EMAIL_PLAN.md, addendum del piloto.
 */
export default function Discovery() {
  const { data, isLoading } = useQuery({
    queryKey: ["discovery", "summary"],
    queryFn: () => apiFetch<DiscoverySummary>("/discovery/summary"),
    refetchInterval: 5000,
  });

  if (isLoading || !data) {
    return (
      <div>
        <PageHeader
          title="External Discovery"
          description="Empresas reales descubiertas fuera del CRM por el Discovery Agent"
        />
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="External Discovery"
        description="Empresas reales descubiertas fuera del CRM por el Discovery Agent — piloto F4.5A, sin envío de mensajes"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Search} label="Empresas encontradas" value={String(data.companiesFound)} hint="candidatos vistos en la fuente" />
        <StatCard icon={Building2} label="Empresas nuevas" value={String(data.newCompaniesCreated)} accent="emerald" />
        <StatCard icon={Copy} label="Duplicados descartados" value={String(data.duplicatesSkipped)} accent="amber" />
        <StatCard icon={AlertTriangle} label="Sin datos suficientes" value={String(data.insufficientDataSkipped)} accent="amber" />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={CheckCircle2} label="Empresas verificadas" value={String(data.companiesVerified)} accent="emerald" />
        <StatCard icon={Globe} label="Sitios web encontrados" value={String(data.websitesFound)} />
        <StatCard icon={Phone} label="Teléfonos encontrados" value={String(data.phonesFound)} />
        <StatCard icon={Mail} label="Correos públicos encontrados" value={String(data.publicEmailsFound)} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={UserSearch}
          label="Contactos públicos encontrados"
          value={String(data.publicContactsFound)}
          hint="OSM no da nombres de personas — esperado en 0"
        />
        <StatCard icon={DollarSign} label="Costo IA" value={`$${data.costUsd.toFixed(4)}`} />
        <StatCard
          icon={DollarSign}
          label="Costo por empresa útil"
          value={data.costPerUsefulCompanyUsd != null ? `$${data.costPerUsefulCompanyUsd.toFixed(4)}` : "—"}
        />
        <StatCard
          icon={Gauge}
          label="Confidence promedio"
          value={data.averageConfidence != null ? `${Math.round(data.averageConfidence * 100)}%` : "—"}
        />
      </div>

      <Card className="mt-4 card-hover">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radar className="h-4 w-4" />
            Fuentes utilizadas
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {data.sourcesUsed.length ? (
            data.sourcesUsed.map((s) => (
              <Badge key={s} variant="neutral">
                {s}
              </Badge>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">Sin misiones de descubrimiento corridas todavía.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
