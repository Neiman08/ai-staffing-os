import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AssignmentListItem,
  CreateAssignmentInput,
  JobOrderListItem,
  Paginated,
  WorkerListItem,
} from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
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

const STATUS_FILTERS = ["SCHEDULED", "ACTIVE", "COMPLETED", "TERMINATED"];

function NewAssignmentForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // F5.4: reutiliza GET /workers y GET /job-orders (ya existentes) para
  // poblar los selectores, sin endpoints nuevos. Workers: solo
  // AVAILABLE+COMPLIANT pueden recibir una Assignment nueva (ver
  // assignments/service.ts). Job Orders: se filtra client-side a
  // OPEN/PARTIALLY_FILLED con cupo real, ya que el query actual solo
  // admite un único status a la vez.
  const { data: availableWorkers } = useQuery({
    queryKey: ["workers", "available-compliant"],
    queryFn: () => apiFetch<Paginated<WorkerListItem>>("/workers?status=AVAILABLE&complianceStatus=COMPLIANT&limit=100"),
  });
  const { data: allOpenJobOrders } = useQuery({
    queryKey: ["job-orders", "for-assignment-form"],
    queryFn: () => apiFetch<Paginated<JobOrderListItem>>("/job-orders?limit=100"),
  });
  const openJobOrders = allOpenJobOrders?.items.filter(
    (jo) => (jo.status === "OPEN" || jo.status === "PARTIALLY_FILLED") && jo.workersFilled < jo.workersNeeded,
  );

  const [form, setForm] = useState<CreateAssignmentInput>({
    workerId: "",
    jobOrderId: "",
    payRate: 0,
    billRate: 0,
    startDate: new Date().toISOString().slice(0, 10),
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateAssignmentInput) =>
      apiFetch<{ id: string }>("/assignments", {
        method: "POST",
        body: JSON.stringify({ ...input, endDate: input.endDate || undefined }),
      }),
    onSuccess: (assignment) => {
      toast({ title: "Assignment creada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["assignments"] });
      queryClient.invalidateQueries({ queryKey: ["workers"] });
      queryClient.invalidateQueries({ queryKey: ["job-orders"] });
      onCreated(assignment.id);
    },
    onError: (err) => toast({ title: "No se pudo crear la Assignment", description: String(err), variant: "error" }),
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
        <Label htmlFor="workerId">Worker (AVAILABLE + COMPLIANT) *</Label>
        <Select id="workerId" required value={form.workerId} onChange={(e) => setForm({ ...form, workerId: e.target.value })}>
          <option value="">Selecciona un worker…</option>
          {availableWorkers?.items.map((w) => (
            <option key={w.id} value={w.id}>
              {w.candidateName}
            </option>
          ))}
        </Select>
        {availableWorkers && availableWorkers.items.length === 0 && (
          <p className="mt-1 text-xs text-muted-foreground">No hay workers disponibles y compliant en este momento.</p>
        )}
      </div>
      <div>
        <Label htmlFor="jobOrderId">Job Order (con cupo real) *</Label>
        <Select id="jobOrderId" required value={form.jobOrderId} onChange={(e) => setForm({ ...form, jobOrderId: e.target.value })}>
          <option value="">Selecciona un job order…</option>
          {openJobOrders?.map((jo) => (
            <option key={jo.id} value={jo.id}>
              {jo.title} ({jo.workersFilled}/{jo.workersNeeded})
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="payRate">Pay rate *</Label>
          <Input
            id="payRate"
            type="number"
            min={0}
            step="0.01"
            required
            value={form.payRate}
            onChange={(e) => setForm({ ...form, payRate: Number(e.target.value) })}
          />
        </div>
        <div>
          <Label htmlFor="billRate">Bill rate *</Label>
          <Input
            id="billRate"
            type="number"
            min={0}
            step="0.01"
            required
            value={form.billRate}
            onChange={(e) => setForm({ ...form, billRate: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="startDate">Fecha de inicio *</Label>
          <Input
            id="startDate"
            type="date"
            required
            value={form.startDate.slice(0, 10)}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="endDate">Fecha estimada de fin</Label>
          <Input
            id="endDate"
            type="date"
            value={form.endDate ? form.endDate.slice(0, 10) : ""}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
          />
        </div>
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending}>
        {createMutation.isPending ? "Creando…" : "Crear Assignment"}
      </Button>
    </form>
  );
}

export default function Assignments() {
  const navigate = useNavigate();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const cursor = cursorStack[cursorStack.length - 1];

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  if (search) params.set("search", search);
  if (status) params.set("status", status);

  const { data, isLoading } = useQuery({
    queryKey: ["assignments", cursor, search, status],
    queryFn: () => apiFetch<Paginated<AssignmentListItem>>(`/assignments?${params.toString()}`),
  });

  function resetAndFilter(fn: () => void) {
    fn();
    setCursorStack([undefined]);
  }

  return (
    <div>
      <PageHeader
        title="Assignments"
        description="Ciclo de asignación de Workers a Job Orders"
        action={
          <Button onClick={() => setDrawerOpen(true)}>
            <Plus className="h-4 w-4" />
            New Assignment
          </Button>
        }
      />

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-[200px] flex-1">
          <Label htmlFor="search">Buscar por worker o job order</Label>
          <Input
            id="search"
            placeholder="Buscar…"
            value={search}
            onChange={(e) => resetAndFilter(() => setSearch(e.target.value))}
          />
        </div>
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
      </Card>

      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Job Order</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Bill / Pay</TableHead>
                <TableHead>Inicio</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((assignment) => (
                <TableRow
                  key={assignment.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/assignments/${assignment.id}`)}
                >
                  <TableCell className="font-medium">{assignment.workerName}</TableCell>
                  <TableCell className="text-muted-foreground">{assignment.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">{assignment.companyName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    ${Number(assignment.billRate).toFixed(2)} / ${Number(assignment.payRate).toFixed(2)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{new Date(assignment.startDate).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(assignment.status)}>{formatStatusLabel(assignment.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Sin Assignments todavía — crea la primera con "New Assignment".
          </p>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="New Assignment">
        <NewAssignmentForm
          onCreated={(id) => {
            setDrawerOpen(false);
            navigate(`/assignments/${id}`);
          }}
        />
      </Drawer>
    </div>
  );
}
