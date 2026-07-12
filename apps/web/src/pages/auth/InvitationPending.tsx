import { MailQuestion } from "lucide-react";
import { StatusScreen } from "./StatusScreen";

export function InvitationPending() {
  return (
    <StatusScreen
      icon={<MailQuestion className="h-10 w-10 text-muted-foreground" />}
      title="Invitation not linked yet"
      description="Your Clerk account isn't linked to an active invitation in this organization. If you were just invited, ask an admin to confirm the invite was sent to this exact email address."
    />
  );
}
