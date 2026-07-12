import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusScreen } from "./StatusScreen";
import { CLERK_CONFIGURED } from "@/lib/auth-config";

export function Unauthorized() {
  return (
    <StatusScreen
      icon={<LockKeyhole className="h-10 w-10 text-muted-foreground" />}
      title="Session required"
      description="You need to sign in to access this application."
      action={
        CLERK_CONFIGURED ? (
          <Button onClick={() => (window.location.href = "/sign-in")}>Go to sign in</Button>
        ) : undefined
      }
    />
  );
}
