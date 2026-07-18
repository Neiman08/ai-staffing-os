import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { ArrowLeft } from "lucide-react";
import type { ClientJobOrderListItem, ClientShortlistEntry } from "./types";

export default function ClientJobOrderDetail() {
  const { id } = useParams<{ id: string }>();

  const { data: jobOrder, isLoading } = useQuery({
    queryKey: ["portal-client-job-order", id],
    queryFn: () => apiFetch<ClientJobOrderListItem>(`/portal/client/job-orders/${id}`),
    enabled: !!id,
  });

  const { data: shortlist } = useQuery({
    queryKey: ["portal-client-shortlist", id],
    queryFn: () => apiFetch<ClientShortlistEntry[]>(`/portal/client/job-orders/${id}/shortlist`),
    enabled: !!id,
  });

  if (isLoading || !jobOrder) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div>
      <Link to="/portal/client/job-orders" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        Job Orders
      </Link>

      <PageHeader
        title={jobOrder.title}
        description={`${jobOrder.workersFilled} / ${jobOrder.workersNeeded} workers`}
        action={<Badge variant={statusVariant(jobOrder.status)}>{formatStatusLabel(jobOrder.status)}</Badge>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Detalles</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fecha de inicio</span>
              <span>{new Date(jobOrder.startDate).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fecha estimada de fin</span>
              <span>{jobOrder.endDate ? new Date(jobOrder.endDate).toLocaleDateString() : "—"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Candidatos propuestos</CardTitle>
          </CardHeader>
          <CardContent>
            {shortlist && shortlist.length > 0 ? (
              <ul className="divide-y divide-border text-sm">
                {shortlist.map((entry) => (
                  <li key={entry.candidateId} className="flex items-center justify-between py-2">
                    <span>
                      <span className="text-xs font-semibold text-muted-foreground">#{entry.rank}</span> {entry.candidateName}
                    </span>
                    <Badge variant={statusVariant(entry.reviewStatus)}>{formatStatusLabel(entry.reviewStatus)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Sin candidatos propuestos todavía para este Job Order.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
