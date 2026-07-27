import { test } from "node:test";
import assert from "node:assert/strict";
import { searchGooglePlaces } from "./google-places";

/**
 * Bug real encontrado en auditoría de "primera misión real":
 * searchGooglePlaces cobraba TEXT_SEARCH_COST_PER_REQUEST_USD incluso
 * cuando la cancelación ocurría ANTES de cualquier `fetch` real (el
 * chequeo `isCancellation` corre al inicio del loop, antes de pegarle a
 * la API) -- inflaba el gasto real registrado sin ningún request real
 * detrás. Con la señal ya abortada antes de llamar, nunca se llega a
 * invocar `fetch` -- esta prueba no necesita mockearlo.
 */
test("searchGooglePlaces: cancelación previa a cualquier fetch nunca cobra costUsd", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await searchGooglePlaces(
    {
      taskId: "test-task",
      industryName: "Manufacturing",
      stateCode: "IL",
      stateName: "Illinois",
      limit: 5,
      abortSignal: controller.signal,
    },
    "fake-api-key",
  );

  assert.equal(result.cancelled, true);
  assert.equal(result.costUsd, 0, "una cancelación sin ningún fetch real nunca debe cobrar costUsd");
  assert.equal(result.candidates.length, 0);
});
