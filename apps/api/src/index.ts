import { env } from "./core/env";
import { createApp } from "./app";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`AI Staffing OS API listening on http://localhost:${env.PORT}`);
});
