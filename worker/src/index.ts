// Worker entry: static UI with security headers, the Gonvex-compatible
// WebSocket at /ws, the JSON API at /api/<path>, operator endpoints at
// /admin/* (off unless ADMIN_TOKEN is set), and the nightly R2 backup.

import { DEFAULT_PROJECT_ID, type Env, type Meta } from "./context";
import { FUNCTIONS } from "./functions";
import { timingSafeEqualString } from "./util";
import type { CallResult, Vault } from "./vault";

export { Vault } from "./vault";

const MAX_BODY_BYTES = 3 << 20;
const ADMIN_OPS = new Set(["stats", "export", "import", "verify-decrypt", "reencrypt"]);

function vault(env: Env): DurableObjectStub<Vault> {
  const hint = (env.VAULT_LOCATION_HINT ?? "").trim();
  const id = env.VAULT.idFromName("vault");
  return hint ? env.VAULT.get(id, { locationHint: hint as DurableObjectLocationHint }) : env.VAULT.get(id);
}

function projectID(env: Env): string {
  return (env.SKILLS_PROJECT_ID ?? "").trim() || DEFAULT_PROJECT_ID;
}

function meta(request: Request): Meta {
  return {
    ip: request.headers.get("CF-Connecting-IP") ?? "",
    userAgent: request.headers.get("User-Agent") ?? "",
    ray: request.headers.get("CF-Ray") ?? "",
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

function fromResult(result: CallResult): Response {
  return result.ok ? json({ result: result.result }) : json({ error: result.error }, result.status);
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

export function securityHeaders(url: URL): Record<string, string> {
  const secure = url.protocol === "https:";
  const socket = `${secure ? "wss" : "ws"}://${url.host}`;
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com https://static.cloudflareinsights.com",
    `connect-src 'self' ${socket} http://127.0.0.1:* https://cloudflareinsights.com`,
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

async function handleSocket(request: Request, env: Env, url: URL): Promise<Response> {
  const project = url.searchParams.get("project");
  if (project !== null && project !== projectID(env)) return new Response("unknown project", { status: 404 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
  return vault(env).fetch(request);
}

async function handleAPI(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "POST") return json({ error: "use POST with a JSON body" }, 405);
  if (!Object.hasOwn(FUNCTIONS, path)) return json({ error: `unknown function: ${path}` }, 404);
  const body = await readJSON(request);
  if (body.error) return body.error;
  const args = body.value && typeof body.value === "object" && !Array.isArray(body.value) ? { ...(body.value as Record<string, unknown>) } : {};
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer && args.apiKey === undefined && path.startsWith("agent.")) args.apiKey = bearer;
  return fromResult(await vault(env).call(path, args, meta(request)));
}

async function handleAdmin(request: Request, env: Env, url: URL, op: string): Promise<Response> {
  const configured = (env.ADMIN_TOKEN ?? "").trim();
  // Disabled unless the operator sets ADMIN_TOKEN; indistinguishable from a
  // missing route so the endpoint's existence is not advertised.
  if (configured.length < 32) return new Response("not found", { status: 404 });
  const supplied = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  if (!timingSafeEqualString(supplied, configured)) return json({ error: "unauthorized" }, 401);
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
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    // Optional cutover shim (DESIGN.md §8 4a): when routed on the Gonvex
    // hostname, take only Skills-project sockets and pass the rest through.
    const passthrough = (env.GONVEX_PASSTHROUGH_HOST ?? "").trim().toLowerCase();
    if (passthrough && url.hostname.toLowerCase() === passthrough) {
      if (url.pathname === "/ws" && url.searchParams.get("project") === projectID(env)) return handleSocket(request, env, url);
      return fetch(request);
    }

    if (url.pathname === "/health") return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
    if (url.pathname === "/ws") return handleSocket(request, env, url);
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
    void ctx;
    return handleAssets(request, env, url);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    if (!env.BLOBS) return;
    ctx.waitUntil(vault(env).backup().then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
