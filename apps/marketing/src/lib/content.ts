import {
  Building2,
  Cpu,
  Factory,
  HardHat,
  Warehouse,
  Zap,
  Wrench,
  ShieldCheck,
  Search,
  Users,
  FileCheck,
  Handshake,
  Radar,
  Mail,
  BrainCircuit,
  Gauge,
  Sparkles,
} from "lucide-react";
import { PHOTOS } from "./photos";

/**
 * F4.8: contenido estático real de posicionamiento — describe
 * CAPACIDADES reales del sistema (el Discovery Agent efectivamente sabe
 * buscar "data center construction", "electrical contractor", etc. —
 * ver apps/api/src/modules/agents/tools/ceo-tools.impl.ts) y tipos de
 * servicio de staffing genuinos de la industria. Nunca nombra un
 * cliente real ni inventa un número de colocaciones — esos datos, si
 * existen, se piden a /public/stats (F4.8 Industries §: "No inventar
 * clientes").
 */
export const INDUSTRIES = [
  {
    slug: "data-centers",
    name: "Data Centers",
    icon: Cpu,
    summary: "Mission-critical staffing for hyperscale, colocation, and enterprise data center builds and operations.",
    detail:
      "From pre-fabrication to commissioning, we source electricians, low-voltage technicians, and controls specialists who understand the tolerances mission-critical environments demand.",
  },
  {
    slug: "electrical",
    name: "Electrical",
    icon: Zap,
    summary: "Journeyman and apprentice electricians, low-voltage and fiber optic technicians.",
    detail: "Licensed and field-tested talent for commercial, industrial, and mission-critical electrical scopes — vetted before they ever reach your job site.",
  },
  {
    slug: "mechanical",
    name: "Mechanical",
    icon: Wrench,
    summary: "HVAC, mechanical, and controls talent for industrial and commercial builds.",
    detail: "Mechanical contractors, HVAC technicians, and controls specialists for new construction, retrofits, and critical-facility maintenance programs.",
  },
  {
    slug: "construction",
    name: "Construction",
    icon: HardHat,
    summary: "Skilled trades and project staffing for commercial and industrial construction.",
    detail: "General contractors, project staffing, and skilled trades across commercial, industrial, and infrastructure builds.",
  },
  {
    slug: "manufacturing",
    name: "Manufacturing",
    icon: Factory,
    summary: "Production, assembly, and skilled manufacturing talent — temp-to-hire or direct.",
    detail: "From production floor to plant management, we fill manufacturing roles fast without compromising on fit or reliability.",
  },
  {
    slug: "warehouse",
    name: "Warehouse",
    icon: Warehouse,
    summary: "Warehouse operations, forklift, and logistics staffing that scales with demand.",
    detail: "Warehouse workers, forklift operators, and logistics coordinators — sourced and screened for facilities that can't afford downtime.",
  },
  {
    slug: "industrial",
    name: "Industrial",
    icon: Building2,
    summary: "General industrial and facilities staffing across every shift.",
    detail: "Broad industrial staffing coverage for facilities that need reliable coverage across multiple shifts and skill levels.",
  },
] as const;

export const SERVICE_TYPES = [
  {
    name: "Temporary Staffing",
    icon: Users,
    photo: PHOTOS.warehouseLogistics,
    description: "Flexible, short-to-medium term coverage for seasonal demand, project surges, or unexpected gaps — without the overhead of a direct hire.",
  },
  {
    name: "Direct Hire",
    icon: Handshake,
    photo: PHOTOS.officeTeamMeeting,
    description: "Full-cycle recruiting for permanent roles, from sourcing through offer — built for teams that need to hire right the first time.",
  },
  {
    name: "Skilled Trades",
    icon: HardHat,
    photo: PHOTOS.electricalTrade,
    description: "Licensed and certified trades talent — electricians, mechanics, and technicians — vetted for the credentials your job actually requires.",
  },
  {
    name: "Project Staffing",
    icon: FileCheck,
    photo: PHOTOS.constructionSite,
    description: "Dedicated crews scoped to a single project timeline, scaled up or down as the build progresses.",
  },
] as const;

