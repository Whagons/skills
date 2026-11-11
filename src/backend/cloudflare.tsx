// Cloudflare Worker backend (docs/cloudflare/DESIGN.md). Selected by the
// "@backend" alias when VITE_SKILLS_BACKEND=cloudflare. One-shot calls use the
// Worker's JSON API; owner collections are live queries over the same
// WebSocket protocol the CLI uses, re-sent by the Worker after every write.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export { api } from "../../gonvex/_generated/api";

type FunctionRef = { kind: string; path: string };
type Args = Record<string, unknown>;
type Listener = { onResult: (value: unknown) => void; onError: (error: Error) => void };

const origin = typeof window === "undefined" ? "" : window.location.origin;
const apiBase = import.meta.env.VITE_VAULT_API_URL ?? origin;
const socketURL = import.meta.env.VITE_VAULT_WS_URL ?? `${origin.replace(/^http/, "ws")}/ws`;

export class VaultClient {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, { path: string; args: Args; listener: Listener }>();
  private nextID = 0;
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly base: string, private readonly socket: string) {}

  async call<T>(ref: FunctionRef, args: Args = {}): Promise<T> {
    const response = await fetch(`${this.base}/api/${encodeURIComponent(ref.path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
    });
    let body: { result?: T; error?: string };
    try {
      body = await response.json();
    } catch {
      throw new Error(`vault request failed (${response.status})`);
    }
    if (body.error !== undefined || !response.ok) throw new Error(body.error ?? `vault request failed (${response.status})`);
    return body.result as T;
  }

  query<T>(ref: FunctionRef, args: Args = {}) {
    return this.call<T>(ref, args);
  }

  mutation<T>(ref: FunctionRef, args: Args = {}) {
    return this.call<T>(ref, args);
  }

  action<T>(ref: FunctionRef, args: Args = {}) {
    return this.call<T>(ref, args);
  }

  subscribe(ref: FunctionRef, args: Args, listener: Listener): () => void {
    const id = `s${++this.nextID}`;
    this.subscriptions.set(id, { path: ref.path, args, listener });
    this.ensureSocket();
    this.sendSubscribe(id);
    return () => {
      this.subscriptions.delete(id);
      this.send({ type: "query.unsubscribe", id });
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private send(message: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private sendSubscribe(id: string) {
    const sub = this.subscriptions.get(id);
    if (sub) this.send({ type: "query.subscribe", id, path: sub.path, args: sub.args });
  }

  private ensureSocket() {
    if (this.closed || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    const ws = new WebSocket(this.socket);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.retry = 0;
      for (const id of this.subscriptions.keys()) this.sendSubscribe(id);
    });
    ws.addEventListener("message", (event) => {
      let message: { type?: string; id?: string; result?: unknown; error?: string };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const sub = message.id ? this.subscriptions.get(message.id) : undefined;
      if (!sub) return;
      if (message.type === "query.result") sub.listener.onResult(message.result);
      else if (message.type === "query.error") sub.listener.onError(new Error(message.error ?? "query failed"));
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null;
      if (this.closed || this.subscriptions.size === 0) return;
      const delay = Math.min(30_000, 500 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => this.ensureSocket(), delay);
    });
  }
}

const VaultContext = createContext<VaultClient | null>(null);
const defaultClient = new VaultClient(apiBase, socketURL);

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
// or when skipped. Rows are not persisted in the browser.
export function useSync<T>(ref: FunctionRef, args: Args | "skip"): T[] | undefined {
  const client = useConvex();
  const key = args === "skip" ? "skip" : JSON.stringify(args);
  const [rows, setRows] = useState<{ key: string; rows: T[] } | undefined>(undefined);
  useEffect(() => {
    if (args === "skip") {
      setRows(undefined);
      return;
    }
    return client.subscribe(ref, args, {
      onResult: (value) => setRows({ key, rows: Array.isArray(value) ? (value as T[]) : [] }),
      onError: () => setRows((current) => (current?.key === key ? current : undefined)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ref.path, key]);
  return rows?.key === key ? rows.rows : undefined;
}

export const backendLabel = "Cloudflare Workers";
export const backendStatus = "Vault live";
export const backendHost = typeof window === "undefined" ? "skills.whagons.com" : window.location.host;

export function scriptAPIGuide() {
  return `Direct HTTP API for custom scripts (no client library needed):
POST ${apiBase}/api/<function> with a JSON body; the API key goes in the
Authorization header. Responses are {"result": ...} or {"error": "..."}.

  curl -sS -X POST ${apiBase}/api/agent.skills.list \\
    -H "Authorization: Bearer $WHAGONS_DEV_API_KEY" -H 'content-type: application/json' -d '{}'

  curl -sS -X POST ${apiBase}/api/agent.skills.get \\
    -H "Authorization: Bearer $WHAGONS_DEV_API_KEY" -H 'content-type: application/json' \\
    -d '{"name":"whagons-monitor"}'

Functions: agent.skills.list/get/upload/delete, agent.credentials.list/get/save/delete,
agent.apiKeys.list/verify/revoke/revokeSelf. Prefer \`whagons-dev credentials exec\` over
agent.credentials.get so values never reach a terminal.`;
}
