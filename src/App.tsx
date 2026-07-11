import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Button,
  Card,
  Chip,
  Input,
  ScrollShadow,
  Tooltip,
} from "@heroui/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  Clipboard,
  Code2,
  Database,
  KeyRound,
  Link2,
  LockKeyhole,
  LogOut,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api } from "../gonvex/_generated/api";
import { useMutation, useQuery } from "../gonvex/_generated/react";

type SkillMeta = {
  id: string;
  name: string;
  summary: string;
  created_at: string;
  updated_at: string;
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
};

type CreateAPIKeyResult = {
  record: APIKeyRecord;
  apiKey: string;
};

type LoginResult = {
  sessionToken: string;
  expires_at: string;
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
};

type TeamMember = {
  id: string;
  email: string;
  created_at: string;
};

type VaultTab = "skills" | "apiKeys" | "credentials" | "team";

const sessionStorageKey = "whagons-skills-vault-session";

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

function isInvalidSessionError(error: unknown) {
  return error instanceof Error && /invalid session|session token is required/i.test(error.message);
}
const gonvexWSURL = import.meta.env.VITE_GONVEX_WS_URL ?? "wss://gonvex.whagons.com/ws";
const gonvexProjectID = import.meta.env.VITE_GONVEX_PROJECT_ID ?? "skills";
const googleClientID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

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

