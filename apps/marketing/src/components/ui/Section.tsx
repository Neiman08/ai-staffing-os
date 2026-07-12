import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Container } from "./Container";
import { Photo } from "./Photo";

interface SectionProps {
  children: ReactNode;
  className?: string;
  tone?: "default" | "muted" | "ink";
  id?: string;
  /** F4.8A: foto de fondo opcional para heroes de página interna —
   * siempre con overlay oscuro + gradiente para legibilidad, nunca
   * reemplaza el tone (que sigue controlando el color de texto). */
  backgroundPhoto?: { src: string; alt?: string };
}

const TONE_CLASSES: Record<NonNullable<SectionProps["tone"]>, string> = {
  default: "bg-background",
  muted: "bg-muted/60",
  ink: "bg-ink text-ink-foreground",
};

export function Section({ children, className, tone = "default", id, backgroundPhoto }: SectionProps) {
  return (
    <section
      id={id}
      className={cn(
        "py-20 sm:py-28",
        TONE_CLASSES[tone],
        backgroundPhoto && "relative isolate overflow-hidden",
        className,
      )}
    >
      {backgroundPhoto && (
        <Photo src={backgroundPhoto.src} alt={backgroundPhoto.alt ?? ""} overlay="dark" className="absolute inset-0 -z-10 h-full w-full" />
      )}
      <Container>{children}</Container>
    </section>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("mb-3 text-xs font-semibold uppercase tracking-widest text-primary", className)}>{children}</p>
  );
}
