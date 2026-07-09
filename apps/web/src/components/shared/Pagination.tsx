import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PaginationProps {
  onPrevious: () => void;
  onNext: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
}

export function Pagination({ onPrevious, onNext, hasPrevious, hasNext }: PaginationProps) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-3">
      <Button variant="outline" size="sm" onClick={onPrevious} disabled={!hasPrevious}>
        <ChevronLeft className="h-4 w-4" />
        Anterior
      </Button>
      <Button variant="outline" size="sm" onClick={onNext} disabled={!hasNext}>
        Siguiente
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
