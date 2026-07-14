import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { WorkerDetail } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { ArrowLeft } from "lucide-react";

// F5.2: superficie mínima aprobada — solo detalle de lectura, para
// verificar que la conversión desde Candidate funcionó. Listado
// completo, edición, filtros, disponibilidad y Assignments quedan para
// el bloque siguiente (ver docs/F5_STAFFING_OPERATIONS_PLAN.md §5).
export default function WorkerDetailPage() {
  const { id } = useParams<{ id: string }>();

  const { data: worker, isLoading } = useQuery({
    queryKey: ["worker", id],
    queryFn: () => apiFetch<WorkerDetail>(`/workers/${id}`),
    enabled: !!id,
  });

  if (isLoading || !worker) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div>
      <Link
        to={`/candidates/${worker.candidateId}`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {worker.candidateName}
      </Link>

      <PageHeader
        title={worker.candidateName}
        description="Worker"
        action={<Badge variant={statusVariant(worker.status)}>{formatStatusLabel(worker.status)}</Badge>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Datos de empleo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Employment type</span>
              <span>{worker.employmentType}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Default pay rate</span>
              <span>${Number(worker.defaultPayRate).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Compliance</span>
              <Badge variant={statusVariant(worker.complianceStatus)}>{formatStatusLabel(worker.complianceStatus)}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Contratado</span>
              <span>{worker.hiredAt ? new Date(worker.hiredAt).toLocaleDateString() : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Creado</span>
              <span>{new Date(worker.createdAt).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Candidate de origen</span>
              <Link to={`/candidates/${worker.candidateId}`} className="text-primary underline">
                {worker.candidateName}
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Documentos</CardTitle>
          </CardHeader>
          <CardContent>
            {worker.documents.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin documentos todavía.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {worker.documents.map((doc) => (
                  <li key={doc.id} className="flex items-center justify-between">
                    <span>{doc.documentTypeName}</span>
                    <span className="flex items-center gap-2">
                      <Badge variant="neutral">{doc.source === "worker" ? "Worker" : "Candidate"}</Badge>
                      <Badge variant={statusVariant(doc.status)}>{formatStatusLabel(doc.status)}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
