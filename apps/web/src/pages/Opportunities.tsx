import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyListItem,
  CreateOpportunityInput,
  JobCategoryListItem,
  OpportunityListItem,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { Plus } from "lucide-react";

function NewOpportunityForm({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: companies } = useQuery({
    queryKey: ["companies", "all-for-select"],
    queryFn: () => apiFetch<Paginated<CompanyListItem>>("/companies?limit=100"),
  });
  const { data: categories } = useQuery({
    queryKey: ["job-categories"],
    queryFn: () => apiFetch<JobCategoryListItem[]>("/job-categories"),
  });

  const [form, setForm] = useState<CreateOpportunityInput>({ companyId: "", title: "" });

  const createMutation = useMutation({
    mutationFn: (input: CreateOpportunityInput) =>
      apiFetch("/opportunities", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Oportunidad creada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["opportunities"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline"] });
      onCreated();
    },
    onError: (err) => toast({ title: "No se pudo crear la oportunidad", description: String(err), variant: "error" }),
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
        <Label htmlFor="companyId">Empresa</Label>
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
        <Label htmlFor="title">Título</Label>
        <Input id="title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="categoryId">Categoría</Label>
        <Select
          id="categoryId"
          value={form.categoryId ?? ""}
          onChange={(e) => setForm({ ...form, categoryId: e.target.value || undefined })}
        >
          <option value="">—</option>
          {categories?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label htmlFor="estimatedWorkers">Trabajadores</Label>
          <Input
            id="estimatedWorkers"
            type="number"
            value={form.estimatedWorkers ?? ""}
            onChange={(e) => setForm({ ...form, estimatedWorkers: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <div>
          <Label htmlFor="estimatedPayRate">Pay rate</Label>
          <Input
            id="estimatedPayRate"
            type="number"
            step="0.01"
            value={form.estimatedPayRate ?? ""}
            onChange={(e) => setForm({ ...form, estimatedPayRate: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <div>
          <Label htmlFor="estimatedBillRate">Bill rate</Label>
          <Input
            id="estimatedBillRate"
            type="number"
            step="0.01"
            value={form.estimatedBillRate ?? ""}
            onChange={(e) => setForm({ ...form, estimatedBillRate: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="estimatedRevenue">Revenue estimado</Label>
          <Input
            id="estimatedRevenue"
            type="number"
            value={form.estimatedRevenue ?? ""}
            onChange={(e) => setForm({ ...form, estimatedRevenue: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <div>
          <Label htmlFor="probability">Probabilidad (%)</Label>
          <Input
            id="probability"
            type="number"
            min={0}
            max={100}
            value={form.probability ?? ""}
            onChange={(e) => setForm({ ...form, probability: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending}>
        {createMutation.isPending ? "Creando…" : "Crear oportunidad"}
      </Button>
    </form>
  );
}

export default function Opportunities() {
  const navigate = useNavigate();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading } = useQuery({
    queryKey: ["opportunities", cursor],
    queryFn: () =>
      apiFetch<Paginated<OpportunityListItem>>(`/opportunities?limit=20${cursor ? `&cursor=${cursor}` : ""}`),
  });

  return (
    <div>
      <PageHeader
        title="Opportunities"
        description="Tratos comerciales calificados con valor estimado"
        action={
          <Button onClick={() => setDrawerOpen(true)}>
            <Plus className="h-4 w-4" />
            New Opportunity
          </Button>
        }
      />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>Categoría</TableHead>
                <TableHead>Trabajadores</TableHead>
                <TableHead>Margen/h</TableHead>
                <TableHead>Revenue estimado</TableHead>
                <TableHead>Probabilidad</TableHead>
                <TableHead>Etapa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((o) => (
                <TableRow key={o.id} className="cursor-pointer" onClick={() => navigate(`/companies/${o.companyId}`)}>
                  <TableCell className="font-medium">{o.title}</TableCell>
                  <TableCell className="text-muted-foreground">{o.companyName}</TableCell>
                  <TableCell className="text-muted-foreground">{o.categoryName ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{o.estimatedWorkers ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {o.estimatedMarginPerHour ? `$${o.estimatedMarginPerHour}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {o.estimatedRevenue ? `$${Number(o.estimatedRevenue).toLocaleString()}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {o.probability != null ? `${o.probability}%` : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(o.stage)}>{formatStatusLabel(o.stage)}</Badge>
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

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="New Opportunity">
        <NewOpportunityForm onCreated={() => setDrawerOpen(false)} />
      </Drawer>
    </div>
  );
}
