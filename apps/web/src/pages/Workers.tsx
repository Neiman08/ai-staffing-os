import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CandidateListItem, CreateWorkerInput, JobCategoryListItem, Paginated, WorkerListItem } from "@ai-staffing-os/shared";
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

const STATUS_FILTERS = ["AVAILABLE", "ASSIGNED", "ON_LEAVE", "TERMINATED"];
const EMPLOYMENT_TYPES = ["W2", "C1099"];
const COMPLIANCE_FILTERS = ["COMPLIANT", "PENDING", "BLOCKED"];

function NewWorkerForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // F5.3: Worker.candidateId es una FK única y NO nullable — solo se
  // puede crear un Worker a partir de un Candidate QUALIFIED que todavía
  // no tenga uno. Se reutiliza GET /candidates (F5.2) con los mismos
  // filtros, en vez de inventar un endpoint nuevo solo para esto.
  const { data: qualifiedCandidates } = useQuery({
    queryKey: ["candidates", "qualified-without-worker"],
    queryFn: () =>
      apiFetch<Paginated<CandidateListItem>>("/candidates?status=QUALIFIED&isWorker=false&limit=100"),
  });
  const [form, setForm] = useState<CreateWorkerInput>({
    candidateId: "",
    employmentType: "W2",
    defaultPayRate: 0,
    hiredAt: "",
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateWorkerInput) =>
      apiFetch<{ id: string }>("/workers", {
        method: "POST",
        body: JSON.stringify({ ...input, hiredAt: input.hiredAt || undefined }),
      }),
    onSuccess: (worker) => {
      toast({ title: "Worker creado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["workers"] });
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
      onCreated(worker.id);
    },
    onError: (err) => toast({ title: "No se pudo crear el Worker", description: String(err), variant: "error" }),
  });

  const selectedCandidate = qualifiedCandidates?.items.find((c) => c.id === form.candidateId);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate(form);
      }}
    >
      <div>
        <Label htmlFor="candidateId">Candidate (QUALIFIED, sin Worker todavía) *</Label>
        <Select
          id="candidateId"
          required
          value={form.candidateId}
          onChange={(e) => setForm({ ...form, candidateId: e.target.value })}
        >
          <option value="">Selecciona un candidate…</option>
          {qualifiedCandidates?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.firstName} {c.lastName}
            </option>
          ))}
        </Select>
        {qualifiedCandidates && qualifiedCandidates.items.length === 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            No hay candidates QUALIFIED sin convertir todavía. Un Candidate debe llegar a QUALIFIED antes de poder
            crear su Worker.
          </p>
        )}
        {selectedCandidate && (
          <p className="mt-1 text-xs text-muted-foreground">
            Categorías: {selectedCandidate.categoryNames.join(", ") || "—"} · {selectedCandidate.city ?? "—"},{" "}
            {selectedCandidate.state ?? "—"}
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="employmentType">Employment type *</Label>
          <Select
            id="employmentType"
            required
            value={form.employmentType}
            onChange={(e) => setForm({ ...form, employmentType: e.target.value as never })}
          >
            <option value="W2">W2</option>
            <option value="C1099">1099</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="defaultPayRate">Default pay rate *</Label>
          <Input
            id="defaultPayRate"
            type="number"
            min={0.01}
            step="0.01"
            required
            value={form.defaultPayRate}
            onChange={(e) => setForm({ ...form, defaultPayRate: Number(e.target.value) })}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="hiredAt">Contratado el</Label>
        <Input id="hiredAt" type="date" value={form.hiredAt ?? ""} onChange={(e) => setForm({ ...form, hiredAt: e.target.value })} />
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending || !form.candidateId}>
        {createMutation.isPending ? "Creando…" : "Crear Worker"}
      </Button>
    </form>
  );
}

