import { test } from "node:test";
import assert from "node:assert/strict";
import { comparePeriods, percentDelta, previousPeriod, resolvePeriod, toResolvedPeriod } from "./period";

test("resolvePeriod: sin from/to, aplica el default en días hacia atrás desde ahora", () => {
  const before = Date.now();
  const range = resolvePeriod({}, 7);
  const after = Date.now();

  assert.ok(range.to.getTime() >= before && range.to.getTime() <= after);
  const expectedFrom = range.to.getTime() - 7 * 24 * 60 * 60 * 1000;
  assert.equal(range.from.getTime(), expectedFrom);
});

test("resolvePeriod: con from/to explícitos, los respeta sin aplicar ningún default", () => {
  const from = new Date("2026-01-01T00:00:00.000Z");
  const to = new Date("2026-01-15T00:00:00.000Z");
  const range = resolvePeriod({ from, to }, 30);

  assert.equal(range.from.getTime(), from.getTime());
  assert.equal(range.to.getTime(), to.getTime());
});

test("previousPeriod: devuelve una ventana de la misma duración, inmediatamente anterior", () => {
  const from = new Date("2026-02-08T00:00:00.000Z");
  const to = new Date("2026-02-15T00:00:00.000Z"); // 7 días
  const prev = previousPeriod({ from, to });

  assert.equal(prev.to.getTime(), from.getTime());
  assert.equal(prev.from.getTime(), from.getTime() - 7 * 24 * 60 * 60 * 1000);
});

test("percentDelta: caso normal, redondeado a 2 decimales", () => {
  assert.equal(percentDelta(150, 100), 50);
  assert.equal(percentDelta(50, 100), -50);
  assert.equal(percentDelta(110, 90), 22.22);
});

test("percentDelta: previous=0, current=0 -> 0% real (no null)", () => {
  assert.equal(percentDelta(0, 0), 0);
});

test("percentDelta: previous=0, current>0 -> null (sin base real para un porcentaje)", () => {
  assert.equal(percentDelta(10, 0), null);
});

test("comparePeriods: empaqueta current/previous/deltaPercent juntos", () => {
  assert.deepEqual(comparePeriods(150, 100), { current: 150, previous: 100, deltaPercent: 50 });
  assert.deepEqual(comparePeriods(5, 0), { current: 5, previous: 0, deltaPercent: null });
});

test("toResolvedPeriod: serializa a ISO strings", () => {
  const from = new Date("2026-01-01T00:00:00.000Z");
  const to = new Date("2026-01-08T00:00:00.000Z");
  assert.deepEqual(toResolvedPeriod({ from, to }), {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-08T00:00:00.000Z",
  });
});
