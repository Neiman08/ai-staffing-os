// F10.2: tipos locales al frontend para los DTOs de /portal/client/*
// -- esos endpoints devuelven DTOs propios del módulo de portal (mismo
// criterio ya usado por F8.6-F8.10 en components/recruiting/types.ts):
// nunca se agregaron a @ai-staffing-os/shared porque son de solo
// lectura, de bajo riesgo, sin input de body a validar salvo el ya
// tipado directo en el router (approve/reject).

export interface ClientDashboardSummary {
  openJobOrders: number;
  activeAssignments: number;
  pendingTimeEntries: number;
  openIncidents: number;
}

export interface ClientJobOrderListItem {
  id: string;
  title: string;
  status: string;
  workersNeeded: number;
  workersFilled: number;
  startDate: string;
  endDate: string | null;
  location: unknown;
}

export interface ClientShortlistEntry {
  candidateId: string;
  candidateName: string;
  rank: number;
  reviewStatus: string;
}

export interface ClientPlacementListItem {
  id: string;
  candidateName: string | null;
  jobOrderTitle: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
}

export interface ClientAssignmentListItem {
  id: string;
  workerName: string;
  jobOrderTitle: string;
  status: string;
  startDate: string;
  endDate: string | null;
}

export interface ClientWorkerListItem {
  workerId: string;
  name: string;
  jobOrderTitle: string;
  assignmentStatus: string;
}

export interface ClientTimeEntryListItem {
  id: string;
  workerName: string;
  jobOrderTitle: string;
  date: string;
  regularHours: string;
  overtimeHours: string;
  doubleHours: string;
  status: string;
}

export interface ClientIncidentListItem {
  id: string;
  type: string;
  status: string;
  description: string;
  occurredAt: string;
  workerName: string | null;
}

// F10.3: Client Job Request
export interface ClientJobRequestRecord {
  id: string;
  companyId: string;
  requestedTitle: string;
  location: unknown;
  headcount: number;
  shift: string | null;
  schedule: string | null;
  payRateExpectation: string | null;
  billBudget: string | null;
  desiredStartDate: string;
  duration: string | null;
  requiredSkills: string[];
  certifications: string[];
  languageRequirements: string[];
  physicalRequirements: string | null;
  notes: string | null;
  urgency: string;
  status: string;
  reviewNotes: string | null;
  convertedJobOrderId: string | null;
  createdAt: string;
  updatedAt: string;
}
