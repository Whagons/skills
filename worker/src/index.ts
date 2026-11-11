// Worker entry: the static UI with security headers, the JSON API at
// POST /api/<function> (docs/cloudflare/API.md), operator endpoints at
// /admin/* (off unless ADMIN_TOKEN is set), and the nightly R2 backup.

import { type Env, type Meta } from "./context";
import { FUNCTIONS } from "./functions";
import { timingSafeEqualString } from "./util";
import type { CallResult, Vault } from "./vault";

export { Vault } from "./vault";

const MAX_BODY_BYTES = 3 << 20;
const ADMIN_OPS = new Set(["stats", "export", "import", "verify-decrypt", "reencrypt"]);
const CREDENTIAL_FIELDS = ["apiKey", "sessionToken"];

function vault(env: Env): DurableObjectStub<Vault> {
  const hint = (env.VAULT_LOCATION_HINT ?? "").trim();
  const id = env.VAULT.idFromName("vault");
  return hint ? env.VAULT.get(id, { locationHint: hint as DurableObjectLocationHint }) : env.VAULT.get(id);
}

function meta(request: Request): Meta {
  return {
    ip: request.headers.get("CF-Connecting-IP") ?? "",
    userAgent: request.headers.get("User-Agent") ?? "",
    ray: request.headers.get("CF-Ray") ?? "",
  };
}

const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });

function fromResult(result: CallResult): Response {
  return result.ok ? json({ result: result.result }) : json({ error: result.error }, result.status);
}

function bearer(request: Request): string {
  return request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
}

async function readJSON(request: Request): Promise<{ value?: unknown; error?: Response }> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > MAX_BODY_BYTES) return { error: json({ error: "request body is too large" }, 413) };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: json({ error: "request body is too large" }, 413) };
  if (!text.trim()) return { value: {} };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: json({ error: "request body must be JSON" }, 400) };
  }
}

// Rate limits (DESIGN.md §5.7), keyed by client IP. Requests without
// CF-Connecting-IP (local development and tests) are not limited.
async function limited(binding: RateLimit | undefined, ip: string): Promise<boolean> {
  if (!binding || !ip) return false;
  const { success } = await binding.limit({ key: ip });
  return !success;
}

export function securityHeaders(url: URL): Record<string, string> {
  const secure = url.protocol === "https:";
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com https://static.cloudflareinsights.com",
    "connect-src 'self' http://127.0.0.1:* https://cloudflareinsights.com",
    "frame-src https://accounts.google.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "Strict-Transport-Security": "max-age=31536000",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  };
}

async function handleAPI(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "POST") return json({ error: "use POST with a JSON body" }, 405, { Allow: "POST" });
  if (!Object.hasOwn(FUNCTIONS, path)) return json({ error: `unknown function: ${path}` }, 404);
  const { ip } = meta(request);
  if (await limited(env.API_LIMIT, ip)) return json({ error: "too many requests; slow down" }, 429, { "Retry-After": "60" });
  if (path === "auth.login" && (await limited(env.LOGIN_LIMIT, ip))) {
    return json({ error: "too many sign-in attempts; try again in a minute" }, 429, { "Retry-After": "60" });
  }
  const body = await readJSON(request);
  if (body.error) return body.error;
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) return json({ error: "request body must be a JSON object" }, 400);
  const args = { ...(body.value as Record<string, unknown>) };
  // Credentials travel only in the Authorization header, never in bodies.
  if (CREDENTIAL_FIELDS.some((field) => Object.hasOwn(args, field))) {
    return json({ error: "send the API key or session token in the Authorization header, not the body" }, 400);
  }
  const token = bearer(request);
  if (token) args[path.startsWith("agent.") ? "apiKey" : "sessionToken"] = token;
  return fromResult(await vault(env).call(path, args, meta(request)));
}

async function handleAdmin(request: Request, env: Env, url: URL, op: string): Promise<Response> {
  const configured = (env.ADMIN_TOKEN ?? "").trim();
  // Disabled unless the operator sets ADMIN_TOKEN; indistinguishable from a
  // missing route so the endpoint's existence is not advertised.
  if (configured.length < 32) return new Response("not found", { status: 404 });
  if (!timingSafeEqualString(bearer(request), configured)) return json({ error: "unauthorized" }, 401);
  if (!ADMIN_OPS.has(op)) return json({ error: "unknown admin operation" }, 404);
  const mutating = op === "import" || op === "reencrypt";
  if (request.method !== "POST" && (mutating || request.method !== "GET")) return json({ error: "method not allowed" }, 405);
  let body: unknown = undefined;
  if (op === "import") {
    const length = Number(request.headers.get("Content-Length") ?? "0");
    if (length > 64 << 20) return json({ error: "bundle is too large" }, 413);
    try {
      body = JSON.parse(await request.text());
    } catch {
      return json({ error: "bundle must be JSON" }, 400);
    }
  }
  const params = Object.fromEntries(url.searchParams.entries());
  return fromResult(await vault(env).admin(op, body, params, meta(request)));
}

async function handleAssets(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ASSETS) return new Response("not found", { status: 404 });
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders(url))) headers.set(name, value);
  if (url.pathname === "/" || url.pathname.endsWith(".html") || !url.pathname.includes(".")) headers.set("Cache-Control", "no-cache");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
    if (url.pathname.startsWith("/api/")) {
      let path: string;
      try {
        path = decodeURIComponent(url.pathname.slice(5));
      } catch {
        return json({ error: "invalid function path" }, 400);
      }
      return handleAPI(request, env, path);
    }
    if (url.pathname.startsWith("/admin/")) return handleAdmin(request, env, url, url.pathname.slice(7));
    return handleAssets(request, env, url);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    if (!env.BLOBS) return;
    ctx.waitUntil(vault(env).backup().then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
