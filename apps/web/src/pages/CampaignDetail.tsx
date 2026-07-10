import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CampaignDetail as CampaignDetailType, UpdateCampaignInput } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { AgentTaskAction } from "@/components/shared/AgentTaskAction";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { Sparkles } from "lucide-react";
import { CompanyOriginBadge } from "@/components/shared/CompanyOriginBadge";

const CAMPAIGN_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED"];

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: campaign, isLoading } = useQuery({
    queryKey: ["campaign", id],
    queryFn: () => apiFetch<CampaignDetailType>(`/campaigns/${id}`),
    enabled: !!id,
  });

  const updateMutation = useMutation({
    mutationFn: (input: UpdateCampaignInput) =>
      apiFetch(`/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Campaña actualizada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["campaign", id] });
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: (err) => toast({ title: "No se pudo actualizar la campaña", description: String(err), variant: "error" }),
  });

  if (isLoading || !campaign) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={campaign.name}
        description={`${campaign.industryName ?? "Cualquier industria"}${campaign.state ? ` · ${campaign.state}` : ""}${campaign.city ? `, ${campaign.city}` : ""}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(campaign.status)}>{formatStatusLabel(campaign.status)}</Badge>
            <Select
              className="w-36"
              value={campaign.status}
              onChange={(e) => updateMutation.mutate({ status: e.target.value as UpdateCampaignInput["status"] })}
            >
              {CAMPAIGN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {formatStatusLabel(s)}
                </option>
              ))}
            </Select>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Criterios</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tamaño</span>
              <span>
                {campaign.minCompanySize ? formatStatusLabel(campaign.minCompanySize) : "—"}
                {campaign.maxCompanySize ? ` a ${formatStatusLabel(campaign.maxCompanySize)}` : ""}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Score mínimo</span>
              <span>{campaign.minScore ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Prioridad</span>
              <Badge variant={campaign.priority === "HIGH" ? "danger" : "warning"}>
                {formatStatusLabel(campaign.priority)}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Costo IA</span>
              <span>${campaign.costUsd.toFixed(4)}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Resultados</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Leads creados</span>
              <span>{campaign.leadsCreated}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Oportunidades creadas</span>
              <span>{campaign.opportunitiesCreated}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pipeline estimado</span>
              <span>${campaign.opportunitiesValueUsd.toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              Recomendación del Campaign Agent
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {campaign.latestRecommendation ?? "Sin recomendación todavía — corré \"Optimizar\" abajo."}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Acciones del Campaign Agent</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          <AgentTaskAction
            label="Seleccionar empresas objetivo"
            runningLabel="Seleccionando…"
            endpoint={`/campaigns/${id}/tasks`}
            input={{ type: "select_target_companies", input: {} }}
            onSettled={() => queryClient.invalidateQueries({ queryKey: ["campaign", id] })}
            renderResult={(output) => {
              const result = output as { companyIds: string[]; addedCount: number };
              return (
                <p className="mt-2 text-xs text-muted-foreground">
                  {result.addedCount} empresa(s) nueva(s) agregada(s) a la campaña.
                </p>
              );
            }}
          />
          <AgentTaskAction
            label="Medir resultados"
            runningLabel="Midiendo…"
            endpoint={`/campaigns/${id}/tasks`}
            input={{ type: "measure_campaign", input: {} }}
            onSettled={() => queryClient.invalidateQueries({ queryKey: ["campaign", id] })}
            renderResult={(output) => {
              const result = output as {
                statusCounts: Record<string, number>;
                costUsd: number;
                leadsCreated: number;
                opportunitiesCreated: number;
                opportunitiesValueUsd: number;
              };
              return (
                <p className="mt-2 text-xs text-muted-foreground">
                  {result.leadsCreated} leads, {result.opportunitiesCreated} oportunidades, $
                  {result.costUsd.toFixed(4)} costo IA.
                </p>
              );
            }}
          />
          <AgentTaskAction
            label="Optimizar campaña"
            runningLabel="Analizando…"
            endpoint={`/campaigns/${id}/tasks`}
            input={{ type: "optimize_campaign", input: {} }}
            onSettled={() => queryClient.invalidateQueries({ queryKey: ["campaign", id] })}
            renderResult={(output) => {
              const result = output as { recommendation: string };
              return <p className="mt-2 text-xs text-muted-foreground">{result.recommendation}</p>;
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Empresas en esta campaña ({campaign.companies.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {campaign.companies.length ? (
            campaign.companies.map((c) => (
              <Link
                key={c.id}
                to={`/campaigns/${campaign.id}/companies/${c.id}`}
                className="flex items-center justify-between rounded-md border border-border p-3 text-sm hover:border-primary/40"
              >
                <span className="font-medium">{c.companyName}</span>
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(c.status)}>{formatStatusLabel(c.status)}</Badge>
                  <CompanyOriginBadge origin={c.companyOrigin} title={c.companySourceUrl ?? undefined} />
                  {c.lastIntent && <Badge variant="neutral">{formatStatusLabel(c.lastIntent)}</Badge>}
                </div>
              </Link>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">Sin empresas todavía — corré "Seleccionar empresas objetivo".</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
