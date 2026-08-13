package main

import (
	"fmt"
	"strings"
)

var helpGroups = map[string]bool{
	"auth": true, "skills": true, "api-keys": true, "credentials": true, "startup": true,
}

// handleHelpRequest resolves help before command dispatch, so asking for help
// never starts browser authentication or opens a network connection.
func handleHelpRequest(args []string) (bool, error) {
	if len(args) == 0 {
		return true, printHelp(nil)
	}
	if args[0] == "help" {
		return true, printHelp(args[1:])
	}
	if args[0] == "-h" || args[0] == "--help" {
		return true, printHelp(nil)
	}
	if len(args) == 1 && helpGroups[args[0]] {
		return true, printHelp(args)
	}
	if len(args) >= 2 && args[1] == "help" {
		return true, printHelp(append([]string{args[0]}, args[2:]...))
	}
	for index, arg := range args {
		if arg != "-h" && arg != "--help" {
			continue
		}
		path := args[:index]
		if len(path) > 2 {
			path = path[:2]
		}
		return true, printHelp(path)
	}
	return false, nil
}

func normalizeHelpTopic(parts []string) string {
	clean := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.ToLower(strings.TrimSpace(part)); part != "" {
			clean = append(clean, part)
		}
	}
	topic := strings.Join(clean, " ")
	switch topic {
	case "--update", "self-update":
		return "update"
	case "api", "keys":
		return "api-keys"
	case "env", "config":
		return "environment"
	case "target", "agents":
		return "targets"
	}
	return topic
}

func printHelp(parts []string) error {
	topic := normalizeHelpTopic(parts)
	if topic == "" {
		fmt.Print(rootHelp)
		return nil
	}
	page, ok := helpPages[topic]
	if !ok {
		fmt.Print(helpTopics)
		return fmt.Errorf("unknown help topic %q", topic)
	}
	fmt.Print(page)
	return nil
}

const rootHelp = `whagons-dev — Whagons developer CLI for the Skills Vault

Downloads approved team skills from https://skills.whagons.com, installs them
for local coding agents, and safely provides project credentials to commands.

Quick start
  go install github.com/whagons/skills/cli/cmd/whagons-dev@latest
  whagons-dev setup

SKILLS & AGENTS
  setup          Configure this computer
  skills         List, upload, install, and update skills
  startup        Manage background skill synchronization
  daemon         Run synchronization directly

SECRETS & ACCESS
  auth           Log in, check status, or log out
  credentials    List, store, or inject credentials
  api-keys       List or revoke API keys

CLI
  update         Update whagons-dev
  version        Print the installed version
  help           Show help

  whagons-dev help <topic>    Group or command help
  whagons-dev help all        Complete command list

Secrets are not printed by default. Managed sync never overwrites an existing
user-owned skill directory.
`

const helpTopics = `Available help topics

  setup  update  startup  daemon  auth  skills  api-keys  credentials
  targets  environment  examples  version  all

Use: whagons-dev help <topic>
     whagons-dev help <group> <command>
`

const skillsHelp = `SKILL COMMANDS

  whagons-dev skills list
  whagons-dev skills get <name-or-id> [--output FILE]
  whagons-dev skills copy <name-or-id>
  whagons-dev skills upload <SKILL.md> [--name NAME] [--id ID] [--summary TEXT]
  whagons-dev skills sync [DIR]
  whagons-dev skills install [--targets all|LIST]
  whagons-dev skills update
  whagons-dev skills status
  whagons-dev skills delete <name-or-id>

Compatibility
  whagons-dev skills install-codex [--dir DIR]
  whagons-dev skills update-codex [--dir DIR]

Uploads require owner approval. Only approved skills are installed.
`

const authHelp = `AUTH COMMANDS

  whagons-dev auth login [--app-url URL]
  whagons-dev auth set-key --stdin
  whagons-dev auth status
  whagons-dev auth logout [--local-only]

Browser login saves a one-year scoped key in ~/.whagons-dev/config.json. Use
set-key with stdin for headless environments so keys do not enter shell history.
`

const credentialsHelp = `CREDENTIAL COMMANDS

  whagons-dev credentials list
  whagons-dev credentials set <name> [--summary TEXT] [--id ID] --value-stdin
  whagons-dev credentials delete <id>
  whagons-dev credentials exec <name> [--via file|stdin|env] [--prefix PREFIX]
      [--inherit-env NAME[,NAME...]] -- <command> [args...]

Exec uses a temporary private file by default and sets WHAGONS_CREDENTIAL_FILE.
Use --via stdin when appropriate; --via env is compatibility mode.
`

const apiKeysHelp = `API KEY COMMANDS

  whagons-dev api-keys list
  whagons-dev api-keys revoke <id>

Create new keys through a Google-verified session in the Skills Vault.
`

const startupHelp = `STARTUP COMMANDS

  whagons-dev startup install
  whagons-dev startup status
  whagons-dev startup remove

Uses a systemd user service on Linux, LaunchAgent on macOS, or Task Scheduler
on Windows. It runs as the current user, not root.
`

