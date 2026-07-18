// F8.11: tipos locales al frontend para los DTOs de F8.6-F8.10 --
// esos endpoints devuelven DTOs locales al service de la API (mismo
// criterio que F8.2/F8.3, nunca se agregaron a @ai-staffing-os/shared),
// así que el frontend define su propia forma aquí en vez de inventar un
// import inexistente.

export type PersistedQualificationStatus = "QUALIFIED" | "POSSIBLY_QUALIFIED" | "NEEDS_REVIEW" | "NOT_QUALIFIED";
export type MatchConfidence = "HIGH" | "MEDIUM" | "LOW";
export type ShortlistReviewStatus = "DRAFT" | "READY_FOR_REVIEW" | "APPROVED" | "HOLD" | "REMOVED";
export type InterviewPreviewStatus = "DRAFT" | "NEEDS_AVAILABILITY" | "READY_FOR_APPROVAL" | "APPROVED_FOR_SEND" | "CANCELLED";
export type InterviewModality = "PHONE" | "VIDEO" | "IN_PERSON";
export type PlacementReadinessStatus = "NOT_READY" | "NEEDS_REVIEW" | "CONDITIONALLY_READY" | "READY_FOR_APPROVAL";

export interface CandidateMatchFactor {
  key: string;
  label: string;
  maxWeight: number;
  score: number;
  evidence: string[];
}

export interface CandidateMatchRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  qualificationStatus: PersistedQualificationStatus;
  recommendable: boolean;
  needsReview: boolean;
  hardConstraints: string[];
  softPreferences: CandidateMatchFactor[];
  score: number;
  normalizedScore: number;
  rank: number | null;
  explanation: string;
  confidence: MatchConfidence;
  missingData: string[];
  risks: string[];
  evidence: string[];
  rulesVersion: number;
  calculatedAt: string;
}

export interface CandidateMatchingApiResult {
  jobOrderId: string;
  ranked: CandidateMatchRecord[];
  excluded: CandidateMatchRecord[];
  rulesVersion: number;
  calculatedAt: string;
}

export interface ShortlistEntryRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  rank: number;
  score: number;
  normalizedScore: number;
  qualificationStatus: PersistedQualificationStatus;
  confidence: MatchConfidence;
  reasons: string[];
  gaps: string[];
  risks: string[];
  reviewStatus: ShortlistReviewStatus;
  addedById: string | null;
  addedAt: string;
  updatedAt: string;
}

export interface QualificationEvaluationResult {
  hardDisqualifiers: string[];
  missingDocuments: string[];
  expiredDocuments: string[];
  experienceGap: boolean;
  languageGaps: string[];
  strengths: string[];
  reasons: string[];
  rulesVersion: number;
}

export interface ScreeningQuestion {
  id: string;
  question: string;
  rationale: string;
  expectedEvidence: string;
}

export interface ScreeningPlanRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  questions: ScreeningQuestion[];
  allowedDisqualifiers: string[];
  manualReviewFlags: string[];
  missingInformation: string[];
  riskFlags: string[];
  rulesVersion: number;
  calculatedAt: string;
}

export interface InterviewPreviewRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  status: InterviewPreviewStatus;
  proposedWindows: Array<{ start: string; end: string }>;
  durationMinutes: number;
  timezone: string;
  modality: InterviewModality;
  locationOrLink: string | null;
  participants: Array<{ role: string; name: string }>;
  restrictions: string[];
  conflicts: Array<{ withInterviewPreviewId: string; window: { start: string; end: string } }>;
  availabilityConfirmed: false;
  missingInformation: string[];
  rulesVersion: number;
  calculatedAt: string;
}

export interface PlacementReadinessRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  readinessStatus: PlacementReadinessStatus;
  score: number;
  blockers: string[];
  warnings: string[];
  completedChecks: string[];
  pendingChecks: string[];
  missingInformation: string[];
  nextBestAction: string;
  requiresApproval: boolean;
  evaluatedAt: string;
  rulesVersion: number;
}

// F9.9: tipos locales para los DTOs de F9.1/F9.2 -- mismo criterio que
// arriba, esos endpoints tampoco agregaron nada a @ai-staffing-os/shared.

export type OnboardingStatus =
  | "INVITED"
  | "IN_PROGRESS"
  | "DOCUMENTS_PENDING"
  | "COMPLIANCE_REVIEW"
  | "READY"
  | "ACTIVE"
  | "BLOCKED"
  | "OFFBOARDED";

export interface WorkerOnboardingRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  workerId: string | null;
  status: OnboardingStatus;
  progress: number;
  blockers: string[];
  warnings: string[];
  nextBestAction: string;
  requiresApproval: true;
  rulesVersion: number;
  startedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChecklistItemStatus =
  | "NOT_REQUESTED"
  | "PENDING"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "VERIFIED"
  | "REJECTED"
  | "EXPIRED"
  | "WAIVED";

export interface DocumentChecklistItemRecord {
  id: string;
  workerOnboardingId: string;
  documentTypeId: string;
  documentTypeKey: string;
  documentId: string | null;
  label: string;
  required: boolean;
  status: ChecklistItemStatus;
  source: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
  verifiedById: string | null;
  rejectionReason: string | null;
  notes: string | null;
  manualReviewRequired: boolean;
  createdAt: string;
  updatedAt: string;
}