export default function Workers() {
  const navigate = useNavigate();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [employmentType, setEmploymentType] = useState("");
  const [complianceStatus, setComplianceStatus] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const cursor = cursorStack[cursorStack.length - 1];

  const { data: categories } = useQuery({
    queryKey: ["job-categories"],
    queryFn: () => apiFetch<JobCategoryListItem[]>("/job-categories"),
  });

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  if (employmentType) params.set("employmentType", employmentType);
  if (complianceStatus) params.set("complianceStatus", complianceStatus);
  if (categoryId) params.set("categoryId", categoryId);
  if (state) params.set("state", state);
  if (city) params.set("city", city);

  const { data, isLoading } = useQuery({
    queryKey: ["workers", cursor, search, status, employmentType, complianceStatus, categoryId, state, city],
    queryFn: () => apiFetch<Paginated<WorkerListItem>>(`/workers?${params.toString()}`),
  });

  function resetAndFilter(fn: () => void) {
    fn();
    setCursorStack([undefined]);
  }

  return (
    <div>
      <PageHeader
        title="Workers"
        description="Trabajadores activos y su estado operativo"
        action={
          <Button onClick={() => setDrawerOpen(true)}>
            <Plus className="h-4 w-4" />
            New Worker
          </Button>
        }
      />

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-[200px] flex-1">
          <Label htmlFor="search">Buscar por nombre</Label>
          <Input
            id="search"
            placeholder="Buscar…"
            value={search}
            onChange={(e) => resetAndFilter(() => setSearch(e.target.value))}
          />
        </div>
        <div className="w-40">
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
        <div className="w-40">
          <Label htmlFor="employmentTypeFilter">Employment type</Label>
          <Select
            id="employmentTypeFilter"
            value={employmentType}
            onChange={(e) => resetAndFilter(() => setEmploymentType(e.target.value))}
          >
            <option value="">Todos</option>
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === "C1099" ? "1099" : t}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <Label htmlFor="complianceFilter">Compliance</Label>
          <Select
            id="complianceFilter"
            value={complianceStatus}
            onChange={(e) => resetAndFilter(() => setComplianceStatus(e.target.value))}
          >
            <option value="">Todos</option>
            {COMPLIANCE_FILTERS.map((c) => (
              <option key={c} value={c}>
                {formatStatusLabel(c)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <Label htmlFor="categoryFilter">Categoría</Label>
          <Select
            id="categoryFilter"
            value={categoryId}
            onChange={(e) => resetAndFilter(() => setCategoryId(e.target.value))}
          >
            <option value="">Todas</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-28">
          <Label htmlFor="stateFilter">Estado (US)</Label>
          <Input id="stateFilter" value={state} onChange={(e) => resetAndFilter(() => setState(e.target.value))} />
        </div>
        <div className="w-36">
          <Label htmlFor="cityFilter">Ciudad</Label>
          <Input id="cityFilter" value={city} onChange={(e) => resetAndFilter(() => setCity(e.target.value))} />
        </div>
      </Card>

      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Ubicación</TableHead>
                <TableHead>Categorías</TableHead>
                <TableHead>Employment</TableHead>
                <TableHead>Pay rate</TableHead>
                <TableHead>Compliance</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((worker) => (
                <TableRow key={worker.id} className="cursor-pointer" onClick={() => navigate(`/workers/${worker.id}`)}>
                  <TableCell className="font-medium">{worker.candidateName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {worker.city && worker.state ? `${worker.city}, ${worker.state}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{worker.categoryNames.join(", ") || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {worker.employmentType === "C1099" ? "1099" : "W2"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">${Number(worker.defaultPayRate).toFixed(2)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(worker.complianceStatus)}>
                      {formatStatusLabel(worker.complianceStatus)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(worker.status)}>{formatStatusLabel(worker.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Sin Workers todavía — crea el primero con "New Worker" (requiere un Candidate ya QUALIFIED).
          </p>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="New Worker">
        <NewWorkerForm
          onCreated={(id) => {
            setDrawerOpen(false);
            navigate(`/workers/${id}`);
          }}
        />
      </Drawer>
    </div>
  );
}
