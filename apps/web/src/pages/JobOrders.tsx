import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyListItem,
  CreateJobOrderInput,
  DocumentTypeListItem,
  JobCategoryListItem,
  JobOrderListItem,
  Paginated,
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
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { Plus } from "lucide-react";

const URGENCY_LEVELS = ["LOW", "MEDIUM", "HIGH"];
const SHIFT_TYPES = ["DAY", "NIGHT", "WEEKEND", "ROTATING"];
const STATUS_FILTERS = ["DRAFT", "OPEN", "PARTIALLY_FILLED", "FILLED", "CLOSED", "CANCELLED"];

function emptyForm(): CreateJobOrderInput {
  return {
    companyId: "",
    categoryId: "",
    title: "",
    description: "",
    workersNeeded: 1,
    billRate: 0,
    payRate: 0,
    location: { address: "", city: "", state: "" },
    shiftType: "DAY",
    scheduleNotes: "",
    startDate: new Date().toISOString().slice(0, 10),
    endDate: "",
    urgency: "MEDIUM",
    requirements: [],
  };
}

function NewJobOrderForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: companies } = useQuery({
    queryKey: ["companies", "for-job-order-form"],
    queryFn: () => apiFetch<Paginated<CompanyListItem>>("/companies?limit=100"),
  });
  const { data: categories } = useQuery({
    queryKey: ["job-categories"],
    queryFn: () => apiFetch<JobCategoryListItem[]>("/job-categories"),
  });
  const { data: documentTypes } = useQuery({
    queryKey: ["document-types"],
    queryFn: () => apiFetch<DocumentTypeListItem[]>("/compliance/document-types"),
  });

  const [form, setForm] = useState<CreateJobOrderInput>(emptyForm());

  const createMutation = useMutation({
    mutationFn: (input: CreateJobOrderInput) => {
      // Location es opcional como un todo — si ninguno de sus campos se
      // completó, no se manda (evita el error "state y city requeridos
      // si se proporciona location" por un objeto vacío sin querer).
      const location =
        input.location && (input.location.city || input.location.state || input.location.address)
          ? input.location
          : undefined;
      const payload: CreateJobOrderInput = {
        ...input,
        location,
        endDate: input.endDate || undefined,
        description: input.description || undefined,
        scheduleNotes: input.scheduleNotes || undefined,
      };
      return apiFetch<{ id: string }>("/job-orders", { method: "POST", body: JSON.stringify(payload) });
    },
    onSuccess: (jobOrder) => {
      toast({ title: "Job Order creado (DRAFT)", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["job-orders"] });
      onCreated(jobOrder.id);
    },
    onError: (err) => toast({ title: "No se pudo crear el Job Order", description: String(err), variant: "error" }),
  });

  function toggleRequirement(key: string) {
    setForm((f) => ({
      ...f,
      requirements: f.requirements?.includes(key)
        ? f.requirements.filter((k) => k !== key)
        : [...(f.requirements ?? []), key],
    }));
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate(form);
      }}
    >
      <div>
        <Label htmlFor="companyId">Company *</Label>
        <Select
          id="companyId"
          required
          value={form.companyId}
          onChange={(e) => setForm({ ...form, companyId: e.target.value })}
        >
          <option value="">Selecciona una empresa…</option>
          {companies?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="categoryId">Job Category *</Label>
        <Select
          id="categoryId"
          required
          value={form.categoryId}
          onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
        >
          <option value="">Selecciona una categoría…</option>
          {categories?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="title">Título *</Label>
        <Input id="title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="description">Descripción</Label>
        <Textarea
          id="description"
          value={form.description ?? ""}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label htmlFor="workersNeeded">Cantidad requerida *</Label>
          <Input
            id="workersNeeded"
            type="number"
            min={1}
            required
            value={form.workersNeeded}
            onChange={(e) => setForm({ ...form, workersNeeded: Number(e.target.value) })}
          />
        </div>
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
      {form.billRate <= form.payRate && (
        <p className="text-xs text-destructive">Bill rate debe ser mayor que pay rate.</p>
      )}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label htmlFor="address">Dirección</Label>
          <Input
            id="address"
            value={form.location?.address ?? ""}
            onChange={(e) => setForm({ ...form, location: { ...form.location!, address: e.target.value } })}
          />
        </div>
        <div>
          <Label htmlFor="city">Ciudad</Label>
          <Input
            id="city"
            value={form.location?.city ?? ""}
            onChange={(e) =>
              setForm({ ...form, location: { ...form.location!, city: e.target.value, state: form.location?.state ?? "" } })
            }
          />
        </div>
        <div>
          <Label htmlFor="state">Estado</Label>
          <Input
            id="state"
            value={form.location?.state ?? ""}
            onChange={(e) =>
              setForm({ ...form, location: { ...form.location!, state: e.target.value, city: form.location?.city ?? "" } })
            }
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="shiftType">Turno</Label>
          <Select id="shiftType" value={form.shiftType} onChange={(e) => setForm({ ...form, shiftType: e.target.value as never })}>
            {SHIFT_TYPES.map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="urgency">Prioridad</Label>
          <Select id="urgency" value={form.urgency} onChange={(e) => setForm({ ...form, urgency: e.target.value as never })}>
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
      <div>
        <Label htmlFor="scheduleNotes">Notas de horario</Label>
        <Textarea
          id="scheduleNotes"
          value={form.scheduleNotes ?? ""}
          onChange={(e) => setForm({ ...form, scheduleNotes: e.target.value })}
        />
      </div>
      {documentTypes && documentTypes.length > 0 && (
        <div>
          <Label>Documentos requeridos</Label>
          <div className="mt-1 grid grid-cols-2 gap-1.5 rounded-md border border-border p-2">
            {documentTypes.map((dt) => (
              <label key={dt.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-border"
                  checked={form.requirements?.includes(dt.key) ?? false}
                  onChange={() => toggleRequirement(dt.key)}
                />
                {dt.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <Button type="submit" className="w-full" disabled={createMutation.isPending}>
        {createMutation.isPending ? "Creando…" : "Crear Job Order (DRAFT)"}
      </Button>
    </form>
  );
}

export default function JobOrders() {
  const navigate = useNavigate();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [urgency, setUrgency] = useState("");
  const cursor = cursorStack[cursorStack.length - 1];

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  if (urgency) params.set("urgency", urgency);

  const { data, isLoading } = useQuery({
    queryKey: ["job-orders", cursor, search, status, urgency],
    queryFn: () => apiFetch<Paginated<JobOrderListItem>>(`/job-orders?${params.toString()}`),
  });

  function resetAndFilter(fn: () => void) {
    fn();
    setCursorStack([undefined]);
  }

  return (
    <div>
      <PageHeader
        title="Job Orders"
        description="Vacantes activas de clientes"
        action={
          <Button onClick={() => setDrawerOpen(true)}>
            <Plus className="h-4 w-4" />
            New Job Order
          </Button>
        }
      />

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-[200px] flex-1">
          <Label htmlFor="search">Buscar por título</Label>
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
        <div className="w-44">
          <Label htmlFor="urgencyFilter">Prioridad</Label>
          <Select id="urgencyFilter" value={urgency} onChange={(e) => resetAndFilter(() => setUrgency(e.target.value))}>
            <option value="">Todas</option>
            {URGENCY_LEVELS.map((u) => (
              <option key={u} value={u}>
                {formatStatusLabel(u)}
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
                <TableHead>Título</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Categoría</TableHead>
                <TableHead>Fill</TableHead>
                <TableHead>Bill / Pay</TableHead>
                <TableHead>Turno</TableHead>
                <TableHead>Prioridad</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((jobOrder) => (
                <TableRow
                  key={jobOrder.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/job-orders/${jobOrder.id}`)}
                >
                  <TableCell className="font-medium">{jobOrder.title}</TableCell>
                  <TableCell className="text-muted-foreground">{jobOrder.companyName}</TableCell>
                  <TableCell className="text-muted-foreground">{jobOrder.categoryName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {jobOrder.workersFilled}/{jobOrder.workersNeeded}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    ${Number(jobOrder.billRate).toFixed(2)} / ${Number(jobOrder.payRate).toFixed(2)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatStatusLabel(jobOrder.shiftType)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(jobOrder.urgency)}>{formatStatusLabel(jobOrder.urgency)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(jobOrder.status)}>{formatStatusLabel(jobOrder.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Sin Job Orders todavía — crea el primero con "New Job Order".
          </p>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="New Job Order">
        <NewJobOrderForm
          onCreated={(id) => {
            setDrawerOpen(false);
            navigate(`/job-orders/${id}`);
          }}
        />
      </Drawer>
    </div>
  );
}
