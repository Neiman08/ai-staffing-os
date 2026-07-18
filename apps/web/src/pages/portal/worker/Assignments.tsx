import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { WorkerAssignmentItem, WorkerIncidentItem, WorkerScheduleChangeRequestItem, WorkerShiftItem } from "./types";

function formatLocation(location: WorkerAssignmentItem["location"]): string {
  if (!location) return "—";
  const parts = [location.address, location.city, location.state].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "—";
}

const REQUEST_TYPE_OPTIONS = [
  { value: "shift_swap", label: "Cambio de turno" },
  { value: "time_off", label: "Solicitud de tiempo libre" },
  { value: "schedule_adjustment", label: "Ajuste de horario" },
  { value: "other", label: "Otro" },
];

function RequestScheduleChangeForm({ assignmentId, onSubmitted }: { assignmentId: string; onSubmitted: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [requestType, setRequestType] = useState(REQUEST_TYPE_OPTIONS[0]!.value);
  const [requestedChange, setRequestedChange] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/portal/worker/assignments/${assignmentId}/schedule-change-requests`, {
        method: "POST",
        body: JSON.stringify({ requestType, requestedChange }),
      }),
    onSuccess: () => {
      toast({ title: "Solicitud enviada -- pendiente de revisión interna", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["portal-worker-schedule-change-requests", assignmentId] });
      setRequestedChange("");
      onSubmitted();
    },
    onError: (err) => toast({ title: "No se pudo enviar la solicitud", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-3 border-t border-border pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <p className="text-sm font-medium">Solicitar un cambio</p>
      <p className="text-xs text-muted-foreground">
        Esto no modifica tu Assignment directamente -- queda como solicitud pendiente de aprobación interna.
      </p>
      <div>
        <Label htmlFor="request-type">Tipo</Label>
        <select
          id="request-type"
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={requestType}
          onChange={(e) => setRequestType(e.target.value)}
        >
          {REQUEST_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="requested-change">Detalle *</Label>
        <Textarea id="requested-change" required value={requestedChange} onChange={(e) => setRequestedChange(e.target.value)} />
      </div>
      <Button type="submit" size="sm" disabled={mutation.isPending || !requestedChange.trim()}>
        {mutation.isPending ? "Enviando…" : "Enviar solicitud"}
      </Button>
    </form>
  );
}

function AssignmentDetailDrawer({ assignment, onClose }: { assignment: WorkerAssignmentItem; onClose: () => void }) {
  const [showRequestForm, setShowRequestForm] = useState(false);

  const { data: shifts } = useQuery({
    queryKey: ["portal-worker-shifts"],
    queryFn: () => apiFetch<WorkerShiftItem[]>("/portal/worker/shifts"),
  });
  const { data: incidents } = useQuery({
    queryKey: ["portal-worker-incidents"],
    queryFn: () => apiFetch<WorkerIncidentItem[]>("/portal/worker/incidents"),
  });
  const { data: requests } = useQuery({
    queryKey: ["portal-worker-schedule-change-requests", assignment.id],
    queryFn: () => apiFetch<WorkerScheduleChangeRequestItem[]>(`/portal/worker/schedule-change-requests?assignmentId=${assignment.id}`),
  });

  const ownShifts = shifts?.filter((s) => s.assignmentId === assignment.id) ?? [];
  const ownIncidents = incidents?.filter((i) => i.assignmentId === assignment.id) ?? [];

  return (
    <Drawer open onClose={onClose} title={assignment.jobOrderTitle}>
      <div className="space-y-5 text-sm">
        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Cliente</span>
            <span>{assignment.companyName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Estado</span>
            <Badge variant={statusVariant(assignment.status)}>{formatStatusLabel(assignment.status)}</Badge>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Ubicación</span>
            <span>{formatLocation(assignment.location)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Turno</span>
            <span>{formatStatusLabel(assignment.shiftType)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Supervisor</span>
            <span>{assignment.supervisorName ?? "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Inicio</span>
            <span>{new Date(assignment.startDate).toLocaleDateString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Fin</span>
            <span>{assignment.endDate ? new Date(assignment.endDate).toLocaleDateString() : "—"}</span>
          </div>
          {assignment.scheduleNotes && (
            <div>
              <span className="text-muted-foreground">Instrucciones</span>
              <p className="mt-1">{assignment.scheduleNotes}</p>
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 font-medium">Turnos programados</p>
          {ownShifts.length > 0 ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {ownShifts.map((s) => (
                <li key={s.id}>
                  {new Date(s.date).toLocaleDateString()} · {s.startTime}–{s.endTime}
                  {s.breakMinutes > 0 && ` · ${s.breakMinutes}min break`}
                  {s.timezone && ` · ${s.timezone}`}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Sin turnos programados todavía.</p>
          )}
        </div>

        {ownIncidents.length > 0 && (
          <div>
            <p className="mb-2 font-medium">Incidents relacionados</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {ownIncidents.map((i) => (
                <li key={i.id}>
                  {formatStatusLabel(i.type)} · <Badge variant={statusVariant(i.status)}>{formatStatusLabel(i.status)}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <p className="mb-2 font-medium">Mis solicitudes de cambio</p>
          {requests && requests.length > 0 ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {requests.map((r) => (
                <li key={r.id} className="flex items-center justify-between">
                  <span>{r.requestedChange}</span>
                  <Badge variant={statusVariant(r.status)}>{formatStatusLabel(r.status)}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Sin solicitudes todavía.</p>
          )}
        </div>

        {showRequestForm ? (
          <RequestScheduleChangeForm assignmentId={assignment.id} onSubmitted={() => setShowRequestForm(false)} />
        ) : (
          <Button variant="outline" size="sm" onClick={() => setShowRequestForm(true)}>
            Solicitar un cambio
          </Button>
        )}
      </div>
    </Drawer>
  );
}

export default function WorkerAssignmentsPage() {
  const [selected, setSelected] = useState<WorkerAssignmentItem | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["portal-worker-assignments"],
    queryFn: () => apiFetch<WorkerAssignmentItem[]>("/portal/worker/assignments"),
  });

  return (
    <div>
      <PageHeader title="Assignments" description="Tus asignaciones actuales e historial." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data && data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job Order</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Inicio</TableHead>
                <TableHead>Fin</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((a) => (
                <TableRow key={a.id} className="cursor-pointer" onClick={() => setSelected(a)}>
                  <TableCell className="font-medium">{a.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">{a.companyName}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(a.startDate).toLocaleDateString()}</TableCell>
                  <TableCell className="text-muted-foreground">{a.endDate ? new Date(a.endDate).toLocaleDateString() : "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(a.status)}>{formatStatusLabel(a.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin Assignments todavía.</p>
        )}
      </Card>

      {selected && <AssignmentDetailDrawer assignment={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
