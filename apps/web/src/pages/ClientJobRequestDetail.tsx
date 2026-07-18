import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobCategoryListItem } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { ArrowLeft } from "lucide-react";
import type { InternalJobRequestDetail } from "./portal-internal-types";

const REVIEW_TARGETS = ["UNDER_REVIEW", "NEEDS_INFORMATION", "APPROVED", "REJECTED"];

function ConvertForm({ request, onConverted }: { request: InternalJobRequestDetail; onConverted: () => void }) {
  const { toast } = useToast();
  const { data: categories } = useQuery({
    queryKey: ["job-categories"],
    queryFn: () => apiFetch<JobCategoryListItem[]>("/job-categories"),
  });
  const [categoryId, setCategoryId] = useState("");
  const [billRate, setBillRate] = useState(0);
  const [payRate, setPayRate] = useState(0);

  const convertMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/client-job-requests/${request.id}/convert`, {
        method: "POST",
        body: JSON.stringify({ categoryId, billRate, payRate, workersNeeded: request.headcount }),
      }),
    onSuccess: () => {
      toast({ title: "Convertida a Job Order real (DRAFT)", variant: "success" });
      onConverted();
    },
    onError: (err) => toast({ title: "No se pudo convertir", description: String(err), variant: "error" }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Convertir a Job Order</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Category/bill rate/pay rate son decisiones internas reales -- nunca se infieren de la expectativa del cliente.
        </p>
        <div>
          <Label htmlFor="categoryId">Job Category *</Label>
          <Select id="categoryId" required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Selecciona…</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="billRate">Bill rate *</Label>
            <Input id="billRate" type="number" min={0.01} step="0.01" value={billRate} onChange={(e) => setBillRate(Number(e.target.value))} />
          </div>
          <div>
            <Label htmlFor="payRate">Pay rate *</Label>
            <Input id="payRate" type="number" min={0.01} step="0.01" value={payRate} onChange={(e) => setPayRate(Number(e.target.value))} />
          </div>
        </div>
        <Button
          className="w-full"
          disabled={convertMutation.isPending || !categoryId || billRate <= 0 || payRate <= 0}
          onClick={() => convertMutation.mutate()}
        >
          {convertMutation.isPending ? "Convirtiendo…" : "Convertir a Job Order"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function ClientJobRequestDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const canReview = currentUser?.permissions.includes("clientJobs.approve") ?? false;
  const [nextStatus, setNextStatus] = useState<string>("UNDER_REVIEW");
  const [reviewNotes, setReviewNotes] = useState("");

  const { data: request, isLoading } = useQuery({
    queryKey: ["client-job-request", id],
    queryFn: () => apiFetch<InternalJobRequestDetail>(`/client-job-requests/${id}`),
    enabled: !!id,
  });

  const reviewMutation = useMutation({
    mutationFn: () => apiFetch(`/client-job-requests/${id}/status`, { method: "PATCH", body: JSON.stringify({ status: nextStatus, reviewNotes: reviewNotes || undefined }) }),
    onSuccess: () => {
      toast({ title: `Estado actualizado a ${formatStatusLabel(nextStatus)}`, variant: "success" });
      setReviewNotes("");
      queryClient.invalidateQueries({ queryKey: ["client-job-request", id] });
    },
    onError: (err) => toast({ title: "Transición inválida", description: String(err), variant: "error" }),
  });

  if (isLoading || !request) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div>
      <Link to="/client-job-requests" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        Client Job Requests
      </Link>

      <PageHeader
        title={request.requestedTitle}
        description={`${request.companyName} — ${request.headcount} persona(s)`}
        action={<Badge variant={statusVariant(request.status)}>{formatStatusLabel(request.status)}</Badge>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Detalles de la solicitud</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Inicio deseado</span>
              <span>{new Date(request.desiredStartDate).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Turno</span>
              <span>{request.shift ? formatStatusLabel(request.shift) : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Horario</span>
              <span>{request.schedule ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Expectativa de pay rate (cliente)</span>
              <span>{request.payRateExpectation ? `$${request.payRateExpectation}` : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Presupuesto de bill rate (cliente)</span>
              <span>{request.billBudget ? `$${request.billBudget}` : "—"}</span>
            </div>
            {request.notes && (
              <div className="pt-2">
                <span className="text-muted-foreground">Notas del cliente</span>
                <p className="mt-1">{request.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {canReview && ["SUBMITTED", "UNDER_REVIEW"].includes(request.status) && (
          <Card>
            <CardHeader>
              <CardTitle>Revisar</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <Label htmlFor="nextStatus">Nuevo estado</Label>
                <Select id="nextStatus" value={nextStatus} onChange={(e) => setNextStatus(e.target.value)}>
                  {REVIEW_TARGETS.map((s) => (
                    <option key={s} value={s}>
                      {formatStatusLabel(s)}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="reviewNotes">Comentario (visible para el cliente)</Label>
                <Textarea id="reviewNotes" value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} />
              </div>
              <Button className="w-full" disabled={reviewMutation.isPending} onClick={() => reviewMutation.mutate()}>
                {reviewMutation.isPending ? "Guardando…" : "Aplicar"}
              </Button>
            </CardContent>
          </Card>
        )}

        {canReview && request.status === "APPROVED" && (
          <ConvertForm request={request} onConverted={() => queryClient.invalidateQueries({ queryKey: ["client-job-request", id] })} />
        )}

        {request.status === "CONVERTED_TO_JOB_ORDER" && request.convertedJobOrderId && (
          <Card>
            <CardHeader>
              <CardTitle>Job Order real</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <Button variant="outline" size="sm" onClick={() => navigate(`/job-orders/${request.convertedJobOrderId}`)}>
                Ver Job Order
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
