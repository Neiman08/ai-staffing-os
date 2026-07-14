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
import Compliance from "./pages/Compliance";
import Payroll from "./pages/Payroll";
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
      { path: "candidates", element: <Candidates /> },
      { path: "compliance", element: <Compliance /> },
      { path: "payroll", element: <Payroll /> },
      { path: "pricing", element: <Pricing /> },
      { path: "agents", element: <AgentsCenter /> },
      { path: "approvals", element: <Approvals /> },
      { path: "ai-dashboard", element: <AIDashboard /> },
      { path: "production-readiness", element: <ProductionReadiness /> },
      { path: "settings", element: <Settings /> },
    ],
  },
]);
