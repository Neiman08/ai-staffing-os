import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AssignmentListItem,
  CreatePayrollRunInput,
  CreateShiftInput,
  CreateTimeEntryInput,
  Paginated,
  PayrollReadinessResultDto,
  PayrollRunListItem,
  ShiftListItem,
  TimeEntryListItem,
} from "@ai-staffing-os/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { Plus } from "lucide-react";

// F9.6: DRAFT/SUBMITTED/NEEDS_REVIEW/REJECTED extienden aditivamente el
// lifecycle original PENDING/APPROVED/LOCKED de F5.6.
const STATUS_FILTERS = ["DRAFT", "PENDING", "SUBMITTED", "NEEDS_REVIEW", "APPROVED", "REJECTED", "LOCKED"];
// F9.6: bulk-approve acepta PENDING y SUBMITTED (NEEDS_REVIEW se excluye
// a propósito -- exige revisión manual explícita, ver payroll/service.ts).
const BULK_SELECTABLE_STATUSES = new Set(["PENDING", "SUBMITTED"]);
type Tab = "timesheets" | "shifts" | "runs" | "readiness";

function LogHoursForm({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // F5.6: reutiliza GET /assignments (F5.4) para el selector — sin
  // endpoint nuevo. Cualquier Assignment real puede recibir horas
  // (SCHEDULED o ACTIVE son las que tiene sentido cargar).
  const { data: assignments } = useQuery({
    queryKey: ["assignments", "for-timesheet-form"],
    queryFn: () => apiFetch<Paginated<AssignmentListItem>>("/assignments?limit=100"),
  });

  const [form, setForm] = useState<CreateTimeEntryInput>({
    assignmentId: "",
    date: new Date().toISOString().slice(0, 10),
    regularHours: 8,
    overtimeHours: 0,
    doubleHours: 0,
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateTimeEntryInput) =>
      apiFetch("/time-entries", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Horas registradas", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["time-entries"] });
      onDone();
    },
    onError: (err) => toast({ title: "No se pudieron registrar las horas", description: String(err), variant: "error" }),
  });

  const total = (form.regularHours ?? 0) + (form.overtimeHours ?? 0) + (form.doubleHours ?? 0);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate(form);
      }}
    >
      <div>
        <Label htmlFor="assignmentId">Assignment *</Label>
        <Select id="assignmentId" required value={form.assignmentId} onChange={(e) => setForm({ ...form, assignmentId: e.target.value })}>
          <option value="">Selecciona…</option>
          {assignments?.items.map((a) => (
            <option key={a.id} value={a.id}>
              {a.workerName} → {a.jobOrderTitle}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="date">Fecha *</Label>
        <Input id="date" type="date" required value={form.date.slice(0, 10)} onChange={(e) => setForm({ ...form, date: e.target.value })} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label htmlFor="regularHours">Regulares</Label>
          <Input
            id="regularHours"
            type="number"
            min={0}
            max={24}
            step="0.5"
            value={form.regularHours}
            onChange={(e) => setForm({ ...form, regularHours: Number(e.target.value) })}
          />
        </div>
        <div>
          <Label htmlFor="overtimeHours">Extra</Label>
          <Input
            id="overtimeHours"
            type="number"
            min={0}
            max={24}
            step="0.5"
            value={form.overtimeHours}
            onChange={(e) => setForm({ ...form, overtimeHours: Number(e.target.value) })}
          />
        </div>
        <div>
          <Label htmlFor="doubleHours">Doble</Label>
          <Input
            id="doubleHours"
            type="number"
            min={0}
            max={24}
            step="0.5"
            value={form.doubleHours}
            onChange={(e) => setForm({ ...form, doubleHours: Number(e.target.value) })}
          />
        </div>
      </div>
      {total > 24 && <p className="text-xs text-destructive">El total de horas de un día no puede superar 24.</p>}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="perDiem">Per diem</Label>
          <Input
            id="perDiem"
            type="number"
            min={0}
            step="0.01"
            value={form.perDiem ?? ""}
            onChange={(e) => setForm({ ...form, perDiem: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <div>
          <Label htmlFor="bonus">Bono</Label>
          <Input
            id="bonus"
            type="number"
            min={0}
            step="0.01"
            value={form.bonus ?? ""}
            onChange={(e) => setForm({ ...form, bonus: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending || !form.assignmentId || total > 24}>
        {createMutation.isPending ? "Registrando…" : "Registrar horas"}
      </Button>
    </form>
  );
}

function CreateShiftForm({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: assignments } = useQuery({
    queryKey: ["assignments", "for-shift-form"],
    queryFn: () => apiFetch<Paginated<AssignmentListItem>>("/assignments?limit=100"),
  });

  const [form, setForm] = useState<CreateShiftInput>({
    assignmentId: "",
    date: new Date().toISOString().slice(0, 10),
    startTime: "09:00",
    endTime: "17:00",
    breakMinutes: 0,
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateShiftInput) => apiFetch("/shifts", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Shift programado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["shifts"] });
      onDone();
    },
    onError: (err) => toast({ title: "No se pudo programar el shift", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate(form);
      }}
    >
      <div>
        <Label htmlFor="shiftAssignmentId">Assignment *</Label>
        <Select id="shiftAssignmentId" required value={form.assignmentId} onChange={(e) => setForm({ ...form, assignmentId: e.target.value })}>
          <option value="">Selecciona…</option>
          {assignments?.items.map((a) => (
            <option key={a.id} value={a.id}>
              {a.workerName} → {a.jobOrderTitle}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="shiftDate">Fecha *</Label>
        <Input id="shiftDate" type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="startTime">Inicio *</Label>
          <Input id="startTime" type="time" required value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="endTime">Fin *</Label>
          <Input id="endTime" type="time" required value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Un turno que termina antes de la hora de inicio se interpreta como nocturno (cruza medianoche).</p>
      <div>
        <Label htmlFor="breakMinutes">Descanso (min)</Label>
        <Input
          id="breakMinutes"
          type="number"
          min={0}
          max={720}
          value={form.breakMinutes ?? 0}
          onChange={(e) => setForm({ ...form, breakMinutes: Number(e.target.value) })}
        />
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending || !form.assignmentId}>
        {createMutation.isPending ? "Guardando…" : "Programar Shift"}
      </Button>
    </form>
  );
}

function ShiftsTab() {
  const { data: currentUser } = useCurrentUser();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [createOpen, setCreateOpen] = useState(false);
  const cursor = cursorStack[cursorStack.length - 1];

  const canCreate = currentUser?.permissions.includes("shifts.create") ?? false;

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);

  const { data, isLoading } = useQuery({
    queryKey: ["shifts", cursor],
    queryFn: () => apiFetch<Paginated<ShiftListItem>>(`/shifts?${params.toString()}`),
  });

  return (
    <div>
      <Card className="mb-4 flex items-center justify-between p-3">
        <p className="text-sm text-muted-foreground">Turnos programados por Assignment -- base para detectar discrepancias de horas.</p>
        {canCreate && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Programar Shift
          </Button>
        )}
      </Card>

      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Trabajador</TableHead>
                <TableHead>Job Order</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Horario</TableHead>
                <TableHead>Descanso</TableHead>
                <TableHead>Horas programadas</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((shift) => (
                <TableRow key={shift.id}>
                  <TableCell className="font-medium">{shift.workerName}</TableCell>
                  <TableCell className="text-muted-foreground">{shift.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(shift.date).toLocaleDateString()}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {shift.startTime}–{shift.endTime}
                    {shift.timezone && <span className="ml-1 text-xs">({shift.timezone})</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{shift.breakMinutes} min</TableCell>
                  <TableCell className="font-medium">{shift.scheduledHours}h</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin Shifts programados todavía.</p>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>

      <Drawer open={createOpen} onClose={() => setCreateOpen(false)} title="Programar Shift">
        <CreateShiftForm onDone={() => setCreateOpen(false)} />
      </Drawer>
    </div>
  );
}

/**
 * F9.7: consulta puntual de Payroll Readiness -- entra un workerId +
 * período, muestra el resultado real del backend (nunca calculado en el
 * frontend). Sin selector de Worker por nombre a propósito (se pega el
 * id directo, mismo criterio minimalista que otras herramientas de
 * lookup de esta fase) -- evita construir un segundo selector grande de
 * Workers solo para esta consulta ocasional.
 */
function PayrollReadinessTab() {
  const { toast } = useToast();
  const [workerId, setWorkerId] = useState("");
  const [periodStart, setPeriodStart] = useState(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitted, setSubmitted] = useState<{ workerId: string; periodStart: string; periodEnd: string } | null>(null);

  const query = useQuery({
    queryKey: ["payroll-readiness", submitted],
    queryFn: () =>
      apiFetch<PayrollReadinessResultDto>(
        `/payroll/readiness?workerId=${submitted!.workerId}&periodStart=${submitted!.periodStart}&periodEnd=${submitted!.periodEnd}`,
      ),
    enabled: !!submitted,
    retry: false,
  });

  return (
    <div className="max-w-xl space-y-4">
      <Card className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          Evalúa si un Worker está listo para incluirse en un Payroll Run para el período dado -- solo lectura, nunca
          procesa un pago real.
        </p>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!workerId) {
              toast({ title: "Ingresa un Worker ID", variant: "error" });
              return;
            }
            setSubmitted({ workerId, periodStart, periodEnd });
          }}
        >
          <div className="sm:col-span-3">
            <Label htmlFor="readinessWorkerId">Worker ID</Label>
            <Input id="readinessWorkerId" value={workerId} onChange={(e) => setWorkerId(e.target.value)} placeholder="worker-…" />
          </div>
          <div>
            <Label htmlFor="readinessPeriodStart">Desde</Label>
            <Input id="readinessPeriodStart" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="readinessPeriodEnd">Hasta</Label>
            <Input id="readinessPeriodEnd" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </div>
          <div className="flex items-end sm:col-span-3">
            <Button type="submit" size="sm" disabled={query.isFetching}>
              {query.isFetching ? "Evaluando…" : "Evaluar Readiness"}
            </Button>
          </div>
        </form>
      </Card>

      {query.isError && (
        <p role="alert" className="text-sm text-destructive">
          {query.error instanceof ApiError ? query.error.message : "No se pudo evaluar readiness."}
        </p>
      )}

      {query.data && (
        <Card className="space-y-2 p-4 text-sm">
          <div className="flex items-center justify-between">
            <Badge variant={statusVariant(query.data.status)}>{formatStatusLabel(query.data.status)}</Badge>
            <span className="text-xs text-muted-foreground">{query.data.timeEntryCount} time entr{query.data.timeEntryCount === 1 ? "y" : "ies"}</span>
          </div>
          {query.data.blockers.length > 0 && (
            <p className="text-destructive">
              <span className="font-medium">Bloqueadores: </span>
              {query.data.blockers.join(" · ")}
            </p>
          )}
          {query.data.reviewNotes.length > 0 && (
            <p className="text-amber-600 dark:text-amber-400">
              <span className="font-medium">Notas: </span>
              {query.data.reviewNotes.join(" · ")}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

function CreatePayrollRunForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreatePayrollRunInput>(() => ({
    periodStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    periodEnd: new Date().toISOString().slice(0, 10),
  }));

  const createMutation = useMutation({
    mutationFn: (input: CreatePayrollRunInput) =>
      apiFetch<{ id: string }>("/payroll/runs", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (run) => {
      toast({ title: "Payroll run creado (DRAFT)", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["payroll-runs"] });
      queryClient.invalidateQueries({ queryKey: ["time-entries"] });
      onCreated(run.id);
    },
    onError: (err) => toast({ title: "No se pudo crear el run", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate(form);
      }}
    >
      <p className="text-xs text-muted-foreground">
        Agrega todas las TimeEntry APPROVED dentro del período elegido, agrupadas por Assignment. Las entradas
        incluidas pasan a LOCKED — no vuelven a incluirse en otro run.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="periodStart">Desde *</Label>
          <Input
            id="periodStart"
            type="date"
            required
            value={form.periodStart.slice(0, 10)}
            onChange={(e) => setForm({ ...form, periodStart: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="periodEnd">Hasta *</Label>
          <Input
            id="periodEnd"
            type="date"
            required
            value={form.periodEnd.slice(0, 10)}
            onChange={(e) => setForm({ ...form, periodEnd: e.target.value })}
          />
        </div>
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending}>
        {createMutation.isPending ? "Creando…" : "Crear Payroll Run"}
      </Button>
    </form>
  );
}

/**
 * F9.6: acciones de una sola TimeEntry -- submit (DRAFT -> SUBMITTED/
 * NEEDS_REVIEW, decidido por el backend, nunca a discreción del
 * frontend), approve, reject (exige motivo) y reopen (REJECTED ->
 * DRAFT, nunca un rechazo permanente). Todas reutilizan timeEntries.update
 * (mismo criterio que bulk-approve en F5.6).
 */
function TimeEntryRowActions({ entry, canManage }: { entry: TimeEntryListItem; canManage: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["time-entries"] });

  const submitMutation = useMutation({
    mutationFn: () => apiFetch(`/time-entries/${entry.id}/submit`, { method: "POST" }),
    onSuccess: (updated) => {
      const t = updated as { status: string };
      toast({ title: `Enviado: ${formatStatusLabel(t.status)}`, variant: "success" });
      invalidate();
    },
    onError: (err) => toast({ title: "No se pudo enviar", description: String(err), variant: "error" }),
  });

  const approveMutation = useMutation({
    mutationFn: () => apiFetch(`/time-entries/${entry.id}/approve`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Entrada aprobada", variant: "success" });
      invalidate();
    },
    onError: (err) => toast({ title: "No se pudo aprobar", description: String(err), variant: "error" }),
  });

  const rejectMutation = useMutation({
    mutationFn: () => apiFetch(`/time-entries/${entry.id}/reject`, { method: "POST", body: JSON.stringify({ rejectionReason: reason }) }),
    onSuccess: () => {
      toast({ title: "Entrada rechazada", variant: "success" });
      setRejecting(false);
      setReason("");
      invalidate();
    },
    onError: (err) => toast({ title: "No se pudo rechazar", description: String(err), variant: "error" }),
  });

  const reopenMutation = useMutation({
    mutationFn: () => apiFetch(`/time-entries/${entry.id}/reopen`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Reabierta como DRAFT", variant: "success" });
      invalidate();
    },
    onError: (err) => toast({ title: "No se pudo reabrir", description: String(err), variant: "error" }),
  });

  if (!canManage) return null;

  if (rejecting) {
    return (
      <div className="flex items-center gap-1">
        <Input
          className="h-7 w-36 text-xs"
          placeholder="Motivo del rechazo…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!reason || rejectMutation.isPending} onClick={() => rejectMutation.mutate()}>
          Confirmar
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setRejecting(false); setReason(""); }}>
          Cancelar
        </Button>
      </div>
    );
  }

  const pending = submitMutation.isPending || approveMutation.isPending || reopenMutation.isPending;

  return (
    <div className="flex items-center gap-1">
      {entry.status === "DRAFT" && (
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={pending} onClick={() => submitMutation.mutate()}>
          Enviar
        </Button>
      )}
      {(entry.status === "PENDING" || entry.status === "SUBMITTED" || entry.status === "NEEDS_REVIEW") && (
        <>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={pending} onClick={() => approveMutation.mutate()}>
            Aprobar
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => setRejecting(true)}>
            Rechazar
          </Button>
        </>
      )}
      {entry.status === "REJECTED" && (
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={pending} onClick={() => reopenMutation.mutate()}>
          Reabrir
        </Button>
      )}
    </div>
  );
}

function TimesheetsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [status, setStatus] = useState("");
  const [logHoursOpen, setLogHoursOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const cursor = cursorStack[cursorStack.length - 1];

  const canCreate = currentUser?.permissions.includes("timeEntries.create") ?? false;
  const canApprove = currentUser?.permissions.includes("timeEntries.update") ?? false;

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  if (status) params.set("status", status);

  const { data, isLoading } = useQuery({
    queryKey: ["time-entries", cursor, status],
    queryFn: () => apiFetch<Paginated<TimeEntryListItem>>(`/time-entries?${params.toString()}`),
  });

  const approveMutation = useMutation({
    mutationFn: (ids: string[]) => apiFetch("/time-entries/bulk-approve", { method: "POST", body: JSON.stringify({ ids }) }),
    onSuccess: (result: unknown) => {
      const { approved } = result as { approved: number; skipped: number };
      toast({ title: `${approved} entrada(s) aprobada(s)`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["time-entries"] });
      setSelectedIds(new Set());
    },
    onError: (err) => toast({ title: "No se pudo aprobar", description: String(err), variant: "error" }),
  });

  function resetAndFilter(fn: () => void) {
    fn();
    setCursorStack([undefined]);
    setSelectedIds(new Set());
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="w-44">
          <Label htmlFor="statusFilter">Estado</Label>
          <Select id="statusFilter" value={status} onChange={(e) => resetAndFilter(() => setStatus(e.target.value))}>
            <option value="">Todos</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        {canCreate && (
          <Button size="sm" onClick={() => setLogHoursOpen(true)}>
            <Plus className="h-4 w-4" />
            Log Hours
          </Button>
        )}
        {canApprove && selectedIds.size > 0 && (
          <Button
            size="sm"
            disabled={approveMutation.isPending}
            onClick={() => approveMutation.mutate(Array.from(selectedIds))}
          >
            {approveMutation.isPending ? "Aprobando…" : `Aprobar seleccionadas (${selectedIds.size})`}
          </Button>
        )}
      </Card>

      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {canApprove && <TableHead className="w-10">Sel.</TableHead>}
                <TableHead>Trabajador</TableHead>
                <TableHead>Job Order</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Reg / OT / Doble</TableHead>
                <TableHead>Bill</TableHead>
                <TableHead>Pay</TableHead>
                <TableHead>Margen</TableHead>
                <TableHead>Estado</TableHead>
                {canApprove && <TableHead>Acciones</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((entry) => (
                <TableRow key={entry.id}>
                  {canApprove && (
                    <TableCell>
                      {BULK_SELECTABLE_STATUSES.has(entry.status) && (
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border"
                          checked={selectedIds.has(entry.id)}
                          onChange={() => toggleSelected(entry.id)}
                        />
                      )}
                    </TableCell>
                  )}
                  <TableCell className="font-medium">{entry.workerName}</TableCell>
                  <TableCell className="text-muted-foreground">{entry.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(entry.date).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {entry.regularHours} / {entry.overtimeHours} / {entry.doubleHours}
                  </TableCell>
                  <TableCell className="text-muted-foreground">${entry.billAmount}</TableCell>
                  <TableCell className="text-muted-foreground">${entry.payAmount}</TableCell>
                  <TableCell className="font-medium text-emerald-600 dark:text-emerald-400">
                    ${entry.margin}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={statusVariant(entry.status)}>{formatStatusLabel(entry.status)}</Badge>
                      {entry.overtimeFlag && <Badge variant="warning">OT</Badge>}
                      {entry.discrepancyFlag && <Badge variant="warning" title={entry.discrepancyNotes ?? undefined}>Discrepancia</Badge>}
                    </div>
                  </TableCell>
                  {canApprove && (
                    <TableCell>
                      <TimeEntryRowActions entry={entry} canManage={canApprove} />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>

      <Drawer open={logHoursOpen} onClose={() => setLogHoursOpen(false)} title="Log Hours">
        <LogHoursForm onDone={() => setLogHoursOpen(false)} />
      </Drawer>
    </div>
  );
}

function PayrollRunsTab() {
  const navigate = useNavigate();
  const { data: currentUser } = useCurrentUser();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [createOpen, setCreateOpen] = useState(false);
  const cursor = cursorStack[cursorStack.length - 1];

  const canCreate = currentUser?.permissions.includes("payrollRuns.create") ?? false;

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);

  const { data, isLoading } = useQuery({
    queryKey: ["payroll-runs", cursor],
    queryFn: () => apiFetch<Paginated<PayrollRunListItem>>(`/payroll/runs?${params.toString()}`),
  });

  return (
    <div>
      <Card className="mb-4 flex items-center justify-between p-3">
        <p className="text-sm text-muted-foreground">Runs de nómina generados desde horas ya aprobadas.</p>
        {canCreate && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New Payroll Run
          </Button>
        )}
      </Card>

      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Período</TableHead>
                <TableHead>Workers</TableHead>
                <TableHead>Gross</TableHead>
                <TableHead>Bill</TableHead>
                <TableHead>Margen</TableHead>
                <TableHead>Creado por</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((run) => (
                <TableRow key={run.id} className="cursor-pointer" onClick={() => navigate(`/payroll-runs/${run.id}`)}>
                  <TableCell className="font-medium">
                    {new Date(run.periodStart).toLocaleDateString()} – {new Date(run.periodEnd).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{run.itemCount}</TableCell>
                  <TableCell className="text-muted-foreground">${run.totalGross}</TableCell>
                  <TableCell className="text-muted-foreground">${run.totalBill}</TableCell>
                  <TableCell className="font-medium text-emerald-600 dark:text-emerald-400">${run.totalMargin}</TableCell>
                  <TableCell className="text-muted-foreground">{run.createdByName ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(run.status)}>{formatStatusLabel(run.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Sin Payroll Runs todavía — crea el primero con "New Payroll Run".
          </p>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>

      <Drawer open={createOpen} onClose={() => setCreateOpen(false)} title="New Payroll Run">
        <CreatePayrollRunForm
          onCreated={(id) => {
            setCreateOpen(false);
            navigate(`/payroll-runs/${id}`);
          }}
        />
      </Drawer>
    </div>
  );
}

const TAB_LABELS: Record<Tab, string> = {
  timesheets: "Timesheets",
  shifts: "Shifts",
  runs: "Payroll Runs",
  readiness: "Readiness",
};

export default function Payroll() {
  const [tab, setTab] = useState<Tab>("timesheets");

  return (
    <div>
      <PageHeader title="Payroll" description="Horas registradas, márgenes, aprobación y runs de nómina" />

      <div className="mb-4 flex gap-1 rounded-md border border-border bg-secondary/40 p-1 w-fit">
        {(["timesheets", "shifts", "runs", "readiness"] as const).map((t) => (
          <Button
            key={t}
            variant={tab === t ? "default" : "ghost"}
            size="sm"
            onClick={() => setTab(t)}
            className={cn(tab !== t && "text-muted-foreground")}
          >
            {TAB_LABELS[t]}
          </Button>
        ))}
      </div>

      {tab === "timesheets" && <TimesheetsTab />}
      {tab === "shifts" && <ShiftsTab />}
      {tab === "runs" && <PayrollRunsTab />}
      {tab === "readiness" && <PayrollReadinessTab />}
    </div>
  );
}
