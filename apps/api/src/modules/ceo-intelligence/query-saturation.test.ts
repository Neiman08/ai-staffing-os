import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateQuerySaturation, type QuerySaturationSample } from "./query-saturation";

function sample(overrides: Partial<QuerySaturationSample>): QuerySaturationSample {
  return {
    rawResultCount: 20,
    acceptedCount: 0,
    duplicateCount: 20,
    rejectedCount: 0,
    executedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("sin historial -> FRESH, nunca inventa un ratio", () => {
  const result = evaluateQuerySaturation({ samples: [] });
  assert.equal(result.level, "FRESH");
  assert.equal(result.noveltyRatio, null);
  assert.equal(result.shouldSkip, false);
});

// F34: hallazgo real de la auditoría -- 71.9% de discovery duplicado
// (800/1113). Una query con >90% de duplicados acumulados debe quedar
// SATURATED y shouldSkip=true.
test("regresión real: >90% de duplicados acumulados -> SATURATED, shouldSkip=true", () => {
  const result = evaluateQuerySaturation({
    samples: [
      sample({ rawResultCount: 20, acceptedCount: 1, duplicateCount: 19 }),
      sample({ rawResultCount: 20, acceptedCount: 0, duplicateCount: 20 }),
    ],
  });
  assert.equal(result.level, "SATURATED");
  assert.equal(result.shouldSkip, true);
  assert.ok(result.noveltyRatio !== null && result.noveltyRatio < 0.1);
});

// F34: hallazgo real -- 48.4% de las queries no aceptó ni una empresa
// nueva. Dos ejecuciones consecutivas recientes con 0 aceptados deben
// bastar para marcar saturación, incluso con volumen crudo bajo.
test("regresión real: 2 ejecuciones consecutivas recientes con 0 nuevas -> SATURATED, sin importar el volumen crudo", () => {
  const result = evaluateQuerySaturation({
    samples: [sample({ rawResultCount: 3, acceptedCount: 0 }), sample({ rawResultCount: 2, acceptedCount: 0 })],
  });
  assert.equal(result.level, "SATURATED");
  assert.equal(result.consecutiveZeroNewRuns, 2);
  assert.equal(result.shouldSkip, true);
});

test("una sola ejecución reciente con 0 nuevas -- todavía no es SATURATED (se necesita repetición real)", () => {
  const result = evaluateQuerySaturation({ samples: [sample({ rawResultCount: 5, acceptedCount: 0 })] });
  assert.notEqual(result.level, "SATURATED");
  assert.equal(result.consecutiveZeroNewRuns, 1);
});

test("volumen crudo bajo (<10) con una sola corrida de 0 aceptados -- ni el ratio (muestra insuficiente) ni consecutiveZeroNewRuns (1 < 2) disparan SATURATED", () => {
  const result = evaluateQuerySaturation({ samples: [sample({ rawResultCount: 3, acceptedCount: 0, duplicateCount: 0, rejectedCount: 3 })] });
  assert.equal(result.level, "FRESH");
  assert.equal(result.consecutiveZeroNewRuns, 1);
});

test("ratio de novedad saludable -> FRESH", () => {
  const result = evaluateQuerySaturation({
    samples: [sample({ rawResultCount: 20, acceptedCount: 10, duplicateCount: 5, rejectedCount: 5 })],
  });
  assert.equal(result.level, "FRESH");
  assert.equal(result.shouldSkip, false);
  assert.equal(result.shouldDeprioritize, false);
});

test("ratio de novedad intermedio (10%-30%) -> DECLINING, deprioriza pero no omite", () => {
  const result = evaluateQuerySaturation({
    samples: [sample({ rawResultCount: 20, acceptedCount: 4, duplicateCount: 16 })],
  });
  assert.equal(result.level, "DECLINING");
  assert.equal(result.shouldSkip, false);
  assert.equal(result.shouldDeprioritize, true);
});

test("consecutiveZeroNewRuns solo cuenta desde la ejecución MÁS RECIENTE hacia atrás -- se corta en el primer >0", () => {
  const result = evaluateQuerySaturation({
    samples: [
      sample({ rawResultCount: 5, acceptedCount: 0 }),
      sample({ rawResultCount: 5, acceptedCount: 0 }),
      sample({ rawResultCount: 5, acceptedCount: 3 }), // ejecución más vieja tuvo éxito -- no debe contarse
    ],
  });
  assert.equal(result.consecutiveZeroNewRuns, 2);
});

test("determinismo: mismo input siempre produce el mismo resultado", () => {
  const input = { samples: [sample({ rawResultCount: 20, acceptedCount: 1, duplicateCount: 19 })] };
  assert.deepEqual(evaluateQuerySaturation(input), evaluateQuerySaturation(input));
});
