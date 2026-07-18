// F10.4: tipos locales al frontend para los DTOs de /portal/candidate/*.

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

export interface CandidateApplicationItem {
  jobOrderId: string;
  jobOrderTitle: string;
  qualificationStatus: string;
  shortlistReviewStatus: string | null;
  calculatedAt: string;
}

export interface CandidateOnboardingItem {
  id: string;
  jobOrderId: string;
  jobOrderTitle: string;
  status: string;
  progress: number;
  nextBestAction: string;
}

export interface CandidateDocumentItem {
  id: string;
  label: string;
  status: string;
  required: boolean;
  expiresAt: string | null;
  rejectionReason: string | null;
}
