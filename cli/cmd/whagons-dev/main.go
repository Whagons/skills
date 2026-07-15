package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultWSURL            = "wss://gonvex.whagons.com/ws"
	defaultProject          = "skills"
	defaultAppURL           = "https://skills.whagons.com/"
	maxSkillBytes           = 2 << 20
	maxCredentialInputBytes = 256 << 10
)

type Config struct {
	APIKey  string `json:"apiKey,omitempty"`
	WSURL   string `json:"wsURL,omitempty"`
	Project string `json:"project,omitempty"`
	AppURL  string `json:"appURL,omitempty"`
}

type Skill struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Summary   string `json:"summary"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type APIKeyRecord struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Prefix    string  `json:"prefix"`
	CreatedAt string  `json:"created_at"`
	RevokedAt *string `json:"revoked_at,omitempty"`
}

type CredentialMeta struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Summary   string `json:"summary"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type Credential struct {
	CredentialMeta
	Value string `json:"value"`
}

type DeleteResult struct {
	Deleted bool `json:"deleted"`
}

type credentialExecOptions struct {
	Name       string
	Command    []string
	Prefix     string
	Via        string
	InheritEnv []string
}

type message map[string]any

type Client struct {
	conn *websocket.Conn
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		usage()
		return nil
	}
	group := args[0]
	command := ""
	if len(args) > 1 {
		command = args[1]
	}
	rest := []string{}
	if len(args) > 2 {
		rest = args[2:]
	}

	switch group {
	case "auth":
		return runAuth(command, rest)
	case "skills":
		return withClient(func(client *Client, apiKey string, _ Config) error {
			return runSkills(client, apiKey, command, rest)
		})
	case "api-keys":
		return withClient(func(client *Client, apiKey string, _ Config) error {
			return runAPIKeys(client, apiKey, command, rest)
		})
	case "credentials":
		return withClient(func(client *Client, apiKey string, _ Config) error {
			return runCredentials(client, apiKey, command, rest)
		})
	default:
		usage()
		return fmt.Errorf("unknown command group: %s", group)
	}
}

func usage() {
	fmt.Print(`whagons-dev — Whagons developer CLI for the Skills Vault

Usage:
  whagons-dev auth login [--app-url URL]
  whagons-dev auth set-key --stdin        (pipe a key minted in the vault UI)
  whagons-dev auth status
	  whagons-dev auth logout [--local-only]
  whagons-dev skills list
  whagons-dev skills get <name-or-id> [--output FILE]
  whagons-dev skills copy <name-or-id>
  whagons-dev skills upload <SKILL.md> [--name NAME] [--id ID] [--summary TEXT]
  whagons-dev skills sync <DIR>
  whagons-dev skills install-codex [--dir DIR]
  whagons-dev skills update-codex [--dir DIR]
  whagons-dev skills delete <name-or-id>
  whagons-dev api-keys list
  whagons-dev api-keys revoke <id>
  whagons-dev credentials list
  whagons-dev credentials set <name> [--summary TEXT] [--value-stdin]
  whagons-dev credentials delete <id>
	  whagons-dev credentials exec <name> [--via file|stdin|env] [--prefix PREFIX]
	      [--inherit-env NAME[,NAME...]] -- <command> [args...]

What it does:
  - Authenticates itself by opening the Skills Vault in your browser (automatic on first use).
  - Lists, copies, uploads, and deletes your workspace's cloud skills.
  - Installs or updates cloud skills into Codex-compatible SKILL.md folders.
  - Stores project credentials and injects them into child processes without printing them.

	Secrets are not printed by default. Credential files are mode 0600 and deleted after the child exits.
	Child processes receive a minimal environment; opt in to additional non-secret variables with --inherit-env.
`)
}

