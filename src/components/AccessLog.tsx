// Owner-only access log: recent credential reads (who, what, when, allowed or
// denied), filterable by person, API key and secret. Values never appear here;
// the vault only records which secret was requested.
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useConvex } from "@backend";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";

const credentialReads = { kind: "query", path: "audit.credentialReads" } as const;

export type CredentialRead = {
  id: number;
  at: string;
  actor_email: string;
  via: string;
  api_key_id: string;
  api_key_name: string;
  api_key_prefix: string;
  credential_id: string;
  credential_name: string;
  result: "allowed" | "denied" | "failed";
  detail: string;
};

type Option = { id: string; label: string };

export function AccessLog({ sessionToken, people, keys, secrets }: {
  sessionToken: string;
  people: string[];
  keys: Option[];
  secrets: Option[];
}) {
  const client = useConvex();
  const [person, setPerson] = useState("");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; rows: CredentialRead[]; error: string }>({ status: "loading", rows: [], error: "" });

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, status: "loading" }));
    client.query<CredentialRead[]>(credentialReads, { sessionToken, actor_email: person, api_key_id: key, credential_id: secret, limit: 200 })
      .then((rows) => { if (!cancelled) setState({ status: "ready", rows, error: "" }); })
      .catch((error: unknown) => { if (!cancelled) setState({ status: "error", rows: [], error: error instanceof Error ? error.message : "Could not load the access log" }); });
    return () => { cancelled = true; };
  }, [client, sessionToken, person, key, secret, reload]);

  const filtered = person || key || secret;
  return (
    <>
      <header className="mainHeader">
        <div className="headerCopy">
          <p className="eyebrow"><span>Workspace</span> / Access log</p>
          <h2>Credential reads</h2>
          <p className="summaryLine">Every time a person or API key asked for a secret's value, newest first. Values are never logged.</p>
        </div>
      </header>
      <Card className="accessLogCard">
        <CardContent>
          <div className="accessLogFilters" role="group" aria-label="Filter credential reads">
            <label>Person
              <select value={person} onChange={(event) => setPerson(event.target.value)}>
                <option value="">Everyone</option>
                {people.map((email) => <option key={email} value={email}>{email}</option>)}
              </select>
            </label>
            <label>API key
              <select value={key} onChange={(event) => setKey(event.target.value)}>
                <option value="">Any key or browser</option>
                {keys.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label>Secret
              <select value={secret} onChange={(event) => setSecret(event.target.value)}>
                <option value="">All secrets</option>
                {secrets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <Button type="button" variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>
              <RefreshCw size={14} /> Refresh
            </Button>
          </div>
          {state.status === "error" ? <p className="memberAccessNotice" role="alert">Could not load the access log: {state.error}</p> : null}
          {state.status !== "error" && state.rows.length === 0 ? (
            <p className="accessLogEmpty">{state.status === "loading" ? "Loading…" : filtered ? "No reads match these filters." : "No credential reads recorded yet."}</p>
          ) : null}
          {state.rows.length > 0 ? (
            <table className="accessLogTable">
              <thead>
                <tr><th>When</th><th>Who</th><th>Through</th><th>Secret</th><th>Result</th></tr>
              </thead>
              <tbody>
                {state.rows.map((row) => (
                  <tr key={row.id}>
                    <td><time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time></td>
                    <td>{row.actor_email || "Unknown"}</td>
                    <td>{row.via === "api_key" ? (row.api_key_name || row.api_key_prefix || "API key") : "Browser"}</td>
                    <td>{row.credential_name || row.credential_id || "—"}</td>
                    <td><span className={`accessLogResult ${row.result}`} title={row.result === "allowed" ? "" : row.detail}>{row.result}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
