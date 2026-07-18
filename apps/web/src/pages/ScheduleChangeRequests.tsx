import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { ScheduleChangeRequestListItem } from "./portal-internal-types";

const STATUS_FILTERS = ["PENDING", "APPROVED", "REJECTED"];

/**
 * F10.6: revisión interna de solicitudes de cambio de horario creadas
 * desde el Worker Portal -- nunca muta el Assignment/Shift real (eso
 * sigue siendo el flujo separado de F9.5, Assignments), solo registra
 * la decisión (aprobar/rechazar) sobre la solicitud misma.
 */
export default function ScheduleChangeRequests() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("PENDING");

  const params = new URLSearchParams();
  if (status) params.set("status", status);

  const { data, isLoading } = useQuery({
    queryKey: ["schedule-change-requests", status],
    queryFn: () => apiFetch<ScheduleChangeRequestListItem[]>(`/schedule-change-requests?${params.toString()}`),
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, next }: { id: string; next: "APPROVED" | "REJECTED" }) =>
      apiFetch(`/schedule-change-requests/${id}/status`, { method: "PATCH", body: JSON.stringify({ status: next }) }),
    onSuccess: () => {
      toast({ title: "Solicitud actualizada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["schedule-change-requests"] });
    },
    onError: (err) => toast({ title: "No se pudo actualizar la solicitud", description: String(err), variant: "error" }),
  });

  return (
    <div>
      <PageHeader title="Schedule Change Requests" description="Solicitudes de cambio de horario originadas por Workers desde su portal." />

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="w-56">
          <Label htmlFor="statusFilter">Estado</Label>
          <Select id="statusFilter" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data && data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Job Order</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Detalle</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>
                  <span className="sr-only">Acciones</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.workerName}</TableCell>
                  <TableCell className="text-muted-foreground">{r.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">{formatStatusLabel(r.requestType)}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground" title={r.requestedChange}>
                    {r.requestedChange}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(r.status)}>{formatStatusLabel(r.status)}</Badge>
                  </TableCell>
                  <TableCell>
                    {r.status === "PENDING" && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => reviewMutation.mutate({ id: r.id, next: "APPROVED" })}>
                          Aprobar
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => reviewMutation.mutate({ id: r.id, next: "REJECTED" })}>
                          Rechazar
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin solicitudes todavía.</p>
        )}
      </Card>
    </div>
  );
}
