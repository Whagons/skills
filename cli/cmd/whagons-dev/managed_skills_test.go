package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestManagedMarkerRejectsTampering(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	marker := newManagedMarker(key, Skill{ID: "skill-1", Name: "deploy", Content: "original"})
	if !marker.valid(key, []byte("original")) {
		t.Fatal("fresh marker should validate")
	}
	if marker.valid(key, []byte("changed")) {
		t.Fatal("marker must reject changed skill content")
	}
	marker.SkillID = "other"
	if marker.valid(key, []byte("original")) {
		t.Fatal("marker must reject changed ownership metadata")
	}
}

func TestWriteManagedSkillPreservesLocallyModifiedContent(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	dir := filepath.Join(t.TempDir(), "deploy")
	if err := writeManagedSkill(dir, Skill{ID: "deploy-id", Name: "deploy", Content: "original"}, key); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("local edit"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := writeManagedSkill(dir, Skill{ID: "deploy-id", Name: "deploy", Content: "vault update"}, key)
	if !errors.Is(err, errLocallyModifiedSkill) {
		t.Fatalf("error = %v, want locally modified sentinel", err)
	}
	data, readErr := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "local edit" {
		t.Fatalf("local edit was overwritten: %q", data)
	}
}

func TestRunForwardsSingleLevelCommandFlags(t *testing.T) {
	err := run([]string{"setup", "--interval", "1s"})
	if err == nil || !strings.Contains(err.Error(), "at least 15 seconds") {
		t.Fatalf("setup error = %v", err)
	}
	err = run([]string{"daemon", "--interval", "1s", "--once"})
	if err == nil || !strings.Contains(err.Error(), "at least 15 seconds") {
		t.Fatalf("daemon error = %v", err)
	}
}

func TestSelfUpdateDueRunsAtMostDaily(t *testing.T) {
	now := time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC)
	if selfUpdateDue(Config{}, now) {
		t.Fatal("disabled automatic updates should not run")
	}
	if !selfUpdateDue(Config{AutoSelfUpdate: true}, now) {
		t.Fatal("automatic updates with no previous attempt should run")
	}
	config := Config{AutoSelfUpdate: true, LastSelfUpdate: now.Add(-23 * time.Hour).Format(time.RFC3339)}
	if selfUpdateDue(config, now) {
		t.Fatal("automatic update should wait 24 hours")
	}
	config.LastSelfUpdate = now.Add(-25 * time.Hour).Format(time.RFC3339)
	if !selfUpdateDue(config, now) {
		t.Fatal("automatic update should run after 24 hours")
	}
}

func TestReplaceExecutableUsesCompleteReplacementFile(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "new-binary")
	destination := filepath.Join(root, "whagons-dev")
	if err := os.WriteFile(source, []byte("new executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("old executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := replaceExecutable(source, destination); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new executable" {
		t.Fatalf("destination = %q", data)
	}
}

func TestEnvironmentOverrideReplacesExistingValue(t *testing.T) {
	t.Setenv("GOBIN", "/old")
	environment := environmentOverride("GOBIN", "/new")
	count := 0
	for _, item := range environment {
		if strings.HasPrefix(strings.ToUpper(item), "GOBIN=") {
			count++
			if item != "GOBIN=/new" {
				t.Fatalf("GOBIN override = %q", item)
			}
		}
	}
	if count != 1 {
		t.Fatalf("GOBIN entries = %d", count)
	}
}

func TestBrowserAuthorizationPreservesManagedSkillConfiguration(t *testing.T) {
	existing := Config{
		ManagementKey:       "local-signing-key",
		SkillTargets:        []string{"agents", "claude"},
		SyncIntervalSeconds: 60,
		AutoSelfUpdate:      true,
		LastSelfUpdate:      "2026-08-13T00:00:00Z",
		GoBinary:            "/usr/local/go/bin/go",
	}
	updated := configWithAuthorization(existing, "skv_new", "https://skills.whagons.com/", "wss://example.test/ws", "skills")
	if updated.APIKey != "skv_new" || updated.AppURL != "https://skills.whagons.com/" || updated.WSURL != "wss://example.test/ws" || updated.Project != "skills" {
		t.Fatalf("authorization fields were not updated: %#v", updated)
	}
	if updated.ManagementKey != existing.ManagementKey || strings.Join(updated.SkillTargets, ",") != "agents,claude" || updated.SyncIntervalSeconds != 60 || !updated.AutoSelfUpdate || updated.LastSelfUpdate != existing.LastSelfUpdate || updated.GoBinary != existing.GoBinary {
		t.Fatalf("local managed-skill configuration was lost: %#v", updated)
	}
}

