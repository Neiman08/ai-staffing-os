import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Paginated, PricingScenarioListItem } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatStatusLabel, statusVariant } from "@/lib/status";

export default function Pricing() {
  const { data, isLoading } = useQuery({
    queryKey: ["pricing-scenarios"],
    queryFn: () => apiFetch<Paginated<PricingScenarioListItem>>("/pricing/scenarios?limit=50"),
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = data?.items.find((s) => s.id === selectedId) ?? data?.items[0] ?? null;

  return (
    <div>
      <PageHeader title="Pricing" description="Escenarios de tarifas recomendadas por el Pricing Agent" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          {isLoading ? (
            <LoadingTable />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Escenario</TableHead>
                  <TableHead>Pay</TableHead>
                  <TableHead>Bill</TableHead>
                  <TableHead>Margen bruto/h</TableHead>
                  <TableHead>Riesgo</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((scenario) => (
                  <TableRow
                    key={scenario.id}
                    onClick={() => setSelectedId(scenario.id)}
                    className={cn(
                      "cursor-pointer",
                      (selected?.id ?? data.items[0]?.id) === scenario.id && "bg-primary/5",
                    )}
                  >
                    <TableCell className="font-medium">{scenario.label}</TableCell>
                    <TableCell className="text-muted-foreground">
                      ${scenario.recommendedPayMin}–${scenario.recommendedPayMax}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      ${scenario.recommendedBillMin}–${scenario.recommendedBillMax}
                    </TableCell>
                    <TableCell className="text-muted-foreground">${scenario.grossMarginPerHour}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(scenario.hiringRisk)}>
                        {formatStatusLabel(scenario.hiringRisk)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(scenario.status)}>{formatStatusLabel(scenario.status)}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Detalle del escenario</CardTitle>
          </CardHeader>
          <CardContent>
            {!selected ? (
              <p className="text-sm text-muted-foreground">Selecciona un escenario de la tabla.</p>
            ) : (
              <div className="space-y-4 text-sm">
                <div>
                  <div className="text-lg font-semibold">{selected.label}</div>
                  <div className="mt-1 flex gap-2">
                    <Badge variant={statusVariant(selected.hiringRisk)}>
                      Riesgo {formatStatusLabel(selected.hiringRisk)}
                    </Badge>
                    <Badge variant={statusVariant(selected.dataConfidence)}>
                      Confianza {formatStatusLabel(selected.dataConfidence)}
                    </Badge>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border border-border p-3">
                    <div className="text-xs text-muted-foreground">Pay rate</div>
                    <div className="font-medium">
                      ${selected.recommendedPayMin} – ${selected.recommendedPayMax}
                    </div>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <div className="text-xs text-muted-foreground">Bill rate</div>
                    <div className="font-medium">
                      ${selected.recommendedBillMin} – ${selected.recommendedBillMax}
                    </div>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <div className="text-xs text-muted-foreground">Margen bruto/h</div>
                    <div className="font-medium">${selected.grossMarginPerHour}</div>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <div className="text-xs text-muted-foreground">Margen neto/h</div>
                    <div className="font-medium">{selected.netMarginPerHour ? `$${selected.netMarginPerHour}` : "—"}</div>
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">Rationale</div>
                  <p className="leading-relaxed text-foreground">{selected.rationale}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
