import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateWorkerAvailability, type WorkerAvailabilityInput, type AssignmentForAvailability } from "./availability";
import { workerAvailabilityResultSchema } from "@ai-staffing-os/shared";

const d = (s: string) => new Date(s);

function baseInput(overrides: Partial<WorkerAvailabilityInput> = {}): WorkerAvailabilityInput {
  return {
    workerId: "worker-x",
    workerStatus: "AVAILABLE",
    assignments: [],
    jobOrderStartDate: d("2026-07-01"),
    jobOrderEndDate: d("2026-12-31"),
    ...overrides,
  };
}

function assignment(overrides: Partial<AssignmentForAvailability> = {}): AssignmentForAvailability {
  return { id: "a1", status: "ACTIVE", startDate: d("2026-01-01"), endDate: null, ...overrides };
}

test("Worker TERMINATED → INELIGIBLE / WORKER_UNAVAILABLE, con reason claro, sin calcular solapamientos", () => {
  const result = evaluateWorkerAvailability(
    baseInput({ workerStatus: "TERMINATED", assignments: [assignment({ status: "ACTIVE", endDate: null })] }),
  );
  assert.equal(result.availabilityStatus, "WORKER_UNAVAILABLE");
  assert.equal(result.eligibility, "INELIGIBLE");
  assert.equal(result.hasDateConflict, false);
  assert.deepEqual(result.conflictingAssignmentIds, []);
  assert.match(result.reason, /TERMINATED/);
});

test("Worker ON_LEAVE → INELIGIBLE / WORKER_UNAVAILABLE, sin calcular solapamientos", () => {
  const result = evaluateWorkerAvailability(
    baseInput({ workerStatus: "ON_LEAVE", assignments: [assignment({ status: "ACTIVE", endDate: null })] }),
  );
  assert.equal(result.availabilityStatus, "WORKER_UNAVAILABLE");
  assert.equal(result.eligibility, "INELIGIBLE");
  assert.match(result.reason, /ON_LEAVE/);
});

test("Worker AVAILABLE sin assignments → ELIGIBLE / AVAILABLE", () => {
  const result = evaluateWorkerAvailability(baseInput({ workerStatus: "AVAILABLE", assignments: [] }));
  assert.equal(result.availabilityStatus, "AVAILABLE");
  assert.equal(result.eligibility, "ELIGIBLE");
  assert.equal(result.hasDateConflict, false);
});

test("Worker AVAILABLE con Assignment COMPLETED que se solaparía por fechas → no bloquea", () => {
  const result = evaluateWorkerAvailability(
    baseInput({
      workerStatus: "AVAILABLE",
      assignments: [assignment({ status: "COMPLETED", startDate: d("2026-07-01"), endDate: d("2026-12-31") })],
    }),
  );
  assert.equal(result.availabilityStatus, "AVAILABLE");
  assert.equal(result.eligibility, "ELIGIBLE");
});

test("Worker AVAILABLE con Assignment TERMINATED que se solaparía por fechas → no bloquea", () => {
  const result = evaluateWorkerAvailability(
    baseInput({
      workerStatus: "AVAILABLE",
      assignments: [assignment({ status: "TERMINATED", startDate: d("2026-07-01"), endDate: d("2026-12-31") })],
    }),
  );
  assert.equal(result.availabilityStatus, "AVAILABLE");
  assert.equal(result.eligibility, "ELIGIBLE");
});

test("Worker AVAILABLE con Assignment SCHEDULED sin conflicto de fechas → ELIGIBLE", () => {
  const result = evaluateWorkerAvailability(
    baseInput({
      workerStatus: "AVAILABLE",
      assignments: [assignment({ status: "SCHEDULED", startDate: d("2025-01-01"), endDate: d("2025-06-30") })],
    }),
  );
  assert.equal(result.availabilityStatus, "AVAILABLE");
  assert.equal(result.eligibility, "ELIGIBLE");
});

test("Worker AVAILABLE con Assignment SCHEDULED con conflicto de fechas → DATE_CONFLICT / INELIGIBLE", () => {
  const result = evaluateWorkerAvailability(
    baseInput({
      workerStatus: "AVAILABLE",
      assignments: [assignment({ id: "a-conflict", status: "SCHEDULED", startDate: d("2026-08-01"), endDate: d("2026-09-01") })],
    }),
  );
  assert.equal(result.availabilityStatus, "DATE_CONFLICT");
  assert.equal(result.eligibility, "INELIGIBLE");
  assert.equal(result.hasDateConflict, true);
  assert.deepEqual(result.conflictingAssignmentIds, ["a-conflict"]);
});

test("F10 fase previa (deuda de F9.5): Worker AVAILABLE con Assignment PAUSED con conflicto de fechas → DATE_CONFLICT / INELIGIBLE (PAUSED sigue ocupando cupo real)", () => {
  const result = evaluateWorkerAvailability(
    baseInput({
      workerStatus: "AVAILABLE",
      assignments: [assignment({ id: "a-paused-conflict", status: "PAUSED", startDate: d("2026-08-01"), endDate: d("2026-09-01") })],
    }),
  );
  assert.equal(result.availabilityStatus, "DATE_CONFLICT");
  assert.equal(result.eligibility, "INELIGIBLE");
  assert.deepEqual(result.conflictingAssignmentIds, ["a-paused-conflict"]);
});

