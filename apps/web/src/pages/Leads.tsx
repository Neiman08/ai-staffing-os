import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateLeadInput, IndustryListItem, LeadListItem, Paginated } from "@ai-staffing-os/shared";
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

function NewLeadForm({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: industries } = useQuery({
    queryKey: ["industries"],
    queryFn: () => apiFetch<IndustryListItem[]>("/industries"),
  });
  const [form, setForm] = useState<CreateLeadInput>({});

  const createMutation = useMutation({
    mutationFn: (input: CreateLeadInput) => apiFetch("/leads", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Lead creado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      onCreated();
    },
    onError: (err) => toast({ title: "No se pudo crear el lead", description: String(err), variant: "error" }),
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
        <Label htmlFor="industryId">Industria</Label>
        <Select
          id="industryId"
          value={form.industryId ?? ""}
          onChange={(e) => setForm({ ...form, industryId: e.target.value || undefined })}
        >
          <option value="">—</option>
          {industries?.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="city">Ciudad</Label>
          <Input id="city" value={form.city ?? ""} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="state">Estado</Label>
          <Input id="state" value={form.state ?? ""} onChange={(e) => setForm({ ...form, state: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="source">Fuente</Label>
          <Input
            id="source"
            placeholder="referral, web, cold-outreach…"
            value={form.source ?? ""}
            onChange={(e) => setForm({ ...form, source: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="priority">Prioridad</Label>
          <Select
            id="priority"
            value={form.priority ?? ""}
            onChange={(e) => setForm({ ...form, priority: (e.target.value || undefined) as never })}
          >
            <option value="">—</option>
            {["LOW", "MEDIUM", "HIGH"].map((p) => (
              <option key={p} value={p}>
                {formatStatusLabel(p)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="notes">Notas</Label>
        <Textarea id="notes" value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending}>
        {createMutation.isPending ? "Creando…" : "Crear lead"}
      </Button>
    </form>
  );
}

export default function Leads() {
  const navigate = useNavigate();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading } = useQuery({
    queryKey: ["leads", cursor],
    queryFn: () => apiFetch<Paginated<LeadListItem>>(`/leads?limit=20${cursor ? `&cursor=${cursor}` : ""}`),
  });

  return (
    <div>
      <PageHeader
        title="Leads"
        description="Prospectos comerciales antes de calificar"
        action={
          <Button onClick={() => setDrawerOpen(true)}>
            <Plus className="h-4 w-4" />
            New Lead
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
                <TableHead>Empresa</TableHead>
                <TableHead>Industria</TableHead>
                <TableHead>Ubicación</TableHead>
                <TableHead>Fuente</TableHead>
                <TableHead>Prioridad</TableHead>
                <TableHead>Asignado a</TableHead>
                <TableHead>Próxima acción</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((lead) => (
                <TableRow key={lead.id} className="cursor-pointer" onClick={() => navigate(`/leads/${lead.id}`)}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      {lead.companyName ?? "—"}
                      {lead.createdByAgentTaskId && (
                        <Badge variant="primary" title="Creado por el Sales Agent">
                          AI
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{lead.industryName ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {lead.city && lead.state ? `${lead.city}, ${lead.state}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{lead.source ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(lead.priority)}>{formatStatusLabel(lead.priority)}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{lead.ownerLabel ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {lead.nextFollowUp
                      ? `${formatStatusLabel(lead.nextFollowUp.type)} · ${new Date(lead.nextFollowUp.dueDate).toLocaleDateString()}`
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(lead.status)}>{formatStatusLabel(lead.status)}</Badge>
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

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="New Lead">
        <NewLeadForm onCreated={() => setDrawerOpen(false)} />
      </Drawer>
    </div>
  );
}
