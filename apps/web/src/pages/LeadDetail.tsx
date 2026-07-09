import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ActivityItem,
  ApprovalRequestListItem,
  ConvertLeadInput,
  ConvertLeadResult,
  JobCategoryListItem,
  LeadDetail as LeadDetailType,
} from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Timeline } from "@/components/shared/Timeline";
import { AgentTaskAction } from "@/components/shared/AgentTaskAction";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatStatusLabel, statusVariant } from "@/lib/status";

function ConvertForm({ lead, onDone }: { lead: LeadDetailType; onDone: (result: ConvertLeadResult) => void }) {
  const { toast } = useToast();
  const { data: categories } = useQuery({
    queryKey: ["job-categories"],
    queryFn: () => apiFetch<JobCategoryListItem[]>("/job-categories"),
  });

  const [newCompanyName, setNewCompanyName] = useState(lead.companyName ?? "");
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [estimatedWorkers, setEstimatedWorkers] = useState("");
  const [payRate, setPayRate] = useState("");
  const [billRate, setBillRate] = useState("");
  const [probability, setProbability] = useState("30");

  const mutation = useMutation({
    mutationFn: (input: ConvertLeadInput) =>
      apiFetch<ConvertLeadResult>(`/leads/${lead.id}/convert`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (result) => {
      toast({ title: "Lead convertido a Oportunidad", variant: "success" });
      onDone(result);
    },
    onError: (err) => toast({ title: "No se pudo convertir el lead", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate({
          newCompanyName: lead.companyId ? undefined : newCompanyName,
          opportunity: {
            title,
            categoryId: categoryId || undefined,
            estimatedWorkers: estimatedWorkers ? Number(estimatedWorkers) : undefined,
            estimatedPayRate: payRate ? Number(payRate) : undefined,
            estimatedBillRate: billRate ? Number(billRate) : undefined,
            probability: probability ? Number(probability) : undefined,
          },
        });
      }}
    >
      {!lead.companyId && (
        <div>
          <Label>Nombre de la nueva empresa</Label>
          <Input required value={newCompanyName} onChange={(e) => setNewCompanyName(e.target.value)} />
        </div>
      )}
      <div>
        <Label>Título de la oportunidad</Label>
        <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <Label>Categoría</Label>
        <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
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
          <Label>Trabajadores</Label>
          <Input type="number" value={estimatedWorkers} onChange={(e) => setEstimatedWorkers(e.target.value)} />
        </div>
        <div>
          <Label>Pay rate</Label>
          <Input type="number" step="0.01" value={payRate} onChange={(e) => setPayRate(e.target.value)} />
        </div>
        <div>
          <Label>Bill rate</Label>
          <Input type="number" step="0.01" value={billRate} onChange={(e) => setBillRate(e.target.value)} />
        </div>
      </div>
      <div>
        <Label>Probabilidad (%)</Label>
        <Input type="number" min={0} max={100} value={probability} onChange={(e) => setProbability(e.target.value)} />
      </div>
      <Button type="submit" className="w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Convirtiendo…" : "Convertir a Oportunidad"}
      </Button>
    </form>
  );
}

function OutreachApprovals({ leadId }: { leadId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: approvals } = useQuery({
    queryKey: ["approvals-for-lead", leadId],
    queryFn: () => apiFetch<ApprovalRequestListItem[]>("/approvals"),
    select: (all) => all.filter((a) => (a.proposedAction as { leadId?: string } | null)?.leadId === leadId),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "APPROVED" | "REJECTED" }) =>
      apiFetch(`/approvals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision }) }),
    onSuccess: () => {
      toast({ title: "Decisión registrada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["approvals-for-lead", leadId] });
    },
    onError: (err) => toast({ title: "No se pudo registrar la decisión", description: String(err), variant: "error" }),
  });

  if (!approvals || approvals.length === 0) return null;

  return (
    <div className="space-y-3">
      {approvals.map((a) => {
        const action = a.proposedAction as { channel: string; subject?: string; body: string };
        return (
          <div key={a.id} className="rounded-md border border-border p-3 text-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">{a.summary}</span>
              <Badge variant={a.status === "PENDING" ? "warning" : a.status === "APPROVED" ? "success" : "danger"}>
                {formatStatusLabel(a.status)}
              </Badge>
            </div>
            {action.subject && <p className="mb-1 font-medium">{action.subject}</p>}
            <p className="whitespace-pre-wrap text-muted-foreground">{action.body}</p>
            {a.status === "PENDING" && (
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: "APPROVED" })}>
                  Aprobar
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: a.id, decision: "REJECTED" })}
                >
                  Rechazar
                </Button>
              </div>
            )}
            {a.decidedByLabel && (
              <p className="mt-2 text-xs text-muted-foreground">
                Decidido por {a.decidedByLabel}
                {a.decisionNote ? ` — "${a.decisionNote}"` : ""}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showConvert, setShowConvert] = useState(false);
  const { toast } = useToast();

  const { data: lead, isLoading } = useQuery({
    queryKey: ["lead", id],
    queryFn: () => apiFetch<LeadDetailType>(`/leads/${id}`),
    enabled: !!id,
  });

  const activitiesQuery = useQuery({
    queryKey: ["activities", "lead", id],
    queryFn: () => apiFetch<ActivityItem[]>(`/activities?entityType=lead&entityId=${id}`),
    enabled: !!id,
  });

  const statusMutation = useMutation({
    mutationFn: (status: string) =>
      apiFetch(`/leads/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => {
      toast({ title: "Lead actualizado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["lead", id] });
    },
    onError: (err) => toast({ title: "No se pudo actualizar el lead", description: String(err), variant: "error" }),
  });

  if (isLoading || !lead) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {lead.companyName ?? "Lead sin empresa"}
            {lead.createdByAgentTaskId && (
              <Badge variant="primary" title="Creado por el Sales Agent">
                AI
              </Badge>
            )}
          </span>
        }
        description={`${lead.industryName ?? "—"}${lead.city && lead.state ? ` · ${lead.city}, ${lead.state}` : ""}`}
        action={
          <div className="flex items-center gap-2">
            <Select
              value={lead.status}
              disabled={lead.status === "CONVERTED"}
              onChange={(e) => statusMutation.mutate(e.target.value)}
              className="w-40"
            >
              {["NEW", "CONTACTED", "INTERESTED", "QUALIFIED", "UNQUALIFIED", "CONVERTED"].map((s) => (
                <option key={s} value={s}>
                  {formatStatusLabel(s)}
                </option>
              ))}
            </Select>
            {lead.status !== "CONVERTED" && <Button onClick={() => setShowConvert((v) => !v)}>Convertir</Button>}
          </div>
        }
      />

      {showConvert && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Convertir a Oportunidad</CardTitle>
          </CardHeader>
          <CardContent>
            <ConvertForm
              lead={lead}
              onDone={(result) => {
                setShowConvert(false);
                navigate(`/companies/${result.companyId}`);
              }}
            />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Detalles</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fuente</span>
              <span>{lead.source ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Prioridad</span>
              <Badge variant={statusVariant(lead.priority)}>{formatStatusLabel(lead.priority)}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Asignado a</span>
              <span>{lead.ownerLabel ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Score</span>
              <span>{lead.aiScore ?? "—"}</span>
            </div>
            <div className="pt-2">
              <span className="text-muted-foreground">Notas</span>
              <p className="mt-1">{lead.notes ?? "—"}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Actividad</CardTitle>
          </CardHeader>
          <CardContent>
            <Timeline items={activitiesQuery.data ?? lead.recentActivity} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Sales Agent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Los borradores son solo texto — nunca se envían automáticamente. Un humano debe aprobarlos antes de
              usarlos.
            </p>
            <div className="flex gap-3">
              <AgentTaskAction
                label="Redactar email (IA)"
                runningLabel="Redactando…"
                input={{ type: "draft_outreach", input: { leadId: lead.id, channel: "EMAIL" } }}
                onSettled={() => queryClient.invalidateQueries({ queryKey: ["approvals-for-lead", lead.id] })}
                renderResult={() => null}
              />
              <AgentTaskAction
                label="Redactar LinkedIn (IA)"
                runningLabel="Redactando…"
                input={{ type: "draft_outreach", input: { leadId: lead.id, channel: "LINKEDIN" } }}
                onSettled={() => queryClient.invalidateQueries({ queryKey: ["approvals-for-lead", lead.id] })}
                renderResult={() => null}
              />
            </div>
            <OutreachApprovals leadId={lead.id} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
