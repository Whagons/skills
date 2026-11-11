// Credential encryption, byte-compatible with gonvex/skills.go:
//   encv2:<key-id>:<base64raw(nonce || AES-256-GCM(ciphertext||tag))>
//   key-id = first 12 hex chars of sha256(raw key bytes)
//   AAD    = "whagons-skills/credential/<workspace>/<credential-id>"
// encv1 (no AAD) and plaintext rows are still readable and are reported as
// needing migration so callers re-encrypt them with the current key.

import { VaultError, sha256Hex, splitCSV } from "./util";

export const ENCV2 = "encv2:";
export const ENCV1 = "encv1:";
const NONCE = 12;

export type KeyConfig = { current?: string; previous?: string };

type Cipher = { id: string; key: CryptoKey };

function decodeHex(raw: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]*$/.test(raw) || raw.length % 2) return null;
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function decodeBase64(raw: string): Uint8Array | null {
  try {
    const normalized = raw.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64Raw(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("=", "");
}

// Matches decodeCredentialKey: hex, then std base64, then raw std base64.
export function decodeCredentialKey(raw: string): Uint8Array {
  const value = raw.trim();
  if (!value) throw new VaultError("credential encryption key is empty", 500);
  for (const candidate of [decodeHex(value), /^[A-Za-z0-9+/]*={0,2}$/.test(value) ? decodeBase64(value) : null]) {
    if (candidate && candidate.length === 32) return candidate;
  }
  throw new VaultError("credential encryption keys must be exactly 32 bytes encoded as hex or base64", 500);
}

const cipherCache = new Map<string, Promise<Cipher>>();

function cipherFor(raw: string): Promise<Cipher> {
  let cached = cipherCache.get(raw);
  if (!cached) {
    cached = (async () => {
      const bytes = decodeCredentialKey(raw);
      const id = (await sha256Hex(bytes)).slice(0, 12);
      const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
      return { id, key };
    })();
    cached.catch(() => cipherCache.delete(raw));
    cipherCache.set(raw, cached);
  }
  return cached;
}

export async function credentialCiphers(config: KeyConfig): Promise<Cipher[]> {
  const current = (config.current ?? "").trim();
  if (!current) throw new VaultError("SKILLS_SECRET_KEY must be configured before credentials can be stored or read", 500);
  const result: Cipher[] = [];
  const seen = new Set<string>();
  for (const raw of [current, ...splitCSV(config.previous)]) {
    const item = await cipherFor(raw);
    if (!seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}

export function credentialAAD(ownerID: string, credentialID: string): Uint8Array {
  return new TextEncoder().encode(`whagons-skills/credential/${ownerID}/${credentialID}`);
}

export async function encryptSecret(config: KeyConfig, ownerID: string, credentialID: string, value: string): Promise<string> {
  const [current] = await credentialCiphers(config);
  const nonce = new Uint8Array(NONCE);
  crypto.getRandomValues(nonce);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: credentialAAD(ownerID, credentialID) },
    current.key,
    new TextEncoder().encode(value),
  ));
  const out = new Uint8Array(NONCE + sealed.length);
  out.set(nonce);
  out.set(sealed, NONCE);
  return `${ENCV2}${current.id}:${encodeBase64Raw(out)}`;
}

async function open(key: CryptoKey, sealed: Uint8Array, aad?: Uint8Array): Promise<string | null> {
  try {
    const params = aad
      ? { name: "AES-GCM", iv: sealed.slice(0, NONCE), additionalData: aad }
      : { name: "AES-GCM", iv: sealed.slice(0, NONCE) };
    const plain = await crypto.subtle.decrypt(params, key, sealed.slice(NONCE));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export type Decrypted = { value: string; migrate: boolean; format: "encv2" | "encv1" | "plaintext"; keyID?: string };

export async function decryptSecret(config: KeyConfig, ownerID: string, credentialID: string, stored: string): Promise<Decrypted> {
  const ciphers = await credentialCiphers(config);
  if (stored.startsWith(ENCV2)) {
    const first = stored.indexOf(":");
    const second = stored.indexOf(":", first + 1);
    const keyID = second > 0 ? stored.slice(first + 1, second) : "";
    const body = second > 0 ? stored.slice(second + 1) : "";
    const sealed = keyID && body ? decodeBase64(body) : null;
    if (!sealed) throw new VaultError("encrypted credential is malformed", 500);
    for (const [index, item] of ciphers.entries()) {
      if (item.id !== keyID || sealed.length < NONCE) continue;
      const value = await open(item.key, sealed, credentialAAD(ownerID, credentialID));
      if (value !== null) return { value, migrate: index !== 0, format: "encv2", keyID };
    }
    throw new VaultError("credential decryption failed", 500);
  }
  if (stored.startsWith(ENCV1)) {
    const sealed = decodeBase64(stored.slice(ENCV1.length));
    if (!sealed) throw new VaultError("legacy encrypted credential is malformed", 500);
    for (const item of ciphers) {
      if (sealed.length < NONCE) continue;
      const value = await open(item.key, sealed);
      if (value !== null) return { value, migrate: true, format: "encv1" };
    }
    throw new VaultError("legacy credential decryption failed", 500);
  }
  return { value: stored, migrate: true, format: "plaintext" };
}

export function storedFormat(stored: string): string {
  if (stored.startsWith(ENCV2)) return `encv2:${stored.split(":")[1] ?? ""}`;
  if (stored.startsWith(ENCV1)) return "encv1";
  return "plaintext";
}
