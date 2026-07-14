import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssignmentListItem, CreateTimeEntryInput, Paginated, TimeEntryListItem } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
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
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { Plus } from "lucide-react";

const STATUS_FILTERS = ["PENDING", "APPROVED", "LOCKED"];

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

export default function Payroll() {
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

  const pendingItems = data?.items.filter((e) => e.status === "PENDING") ?? [];

  return (
    <div>
      <PageHeader
        title="Payroll"
        description="Horas registradas, márgenes y aprobación por asignación"
        action={
          canCreate ? (
            <Button onClick={() => setLogHoursOpen(true)}>
              <Plus className="h-4 w-4" />
              Log Hours
            </Button>
          ) : undefined
        }
      />

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
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((entry) => (
                <TableRow key={entry.id}>
                  {canApprove && (
                    <TableCell>
                      {entry.status === "PENDING" && (
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
                    <Badge variant={statusVariant(entry.status)}>{formatStatusLabel(entry.status)}</Badge>
                  </TableCell>
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

      {pendingItems.length === 0 && data && data.items.length > 0 && status === "" && (
        <p className="mt-2 text-xs text-muted-foreground">No hay entradas PENDING en esta página para aprobar.</p>
      )}

      <Drawer open={logHoursOpen} onClose={() => setLogHoursOpen(false)} title="Log Hours">
        <LogHoursForm onDone={() => setLogHoursOpen(false)} />
      </Drawer>
    </div>
  );
}
