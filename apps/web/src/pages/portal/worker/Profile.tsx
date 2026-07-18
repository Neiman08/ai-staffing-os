import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { WorkerProfile } from "./types";

export default function WorkerProfilePage() {
  const { data: profile, isLoading } = useQuery({
    queryKey: ["portal-worker-profile"],
    queryFn: () => apiFetch<WorkerProfile>("/portal/worker/profile"),
  });

  if (isLoading || !profile) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div>
      <PageHeader
        title={`${profile.firstName} ${profile.lastName}`}
        description="Tu perfil como Worker."
        action={<Badge variant={statusVariant(profile.status)}>{formatStatusLabel(profile.status)}</Badge>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Información personal</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email</span>
              <span>{profile.email ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Teléfono</span>
              <span>{profile.phone ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ubicación</span>
              <span>{profile.city && profile.state ? `${profile.city}, ${profile.state}` : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Idiomas</span>
              <span>{profile.languages.join(", ").toUpperCase() || "—"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Datos de empleo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Employment type</span>
              <span>{profile.employmentType === "C1099" ? "1099" : "W2"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pay rate</span>
              <span>${Number(profile.defaultPayRate).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Compliance</span>
              <Badge variant={statusVariant(profile.complianceStatus)}>{formatStatusLabel(profile.complianceStatus)}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Contratado</span>
              <span>{profile.hiredAt ? new Date(profile.hiredAt).toLocaleDateString() : "—"}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