test("Worker ASSIGNED sin conflicto de fechas → ELIGIBLE (ASSIGNED no es automáticamente inelegible)", () => {
  const result = evaluateWorkerAvailability(
    baseInput({
      workerStatus: "ASSIGNED",
      assignments: [assignment({ status: "ACTIVE", startDate: d("2025-01-01"), endDate: d("2025-06-30") })],
    }),
  );
  assert.equal(result.availabilityStatus, "AVAILABLE");
  assert.equal(result.eligibility, "ELIGIBLE");
});

test("Worker ASSIGNED con conflicto de fechas → DATE_CONFLICT / INELIGIBLE", () => {
  const result = evaluateWorkerAvailability(
    baseInput({
      workerStatus: "ASSIGNED",
      assignments: [assignment({ id: "a-conflict", status: "ACTIVE", startDate: d("2026-01-01"), endDate: null })],
    }),
  );
  assert.equal(result.availabilityStatus, "DATE_CONFLICT");
  assert.equal(result.eligibility, "INELIGIBLE");
  assert.deepEqual(result.conflictingAssignmentIds, ["a-conflict"]);
});

test("múltiples assignments, una conflictiva → reporta solo la conflictiva", () => {
  const result = evaluateWorkerAvailability(
    baseInput({
      workerStatus: "ASSIGNED",
      assignments: [
        assignment({ id: "a-ok-1", status: "COMPLETED", startDate: d("2026-07-01"), endDate: d("2026-12-31") }),
        assignment({ id: "a-ok-2", status: "SCHEDULED", startDate: d("2025-01-01"), endDate: d("2025-02-01") }),
        assignment({ id: "a-conflict", status: "ACTIVE", startDate: d("2026-08-01"), endDate: d("2026-09-01") }),
      ],
    }),
  );
  assert.equal(result.availabilityStatus, "DATE_CONFLICT");
  assert.deepEqual(result.conflictingAssignmentIds, ["a-conflict"]);
});

test("múltiples assignments, ninguna conflictiva → ELIGIBLE", () => {
  const result = evaluateWorkerAvailability(
    baseInput({
      workerStatus: "ASSIGNED",
      assignments: [
        assignment({ id: "a-1", status: "COMPLETED", startDate: d("2026-07-01"), endDate: d("2026-12-31") }),
        assignment({ id: "a-2", status: "SCHEDULED", startDate: d("2025-01-01"), endDate: d("2025-02-01") }),
        assignment({ id: "a-3", status: "TERMINATED", startDate: d("2026-08-01"), endDate: d("2026-09-01") }),
      ],
    }),
  );
  assert.equal(result.availabilityStatus, "AVAILABLE");
  assert.equal(result.eligibility, "ELIGIBLE");
  assert.deepEqual(result.conflictingAssignmentIds, []);
});

test("WorkerStatus no reconocido → UNKNOWN / REVIEW_REQUIRED con warning, nunca se asume disponible", () => {
  const result = evaluateWorkerAvailability(baseInput({ workerStatus: "SOMETHING_NEW" }));
  assert.equal(result.availabilityStatus, "UNKNOWN");
  assert.equal(result.eligibility, "REVIEW_REQUIRED");
  assert.ok(result.warnings.length > 0);
});

test("evaluatedJobOrderStart/End reflejan exactamente las fechas evaluadas (ISO)", () => {
  const result = evaluateWorkerAvailability(baseInput({ jobOrderStartDate: d("2026-07-01"), jobOrderEndDate: null }));
  assert.equal(result.evaluatedJobOrderStart, d("2026-07-01").toISOString());
  assert.equal(result.evaluatedJobOrderEnd, null);
});

test("reason nunca está vacío en ningún caso", () => {
  const cases: WorkerAvailabilityInput[] = [
    baseInput({ workerStatus: "TERMINATED" }),
    baseInput({ workerStatus: "ON_LEAVE" }),
    baseInput({ workerStatus: "AVAILABLE" }),
    baseInput({ workerStatus: "ASSIGNED", assignments: [assignment({ status: "ACTIVE", startDate: d("2026-08-01") })] }),
    baseInput({ workerStatus: "UNKNOWN_XYZ" }),
  ];
  for (const c of cases) assert.ok(evaluateWorkerAvailability(c).reason.length > 0);
});

test("el resultado de evaluateWorkerAvailability siempre es válido contra workerAvailabilityResultSchema", () => {
  const cases: WorkerAvailabilityInput[] = [
    baseInput({ workerStatus: "TERMINATED" }),
    baseInput({ workerStatus: "ON_LEAVE" }),
    baseInput({ workerStatus: "AVAILABLE" }),
    baseInput({ workerStatus: "ASSIGNED", assignments: [assignment({ status: "ACTIVE", startDate: d("2026-08-01") })] }),
  ];
  for (const c of cases) {
    const result = evaluateWorkerAvailability(c);
    const parsed = workerAvailabilityResultSchema.safeParse(result);
    assert.equal(parsed.success, true, JSON.stringify(parsed.success === false ? parsed.error.issues : null));
  }
});