export const HOW_IT_WORKS_EMPLOYERS = [
  { title: "Tell us what you need", description: "Submit a Request Talent form with your role, location, and timeline — takes under two minutes.", icon: FileCheck },
  { title: "We source and verify", description: "Our AI-assisted discovery and verification pipeline identifies and screens qualified candidates against real, confirmed data — never guesses.", icon: Search },
  { title: "You review and decide", description: "Every candidate is reviewed by our team before you ever see them — no automated placements, ever.", icon: ShieldCheck },
  { title: "We stay engaged", description: "From onboarding through the life of the assignment, your account team stays involved.", icon: Handshake },
] as const;

export const HOW_IT_WORKS_CANDIDATES = [
  { title: "Apply in minutes", description: "Tell us your trade, experience, and location — no lengthy forms, no account required.", icon: FileCheck },
  { title: "We match you to real openings", description: "We match your profile against active, verified openings — never a generic mass-blast.", icon: Search },
  { title: "Talk to a real recruiter", description: "A human reviews every application before you're presented to an employer.", icon: Users },
  { title: "Get to work", description: "From offer to first day, we handle the paperwork so you can focus on the job.", icon: Handshake },
] as const;

export const AI_CAPABILITIES = [
  {
    title: "AI-Powered Discovery",
    description: "Our discovery engine continuously identifies real, verifiable employers actively hiring across your industry and region — never a purchased list.",
    icon: Radar,
  },
  {
    title: "Verified Contact Intelligence",
    description: "Every decision-maker we reach out to is identified and verified through authorized data sources — never guessed, never fabricated.",
    icon: BrainCircuit,
  },
  {
    title: "Deliverability-Verified Outreach",
    description: "Email addresses are verified for deliverability before any human-approved outreach goes out — protecting your inbox and ours.",
    icon: Mail,
  },
  {
    title: "Human Approval, Always",
    description: "AI accelerates research and matching — every message, every placement decision is reviewed and approved by a real person.",
    icon: Gauge,
  },
] as const;

export const FAQ_ITEMS = [
  {
    question: "How fast can you fill a role?",
    answer:
      "Timelines depend on the role's specificity and location, but our AI-assisted discovery and verification pipeline lets our recruiters move faster than manual sourcing alone — most requests get a response within one business day.",
  },
  {
    question: "Do you only work with large employers?",
    answer:
      "No — we work with employers of every size, from single-site operations to multi-facility organizations, across Manufacturing, Construction, Warehouse/Logistics, and General Labor.",
  },
  {
    question: "Is your technology replacing human recruiters?",
    answer:
      "No. Our AI agents handle research, discovery, and verification — the decisions that matter (who to contact, who to present, what to send) always go through human approval before anything leaves our system.",
  },
  {
    question: "What does it cost to submit a request?",
    answer: "Submitting a Request Talent form is free with no obligation — a member of our team will follow up to discuss your specific needs.",
  },
  {
    question: "How do you verify candidates?",
    answer:
      "Every candidate is reviewed by a recruiter before being presented to an employer. Contact and credential data used in our process is sourced from authorized providers and verified before it's relied on — we never fabricate or infer data we can't confirm.",
  },
] as const;

// F4.8A: franja de beneficios del Home — restatement de hechos reales
// ya presentes en SERVICE_TYPES/AI_CAPABILITIES arriba, nunca una
// afirmación nueva sin respaldo.
export const BENEFITS = [
  {
    title: "Verified Talent",
    icon: ShieldCheck,
    description: "Every candidate is reviewed by a recruiter before you ever see them — no automated placements.",
  },
  {
    title: "Flexible Engagement",
    icon: Sparkles,
    description: "Temporary, Direct Hire, Skilled Trades, or Project Staffing — whichever model fits your need.",
  },
  {
    title: "AI-Accelerated Discovery",
    icon: Radar,
    description: "Our discovery engine identifies real, verifiable opportunities faster than manual sourcing alone.",
  },
  {
    title: "Human-Approved, Always",
    icon: Users,
    description: "AI accelerates research — every placement decision is reviewed and approved by a real person.",
  },
] as const;
