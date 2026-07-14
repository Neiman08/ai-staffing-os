import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ActivityItem,
  AssignmentListItem,
  Paginated,
  UpdateWorkerInput,
  WorkerDetail,
  WorkerStatusValue,
} from "@ai-staffing-os/shared";
import { WORKER_STATUS_TRANSITIONS } from "@ai-staffing-os/shared";
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
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { ArrowLeft } from "lucide-react";

// F5.3: TERMINATED es el único destino que pide confirmación explícita —
// mismo criterio que CLOSED/CANCELLED en JobOrder (F5.1): no borra nada,
// pero es un estado terminal en esta fase (sin reapertura pedida).
const CONFIRM_REQUIRED_STATUSES = new Set<WorkerStatusValue>(["TERMINATED"]);

function EditWorkerForm({ worker, onDone }: { worker: WorkerDetail; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<UpdateWorkerInput>({
    employmentType: worker.employmentType,
    defaultPayRate: Number(worker.defaultPayRate),
    hiredAt: worker.hiredAt ? worker.hiredAt.slice(0, 10) : "",
  });

  const mutation = useMutation({
    mutationFn: (input: UpdateWorkerInput) =>
      apiFetch(`/workers/${worker.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...input, hiredAt: input.hiredAt || undefined }),
      }),
    onSuccess: () => {
      toast({ title: "Worker actualizado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["worker", worker.id] });
      queryClient.invalidateQueries({ queryKey: ["workers"] });
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
          <Label>Employment type</Label>
          <Select
            value={form.employmentType}
            onChange={(e) => setForm({ ...form, employmentType: e.target.value as never })}
          >
            <option value="W2">W2</option>
            <option value="C1099">1099</option>
          </Select>
        </div>
        <div>
          <Label>Default pay rate</Label>
          <Input
            type="number"
            min={0.01}
            step="0.01"
            value={form.defaultPayRate}
            onChange={(e) => setForm({ ...form, defaultPayRate: Number(e.target.value) })}
          />
        </div>
      </div>
      <div>
        <Label>Contratado el</Label>
        <Input type="date" value={form.hiredAt ?? ""} onChange={(e) => setForm({ ...form, hiredAt: e.target.value })} />
      </div>
      <Button type="submit" className="w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Guardando…" : "Guardar cambios"}
      </Button>
    </form>
  );
}

export default function WorkerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<WorkerStatusValue | null>(null);

  const { data: worker, isLoading } = useQuery({
    queryKey: ["worker", id],
    queryFn: () => apiFetch<WorkerDetail>(`/workers/${id}`),
    enabled: !!id,
  });

  const { data: activity } = useQuery({
    queryKey: ["worker-activity", id],
    queryFn: () => apiFetch<ActivityItem[]>(`/activities?entityType=worker&entityId=${id}`),
    enabled: !!id,
  });

  // F5.4: sección de solo lectura — la creación real de Assignments vive
  // en /assignments.
  const { data: assignments } = useQuery({
    queryKey: ["worker-assignments", id],
    queryFn: () => apiFetch<Paginated<AssignmentListItem>>(`/assignments?workerId=${id}&limit=50`),
    enabled: !!id,
  });

  const statusMutation = useMutation({
    mutationFn: (status: WorkerStatusValue) =>
      apiFetch(`/workers/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: (_data, status) => {
      toast({ title: `Estado actualizado a ${formatStatusLabel(status)}`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["worker", id] });
      queryClient.invalidateQueries({ queryKey: ["worker-activity", id] });
      queryClient.invalidateQueries({ queryKey: ["workers"] });
      setPendingStatus(null);
    },
    onError: (err) => {
      toast({ title: "No se pudo cambiar el estado", description: String(err), variant: "error" });
      setPendingStatus(null);
    },
  });

  if (isLoading || !worker) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  // F5.3: ASSIGNED nunca se ofrece como botón manual — el schema
  // WORKER_STATUS_TRANSITIONS ya lo excluye de todos los orígenes, así
  // que allowedNext refleja esto automáticamente sin lógica extra acá.
  const allowedNext = WORKER_STATUS_TRANSITIONS[worker.status];

  function requestStatusChange(status: WorkerStatusValue) {
    if (CONFIRM_REQUIRED_STATUSES.has(status)) {
      setPendingStatus(status);
    } else {
      statusMutation.mutate(status);
    }
  }

  return (
    <div>
      <Link
        to={`/candidates/${worker.candidateId}`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Volver al Candidate
      </Link>

      <PageHeader
        title={worker.candidateName}
        description={worker.categoryNames.join(", ") || "Sin categoría asignada"}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(worker.status)}>{formatStatusLabel(worker.status)}</Badge>
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
            <CardTitle>Información general</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Candidate de origen</span>
              <Link to={`/candidates/${worker.candidateId}`} className="text-primary underline">
                {worker.candidateName}
              </Link>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email</span>
              <span>{worker.email ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ubicación</span>
              <span>{worker.city && worker.state ? `${worker.city}, ${worker.state}` : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Idiomas</span>
              <span>{worker.languages.join(", ").toUpperCase() || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Job Categories</span>
              <span>{worker.categoryNames.join(", ") || "—"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Datos de empleo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Employment type</span>
              <span>{worker.employmentType === "C1099" ? "1099" : "W2"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Default pay rate</span>
              <span>${Number(worker.defaultPayRate).toFixed(2)}</span>
            </div>
            {/* F5.3: complianceStatus es de solo lectura acá a propósito —
                pertenece al dominio de Compliance (compliance.verify/
                compliance.block), fuera de alcance de este módulo. */}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Compliance (solo lectura)</span>
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
              <span className="text-muted-foreground">Actualizado</span>
              <span>{new Date(worker.updatedAt).toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Assignments</CardTitle>
          </CardHeader>
          <CardContent>
            {assignments && assignments.items.length > 0 ? (
              <ul className="divide-y divide-border text-sm">
                {assignments.items.map((a) => (
                  <li key={a.id} className="flex items-center justify-between py-2">
                    <Link to={`/assignments/${a.id}`} className="text-primary underline">
                      {a.jobOrderTitle}
                    </Link>
                    <Badge variant={statusVariant(a.status)}>{formatStatusLabel(a.status)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Sin Assignments todavía para este Worker.</p>
            )}
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

        <Card>
          <CardHeader>
            <CardTitle>Actividad</CardTitle>
          </CardHeader>
          <CardContent>
            <Timeline items={activity ?? []} />
          </CardContent>
        </Card>
      </div>

      <Drawer open={editOpen} onClose={() => setEditOpen(false)} title="Editar Worker">
        <EditWorkerForm worker={worker} onDone={() => setEditOpen(false)} />
      </Drawer>

      {pendingStatus && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-sm p-4">
            <p className="text-sm font-medium">¿Terminar este Worker?</p>
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
