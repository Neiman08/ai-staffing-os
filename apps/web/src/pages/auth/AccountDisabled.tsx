import { UserX } from "lucide-react";
import { StatusScreen } from "./StatusScreen";

export function AccountDisabled() {
  return (
    <StatusScreen
      icon={<UserX className="h-10 w-10 text-destructive" />}
      title="Account disabled"
      description="Your account has been deactivated. Contact your administrator to restore access."
    />
  );
}
