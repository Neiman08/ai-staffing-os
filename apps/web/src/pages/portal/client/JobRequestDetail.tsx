import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { ArrowLeft } from "lucide-react";
import type { ClientJobRequestRecord } from "./types";

const EDITABLE_STATUSES = new Set(["DRAFT", "NEEDS_INFORMATION"]);
const CANCELLABLE_STATUSES = new Set(["DRAFT", "SUBMITTED", "NEEDS_INFORMATION"]);

export default function ClientJobRequestDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const canSubmit = currentUser?.permissions.includes("clientJobs.create") ?? false;
  const canManage = currentUser?.permissions.includes("clientJobs.update") ?? false;

  const { data: request, isLoading } = useQuery({
    queryKey: ["portal-client-job-request", id],
    queryFn: () => apiFetch<ClientJobRequestRecord>(`/portal/client/job-requests/${id}`),
    enabled: !!id,
  });

  const submitMutation = useMutation({
    mutationFn: () => apiFetch(`/portal/client/job-requests/${id}/submit`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Solicitud enviada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["portal-client-job-request", id] });
    },
    onError: (err) => toast({ title: "No se pudo enviar", description: String(err), variant: "error" }),
  });

  const cancelMutation = useMutation({
    mutationFn: () => apiFetch(`/portal/client/job-requests/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Solicitud cancelada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["portal-client-job-request", id] });
    },
    onError: (err) => toast({ title: "No se pudo cancelar", description: String(err), variant: "error" }),
  });

  if (isLoading || !request) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div>
      <Link to="/portal/client/job-requests" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        Job Requests
      </Link>

      <PageHeader
        title={request.requestedTitle}
        description={`${request.headcount} persona(s) -- inicio deseado ${new Date(request.desiredStartDate).toLocaleDateString()}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(request.status)}>{formatStatusLabel(request.status)}</Badge>
            {canSubmit && (request.status === "DRAFT" || request.status === "NEEDS_INFORMATION") && (
              <Button size="sm" disabled={submitMutation.isPending} onClick={() => submitMutation.mutate()}>
                Enviar
              </Button>
            )}
            {canManage && CANCELLABLE_STATUSES.has(request.status) && (
              <Button size="sm" variant="outline" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>
                Cancelar
              </Button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Detalles</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Turno</span>
              <span>{request.shift ? formatStatusLabel(request.shift) : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Horario</span>
              <span>{request.schedule ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Duración estimada</span>
              <span>{request.duration ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Urgencia</span>
              <span>{formatStatusLabel(request.urgency)}</span>
            </div>
            {request.notes && (
              <div className="pt-2">
                <span className="text-muted-foreground">Notas</span>
                <p className="mt-1">{request.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Estado de la revisión</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {request.reviewNotes && (
              <p className="rounded border border-border bg-muted/40 p-2 text-xs">
                <span className="font-medium">Comentario del equipo interno: </span>
                {request.reviewNotes}
              </p>
            )}
            {request.status === "NEEDS_INFORMATION" && (
              <p className="text-amber-600 dark:text-amber-400">
                Se necesita más información -- {canManage ? "edita la solicitud y vuelve a enviarla." : "pide a un CLIENT_ADMIN que la edite y reenvíe."}
              </p>
            )}
            {request.status === "CONVERTED_TO_JOB_ORDER" && request.convertedJobOrderId && (
              <p className="text-emerald-600 dark:text-emerald-400">
                Convertida a un Job Order real.{" "}
                <button type="button" className="underline" onClick={() => navigate(`/portal/client/job-orders/${request.convertedJobOrderId}`)}>
                  Ver Job Order
                </button>
              </p>
            )}
            {!EDITABLE_STATUSES.has(request.status) && request.status !== "CONVERTED_TO_JOB_ORDER" && (
              <p className="text-xs text-muted-foreground">Esta solicitud ya no es editable en este estado.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
