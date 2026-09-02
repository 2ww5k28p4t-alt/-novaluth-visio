import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateProtectedOrderCommissionCents,
  PROTECTED_ORDER_COMMISSION_CAP_CENTS,
  PROTECTED_ORDER_COMMITMENT_FEE_CENTS,
} from "./novaluth-orders";

test("protected order engagement fee stays fixed at 29 euros", () => {
  assert.equal(PROTECTED_ORDER_COMMITMENT_FEE_CENTS, 2_900);
});

test("protected order commission is 2 percent below the cap", () => {
  assert.equal(calculateProtectedOrderCommissionCents(100_000), 2_000);
});

test("protected order commission never exceeds the 149 euro cap", () => {
  assert.equal(
    calculateProtectedOrderCommissionCents(2_000_000),
    PROTECTED_ORDER_COMMISSION_CAP_CENTS,
  );
});