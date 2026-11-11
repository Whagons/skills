import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export const ORIGIN = "https://vault.test";
export const ADMIN_TOKEN = "test-admin-token-0123456789abcdef0123456789abcdef";
export const OWNER_EMAIL = "owner@fixtures.invalid";

export type CallOutcome = { status: number; result?: any; error?: string };

// Mirrors the CLI and UI: credentials go in the Authorization header, the
// remaining arguments in the JSON body.
export async function call(path: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<CallOutcome> {
  const { sessionToken, apiKey, ...body } = args;
  const token = (path.startsWith("agent.") ? apiKey : sessionToken) ?? apiKey ?? sessionToken;
  const response = await SELF.fetch(`${ORIGIN}/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${String(token)}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as { result?: unknown; error?: string };
  return { status: response.status, ...parsed };
}

export async function ok<T = any>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  const outcome = await call(path, args);
  if (outcome.error !== undefined) throw new Error(`${path} failed: ${outcome.error}`);
  return outcome.result as T;
}

export async function fails(path: string, args: Record<string, unknown>, pattern?: RegExp | string): Promise<CallOutcome> {
  const outcome = await call(path, args);
  expect(outcome.error, `${path} should fail`).toBeTypeOf("string");
  if (pattern) expect(outcome.error).toMatch(pattern);
  return outcome;
}

export async function login(email: string, sub: string): Promise<{ sessionToken: string; is_owner: boolean; pending_only: boolean }> {
  return ok("auth.login", { idToken: `fake|${sub}|${email}` });
}

export async function admin(op: string, init: { method?: string; body?: unknown; query?: string; token?: string } = {}) {
  const response = await SELF.fetch(`${ORIGIN}/admin/${op}${init.query ?? ""}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { Authorization: `Bearer ${init.token ?? ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

// Owner + one invited member (Full access) in the owner's workspace.
export async function team() {
  const owner = await login(OWNER_EMAIL, "100");
  expect(owner.is_owner).toBe(true);
  const ownerMe = await ok("auth.me", { sessionToken: owner.sessionToken });
  const invite = await ok("team.invite", { sessionToken: owner.sessionToken, email: "Member@Fixtures.invalid", role_id: "full" });
  const pending = await login("member@fixtures.invalid", "200");
  expect(pending.pending_only).toBe(true);
  await ok("team.invitations.accept", { sessionToken: pending.sessionToken, id: invite.id });
  return { owner: owner.sessionToken, member: pending.sessionToken, workspace: ownerMe.workspace_id as string, inviteID: invite.id as string };
}

export async function membershipID(ownerToken: string, email: string): Promise<string> {
  const people = await ok<Array<{ id: string; email: string; status: string }>>("team.list", { sessionToken: ownerToken });
  const person = people.find((row) => row.email === email && row.status === "active");
  if (!person) throw new Error(`no active member ${email}`);
  return person.id;
}