func runAuth(command string, args []string) error {
	switch command {
	case "login":
		fs := flag.NewFlagSet("auth login", flag.ContinueOnError)
		appURL := fs.String("app-url", "", "vault app URL")
		if err := fs.Parse(args); err != nil {
			return err
		}
		return browserLogin(*appURL)
	case "status":
		config, _ := readConfig()
		apiKey := firstNonEmpty(envValue("API_KEY"), config.APIKey)
		if apiKey == "" {
			fmt.Println("Not logged in — run any command and the browser flow starts automatically.")
			return nil
		}
		prefix := apiKey
		if len(prefix) > 14 {
			prefix = prefix[:14]
		}
		project := firstNonEmpty(config.Project, defaultProject)
		fmt.Printf("Logged in (project %s, key %s...)\n", project, prefix)
		return nil
	case "set-key":
		// Persists a key minted by a human in the vault UI. Agents cannot mint
		// keys themselves (no agent.apiKeys.create), but they can store one
		// they were handed.
		fs := flag.NewFlagSet("auth set-key", flag.ContinueOnError)
		valueStdin := fs.Bool("stdin", false, "read the API key from stdin")
		if err := fs.Parse(args); err != nil {
			return err
		}
		if !*valueStdin {
			return errors.New(`use --stdin so the key stays out of shell history: printf '%s' "$KEY" | whagons-dev auth set-key --stdin`)
		}
		data, err := readLimitedInput(os.Stdin, 4096, "API key")
		if err != nil {
			return err
		}
		apiKey := strings.TrimSpace(string(data))
		if apiKey == "" {
			return errors.New("no API key received on stdin")
		}
		config, _ := readConfig()
		wsURL := firstNonEmpty(envValue("WS_URL"), config.WSURL, defaultWSURL)
		project := firstNonEmpty(envValue("PROJECT"), config.Project, defaultProject)
		client, err := NewClient(wsURLWithProject(wsURL, project), project)
		if err != nil {
			return err
		}
		defer client.Close()
		var verified DeleteResult
		if err := client.Query("agent.apiKeys.verify", map[string]any{"apiKey": apiKey}, &verified); err != nil {
			return fmt.Errorf("the vault rejected this API key: %v", err)
		}
		config.APIKey = apiKey
		config.WSURL = wsURL
		config.Project = project
		config.AppURL = firstNonEmpty(config.AppURL, defaultAppURL)
		if err := writeConfig(config); err != nil {
			return err
		}
		fmt.Println("API key verified and saved to " + configPath())
		return nil
	case "logout":
		fs := flag.NewFlagSet("auth logout", flag.ContinueOnError)
		localOnly := fs.Bool("local-only", false, "clear local authentication without revoking the server key")
		if err := fs.Parse(args); err != nil {
			return err
		}
		config, _ := readConfig()
		apiKey := firstNonEmpty(envValue("API_KEY"), config.APIKey)
		if !*localOnly && apiKey != "" {
			wsURL := firstNonEmpty(envValue("WS_URL"), config.WSURL, defaultWSURL)
			project := firstNonEmpty(envValue("PROJECT"), config.Project, defaultProject)
			client, err := NewClient(wsURLWithProject(wsURL, project), project)
			if err != nil {
				return fmt.Errorf("could not revoke the server key; local authentication was preserved: %w (use --local-only to clear it anyway)", err)
			}
			defer client.Close()
			var result DeleteResult
			if err := client.Mutation("agent.apiKeys.revokeSelf", map[string]any{"apiKey": apiKey}, &result); err != nil {
				return fmt.Errorf("could not revoke the server key; local authentication was preserved: %w (use --local-only to clear it anyway)", err)
			}
		}
		if err := writeConfig(Config{}); err != nil {
			return err
		}
		if *localOnly {
			fmt.Println("Local authentication cleared; the server key was not revoked.")
		} else {
			fmt.Println("Logged out and revoked the server key.")
		}
		return nil
	default:
		usage()
		return fmt.Errorf("unknown auth command: %s", command)
	}
}

