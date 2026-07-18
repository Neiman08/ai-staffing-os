/**
 * F10.4: Candidate Portal -- TODA función exige `ctx.candidateId`
 * (F10.1) y filtra explícitamente por él. NUNCA expone rankings frente
 * a otros candidatos (`rank`, `score`), ni notas internas de recruiting
 * (`reasons`/`gaps`/`risks`/`evidence`) -- ver docs/F10_PLAN.md §6.1.
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";

function requireCandidateContext(): { tenantId: string; candidateId: string } {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  if (!ctx.candidateId) throw AppError.forbidden("This account is not linked to a Candidate portal identity");
  return { tenantId: ctx.tenantId, candidateId: ctx.candidateId };
}

export interface CandidateProfile {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  languages: string[];
  yearsExperience: number | null;
  status: string;
}

export async function getCandidateProfile(): Promise<CandidateProfile> {
  const { candidateId } = requireCandidateContext();
  const candidate = await scopedDb.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate) throw AppError.notFound("Candidate not found");
  return {
    id: candidate.id,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    email: candidate.email,
    phone: candidate.phone,
    city: candidate.city,
    state: candidate.state,
    languages: candidate.languages,
    yearsExperience: candidate.yearsExperience,
    status: candidate.status,
  };
}

export interface CandidateApplicationItem {
  jobOrderId: string;
  jobOrderTitle: string;
  qualificationStatus: string;
  shortlistReviewStatus: string | null;
  calculatedAt: string;
}

/**
 * F10.4: "aplicaciones/matches visibles" -- deliberadamente SIN score/
 * rank/reasons/gaps/risks/evidence (lógica interna de scoring, y rank
 * revelaría posición frente a otros candidatos). Solo jobs donde el
 * candidato es QUALIFIED o POSSIBLY_QUALIFIED -- NOT_QUALIFIED nunca se
 * muestra como una "aplicación" real.
 */
export async function listCandidateApplications(): Promise<CandidateApplicationItem[]> {
  const { candidateId } = requireCandidateContext();
  const matches = await scopedDb.candidateMatch.findMany({
    where: { candidateId, qualificationStatus: { in: ["QUALIFIED", "POSSIBLY_QUALIFIED"] } },
    include: { jobOrder: { select: { title: true } } },
    orderBy: { calculatedAt: "desc" },
  });

  const shortlistEntries = await scopedDb.candidateShortlistEntry.findMany({
    where: { candidateId, jobOrderId: { in: matches.map((m) => m.jobOrderId) } },
    select: { jobOrderId: true, reviewStatus: true },
  });
  const shortlistByJobOrder = new Map(shortlistEntries.map((s) => [s.jobOrderId, s.reviewStatus]));

  return matches.map((m) => ({
    jobOrderId: m.jobOrderId,
    jobOrderTitle: m.jobOrder.title,
    qualificationStatus: m.qualificationStatus,
    shortlistReviewStatus: shortlistByJobOrder.get(m.jobOrderId) ?? null,
    calculatedAt: m.calculatedAt.toISOString(),
  }));
}

export interface CandidateOnboardingItem {
  id: string;
  jobOrderId: string;
  jobOrderTitle: string;
  status: string;
  progress: number;
  nextBestAction: string;
}

export async function listCandidateOnboarding(): Promise<CandidateOnboardingItem[]> {
  const { candidateId } = requireCandidateContext();
  const rows = await scopedDb.workerOnboarding.findMany({
    where: { candidateId },
    include: { jobOrder: { select: { title: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    jobOrderId: r.jobOrderId,
    jobOrderTitle: r.jobOrder.title,
    status: r.status,
    progress: r.progress,
    nextBestAction: r.nextBestAction,
  }));
}

export interface CandidateDocumentItem {
  id: string;
  label: string;
  status: string;
  required: boolean;
  expiresAt: string | null;
  rejectionReason: string | null;
}

export async function listCandidateDocuments(): Promise<CandidateDocumentItem[]> {
  const { candidateId } = requireCandidateContext();
  const items = await scopedDb.documentChecklistItem.findMany({
    where: { workerOnboarding: { candidateId } },
    orderBy: { createdAt: "asc" },
  });
  return items.map((i) => ({
    id: i.id,
    label: i.label,
    status: i.status,
    required: i.required,
    expiresAt: i.expiresAt?.toISOString() ?? null,
    rejectionReason: i.rejectionReason,
  }));
}
