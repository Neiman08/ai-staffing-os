import { env } from "./core/env";
import { createApp } from "./app";
import { startProspectingScheduler } from "./modules/agents/scheduler";
import { startComplianceAlertScheduler } from "./modules/compliance/scheduler";
import { startBillingOverdueScheduler } from "./modules/billing/scheduler";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`AI Staffing OS API listening on http://localhost:${env.PORT}`);
  startProspectingScheduler();
  startComplianceAlertScheduler();
  startBillingOverdueScheduler();
});
