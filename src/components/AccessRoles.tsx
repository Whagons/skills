import { useState, type FormEvent } from "react";
import { Check, KeyRound, LibraryBig, Pencil, Plus, Search, ShieldCheck, Trash2, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { newRole, resourceSummary, type AccessRole, type AccessState } from "../lib/access";

type Resource = { id: string; name: string; summary: string };
type Props = { state: AccessState | null; skills: Resource[]; credentials: Resource[]; onSave: (role: AccessRole) => Promise<void>; onDelete: (id: string) => Promise<void> };

function ResourcePicker({ kind, resources, role, onChange }: { kind: "skills" | "credentials"; resources: Resource[]; role: AccessRole; onChange: (role: AccessRole) => void }) {
  const [query, setQuery] = useState("");
  const allKey = kind === "skills" ? "all_skills" : "all_credentials";
  const idsKey = kind === "skills" ? "skill_ids" : "credential_ids";
  const read = role.scopes.includes(`${kind}:read`);
  const write = role.scopes.includes(`${kind}:write`);
  const selected = role[idsKey] ?? [];
  const choices = [...resources, ...selected.filter(id => !resources.some(item => item.id === id)).map(id => ({ id, name: "Removed item", summary: `Unselect this item before saving. ${id}` }))];
  const visible = choices.filter(item => `${item.name} ${item.summary}`.toLowerCase().includes(query.toLowerCase()));
  function setLevel(level: string) {
    const scopes = role.scopes.filter(scope => !scope.startsWith(`${kind}:`));
    if (level !== "none") scopes.push(`${kind}:read`);
    if (level === "edit") scopes.push(`${kind}:write`);
    onChange({ ...role, scopes, ...(level === "none" ? { [idsKey]: [], [allKey]: false } : {}) });
  }
  return <fieldset className="resourcePicker">
    <legend>{kind === "skills" ? <LibraryBig size={17} /> : <KeyRound size={17} />}{kind === "skills" ? "Skills" : "Credentials"}</legend>
    <div className="permissionLevels" aria-label={`${kind} permission`}>
      {[["none", "No access"], ["read", kind === "skills" ? "Read & install" : "Reveal & use"], ["edit", "Read & edit"]].map(([value, label]) => <button type="button" key={value} aria-pressed={(write ? "edit" : read ? "read" : "none") === value} onClick={() => setLevel(value)}>{label}</button>)}
    </div>
    {read ? <>
      <label className="accessAll"><input type="checkbox" checked={role[allKey]} onChange={event => onChange({ ...role, [allKey]: event.target.checked, ...(event.target.checked ? { [idsKey]: [] } : {}) })} /><span>All {kind}<small>Includes items added in the future.</small></span></label>
      {!role[allKey] ? <>
        <div className="resourceSearch"><Search size={15} /><Input aria-label={`Search ${kind}`} placeholder={`Search ${kind}…`} value={query} onChange={event => setQuery(event.target.value)} /></div>
        <div className="resourceChoices">
          {visible.length ? visible.map(item => <label key={item.id} className="resourceChoice"><input type="checkbox" checked={selected.includes(item.id)} onChange={event => onChange({ ...role, [idsKey]: event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id) })} /><span><strong>{item.name}</strong><small>{item.summary || "No description"}</small></span>{selected.includes(item.id) ? <Check size={14} /> : null}</label>) : <p className="mutedText">{resources.length ? "No matching items." : `No ${kind} in this workspace yet.`}</p>}
        </div>
        <p className="selectionHint">{selected.length} selected. New items stay private.{write ? " Members can edit or delete selected items. Creating items requires All access." : ""}</p>
      </> : <p className="selectionHint">{write ? `Members can create, edit and delete ${kind}.` : `Members can read all ${kind}.`}</p>}
      {kind === "credentials" ? <p className="credentialAccessNote">Read access lets members reveal and copy the selected secret values.</p> : null}
    </> : <p className="selectionHint">These items stay hidden from members with this role.</p>}
  </fieldset>;
}

