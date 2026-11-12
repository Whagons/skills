// Small helpers shared by the vault functions. Error strings mirror the Go
// backend (gonvex/*.go) because the CLI and UI show them verbatim.

export class VaultError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const deny = (message: string) => new VaultError(message, 403);
export const unauthorized = (message: string) => new VaultError(message, 401);

const encoder = new TextEncoder();

export function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

// Go's unicode.IsControl: C0, DEL and C1.
export function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function hasSpace(value: string): boolean {
  return /\s/u.test(value);
}

export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return prefix + base64url(bytes);
}

export function randomID(): string {
  return randomToken("skill_");
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hashToken(value: string): Promise<string> {
  return sha256Hex(value);
}

export function splitCSV(value: string | null | undefined): string[] {
  return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

export function int(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// Constant-time comparison for operator tokens.
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