func runSkills(client *Client, apiKey, command string, args []string) error {
	switch command {
	case "list":
		var skills []Skill
		if err := client.Query("agent.skills.list", map[string]any{"apiKey": apiKey}, &skills); err != nil {
			return err
		}
		for _, skill := range skills {
			fmt.Printf("%s\t%s\t%s\n", skill.Name, skill.ID, skill.Summary)
		}
		return nil
	case "get":
		fs := flag.NewFlagSet("skills get", flag.ContinueOnError)
		output := fs.String("output", "", "output file")
		if err := fs.Parse(args); err != nil {
			return err
		}
		if fs.NArg() < 1 {
			return errors.New("missing skill name or id")
		}
		skill, err := findSkill(client, apiKey, fs.Arg(0))
		if err != nil {
			return err
		}
		if *output != "" {
			if err := os.WriteFile(*output, []byte(skill.Content), 0o644); err != nil {
				return err
			}
			fmt.Printf("Wrote %s\n", *output)
			return nil
		}
		fmt.Print(skill.Content)
		return nil
	case "copy":
		if len(args) < 1 {
			return errors.New("missing skill name or id")
		}
		skill, err := findSkill(client, apiKey, args[0])
		if err != nil {
			return err
		}
		if err := copyToClipboard(skill.Content); err != nil {
			return err
		}
		fmt.Printf("Copied %s\n", skill.Name)
		return nil
	case "upload":
		fs := flag.NewFlagSet("skills upload", flag.ContinueOnError)
		name := fs.String("name", "", "skill name")
		id := fs.String("id", "", "skill id")
		summary := fs.String("summary", "", "skill summary")
		if err := fs.Parse(args); err != nil {
			return err
		}
		if fs.NArg() < 1 {
			return errors.New("missing SKILL.md file")
		}
		skill, err := uploadSkill(client, apiKey, fs.Arg(0), *id, *name, *summary)
		if err != nil {
			return err
		}
		fmt.Printf("Uploaded %s\n", skill.Name)
		return nil
	case "sync":
		root := "."
		if len(args) > 0 {
			root = args[0]
		}
		files, err := discoverSkillFiles(root)
		if err != nil {
			return err
		}
		for _, file := range files {
			skill, err := uploadSkill(client, apiKey, file, "", "", "")
			if err != nil {
				return err
			}
			fmt.Printf("Uploaded %s\n", skill.Name)
		}
		fmt.Printf("Synced %d skills\n", len(files))
		return nil
	case "install-codex", "update-codex":
		fs := flag.NewFlagSet("skills "+command, flag.ContinueOnError)
		dir := fs.String("dir", defaultCodexSkillsDir(), "Codex skills directory")
		if err := fs.Parse(args); err != nil {
			return err
		}
		return installCodexSkills(client, apiKey, *dir)
	case "delete":
		if len(args) < 1 {
			return errors.New("missing skill name or id")
		}
		skill, err := findSkill(client, apiKey, args[0])
		if err != nil {
			return err
		}
		var result DeleteResult
		if err := client.Mutation("agent.skills.delete", map[string]any{"apiKey": apiKey, "id": skill.ID}, &result); err != nil {
			return err
		}
		if result.Deleted {
			fmt.Printf("Deleted %s\n", skill.Name)
		} else {
			fmt.Printf("No skill deleted for %s\n", skill.Name)
		}
		return nil
	default:
		usage()
		return fmt.Errorf("unknown skills command: %s", command)
	}
}

func runAPIKeys(client *Client, apiKey, command string, args []string) error {
	switch command {
	case "list":
		var keys []APIKeyRecord
		if err := client.Query("agent.apiKeys.list", map[string]any{"apiKey": apiKey}, &keys); err != nil {
			return err
		}
		for _, key := range keys {
			status := "active"
			if key.RevokedAt != nil {
				status = "revoked"
			}
			fmt.Printf("%s\t%s\t%s...\t%s\n", key.ID, key.Name, key.Prefix, status)
		}
		return nil
	case "create":
		return errors.New("api-keys create was removed: an API key cannot mint new keys. Create keys from a Google session — run: whagons-dev auth login")
	case "revoke":
		if len(args) < 1 {
			return errors.New("missing API key id")
		}
		var result DeleteResult
		if err := client.Mutation("agent.apiKeys.revoke", map[string]any{"apiKey": apiKey, "id": args[0]}, &result); err != nil {
			return err
		}
		if result.Deleted {
			fmt.Printf("Revoked %s\n", args[0])
		} else {
			fmt.Printf("No active API key matched %s\n", args[0])
		}
		return nil
	default:
		usage()
		return fmt.Errorf("unknown api-keys command: %s", command)
	}
}

