// F10.5: "Enviar documento" -- deliberadamente NO es un file picker real
// (no existe backend de storage real, ver DocumentStorageAdapter /
// docs/F10_PLAN.md §7). Solo captura fileName + notas; el backend genera
// una referencia mock (`mock://...`), nunca bytes.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function SubmitDocumentDrawer({
  label,
  onSubmit,
  isSubmitting,
}: {
  label: string;
  onSubmit: (input: { fileName: string; notes: string | null }) => void;
  isSubmitting: boolean;
}) {
  const [fileName, setFileName] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ fileName, notes: notes.trim() || null });
      }}
    >
      <p className="text-xs text-muted-foreground">
        Almacenamiento de archivos real pendiente de integración -- solo se registra el nombre del archivo como referencia. Documento: <strong>{label}</strong>
      </p>
      <div>
        <Label htmlFor="submit-doc-filename">Nombre del archivo *</Label>
        <Input id="submit-doc-filename" required value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="i9-form.pdf" />
      </div>
      <div>
        <Label htmlFor="submit-doc-notes">Notas</Label>
        <Textarea id="submit-doc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <Button type="submit" className="w-full" disabled={isSubmitting || !fileName.trim()}>
        {isSubmitting ? "Enviando…" : "Enviar documento"}
      </Button>
    </form>
  );
}
