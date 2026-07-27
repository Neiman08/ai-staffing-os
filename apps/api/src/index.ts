import { prisma } from "@ai-staffing-os/db";
import { env } from "./core/env";
import { logger } from "./core/logger";
import { createApp } from "./app";
import { recoverOrphanedTasksAtBoot } from "./core/queue/postgres-queue";
import { startProspectingScheduler, stopProspectingScheduler } from "./modules/agents/scheduler";
import { startComplianceAlertScheduler, stopComplianceAlertScheduler } from "./modules/compliance/scheduler";
import { startBillingOverdueScheduler, stopBillingOverdueScheduler } from "./modules/billing/scheduler";
import { startAutonomousWorkers, stopAutonomousWorkers } from "./modules/agents/orchestrator-scheduler";
import { startEmailReconciliationScheduler, stopEmailReconciliationScheduler } from "./modules/email/scheduler";
import { PIPELINE_FLAGS } from "./core/pipeline-flags";

const app = createApp();

let server: ReturnType<typeof app.listen>;

/**
 * Bug real encontrado en auditoría: recoverOrphanedTasksAtBoot() debe
 * correr exactamente una vez, ANTES de aceptar el primer request --
 * cualquier AgentTask ya en RUNNING/CLAIMED sin lease en este instante
 * es huérfana de un proceso anterior (este proceso todavía no reclamó
 * ni ejecutó nada). Recién después de eso se abre el puerto y arrancan
 * los schedulers, mismo orden que ya usa gracefulShutdown al revés.
 */
async function boot(): Promise<void> {
  const { recoveredTaskIds } = await recoverOrphanedTasksAtBoot();
  if (recoveredTaskIds.length > 0) {
    logger.warn("boot_recovered_orphaned_tasks", { count: recoveredTaskIds.length, taskIds: recoveredTaskIds });
  }

  server = app.listen(env.PORT, () => {
    console.log(`AI Staffing OS API listening on http://localhost:${env.PORT}`);
    startProspectingScheduler();
    startComplianceAlertScheduler();
    startBillingOverdueScheduler();
    startEmailReconciliationScheduler();
    // F25.2 (activación controlada): gateado por PIPELINE_FLAGS.autonomousWorkerEnabled
    // (env AUTONOMOUS_WORKER_ENABLED, default true -- ya verificado inerte
    // en la sesión anterior; PIPELINE_KILL_SWITCH=true lo apaga junto con
    // todo lo demás). Los 3 AgentExecutor registrados
    // (discover_companies/find_contacts/evaluate_draft_quality) nunca
    // envían nada externo -- ver orchestrator-scheduler.ts.
    if (PIPELINE_FLAGS.autonomousWorkerEnabled) {
      startAutonomousWorkers();
    } else {
      logger.info("autonomous_worker_disabled_by_flag", {});
    }
  });
}

void boot();

/**
 * F12.7: cierre ordenado real -- SIGTERM es la señal que Render (y
 * cualquier orquestador de contenedores) manda antes de matar el
 * proceso en un redeploy/restart. Sin esto, un request en vuelo se
 * corta a mitad de camino y los 4 schedulers de setInterval siguen
 * intentando escribir a una conexión de Prisma que puede cerrarse en
 * cualquier momento. Orden: (1) dejar de aceptar conexiones nuevas,
 * (2) parar los timers de los schedulers (5 desde la auditoría de
 * "primera misión real", que agregó el de reconciliación de email),
 * (3) esperar a que los
 * requests en vuelo terminen (server.close ya hace esto), (4) cerrar
 * Prisma, (5) recién ahí salir. Nunca fuerza un exit inmediato salvo
 * que el cierre ordenado tarde más de 10s (tope real, para no colgarse
 * para siempre esperando un request que nunca termina).
 */
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("graceful_shutdown_started", { signal });

  const forceExitTimer = setTimeout(() => {
    logger.error("graceful_shutdown_timeout_forcing_exit", { signal });
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  stopProspectingScheduler();
  stopComplianceAlertScheduler();
  stopBillingOverdueScheduler();
  stopAutonomousWorkers();
  stopEmailReconciliationScheduler();

  // `server` es asignado dentro de boot(), después de un await real
  // (recoverOrphanedTasksAtBoot) -- una señal recibida en esa ventana
  // minúscula (antes de que el puerto llegue a abrirse) todavía no
  // tiene servidor que cerrar; el resto del cierre ordenado sigue igual.
  const closeServer = server ? new Promise<Error | undefined>((resolve) => server.close((err) => resolve(err))) : Promise.resolve(undefined);

  closeServer.then(async (err) => {
    if (err) {
      logger.error("graceful_shutdown_server_close_failed", { message: err.message });
    }
    try {
      await prisma.$disconnect();
      logger.info("graceful_shutdown_complete", { signal });
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (disconnectErr) {
      logger.error("graceful_shutdown_prisma_disconnect_failed", {
        message: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
      });
      process.exit(1);
    }
  });
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

/**
 * F12.7: red de seguridad final -- un error/rejection no atrapado en
 * cualquier otra parte del código (todo lo demás ya se atrapa: rutas
 * vía errorHandler, tareas de agente vía executeTaskById, misiones vía
 * runMissionPipelineAsync/launchMission) nunca debe crashear el proceso
 * en silencio. Se loguea con toda la evidencia real y se intenta un
 * cierre ordenado -- nunca un exit inmediato sin dar tiempo a que las
 * conexiones en vuelo terminen, pero tampoco se sigue sirviendo tráfico
 * nuevo con el proceso en un estado potencialmente inconsistente.
 */
process.on("uncaughtException", (err) => {
  logger.error("uncaught_exception", { message: err.message, stack: err.stack });
  void gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  void gracefulShutdown("unhandledRejection");
});
