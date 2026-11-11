// Cloudflare Worker backend (docs/cloudflare/DESIGN.md, API.md). Selected by
// the "@backend" alias when building with `vite build --mode cloudflare`.
// Every call is POST /api/<function>; the session token travels in the
// Authorization header. Collections are polled and refreshed right after
// this browser's own writes.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export { api } from "../../gonvex/_generated/api";

type FunctionRef = { kind: string; path: string };
type Args = Record<string, unknown>;

const POLL_MS = 5000;
const origin = typeof window === "undefined" ? "" : window.location.origin;
const apiBase = import.meta.env.VITE_VAULT_API_URL ?? origin;

export class VaultClient {
  private listeners = new Set<() => void>();

  constructor(private readonly base: string) {}

  async call<T>(ref: FunctionRef, args: Args = {}): Promise<T> {
    const { sessionToken, apiKey, ...body } = args;
    const token = (sessionToken ?? apiKey) as string | undefined;
    const response = await fetch(`${this.base}/api/${encodeURIComponent(ref.path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    let parsed: { result?: T; error?: string };
    try {
      parsed = await response.json();
    } catch {
      throw new Error(`vault request failed (${response.status})`);
    }
    if (parsed.error !== undefined || !response.ok) throw new Error(parsed.error ?? `vault request failed (${response.status})`);
    return parsed.result as T;
  }

  query<T>(ref: FunctionRef, args: Args = {}) {
    return this.call<T>(ref, args);
  }

  action<T>(ref: FunctionRef, args: Args = {}) {
    return this.call<T>(ref, args);
  }

  async mutation<T>(ref: FunctionRef, args: Args = {}) {
    try {
      return await this.call<T>(ref, args);
    } finally {
      for (const listener of this.listeners) listener();
    }
  }

  onWrite(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const VaultContext = createContext<VaultClient | null>(null);
const defaultClient = new VaultClient(apiBase);

export function BackendProvider({ children, client = defaultClient }: { children: ReactNode; client?: VaultClient }) {
  return <VaultContext.Provider value={client}>{children}</VaultContext.Provider>;
}

export function useConvex(): VaultClient {
  const client = useContext(VaultContext);
  if (!client) throw new Error("BackendProvider is missing");
  return client;
}

export function useMutation(ref: FunctionRef) {
  const client = useConvex();
  return useMemo(() => (args: Args = {}) => client.mutation<unknown>(ref, args), [client, ref]);
}

// Same contract as Gonvex useSync: rows once loaded, undefined while loading
// or when skipped. Refreshed every few seconds, when the tab regains focus,
// and immediately after this browser's own writes. Nothing is persisted.
export function useSync<T>(ref: FunctionRef, args: Args | "skip"): T[] | undefined {
  const client = useConvex();
  const key = args === "skip" ? "skip" : JSON.stringify(args);
  const [rows, setRows] = useState<{ key: string; rows: T[] } | undefined>(undefined);
  useEffect(() => {
    if (args === "skip") {
      setRows(undefined);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer);
      try {
        const value = await client.query<unknown>(ref, args);
        if (!cancelled) setRows({ key, rows: Array.isArray(value) ? (value as T[]) : [] });
      } catch {
        // Keep the last good rows; the next poll retries.
      } finally {
        if (!cancelled) timer = setTimeout(load, document.visibilityState === "visible" ? POLL_MS : POLL_MS * 6);
      }
    };
    void load();
    const offWrite = client.onWrite(() => void load());
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      offWrite();
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ref.path, key]);
  return rows?.key === key ? rows.rows : undefined;
}

export const backendLabel = "Cloudflare Workers";
export const backendStatus = "Vault live";
export const backendFeatures = { accessLog: true };
export const backendHost = typeof window === "undefined" ? "skills.whagons.com" : window.location.host;

export function scriptAPIGuide() {
  return `Direct HTTP API for custom scripts (no client library needed):
POST ${apiBase}/api/<function> with the arguments as a JSON object and the API key
in the Authorization header. Responses are {"result": ...} or {"error": "..."}.

  curl -sS -X POST ${apiBase}/api/agent.skills.list \\
    -H "Authorization: Bearer $WHAGONS_DEV_API_KEY" -H 'content-type: application/json' -d '{}'

  curl -sS -X POST ${apiBase}/api/agent.skills.get \\
    -H "Authorization: Bearer $WHAGONS_DEV_API_KEY" -H 'content-type: application/json' \\
    -d '{"name":"whagons-monitor"}'

Functions: agent.skills.list/get/upload/delete, agent.credentials.list/get/save/delete,
agent.apiKeys.list/verify/revoke/revokeSelf. Prefer \`whagons-dev credentials exec\` over
agent.credentials.get so values never reach a terminal.`;
}
