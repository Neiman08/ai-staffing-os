import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

export function NewButton({ label }: { label: string }) {
  return (
    <Tooltip label="Disponible en F1">
      <Button disabled aria-disabled="true">
        <Plus className="h-4 w-4" />
        {label}
      </Button>
    </Tooltip>
  );
}
