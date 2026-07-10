/**
 * Bugfix de ciclo de vida (misiones atascadas en RUNNING): registro en
 * memoria de un AbortController por AgentTask en ejecución. task-executor
 * registra uno antes de correr cualquier tarea y lo limpia al terminar;
 * cualquier tool que haga una llamada de red real (hoy, solo
 * discoverCompaniesTool) puede tomar su señal vía getAbortSignal(taskId) y
 * pasarla a fetch — así "Cancelar" aborta la llamada HTTP en vuelo de
 * verdad, no solo cambia una etiqueta en la UI.
 *
 * Limitación consciente de un solo proceso Node (mismo trade-off que el
 * scheduler in-process, F3 §6) — no sobrevive un restart, pero tampoco
 * necesita hacerlo: si el proceso reinicia, no hay ninguna llamada en
 * vuelo que abortar.
 */
const controllers = new Map<string, AbortController>();

export function registerAbortController(taskId: string): AbortController {
  const controller = new AbortController();
  controllers.set(taskId, controller);
  return controller;
}

export function getAbortSignal(taskId: string): AbortSignal | undefined {
  return controllers.get(taskId)?.signal;
}

/** true si había una tarea en vuelo y se le mandó abort; false si no había nada que abortar. */
export function abortTask(taskId: string, reason: string): boolean {
  const controller = controllers.get(taskId);
  if (!controller || controller.signal.aborted) return false;
  controller.abort(reason);
  return true;
}

export function clearAbortController(taskId: string): void {
  controllers.delete(taskId);
}
