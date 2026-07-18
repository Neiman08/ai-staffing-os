// F11.5: GET /analytics/commercial -- win-rate, duración de ciclo de
// venta, conversión. Field-level por permiso real (opportunities.view
// para winRate/salesCycle, leads.view para conversion.leadConversionRate,
// ambos para conversion.leadToOpportunityRate), mismo criterio F6.8.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Comparison {
  current: number;
  previous: number;
  deltaPercent: number | null;
}

interface CommercialBody {
  generatedAt: string;
  commercial: {
    period?: { from: string; to: string };
    previousPeriod?: { from: string; to: string };
    winRate?: { won: number; lost: number; winRatePercent: number | null };
    salesCycle?: { averageDays: number | null; opportunitiesWon: number };
    conversion?: { leadConversionRate: number | null; leadToOpportunityRate?: number | null };
    comparison?: {
      opportunitiesWon?: Comparison;
      opportunitiesLost?: Comparison;
      leadsCreated?: Comparison;
      leadsConverted?: Comparison;
    };
  };
}

async function fetchCommercial(devUser: string, qs = ""): Promise<{ status: number; body: CommercialBody }> {
  const res = await fetch(`${baseUrl}/api/v1/analytics/commercial${qs}`, { headers: { "x-dev-user": devUser } });
  const body = (await res.json()) as CommercialBody;
  return { status: res.status, body };
}

test("sales@titan.dev (leads.view + opportunities.view): ve winRate, salesCycle y conversion completos", async () => {
  const { status, body } = await fetchCommercial("sales@titan.dev");
  assert.equal(status, 200);
  assert.ok(body.commercial.winRate);
  assert.ok(body.commercial.salesCycle);
  assert.ok(body.commercial.conversion);
  assert.equal(body.commercial.conversion!.leadToOpportunityRate !== undefined, true);

  assert.ok(body.commercial.winRate!.won >= 0);
  assert.ok(body.commercial.winRate!.lost >= 0);
  assert.ok(body.commercial.salesCycle!.opportunitiesWon >= 0);
});

test("recruiter@titan.dev (sin leads.view ni opportunities.view): commercial queda vacío, nunca 403", async () => {
  const { status, body } = await fetchCommercial("recruiter@titan.dev");
  assert.equal(status, 200);
  assert.deepEqual(body.commercial, {});
});

test("winRatePercent: coherente con won/lost (won + lost = total cerrado, porcentaje entre 0 y 100)", async () => {
  const { body } = await fetchCommercial("sales@titan.dev");
  const wr = body.commercial.winRate!;
  if (wr.won + wr.lost > 0) {
    assert.ok(wr.winRatePercent !== null);
    assert.ok(wr.winRatePercent! >= 0 && wr.winRatePercent! <= 100);
    assert.equal(wr.winRatePercent, Number(((wr.won / (wr.won + wr.lost)) * 100).toFixed(1)));
  } else {
    assert.equal(wr.winRatePercent, null);
  }
});

test("filtro from/to real: rango sin ninguna Opportunity/Lead real -> ceros/null, nunca error", async () => {
  const { status, body } = await fetchCommercial("sales@titan.dev", "?from=2010-01-01&to=2010-01-02");
  assert.equal(status, 200);
  assert.deepEqual(body.commercial.winRate, { won: 0, lost: 0, winRatePercent: null });
  assert.deepEqual(body.commercial.salesCycle, { averageDays: null, opportunitiesWon: 0 });
  assert.equal(body.commercial.conversion!.leadConversionRate, null);
});

test("ninguna identidad de portal puede alcanzar /analytics/commercial", async () => {
  for (const devUser of ["worker-portal@titan.dev", "candidate-portal@titan.dev", "client-admin@titan.dev"]) {
    const { status } = await fetchCommercial(devUser);
    assert.equal(status, 403, `${devUser} debería recibir 403`);
  }
});

test("query inválida (to no-fecha) devuelve 400, no 500", async () => {
  const res = await fetch(`${baseUrl}/api/v1/analytics/commercial?to=not-a-date`, {
    headers: { "x-dev-user": "sales@titan.dev" },
  });
  assert.equal(res.status, 400);
});

test("F11.7: comparison.opportunitiesWon/Lost coinciden con winRate, previousPeriod es la ventana anterior real", async () => {
  const { body } = await fetchCommercial("sales@titan.dev", "?from=2026-01-01&to=2026-01-31");
  assert.deepEqual(body.commercial.previousPeriod, { from: "2025-12-02T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" });

  const cmp = body.commercial.comparison!;
  assert.equal(cmp.opportunitiesWon!.current, body.commercial.winRate!.won);
  assert.equal(cmp.opportunitiesLost!.current, body.commercial.winRate!.lost);
  assert.ok(cmp.leadsCreated!.current >= 0);
  assert.ok(cmp.leadsConverted!.current >= 0);
});

test("F11.7: recruiter@titan.dev (sin comercial): comparison ausente por completo, no un objeto vacío con 403", async () => {
  const { status, body } = await fetchCommercial("recruiter@titan.dev");
  assert.equal(status, 200);
  assert.equal(body.commercial.comparison, undefined);
});