func runCredentials(client *Client, apiKey, command string, args []string) error {
	switch command {
	case "list":
		var credentials []CredentialMeta
		if err := client.Query("agent.credentials.list", map[string]any{"apiKey": apiKey}, &credentials); err != nil {
			return err
		}
		for _, credential := range credentials {
			fmt.Printf("%s\t%s\t%s\n", credential.Name, credential.ID, credential.Summary)
		}
		return nil
	case "set":
		fs := flag.NewFlagSet("credentials set", flag.ContinueOnError)
		summary := fs.String("summary", "", "credential summary")
		valueStdin := fs.Bool("value-stdin", false, "read secret value from stdin")
		id := fs.String("id", "", "credential id")
		if err := fs.Parse(args); err != nil {
			return err
		}
		if fs.NArg() < 1 {
			return errors.New("missing credential name")
		}
		if !*valueStdin {
			return errors.New("use --value-stdin so secret values are not exposed in shell history")
		}
		value, err := readLimitedInput(os.Stdin, maxCredentialInputBytes, "credential")
		if err != nil {
			return err
		}
		credentialID := *id
		if credentialID == "" {
			credentialID = "credential-" + fs.Arg(0)
		}
		var meta CredentialMeta
		if err := client.Mutation("agent.credentials.save", map[string]any{
			"apiKey":  apiKey,
			"id":      credentialID,
			"name":    fs.Arg(0),
			"summary": *summary,
			"value":   string(value),
		}, &meta); err != nil {
			return err
		}
		fmt.Printf("Stored %s\n", meta.Name)
		return nil
	case "delete":
		if len(args) < 1 {
			return errors.New("missing credential id")
		}
		var result DeleteResult
		if err := client.Mutation("agent.credentials.delete", map[string]any{"apiKey": apiKey, "id": args[0]}, &result); err != nil {
			return err
		}
		if result.Deleted {
			fmt.Printf("Deleted %s\n", args[0])
		} else {
			fmt.Printf("No credential matched %s\n", args[0])
		}
		return nil
	case "exec":
		options, err := parseCredentialExec(args)
		if err != nil {
			return err
		}
		var credential Credential
		if err := client.Query("agent.credentials.get", map[string]any{"apiKey": apiKey, "name": options.Name}, &credential); err != nil {
			return err
		}
		childEnv, err := childEnvironment(options.InheritEnv)
		if err != nil {
			return err
		}
		cmd := exec.Command(options.Command[0], options.Command[1:]...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Stdin = os.Stdin
		cmd.Env = childEnv
		switch options.Via {
		case "file":
			path, cleanup, err := writeCredentialFile(credential.Value)
			if err != nil {
				return err
			}
			defer cleanup()
			prefix := sanitizeEnv(firstNonEmpty(options.Prefix, credential.Name))
			cmd.Env = append(cmd.Env, "WHAGONS_CREDENTIAL_FILE="+path, prefix+"_FILE="+path)
		case "stdin":
			cmd.Stdin = strings.NewReader(credential.Value)
		case "env":
			cmd.Env = append(cmd.Env, credentialEnv(credential.Name, credential.Value, options.Prefix)...)
		default:
			return fmt.Errorf("unsupported credential delivery mode %q", options.Via)
		}
		return cmd.Run()
	default:
		usage()
		return fmt.Errorf("unknown credentials command: %s", command)
	}
}

// envValue reads WHAGONS_DEV_<suffix>, falling back to the legacy
// WHAGONS_SKILLS_<suffix> name.
func envValue(suffix string) string {
	return firstNonEmpty(os.Getenv("WHAGONS_DEV_"+suffix), os.Getenv("WHAGONS_SKILLS_"+suffix))
}

func withClient(fn func(*Client, string, Config) error) error {
	config, _ := readConfig()
	apiKey := firstNonEmpty(envValue("API_KEY"), config.APIKey)
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "Not logged in — opening the Skills Vault in your browser to authorize this CLI...")
		if err := browserLogin(""); err != nil {
			return fmt.Errorf("browser login failed: %w (or set WHAGONS_DEV_API_KEY)", err)
		}
		config, _ = readConfig()
		apiKey = config.APIKey
		if apiKey == "" {
			return errors.New("not logged in. Run: whagons-dev auth login")
		}
	}
	wsURL := firstNonEmpty(envValue("WS_URL"), config.WSURL, defaultWSURL)
	project := firstNonEmpty(envValue("PROJECT"), config.Project, defaultProject)
	client, err := NewClient(wsURLWithProject(wsURL, project), project)
	if err != nil {
		return err
	}
	defer client.Close()
	return fn(client, apiKey, config)
}

func NewClient(wsURL, tenant string) (*Client, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		return nil, err
	}
	client := &Client{conn: conn}
	if tenant != "" {
		id := randomID()
		if err := client.write(message{"type": "auth", "id": id, "token": devJWT(), "tenant": tenant}); err != nil {
			conn.Close()
			return nil, err
		}
		for {
			msg, err := client.read()
			if err != nil {
				conn.Close()
				return nil, err
			}
			if msg["id"] != id {
				continue
			}
			switch msg["type"] {
			case "auth.result":
				return client, nil
			case "auth.error":
				conn.Close()
				return nil, fmt.Errorf("gonvex auth failed: %v", msg["error"])
			}
		}
	}
	return client, nil
}

func (c *Client) Close() {
	_ = c.conn.Close()
}

func (c *Client) Query(path string, args any, out any) error {
	id := randomID()
	if err := c.write(message{"type": "query.subscribe", "id": id, "path": path, "args": args}); err != nil {
		return err
	}
	defer c.write(message{"type": "query.unsubscribe", "id": id})
	for {
		msg, err := c.read()
		if err != nil {
			return err
		}
		if msg["id"] != id {
			continue
		}
		switch msg["type"] {
		case "query.result":
			return decodeResult(msg["result"], out)
		case "query.error":
			return fmt.Errorf("%v", msg["error"])
		}
	}
}

