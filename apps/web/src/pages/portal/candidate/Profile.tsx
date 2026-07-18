import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { ProfileEditForm, type EditableProfileFields } from "../shared/ProfileEditForm";
import type { CandidateProfile } from "./types";

export default function CandidateProfilePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: profile, isLoading } = useQuery({
    queryKey: ["portal-candidate-profile"],
    queryFn: () => apiFetch<CandidateProfile>("/portal/candidate/profile"),
  });

  const updateMutation = useMutation({
    mutationFn: (input: EditableProfileFields) =>
      apiFetch<CandidateProfile>("/portal/candidate/profile", { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Perfil actualizado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["portal-candidate-profile"] });
    },
    onError: (err) => toast({ title: "No se pudo actualizar el perfil", description: String(err), variant: "error" }),
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
            <div className="flex justify-between">
              <span className="text-muted-foreground">Skills</span>
              <span>{profile.skills.join(", ") || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Disponibilidad</span>
              <span>{profile.availabilityNotes ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Años de experiencia</span>
              <span>{profile.yearsExperience ?? "—"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Editar mi perfil</CardTitle>
          </CardHeader>
          <CardContent>
            <ProfileEditForm
              initial={{
                phone: profile.phone,
                city: profile.city,
                state: profile.state,
                languages: profile.languages,
                availabilityNotes: profile.availabilityNotes,
                skills: profile.skills,
              }}
              onSave={(input) => updateMutation.mutate(input)}
              isSaving={updateMutation.isPending}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
