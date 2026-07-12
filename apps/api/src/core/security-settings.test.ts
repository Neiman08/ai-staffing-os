import { test } from "node:test";
import assert from "node:assert/strict";
import { isMfaEnforced } from "./security-settings";

test("isMfaEnforced: settings vacío/null → false", () => {
  assert.equal(isMfaEnforced({ settings: {} }), false);
  assert.equal(isMfaEnforced({ settings: null }), false);
});

test("isMfaEnforced: security.mfaEnforced=true → true", () => {
  assert.equal(isMfaEnforced({ settings: { security: { mfaEnforced: true } } }), true);
});

test("isMfaEnforced: security.mfaEnforced=false explícito → false", () => {
  assert.equal(isMfaEnforced({ settings: { security: { mfaEnforced: false } } }), false);
});

test("isMfaEnforced: valor no-booleano nunca se trata como true (nunca inventa un default inseguro)", () => {
  assert.equal(isMfaEnforced({ settings: { security: { mfaEnforced: "true" } } }), false);
  assert.equal(isMfaEnforced({ settings: { security: { mfaEnforced: 1 } } }), false);
});
