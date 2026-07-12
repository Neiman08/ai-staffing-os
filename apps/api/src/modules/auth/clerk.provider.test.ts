import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveMfaVerified } from "./clerk.provider";

test("deriveMfaVerified: sin sessionClaims → false", () => {
  assert.equal(deriveMfaVerified(undefined), false);
  assert.equal(deriveMfaVerified(null), false);
});

test("deriveMfaVerified: sin claim fva → false (nunca asume verificado)", () => {
  assert.equal(deriveMfaVerified({}), false);
});

test("deriveMfaVerified: fva con segundo factor en -1 (nunca verificado en esta sesión) → false", () => {
  assert.equal(deriveMfaVerified({ fva: [5, -1] }), false);
});

test("deriveMfaVerified: fva con segundo factor verificado (edad >= 0) → true", () => {
  assert.equal(deriveMfaVerified({ fva: [5, 0] }), true);
  assert.equal(deriveMfaVerified({ fva: [5, 12] }), true);
});

test("deriveMfaVerified: fva mal formado (no es array de 2) → false", () => {
  assert.equal(deriveMfaVerified({ fva: "not-an-array" }), false);
  assert.equal(deriveMfaVerified({ fva: [5] }), false);
});