export function AccessRoles({ state, skills, credentials, onSave, onDelete }: Props) {
  const [draft, setDraft] = useState<AccessRole | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft) return;
    setBusy(true); setError("");
    try { await onSave(draft); setDraft(null); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  }
  const assigned = (id: string) => Object.values(state?.assignments ?? {}).filter(value => value === id).length;
  return <section className="accessRoles">
    <Card className="settingsCard">
      <CardHeader><div className="settingsIcon"><ShieldCheck size={19} /></div><div><CardTitle>Roles & permissions</CardTitle><CardDescription>Choose what a teammate can see and change. Reuse a role across your team.</CardDescription></div><Button type="button" variant="accent" disabled={!state || busy} onClick={() => { setDraft(newRole()); setError(""); }}><Plus size={16} />Create role</Button></CardHeader>
      <CardContent>
        <div className="roleCards">
          {!state ? <p className="mutedText">Loading roles…</p> : state.roles.map(role => <article className={`roleCard ${role.id === "full" ? "builtInRole" : ""}`} key={role.id}>
            <div className="roleCardTop"><ShieldCheck size={18} /><Badge variant="muted">{role.id === "full" ? "Built in" : `${assigned(role.id)} assigned`}</Badge></div>
            <h3>{role.name}</h3><p>{role.description || "Custom workspace access"}</p>
            <div className="roleGrants"><span><LibraryBig size={14} />{resourceSummary(role, "skills")}</span><span><KeyRound size={14} />{resourceSummary(role, "credentials")}</span></div>
            {role.id !== "full" ? <div className="roleCardActions"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setDraft({ ...role, skill_ids: role.skill_ids ?? [], credential_ids: role.credential_ids ?? [] }); setError(""); }}><Pencil size={14} />Edit role</Button><Button type="button" variant="ghost" size="icon" aria-label={`Delete ${role.name} role`} title={assigned(role.id) ? "Reassign members before deleting this role" : "Delete unused role"} disabled={busy || assigned(role.id) > 0} onClick={async () => { setBusy(true); setError(""); try { await onDelete(role.id); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }}><Trash2 size={15} /></Button></div> : <small className="mutedText">Owner access cannot be changed.</small>}
          </article>)}
        </div>
        {error && !draft ? <p className="accessError" role="alert">{error}</p> : null}
      </CardContent>
    </Card>
    {draft ? <Card className="roleEditor settingsCard">
      <CardHeader><div className="settingsIcon"><Pencil size={19} /></div><div><CardTitle>{draft.id ? `Edit ${draft.name}` : "Create a role"}</CardTitle><CardDescription>{draft.id ? `Changes apply to everyone assigned this role, including their API keys.` : "Start with selected skills. Add credential access only where needed."}</CardDescription></div><Button type="button" variant="ghost" size="icon" aria-label="Close role editor" disabled={busy} onClick={() => setDraft(null)}><X size={18} /></Button></CardHeader>
      <CardContent><form className="roleForm" onSubmit={event => void save(event)}>
        <div className="roleDetails"><label><span>Role name</span><Input autoFocus placeholder="e.g. Frontend developer" value={draft.name} maxLength={80} required onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label><span>Description</span><Input placeholder="Who is this role for?" value={draft.description} maxLength={500} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label></div>
        <div className="roleResourceGrid"><ResourcePicker kind="skills" resources={skills} role={draft} onChange={setDraft} /><ResourcePicker kind="credentials" resources={credentials} role={draft} onChange={setDraft} /></div>
        <fieldset className="roleKeyPermissions"><legend>API key management</legend><p className="mutedText">Members can create personal keys within their role's permissions. Allow these actions on other workspace keys:</p>{[["keys:read", "View workspace key names and status"], ["keys:revoke", "Revoke workspace keys"]].map(([scope, label]) => <label key={scope}><input type="checkbox" checked={draft.scopes.includes(scope)} onChange={event => setDraft({ ...draft, scopes: event.target.checked ? [...draft.scopes, scope] : draft.scopes.filter(value => value !== scope) })} />{label}</label>)}</fieldset>
        <div className="roleSaveBar"><div><strong>Access preview</strong><span>{resourceSummary(draft, "skills")} · {resourceSummary(draft, "credentials")}</span></div><Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" variant="accent" disabled={busy || !draft.name.trim()}><Check size={16} />{busy ? "Saving…" : "Save role"}</Button></div>
        {error ? <p className="accessError" role="alert">{error}</p> : null}
      </form></CardContent>
    </Card> : null}
  </section>;
}