func (c *Client) Mutation(path string, args any, out any) error {
	id := randomID()
	if err := c.write(message{"type": "mutation.call", "id": id, "path": path, "args": args, "trace": map[string]any{"clientSentAtMs": time.Now().UnixMilli()}}); err != nil {
		return err
	}
	for {
		msg, err := c.read()
		if err != nil {
			return err
		}
		if msg["id"] != id {
			continue
		}
		switch msg["type"] {
		case "mutation.result":
			return decodeResult(msg["result"], out)
		case "mutation.error":
			return fmt.Errorf("%v", msg["error"])
		}
	}
}

func (c *Client) write(value any) error {
	if err := c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	return c.conn.WriteJSON(value)
}

func (c *Client) read() (message, error) {
	if err := c.conn.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return nil, err
	}
	var msg message
	if err := c.conn.ReadJSON(&msg); err != nil {
		return nil, err
	}
	return msg, nil
}

func decodeResult(value any, out any) error {
	if out == nil {
		return nil
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

type authCallbackPayload struct {
	APIKey string `json:"api_key"`
	State  string `json:"state"`
}

func browserLogin(appURL string) error {
	config, _ := readConfig()
	appURL = firstNonEmpty(appURL, envValue("APP_URL"), config.AppURL, defaultAppURL)
	trustedAppURL, trustedOrigin, err := validateAppURL(appURL)
	if err != nil {
		return err
	}
	wsURL := firstNonEmpty(envValue("WS_URL"), config.WSURL, defaultWSURL)
	if err := validateWebSocketURL(wsURL); err != nil {
		return err
	}
	project := firstNonEmpty(envValue("PROJECT"), config.Project, defaultProject)
	state, err := secureRandomID()
	if err != nil {
		return fmt.Errorf("generate authorization state: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	resultCh := make(chan Config, 1)
	server := &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       15 * time.Second,
	}
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Access-Control-Allow-Origin", trustedOrigin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		if r.URL.Path != "/callback" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Origin") != trustedOrigin {
			http.Error(w, "origin mismatch", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST, OPTIONS")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
			http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
			return
		}
		var payload authCallbackPayload
		decoder := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		// A wrong state or missing key is a stray request, not the vault;
		// reject it and keep waiting for the real callback.
		if payload.State != state {
			http.Error(w, "state mismatch", http.StatusBadRequest)
			return
		}
		if payload.APIKey == "" {
			http.Error(w, "missing api key", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>whagons-dev authorized</title>
<body style="font-family:system-ui;background:#0b1117;color:#f7fffb;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="margin:0 0 8px">whagons-dev is authorized</h1>
<p style="color:#9db3aa;margin:0">You can close this tab and return to your terminal.</p></div></body>`)
		select {
		case resultCh <- Config{
			APIKey:  payload.APIKey,
			AppURL:  trustedAppURL,
			WSURL:   wsURL,
			Project: project,
		}:
		default:
		}
	})
	go func() {
		_ = server.Serve(listener)
	}()
	callback := "http://" + listener.Addr().String() + "/callback"
	loginURL, err := url.Parse(trustedAppURL)
	if err != nil {
		return err
	}
	q := loginURL.Query()
	q.Set("cli_callback", callback)
	q.Set("cli_state", state)
	q.Set("cli_name", "Whagons Dev CLI")
	loginURL.RawQuery = q.Encode()
	fmt.Printf("Opening browser: %s\n", loginURL.String())
	fmt.Println("Sign in with Google, then click \"Authorize CLI\".")
	if err := openBrowser(loginURL.String()); err != nil {
		fmt.Printf("Open this URL manually: %s\n", loginURL.String())
	}
	select {
	case result := <-resultCh:
		shutdownHTTPServer(server)
		client, err := NewClient(wsURLWithProject(result.WSURL, result.Project), result.Project)
		if err != nil {
			return fmt.Errorf("verify authorized key: %w", err)
		}
		var verified DeleteResult
		err = client.Query("agent.apiKeys.verify", map[string]any{"apiKey": result.APIKey}, &verified)
		client.Close()
		if err != nil {
			return fmt.Errorf("the vault rejected the authorized key: %w", err)
		}
		if err := writeConfig(result); err != nil {
			return err
		}
		fmt.Println("Logged in. API key saved to " + configPath())
		return nil
	case <-time.After(5 * time.Minute):
		shutdownHTTPServer(server)
		return errors.New("timed out waiting for browser authorization")
	}
}

func readConfig() (Config, error) {
	data, err := readPrivateFile(configPath(), 1<<20)
	if err != nil {
		// Fall back to the config written by the old whagons-skills CLI so an
		// upgrade does not force a re-login.
		legacy, legacyErr := readPrivateFile(legacyConfigPath(), 1<<20)
		if legacyErr != nil {
			return Config{}, err
		}
		data = legacy
	}
	var config Config
	return config, json.Unmarshal(data, &config)
}

func writeConfig(config Config) error {
	path := configPath()
	dir := filepath.Dir(path)
	_, statErr := os.Stat(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if os.IsNotExist(statErr) || filepath.Base(dir) == ".whagons-dev" {
		if err := os.Chmod(dir, 0o700); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writePrivateFile(path, data)
}

func readPrivateFile(path string, maxBytes int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("refusing non-regular private file: %s", path)
	}
	if info.Size() > maxBytes {
		return nil, fmt.Errorf("private file is too large: %s", path)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		if err := os.Chmod(path, 0o600); err != nil {
			return nil, fmt.Errorf("secure private file permissions: %w", err)
		}
	}
	return readRegularFile(path, maxBytes)
}

func writePrivateFile(path string, data []byte) error {
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("refusing non-regular private file: %s", path)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".config-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func configPath() string {
	if path := envValue("CONFIG"); path != "" {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".whagons-dev-config.json"
	}
	return filepath.Join(home, ".whagons-dev", "config.json")
}

func legacyConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".whagons-skills-config.json"
	}
	return filepath.Join(home, ".whagons-skills", "config.json")
}

func wsURLWithProject(rawURL, project string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	q := u.Query()
	q.Set("project", project)
	u.RawQuery = q.Encode()
	return u.String()
}

func validateAppURL(rawURL string) (string, string, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || u.User != nil {
		return "", "", errors.New("vault app URL must be an absolute URL without user information")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && isLoopbackHost(u.Hostname())) {
		return "", "", errors.New("vault app URL must use HTTPS (HTTP is allowed only for loopback development)")
	}
	u.Fragment = ""
	return u.String(), u.Scheme + "://" + u.Host, nil
}

func validateWebSocketURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || u.User != nil {
		return errors.New("vault WebSocket URL must be an absolute URL without user information")
	}
	if u.Scheme != "wss" && !(u.Scheme == "ws" && isLoopbackHost(u.Hostname())) {
		return errors.New("vault WebSocket URL must use WSS (WS is allowed only for loopback development)")
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func shutdownHTTPServer(server *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}

// findSkill resolves a name or id to the full skill, including content.
// agent.skills.get matches on either id or (case-insensitive) name, so the
// same value is passed as both.
func findSkill(client *Client, apiKey, nameOrID string) (Skill, error) {
	var skill Skill
	err := client.Query("agent.skills.get", map[string]any{"apiKey": apiKey, "id": nameOrID, "name": nameOrID}, &skill)
	if err != nil {
		return Skill{}, fmt.Errorf("skill not found: %s (%v)", nameOrID, err)
	}
	return skill, nil
}

func readRegularFile(path string, maxBytes int64) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() {
		return nil, fmt.Errorf("refusing non-regular file: %s", path)
	}
	if before.Size() > maxBytes {
		return nil, fmt.Errorf("file exceeds %d-byte limit: %s", maxBytes, path)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return nil, fmt.Errorf("file changed while opening: %s", path)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("file exceeds %d-byte limit: %s", maxBytes, path)
	}
	return data, nil
}

func readLimitedInput(reader io.Reader, maxBytes int64, label string) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("%s input exceeds the %d-byte limit", label, maxBytes)
	}
	return data, nil
}

func ensureSafeDirectory(path string, mode os.FileMode) error {
	info, err := os.Lstat(path)
	if err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("refusing non-directory path: %s", path)
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	return os.MkdirAll(path, mode)
}

func writeRegularFile(path string, data []byte, mode os.FileMode) error {
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("refusing non-regular output file: %s", path)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".skill-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, path)
}

func uploadSkill(client *Client, apiKey, path, id, name, summary string) (Skill, error) {
	contentBytes, err := readRegularFile(path, maxSkillBytes)
	if err != nil {
		return Skill{}, err
	}
	content := string(contentBytes)
	metadataName, metadataSummary := parseFrontmatter(content, filepath.Base(filepath.Dir(path)))
	name = firstNonEmpty(name, metadataName)
	summary = firstNonEmpty(summary, metadataSummary)
	if id == "" {
		var skills []Skill
		if err := client.Query("agent.skills.list", map[string]any{"apiKey": apiKey}, &skills); err != nil {
			return Skill{}, err
		}
		for _, skill := range skills {
			if strings.EqualFold(skill.Name, name) {
				id = skill.ID
				break
			}
		}
	}
	if id == "" {
		id = "cloud-" + name
	}
	var skill Skill
	err = client.Mutation("agent.skills.upload", map[string]any{"apiKey": apiKey, "id": id, "name": name, "summary": summary, "content": content}, &skill)
	return skill, err
}

func discoverSkillFiles(root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && (strings.HasPrefix(entry.Name(), ".") || entry.Name() == "node_modules") && path != root {
			return filepath.SkipDir
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.Name() == "SKILL.md" {
				return fmt.Errorf("refusing symlinked skill file: %s", path)
			}
			return nil
		}
		if !entry.IsDir() && entry.Name() == "SKILL.md" {
			info, infoErr := entry.Info()
			if infoErr != nil {
				return infoErr
			}
			if !info.Mode().IsRegular() || info.Size() > maxSkillBytes {
				return fmt.Errorf("skill file must be regular and at most %d bytes: %s", maxSkillBytes, path)
			}
			files = append(files, path)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

func installCodexSkills(client *Client, apiKey string, dir string) error {
	if strings.TrimSpace(dir) == "" {
		return errors.New("Codex skills directory is required")
	}
	var skills []Skill
	if err := client.Query("agent.skills.list", map[string]any{"apiKey": apiKey}, &skills); err != nil {
		return err
	}
	if err := ensureSafeDirectory(dir, 0o755); err != nil {
		return err
	}
	for _, meta := range skills {
		// Lists are metadata-only; fetch each skill's content individually.
		var skill Skill
		if err := client.Query("agent.skills.get", map[string]any{"apiKey": apiKey, "id": meta.ID}, &skill); err != nil {
			return fmt.Errorf("fetch %s: %w", meta.Name, err)
		}
		name := safePathName(skill.Name)
		if name == "" {
			name = safePathName(skill.ID)
		}
		if len(skill.Content) > maxSkillBytes {
			return fmt.Errorf("refusing oversized skill %s (%d bytes)", skill.Name, len(skill.Content))
		}
		skillDir := filepath.Join(dir, name)
		if err := ensureSafeDirectory(skillDir, 0o755); err != nil {
			return err
		}
		path := filepath.Join(skillDir, "SKILL.md")
		if err := writeRegularFile(path, []byte(skill.Content), 0o644); err != nil {
			return err
		}
		fmt.Printf("Installed %s -> %s\n", skill.Name, path)
	}
	fmt.Printf("Installed %d skills into %s\n", len(skills), dir)
	return nil
}

func defaultCodexSkillsDir() string {
	if dir := os.Getenv("CODEX_SKILLS_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".codex/skills/whagons"
	}
	return filepath.Join(home, ".codex", "skills", "whagons")
}

var pathReplace = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func safePathName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = pathReplace.ReplaceAllString(value, "-")
	value = strings.Trim(value, "-.")
	return value
}

func parseFrontmatter(content, fallbackName string) (string, string) {
	fields := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(content))
	if !scanner.Scan() || strings.TrimSpace(scanner.Text()) != "---" {
		return fallbackName, ""
	}
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "---" {
			break
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 {
			fields[strings.TrimSpace(parts[0])] = strings.Trim(strings.TrimSpace(parts[1]), `"'`)
		}
	}
	return firstNonEmpty(fields["name"], fallbackName), fields["description"]
}

func copyToClipboard(value string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("pbcopy")
	case "linux":
		if _, err := exec.LookPath("wl-copy"); err == nil {
			cmd = exec.Command("wl-copy")
		} else {
			cmd = exec.Command("xclip", "-selection", "clipboard")
		}
	case "windows":
		cmd = exec.Command("clip")
	default:
		return fmt.Errorf("clipboard unsupported on %s", runtime.GOOS)
	}
	cmd.Stdin = strings.NewReader(value)
	return cmd.Run()
}

func parseCredentialExec(args []string) (credentialExecOptions, error) {
	var options credentialExecOptions
	if len(args) == 0 {
		return options, errors.New("usage: whagons-dev credentials exec <name> [--via file|stdin|env] [--prefix PREFIX] [--inherit-env NAME[,NAME...]] -- <command> [args...]")
	}
	options.Name = args[0]
	options.Via = "file"
	sep := -1
	for i := 1; i < len(args); i++ {
		if args[i] == "--" {
			sep = i
			break
		}
		switch args[i] {
		case "--prefix", "--via", "--inherit-env":
			if i+1 >= len(args) {
				return options, fmt.Errorf("%s requires a value", args[i])
			}
			value := args[i+1]
			switch args[i] {
			case "--prefix":
				options.Prefix = value
			case "--via":
				options.Via = strings.ToLower(value)
			case "--inherit-env":
				for _, name := range strings.Split(value, ",") {
					if name = strings.TrimSpace(name); name != "" {
						options.InheritEnv = append(options.InheritEnv, name)
					}
				}
			}
			i++
		default:
			return options, fmt.Errorf("unknown credentials exec option: %s", args[i])
		}
	}
	if sep == -1 || sep+1 >= len(args) {
		return options, errors.New("usage: whagons-dev credentials exec <name> [--via file|stdin|env] [--prefix PREFIX] [--inherit-env NAME[,NAME...]] -- <command> [args...]")
	}
	if options.Name == "" {
		return options, errors.New("credential name is required")
	}
	if options.Via != "file" && options.Via != "stdin" && options.Via != "env" {
		return options, errors.New("--via must be one of file, stdin, or env")
	}
	options.Command = args[sep+1:]
	return options, nil
}

func credentialEnv(name, value, explicitPrefix string) []string {
	prefix := sanitizeEnv(firstNonEmpty(explicitPrefix, name))
	env := map[string]string{}
	var parsed any
	if json.Unmarshal([]byte(value), &parsed) == nil {
		if object, ok := parsed.(map[string]any); ok {
			flattenEnv(env, prefix, "", object)
			env[prefix+"_JSON"] = value
			return envPairs(env)
		}
	}
	env[prefix+"_VALUE"] = value
	return envPairs(env)
}

var safeInheritedEnvironment = map[string]bool{
	"COMSPEC": true, "HOME": true, "LANG": true, "LOGNAME": true,
	"PATH": true, "PATHEXT": true, "SHELL": true, "SYSTEMROOT": true,
	"TEMP": true, "TERM": true, "TMP": true, "TMPDIR": true,
	"USER": true, "WINDIR": true,
}

var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var sensitiveEnvironmentName = regexp.MustCompile(`(?i)(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|AUTH)`)

func childEnvironment(explicit []string) ([]string, error) {
	wanted := make(map[string]bool, len(safeInheritedEnvironment)+len(explicit))
	for name := range safeInheritedEnvironment {
		wanted[name] = true
	}
	for _, name := range explicit {
		if !environmentName.MatchString(name) {
			return nil, fmt.Errorf("invalid environment variable name %q", name)
		}
		if sensitiveEnvironmentName.MatchString(name) {
			return nil, fmt.Errorf("refusing to inherit sensitive environment variable %s; pass required secrets through a separate credential", name)
		}
		wanted[strings.ToUpper(name)] = true
	}

	env := make(map[string]string)
	for _, pair := range os.Environ() {
		name, value, found := strings.Cut(pair, "=")
		if !found {
			continue
		}
		upper := strings.ToUpper(name)
		if wanted[upper] || strings.HasPrefix(upper, "LC_") {
			env[name] = value
		}
	}
	return envPairs(env), nil
}

func writeCredentialFile(value string) (string, func(), error) {
	file, err := os.CreateTemp("", "whagons-credential-*")
	if err != nil {
		return "", nil, err
	}
	path := file.Name()
	cleanup := func() {
		_ = os.Remove(path)
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		cleanup()
		return "", nil, err
	}
	if _, err := io.WriteString(file, value); err != nil {
		file.Close()
		cleanup()
		return "", nil, err
	}
	if err := file.Close(); err != nil {
		cleanup()
		return "", nil, err
	}
	return path, cleanup, nil
}

func flattenEnv(env map[string]string, prefix, path string, value any) {
	if object, ok := value.(map[string]any); ok {
		for key, nested := range object {
			next := key
			if path != "" {
				next = path + "_" + key
			}
			flattenEnv(env, prefix, next, nested)
		}
		return
	}
	key := prefix + "_" + sanitizeEnv(firstNonEmpty(path, "VALUE"))
	switch typed := value.(type) {
	case string:
		env[key] = typed
	default:
		data, _ := json.Marshal(typed)
		env[key] = string(data)
	}
}

func envPairs(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, key := range keys {
		pairs = append(pairs, key+"="+env[key])
	}
	return pairs
}

var envReplace = regexp.MustCompile(`[^A-Za-z0-9]+`)

func sanitizeEnv(value string) string {
	value = envReplace.ReplaceAllString(value, "_")
	value = strings.Trim(value, "_")
	if value == "" {
		value = "CREDENTIAL"
	}
	return strings.ToUpper(value)
}

func openBrowser(rawURL string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", rawURL).Start()
	case "windows":
		return exec.Command("cmd", "/c", "start", "", rawURL).Start()
	default:
		return exec.Command("xdg-open", rawURL).Start()
	}
}

func devJWT() string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"whagons-skills-cli","email":"cli@whagons.local"}`))
	return header + "." + payload + ".cli"
}

func randomID() string {
	id, err := secureRandomID()
	if err == nil {
		return id
	}
	return fmt.Sprintf("id_%d", time.Now().UnixNano())
}

func secureRandomID() (string, error) {
	var buf [18]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func prettyJSON(value any) string {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(value)
	return strings.TrimSpace(buf.String())
}
