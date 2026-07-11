import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Container } from "./Container";

interface SectionProps {
  children: ReactNode;
  className?: string;
  tone?: "default" | "muted" | "ink";
  id?: string;
}

const TONE_CLASSES: Record<NonNullable<SectionProps["tone"]>, string> = {
  default: "bg-background",
  muted: "bg-muted/60",
  ink: "bg-ink text-ink-foreground",
};

export function Section({ children, className, tone = "default", id }: SectionProps) {
  return (
    <section id={id} className={cn("py-20 sm:py-28", TONE_CLASSES[tone], className)}>
      <Container>{children}</Container>
    </section>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("mb-3 text-xs font-semibold uppercase tracking-widest text-primary", className)}>{children}</p>
  );
}
