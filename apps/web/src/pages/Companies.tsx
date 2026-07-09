import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyListItem,
  CreateCompanyInput,
  IndustryListItem,
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

const COMPANY_SIZES = ["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"];

function NewCompanyForm({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: industries } = useQuery({
    queryKey: ["industries"],
    queryFn: () => apiFetch<IndustryListItem[]>("/industries"),
  });

  const [form, setForm] = useState<CreateCompanyInput>({ name: "", industryId: "" });

  const createMutation = useMutation({
    mutationFn: (input: CreateCompanyInput) => apiFetch<{ id: string }>("/companies", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Company created", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      onCreated();
    },
    onError: (err) => {
      toast({ title: "Could not create company", description: String(err), variant: "error" });
    },
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
        <Label htmlFor="name">Name</Label>
        <Input id="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="industryId">Industry</Label>
        <Select
          id="industryId"
          required
          value={form.industryId}
          onChange={(e) => setForm({ ...form, industryId: e.target.value })}
        >
          <option value="">Select an industry…</option>
          {industries?.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="city">City</Label>
          <Input id="city" value={form.city ?? ""} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="state">State</Label>
          <Input id="state" value={form.state ?? ""} onChange={(e) => setForm({ ...form, state: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="estimatedSize">Estimated size</Label>
          <Select
            id="estimatedSize"
            value={form.estimatedSize ?? ""}
            onChange={(e) => setForm({ ...form, estimatedSize: (e.target.value || undefined) as never })}
          >
            <option value="">—</option>
            {COMPANY_SIZES.map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="commercialScore">Commercial score</Label>
          <Input
            id="commercialScore"
            type="number"
            min={0}
            max={100}
            value={form.commercialScore ?? ""}
            onChange={(e) => setForm({ ...form, commercialScore: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending}>
        {createMutation.isPending ? "Creating…" : "Create company"}
      </Button>
    </form>
  );
}

export default function Companies() {
  const navigate = useNavigate();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading } = useQuery({
    queryKey: ["companies", cursor],
    queryFn: () =>
      apiFetch<Paginated<CompanyListItem>>(`/companies?limit=20${cursor ? `&cursor=${cursor}` : ""}`),
  });

  return (
    <div>
      <PageHeader
        title="Companies"
        description="Clientes y prospectos de la agencia"
        action={
          <Button onClick={() => setDrawerOpen(true)}>
            <Plus className="h-4 w-4" />
            New Company
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
                <TableHead>Nombre</TableHead>
                <TableHead>Industria</TableHead>
                <TableHead>Ubicación</TableHead>
                <TableHead>Tamaño</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Oportunidades abiertas</TableHead>
                <TableHead>Próxima acción</TableHead>
                <TableHead>Último contacto</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((company) => (
                <TableRow
                  key={company.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/companies/${company.id}`)}
                >
                  <TableCell className="font-medium">{company.name}</TableCell>
                  <TableCell className="text-muted-foreground">{company.industryName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.city && company.state ? `${company.city}, ${company.state}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.estimatedSize ? formatStatusLabel(company.estimatedSize) : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.commercialScore != null ? company.commercialScore : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{company.openOpportunityCount}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.nextFollowUp
                      ? `${formatStatusLabel(company.nextFollowUp.type)} · ${new Date(company.nextFollowUp.dueDate).toLocaleDateString()}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.lastActivityAt ? new Date(company.lastActivityAt).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(company.status)}>{formatStatusLabel(company.status)}</Badge>
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

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="New Company">
        <NewCompanyForm onCreated={() => setDrawerOpen(false)} />
      </Drawer>
    </div>
  );
}
