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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { AlertTriangle, Plus } from "lucide-react";
import type { WorkerAssignmentItem, WorkerTimeEntryItem } from "./types";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function CreateDraftForm({ assignments, onCreated }: { assignments: WorkerAssignmentItem[]; onCreated: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => ({
    assignmentId: assignments[0]?.id ?? "",
    date: todayIso(),
    startTime: "08:00",
    endTime: "16:00",
    breakMinutes: 30,
    notes: "",
  }));

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch("/portal/worker/time-entries", {
        method: "POST",
        body: JSON.stringify({ ...form, notes: form.notes.trim() || undefined }),
      }),
    onSuccess: () => {
      toast({ title: "Borrador creado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["portal-worker-time-entries"] });
      onCreated();
    },
    onError: (err) => toast({ title: "No se pudo crear el borrador", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate();
      }}
    >
      <div>
        <Label htmlFor="te-assignment">Assignment *</Label>
        <Select id="te-assignment" required value={form.assignmentId} onChange={(e) => setForm({ ...form, assignmentId: e.target.value })}>
          {assignments.map((a) => (
            <option key={a.id} value={a.id}>
              {a.jobOrderTitle} -- {a.companyName}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="te-date">Fecha *</Label>
        <Input id="te-date" type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="te-start">Hora inicio *</Label>
          <Input id="te-start" type="time" required value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="te-end">Hora fin *</Label>
          <Input id="te-end" type="time" required value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
        </div>
      </div>
      <div>
        <Label htmlFor="te-break">Break (minutos)</Label>
        <Input
          id="te-break"
          type="number"
          min={0}
          value={form.breakMinutes}
          onChange={(e) => setForm({ ...form, breakMinutes: Number(e.target.value) })}
        />
      </div>
      <div>
        <Label htmlFor="te-notes">Nota</Label>
        <Textarea id="te-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending || !form.assignmentId}>
        {createMutation.isPending ? "Guardando…" : "Guardar borrador"}
      </Button>
    </form>
  );
}

function EditDraftForm({ entry, onSaved }: { entry: WorkerTimeEntryItem; onSaved: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("16:00");
  const [breakMinutes, setBreakMinutes] = useState(30);
  const [notes, setNotes] = useState(entry.notes ?? "");

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/portal/worker/time-entries/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ startTime, endTime, breakMinutes, notes: notes.trim() || undefined }),
      }),
    onSuccess: () => {
      toast({ title: "Borrador actualizado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["portal-worker-time-entries"] });
      onSaved();
    },
    onError: (err) => toast({ title: "No se pudo actualizar", description: String(err), variant: "error" }),
  });

  const submitMutation = useMutation({
    mutationFn: () => apiFetch(`/portal/worker/time-entries/${entry.id}/submit`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Horas enviadas", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["portal-worker-time-entries"] });
      onSaved();
    },
    onError: (err) => toast({ title: "No se pudo enviar", description: String(err), variant: "error" }),
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="edit-start">Hora inicio</Label>
          <Input id="edit-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="edit-end">Hora fin</Label>
          <Input id="edit-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="edit-break">Break (minutos)</Label>
        <Input id="edit-break" type="number" min={0} value={breakMinutes} onChange={(e) => setBreakMinutes(Number(e.target.value))} />
      </div>
      <div>
        <Label htmlFor="edit-notes">Nota</Label>
        <Textarea id="edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? "Guardando…" : "Guardar cambios"}
        </Button>
        <Button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending}>
          {submitMutation.isPending ? "Enviando…" : "Enviar"}
        </Button>
      </div>
    </div>
  );
}

export default function WorkerTimeEntriesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WorkerTimeEntryItem | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["portal-worker-time-entries"],
    queryFn: () => apiFetch<{ items: WorkerTimeEntryItem[]; nextCursor: string | null }>("/portal/worker/time-entries?limit=50"),
  });
  const { data: assignments } = useQuery({
    queryKey: ["portal-worker-assignments"],
    queryFn: () => apiFetch<WorkerAssignmentItem[]>("/portal/worker/assignments"),
  });

  const reopenMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/portal/worker/time-entries/${id}/reopen`, { method: "POST" }),
    onSuccess: (_, id) => {
      toast({ title: "Reabierto -- corrígelo y vuelve a enviarlo", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["portal-worker-time-entries"] });
      const reopened = data?.items.find((t) => t.id === id);
      if (reopened) setEditing({ ...reopened, status: "DRAFT" });
    },
    onError: (err) => toast({ title: "No se pudo reabrir", description: String(err), variant: "error" }),
  });

  return (
    <div>
      <PageHeader
        title="Time Entries"
        description="Tus horas registradas."
        action={
          assignments && assignments.length > 0 ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Nuevo borrador
            </Button>
          ) : undefined
        }
      />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job Order</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Reg / OT / Doble</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>
                  <span className="sr-only">Acciones</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(t.date).toLocaleDateString()}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {t.regularHours} / {t.overtimeHours} / {t.doubleHours}
                    {t.overtimeFlag && (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs text-amber-600" title="Overtime warning -- not a legal determination">
                        <AlertTriangle className="h-3 w-3" />
                        OT
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(t.status)}>{formatStatusLabel(t.status)}</Badge>
                    {t.discrepancyFlag && t.discrepancyNotes && <p className="mt-1 text-xs text-amber-600">{t.discrepancyNotes}</p>}
                    {t.rejectionReason && <p className="mt-1 text-xs text-destructive">{t.rejectionReason}</p>}
                    {t.notes && <p className="mt-1 text-xs text-muted-foreground">Nota: {t.notes}</p>}
                  </TableCell>
                  <TableCell>
                    {t.status === "DRAFT" && (
                      <Button size="sm" variant="outline" onClick={() => setEditing(t)}>
                        Editar
                      </Button>
                    )}
                    {t.status === "REJECTED" && (
                      <Button size="sm" variant="outline" disabled={reopenMutation.isPending} onClick={() => reopenMutation.mutate(t.id)}>
                        Corregir y reenviar
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin horas registradas todavía.</p>
        )}
      </Card>

      <Drawer open={createOpen} onClose={() => setCreateOpen(false)} title="Nuevo borrador de horas">
        {assignments && <CreateDraftForm assignments={assignments} onCreated={() => setCreateOpen(false)} />}
      </Drawer>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title="Editar borrador">
        {editing && <EditDraftForm entry={editing} onSaved={() => setEditing(null)} />}
      </Drawer>
    </div>
  );
}
