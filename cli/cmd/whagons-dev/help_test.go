package main

import (
	"io"
	"os"
	"strings"
	"testing"
)

func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	original := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writer
	callErr := fn()
	_ = writer.Close()
	os.Stdout = original
	output, readErr := io.ReadAll(reader)
	_ = reader.Close()
	if readErr != nil {
		t.Fatal(readErr)
	}
	return string(output), callErr
}

func requireHelpText(t *testing.T, output string, values ...string) {
	t.Helper()
	for _, value := range values {
		if !strings.Contains(output, value) {
			t.Fatalf("help output missing %q:\n%s", value, output)
		}
	}
}

func TestRootHelpExplainsTheCLIAndQuickStart(t *testing.T) {
	output, err := captureStdout(t, func() error { return run([]string{"help"}) })
	if err != nil {
		t.Fatal(err)
	}
	requireHelpText(t, output,
		"Whagons developer CLI",
		"Quick start",
		"whagons-dev setup",
		"Skills Vault",
		"SKILLS & AGENTS",
		"SECRETS & ACCESS",
		"whagons-dev help <topic>",
	)
}

func TestHelpRoutesBeforeAuthentication(t *testing.T) {
	cases := []struct {
		args []string
		want []string
	}{
		{[]string{"skills"}, []string{"SKILL COMMANDS", "skills install", "skills delete"}},
		{[]string{"skills", "help"}, []string{"SKILL COMMANDS", "skills upload"}},
		{[]string{"skills", "--help"}, []string{"SKILL COMMANDS", "skills status"}},
		{[]string{"help", "skills", "install"}, []string{"whagons-dev skills install", "--targets", "agents, claude"}},
		{[]string{"skills", "help", "install"}, []string{"whagons-dev skills install", "TARGETS"}},
		{[]string{"skills", "install", "--help"}, []string{"whagons-dev skills install", "Does not overwrite"}},
		{[]string{"setup", "--help"}, []string{"whagons-dev setup", "--no-startup", "--no-auto-update"}},
		{[]string{"credentials", "exec", "--help"}, []string{"credentials exec", "--via file|stdin|env", "WHAGONS_CREDENTIAL_FILE"}},
	}
	for _, test := range cases {
		t.Run(strings.Join(test.args, "_"), func(t *testing.T) {
			output, err := captureStdout(t, func() error { return run(test.args) })
			if err != nil {
				t.Fatal(err)
			}
			requireHelpText(t, output, test.want...)
		})
	}
}

func TestFullReferenceListsEveryPublicCommand(t *testing.T) {
	output, err := captureStdout(t, func() error { return run([]string{"help", "all"}) })
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{
		"setup", "update", "startup install", "daemon", "auth login", "auth set-key",
		"auth status", "auth logout", "skills list", "skills get", "skills copy",
		"skills upload", "skills sync", "skills install", "skills update", "skills status",
		"skills install-codex", "skills update-codex", "skills delete", "api-keys list",
		"api-keys revoke", "credentials list", "credentials set", "credentials delete",
		"credentials exec", "version", "help",
	} {
		requireHelpText(t, output, "whagons-dev "+command)
	}
}

func TestUnknownHelpTopicSuggestsAvailableTopics(t *testing.T) {
	output, err := captureStdout(t, func() error { return run([]string{"help", "mystery"}) })
	if err == nil || !strings.Contains(err.Error(), "unknown help topic") {
		t.Fatalf("error = %v", err)
	}
	requireHelpText(t, output, "Available help topics", "skills", "credentials", "targets")
}
