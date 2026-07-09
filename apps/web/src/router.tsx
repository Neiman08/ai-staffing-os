import { createBrowserRouter } from "react-router-dom";
import App from "./App";
import Dashboard from "./pages/Dashboard";
import Companies from "./pages/Companies";
import JobOrders from "./pages/JobOrders";
import Candidates from "./pages/Candidates";
import Compliance from "./pages/Compliance";
import Payroll from "./pages/Payroll";
import Pricing from "./pages/Pricing";
import AgentsCenter from "./pages/AgentsCenter";
import Settings from "./pages/Settings";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "companies", element: <Companies /> },
      { path: "job-orders", element: <JobOrders /> },
      { path: "candidates", element: <Candidates /> },
      { path: "compliance", element: <Compliance /> },
      { path: "payroll", element: <Payroll /> },
      { path: "pricing", element: <Pricing /> },
      { path: "agents", element: <AgentsCenter /> },
      { path: "settings", element: <Settings /> },
    ],
  },
]);
