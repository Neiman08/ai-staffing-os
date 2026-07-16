import { test } from "node:test";
import assert from "node:assert/strict";
import { doDateRangesOverlap } from "./date-overlap";

const d = (s: string) => new Date(s);

test("rangos sin solapamiento (A termina antes de que empiece B)", () => {
  assert.equal(doDateRangesOverlap(d("2026-01-01"), d("2026-01-10"), d("2026-02-01"), d("2026-02-10")), false);
});

test("rangos sin solapamiento (B termina antes de que empiece A)", () => {
  assert.equal(doDateRangesOverlap(d("2026-02-01"), d("2026-02-10"), d("2026-01-01"), d("2026-01-10")), false);
});

test("rangos con solapamiento parcial", () => {
  assert.equal(doDateRangesOverlap(d("2026-01-05"), d("2026-01-20"), d("2026-01-01"), d("2026-01-10")), true);
});

test("un rango contiene completamente al otro", () => {
  assert.equal(doDateRangesOverlap(d("2026-01-01"), d("2026-01-31"), d("2026-01-10"), d("2026-01-20")), true);
});

test("mismo día exacto (ambos rangos de un solo día, coincidentes)", () => {
  assert.equal(doDateRangesOverlap(d("2026-01-15"), d("2026-01-15"), d("2026-01-15"), d("2026-01-15")), true);
});

test("límite exacto: A.endDate === B.startDate (inclusive, debe solapar)", () => {
  assert.equal(doDateRangesOverlap(d("2026-01-01"), d("2026-01-10"), d("2026-01-10"), d("2026-01-20")), true);
});

test("límite exacto: A.startDate === B.endDate (inclusive, debe solapar)", () => {
  assert.equal(doDateRangesOverlap(d("2026-01-20"), d("2026-01-30"), d("2026-01-10"), d("2026-01-20")), true);
});

test("justo fuera del límite: A empieza 1ms después de que termina B → no solapa", () => {
  const bEnd = d("2026-01-10");
  const aStart = new Date(bEnd.getTime() + 1);
  assert.equal(doDateRangesOverlap(aStart, d("2026-01-20"), d("2026-01-01"), bEnd), false);
});

test("Job Order sin endDate (B abierto): A sin endDate también → siempre solapa", () => {
  assert.equal(doDateRangesOverlap(d("2026-01-01"), null, d("2026-06-01"), null), true);
});

test("Job Order sin endDate: A termina antes del startDate del Job Order → no solapa", () => {
  assert.equal(doDateRangesOverlap(d("2026-01-01"), d("2026-01-10"), d("2026-06-01"), null), false);
});

test("Job Order sin endDate: A termina en/tras el startDate del Job Order → solapa", () => {
  assert.equal(doDateRangesOverlap(d("2026-01-01"), d("2026-06-01"), d("2026-06-01"), null), true);
  assert.equal(doDateRangesOverlap(d("2026-01-01"), d("2026-12-01"), d("2026-06-01"), null), true);
});

test("Assignment sin endDate (A abierto): bloquea un Job Order cuyo endDate es en/tras el startDate de A", () => {
  assert.equal(doDateRangesOverlap(d("2026-06-01"), null, d("2026-01-01"), d("2026-06-01")), true);
  assert.equal(doDateRangesOverlap(d("2026-06-01"), null, d("2026-01-01"), d("2026-12-01")), true);
});

test("Assignment sin endDate: NO bloquea si el Job Order termina antes de que empiece la Assignment", () => {
  assert.equal(doDateRangesOverlap(d("2026-06-01"), null, d("2026-01-01"), d("2026-05-31")), false);
});

test("Assignment sin endDate y Job Order sin endDate → siempre solapa (ambos abiertos)", () => {
  assert.equal(doDateRangesOverlap(d("2026-01-01"), null, d("2026-12-31"), null), true);
  assert.equal(doDateRangesOverlap(d("2026-12-31"), null, d("2026-01-01"), null), true);
});
