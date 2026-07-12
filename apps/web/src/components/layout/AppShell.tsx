import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { DevBanner } from "@/components/layout/DevBanner";
import { useBranding, useDocumentTitleFromBranding } from "@/lib/branding";

export function AppShell() {
  const { data: branding } = useBranding();
  useDocumentTitleFromBranding(branding?.brandName);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background">
      <DevBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar brandName={branding?.brandName} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="flex-1 overflow-y-auto p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
