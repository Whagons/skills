// Generates a synthetic Gonvex Postgres export for migration tests. Every
// value is fake: fixture emails use the reserved .invalid TLD, secrets are
// random, and credentials are encrypted with a throwaway key in the same
// formats the Go backend produces (encv2 with AAD, legacy encv1, plaintext).
// Works in Node and in workerd (WebCrypto only).

import { GONVEX_EXPORT_FORMAT } from "./lib.mjs";

const enc = new TextEncoder();

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64raw(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("=", "");
}
function b64url(bytes) {
  return b64raw(bytes).replaceAll("+", "-").replaceAll("/", "_");
}
function random(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}
async function sha256(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}
function hexToBytes(text) {
  return Uint8Array.from(text.match(/../g).map((h) => parseInt(h, 16)));
}

async function seal(keyHex, plaintext, aad) {
  const raw = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const nonce = random(12);
  const params = aad ? { name: "AES-GCM", iv: nonce, additionalData: enc.encode(aad) } : { name: "AES-GCM", iv: nonce };
  const sealed = new Uint8Array(await crypto.subtle.encrypt(params, key, enc.encode(plaintext)));
  const out = new Uint8Array(12 + sealed.length);
  out.set(nonce);
  out.set(sealed, 12);
  return { out, keyID: (await sha256Bytes(raw)).slice(0, 12) };
}
async function sha256Bytes(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function encv2(keyHex, owner, id, value) {
  const { out, keyID } = await seal(keyHex, value, `whagons-skills/credential/${owner}/${id}`);
  return `encv2:${keyID}:${b64raw(out)}`;
}
export async function encv1(keyHex, value) {
  const { out } = await seal(keyHex, value);
  return `encv1:${b64raw(out)}`;
}

// Postgres json renders timestamps like this.
function pgTime(ms) {
  const iso = new Date(ms).toISOString();
  return iso.replace("Z", "").replace(/\.(\d{3})$/, (_, m) => `.${m}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`) + "+00:00";
}

/**
 * @returns {Promise<{ exportDoc: object, key: string, secrets: Record<string,string>, apiKeys: Record<string,string>, sessions: Record<string,string> }>}
 */
export async function generateGonvexExport(options = {}) {
  const key = options.key ?? hex(random(32));
  const now = options.now ?? Date.now();
  const day = 86400e3;
  const owner = "google:100000000000000000001";
  const member = "google:100000000000000000002";
  const ownerPrefix = (await sha256(owner)).slice(0, 12) + "_";
  const secrets = {};
  const apiKeys = {};
  const sessions = {};

  const users = [
    { owner_id: owner, email: "owner@fixtures.invalid", name: "Fixture Owner", can_own: true, created_at: pgTime(now - 90 * day), updated_at: pgTime(now - day) },
    { owner_id: member, email: "member@fixtures.invalid", name: "Fixture Member", can_own: false, created_at: pgTime(now - 60 * day), updated_at: pgTime(now - day) },
  ];

  const skills = [];
  for (let i = 0; i < 12; i++) {
    const content = `---\nname: fixture-skill-${i}\ndescription: Synthetic skill ${i}\n---\n\n# Fixture ${i}\n\n${"Lorem ipsum. ".repeat(20 + i * 10)}`;
    skills.push({
      id: `${ownerPrefix}local-fixture-skill-${i}`, owner_id: owner, name: `fixture-skill-${i}`, summary: `Synthetic skill ${i}`,
      content, content_hash: await sha256(content), approved_at: i === 11 ? null : pgTime(now - (30 - i) * day),
      approved_by: i === 11 ? "" : owner, created_at: pgTime(now - (40 - i) * day), updated_at: pgTime(now - (30 - i) * day),
    });
  }

  const credentials = [];
  const formats = ["encv2", "encv2", "encv2", "encv2", "encv2", "encv1", "plaintext"];
  for (const [i, format] of formats.entries()) {
    const id = `${ownerPrefix}skill_fixturecredential${i}`;
    const value = JSON.stringify({ accountId: `fixture-${i}`, apiToken: b64url(random(24)) });
    secrets[id] = value;
    const stored = format === "encv2" ? await encv2(key, owner, id, value) : format === "encv1" ? await encv1(key, value) : value;
    credentials.push({
      id, owner_id: owner, name: `fixture-credential-${i}`, summary: `Synthetic credential ${i} (${format})`, secret_value: stored,
      created_at: pgTime(now - 20 * day), updated_at: pgTime(now - (10 - i) * day),
    });
  }

  const keyRows = [];
  const makeKey = async (id, createdBy, scopes, expires, revoked) => {
    const plaintext = `skv_${b64url(random(32))}`;
    apiKeys[id] = plaintext;
    keyRows.push({
      id, owner_id: owner, created_by: createdBy, name: `fixture key ${id}`, key_hash: await sha256(plaintext), prefix: plaintext.slice(0, 14),
      scopes, created_at: pgTime(now - 5 * day), expires_at: expires, revoked_at: revoked,
    });
  };
  await makeKey("skill_fixturekey_owner", owner, "credentials:read,credentials:write,keys:read,keys:revoke,skills:read,skills:write", pgTime(now + 300 * day), null);
  await makeKey("skill_fixturekey_member", member, "credentials:read,skills:read", null, null);
  await makeKey("skill_fixturekey_revoked", owner, "skills:read", pgTime(now + 30 * day), pgTime(now - day));

  const sessionRows = [];
  for (const [id, who, expires] of [["skill_fixturesession_live", owner, now + 20 * day], ["skill_fixturesession_expired", owner, now - 2 * day]]) {
    const token = `skv_sess_${b64url(random(32))}`;
    sessions[id] = token;
    sessionRows.push({ id, owner_id: who, workspace_id: who, token_hash: await sha256(token), pending_only: false, created_at: pgTime(expires - 30 * day), expires_at: pgTime(expires), revoked_at: null });
  }

  const roleID = "skill_fixturerole_limited";
  const policy = {
    id: roleID, name: "Limited", description: "", scopes: ["credentials:read", "skills:read"],
    all_skills: true, skill_ids: [], all_credentials: false, credential_ids: [credentials[0].id],
  };
  const exportDoc = {
    format: GONVEX_EXPORT_FORMAT,
    exported_at: pgTime(now),
    tables: {
      skill_users: users,
      skill_sessions: sessionRows,
      skills,
      skill_api_keys: keyRows,
      skill_credentials: credentials,
      skill_workspace_members: [{ id: "skill_fixturemember", workspace_owner_id: owner, email: "member@fixtures.invalid", invited_by: owner, role_id: roleID, created_at: pgTime(now - 59 * day) }],
      skill_workspace_invitations: [
        { id: "skill_fixtureinvite_accepted", workspace_owner_id: owner, email: "member@fixtures.invalid", invited_by: owner, role_id: roleID, created_at: pgTime(now - 60 * day), accepted_at: pgTime(now - 59 * day), rejected_at: null },
        { id: "skill_fixtureinvite_pending", workspace_owner_id: owner, email: "pending@fixtures.invalid", invited_by: owner, role_id: "", created_at: pgTime(now - day), accepted_at: null, rejected_at: null },
      ],
      skill_access_roles: [{ id: roleID, workspace_owner_id: owner, name: "Limited", policy: JSON.stringify(policy) }],
    },
  };
  return { exportDoc, key, secrets, apiKeys, sessions };
}