const fullReference = `ALL COMMANDS

  whagons-dev setup [--targets LIST] [--no-startup] [--interval DURATION]
      [--no-auto-update]
  whagons-dev update
  whagons-dev self-update
  whagons-dev --update
  whagons-dev version
  whagons-dev help [topic [command]]

  whagons-dev startup install
  whagons-dev startup status
  whagons-dev startup remove
  whagons-dev daemon [--interval DURATION] [--once] [--no-self-update]

  whagons-dev auth login [--app-url URL]
  whagons-dev auth set-key --stdin
  whagons-dev auth status
  whagons-dev auth logout [--local-only]

  whagons-dev skills list
  whagons-dev skills get <name-or-id> [--output FILE]
  whagons-dev skills copy <name-or-id>
  whagons-dev skills upload <SKILL.md> [--name NAME] [--id ID] [--summary TEXT]
  whagons-dev skills sync [DIR]
  whagons-dev skills install [--targets all|LIST]
  whagons-dev skills update
  whagons-dev skills status
  whagons-dev skills install-codex [--dir DIR]
  whagons-dev skills update-codex [--dir DIR]
  whagons-dev skills delete <name-or-id>

  whagons-dev api-keys list
  whagons-dev api-keys revoke <id>

  whagons-dev credentials list
  whagons-dev credentials set <name> [--summary TEXT] [--id ID] --value-stdin
  whagons-dev credentials delete <id>
  whagons-dev credentials exec <name> [--via file|stdin|env] [--prefix PREFIX]
      [--inherit-env NAME[,NAME...]] -- <command> [args...]
`

var helpPages = map[string]string{
	"all":         fullReference,
	"help":        helpTopics,
	"skills":      skillsHelp,
	"auth":        authHelp,
	"credentials": credentialsHelp,
	"api-keys":    apiKeysHelp,
	"startup":     startupHelp,
	"setup": `SETUP

  whagons-dev setup [--targets LIST] [--no-startup] [--interval DURATION]
      [--no-auto-update]

Authenticates, installs approved skills, remembers targets, and normally starts
background sync. The default interval is 1m; the minimum is 15s.
`,
	"update": `UPDATE

  whagons-dev update
  whagons-dev self-update
  whagons-dev --update

Installs the latest official Go module and replaces this CLI. Go is required.
`,
	"daemon": `DAEMON

  whagons-dev daemon [--interval DURATION] [--once] [--no-self-update]

Syncs immediately, watches live vault changes, and reconnects at the interval.
`,
	"targets": `TARGETS

  agents    ~/.agents/skills          Codex, T3, Cursor, OpenCode
  codex     alias for agents
  t3        alias for agents
  claude    ~/.claude/skills
  cursor    ~/.cursor/skills           optional native target
  opencode  ~/.config/opencode/skills  optional native target
  all       agents, claude

Canonical copies live in ~/.whagons-dev/skills. Does not overwrite existing
user-owned skill directories.
`,
	"environment": `ENVIRONMENT

  WHAGONS_DEV_API_KEY     Process API key
  WHAGONS_DEV_WS_URL      Gonvex WebSocket URL
  WHAGONS_DEV_PROJECT     Gonvex project
  WHAGONS_DEV_APP_URL     Browser app URL
  WHAGONS_DEV_CONFIG      Alternate config file
  WHAGONS_DEV_SKILLS_DIR  Alternate managed-skill directory

Legacy WHAGONS_SKILLS_* names remain supported.
`,
	"examples": `EXAMPLES

  whagons-dev setup
  whagons-dev skills install --targets all
  whagons-dev skills update
  whagons-dev skills sync ./skills
  whagons-dev credentials exec coolify-whagons -- node deploy.mjs
  printf '%s' "$KEY" | whagons-dev auth set-key --stdin
`,
	"version": `VERSION

  whagons-dev version
  whagons-dev --version
  whagons-dev -v
`,
	"skills install": `INSTALL SKILLS

  whagons-dev skills install [--targets all|LIST]

TARGETS
  agents, codex, t3, claude, cursor, opencode, all

The all target resolves to agents, claude. Does not overwrite user-owned skill
directories. Signed, unchanged managed skills are pruned after vault deletion.
`,
	"credentials exec": credentialsHelp,
}

func init() {
	for _, command := range []string{"list", "get", "copy", "upload", "sync", "update", "status", "install-codex", "update-codex", "delete"} {
		helpPages["skills "+command] = skillsHelp
	}
	for _, command := range []string{"login", "set-key", "status", "logout"} {
		helpPages["auth "+command] = authHelp
	}
	for _, command := range []string{"list", "revoke"} {
		helpPages["api-keys "+command] = apiKeysHelp
	}
	for _, command := range []string{"list", "set", "delete"} {
		helpPages["credentials "+command] = credentialsHelp
	}
	for _, command := range []string{"install", "status", "remove"} {
		helpPages["startup "+command] = startupHelp
	}
}
