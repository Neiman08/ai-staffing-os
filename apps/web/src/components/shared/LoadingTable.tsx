import { Skeleton } from "@/components/ui/skeleton";

export function LoadingTable({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" aria-hidden="true" />
      ))}
    </div>
  );
}
