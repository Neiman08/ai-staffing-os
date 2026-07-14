import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CandidateListItem, CreateCandidateInput, JobCategoryListItem, Paginated } from "@ai-staffing-os/shared";
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

// F5.2: enum real (packages/shared) — INTERVIEW/OFFERED viven dentro de
// QUALIFIED, WITHDRAWN/ARCHIVED dentro de INACTIVE, HIRED es PLACED.
const STATUS_FILTERS = ["NEW", "SCREENING", "QUALIFIED", "PLACED", "REJECTED", "INACTIVE"];

function emptyForm(): CreateCandidateInput {
  return {
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    city: "",
    state: "",
    zip: "",
    categoryIds: [],
    yearsExperience: undefined,
    resumeUrl: "",
    source: "",
    smsOptIn: false,
  };
}

function NewCandidateForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: categories } = useQuery({
    queryKey: ["job-categories"],
    queryFn: () => apiFetch<JobCategoryListItem[]>("/job-categories"),
  });

  const [form, setForm] = useState<CreateCandidateInput>(emptyForm());

  const createMutation = useMutation({
    mutationFn: (input: CreateCandidateInput) => {
      const payload: CreateCandidateInput = {
        ...input,
        email: input.email || undefined,
        phone: input.phone || undefined,
        city: input.city || undefined,
        state: input.state || undefined,
        zip: input.zip || undefined,
        resumeUrl: input.resumeUrl || undefined,
        source: input.source || undefined,
        yearsExperience: input.yearsExperience || undefined,
      };
      return apiFetch<{ id: string }>("/candidates", { method: "POST", body: JSON.stringify(payload) });
    },
    onSuccess: (candidate) => {
      toast({ title: "Candidate creado (NEW)", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
      onCreated(candidate.id);
    },
    onError: (err) => toast({ title: "No se pudo crear el Candidate", description: String(err), variant: "error" }),
  });

  function toggleCategory(id: string) {
    setForm((f) => ({
      ...f,
      categoryIds: f.categoryIds?.includes(id) ? f.categoryIds.filter((c) => c !== id) : [...(f.categoryIds ?? []), id],
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
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="firstName">Nombre *</Label>
          <Input
            id="firstName"
            required
            value={form.firstName}
            onChange={(e) => setForm({ ...form, firstName: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="lastName">Apellido *</Label>
          <Input
            id="lastName"
            required
            value={form.lastName}
            onChange={(e) => setForm({ ...form, lastName: e.target.value })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={form.email ?? ""}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="phone">Teléfono</Label>
          <Input id="phone" value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label htmlFor="city">Ciudad</Label>
          <Input id="city" value={form.city ?? ""} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="state">Estado</Label>
          <Input id="state" value={form.state ?? ""} onChange={(e) => setForm({ ...form, state: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="zip">ZIP</Label>
          <Input id="zip" value={form.zip ?? ""} onChange={(e) => setForm({ ...form, zip: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="yearsExperience">Años de experiencia</Label>
          <Input
            id="yearsExperience"
            type="number"
            min={0}
            value={form.yearsExperience ?? ""}
            onChange={(e) => setForm({ ...form, yearsExperience: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <div>
          <Label htmlFor="source">Origen</Label>
          <Input
            id="source"
            placeholder="referral, job board…"
            value={form.source ?? ""}
            onChange={(e) => setForm({ ...form, source: e.target.value })}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="resumeUrl">Resume URL</Label>
        <Input
          id="resumeUrl"
          value={form.resumeUrl ?? ""}
          onChange={(e) => setForm({ ...form, resumeUrl: e.target.value })}
        />
      </div>
      {categories && categories.length > 0 && (
        <div>
          <Label>Categorías</Label>
          <div className="mt-1 grid grid-cols-2 gap-1.5 rounded-md border border-border p-2">
            {categories.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-border"
                  checked={form.categoryIds?.includes(c.id) ?? false}
                  onChange={() => toggleCategory(c.id)}
                />
                {c.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-border"
          checked={form.smsOptIn ?? false}
          onChange={(e) => setForm({ ...form, smsOptIn: e.target.checked })}
        />
        Acepta recibir SMS (TCPA)
      </label>
      <Button type="submit" className="w-full" disabled={createMutation.isPending}>
        {createMutation.isPending ? "Creando…" : "Crear Candidate (NEW)"}
      </Button>
    </form>
  );
}

export default function Candidates() {
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
    queryKey: ["candidates", cursor, search, status],
    queryFn: () => apiFetch<Paginated<CandidateListItem>>(`/candidates?${params.toString()}`),
  });

  function resetAndFilter(fn: () => void) {
    fn();
    setCursorStack([undefined]);
  }

  return (
    <div>
      <PageHeader
        title="Candidates"
        description="Talento en proceso de selección"
        action={
          <Button onClick={() => setDrawerOpen(true)}>
            <Plus className="h-4 w-4" />
            New Candidate
          </Button>
        }
      />

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-[200px] flex-1">
          <Label htmlFor="search">Buscar por nombre/email</Label>
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
                <TableHead>Nombre</TableHead>
                <TableHead>Ubicación</TableHead>
                <TableHead>Categorías</TableHead>
                <TableHead>Idiomas</TableHead>
                <TableHead>AI Score</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((candidate) => (
                <TableRow
                  key={candidate.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/candidates/${candidate.id}`)}
                >
                  <TableCell className="font-medium">
                    {candidate.firstName} {candidate.lastName}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {candidate.city && candidate.state ? `${candidate.city}, ${candidate.state}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{candidate.categoryNames.join(", ") || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {candidate.languages.join(", ").toUpperCase() || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {candidate.aiScore != null ? candidate.aiScore.toFixed(1) : "—"}
                  </TableCell>
                  <TableCell>
                    {candidate.isWorker ? (
                      <Badge variant="success">Worker</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(candidate.status)}>{formatStatusLabel(candidate.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Sin Candidates todavía — crea el primero con "New Candidate".
          </p>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="New Candidate">
        <NewCandidateForm
          onCreated={(id) => {
            setDrawerOpen(false);
            navigate(`/candidates/${id}`);
          }}
        />
      </Drawer>
    </div>
  );
}
