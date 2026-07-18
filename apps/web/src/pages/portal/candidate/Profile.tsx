import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { CandidateProfile } from "./types";

export default function CandidateProfilePage() {
  const { data: profile, isLoading } = useQuery({
    queryKey: ["portal-candidate-profile"],
    queryFn: () => apiFetch<CandidateProfile>("/portal/candidate/profile"),
  });

  if (isLoading || !profile) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div>
      <PageHeader
        title={`${profile.firstName} ${profile.lastName}`}
        description="Tu perfil de candidato."
        action={<Badge variant={statusVariant(profile.status)}>{formatStatusLabel(profile.status)}</Badge>}
      />

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
          <div className="flex justify-between">
            <span className="text-muted-foreground">Años de experiencia</span>
            <span>{profile.yearsExperience ?? "—"}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
