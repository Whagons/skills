package main

import (
	"flag"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWriteConfigRepairsExistingPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are not available on Windows")
	}

	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"apiKey":"old"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WHAGONS_DEV_CONFIG", path)

	if err := writeConfig(Config{APIKey: "replacement"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("config permissions = %o, want 600", got)
	}
}

func TestMigrateLegacyRuntimeOnlyRewritesFormerDefaults(t *testing.T) {
	legacy := Config{WSURL: legacyDefaultWSURL, Project: legacyDefaultProject}
	if !migrateLegacyRuntime(&legacy) {
		t.Fatal("expected former Skills Vault defaults to migrate")
	}
	if legacy.WSURL != defaultWSURL || legacy.Project != defaultProject {
		t.Fatalf("migrated runtime = %q project = %q", legacy.WSURL, legacy.Project)
	}

	custom := Config{WSURL: "wss://example.test/ws", Project: "personal"}
	if migrateLegacyRuntime(&custom) {
		t.Fatal("custom runtime must remain user-owned")
	}
	if custom.WSURL != "wss://example.test/ws" || custom.Project != "personal" {
		t.Fatalf("custom configuration changed: %#v", custom)
	}
}

func TestDiscoverSkillFilesRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation is not consistently available on Windows")
	}

	root := t.TempDir()
	skillDir := filepath.Join(root, "malicious")
	if err := os.Mkdir(skillDir, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "secret.txt")
	if err := os.WriteFile(target, []byte("do-not-upload"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(skillDir, "SKILL.md")); err != nil {
		t.Fatal(err)
	}

	if _, err := discoverSkillFiles(root); err == nil {
		t.Fatal("expected discovery to reject a symlinked SKILL.md")
	}
}

func TestChildEnvironmentExcludesSecretsByDefault(t *testing.T) {
	t.Setenv("PATH", "/safe/bin")
	t.Setenv("GONVEX_PROJECT_KEY", "must-not-leak")
	t.Setenv("SKILLS_SECRET_KEY", "must-not-leak")
	t.Setenv("WHAGONS_DEV_API_KEY", "must-not-leak")

	env, err := childEnvironment(nil)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "PATH=/safe/bin") {
		t.Fatalf("safe PATH missing from child environment: %q", joined)
	}
	for _, secret := range []string{"GONVEX_PROJECT_KEY", "SKILLS_SECRET_KEY", "WHAGONS_DEV_API_KEY", "must-not-leak"} {
		if strings.Contains(joined, secret) {
			t.Fatalf("child environment leaked %s", secret)
		}
	}
}

func TestCredentialExecDefaultsToPrivateFile(t *testing.T) {
	options, err := parseCredentialExec([]string{"deploy", "--", "tool", "arg"})
	if err != nil {
		t.Fatal(err)
	}
	if options.Via != "file" {
		t.Fatalf("delivery mode = %q, want file", options.Via)
	}
}

func TestParseInterspersedAcceptsFlagsAfterPositionals(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{"flags first", []string{"--value-stdin", "--summary", "TypeSafe key", "typesafe"}},
		{"flags last", []string{"typesafe", "--summary", "TypeSafe key", "--value-stdin"}},
		{"flags mixed", []string{"--summary=TypeSafe key", "typesafe", "--value-stdin"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fs := flag.NewFlagSet("credentials set", flag.ContinueOnError)
			summary := fs.String("summary", "", "")
			valueStdin := fs.Bool("value-stdin", false, "")
			if err := parseInterspersed(fs, tc.args); err != nil {
				t.Fatalf("parse: %v", err)
			}
			if !*valueStdin {
				t.Fatal("expected --value-stdin to be set")
			}
			if *summary != "TypeSafe key" {
				t.Fatalf("unexpected summary %q", *summary)
			}
			if fs.NArg() != 1 || fs.Arg(0) != "typesafe" {
				t.Fatalf("unexpected positionals %v", fs.Args())
			}
		})
	}
}

func TestParseInterspersedStopsAtDoubleDash(t *testing.T) {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	output := fs.String("output", "", "")
	if err := parseInterspersed(fs, []string{"skill", "--", "--output", "x"}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if *output != "" {
		t.Fatalf("flag after -- should be positional, got %q", *output)
	}
	if got := strings.Join(fs.Args(), " "); got != "skill --output x" {
		t.Fatalf("unexpected positionals %q", got)
	}
}

func TestParseInterspersedReportsUnknownFlag(t *testing.T) {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	fs.SetOutput(&strings.Builder{})
	if err := parseInterspersed(fs, []string{"skill", "--bogus"}); err == nil {
		t.Fatal("expected error for unknown flag")
	}
}
