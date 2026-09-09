import assert from "node:assert/strict";
import test from "node:test";
import { canAccess, newRole, resourceSummary } from "../src/lib/access.ts";

test("new roles grant no resources until selected", () => {
  const role = newRole();
  assert.equal(canAccess(role, "skills:read", "skill-1"), false);
  assert.equal(canAccess(role, "credentials:read", "secret-1"), false);
  assert.equal(canAccess(undefined, "skills:read", "skill-1"), false);
});
test("selected grants do not include future resources or write access", () => {
  const role = { ...newRole(), skill_ids: ["skill-1"] };
  assert.equal(canAccess(role, "skills:read", "skill-1"), true);
  assert.equal(canAccess(role, "skills:read", "skill-2"), false);
  assert.equal(canAccess(role, "skills:write", "skill-1"), false);
  assert.equal(canAccess(role, "skills:write"), false);
  assert.equal(resourceSummary(role, "skills"), "1 skill · read only");
});
test("all-resource access still needs the operation permission", () => {
  const role = { ...newRole(), all_skills: true, all_credentials: true };
  assert.equal(canAccess(role, "skills:read", "future-skill"), true);
  assert.equal(canAccess(role, "skills:write", "future-skill"), false);
  assert.equal(canAccess(role, "credentials:read", "future-secret"), false);
});
