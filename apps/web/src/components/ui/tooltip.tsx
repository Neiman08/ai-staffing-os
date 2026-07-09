import * as React from "react";
import { cn } from "@/lib/utils";

interface TooltipProps {
  label: string;
  children: React.ReactNode;
  className?: string;
}

export function Tooltip({ label, children, className }: TooltipProps) {
  return (
    <span className={cn("group relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background opacity-0 shadow-md transition-opacity group-hover:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
