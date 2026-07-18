import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { ClientTimeEntryListItem } from "./types";

function TimeEntryRowActions({ entry, canApprove }: { entry: ClientTimeEntryListItem; canApprove: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["portal-client-time-entries"] });

  const approveMutation = useMutation({
    mutationFn: () => apiFetch(`/portal/client/time-entries/${entry.id}/approve`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Horas aprobadas", variant: "success" });
      invalidate();
    },
    onError: (err) => toast({ title: "No se pudo aprobar", description: String(err), variant: "error" }),
  });

  const rejectMutation = useMutation({
    mutationFn: () => apiFetch(`/portal/client/time-entries/${entry.id}/reject`, { method: "POST", body: JSON.stringify({ rejectionReason: reason }) }),
    onSuccess: () => {
      toast({ title: "Horas rechazadas", variant: "success" });
      setRejecting(false);
      setReason("");
      invalidate();
    },
    onError: (err) => toast({ title: "No se pudo rechazar", description: String(err), variant: "error" }),
  });

  if (!canApprove) return null;

  if (rejecting) {
    return (
      <div className="flex items-center gap-1">
        <Input className="h-7 w-36 text-xs" placeholder="Motivo…" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!reason || rejectMutation.isPending} onClick={() => rejectMutation.mutate()}>
          Confirmar
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setRejecting(false)}>
          Cancelar
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={approveMutation.isPending} onClick={() => approveMutation.mutate()}>
        Aprobar
      </Button>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => setRejecting(true)}>
        Rechazar
      </Button>
    </div>
  );
}

export default function ClientTimeEntries() {
  const { data: currentUser } = useCurrentUser();
  const canApprove = currentUser?.permissions.includes("portalTimeEntries.update") ?? false;
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);

  const { data, isLoading } = useQuery({
    queryKey: ["portal-client-time-entries", cursor],
    queryFn: () => apiFetch<{ items: ClientTimeEntryListItem[]; nextCursor: string | null }>(`/portal/client/time-entries?${params.toString()}`),
  });

  return (
    <div>
      <PageHeader title="Time Entries" description="Horas pendientes de tu aprobación (SUBMITTED/NEEDS_REVIEW)." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Job Order</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Reg / OT / Doble</TableHead>
                <TableHead>Estado</TableHead>
                {canApprove && <TableHead>Acciones</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.workerName}</TableCell>
                  <TableCell className="text-muted-foreground">{t.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(t.date).toLocaleDateString()}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {t.regularHours} / {t.overtimeHours} / {t.doubleHours}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(t.status)}>{formatStatusLabel(t.status)}</Badge>
                  </TableCell>
                  {canApprove && (
                    <TableCell>
                      <TimeEntryRowActions entry={t} canApprove={canApprove} />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin horas pendientes de revisión.</p>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>
    </div>
  );
}
