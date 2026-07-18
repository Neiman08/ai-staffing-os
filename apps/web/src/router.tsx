import { createBrowserRouter } from "react-router-dom";
import App from "./App";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { CLERK_CONFIGURED } from "@/lib/auth-config";
import { SignInPage } from "./pages/auth/SignInPage";
import { SignUpPage } from "./pages/auth/SignUpPage";
import Dashboard from "./pages/Dashboard";
import Companies from "./pages/Companies";
import CompanyDetail from "./pages/CompanyDetail";
import Contacts from "./pages/Contacts";
import Leads from "./pages/Leads";
import LeadDetail from "./pages/LeadDetail";
import Pipeline from "./pages/Pipeline";
import Opportunities from "./pages/Opportunities";
import FollowUps from "./pages/FollowUps";
import Revenue from "./pages/Revenue";
import JobOrders from "./pages/JobOrders";
import JobOrderDetail from "./pages/JobOrderDetail";
import Candidates from "./pages/Candidates";
import CandidateDetail from "./pages/CandidateDetail";
import Workers from "./pages/Workers";
import WorkerDetail from "./pages/WorkerDetail";
import Assignments from "./pages/Assignments";
import AssignmentDetail from "./pages/AssignmentDetail";
import PayrollRunDetail from "./pages/PayrollRunDetail";
import Compliance from "./pages/Compliance";
import Payroll from "./pages/Payroll";
import Invoices from "./pages/Invoices";
import InvoiceDetail from "./pages/InvoiceDetail";
import Pricing from "./pages/Pricing";
import AgentsCenter from "./pages/AgentsCenter";
import Approvals from "./pages/Approvals";
import AIDashboard from "./pages/AIDashboard";
import Settings from "./pages/Settings";
import Campaigns from "./pages/Campaigns";
import CampaignDetail from "./pages/CampaignDetail";
import CampaignCompanyDetail from "./pages/CampaignCompanyDetail";
import Missions from "./pages/Missions";
import Discovery from "./pages/Discovery";
import ProductionReadiness from "./pages/ProductionReadiness";
import { ClientPortalGate } from "@/components/layout/ClientPortalGate";
import ClientDashboard from "./pages/portal/client/Dashboard";
import ClientJobOrders from "./pages/portal/client/JobOrders";
import ClientJobOrderDetail from "./pages/portal/client/JobOrderDetail";
import ClientWorkers from "./pages/portal/client/Workers";
import ClientAssignments from "./pages/portal/client/Assignments";
import ClientTimeEntries from "./pages/portal/client/TimeEntries";
import ClientIncidents from "./pages/portal/client/Incidents";
import ClientPortalJobRequests from "./pages/portal/client/JobRequests";
import ClientPortalJobRequestDetail from "./pages/portal/client/JobRequestDetail";
import ClientJobRequests from "./pages/ClientJobRequests";
import ClientJobRequestDetail from "./pages/ClientJobRequestDetail";

export const router = createBrowserRouter([
  // F4.9: /sign-in y /sign-up viven FUERA de RequireAuth a propósito —
  // tienen que ser alcanzables sin sesión. Solo se registran cuando
  // Clerk está configurado (VITE_CLERK_PUBLISHABLE_KEY); en dev-bypass
  // no existen, y no hace falta que existan.
  ...(CLERK_CONFIGURED
    ? [
        { path: "/sign-in/*", element: <SignInPage /> },
        { path: "/sign-up/*", element: <SignUpPage /> },
      ]
    : []),
  {
    path: "/",
    element: (
      <RequireAuth>
        <App />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Dashboard /> },
      { path: "companies", element: <Companies /> },
      { path: "companies/:id", element: <CompanyDetail /> },
      { path: "contacts", element: <Contacts /> },
      { path: "leads", element: <Leads /> },
      { path: "leads/:id", element: <LeadDetail /> },
      { path: "pipeline", element: <Pipeline /> },
      { path: "opportunities", element: <Opportunities /> },
      { path: "follow-ups", element: <FollowUps /> },
      { path: "campaigns", element: <Campaigns /> },
      { path: "campaigns/:id", element: <CampaignDetail /> },
      { path: "campaigns/:campaignId/companies/:companyId", element: <CampaignCompanyDetail /> },
      { path: "missions", element: <Missions /> },
      { path: "discovery", element: <Discovery /> },
      { path: "revenue", element: <Revenue /> },
      { path: "job-orders", element: <JobOrders /> },
      { path: "job-orders/:id", element: <JobOrderDetail /> },
      { path: "client-job-requests", element: <ClientJobRequests /> },
      { path: "client-job-requests/:id", element: <ClientJobRequestDetail /> },
      { path: "candidates", element: <Candidates /> },
      { path: "candidates/:id", element: <CandidateDetail /> },
      { path: "workers", element: <Workers /> },
      { path: "workers/:id", element: <WorkerDetail /> },
      { path: "assignments", element: <Assignments /> },
      { path: "assignments/:id", element: <AssignmentDetail /> },
      { path: "compliance", element: <Compliance /> },
      { path: "payroll", element: <Payroll /> },
      { path: "payroll-runs/:id", element: <PayrollRunDetail /> },
      { path: "invoices", element: <Invoices /> },
      { path: "invoices/:id", element: <InvoiceDetail /> },
      { path: "pricing", element: <Pricing /> },
      { path: "agents", element: <AgentsCenter /> },
      { path: "approvals", element: <Approvals /> },
      { path: "ai-dashboard", element: <AIDashboard /> },
      { path: "production-readiness", element: <ProductionReadiness /> },
      { path: "settings", element: <Settings /> },
    ],
  },
  // F10.2: rama de rutas SEPARADA para el Client Portal -- nunca
  // anidada bajo "/" (layout distinguible del backoffice interno,
  // pedido explícito del PO). Worker/Candidate Portal llegan en F10.4
  // con su propio branch simétrico.
  {
    path: "/portal/client",
    element: (
      <RequireAuth>
        <ClientPortalGate />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <ClientDashboard /> },
      { path: "job-requests", element: <ClientPortalJobRequests /> },
      { path: "job-requests/:id", element: <ClientPortalJobRequestDetail /> },
      { path: "job-orders", element: <ClientJobOrders /> },
      { path: "job-orders/:id", element: <ClientJobOrderDetail /> },
      { path: "workers", element: <ClientWorkers /> },
      { path: "assignments", element: <ClientAssignments /> },
      { path: "time-entries", element: <ClientTimeEntries /> },
      { path: "incidents", element: <ClientIncidents /> },
    ],
  },
]);
