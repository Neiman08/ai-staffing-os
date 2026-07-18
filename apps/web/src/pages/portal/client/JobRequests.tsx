import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { Plus } from "lucide-react";
import type { ClientJobRequestRecord } from "./types";

function CreateJobRequestForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => ({
    requestedTitle: "",
    headcount: 1,
    desiredStartDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    notes: "",
  }));

  const createMutation = useMutation({
    mutationFn: () => apiFetch<{ id: string }>("/portal/client/job-requests", { method: "POST", body: JSON.stringify(form) }),
    onSuccess: (req) => {
      toast({ title: "Solicitud creada (borrador)", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["portal-client-job-requests"] });
      onCreated(req.id);
    },
    onError: (err) => toast({ title: "No se pudo crear la solicitud", description: String(err), variant: "error" }),
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
        <Label htmlFor="requestedTitle">Puesto solicitado *</Label>
        <Input id="requestedTitle" required value={form.requestedTitle} onChange={(e) => setForm({ ...form, requestedTitle: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="headcount">Cantidad de personas *</Label>
          <Input
            id="headcount"
            type="number"
            min={1}
            required
            value={form.headcount}
            onChange={(e) => setForm({ ...form, headcount: Number(e.target.value) })}
          />
        </div>
        <div>
          <Label htmlFor="desiredStartDate">Fecha deseada de inicio *</Label>
          <Input
            id="desiredStartDate"
            type="date"
            required
            value={form.desiredStartDate}
            onChange={(e) => setForm({ ...form, desiredStartDate: e.target.value })}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="notes">Notas</Label>
        <Textarea id="notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending || !form.requestedTitle}>
        {createMutation.isPending ? "Creando…" : "Crear borrador"}
      </Button>
    </form>
  );
}

export default function ClientJobRequests() {
  const navigate = useNavigate();
  const { data: currentUser } = useCurrentUser();
  const canCreate = currentUser?.permissions.includes("clientJobs.create") ?? false;
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [createOpen, setCreateOpen] = useState(false);
  const cursor = cursorStack[cursorStack.length - 1];

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);

  const { data, isLoading } = useQuery({
    queryKey: ["portal-client-job-requests", cursor],
    queryFn: () => apiFetch<{ items: ClientJobRequestRecord[]; nextCursor: string | null }>(`/portal/client/job-requests?${params.toString()}`),
  });

  return (
    <div>
      <PageHeader
        title="Job Requests"
        description="Tus solicitudes de personal -- borradores, en revisión, aprobadas."
        action={
          canCreate && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              New Request
            </Button>
          )
        }
      />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Puesto</TableHead>
                <TableHead>Cantidad</TableHead>
                <TableHead>Inicio deseado</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/portal/client/job-requests/${r.id}`)}>
                  <TableCell className="font-medium">{r.requestedTitle}</TableCell>
                  <TableCell className="text-muted-foreground">{r.headcount}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(r.desiredStartDate).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(r.status)}>{formatStatusLabel(r.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin solicitudes todavía.</p>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>

      <Drawer open={createOpen} onClose={() => setCreateOpen(false)} title="New Job Request">
        <CreateJobRequestForm
          onCreated={(id) => {
            setCreateOpen(false);
            navigate(`/portal/client/job-requests/${id}`);
          }}
        />
      </Drawer>
    </div>
  );
}
