import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CampaignCompanyDetail as CampaignCompanyDetailType, LogConversationResult } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { AgentTaskAction } from "@/components/shared/AgentTaskAction";
import { SequenceTimeline } from "@/components/shared/SequenceTimeline";
import { IntentBadge } from "@/components/shared/IntentBadge";
import { Timeline } from "@/components/shared/Timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatStatusLabel, statusVariant } from "@/lib/status";

function LogConversationForm({ campaignCompanyId }: { campaignCompanyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [replyText, setReplyText] = useState("");
  const [lastResult, setLastResult] = useState<LogConversationResult | null>(null);

  const mutation = useMutation({
    mutationFn: (text: string) =>
      apiFetch<LogConversationResult>(`/campaign-companies/${campaignCompanyId}/conversation`, {
        method: "POST",
        body: JSON.stringify({ replyText: text }),
      }),
    onSuccess: (result) => {
      setLastResult(result);
      setReplyText("");
      toast({ title: `Clasificado: ${formatStatusLabel(result.intent)}`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["campaign-company", campaignCompanyId] });
    },
    onError: (err) => toast({ title: "No se pudo clasificar la respuesta", description: String(err), variant: "error" }),
  });

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        No hay integración de bandeja de entrada todavía (F4.5) — pegá acá la respuesta que recibiste por el canal que
        sea, y el Conversation Agent la clasifica.
      </p>
      <Textarea
        placeholder="Pegá el texto de la respuesta que recibiste…"
        value={replyText}
        onChange={(e) => setReplyText(e.target.value)}
        rows={3}
      />
      <Button
        size="sm"
        disabled={!replyText.trim() || mutation.isPending}
        onClick={() => mutation.mutate(replyText)}
      >
        {mutation.isPending ? "Clasificando…" : "Registrar respuesta"}
      </Button>
      {lastResult && (
        <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs">
          <div className="mb-1 flex items-center gap-2">
            <IntentBadge intent={lastResult.intent} />
            <span className="text-muted-foreground">→ {formatStatusLabel(lastResult.newStatus)}</span>
          </div>
          <p className="text-muted-foreground">{lastResult.rationale}</p>
        </div>
      )}
    </div>
  );
}

export default function CampaignCompanyDetail() {
  const { campaignId, companyId: campaignCompanyId } = useParams<{ campaignId: string; companyId: string }>();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);

  const { data: cc, isLoading } = useQuery({
    queryKey: ["campaign-company", campaignCompanyId],
    queryFn: () => apiFetch<CampaignCompanyDetailType>(`/campaign-companies/${campaignCompanyId}`),
    enabled: !!campaignCompanyId,
  });

  if (isLoading || !cc) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={cc.companyName}
        description={
          <>
            {cc.industryName} ·{" "}
            <Link to={`/campaigns/${campaignId}`} className="text-primary hover:underline">
              Ver campaña
            </Link>
          </>
        }
        action={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(cc.status)}>{formatStatusLabel(cc.status)}</Badge>
            <IntentBadge intent={cc.lastIntent} />
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Secuencia comercial</CardTitle>
          </CardHeader>
          <CardContent>
            <SequenceTimeline steps={cc.sequence} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Conversación</CardTitle>
          </CardHeader>
          <CardContent>
            <LogConversationForm campaignCompanyId={cc.id} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Acciones del Outreach Agent</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          <AgentTaskAction
            label="Planificar secuencia"
            runningLabel="Planificando…"
            endpoint={`/campaign-companies/${cc.id}/tasks`}
            input={{ type: "plan_sequence", input: {} }}
            onSettled={() => queryClient.invalidateQueries({ queryKey: ["campaign-company", cc.id] })}
            renderResult={(output) => {
              const result = output as { followUpIds: string[]; alreadyExisted: boolean };
              return (
                <p className="mt-2 text-xs text-muted-foreground">
                  {result.alreadyExisted ? "La secuencia ya existía." : "4 pasos creados (día 1/4/9/18)."}
                </p>
              );
            }}
          />

          <div className="space-y-2">
            <Select value={String(step)} onChange={(e) => setStep(Number(e.target.value))}>
              <option value="0">Día 1 — Primer contacto</option>
              <option value="1">Día 4 — Seguimiento</option>
              <option value="2">Día 9 — Caso de éxito</option>
              <option value="3">Día 18 — Último intento</option>
            </Select>
            <AgentTaskAction
              label="Personalizar mensaje"
              runningLabel="Redactando…"
              endpoint={`/campaign-companies/${cc.id}/tasks`}
              input={{ type: "personalize_message", input: { step } }}
              onSettled={() => queryClient.invalidateQueries({ queryKey: ["campaign-company", cc.id] })}
              renderResult={(output) => {
                const result = output as { draftBody: string; subject?: string };
                return (
                  <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                    Borrador creado (pendiente de aprobación) — {result.subject ?? result.draftBody.slice(0, 60)}
                  </p>
                );
              }}
            />
          </div>

          <AgentTaskAction
            label="Sugerir siguiente paso"
            runningLabel="Analizando…"
            endpoint={`/campaign-companies/${cc.id}/tasks`}
            input={{ type: "suggest_next_step", input: {} }}
            onSettled={() => queryClient.invalidateQueries({ queryKey: ["campaign-company", cc.id] })}
            renderResult={(output) => {
              const result = output as { action: string; recommendation: string };
              return <p className="mt-2 text-xs text-muted-foreground">{result.recommendation}</p>;
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actividad</CardTitle>
        </CardHeader>
        <CardContent>
          <Timeline items={cc.recentActivity} />
        </CardContent>
      </Card>
    </div>
  );
}