function parseLoopbackCallback(rawCallback: string): URL | null {
  try {
    const url = new URL(rawCallback);
    const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
    if (url.protocol !== "http:" || !loopbackHosts.includes(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function agentExample(apiKey: string) {
  const key = apiKey || "skv_your_key_here";
  return `import { GonvexClient } from "@gonvex/client";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = \`\${encode({ alg: "none", typ: "JWT" })}.\${encode({
  sub: "agent",
  email: "agent@whagons.local",
})}.agent\`;

const client = new GonvexClient("wss://gonvex.whagons.com/ws?project=skills", {
  token,
  tenant: "skills",
});

const apiKey = "${key}";

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

function agentSetupInstructions(apiKey: string) {
  const keyLine = apiKey
    ? `An API key for this workspace is included below. Save it into the CLI once (headless-friendly,
skips the browser):
   printf '%s' '${apiKey}' | whagons-dev auth set-key --stdin
Or export WHAGONS_DEV_API_KEY=${apiKey} for ephemeral use. Then delete this handoff text.`
    : "No API key pasted here — the CLI will open the browser to authorize itself on first use.";
  return `Whagons Skills Vault — agent setup (plug and play)

Goal: give this agent the Whagons team's skills and project credentials with two commands.

1. Install the whagons-dev CLI:
   go install github.com/whagons/skills/cli/cmd/whagons-dev@latest

2. Install the team's skills locally (the CLI opens https://skills.whagons.com in the
   browser on first run, you click "Authorize CLI", and it saves its own API key):
   whagons-dev skills install-codex

${keyLine}

That's it. From then on:
- Refresh skills any time: whagons-dev skills update-codex
- See what credentials exist: whagons-dev credentials list
- Run anything that needs a secret WITHOUT printing it:
  whagons-dev credentials exec coolify-whagons -- <command> [args...]
  (the credential is injected as environment variables, e.g. COOLIFY_WHAGONS_JSON)

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
whagons-dev auth status

Direct Gonvex API path for custom scripts:
1. npm install @gonvex/client
2. Runtime: ${gonvexWSURL}  ·  project/tenant: ${gonvexProjectID}
3. Call agent endpoints with the API key:
${agentExample(apiKey)}

Security rules:
- Use credentials exec for commands that need secrets.
- If using agent.credentials.get directly, pass the value only into the command that
  needs it and never echo it.
- The CLI stores its config at ~/.whagons-dev/config.json with mode 0600.
- Keep uploaded skills universal; avoid private machine paths or one-person local
  assumptions unless the skill is explicitly local-infra scoped.`;
}

export default function App() {
  const [sessionToken, setSessionToken] = useState(readStoredSession);
  const googleButtonRef = useRef<HTMLDivElement | null>(null);
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
  const [activeTab, setActiveTab] = useState<VaultTab>("skills");
  const [selectedID, setSelectedID] = useState(() => decodeURIComponent(window.location.hash.replace(/^#/, "")));
  const [notice, setNotice] = useState("");
  const [freshAPIKey, setFreshAPIKey] = useState("");
  const [credentialDraft, setCredentialDraft] = useState<CredentialDraft>({ name: "", summary: "", value: "" });
  const [inviteEmail, setInviteEmail] = useState("");

  const protectedArgs = sessionToken ? { sessionToken } : "skip";
  const skills = useQuery<SkillMeta[]>(api["skills.list"], protectedArgs) ?? [];
  const apiKeys = useQuery<APIKeyRecord[]>(api["apiKeys.list"], protectedArgs) ?? [];
  const credentials = useQuery<CredentialMeta[]>(api["credentials.list"], protectedArgs) ?? [];
  const me = useQuery<MeResult>(api["auth.me"], protectedArgs) ?? null;
  const teamMembers = useQuery<TeamMember[]>(api["team.list"], protectedArgs) ?? [];
  const login = useMutation(api["auth.login"]);
  const logout = useMutation(api["auth.logout"]);
  const deleteSkill = useMutation(api["skills.delete"]);
  const createAPIKey = useMutation(api["apiKeys.create"]);
  const revokeAPIKey = useMutation(api["apiKeys.revoke"]);
  const getCredential = useMutation(api["credentials.get"]);
  const saveCredential = useMutation(api["credentials.save"]);
  const deleteCredential = useMutation(api["credentials.delete"]);
  const inviteMember = useMutation(api["team.invite"]);
  const removeMember = useMutation(api["team.remove"]);
  const isWorkspaceOwner = me?.is_owner ?? true;
  const cliCallbackURL = cliAuthRequest ? parseLoopbackCallback(cliAuthRequest.callback) : null;

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => {
      return [skill.name, skill.summary].some((value) => value.toLowerCase().includes(needle));
    });
  }, [query, skills]);

  const selectedSkill = skills.find((skill) => skill.id === selectedID) ?? filteredSkills[0] ?? skills[0] ?? null;
  const selectedSkillFull = useQuery<Skill>(
    api["skills.get"],
    sessionToken && selectedSkill ? { sessionToken, id: selectedSkill.id } : "skip",
  ) ?? null;
  const selectedContent = selectedSkillFull?.id === selectedSkill?.id ? selectedSkillFull?.content ?? null : null;
  const activeAPIKeys = apiKeys.filter((key) => !key.revoked_at);

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
    } catch {
      setAuthError("Google login was rejected.");
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

  async function copyCredential(credential: CredentialMeta) {
    await runGuarded(async () => {
      const result = await getCredential({ sessionToken, id: credential.id, name: credential.name }) as Credential;
      await copyText(result.value, `Copied ${credential.name}`);
    });
  }

  async function removeSkill(skill: SkillMeta) {
    await runGuarded(async () => {
      await deleteSkill({ sessionToken, id: skill.id });
      setNotice("Deleted skill");
    });
  }

  async function makeAPIKey() {
    await runGuarded(async () => {
      const result = await createAPIKey({ sessionToken, name: `Agent key ${new Date().toLocaleString()}` }) as CreateAPIKeyResult;
      setFreshAPIKey(result.apiKey);
      setNotice("Created API key");
    });
  }

  async function authorizeCLI() {
    if (!cliAuthRequest || !cliCallbackURL) return;
    await runGuarded(async () => {
      await deliverCLIKey(cliAuthRequest, cliCallbackURL);
    });
  }

  async function deliverCLIKey(request: CLIAuthRequest, callbackURL: URL) {
    const result = await createAPIKey({ sessionToken, name: `${request.name} ${new Date().toLocaleString()}` }) as CreateAPIKeyResult;
    const payload = {
      api_key: result.apiKey,
      api_key_prefix: result.record.prefix,
      state: request.state,
      project: gonvexProjectID,
      ws_url: gonvexWSURL,
      app_url: window.location.origin + window.location.pathname,
    };
    try {
      // POST keeps the API key out of browser history. The CLI's loopback
      // server answers with CORS headers.
      const response = await fetch(callbackURL.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`callback returned ${response.status}`);
      setCliAuthRequest(null);
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      setNotice("CLI authorized — return to your terminal");
    } catch {
      // Older CLI builds only handle the GET redirect.
      const callback = new URL(callbackURL.toString());
      for (const [key, value] of Object.entries(payload)) {
        callback.searchParams.set(key, value);
      }
      window.location.href = callback.toString();
    }
  }

  async function signOut() {
    try {
      await logout({ sessionToken });
    } catch {
      // Session may already be expired; clear it locally regardless.
    }
    sessionStorage.removeItem(sessionStorageKey);
    setSessionToken("");
  }

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    await runGuarded(async () => {
      await inviteMember({ sessionToken, email }) as TeamMember;
      setInviteEmail("");
      setNotice(`Invited ${email}`);
    });
  }

  async function dropMember(member: TeamMember) {
    await runGuarded(async () => {
      await removeMember({ sessionToken, id: member.id });
      setNotice(`Removed ${member.email}`);
    });
  }

  async function storeCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runGuarded(async () => {
      await saveCredential({ sessionToken, ...credentialDraft });
      setCredentialDraft({ name: "", summary: "", value: "" });
      setNotice("Stored credential");
    });
  }

  if (!sessionToken) {
    return (
      <main className="authPage">
        <Card className="authCard">
          <Card.Header className="authHeader">
            <div className="authIcon">
              <LockKeyhole size={22} />
            </div>
            <div>
              <p className="overline">Private Whagons Library</p>
              <Card.Title>Skills Vault</Card.Title>
              <Card.Description>
                {cliAuthRequest ? `Unlock to authorize ${cliAuthRequest.name}.` : "Copy, share, and manage Whagons-specific agent skills."}
              </Card.Description>
            </div>
          </Card.Header>
          <Card.Content>
            <div className="authForm">
              {googleClientID ? (
                <div className="googleButtonHost" ref={googleButtonRef} aria-label="Sign in with Google" />
              ) : (
                <div className="authError">Google login is not configured for this deployment.</div>
              )}
              {authError ? <div className="authError">{authError}</div> : null}
            </div>
          </Card.Content>
        </Card>
      </main>
    );
  }

  return (
    <main className="vaultPage">
      <aside className="vaultSidebar" aria-label="Skills">
        <div className="brandBlock">
          <div>
            <p className="overline">Whagons</p>
            <h1>Skills</h1>
          </div>
          <Chip size="sm" variant="soft">{skills.length}</Chip>
        </div>

        <div className="tabNav" aria-label="Vault sections">
          <button className={activeTab === "skills" ? "tabButton active" : "tabButton"} type="button" onClick={() => setActiveTab("skills")}>
            <Code2 size={17} />
            Skills
          </button>
          <button className={activeTab === "apiKeys" ? "tabButton active" : "tabButton"} type="button" onClick={() => setActiveTab("apiKeys")}>
            <KeyRound size={17} />
            API keys
          </button>
          <button className={activeTab === "credentials" ? "tabButton active" : "tabButton"} type="button" onClick={() => setActiveTab("credentials")}>
            <Database size={17} />
            Credentials
          </button>
          <button className={activeTab === "team" ? "tabButton active" : "tabButton"} type="button" onClick={() => setActiveTab("team")}>
            <Users size={17} />
            Team
          </button>
        </div>

        {activeTab === "skills" ? (
          <>
            <div className="sidebarTools">
              <div className="searchBox">
                <Search size={16} />
                <Input
                  fullWidth
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search skills"
                  aria-label="Search skills"
                />
              </div>
            </div>
            <ScrollShadow className="skillScroll" hideScrollBar>
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
                    window.history.replaceState(null, "", `#${encodeURIComponent(skill.id)}`);
                  }}
                >
                  <span className="skillRowTitle">{skill.name}</span>
                  <span className="skillRowMeta">{skill.summary || `Updated ${formatDate(skill.updated_at)}`}</span>
                </button>
              ))}
            </ScrollShadow>
          </>
        ) : (
          <div className="sidebarHint">
            <strong>
              {activeTab === "apiKeys" ? `${activeAPIKeys.length} active keys`
                : activeTab === "credentials" ? `${credentials.length} credentials`
                : `${teamMembers.length} invited members`}
            </strong>
            <span>
              {activeTab === "apiKeys" ? "Create and revoke agent access."
                : activeTab === "credentials" ? "Store secrets for CLI and agents."
                : "Share this workspace with teammates."}
            </span>
          </div>
        )}

        <div className="sidebarAccount">
          <div className="sidebarAccountInfo">
            <strong>{me?.name || me?.email || "Signed in"}</strong>
            {me && !me.is_owner ? <span>Workspace of {me.workspace_email || "the owner"}</span> : <span>{me?.email ?? ""}</span>}
          </div>
          <Tooltip>
            <Tooltip.Trigger>
              <Button type="button" aria-label="Sign out" onPress={() => void signOut()}>
                <LogOut size={16} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>Sign out</Tooltip.Content>
          </Tooltip>
        </div>
      </aside>

      <section className="vaultMain">
        {cliAuthRequest ? (
          <div className="cliAuthBanner">
            <div>
              <p className="overline">CLI authorization</p>
              <h3>{cliAuthRequest.name}</h3>
              {cliCallbackURL ? (
                <p>Create a workspace API key and send it to <code>{cliCallbackURL.origin}</code> on this machine.</p>
              ) : (
                <p className="authError">Blocked: callback {cliAuthRequest.callback} is not a local (127.0.0.1) address, so it cannot be a CLI on this machine.</p>
              )}
            </div>
            <div className="primaryActions">
              {cliCallbackURL ? (
                <Button type="button" variant="primary" onPress={() => void authorizeCLI()}>
                  <KeyRound size={16} />
                  Authorize CLI
                </Button>
              ) : null}
              <Button
                type="button"
                aria-label="Dismiss CLI authorization"
                onPress={() => {
                  setCliAuthRequest(null);
                  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
                }}
              >
                <X size={16} />
              </Button>
            </div>
          </div>
        ) : null}
        {activeTab === "skills" && selectedSkill ? (
          <>
            <header className="mainHeader">
              <div>
                <p className="overline">Selected skill</p>
                <h2>{selectedSkill.name}</h2>
                <p className="summaryLine">{selectedSkill.summary}</p>
              </div>
              <div className="primaryActions">
                <Tooltip>
                  <Tooltip.Trigger>
                    <Button
                      type="button"
                      aria-label="Copy skill"
                      isDisabled={selectedContent === null}
                      onPress={() => selectedContent !== null && void copyText(selectedContent, "Copied skill")}
                    >
                      <Clipboard size={18} />
                      Copy
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content>Copy skill</Tooltip.Content>
                </Tooltip>
                <Tooltip>
                  <Tooltip.Trigger>
                    <Button
                      type="button"
                      aria-label="Copy share link"
                      onPress={() => void copyText(shareURL(selectedSkill), "Copied share link")}
                    >
                      <Link2 size={18} />
                      Share link
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content>Copy share link</Tooltip.Content>
                </Tooltip>
                <Tooltip>
                  <Tooltip.Trigger>
                    <Button
                      type="button"
                      aria-label="Delete skill"
                      className="dangerButton"
                      onPress={() => void removeSkill(selectedSkill)}
                    >
                      <Trash2 size={18} />
                      Delete
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content>Delete skill</Tooltip.Content>
                </Tooltip>
              </div>
            </header>

            <div className="libraryLayout">
              <section className="readerPane">
                <div className="metaStrip">
                  {selectedContent !== null ? (
                    <>
                      <span>{selectedContent.length.toLocaleString()} chars</span>
                      <span>{countWords(selectedContent).toLocaleString()} words</span>
                    </>
                  ) : (
                    <span>Loading…</span>
                  )}
                  <span>Updated {formatDate(selectedSkill.updated_at)}</span>
                </div>
                <article className="markdownDoc">
                  {selectedContent !== null ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {displayMarkdown(selectedContent)}
                    </ReactMarkdown>
                  ) : null}
                </article>
              </section>
            </div>
          </>
        ) : activeTab === "skills" ? (
          <div className="emptyMain">
            <Code2 size={32} />
            <h2>No skills yet</h2>
            <p>Create an API key and let agents upload skills into the vault.</p>
          </div>
        ) : null}

        {activeTab === "apiKeys" ? (
          <>
            <header className="mainHeader">
              <div>
                <p className="overline">Agent access</p>
                <h2>API keys</h2>
                <p className="summaryLine">Create keys for the CLI and agents. New key values are shown once.</p>
              </div>
              <div className="primaryActions">
                <Button type="button" onPress={() => void copyText(agentSetupInstructions(freshAPIKey), "Copied agent setup")}>
                  <Clipboard size={16} />
                  Copy agent setup
                </Button>
                <Button type="button" variant="primary" onPress={() => void makeAPIKey()}>
                  <KeyRound size={16} />
                  Create API key
                </Button>
              </div>
            </header>
            <div className="settingsLayout">
              <Card className="settingsCard">
                <Card.Content className="apiContent">
                  {freshAPIKey ? (
                    <div className="freshKey">
                      <span>New key</span>
                      <code>{freshAPIKey}</code>
                      <Button type="button" onPress={() => void copyText(freshAPIKey, "Copied API key")}>
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
                          <span>{key.prefix}... · Created {formatDate(key.created_at)}</span>
                        </div>
                        <Button
                          type="button"
                          className="dangerButton"
                          onPress={() => void revokeAPIKey({ sessionToken, id: key.id })}
                        >
                          Revoke
                        </Button>
                      </div>
                    ))}
                  </div>
                </Card.Content>
              </Card>

              <Card className="settingsCard">
                <Card.Content className="apiContent">
                  <div className="apiCodeHeader">
                    <div>
                      <p className="overline">Agent snippet</p>
                      <h3>Skills Vault handoff</h3>
                    </div>
                    <Button type="button" onPress={() => void copyText(agentSetupInstructions(freshAPIKey), "Copied agent handoff")}>
                      <Clipboard size={16} />
                      Copy
                    </Button>
                  </div>
                  <div className="apiCode">
                    <pre>{agentSetupInstructions(freshAPIKey)}</pre>
                  </div>
                </Card.Content>
              </Card>
            </div>
          </>
        ) : null}

        {activeTab === "credentials" ? (
          <>
            <header className="mainHeader">
              <div>
                <p className="overline">Project secrets</p>
                <h2>Credentials</h2>
                <p className="summaryLine">Store credentials for the CLI and agents. Values are never shown in this list.</p>
              </div>
            </header>
            <div className="settingsLayout">
              <Card className="settingsCard">
                <Card.Content className="apiContent">
                  <form className="credentialForm" onSubmit={(event) => void storeCredential(event)}>
                    <Input
                      fullWidth
                      value={credentialDraft.name}
                      onChange={(event) => setCredentialDraft((current) => ({ ...current, name: event.target.value }))}
                      placeholder="Credential name, e.g. coolify-whagons"
                      required
                    />
                    <Input
                      fullWidth
                      value={credentialDraft.summary}
                      onChange={(event) => setCredentialDraft((current) => ({ ...current, summary: event.target.value }))}
                      placeholder="Description"
                    />
                    <Input
                      fullWidth
                      value={credentialDraft.value}
                      onChange={(event) => setCredentialDraft((current) => ({ ...current, value: event.target.value }))}
                      placeholder="Secret value"
                      type="password"
                      required
                    />
                    <Button type="submit" variant="primary">
                      <Plus size={16} />
                      Store credential
                    </Button>
                  </form>
                </Card.Content>
              </Card>

              <Card className="settingsCard">
                <Card.Content className="apiContent">
                  <div className="keyList">
                    {credentials.length === 0 ? (
                      <span className="mutedText">No project credentials stored.</span>
                    ) : credentials.map((credential) => (
                      <div className="keyRow" key={credential.id}>
                        <div>
                          <strong>{credential.name}</strong>
                          <span>{credential.summary || `Updated ${formatDate(credential.updated_at)}`}</span>
                        </div>
                        <div className="rowActions">
                          <Button type="button" onPress={() => void copyCredential(credential)}>
                            <Clipboard size={16} />
                            Copy
                          </Button>
                          <Button
                            type="button"
                            className="dangerButton"
                            onPress={() => void deleteCredential({ sessionToken, id: credential.id })}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card.Content>
              </Card>
            </div>
          </>
        ) : null}

        {activeTab === "team" ? (
          <>
            <header className="mainHeader">
              <div>
                <p className="overline">Workspace access</p>
                <h2>Team</h2>
                <p className="summaryLine">
                  {isWorkspaceOwner
                    ? "Invite Whagons teammates by Google email. They sign in with Google and see all skills and credentials in this workspace."
                    : `You are a member of ${me?.workspace_email || "this workspace"}. Only the workspace owner can manage members.`}
                </p>
              </div>
            </header>
            <div className="settingsLayout">
              {isWorkspaceOwner ? (
                <Card className="settingsCard">
                  <Card.Content className="apiContent">
                    <form className="credentialForm" onSubmit={(event) => void submitInvite(event)}>
                      <Input
                        fullWidth
                        value={inviteEmail}
                        onChange={(event) => setInviteEmail(event.target.value)}
                        placeholder="teammate@whagons.com"
                        type="email"
                        required
                      />
                      <Button type="submit" variant="primary">
                        <Plus size={16} />
                        Invite member
                      </Button>
                    </form>
                    <span className="mutedText">
                      Invited members get full access to this workspace: skills, credentials, and API keys. Removing a member also revokes their active sessions.
                    </span>
                  </Card.Content>
                </Card>
              ) : null}

              <Card className="settingsCard">
                <Card.Content className="apiContent">
                  <div className="keyList">
                    {teamMembers.length === 0 ? (
                      <span className="mutedText">No invited members yet. This workspace is only accessible to its owner.</span>
                    ) : teamMembers.map((member) => (
                      <div className="keyRow" key={member.id}>
                        <div>
                          <strong>{member.email}</strong>
                          <span>Invited {formatDate(member.created_at)}</span>
                        </div>
                        {isWorkspaceOwner ? (
                          <Button
                            type="button"
                            className="dangerButton"
                            onPress={() => void dropMember(member)}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </Card.Content>
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
