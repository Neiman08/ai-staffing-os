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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { SubmitDocumentDrawer } from "../shared/SubmitDocumentDrawer";
import type { WorkerDocumentItem } from "./types";

export default function WorkerDocumentsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [submittingItem, setSubmittingItem] = useState<WorkerDocumentItem | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["portal-worker-documents"],
    queryFn: () => apiFetch<WorkerDocumentItem[]>("/portal/worker/documents"),
  });

  const submitMutation = useMutation({
    mutationFn: (input: { fileName: string; notes: string | null }) =>
      apiFetch(`/portal/worker/documents/${submittingItem!.id}/submit`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Documento enviado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["portal-worker-documents"] });
      setSubmittingItem(null);
    },
    onError: (err) => toast({ title: "No se pudo enviar el documento", description: String(err), variant: "error" }),
  });

  return (
    <div>
      <PageHeader title="Documents" description="Checklist de documentos requeridos para tu onboarding." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data && data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Documento</TableHead>
                <TableHead>Vence</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>
                  <span className="sr-only">Acciones</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">
                    {d.label}
                    {d.required && (
                      <span className="ml-1 text-xs text-destructive" aria-label="requerido">
                        *
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{d.expiresAt ? new Date(d.expiresAt).toLocaleDateString() : "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(d.status)}>{formatStatusLabel(d.status)}</Badge>
                    {d.rejectionReason && <p className="mt-1 text-xs text-destructive">{d.rejectionReason}</p>}
                  </TableCell>
                  <TableCell>
                    {d.status === "PENDING" && (
                      <Button size="sm" variant="outline" onClick={() => setSubmittingItem(d)}>
                        Enviar
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin checklist de documentos todavía.</p>
        )}
      </Card>

      <Drawer open={!!submittingItem} onClose={() => setSubmittingItem(null)} title={`Enviar: ${submittingItem?.label ?? ""}`}>
        {submittingItem && (
          <SubmitDocumentDrawer label={submittingItem.label} onSubmit={(input) => submitMutation.mutate(input)} isSubmitting={submitMutation.isPending} />
        )}
      </Drawer>
    </div>
  );
}
