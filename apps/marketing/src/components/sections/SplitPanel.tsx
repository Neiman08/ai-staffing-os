import { ArrowRight } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { Photo } from "@/components/ui/Photo";

interface SplitPanelProps {
  photo: { src: string; alt: string };
  eyebrow: string;
  title: string;
  titleAccent: string;
  description: string;
  cta: { to: string; label: string };
}

/**
 * F4.8A: bloque 50/50 con foto real + overlay — usado en pares (ver
 * Home.tsx, candidatos/empleadores). Mismo copy real que antes vivía en
 * la lista de bullets, solo cambia la composición visual.
 */
export function SplitPanel({ photo, eyebrow, title, titleAccent, description, cta }: SplitPanelProps) {
  return (
    <div className="relative isolate flex min-h-[26rem] items-end overflow-hidden">
      <Photo src={photo.src} alt={photo.alt} overlay="gradient" className="absolute inset-0 -z-10 h-full w-full" />
      <div className="p-8 text-white sm:p-12">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">{eyebrow}</p>
        <h3 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
          {title} <span className="text-gradient">{titleAccent}</span>
        </h3>
        <p className="mt-3 max-w-sm text-balance text-sm text-white/75">{description}</p>
        <ButtonLink to={cta.to} variant="primary" className="mt-6">
          {cta.label} <ArrowRight className="h-4 w-4" />
        </ButtonLink>
      </div>
    </div>
  );
}
