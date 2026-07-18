// F10.5: compartido entre Worker y Candidate portal -- ambos exponen
// exactamente el mismo subconjunto self-service editable
// (phone/city/state/languages/availabilityNotes/skills), nunca
// employmentType/defaultPayRate/status/complianceStatus/yearsExperience
// (juicio interno, nunca editable desde el portal).
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface EditableProfileFields {
  phone: string | null;
  city: string | null;
  state: string | null;
  languages: string[];
  availabilityNotes: string | null;
  skills: string[];
}

function toCsv(values: string[]): string {
  return values.join(", ");
}

function fromCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function ProfileEditForm({
  initial,
  onSave,
  isSaving,
}: {
  initial: EditableProfileFields;
  onSave: (input: EditableProfileFields) => void;
  isSaving: boolean;
}) {
  const [form, setForm] = useState(() => ({
    phone: initial.phone ?? "",
    city: initial.city ?? "",
    state: initial.state ?? "",
    languages: toCsv(initial.languages),
    availabilityNotes: initial.availabilityNotes ?? "",
    skills: toCsv(initial.skills),
  }));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          phone: form.phone.trim() || null,
          city: form.city.trim() || null,
          state: form.state.trim() || null,
          languages: fromCsv(form.languages),
          availabilityNotes: form.availabilityNotes.trim() || null,
          skills: fromCsv(form.skills),
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="profile-phone">Teléfono</Label>
          <Input id="profile-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div />
        <div>
          <Label htmlFor="profile-city">Ciudad</Label>
          <Input id="profile-city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="profile-state">Estado</Label>
          <Input id="profile-state" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
        </div>
      </div>
      <div>
        <Label htmlFor="profile-languages">Idiomas (separados por coma)</Label>
        <Input
          id="profile-languages"
          value={form.languages}
          onChange={(e) => setForm({ ...form, languages: e.target.value })}
          placeholder="English, Spanish"
        />
      </div>
      <div>
        <Label htmlFor="profile-skills">Skills (separados por coma)</Label>
        <Input id="profile-skills" value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} placeholder="forklift, osha-10" />
      </div>
      <div>
        <Label htmlFor="profile-availability">Disponibilidad</Label>
        <Textarea
          id="profile-availability"
          value={form.availabilityNotes}
          onChange={(e) => setForm({ ...form, availabilityNotes: e.target.value })}
          placeholder="Ej: disponible fines de semana"
        />
      </div>
      <Button type="submit" disabled={isSaving}>
        {isSaving ? "Guardando…" : "Guardar cambios"}
      </Button>
    </form>
  );
}
