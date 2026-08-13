import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUpRight,
  Check,
  Clipboard,
  Code2,
  Command,
  Database,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  LibraryBig,
  Link2,
  LockKeyhole,
  LogOut,
  Moon,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  TerminalSquare,
  Trash2,
  Users,
  Vault,
  X,
} from "lucide-react";
import { api } from "../gonvex/_generated/api";
import { useConvex, useMutation, useQuery } from "../gonvex/_generated/react";
import { Avatar, AvatarFallback } from "./components/ui/avatar";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { getAuthErrorMessage } from "./lib/auth-error";
import { dedupeCredentials } from "./lib/credentials";
import { invitationInstructions } from "./lib/invitations";
import { isCurrentSkillRevision } from "./lib/skill-review";
import {
  readVaultTab,
  vaultURLForSkill,
  vaultURLForTab,
  vaultURLWithoutCLIAuth,
  type VaultTab,
} from "./lib/vault-state";

type SkillMeta = {
  id: string;
  name: string;
  summary: string;
  created_at: string;
  updated_at: string;
  approved: boolean;
};

type Skill = SkillMeta & {
  content: string;
};

type APIKeyRecord = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  revoked_at?: string | null;
  expires_at?: string | null;
  scopes: string[];
};

type CreateAPIKeyResult = {
  record: APIKeyRecord;
  apiKey: string;
};

type LoginResult = {
  sessionToken: string;
  expires_at: string;
  pending_only: boolean;
};

type CredentialMeta = {
  id: string;
  name: string;
  summary: string;
  created_at: string;
  updated_at: string;
};

type Credential = CredentialMeta & {
  value: string;
};

type CredentialDraft = {
  id: string;
  name: string;
  summary: string;
  value: string;
};

type CLIAuthRequest = {
  callback: string;
  state: string;
  name: string;
};

type MeResult = {
  email: string;
  name: string;
  is_owner: boolean;
  workspace_email: string;
  pending_only: boolean;
};

type TeamMember = {
  id: string;
  email: string;
  created_at: string;
  status: "active" | "pending";
};

type WorkspaceInvitation = {
  id: string;
  workspace_id: string;
  workspace_email: string;
  email: string;
  created_at: string;
};

type WorkspaceRecord = {
  id: string;
  email: string;
  is_owner: boolean;
  active: boolean;
};

type InvitationLoad = {
  status: "idle" | "loading" | "ready" | "error";
  invitations: WorkspaceInvitation[];
  error: string;
};

type SelectedSkillLoad = {
  status: "idle" | "loading" | "ready" | "error";
  skill: Skill | null;
};

type ColorTheme = "light" | "dark";

const sessionStorageKey = "whagons-skills-vault-session";
const themeStorageKey = "whagons-skills-vault-theme";
const readOnlyScopes = ["skills:read"];
const cliScopes = ["skills:read", "skills:write", "credentials:read", "credentials:write", "keys:read", "keys:revoke"];
const cliAPIKeyLifetimeDays = 365;
const emptyCredentialDraft: CredentialDraft = { id: "", name: "", summary: "", value: "" };

type StoredSession = {
  sessionToken: string;
  expiresAt: string;
};

function readStoredSession(): string {
  const raw = sessionStorage.getItem(sessionStorageKey);
  if (!raw) return "";
  try {
    const stored = JSON.parse(raw) as StoredSession;
    if (stored && typeof stored.sessionToken === "string") {
      if (stored.expiresAt && new Date(stored.expiresAt).getTime() <= Date.now()) {
        sessionStorage.removeItem(sessionStorageKey);
        return "";
      }
      return stored.sessionToken;
    }
  } catch {
    // Pre-expiry format: the raw token string.
  }
  return raw;
}

function readPreferredTheme(): ColorTheme {
  const stored = localStorage.getItem(themeStorageKey);
  const theme = stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  return theme;
}

