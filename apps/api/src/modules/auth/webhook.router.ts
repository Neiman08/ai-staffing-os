import { Router, raw } from "express";
import { verifyWebhook } from "@clerk/express/webhooks";
import { env } from "../../core/env";
import {
  handleUserCreated,
  handleUserUpdated,
  handleUserDeleted,
  handleOrganizationCreatedOrUpdated,
  handleOrganizationMembershipUpsert,
  handleOrganizationMembershipDeleted,
} from "./webhook-handlers";

export const authWebhookRouter = Router();

/**
 * F4.9: raw body (Buffer) requerido para que verifyWebhook pueda
 * recalcular la firma svix — se monta ANTES del express.json() global
 * en app.ts, mismo principio que ya aplica el publicRouter de F4.8
 * (orden de middleware importa). Nunca procesa un evento sin firma
 * válida: verifyWebhook lanza si la firma no coincide, y ese throw cae
 * directo al catch de abajo → 400, ningún handler se ejecuta.
 */
authWebhookRouter.post("/webhook", raw({ type: "application/json" }), async (req, res) => {
  let evt;
  try {
    evt = await verifyWebhook(req, { signingSecret: env.CLERK_WEBHOOK_SECRET });
  } catch (err) {
    console.error("Clerk webhook signature verification failed:", err);
    res.status(400).json({ error: { code: "INVALID_SIGNATURE", message: "Webhook verification failed" } });
    return;
  }

  try {
    switch (evt.type) {
      case "user.created":
        await handleUserCreated(evt.data);
        break;
      case "user.updated":
        await handleUserUpdated(evt.data);
        break;
      case "user.deleted":
        await handleUserDeleted(evt.data);
        break;
      case "organization.created":
      case "organization.updated":
        await handleOrganizationCreatedOrUpdated(evt.data);
        break;
      case "organizationMembership.created":
      case "organizationMembership.updated":
        await handleOrganizationMembershipUpsert(evt.data);
        break;
      case "organizationMembership.deleted":
        await handleOrganizationMembershipDeleted(evt.data);
        break;
      default:
        // Evento con firma válida pero que no nos suscribimos a manejar
        // (el dashboard de Clerk puede mandar más de los 8 configurados
        // si se agregan tipos nuevos ahí) — se acusa recibo igual, nunca
        // se rechaza un webhook legítimo solo por no tener handler.
        break;
    }
    res.status(200).json({ received: true });
  } catch (err) {
    // Falla de nuestro lado (DB, etc.) — devolver 500 para que Clerk
    // reintente; los handlers son idempotentes (§ webhook-handlers.ts).
    console.error(`Clerk webhook handler failed for event ${evt.type}:`, err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to process webhook" } });
  }
});
