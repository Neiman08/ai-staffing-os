import { Link } from "react-router-dom";
import type { CampaignListItem } from "@ai-staffing-os/shared";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { Bot } from "lucide-react";

const STATUS_ORDER = ["TARGETED", "SEQUENCING", "HOT", "RECOVERED", "COLD", "CONVERTED", "EXCLUDED"];

/** F4: tarjeta premium de campaña — mismo lenguaje visual que Companies.tsx (F3.5). */
export function CampaignCard({ campaign }: { campaign: CampaignListItem }) {
  const totalCompanies = Object.values(campaign.statusCounts).reduce((sum, n) => sum + n, 0);

  return (
    <Link to={`/campaigns/${campaign.id}`}>
      <Card className="card-hover flex h-full flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium" title={campaign.name}>
                {campaign.name}
              </span>
              {campaign.createdByAgentTaskId && (
                <Badge variant="primary" title="Creada por el Campaign Agent">
                  <Bot className="mr-0.5 h-3 w-3" />
                  AI
                </Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {campaign.industryName ?? "Cualquier industria"}
              {campaign.state ? ` · ${campaign.state}` : ""}
              {campaign.city ? `, ${campaign.city}` : ""}
            </p>
          </div>
          <Badge variant={statusVariant(campaign.status)}>{formatStatusLabel(campaign.status)}</Badge>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 px-3 py-2">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Empresas</p>
            <p className="text-2xl font-semibold tabular-nums tracking-tight">{totalCompanies}</p>
          </div>
          <Badge variant={campaign.priority === "HIGH" ? "danger" : campaign.priority === "LOW" ? "neutral" : "warning"}>
            {formatStatusLabel(campaign.priority)}
          </Badge>
        </div>

        <div className="flex flex-wrap gap-1.5 text-xs">
          {STATUS_ORDER.filter((s) => campaign.statusCounts[s]).map((s) => (
            <Badge key={s} variant={statusVariant(s)}>
              {formatStatusLabel(s)}: {campaign.statusCounts[s]}
            </Badge>
          ))}
          {totalCompanies === 0 && <span className="text-muted-foreground">Sin empresas seleccionadas todavía.</span>}
        </div>

        <div className="mt-auto flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
          <span>Costo IA: ${campaign.costUsd.toFixed(4)}</span>
          <span>{new Date(campaign.createdAt).toLocaleDateString()}</span>
        </div>
      </Card>
    </Link>
  );
}
