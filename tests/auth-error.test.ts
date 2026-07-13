import assert from "node:assert/strict";
import test from "node:test";
import { getAuthErrorMessage } from "../src/lib/auth-error.ts";

test("shows the Gonvex rejection instead of erasing it", () => {
  assert.equal(
    getAuthErrorMessage(new Error("google token audience mismatch")),
    "Google token audience mismatch.",
  );
});

test("falls back when the rejection is empty", () => {
  assert.equal(getAuthErrorMessage(null), "Google login was rejected. Try again.");
});