function isInvalidSessionError(error: unknown) {
  return error instanceof Error && /invalid session|session token is required/i.test(error.message);
}
const gonvexWSURL = import.meta.env.VITE_GONVEX_WS_URL ?? "wss://gonvex-unified-dev.whagons.com/ws";
const gonvexProjectID = import.meta.env.VITE_GONVEX_PROJECT_ID ?? "skills";
const googleClientID = import.meta.env.VITE_GOOGLE_CLIENT_ID
  ?? "578623964983-iall0oeq2r2mke7trpqqv3pjingqljh0.apps.googleusercontent.com";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: { client_id: string; callback: (response: { credential?: string }) => void }) => void;
          renderButton: (element: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

function formatDate(value: string) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function countWords(value: string) {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

function displayMarkdown(value: string) {
  return value.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function shareURL(skill: SkillMeta) {
  return `${window.location.origin}${window.location.pathname}#${encodeURIComponent(skill.id)}`;
}

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function formatCredentialValue(value: string) {
  try {
    const parsed = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Credentials may be opaque tokens rather than JSON.
  }
  return value;
}

function parseLoopbackCallback(rawCallback: string): URL | null {
  try {
    const url = new URL(rawCallback);
    const loopbackHosts = ["127.0.0.1", "[::1]"];
    if (url.protocol !== "http:" || !loopbackHosts.includes(url.hostname)) return null;
    if (!url.port || url.pathname !== "/callback" || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function agentExample() {
  return `import { GonvexClient } from "@gonvex/client";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = \`\${encode({ alg: "none", typ: "JWT" })}.\${encode({
  sub: "agent",
  email: "agent@whagons.local",
})}.agent\`;

const client = new GonvexClient("wss://gonvex-unified-dev.whagons.com/ws?project=skills", {
  token,
  tenant: "skills",
});

const apiKey = process.env.WHAGONS_DEV_API_KEY;
if (!apiKey) throw new Error("WHAGONS_DEV_API_KEY is required");

const skills = await client.query(
  { kind: "query", path: "agent.skills.list" },
  { apiKey }
);

await client.mutation(
  { kind: "mutation", path: "agent.skills.upload" },
  {
    apiKey,
    id: "local-my-skill",
    name: "my-skill",
    summary: "Short trigger description",
    content: skillMarkdown,
  }
);

const skill = await client.query(
  { kind: "query", path: "agent.skills.get" },
  { apiKey, name: "whagons-monitor" }
);

const credentials = await client.query(
  { kind: "query", path: "agent.credentials.list" },
  { apiKey }
);

const credential = await client.query(
  { kind: "query", path: "agent.credentials.get" },
  { apiKey, name: "coolify-whagons" }
);

client.close();`;
}

function agentSetupInstructions() {
  return `Whagons Skills Vault — agent setup (plug and play)

Goal: give local coding agents the Whagons team's skills and project credentials with two commands.

1. Install the whagons-dev CLI:
   go install github.com/whagons/skills/cli/cmd/whagons-dev@latest

2. Configure managed skills, detected agent integrations, background sync, and CLI updates
   (the CLI opens https://skills.whagons.com on first run; click "Authorize CLI"):
   whagons-dev setup

   To link skills into every supported agent target:
   whagons-dev setup --targets all

The copied setup never includes a live key. The CLI opens the browser for an explicit,
scoped authorization. If a key was created manually, copy it separately and provide it
to \`whagons-dev auth set-key --stdin\` through a secure channel.

That's it. From then on:
- Refresh skills any time: whagons-dev skills update
- Update the CLI now: whagons-dev --update
- Inspect integrations/background sync: whagons-dev skills status
- See what credentials exist: whagons-dev credentials list
- Run anything that needs a secret WITHOUT printing it:
  whagons-dev credentials exec coolify-whagons -- <command> [args...]
  (the credential is provided through a temporary mode-0600 file by default)

Context:
- The vault at https://skills.whagons.com stores Whagons-specific agent skills and
  project credentials, shared across the workspace's invited team members.
- The API key grants access to this workspace only. Anyone on the team can be invited
  by the workspace owner from the Team tab.
- Do not print API keys, credential values, OAuth tokens, or full secret JSON.

Other useful commands:
whagons-dev skills list
whagons-dev skills get whagons-monitor --output ./SKILL.md
whagons-dev skills copy whagons-monitor
whagons-dev skills upload ./my-skill/SKILL.md
whagons-dev skills sync ./skills
whagons-dev skills install --targets all
whagons-dev startup status
whagons-dev auth status

Direct Gonvex API path for custom scripts:
1. npm install @gonvex/client
2. Runtime: ${gonvexWSURL}  ·  project/tenant: ${gonvexProjectID}
3. Call agent endpoints with the API key:
${agentExample()}

Security rules:
- Use credentials exec for commands that need secrets.
- If using agent.credentials.get directly, pass the value only into the command that
  needs it and never echo it.
- The CLI stores its config at ~/.whagons-dev/config.json with mode 0600.
- Canonical vault skills live in ~/.whagons-dev/skills and are linked into supported
  agent directories. Signed ownership metadata lets the CLI prune only its own files.
- Keep uploaded skills universal; avoid private machine paths or one-person local
  assumptions unless the skill is explicitly local-infra scoped.`;
}

export default function App() {
  const [sessionToken, setSessionToken] = useState(readStoredSession);
  const [theme, setTheme] = useState<ColorTheme>(readPreferredTheme);
  const googleButtonRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [cliAuthRequest, setCliAuthRequest] = useState<CLIAuthRequest | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const callback = params.get("cli_callback");
    if (!callback) return null;
    return {
      callback,
      state: params.get("cli_state") ?? "",
      name: params.get("cli_name") ?? "Whagons Dev CLI",
    };
  });
  const [authError, setAuthError] = useState("");
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<VaultTab>(() => readVaultTab(window.location.href));
  const [selectedID, setSelectedID] = useState(() => decodeURIComponent(window.location.hash.replace(/^#/, "")));
  const [notice, setNotice] = useState("");
  const [freshAPIKey, setFreshAPIKey] = useState("");
  const [apiKeyName, setAPIKeyName] = useState("");
  const [apiKeyScopes, setAPIKeyScopes] = useState<string[]>(readOnlyScopes);
  const [apiKeyExpiry, setAPIKeyExpiry] = useState("30");
  const [credentialDraft, setCredentialDraft] = useState<CredentialDraft>(emptyCredentialDraft);
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [credentialSecrets, setCredentialSecrets] = useState<Record<string, string>>({});
  const [credentialLoadingID, setCredentialLoadingID] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitationReload, setInvitationReload] = useState(0);
  const [invitationLoad, setInvitationLoad] = useState<InvitationLoad>({ status: "idle", invitations: [], error: "" });
  const [selectedSkillLoad, setSelectedSkillLoad] = useState<SelectedSkillLoad>({ status: "idle", skill: null });

  const gonvex = useConvex();
  const protectedArgs = sessionToken ? { sessionToken } : "skip";
  const me = useQuery<MeResult>(api.auth.me, protectedArgs) ?? null;
  const activeWorkspaceArgs = sessionToken && me && !me.pending_only ? { sessionToken } : "skip";
  const skills = useQuery<SkillMeta[]>(api.skills.list, activeWorkspaceArgs) ?? [];
  const apiKeys = useQuery<APIKeyRecord[]>(api.apiKeys.list, activeWorkspaceArgs) ?? [];
  const credentialRecords = useQuery<CredentialMeta[]>(api.credentials.list, activeWorkspaceArgs) ?? [];
  const teamMembers = useQuery<TeamMember[]>(api.team.list, activeWorkspaceArgs) ?? [];
  const workspaces = useQuery<WorkspaceRecord[]>(api.auth.workspaces, protectedArgs) ?? [];
  const login = useMutation(api.auth.login);
  const logout = useMutation(api.auth.logout);
  const switchWorkspace = useMutation(api.auth.switchWorkspace);
  const deleteSkill = useMutation(api.skills.delete);
  const approveSkill = useMutation(api.skills.approve);
  const createAPIKey = useMutation(api.apiKeys.create);
  const revokeAPIKey = useMutation(api.apiKeys.revoke);
  const getCredential = useMutation(api.credentials.get);
  const saveCredential = useMutation(api.credentials.save);
  const deleteCredential = useMutation(api.credentials.delete);
  const inviteMember = useMutation(api.team.invite);
  const removeMember = useMutation(api.team.remove);
  const acceptInvitation = useMutation(api.team.invitations.accept);
  const rejectInvitation = useMutation(api.team.invitations.reject);
  const isWorkspaceOwner = me?.is_owner ?? true;
  const cliCallbackURL = cliAuthRequest?.state ? parseLoopbackCallback(cliAuthRequest.callback) : null;

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => {
      return [skill.name, skill.summary].some((value) => value.toLowerCase().includes(needle));
    });
  }, [query, skills]);

  const selectedSkill = skills.find((skill) => skill.id === selectedID) ?? filteredSkills[0] ?? skills[0] ?? null;
  const selectedSkillFull = isCurrentSkillRevision(selectedSkill, selectedSkillLoad.skill) ? selectedSkillLoad.skill : null;
  const selectedContent = selectedSkillFull?.id === selectedSkill?.id ? selectedSkillFull?.content ?? null : null;
  const selectedSkillApproved = selectedSkillFull?.approved ?? selectedSkill?.approved ?? false;
  const invitations = invitationLoad.invitations;
  const activeTeamMembers = teamMembers.filter((member) => member.status !== "pending");
  const pendingTeamMembers = teamMembers.filter((member) => member.status === "pending");
  const activeAPIKeys = apiKeys.filter((key) => !key.revoked_at && (!key.expires_at || new Date(key.expires_at).getTime() > Date.now()));
  const credentials = useMemo(() => dedupeCredentials(credentialRecords), [credentialRecords]);

  useEffect(() => {
    if (!sessionToken || !me || me.pending_only || !selectedSkill) {
      setSelectedSkillLoad({ status: "idle", skill: null });
      return;
    }

    let cancelled = false;
    setSelectedSkillLoad((current) => isCurrentSkillRevision(selectedSkill, current.skill)
      ? current
      : { status: "loading", skill: null });
    void gonvex.query<Skill>(api.skills.get, { sessionToken, id: selectedSkill.id })
      .then((skill) => {
        if (!cancelled) setSelectedSkillLoad({ status: "ready", skill });
      })
      .catch(() => {
        if (!cancelled) setSelectedSkillLoad({ status: "error", skill: null });
      });

    return () => {
      cancelled = true;
    };
  }, [gonvex, me?.pending_only, selectedSkill?.id, selectedSkill?.updated_at, sessionToken]);

  useEffect(() => {
    if (!sessionToken) {
      setInvitationLoad({ status: "idle", invitations: [], error: "" });
      return;
    }

    let cancelled = false;
    setInvitationLoad({ status: "loading", invitations: [], error: "" });
    void gonvex.query<WorkspaceInvitation[]>(api.team.invitations.list, { sessionToken })
      .then((result) => {
        if (!cancelled) setInvitationLoad({ status: "ready", invitations: result, error: "" });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Unknown query error";
        setInvitationLoad({ status: "error", invitations: [], error: message });
      });

    return () => {
      cancelled = true;
    };
  }, [gonvex, invitationReload, sessionToken]);

  function changeVaultTab(tab: VaultTab) {
    setActiveTab(tab);
    const nextURL = vaultURLForTab(window.location.href, tab);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextURL !== current) {
      window.history.pushState(null, "", nextURL);
    }
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    if (!selectedSkill) return;
    if (selectedID !== selectedSkill.id) {
      setSelectedID(selectedSkill.id);
    }
  }, [selectedID, selectedSkill]);

  useEffect(() => {
    function onHashChange() {
      setSelectedID(decodeURIComponent(window.location.hash.replace(/^#/, "")));
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    function onPopState() {
      setActiveTab(readVaultTab(window.location.href));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    function onSearchShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        changeVaultTab("skills");
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    }
    window.addEventListener("keydown", onSearchShortcut);
    return () => window.removeEventListener("keydown", onSearchShortcut);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!freshAPIKey) return;
    const timeout = window.setTimeout(() => setFreshAPIKey(""), 60_000);
    return () => window.clearTimeout(timeout);
  }, [freshAPIKey]);

  useEffect(() => {
    if (sessionToken || !googleClientID || !googleButtonRef.current) return;

    let cancelled = false;
    const render = () => {
      if (cancelled || !window.google || !googleButtonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: googleClientID,
        callback: (response) => {
          if (response.credential) {
            void signInWithGoogle(response.credential);
          } else {
            setAuthError("Google did not return an identity token.");
          }
        },
      });
      googleButtonRef.current.innerHTML = "";
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: "filled_black",
        size: "large",
        type: "standard",
        shape: "pill",
        text: "continue_with",
        width: 280,
      });
    };

    if (window.google) {
      render();
      return () => {
        cancelled = true;
      };
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = render;
    script.onerror = () => setAuthError("Could not load Google sign-in.");
    document.head.appendChild(script);
    return () => {
      cancelled = true;
    };
  }, [sessionToken]);

  async function signInWithGoogle(idToken: string) {
    setAuthError("");
    try {
      const result = await login({ idToken }) as LoginResult;
      const stored: StoredSession = { sessionToken: result.sessionToken, expiresAt: result.expires_at };
      sessionStorage.setItem(sessionStorageKey, JSON.stringify(stored));
      setSessionToken(result.sessionToken);
      setAuthError("");
    } catch (error) {
      console.error("[skills] Google login failed", error);
      setAuthError(getAuthErrorMessage(error));
    }
  }

  // Wraps session-backed actions: an expired/revoked session drops back to the
  // login screen instead of failing silently; other errors surface as a toast.
  async function runGuarded(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      if (isInvalidSessionError(error)) {
        sessionStorage.removeItem(sessionStorageKey);
        setSessionToken("");
        setAuthError("Your session expired. Sign in again.");
        return;
      }
      setNotice(error instanceof Error ? error.message : "Something went wrong");
    }
  }

  async function copyText(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setNotice(label);
  }

  async function removeSkill(skill: SkillMeta) {
    await runGuarded(async () => {
      await deleteSkill({ sessionToken, id: skill.id });
      setNotice("Deleted skill");
    });
  }

  async function makeAPIKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = apiKeyName.trim();
    if (!name) return;
    await runGuarded(async () => {
      const neverExpires = apiKeyExpiry === "never";
      const result = await createAPIKey({
        sessionToken,
        name,
        scopes: apiKeyScopes,
        expires_in_days: neverExpires ? 0 : Number(apiKeyExpiry),
        never_expires: neverExpires,
      }) as CreateAPIKeyResult;
      setFreshAPIKey(result.apiKey);
      setAPIKeyName("");
      setNotice(`Created ${result.record.name}`);
    });
  }

  function toggleAPIKeyScope(scope: string) {
    setAPIKeyScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]);
  }

  async function authorizeCLI() {
    if (!cliAuthRequest || !cliCallbackURL) return;
    await runGuarded(async () => {
      await deliverCLIKey(cliAuthRequest, cliCallbackURL);
    });
  }

  async function deliverCLIKey(request: CLIAuthRequest, callbackURL: URL) {
    const result = await createAPIKey({
      sessionToken,
      name: `${request.name} ${new Date().toLocaleString()}`,
      scopes: cliScopes,
      expires_in_days: cliAPIKeyLifetimeDays,
    }) as CreateAPIKeyResult;
    const payload = {
      api_key: result.apiKey,
      state: request.state,
    };
    try {
      // POST keeps the API key out of browser history. The CLI's loopback
      // server answers with CORS headers.
      const response = await fetch(callbackURL.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error(`callback returned ${response.status}`);
      setCliAuthRequest(null);
      window.history.replaceState(null, "", vaultURLWithoutCLIAuth(window.location.href));
      setNotice("CLI authorized — return to your terminal");
    } catch (error) {
      await revokeAPIKey({ sessionToken, id: result.record.id }).catch(() => undefined);
      throw new Error(`Could not deliver the CLI key; it was revoked. ${error instanceof Error ? error.message : ""}`.trim());
    }
  }

  async function signOut() {
    try {
      await logout({ sessionToken });
    } catch {
      // Session may already be expired; clear it locally regardless.
    }
    sessionStorage.removeItem(sessionStorageKey);
    setFreshAPIKey("");
    setSessionToken("");
  }

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    await runGuarded(async () => {
      await inviteMember({ sessionToken, email }) as TeamMember;
      setInviteEmail("");
      setNotice(`Invitation created for ${email}. Copy and send the sign-in instructions.`);
    });
  }

  async function copyInvitation(member: TeamMember) {
    await copyText(
      invitationInstructions(member.email, window.location.origin),
      `Copied invitation instructions for ${member.email}`,
    );
  }

  async function dropMember(member: TeamMember) {
    await runGuarded(async () => {
      await removeMember({ sessionToken, id: member.id });
      setNotice(member.status === "pending" ? `Cancelled invitation for ${member.email}` : `Removed ${member.email}`);
    });
  }

  async function storeCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (credentialSaving) return;
    setCredentialSaving(true);
    try {
      await runGuarded(async () => {
        await saveCredential({ sessionToken, ...credentialDraft });
        setCredentialSecrets((current) => {
          if (!credentialDraft.id) return current;
          const next = { ...current };
          delete next[credentialDraft.id];
          return next;
        });
        setCredentialDraft(emptyCredentialDraft);
        setNotice(credentialDraft.id ? "Updated credential" : "Stored credential");
      });
    } finally {
      setCredentialSaving(false);
    }
  }

  async function loadCredential(credential: CredentialMeta) {
    return getCredential({ sessionToken, id: credential.id, name: "" }) as Promise<Credential>;
  }

  async function editCredential(credential: CredentialMeta) {
    setCredentialLoadingID(credential.id);
    try {
      await runGuarded(async () => {
        const full = await loadCredential(credential);
        setCredentialDraft({
          id: credential.id,
          name: credential.name,
          summary: credential.summary,
          value: full.value,
        });
        setNotice(`Editing ${credential.name}`);
      });
    } finally {
      setCredentialLoadingID("");
    }
  }

  async function toggleCredentialValue(credential: CredentialMeta) {
    if (credentialSecrets[credential.id] !== undefined) {
      setCredentialSecrets((current) => {
        const next = { ...current };
        delete next[credential.id];
        return next;
      });
      return;
    }
    setCredentialLoadingID(credential.id);
    try {
      await runGuarded(async () => {
        const full = await loadCredential(credential);
        setCredentialSecrets((current) => ({ ...current, [credential.id]: full.value }));
      });
    } finally {
      setCredentialLoadingID("");
    }
  }

  async function copyCredentialValue(credential: CredentialMeta) {
    setCredentialLoadingID(credential.id);
    try {
      await runGuarded(async () => {
        const full = await loadCredential(credential);
        await copyText(full.value, `Copied ${credential.name} value`);
      });
    } finally {
      setCredentialLoadingID("");
    }
  }

  async function respondToInvitation(invitation: WorkspaceInvitation, accept: boolean) {
    await runGuarded(async () => {
      if (accept) {
        await acceptInvitation({ sessionToken, id: invitation.id });
        window.location.reload();
        return;
      }
      await rejectInvitation({ sessionToken, id: invitation.id });
      if (me?.pending_only) {
        await signOut();
      } else {
        setInvitationLoad((current) => ({
          ...current,
          invitations: current.invitations.filter((item) => item.id !== invitation.id),
        }));
        setNotice("Invitation rejected");
      }
    });
  }

  async function chooseWorkspace(workspace: WorkspaceRecord) {
    if (workspace.active) return;
    await runGuarded(async () => {
      await switchWorkspace({ sessionToken, workspace_id: workspace.id });
      window.location.reload();
    });
  }

  if (!sessionToken) {
    return (
      <main className="authPage">
        <section className="authStory" aria-label="Whagons Skills Vault">
          <div className="authAmbient authAmbientOne" />
          <div className="authAmbient authAmbientTwo" />

          <div className="brandSignature">
            <div className="brandMark"><Command size={18} strokeWidth={2.4} /></div>
            <div>
              <strong>Whagons</strong>
              <span>Agent infrastructure</span>
            </div>
          </div>

          <div className="authStatement">
            <Badge variant="accent"><Sparkles size={12} /> Private knowledge system</Badge>
            <h1>Give your agents<br /><em>better instincts.</em></h1>
            <p>One secure home for the skills, credentials, and access your team uses to get real work done.</p>
          </div>

          <div className="authArtifact" aria-hidden="true">
            <div className="artifactRail">
              <span>01</span>
              <span>02</span>
              <span>03</span>
            </div>
            <div className="artifactCards">
              <div className="artifactCard artifactCardBack">
                <span className="artifactIcon"><Database size={15} /></span>
                <span>Project credentials</span>
                <small>Encrypted · workspace scoped</small>
              </div>
              <div className="artifactCard artifactCardMiddle">
                <span className="artifactIcon"><TerminalSquare size={15} /></span>
                <span>whagons-monitor</span>
                <small>Release intelligence</small>
              </div>
              <div className="artifactCard artifactCardFront">
                <div className="artifactCardTop">
                  <span className="artifactIcon"><LibraryBig size={15} /></span>
                  <Badge variant="outline">SKILL.md</Badge>
                </div>
                <strong>Operational memory,<br />ready on demand.</strong>
                <div className="artifactLines"><i /><i /><i /></div>
              </div>
            </div>
          </div>

          <div className="authStoryFooter">
            <span><i className="statusDot" /> Gonvex runtime</span>
            <span>gonvex-unified-dev.whagons.com</span>
          </div>
        </section>

        <section className="authPanel">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="themeToggle authThemeToggle"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </Button>
          <div className="authPanelInner">
            <div className="authMobileBrand">
              <div className="brandMark"><Command size={18} /></div>
              <strong>Whagons</strong>
            </div>
            <Card className="authCard">
              <CardHeader className="authHeader">
                <div className="authIcon"><LockKeyhole size={21} /></div>
                <div>
                  <p className="eyebrow">Protected workspace</p>
                  <CardTitle>Enter the vault</CardTitle>
                  <CardDescription>
                    {cliAuthRequest ? `Sign in to authorize ${cliAuthRequest.name}.` : "Continue with your approved or invited Google account."}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <div className="authForm">
                  <div className="googleButtonHost" ref={googleButtonRef} aria-label="Sign in with Google" />
                  {authError ? <div className="authError">{authError}</div> : null}
                  {!cliAuthRequest ? <span className="mutedText">Invited? Use the exact Google email address the workspace owner entered.</span> : null}
                </div>
                <div className="authTrustRow">
                  <ShieldCheck size={16} />
                  <span>Workspace-scoped access<br /><small>Sessions expire automatically</small></span>
                </div>
              </CardContent>
            </Card>
            <p className="authFootnote">Internal tools · Whagons team only</p>
          </div>
        </section>
      </main>
    );
  }

  if (me?.pending_only) {
    return (
      <main className="authPage">
        <section className="authStory" aria-label="Pending workspace invitation">
          <div className="authAmbient authAmbientOne" />
          <div className="brandSignature">
            <div className="brandMark"><Command size={18} /></div>
            <div><strong>Whagons</strong><span>Skills vault</span></div>
          </div>
          <div className="authStatement">
            <Badge variant="accent"><ShieldCheck size={12} /> Explicit access</Badge>
            <h1>Choose your<br /><em>workspace.</em></h1>
            <p>An invitation never redirects your account automatically. Review who invited you before joining.</p>
          </div>
        </section>
        <section className="authPanel">
          <div className="authPanelInner">
            <Card className="authCard">
              <CardHeader className="authHeader">
                <div className="authIcon"><Users size={21} /></div>
                <div><p className="eyebrow">Pending invitation</p><CardTitle>Join a workspace?</CardTitle><CardDescription>Accepting grants access to its skills and credentials.</CardDescription></div>
              </CardHeader>
              <CardContent className="apiContent">
                {invitationLoad.status === "loading" || invitationLoad.status === "idle" ? (
                  <span className="mutedText">Loading your invitation…</span>
                ) : invitationLoad.status === "error" ? (
                  <div className="invitationError">
                    <span className="mutedText">Could not load the invitation: {invitationLoad.error}</span>
                    <Button type="button" variant="outline" onClick={() => setInvitationReload((current) => current + 1)}>Retry</Button>
                  </div>
                ) : invitations.length === 0 ? <span className="mutedText">No active invitation was found. Sign out and ask the owner to invite you again.</span> : invitations.map((invitation) => (
                  <div className="keyRow" key={invitation.id}>
                    <div><strong>{invitation.workspace_email || "Whagons workspace"}</strong><span>Invited {formatDate(invitation.created_at)}</span></div>
                    <div className="rowActions">
                      <Button type="button" variant="accent" onClick={() => void respondToInvitation(invitation, true)}>Accept</Button>
                      <Button type="button" variant="ghost" onClick={() => void respondToInvitation(invitation, false)}>Reject</Button>
                    </div>
                  </div>
                ))}
                <Button type="button" variant="outline" onClick={() => void signOut()}><LogOut size={16} /> Sign out</Button>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="vaultPage">
      <aside className="vaultSidebar" aria-label="Skills">
        <div className="brandBlock">
          <div className="brandIdentity">
            <div className="brandMark"><Command size={18} strokeWidth={2.4} /></div>
            <div>
              <strong>Whagons</strong>
              <span>Skills vault</span>
            </div>
          </div>
          <Badge variant="accent">{skills.length}</Badge>
        </div>

        <div className="tabNav" aria-label="Vault sections">
          <button className={activeTab === "skills" ? "tabButton active" : "tabButton"} type="button" onClick={() => changeVaultTab("skills")}>
            <span className="tabIcon"><LibraryBig size={17} /></span>
            <span>Skills</span>
            <small>{skills.length.toString().padStart(2, "0")}</small>
          </button>
          <button className={activeTab === "apiKeys" ? "tabButton active" : "tabButton"} type="button" onClick={() => changeVaultTab("apiKeys")}>
            <span className="tabIcon"><Fingerprint size={17} /></span>
            <span>API keys</span>
            <small>{activeAPIKeys.length.toString().padStart(2, "0")}</small>
          </button>
          <button className={activeTab === "credentials" ? "tabButton active" : "tabButton"} type="button" onClick={() => changeVaultTab("credentials")}>
            <span className="tabIcon"><Vault size={17} /></span>
            <span>Credentials</span>
            <small>{credentials.length.toString().padStart(2, "0")}</small>
          </button>
          <button className={activeTab === "team" ? "tabButton active" : "tabButton"} type="button" onClick={() => changeVaultTab("team")}>
            <span className="tabIcon"><Users size={17} /></span>
            <span>Team</span>
            <small>{teamMembers.length.toString().padStart(2, "0")}</small>
          </button>
        </div>

        {activeTab === "skills" ? (
          <div className="skillLibrary">
            <div className="sidebarTools">
              <p className="sidebarLabel">Library</p>
              <div className="searchBox">
                <Search size={16} />
                <Input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a skill..."
                  aria-label="Search skills"
                />
                <kbd>⌘ K</kbd>
              </div>
            </div>
            <div className="skillScroll" tabIndex={0} aria-label="Skill library">
              {filteredSkills.length === 0 ? (
                <div className="emptyState">
                  <Code2 size={28} />
                  <strong>No matching skills</strong>
                  <span>Clear search or upload through the agent API.</span>
                </div>
              ) : filteredSkills.map((skill) => (
                <button
                  className={skill.id === selectedSkill?.id ? "skillRow active" : "skillRow"}
                  key={skill.id}
                  type="button"
                  onClick={() => {
                    setSelectedID(skill.id);
                    window.history.replaceState(null, "", vaultURLForSkill(window.location.href, skill.id));
                  }}
                >
                  <span className="skillRowIndex">{String(filteredSkills.indexOf(skill) + 1).padStart(2, "0")}</span>
                  <span className="skillRowCopy">
                    <span className="skillRowTitle">{skill.name}</span>
                    <span className="skillRowMeta">{skill.summary || `Updated ${formatDate(skill.updated_at)}`}</span>
                  </span>
                  <ArrowUpRight className="skillRowArrow" size={15} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="sidebarHint">
            <div className="sidebarHintIcon">
              {activeTab === "apiKeys" ? <Fingerprint size={20} /> : activeTab === "credentials" ? <Vault size={20} /> : <Users size={20} />}
            </div>
            <strong>
              {activeTab === "apiKeys" ? `${activeAPIKeys.length} active keys`
                : activeTab === "credentials" ? `${credentials.length} credentials`
                : `${activeTeamMembers.length} active · ${pendingTeamMembers.length} pending`}
            </strong>
            <span>
              {activeTab === "apiKeys" ? "Create and revoke agent access."
                : activeTab === "credentials" ? "Store secrets for CLI and agents."
                : "Share this workspace with teammates."}
            </span>
          </div>
        )}

        <div className="sidebarAccount">
          <Avatar>
            <AvatarFallback>{(me?.name || me?.email || "W").slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="sidebarAccountInfo">
            <strong>{me?.name || me?.email || "Whagons member"}</strong>
            {me && !me.is_owner ? <span>{me.workspace_email || "Shared workspace"}</span> : <span>{me?.email ?? "Owner workspace"}</span>}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Sign out" onClick={() => void signOut()}>
                <LogOut size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Sign out</TooltipContent>
          </Tooltip>
        </div>
      </aside>

      <section className="vaultMain">
        <div className="workspaceBar">
          <span className="workspaceName"><ShieldCheck size={14} /> Private workspace</span>
          <div className="workspaceControls">
            <span className="runtimeStatus"><i className="statusDot" /> Gonvex live</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="themeToggle"
                  aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
                  onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
                >
                  {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Switch to {theme === "dark" ? "light" : "dark"} mode</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {cliAuthRequest ? (
          <div className="cliAuthBanner">
            <div className="cliAuthIcon"><TerminalSquare size={21} /></div>
            <div className="cliAuthCopy">
              <p className="eyebrow">CLI authorization request</p>
              <h3>Connect {cliAuthRequest.name}</h3>
              {cliCallbackURL ? (
                <p>Create a scoped key valid for one year and send it to <code>{cliCallbackURL.origin}</code> on this machine.</p>
              ) : (
                <p className="authError">Blocked: callback {cliAuthRequest.callback} is not a local (127.0.0.1) address, so it cannot be a CLI on this machine.</p>
              )}
            </div>
            <div className="primaryActions">
              {cliCallbackURL ? (
                <Button type="button" variant="accent" onClick={() => void authorizeCLI()}>
                  <KeyRound size={16} />
                  Authorize CLI
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Dismiss CLI authorization"
                onClick={() => {
                  setCliAuthRequest(null);
                  window.history.replaceState(null, "", vaultURLWithoutCLIAuth(window.location.href));
                }}
              >
                <X size={16} />
              </Button>
            </div>
          </div>
        ) : null}
        {!cliAuthRequest && invitations.length > 0 && activeTab !== "team" ? (
          <div className="cliAuthBanner">
            <div className="cliAuthIcon"><Users size={21} /></div>
            <div className="cliAuthCopy">
              <p className="eyebrow">Workspace invitation</p>
              <h3>{invitations.length === 1 ? "A workspace is waiting" : `${invitations.length} workspaces are waiting`}</h3>
              <p>Review who invited you before accepting access to shared skills and credentials.</p>
            </div>
            <Button type="button" variant="accent" onClick={() => changeVaultTab("team")}>
              Review invitation
            </Button>
          </div>
        ) : null}
        {activeTab === "skills" && selectedSkill ? (
          <>
            <header className="mainHeader">
              <div className="headerCopy">
                <p className="eyebrow"><span>Skill dossier</span> / {selectedSkill.id.slice(0, 8)}</p>
                <h2>{selectedSkill.name}</h2>
                <p className="summaryLine">{selectedSkill.summary || "A team instruction set ready for agents to use."}</p>
              </div>
              <div className="primaryActions">
                {!selectedSkillApproved && isWorkspaceOwner ? (
                  <Button type="button" variant="accent" onClick={() => void runGuarded(async () => {
                    const approved = await approveSkill({ sessionToken, id: selectedSkill.id }) as Skill;
                    setSelectedSkillLoad({ status: "ready", skill: approved });
                    setNotice("Approved skill for agent installation");
                  })} disabled={selectedSkillFull === null}>
                    <ShieldCheck size={16} /> Approve
                  </Button>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      aria-label="Copy skill"
                      disabled={selectedContent === null}
                      onClick={() => selectedContent !== null && void copyText(selectedContent, "Copied skill")}
                    >
                      <Clipboard size={16} />
                      Copy
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Copy the full SKILL.md</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      aria-label="Copy share link"
                      onClick={() => void copyText(shareURL(selectedSkill), "Copied share link")}
                    >
                      <Link2 size={16} />
                      Share
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Copy a deep link</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete skill"
                      className="dangerButton"
                      onClick={() => void removeSkill(selectedSkill)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete skill</TooltipContent>
                </Tooltip>
              </div>
            </header>

            <div className="libraryLayout">
              <section className="readerPane">
                <div className="readerTopline">
                  <div className="documentIdentity">
                    <span className="documentIcon"><Code2 size={17} /></span>
                    <div><strong>SKILL.md</strong><small>Rendered document</small></div>
                  </div>
                  <div className="metaStrip">
                    <Badge variant={selectedSkillApproved ? "accent" : "outline"}>{selectedSkillApproved ? "Approved" : "Review required"}</Badge>
                    {selectedContent !== null ? (
                      <>
                        <Badge variant="muted">{countWords(selectedContent).toLocaleString()} words</Badge>
                        <Badge variant="muted">{selectedContent.length.toLocaleString()} chars</Badge>
                      </>
                    ) : (
                      <Badge variant="muted">Loading…</Badge>
                    )}
                    <Badge variant="outline">Updated {formatDate(selectedSkill.updated_at)}</Badge>
                  </div>
                </div>
                <article className="markdownDoc">
                  {selectedContent !== null ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        img: ({ alt }) => <span className="mutedText">[Remote image blocked{alt ? `: ${alt}` : ""}]</span>,
                        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
                      }}
                    >
                      {displayMarkdown(selectedContent)}
                    </ReactMarkdown>
                  ) : null}
                </article>
              </section>
            </div>
          </>
        ) : activeTab === "skills" ? (
          <div className="emptyMain">
            <div className="emptyIcon"><LibraryBig size={26} /></div>
            <p className="eyebrow">Empty library</p>
            <h2>Your first skill belongs here.</h2>
            <p>Create an API key and let agents upload skills into the vault.</p>
            <Button variant="accent" onClick={() => changeVaultTab("apiKeys")}><KeyRound size={16} /> Create API key</Button>
          </div>
        ) : null}

        {activeTab === "apiKeys" ? (
          <>
            <header className="mainHeader">
              <div className="headerCopy">
                <p className="eyebrow"><span>Access control</span> / Agents</p>
                <h2>API keys</h2>
                <p className="summaryLine">Create keys for the CLI and agents. New key values are shown once.</p>
              </div>
              <div className="primaryActions">
                <Button type="button" variant="outline" onClick={() => void copyText(agentSetupInstructions(), "Copied agent setup")}>
                  <Clipboard size={16} />
                  Copy setup
                </Button>
              </div>
            </header>
            <div className="settingsLayout">
              <Card className="settingsCard">
                <CardHeader>
                  <div className="settingsIcon"><Fingerprint size={19} /></div>
                  <div><CardTitle>Active keys</CardTitle><CardDescription>Keys with live access to this workspace.</CardDescription></div>
                </CardHeader>
                <CardContent className="apiContent">
                  <form className="apiKeyCreateForm" onSubmit={(event) => void makeAPIKey(event)}>
                    <label>
                      <span>Name this key</span>
                      <Input
                        value={apiKeyName}
                        onChange={(event) => setAPIKeyName(event.target.value)}
                        placeholder="e.g. Gabriel's laptop"
                        maxLength={80}
                        autoComplete="off"
                        required
                      />
                    </label>
                    <fieldset className="scopeFieldset">
                      <legend>Permissions</legend>
                      {[
                        ["skills:read", "Read approved skills"],
                        ["skills:write", "Upload skills for review"],
                        ["credentials:read", "Use credentials"],
                        ["credentials:write", "Manage credentials"],
                        ["keys:read", "List API keys"],
                        ["keys:revoke", "Revoke other keys"],
                      ].map(([scope, label]) => (
                        <label key={scope}><input type="checkbox" checked={apiKeyScopes.includes(scope)} onChange={() => toggleAPIKeyScope(scope)} /><span>{label}</span></label>
                      ))}
                    </fieldset>
                    <label>
                      <span>Expires after</span>
                      <select value={apiKeyExpiry} onChange={(event) => setAPIKeyExpiry(event.target.value)}>
                        <option value={7}>7 days</option>
                        <option value={30}>30 days</option>
                        <option value={90}>90 days</option>
                        <option value={365}>1 year</option>
                        <option value="never">Never expires</option>
                      </select>
                    </label>
                    <Button type="submit" variant="accent" disabled={apiKeyScopes.length === 0}>
                      <KeyRound size={16} />
                      Create key
                    </Button>
                  </form>
                  {freshAPIKey ? (
                    <div className="freshKey">
                      <div><Badge variant="accent">New key</Badge><span>Copy it now — it won&apos;t be shown again.</span></div>
                      <code>{freshAPIKey}</code>
                      <Button type="button" onClick={() => void copyText(freshAPIKey, "Copied API key")}>
                        <Clipboard size={16} />
                        Copy key
                      </Button>
                    </div>
                  ) : null}
                  <div className="keyList">
                    {activeAPIKeys.length === 0 ? (
                      <span className="mutedText">No active API keys.</span>
                    ) : activeAPIKeys.map((key) => (
                      <div className="keyRow" key={key.id}>
                        <div>
                          <strong>{key.name}</strong>
                          <span>{key.prefix}... · {key.expires_at ? `Expires ${formatDate(key.expires_at)}` : "Never expires"} · {key.scopes.join(", ")}</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          className="dangerButton"
                          onClick={() => void runGuarded(async () => {
                            await revokeAPIKey({ sessionToken, id: key.id });
                            setNotice("Revoked API key");
                          })}
                        >
                          Revoke
                        </Button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card className="settingsCard codeCard">
                <CardHeader>
                  <div className="settingsIcon"><TerminalSquare size={19} /></div>
                  <div><CardTitle>Agent handoff</CardTitle><CardDescription>A complete bootstrap prompt for Codex or another agent.</CardDescription></div>
                  <Button type="button" variant="outline" size="sm" onClick={() => void copyText(agentSetupInstructions(), "Copied agent handoff")}>
                    <Clipboard size={16} />
                    Copy
                  </Button>
                </CardHeader>
                <CardContent className="apiContent">
                  <div className="apiCode">
                    <pre>{agentSetupInstructions()}</pre>
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        ) : null}

        {activeTab === "credentials" ? (
          <>
            <header className="mainHeader">
              <div className="headerCopy">
                <p className="eyebrow"><span>Secure storage</span> / Secrets</p>
                <h2>Credentials</h2>
                <p className="summaryLine">Store credentials for the CLI and agents. Values stay hidden until you explicitly reveal or copy them.</p>
              </div>
            </header>
            <div className="settingsLayout settingsColumns">
              <Card className="settingsCard">
                <CardHeader>
                  <div className="settingsIcon">{credentialDraft.id ? <Pencil size={19} /> : <Plus size={19} />}</div>
                  <div>
                    <CardTitle>{credentialDraft.id ? "Edit credential" : "Store a credential"}</CardTitle>
                    <CardDescription>{credentialDraft.id ? "Update the selected workspace secret by ID." : "Save a new workspace secret."}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="apiContent">
                  <form className="credentialForm" onSubmit={(event) => void storeCredential(event)}>
                    <label><span>Name</span><Input value={credentialDraft.name} onChange={(event) => setCredentialDraft((current) => ({ ...current, name: event.target.value }))} placeholder="coolify-whagons" required /></label>
                    <label><span>Description</span><Input value={credentialDraft.summary} onChange={(event) => setCredentialDraft((current) => ({ ...current, summary: event.target.value }))} placeholder="What this credential unlocks" /></label>
                    <label><span>Secret value</span><Input value={credentialDraft.value} onChange={(event) => setCredentialDraft((current) => ({ ...current, value: event.target.value }))} placeholder="Paste the secret value" type="password" autoComplete="new-password" maxLength={262144} required /></label>
                    <div className="credentialFormActions">
                      <Button type="submit" variant="accent" disabled={credentialSaving}>
                        {credentialDraft.id ? <Pencil size={16} /> : <Plus size={16} />}
                        {credentialSaving ? "Saving…" : credentialDraft.id ? "Update credential" : "Store credential"}
                      </Button>
                      {credentialDraft.id ? (
                        <Button type="button" variant="ghost" onClick={() => setCredentialDraft(emptyCredentialDraft)}>
                          <X size={16} />
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                  </form>
                </CardContent>
              </Card>

              <Card className="settingsCard">
                <CardHeader>
                  <div className="settingsIcon"><Vault size={19} /></div>
                  <div><CardTitle>Credential vault</CardTitle><CardDescription>{credentials.length} encrypted workspace entries.</CardDescription></div>
                </CardHeader>
                <CardContent className="apiContent">
                  <div className="keyList">
                    {credentials.length === 0 ? (
                      <span className="mutedText">No project credentials stored.</span>
                    ) : credentials.map((credential) => (
                      <div className="keyRow credentialRow" key={credential.id}>
                        <div className="credentialIdentity">
                          <strong>{credential.name}</strong>
                          <span>{credential.summary || `Updated ${formatDate(credential.updated_at)}`}</span>
                        </div>
                        {credentialSecrets[credential.id] !== undefined ? (
                          <div className="credentialValuePanel">
                            <code className="credentialSecret" aria-label={`${credential.name} value`}>
                              {formatCredentialValue(credentialSecrets[credential.id])}
                            </code>
                          </div>
                        ) : null}
                        <div className="rowActions">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={credentialLoadingID === credential.id}
                            onClick={() => void editCredential(credential)}
                          >
                            <Pencil size={16} />
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={credentialLoadingID === credential.id}
                            onClick={() => void toggleCredentialValue(credential)}
                          >
                            {credentialSecrets[credential.id] !== undefined ? <EyeOff size={16} /> : <Eye size={16} />}
                            {credentialSecrets[credential.id] !== undefined ? "Hide value" : "Show value"}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={credentialLoadingID === credential.id}
                            onClick={() => void copyCredentialValue(credential)}
                          >
                            <Clipboard size={16} />
                            Copy value
                          </Button>
                          <Button type="button" variant="outline" size="sm" onClick={() => void copyText(`whagons-dev credentials exec ${shellQuote(credential.name)} -- <command>`, "Copied safe CLI command")}>
                            <TerminalSquare size={16} />
                            CLI command
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="dangerButton"
                            aria-label={`Delete ${credential.name}`}
                            onClick={() => void runGuarded(async () => {
                              await deleteCredential({ sessionToken, id: credential.id });
                              setNotice(`Deleted ${credential.name}`);
                            })}
                          >
                            <Trash2 size={16} />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        ) : null}

        {activeTab === "team" ? (
          <>
            <header className="mainHeader">
              <div className="headerCopy">
                <p className="eyebrow"><span>Workspace</span> / People</p>
                <h2>Team</h2>
                <p className="summaryLine">
                  {isWorkspaceOwner
                    ? "Invite teammates by their exact Google email, then send them the sign-in instructions. They explicitly accept before gaining access."
                    : `You are a member of ${me?.workspace_email || "this workspace"}. Only the workspace owner can manage members.`}
                </p>
              </div>
            </header>
            <div className="settingsLayout settingsColumns">
              {invitations.length > 0 ? (
                <Card className="settingsCard">
                  <CardHeader>
                    <div className="settingsIcon"><ShieldCheck size={19} /></div>
                    <div><CardTitle>Pending invitations</CardTitle><CardDescription>Review before changing workspaces.</CardDescription></div>
                  </CardHeader>
                  <CardContent className="apiContent">
                    <div className="keyList">
                      {invitations.map((invitation) => (
                        <div className="keyRow" key={invitation.id}>
                          <div><strong>{invitation.workspace_email || "Whagons workspace"}</strong><span>Invited {formatDate(invitation.created_at)}</span></div>
                          <div className="rowActions">
                            <Button type="button" variant="accent" size="sm" onClick={() => void respondToInvitation(invitation, true)}>Accept</Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => void respondToInvitation(invitation, false)}>Reject</Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              {workspaces.length > 1 ? (
                <Card className="settingsCard">
                  <CardHeader>
                    <div className="settingsIcon"><Database size={19} /></div>
                    <div><CardTitle>Workspace access</CardTitle><CardDescription>Switch only between workspaces you explicitly joined.</CardDescription></div>
                  </CardHeader>
                  <CardContent className="apiContent">
                    <div className="keyList">
                      {workspaces.map((workspace) => (
                        <div className="keyRow" key={workspace.id}>
                          <div><strong>{workspace.email || "Whagons workspace"}</strong><span>{workspace.is_owner ? "Your workspace" : "Shared workspace"}</span></div>
                          <Button type="button" variant={workspace.active ? "outline" : "ghost"} size="sm" disabled={workspace.active} onClick={() => void chooseWorkspace(workspace)}>
                            {workspace.active ? "Current" : "Switch"}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              {isWorkspaceOwner ? (
                <Card className="settingsCard">
                  <CardHeader>
                    <div className="settingsIcon"><Plus size={19} /></div>
                    <div><CardTitle>Invite a teammate</CardTitle><CardDescription>Create access for one exact Google account.</CardDescription></div>
                  </CardHeader>
                  <CardContent className="apiContent">
                    <form className="credentialForm" onSubmit={(event) => void submitInvite(event)}>
                      <label><span>Email address</span><Input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="teammate@whagons.com" type="email" required /></label>
                      <Button type="submit" variant="accent">
                        <Plus size={16} />
                        Invite member
                      </Button>
                    </form>
                    <span className="mutedText">
                      The vault does not send an email. After inviting, use Copy invite below and send those instructions yourself. Accepted members get full access to skills, credentials, and API keys.
                    </span>
                  </CardContent>
                </Card>
              ) : null}

              <Card className="settingsCard">
                <CardHeader>
                  <div className="settingsIcon"><Users size={19} /></div>
                  <div><CardTitle>Workspace access</CardTitle><CardDescription>{activeTeamMembers.length} active · {pendingTeamMembers.length} pending.</CardDescription></div>
                </CardHeader>
                <CardContent className="apiContent">
                  <div className="keyList">
                    {teamMembers.length === 0 ? (
                      <span className="mutedText">No teammates yet. This workspace is only accessible to its owner.</span>
                    ) : teamMembers.map((member) => (
                      <div className="keyRow" key={member.id}>
                        <div>
                          <div className="memberHeading">
                            <strong>{member.email}</strong>
                            <Badge variant={member.status === "pending" ? "muted" : "accent"}>{member.status === "pending" ? "Pending" : "Active"}</Badge>
                          </div>
                          <span>{member.status === "pending" ? `Invited ${formatDate(member.created_at)} · awaiting acceptance` : `Joined ${formatDate(member.created_at)}`}</span>
                        </div>
                        {isWorkspaceOwner ? (
                          <div className="rowActions">
                            {member.status === "pending" ? (
                              <Button type="button" variant="outline" size="sm" onClick={() => void copyInvitation(member)}>
                                <Clipboard size={14} /> Copy invite
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="dangerButton"
                              onClick={() => void dropMember(member)}
                            >
                              {member.status === "pending" ? "Cancel invite" : "Remove"}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        ) : null}

        {notice ? (
          <div className="noticeToast">
            <Check size={16} />
            {notice}
          </div>
        ) : null}
      </section>
    </main>
  );
}
