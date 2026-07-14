import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityItem, AssignmentDetail, AssignmentStatusValue, UpdateAssignmentInput } from "@ai-staffing-os/shared";
import { ASSIGNMENT_STATUS_TRANSITIONS } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Timeline } from "@/components/shared/Timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { ArrowLeft } from "lucide-react";

// F5.4: cerrar (COMPLETED/TERMINATED) siempre pide confirmación y motivo
// — el registro no se borra, pero es un cambio operativo real que libera
// al Worker y puede reabrir cupo del Job Order.
const CONFIRM_REQUIRED_STATUSES = new Set<AssignmentStatusValue>(["COMPLETED", "TERMINATED"]);

function EditAssignmentForm({ assignment, onDone }: { assignment: AssignmentDetail; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<UpdateAssignmentInput>({
    payRate: Number(assignment.payRate),
    billRate: Number(assignment.billRate),
    startDate: assignment.startDate.slice(0, 10),
    endDate: assignment.endDate ? assignment.endDate.slice(0, 10) : "",
  });

  const mutation = useMutation({
    mutationFn: (input: UpdateAssignmentInput) =>
      apiFetch(`/assignments/${assignment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...input, endDate: input.endDate || undefined }),
      }),
    onSuccess: () => {
      toast({ title: "Assignment actualizada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["assignment", assignment.id] });
      queryClient.invalidateQueries({ queryKey: ["assignments"] });
      onDone();
    },
    onError: (err) => toast({ title: "No se pudo actualizar", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(form);
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Pay rate</Label>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={form.payRate}
            onChange={(e) => setForm({ ...form, payRate: Number(e.target.value) })}
          />
        </div>
        <div>
          <Label>Bill rate</Label>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={form.billRate}
            onChange={(e) => setForm({ ...form, billRate: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Fecha de inicio</Label>
          <Input type="date" value={form.startDate?.slice(0, 10) ?? ""} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
        </div>
        <div>
          <Label>Fecha estimada de fin</Label>
          <Input type="date" value={form.endDate?.slice(0, 10) ?? ""} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
        </div>
      </div>
      <Button type="submit" className="w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Guardando…" : "Guardar cambios"}
      </Button>
    </form>
  );
}

export default function AssignmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<AssignmentStatusValue | null>(null);
  const [closeReason, setCloseReason] = useState("");

  const { data: assignment, isLoading } = useQuery({
    queryKey: ["assignment", id],
    queryFn: () => apiFetch<AssignmentDetail>(`/assignments/${id}`),
    enabled: !!id,
  });

  const { data: activity } = useQuery({
    queryKey: ["assignment-activity", id],
    queryFn: () => apiFetch<ActivityItem[]>(`/activities?entityType=assignment&entityId=${id}`),
    enabled: !!id,
  });

  const statusMutation = useMutation({
    mutationFn: ({ status, reason }: { status: AssignmentStatusValue; reason?: string }) =>
      apiFetch(`/assignments/${id}/status`, { method: "PATCH", body: JSON.stringify({ status, reason: reason || undefined }) }),
    onSuccess: (_data, { status }) => {
      toast({ title: `Estado actualizado a ${formatStatusLabel(status)}`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["assignment", id] });
      queryClient.invalidateQueries({ queryKey: ["assignment-activity", id] });
      queryClient.invalidateQueries({ queryKey: ["assignments"] });
      queryClient.invalidateQueries({ queryKey: ["workers"] });
      queryClient.invalidateQueries({ queryKey: ["job-orders"] });
      setPendingStatus(null);
      setCloseReason("");
    },
    onError: (err) => {
      toast({ title: "No se pudo cambiar el estado", description: String(err), variant: "error" });
    },
  });

  if (isLoading || !assignment) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  const allowedNext = ASSIGNMENT_STATUS_TRANSITIONS[assignment.status];

  function requestStatusChange(status: AssignmentStatusValue) {
    if (CONFIRM_REQUIRED_STATUSES.has(status)) {
      setPendingStatus(status);
    } else {
      statusMutation.mutate({ status });
    }
  }

  return (
    <div>
      <Link to="/assignments" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        Assignments
      </Link>

      <PageHeader
        title={`${assignment.workerName} → ${assignment.jobOrderTitle}`}
        description={assignment.companyName}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(assignment.status)}>{formatStatusLabel(assignment.status)}</Badge>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              Editar
            </Button>
          </div>
        }
      />

      {allowedNext.length > 0 && (
        <Card className="mb-4 p-3">
          <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Cambiar estado</p>
          <div className="flex flex-wrap gap-2">
            {allowedNext.map((next) => (
              <Button key={next} variant="outline" size="sm" disabled={statusMutation.isPending} onClick={() => requestStatusChange(next)}>
                {formatStatusLabel(next)}
              </Button>
            ))}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Detalles</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Worker</span>
              <Link to={`/workers/${assignment.workerId}`} className="text-primary underline">
                {assignment.workerName}
              </Link>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Worker compliance</span>
              <Badge variant={statusVariant(assignment.workerComplianceStatus)}>
                {formatStatusLabel(assignment.workerComplianceStatus)}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Job Order</span>
              <Link to={`/job-orders/${assignment.jobOrderId}`} className="text-primary underline">
                {assignment.jobOrderTitle}
              </Link>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Cliente</span>
              <span>{assignment.companyName}</span>
            </div>
            {assignment.projectName && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Proyecto</span>
                <span>{assignment.projectName}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fecha de inicio</span>
              <span>{new Date(assignment.startDate).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fecha estimada de fin</span>
              <span>{assignment.endDate ? new Date(assignment.endDate).toLocaleDateString() : "—"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tarifas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Bill rate</span>
              <span>${Number(assignment.billRate).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pay rate</span>
              <span>${Number(assignment.payRate).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Margen bruto/h</span>
              <span>${(Number(assignment.billRate) - Number(assignment.payRate)).toFixed(2)}</span>
            </div>
            <p className="pt-2 text-xs text-muted-foreground">
              Snapshot al crear — un cambio posterior en las tarifas del Job Order no se propaga acá.
            </p>
            <div className="flex justify-between pt-2">
              <span className="text-muted-foreground">Creado</span>
              <span>{new Date(assignment.createdAt).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Actualizado</span>
              <span>{new Date(assignment.updatedAt).toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Actividad</CardTitle>
          </CardHeader>
          <CardContent>
            <Timeline items={activity ?? []} />
          </CardContent>
        </Card>
      </div>

      <Drawer open={editOpen} onClose={() => setEditOpen(false)} title="Editar Assignment">
        <EditAssignmentForm assignment={assignment} onDone={() => setEditOpen(false)} />
      </Drawer>

      {pendingStatus && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-sm p-4">
            <p className="text-sm font-medium">
              {pendingStatus === "TERMINATED" ? "¿Terminar esta Assignment?" : "¿Completar esta Assignment?"}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              El registro no se elimina — queda guardado con estado {formatStatusLabel(pendingStatus)}. El Worker
              vuelve a estar disponible y el Job Order recupera ese cupo si corresponde.
            </p>
            <div className="mt-3">
              <Label htmlFor="closeReason">Motivo (opcional)</Label>
              <Textarea id="closeReason" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setPendingStatus(null); setCloseReason(""); }}>
                Volver
              </Button>
              <Button
                size="sm"
                disabled={statusMutation.isPending}
                onClick={() => statusMutation.mutate({ status: pendingStatus, reason: closeReason })}
              >
                {statusMutation.isPending ? "Aplicando…" : "Confirmar"}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
