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
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { api } from "../gonvex/_generated/api";
import { useMutation, useQuery } from "../gonvex/_generated/react";

type Skill = {
  id: string;
  name: string;
  summary: string;
  content: string;
  created_at: string;
  updated_at: string;
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

type VaultTab = "skills" | "apiKeys" | "credentials";

const sessionStorageKey = "whagons-skills-vault-session";
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

function shareURL(skill: Skill) {
  return `${window.location.origin}${window.location.pathname}#${encodeURIComponent(skill.id)}`;
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
    ? `API key for this vault owner: ${apiKey}`
    : "Get an API key from the Skills Vault UI before running authenticated commands.";
  return `Whagons Skills Vault agent handoff

Context:
- This is the private Whagons Skills Vault at https://skills.whagons.com.
- It stores Whagons-specific agent skills plus credential handles for the logged-in Google user.
- Data is owner-scoped. The API key only grants access to the user's own skills and credentials.
- Prefer the CLI for normal agent work. Use direct Gonvex access only when writing custom automation.
- Do not print API keys, credential values, OAuth tokens, or full secret JSON.

Primary path: install the CLI
go install github.com/whagons/skills/cli/cmd/whagons-skills@latest

Authenticate the CLI through the browser:
whagons-skills auth login --app-url https://skills.whagons.com/

${keyLine}

Install or update all cloud skills into Codex:
whagons-skills skills install-codex
whagons-skills skills update-codex

Useful commands:
whagons-skills skills list
whagons-skills skills get whagons-skills-server --output ./SKILL.md
whagons-skills skills get whagons-monitor --output ./SKILL.md
whagons-skills skills copy whagons-monitor
whagons-skills skills upload ./my-skill/SKILL.md
whagons-skills credentials list
whagons-skills credentials exec coolify-whagons -- <command> [args...]

Direct Gonvex API path for custom scripts:
1. Install the client package in a Node project:
   npm install @gonvex/client

2. Use the runtime/project:
   WebSocket: ${gonvexWSURL}
   Project/tenant: ${gonvexProjectID}

3. Call agent endpoints with the API key:
${agentExample(apiKey)}

Security rules:
- Use credentials exec for commands that need secrets.
- If using agent.credentials.get directly, pass the value only into the command that needs it and never echo it.
- Store CLI config at ~/.whagons-skills/config.json with mode 0600.
- Keep uploaded skills universal; avoid private machine paths or one-person local assumptions unless the skill is explicitly local-infra scoped.`;
}

export default function App() {
  const [sessionToken, setSessionToken] = useState(() => sessionStorage.getItem(sessionStorageKey) ?? "");
  const googleButtonRef = useRef<HTMLDivElement | null>(null);
  const [cliAuthRequest] = useState<CLIAuthRequest | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const callback = params.get("cli_callback");
    if (!callback) return null;
    return {
      callback,
      state: params.get("cli_state") ?? "",
      name: params.get("cli_name") ?? "Whagons Skills CLI",
    };
  });
  const [authError, setAuthError] = useState("");
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<VaultTab>("skills");
  const [selectedID, setSelectedID] = useState(() => decodeURIComponent(window.location.hash.replace(/^#/, "")));
  const [notice, setNotice] = useState("");
  const [freshAPIKey, setFreshAPIKey] = useState("");
  const [credentialDraft, setCredentialDraft] = useState<CredentialDraft>({ name: "", summary: "", value: "" });

  const protectedArgs = sessionToken ? { sessionToken } : "skip";
  const skills = useQuery<Skill[]>(api["skills.list"], protectedArgs) ?? [];
  const apiKeys = useQuery<APIKeyRecord[]>(api["apiKeys.list"], protectedArgs) ?? [];
  const credentials = useQuery<CredentialMeta[]>(api["credentials.list"], protectedArgs) ?? [];
  const login = useMutation(api["auth.login"]);
  const deleteSkill = useMutation(api["skills.delete"]);
  const createAPIKey = useMutation(api["apiKeys.create"]);
  const revokeAPIKey = useMutation(api["apiKeys.revoke"]);
  const saveCredential = useMutation(api["credentials.save"]);
  const deleteCredential = useMutation(api["credentials.delete"]);

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => {
      return [skill.name, skill.summary, skill.content].some((value) => value.toLowerCase().includes(needle));
    });
  }, [query, skills]);

  const selectedSkill = skills.find((skill) => skill.id === selectedID) ?? filteredSkills[0] ?? skills[0] ?? null;
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
      sessionStorage.setItem(sessionStorageKey, result.sessionToken);
      setSessionToken(result.sessionToken);
      setAuthError("");
    } catch {
      setAuthError("Google login was rejected.");
    }
  }

  async function copyText(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setNotice(label);
  }

  async function removeSkill(skill: Skill) {
    await deleteSkill({ sessionToken, id: skill.id });
    setNotice("Deleted skill");
  }

  async function makeAPIKey() {
    const result = await createAPIKey({ sessionToken, name: `Agent key ${new Date().toLocaleString()}` }) as CreateAPIKeyResult;
    setFreshAPIKey(result.apiKey);
    setNotice("Created API key");
  }

  async function authorizeCLI() {
    if (!cliAuthRequest) return;
    const result = await createAPIKey({ sessionToken, name: `${cliAuthRequest.name} ${new Date().toLocaleString()}` }) as CreateAPIKeyResult;
    const callback = new URL(cliAuthRequest.callback);
    callback.searchParams.set("api_key", result.apiKey);
    callback.searchParams.set("api_key_prefix", result.record.prefix);
    callback.searchParams.set("state", cliAuthRequest.state);
    callback.searchParams.set("project", gonvexProjectID);
    callback.searchParams.set("ws_url", gonvexWSURL);
    callback.searchParams.set("app_url", window.location.origin + window.location.pathname);
    window.location.href = callback.toString();
  }

  async function storeCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveCredential({ sessionToken, ...credentialDraft });
    setCredentialDraft({ name: "", summary: "", value: "" });
    setNotice("Stored credential");
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
                  <span className="skillRowMeta">{skill.summary || `${skill.content.length.toLocaleString()} characters`}</span>
                </button>
              ))}
            </ScrollShadow>
          </>
        ) : (
          <div className="sidebarHint">
            <strong>{activeTab === "apiKeys" ? `${activeAPIKeys.length} active keys` : `${credentials.length} credentials`}</strong>
            <span>{activeTab === "apiKeys" ? "Create and revoke agent access." : "Store secrets for CLI and agents."}</span>
          </div>
        )}
      </aside>

      <section className="vaultMain">
        {cliAuthRequest ? (
          <div className="cliAuthBanner">
            <div>
              <p className="overline">CLI authorization</p>
              <h3>{cliAuthRequest.name}</h3>
              <p>Create a vault API key and send it back to the local CLI callback.</p>
            </div>
            <Button type="button" variant="primary" onPress={() => void authorizeCLI()}>
              <KeyRound size={16} />
              Authorize CLI
            </Button>
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
                      onPress={() => void copyText(selectedSkill.content, "Copied skill")}
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
                  <span>{selectedSkill.content.length.toLocaleString()} chars</span>
                  <span>{countWords(selectedSkill.content).toLocaleString()} words</span>
                  <span>Updated {formatDate(selectedSkill.updated_at)}</span>
                </div>
                <article className="markdownDoc">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {displayMarkdown(selectedSkill.content)}
                  </ReactMarkdown>
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
                        <Button
                          type="button"
                          className="dangerButton"
                          onPress={() => void deleteCredential({ sessionToken, id: credential.id })}
                        >
                          Delete
                        </Button>
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
