import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ActivityItem,
  AssignmentListItem,
  CompanyListItem,
  JobCategoryListItem,
  JobOrderDetail,
  JobOrderStatusValue,
  Paginated,
  UpdateJobOrderInput,
} from "@ai-staffing-os/shared";
import { JOB_ORDER_STATUS_TRANSITIONS } from "@ai-staffing-os/shared";
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
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { ArrowLeft } from "lucide-react";

const SHIFT_TYPES = ["DAY", "NIGHT", "WEEKEND", "ROTATING"];
const URGENCY_LEVELS = ["LOW", "MEDIUM", "HIGH"];

// F5.1: cerrar/cancelar nunca borra el registro — solo estos dos destinos
// piden confirmación explícita antes de aplicarse.
const CONFIRM_REQUIRED_STATUSES = new Set<JobOrderStatusValue>(["CLOSED", "CANCELLED"]);

function EditJobOrderForm({ jobOrder, onDone }: { jobOrder: JobOrderDetail; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<UpdateJobOrderInput>({
    title: jobOrder.title,
    description: jobOrder.description ?? "",
    workersNeeded: jobOrder.workersNeeded,
    billRate: Number(jobOrder.billRate),
    payRate: Number(jobOrder.payRate),
    location: jobOrder.location ?? { address: "", city: "", state: "" },
    shiftType: jobOrder.shiftType as never,
    scheduleNotes: jobOrder.scheduleNotes ?? "",
    startDate: jobOrder.startDate.slice(0, 10),
    endDate: jobOrder.endDate ? jobOrder.endDate.slice(0, 10) : "",
    urgency: jobOrder.urgency as never,
  });

  const mutation = useMutation({
    mutationFn: (input: UpdateJobOrderInput) => {
      const location =
        input.location && (input.location.city || input.location.state || input.location.address)
          ? input.location
          : undefined;
      return apiFetch(`/job-orders/${jobOrder.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...input, location, endDate: input.endDate || undefined }),
      });
    },
    onSuccess: () => {
      toast({ title: "Job Order actualizado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["job-order", jobOrder.id] });
      queryClient.invalidateQueries({ queryKey: ["job-orders"] });
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
      <div>
        <Label>Título</Label>
        <Input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div>
        <Label>Descripción</Label>
        <Textarea
          value={form.description ?? ""}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label>Cantidad requerida</Label>
          <Input
            type="number"
            min={1}
            value={form.workersNeeded}
            onChange={(e) => setForm({ ...form, workersNeeded: Number(e.target.value) })}
          />
        </div>
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
      {(form.billRate ?? 0) <= (form.payRate ?? 0) && (
        <p className="text-xs text-destructive">Bill rate debe ser mayor que pay rate.</p>
      )}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label>Dirección</Label>
          <Input
            value={form.location?.address ?? ""}
            onChange={(e) => setForm({ ...form, location: { ...form.location!, address: e.target.value } })}
          />
        </div>
        <div>
          <Label>Ciudad</Label>
          <Input
            value={form.location?.city ?? ""}
            onChange={(e) => setForm({ ...form, location: { ...form.location!, city: e.target.value } })}
          />
        </div>
        <div>
          <Label>Estado</Label>
          <Input
            value={form.location?.state ?? ""}
            onChange={(e) => setForm({ ...form, location: { ...form.location!, state: e.target.value } })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Turno</Label>
          <Select value={form.shiftType} onChange={(e) => setForm({ ...form, shiftType: e.target.value as never })}>
            {SHIFT_TYPES.map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Prioridad</Label>
          <Select value={form.urgency} onChange={(e) => setForm({ ...form, urgency: e.target.value as never })}>
            {URGENCY_LEVELS.map((u) => (
              <option key={u} value={u}>
                {formatStatusLabel(u)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Fecha de inicio</Label>
          <Input
            type="date"
            value={form.startDate?.slice(0, 10) ?? ""}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })}
          />
        </div>
        <div>
          <Label>Fecha estimada de fin</Label>
          <Input
            type="date"
            value={form.endDate?.slice(0, 10) ?? ""}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
          />
        </div>
      </div>
      <div>
        <Label>Notas de horario</Label>
        <Textarea value={form.scheduleNotes ?? ""} onChange={(e) => setForm({ ...form, scheduleNotes: e.target.value })} />
      </div>
      <Button type="submit" className="w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Guardando…" : "Guardar cambios"}
      </Button>
    </form>
  );
}

export default function JobOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<JobOrderStatusValue | null>(null);

  const { data: jobOrder, isLoading } = useQuery({
    queryKey: ["job-order", id],
    queryFn: () => apiFetch<JobOrderDetail>(`/job-orders/${id}`),
    enabled: !!id,
  });

  const { data: activity } = useQuery({
    queryKey: ["job-order-activity", id],
    queryFn: () => apiFetch<ActivityItem[]>(`/activities?entityType=jobOrder&entityId=${id}`),
    enabled: !!id,
  });

  // F5.4: sección de solo lectura — la creación real de Assignments vive
  // en /assignments (selector de Worker+Job Order), no acá.
  const { data: assignments } = useQuery({
    queryKey: ["job-order-assignments", id],
    queryFn: () => apiFetch<Paginated<AssignmentListItem>>(`/assignments?jobOrderId=${id}&limit=50`),
    enabled: !!id,
  });

  // F5.1: solo para mostrar el nombre real de la empresa/categoría ya
  // elegidas — no se usan para poblar el formulario de edición.
  const { data: companies } = useQuery({
    queryKey: ["companies", "for-job-order-detail"],
    queryFn: () => apiFetch<{ items: CompanyListItem[] }>("/companies?limit=100"),
  });
  const { data: categories } = useQuery({
    queryKey: ["job-categories"],
    queryFn: () => apiFetch<JobCategoryListItem[]>("/job-categories"),
  });

  const statusMutation = useMutation({
    mutationFn: (status: JobOrderStatusValue) =>
      apiFetch(`/job-orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: (_data, status) => {
      toast({ title: `Estado actualizado a ${formatStatusLabel(status)}`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["job-order", id] });
      queryClient.invalidateQueries({ queryKey: ["job-order-activity", id] });
      queryClient.invalidateQueries({ queryKey: ["job-orders"] });
      setPendingStatus(null);
    },
    onError: (err) => {
      toast({ title: "No se pudo cambiar el estado", description: String(err), variant: "error" });
      setPendingStatus(null);
    },
  });

  if (isLoading || !jobOrder) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  const allowedNext = JOB_ORDER_STATUS_TRANSITIONS[jobOrder.status];

  function requestStatusChange(status: JobOrderStatusValue) {
    if (CONFIRM_REQUIRED_STATUSES.has(status)) {
      setPendingStatus(status);
    } else {
      statusMutation.mutate(status);
    }
  }

  return (
    <div>
      <Link to="/job-orders" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        Job Orders
      </Link>

      <PageHeader
        title={jobOrder.title}
        description={`${jobOrder.companyName} · ${jobOrder.categoryName}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(jobOrder.status)}>{formatStatusLabel(jobOrder.status)}</Badge>
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
              <Button
                key={next}
                variant="outline"
                size="sm"
                disabled={statusMutation.isPending}
                onClick={() => requestStatusChange(next)}
              >
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
              <span className="text-muted-foreground">Cliente</span>
              <span>{companies?.items.find((c) => c.id === jobOrder.companyId)?.name ?? jobOrder.companyName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Categoría</span>
              <span>{categories?.find((c) => c.id === jobOrder.categoryId)?.name ?? jobOrder.categoryName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ubicación</span>
              <span>
                {jobOrder.location
                  ? `${jobOrder.location.address ? `${jobOrder.location.address}, ` : ""}${jobOrder.location.city}, ${jobOrder.location.state}`
                  : "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Turno</span>
              <span>{formatStatusLabel(jobOrder.shiftType)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Prioridad</span>
              <Badge variant={statusVariant(jobOrder.urgency)}>{formatStatusLabel(jobOrder.urgency)}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fecha de inicio</span>
              <span>{new Date(jobOrder.startDate).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fecha estimada de fin</span>
              <span>{jobOrder.endDate ? new Date(jobOrder.endDate).toLocaleDateString() : "—"}</span>
            </div>
            {jobOrder.description && (
              <div className="pt-2">
                <span className="text-muted-foreground">Descripción</span>
                <p className="mt-1">{jobOrder.description}</p>
              </div>
            )}
            {jobOrder.scheduleNotes && (
              <div className="pt-2">
                <span className="text-muted-foreground">Notas de horario</span>
                <p className="mt-1">{jobOrder.scheduleNotes}</p>
              </div>
            )}
            {jobOrder.requirements.length > 0 && (
              <div className="pt-2">
                <span className="text-muted-foreground">Documentos requeridos</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {jobOrder.requirements.map((r) => (
                    <Badge key={r} variant="neutral">
                      {r}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tarifas y ocupación</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Bill rate</span>
              <span>${Number(jobOrder.billRate).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pay rate</span>
              <span>${Number(jobOrder.payRate).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Margen bruto/h</span>
              <span>${(Number(jobOrder.billRate) - Number(jobOrder.payRate)).toFixed(2)}</span>
            </div>
            {/* F5.1: solo lectura — se automatiza cuando exista Assignments, nunca editable a mano acá. */}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ocupación (solo lectura)</span>
              <span>
                {jobOrder.workersFilled} / {jobOrder.workersNeeded}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Creado por</span>
              <span>{jobOrder.createdByName ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Creado</span>
              <span>{new Date(jobOrder.createdAt).toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Assignments
              {(jobOrder.status === "OPEN" || jobOrder.status === "PARTIALLY_FILLED") && (
                <Link to="/assignments">
                  <Button variant="outline" size="sm">
                    Assign Worker
                  </Button>
                </Link>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {assignments && assignments.items.length > 0 ? (
              <ul className="divide-y divide-border text-sm">
                {assignments.items.map((a) => (
                  <li key={a.id} className="flex items-center justify-between py-2">
                    <Link to={`/assignments/${a.id}`} className="text-primary underline">
                      {a.workerName}
                    </Link>
                    <Badge variant={statusVariant(a.status)}>{formatStatusLabel(a.status)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Sin Assignments todavía para este Job Order.</p>
            )}
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

      <Drawer open={editOpen} onClose={() => setEditOpen(false)} title="Editar Job Order">
        <EditJobOrderForm jobOrder={jobOrder} onDone={() => setEditOpen(false)} />
      </Drawer>

      {pendingStatus && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-sm p-4">
            <p className="text-sm font-medium">
              {pendingStatus === "CANCELLED" ? "¿Cancelar este Job Order?" : "¿Cerrar este Job Order?"}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              El registro no se elimina — queda guardado con estado {formatStatusLabel(pendingStatus)} y sigue
              siendo consultable en el detalle y en el historial de actividad.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPendingStatus(null)}>
                Volver
              </Button>
              <Button
                size="sm"
                disabled={statusMutation.isPending}
                onClick={() => statusMutation.mutate(pendingStatus)}
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