func TestPruneManagedSkillsOnlyRemovesSignedUnmodifiedDirectories(t *testing.T) {
	root := t.TempDir()
	key := []byte("01234567890123456789012345678901")

	owned := filepath.Join(root, "owned")
	if err := writeManagedSkill(owned, Skill{ID: "owned-id", Name: "owned", Content: "owned content"}, key); err != nil {
		t.Fatal(err)
	}
	tampered := filepath.Join(root, "tampered")
	if err := writeManagedSkill(tampered, Skill{ID: "tampered-id", Name: "tampered", Content: "before"}, key); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tampered, "SKILL.md"), []byte("after"), 0o644); err != nil {
		t.Fatal(err)
	}
	unowned := filepath.Join(root, "unowned")
	if err := os.MkdirAll(unowned, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unowned, "SKILL.md"), []byte("personal"), 0o644); err != nil {
		t.Fatal(err)
	}
	withExtra := filepath.Join(root, "with-extra")
	if err := writeManagedSkill(withExtra, Skill{ID: "extra-id", Name: "with-extra", Content: "owned content"}, key); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(withExtra, "personal.txt"), []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := pruneManagedSkills(root, map[string]bool{}, key)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Removed) != 1 || result.Removed[0] != "owned" {
		t.Fatalf("removed = %#v, want only owned", result.Removed)
	}
	for _, path := range []string{tampered, unowned, withExtra} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("%s should be preserved: %v", path, err)
		}
	}
	if len(result.Preserved) != 2 || result.Preserved[0] != "tampered" || result.Preserved[1] != "with-extra" {
		t.Fatalf("preserved = %#v, want tampered and with-extra", result.Preserved)
	}
}

func TestInstallIntegrationDoesNotReplaceUserDirectory(t *testing.T) {
	root := t.TempDir()
	store := filepath.Join(root, "store")
	target := filepath.Join(root, "target")
	key := []byte("01234567890123456789012345678901")
	if err := writeManagedSkill(filepath.Join(store, "deploy"), Skill{ID: "deploy-id", Name: "deploy", Content: "vault"}, key); err != nil {
		t.Fatal(err)
	}
	personal := filepath.Join(target, "deploy")
	if err := os.MkdirAll(personal, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(personal, "SKILL.md"), []byte("personal"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := installIntegrationLinks(store, target, map[string]bool{"deploy": true})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Conflicts) != 1 || result.Conflicts[0] != "deploy" {
		t.Fatalf("conflicts = %#v", result.Conflicts)
	}
	data, err := os.ReadFile(filepath.Join(personal, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "personal" {
		t.Fatalf("personal skill was overwritten: %q", data)
	}
}

func TestInstallIntegrationRemovesBrokenManagedLink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink permissions vary on Windows")
	}
	root := t.TempDir()
	store := filepath.Join(root, "store")
	target := filepath.Join(root, "target")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(target, "deleted")
	if err := os.Symlink(filepath.Join(store, "deleted"), link); err != nil {
		t.Fatal(err)
	}
	result, err := installIntegrationLinks(store, target, map[string]bool{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Removed) != 1 || result.Removed[0] != "deleted" {
		t.Fatalf("removed = %#v", result.Removed)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("broken managed link still exists: %v", err)
	}
}

func TestNormalizeTargetsUsesPortableAgentsDirectoryForCodexAndT3(t *testing.T) {
	targets, err := normalizeTargets([]string{"codex", "t3", "claude"})
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 2 || targets[0] != "agents" || targets[1] != "claude" {
		t.Fatalf("targets = %#v, want agents and claude", targets)
	}
}

func TestNormalizeAllAvoidsDuplicateCursorAndOpenCodeDiscovery(t *testing.T) {
	targets, err := normalizeTargets([]string{"all"})
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 2 || targets[0] != "agents" || targets[1] != "claude" {
		t.Fatalf("targets = %#v, want portable agents and claude", targets)
	}
}
