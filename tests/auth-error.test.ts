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

test("explains how an invited user should recover from an access rejection", () => {
  assert.equal(
    getAuthErrorMessage(new Error("google account is not allowed for this vault")),
    "This Google account does not have vault access. If you were invited, sign out of Google and use the exact email address on the invitation.",
  );
});
