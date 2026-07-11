import { createBrowserRouter } from "react-router-dom";
import { SiteLayout } from "./components/layout/SiteLayout";
import Home from "./pages/Home";
import Employers from "./pages/Employers";
import Candidates from "./pages/Candidates";
import Industries from "./pages/Industries";
import About from "./pages/About";
import Contact from "./pages/Contact";
import RequestTalent from "./pages/RequestTalent";
import Careers from "./pages/Careers";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <SiteLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: "employers", element: <Employers /> },
      { path: "candidates", element: <Candidates /> },
      { path: "industries", element: <Industries /> },
      { path: "about", element: <About /> },
      { path: "contact", element: <Contact /> },
      { path: "request-talent", element: <RequestTalent /> },
      { path: "careers", element: <Careers /> },
      { path: "privacy", element: <Privacy /> },
      { path: "terms", element: <Terms /> },
      { path: "login", element: <Login /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
