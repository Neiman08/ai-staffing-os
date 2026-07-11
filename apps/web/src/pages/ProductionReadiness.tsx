import { useQuery } from "@tanstack/react-query";
import type {
  CleanupPlan,
  DataOrigin,
  DuplicatesReport,
  ProductionAuditReport,
  ProductionReadinessSummary,
} from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel } from "@/lib/status";

const DATA_ORIGINS: DataOrigin[] = [
  "DEMO",
  "SEED",
  "MANUAL",
  "GOOGLE_PLACES",
  "PEOPLE_DATA_LABS",
  "WEBSITE",
  "HUNTER",
  "API_PROVIDER",
  "IMPORT",
  "USER_CREATED",
  "UNKNOWN",
];

function MetricCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "success" | "warning" | "danger" }) {
  const toneClass = tone === "success" ? "text-emerald-600 dark:text-emerald-400" : tone === "warning" ? "text-amber-600 dark:text-amber-400" : tone === "danger" ? "text-red-600 dark:text-red-400" : "";
  return (
    <Card className="card-hover">
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export default function ProductionReadiness() {
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["production-readiness-summary"],
    queryFn: () => apiFetch<ProductionReadinessSummary>("/production-readiness/summary"),
  });
  const { data: audit } = useQuery({
    queryKey: ["production-readiness-audit"],
    queryFn: () => apiFetch<ProductionAuditReport>("/production-readiness/audit"),
  });
  const { data: duplicates } = useQuery({
    queryKey: ["production-readiness-duplicates"],
    queryFn: () => apiFetch<DuplicatesReport>("/production-readiness/duplicates"),
  });
  const { data: cleanupPlan } = useQuery({
    queryKey: ["production-readiness-cleanup-plan"],
    queryFn: () => apiFetch<CleanupPlan>("/production-readiness/cleanup-plan"),
  });

  return (
    <div>
      <PageHeader
        title="Production Readiness"
        description="Auditoría de procedencia de datos, duplicados y calidad — solo lectura, nada se borra ni se fusiona desde acá (F4.7.5)"
      />

      {summary?.productionMode === false && (
        <Card className="mb-4 border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-4 text-sm text-amber-700 dark:text-amber-400">
            <strong>Production Mode: OFF.</strong> Datos demo permitidos, seed.ts puede correr, regresión libre. Nadie activó
            Production Mode todavía — es una decisión explícita pendiente del Product Owner.
          </CardContent>
        </Card>
      )}

      {summaryLoading ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">Cargando…</Card>
      ) : summary ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard label="Empresas reales" value={String(summary.companies.real)} tone="success" />
            <MetricCard label="Empresas demo" value={String(summary.companies.demo)} tone="warning" />
            <MetricCard label="Contactos reales" value={String(summary.contacts.real)} tone="success" />
            <MetricCard label="Contactos demo" value={String(summary.contacts.demo)} tone="warning" />
            <MetricCard label="Emails verificados" value={String(summary.contacts.emailsVerified)} tone="success" />
            <MetricCard label="Grupos duplicados" value={String(summary.duplicates.groups)} hint={`${summary.duplicates.affectedRecords} registros afectados`} tone={summary.duplicates.groups > 0 ? "danger" : "success"} />
            <MetricCard label="Empresas incompletas" value={String(summary.companies.incomplete)} hint="quality score < 0.5" />
            <MetricCard label="Contactos incompletos" value={String(summary.contacts.incomplete)} hint="quality score < 0.5" />
            <MetricCard label="Calidad promedio (empresas)" value={pct(summary.companies.avgQualityScore * 100)} />
            <MetricCard label="Calidad promedio (contactos)" value={pct(summary.contacts.avgQualityScore * 100)} />
          </div>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>% Listo para producción</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tabular-nums">{pct(summary.readiness.percentReady)}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Promedio simple de dos componentes — no es una certeza matemática, es una señal operativa: calidad de datos
                reales ({pct(summary.readiness.dataQualityComponent)}) y ausencia de duplicados (
                {pct(summary.readiness.duplicatesComponent)}).
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}

      {audit && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Auditoría de procedencia (§1)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Entidad</TableHead>
                  <TableHead>Total</TableHead>
                  {DATA_ORIGINS.map((o) => (
                    <TableHead key={o}>{formatStatusLabel(o)}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.entities.map((e) => (
                  <TableRow key={e.entity}>
                    <TableCell className="font-medium">{e.entity}</TableCell>
                    <TableCell>{e.total}</TableCell>
                    {DATA_ORIGINS.map((o) => (
                      <TableCell key={o} className="text-muted-foreground">
                        {e.byOrigin[o] || "—"}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {duplicates && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Duplicados encontrados (§4)</CardTitle>
          </CardHeader>
          <CardContent>
            {duplicates.summary.totalDuplicateGroups === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin duplicados — 0 grupos encontrados entre {" "}
                {summary ? summary.companies.real + summary.contacts.real : "—"} registros reales.
              </p>
            ) : (
              <div className="space-y-2 text-sm">
                {[
                  ...duplicates.companies.byNameState.map((g) => ({ ...g, scope: "Company" })),
                  ...duplicates.companies.byWebsite.map((g) => ({ ...g, scope: "Company" })),
                  ...duplicates.contacts.byEmail.map((g) => ({ ...g, scope: "Contact" })),
                  ...duplicates.contacts.byLinkedin.map((g) => ({ ...g, scope: "Contact" })),
                  ...duplicates.contacts.byNameCompany.map((g) => ({ ...g, scope: "Contact" })),
                ].map((g, i) => (
                  <div key={i} className="flex items-center justify-between border-b border-border py-2">
                    <span>
                      <Badge variant="warning" className="mr-2">
                        {g.scope}
                      </Badge>
                      {g.matchType}: <span className="font-mono text-xs">{g.key}</span>
                    </span>
                    <span className="text-muted-foreground">{g.count} registros</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {cleanupPlan && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Plan de limpieza de datos demo (§3) — nada se borró</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              {cleanupPlan.totalRecordsToDelete} registros demo identificados en total, en el orden seguro de borrado.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Orden</TableHead>
                  <TableHead>Entidad</TableHead>
                  <TableHead>Cantidad</TableHead>
                  <TableHead>Nota</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cleanupPlan.steps.map((s) => (
                  <TableRow key={s.entity}>
                    <TableCell>{s.order}</TableCell>
                    <TableCell className="font-medium">{s.entity}</TableCell>
                    <TableCell>{s.count}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.note}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {cleanupPlan.blockers.length > 0 && (
              <div className="mt-4">
                <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                  Bloqueantes reales (fuera del alcance de las 8 entidades, igual bloquearían el borrado de Company):
                </p>
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {cleanupPlan.blockers.map((b) => (
                    <li key={b.entity}>
                      {b.entity}: {b.count} filas — {b.note}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
