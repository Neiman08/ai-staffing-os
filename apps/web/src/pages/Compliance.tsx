import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CandidateListItem,
  ComplianceAlertListItem,
  CreateDocumentInput,
  DocumentListItem,
  DocumentTypeListItem,
  Paginated,
  WorkerListItem,
} from "@ai-staffing-os/shared";
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
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { Plus } from "lucide-react";

type Tab = "documents" | "alerts";

function UploadDocumentForm({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [ownerType, setOwnerType] = useState<"candidate" | "worker">("worker");
  const [form, setForm] = useState({
    documentTypeId: "",
    ownerId: "",
    fileUrl: "",
    issuedDate: "",
    expirationDate: "",
  });

  const { data: documentTypes } = useQuery({
    queryKey: ["document-types"],
    queryFn: () => apiFetch<DocumentTypeListItem[]>("/compliance/document-types"),
  });
  const { data: candidates } = useQuery({
    queryKey: ["candidates", "for-document-form"],
    queryFn: () => apiFetch<Paginated<CandidateListItem>>("/candidates?limit=100"),
    enabled: ownerType === "candidate",
  });
  const { data: workers } = useQuery({
    queryKey: ["workers", "for-document-form"],
    queryFn: () => apiFetch<Paginated<WorkerListItem>>("/workers?limit=100"),
    enabled: ownerType === "worker",
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateDocumentInput) =>
      apiFetch("/documents", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Documento registrado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      onDone();
    },
    onError: (err) => toast({ title: "No se pudo registrar el documento", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const input: CreateDocumentInput = {
          documentTypeId: form.documentTypeId,
          [ownerType === "worker" ? "workerId" : "candidateId"]: form.ownerId,
          fileUrl: form.fileUrl || undefined,
          issuedDate: form.issuedDate || undefined,
          expirationDate: form.expirationDate || undefined,
        } as CreateDocumentInput;
        createMutation.mutate(input);
      }}
    >
      <div>
        <Label>Propietario</Label>
        <div className="mt-1 flex gap-1 rounded-md border border-border bg-secondary/40 p-1 w-fit">
          {(["worker", "candidate"] as const).map((t) => (
            <Button
              key={t}
              type="button"
              variant={ownerType === t ? "default" : "ghost"}
              size="sm"
              onClick={() => {
                setOwnerType(t);
                setForm({ ...form, ownerId: "" });
              }}
              className={cn(ownerType !== t && "text-muted-foreground")}
            >
              {t === "worker" ? "Worker" : "Candidate"}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <Label htmlFor="ownerId">{ownerType === "worker" ? "Worker" : "Candidate"} *</Label>
        <Select id="ownerId" required value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
          <option value="">Selecciona…</option>
          {ownerType === "worker"
            ? workers?.items.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.candidateName}
                </option>
              ))
            : candidates?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.firstName} {c.lastName}
                </option>
              ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="documentTypeId">Tipo de documento *</Label>
        <Select
          id="documentTypeId"
          required
          value={form.documentTypeId}
          onChange={(e) => setForm({ ...form, documentTypeId: e.target.value })}
        >
          <option value="">Selecciona…</option>
          {documentTypes?.map((dt) => (
            <option key={dt.id} value={dt.id}>
              {dt.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="fileUrl">URL del archivo</Label>
        <Input
          id="fileUrl"
          placeholder="https://…"
          value={form.fileUrl}
          onChange={(e) => setForm({ ...form, fileUrl: e.target.value })}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Storage real todavía no existe — se acepta un link ya alojado externamente.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="issuedDate">Fecha de emisión</Label>
          <Input id="issuedDate" type="date" value={form.issuedDate} onChange={(e) => setForm({ ...form, issuedDate: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="expirationDate">Fecha de vencimiento</Label>
          <Input
            id="expirationDate"
            type="date"
            value={form.expirationDate}
            onChange={(e) => setForm({ ...form, expirationDate: e.target.value })}
          />
        </div>
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending || !form.ownerId || !form.documentTypeId}>
        {createMutation.isPending ? "Registrando…" : "Registrar documento"}
      </Button>
    </form>
  );
}

export default function Compliance() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const [tab, setTab] = useState<Tab>("documents");
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [rejectingDocId, setRejectingDocId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const cursor = cursorStack[cursorStack.length - 1];

  const canVerify = currentUser?.permissions.includes("compliance.verify") ?? false;

  function switchTab(next: Tab) {
    setTab(next);
    setCursorStack([undefined]);
  }

  const documentsQuery = useQuery({
    queryKey: ["documents", cursor],
    queryFn: () =>
      apiFetch<Paginated<DocumentListItem>>(`/documents?limit=20${cursor ? `&cursor=${cursor}` : ""}`),
    enabled: tab === "documents",
  });

  const alertsQuery = useQuery({
    queryKey: ["compliance-alerts", cursor],
    queryFn: () =>
      apiFetch<Paginated<ComplianceAlertListItem>>(
        `/compliance/alerts?limit=20${cursor ? `&cursor=${cursor}` : ""}`,
      ),
    enabled: tab === "alerts",
  });

  const activeQuery = tab === "documents" ? documentsQuery : alertsQuery;

  const verifyMutation = useMutation({
    mutationFn: ({ id, status, rejectionReason: reason }: { id: string; status: "VERIFIED" | "REJECTED"; rejectionReason?: string }) =>
      apiFetch(`/documents/${id}/verify`, { method: "POST", body: JSON.stringify({ status, rejectionReason: reason }) }),
    onSuccess: (_data, { status }) => {
      toast({ title: status === "VERIFIED" ? "Documento verificado" : "Documento rechazado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["compliance-alerts"] });
      setRejectingDocId(null);
      setRejectionReason("");
    },
    onError: (err) => toast({ title: "No se pudo actualizar el documento", description: String(err), variant: "error" }),
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/compliance/alerts/${id}/resolve`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Alerta resuelta", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["compliance-alerts"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (err) => toast({ title: "No se pudo resolver la alerta", description: String(err), variant: "error" }),
  });

  return (
    <div>
      <PageHeader
        title="Compliance"
        description="Documentos, verificaciones y alertas de vencimiento"
        action={
          <Button onClick={() => setUploadOpen(true)}>
            <Plus className="h-4 w-4" />
            Upload Document
          </Button>
        }
      />

      <div className="mb-4 flex gap-1 rounded-md border border-border bg-secondary/40 p-1 w-fit">
        {(["documents", "alerts"] as const).map((t) => (
          <Button
            key={t}
            variant={tab === t ? "default" : "ghost"}
            size="sm"
            onClick={() => switchTab(t)}
            className={cn(tab !== t && "text-muted-foreground")}
          >
            {t === "documents" ? "Documentos" : "Alertas"}
          </Button>
        ))}
      </div>

      <Card>
        {activeQuery.isLoading ? (
          <LoadingTable />
        ) : tab === "documents" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Documento</TableHead>
                <TableHead>Propietario</TableHead>
                <TableHead>Vencimiento</TableHead>
                <TableHead>Verificado por IA</TableHead>
                <TableHead>Estado</TableHead>
                {canVerify && <TableHead>Acciones</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {documentsQuery.data?.items.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium">{doc.documentTypeName}</TableCell>
                  <TableCell className="text-muted-foreground">{doc.ownerLabel}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {doc.expirationDate ? new Date(doc.expirationDate).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{doc.verifiedByAgent ? "Sí" : "No"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(doc.status)}>{formatStatusLabel(doc.status)}</Badge>
                  </TableCell>
                  {canVerify && (
                    <TableCell>
                      {doc.status === "PENDING_REVIEW" ? (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={verifyMutation.isPending}
                            onClick={() => verifyMutation.mutate({ id: doc.id, status: "VERIFIED" })}
                          >
                            Verificar
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-600 dark:text-red-400"
                            onClick={() => setRejectingDocId(doc.id)}
                          >
                            Rechazar
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Trabajador</TableHead>
                <TableHead>Mensaje</TableHead>
                <TableHead>Severidad</TableHead>
                <TableHead>Estado</TableHead>
                {canVerify && <TableHead>Acciones</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {alertsQuery.data?.items.map((alert) => (
                <TableRow key={alert.id}>
                  <TableCell className="font-medium">{formatStatusLabel(alert.type)}</TableCell>
                  <TableCell className="text-muted-foreground">{alert.workerName ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{alert.message}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(alert.severity)}>{formatStatusLabel(alert.severity)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={alert.resolvedAt ? "success" : "warning"}>
                      {alert.resolvedAt ? "Resuelta" : "Pendiente"}
                    </Badge>
                  </TableCell>
                  {canVerify && (
                    <TableCell>
                      {!alert.resolvedAt && (
                        <Button size="sm" variant="outline" disabled={resolveMutation.isPending} onClick={() => resolveMutation.mutate(alert.id)}>
                          Resolver
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!activeQuery.data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() =>
            activeQuery.data?.nextCursor &&
            setCursorStack((stack) => [...stack, activeQuery.data!.nextCursor!])
          }
        />
      </Card>

      <Drawer open={uploadOpen} onClose={() => setUploadOpen(false)} title="Upload Document">
        <UploadDocumentForm onDone={() => setUploadOpen(false)} />
      </Drawer>

      {rejectingDocId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-sm p-4">
            <p className="text-sm font-medium">¿Rechazar este documento?</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Esto genera automáticamente una alerta de compliance y bloquea al Worker hasta que se resuelva.
            </p>
            <div className="mt-3">
              <Label htmlFor="rejectionReason">Motivo *</Label>
              <Textarea id="rejectionReason" required value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setRejectingDocId(null); setRejectionReason(""); }}>
                Volver
              </Button>
              <Button
                size="sm"
                disabled={verifyMutation.isPending || !rejectionReason.trim()}
                onClick={() => verifyMutation.mutate({ id: rejectingDocId, status: "REJECTED", rejectionReason })}
              >
                {verifyMutation.isPending ? "Rechazando…" : "Confirmar rechazo"}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
