package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const managedMarkerName = ".whagons-managed.json"

var canonicalTargetOrder = []string{"agents", "claude", "cursor", "opencode"}
var errLocallyModifiedSkill = errors.New("managed skill was modified locally")

type ManagedMarker struct {
	Version       int    `json:"version"`
	SkillID       string `json:"skillId"`
	SkillName     string `json:"skillName"`
	ContentSHA256 string `json:"contentSha256"`
	Signature     string `json:"signature"`
}

type PruneResult struct {
	Removed   []string
	Preserved []string
}

type LinkResult struct {
	Linked    []string
	Removed   []string
	Conflicts []string
}

type SkillSyncResult struct {
	Installed int
	Removed   []string
	Preserved []string
	Skipped   []string
	Links     map[string]LinkResult
	Revision  string
}

func markerPayload(marker ManagedMarker) []byte {
	return []byte(fmt.Sprintf("%d\x00%s\x00%s\x00%s", marker.Version, marker.SkillID, marker.SkillName, marker.ContentSHA256))
}

func signMarker(key []byte, marker ManagedMarker) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(markerPayload(marker))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func newManagedMarker(key []byte, skill Skill) ManagedMarker {
	hash := sha256.Sum256([]byte(skill.Content))
	marker := ManagedMarker{
		Version:       1,
		SkillID:       skill.ID,
		SkillName:     skill.Name,
		ContentSHA256: hex.EncodeToString(hash[:]),
	}
	marker.Signature = signMarker(key, marker)
	return marker
}

func (marker ManagedMarker) valid(key, content []byte) bool {
	if !marker.owned(key) {
		return false
	}
	hash := sha256.Sum256(content)
	if !hmac.Equal([]byte(marker.ContentSHA256), []byte(hex.EncodeToString(hash[:]))) {
		return false
	}
	return true
}

func (marker ManagedMarker) owned(key []byte) bool {
	if marker.Version != 1 || marker.SkillID == "" || marker.SkillName == "" || len(key) < 32 {
		return false
	}
	want := signMarker(key, marker)
	return hmac.Equal([]byte(marker.Signature), []byte(want))
}

func readManagedMarker(dir string, key []byte) (ManagedMarker, bool, error) {
	content, err := readRegularFile(filepath.Join(dir, "SKILL.md"), maxSkillBytes)
	if err != nil {
		return ManagedMarker{}, false, err
	}
	markerBytes, err := readRegularFile(filepath.Join(dir, managedMarkerName), 64<<10)
	if err != nil {
		return ManagedMarker{}, false, err
	}
	var marker ManagedMarker
	if err := json.Unmarshal(markerBytes, &marker); err != nil {
		return ManagedMarker{}, false, err
	}
	return marker, marker.valid(key, content), nil
}

func managedDirectoryHasOnlyOwnedFiles(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 2 {
		return false
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return false
		}
		seen[entry.Name()] = true
	}
	return seen["SKILL.md"] && seen[managedMarkerName]
}

func writeManagedSkill(dir string, skill Skill, key []byte) error {
	if len(key) < 32 {
		return errors.New("managed skill signing key must be at least 32 bytes")
	}
	if info, err := os.Lstat(dir); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("refusing non-directory managed skill path: %s", dir)
		}
		marker, valid, markerErr := readManagedMarker(dir, key)
		if markerErr != nil || !marker.owned(key) {
			return fmt.Errorf("refusing to overwrite unowned or locally modified skill directory: %s", dir)
		}
		if !valid {
			return fmt.Errorf("%w: %s", errLocallyModifiedSkill, dir)
		}
		if !managedDirectoryHasOnlyOwnedFiles(dir) {
			return fmt.Errorf("%w: %s contains additional files", errLocallyModifiedSkill, dir)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := ensureSafeDirectory(dir, 0o755); err != nil {
		return err
	}
	if err := writeRegularFile(filepath.Join(dir, "SKILL.md"), []byte(skill.Content), 0o644); err != nil {
		return err
	}
	marker := newManagedMarker(key, skill)
	markerBytes, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return err
	}
	markerBytes = append(markerBytes, '\n')
	return writeRegularFile(filepath.Join(dir, managedMarkerName), markerBytes, 0o600)
}

func pruneManagedSkills(root string, active map[string]bool, key []byte) (PruneResult, error) {
	var result PruneResult
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	for _, entry := range entries {
		if !entry.IsDir() || active[entry.Name()] {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		_, valid, markerErr := readManagedMarker(dir, key)
		if markerErr != nil {
			if _, statErr := os.Stat(filepath.Join(dir, managedMarkerName)); statErr == nil {
				result.Preserved = append(result.Preserved, entry.Name())
			}
			continue
		}
		if !valid || !managedDirectoryHasOnlyOwnedFiles(dir) {
			result.Preserved = append(result.Preserved, entry.Name())
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			return result, err
		}
		result.Removed = append(result.Removed, entry.Name())
	}
	sort.Strings(result.Removed)
	sort.Strings(result.Preserved)
	return result, nil
}

func sameResolvedPath(path, want string) bool {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}
	resolvedAbs, err := filepath.Abs(resolved)
	if err != nil {
		return false
	}
	wantAbs, err := filepath.Abs(want)
	if err != nil {
		return false
	}
	return filepath.Clean(resolvedAbs) == filepath.Clean(wantAbs)
}

func managedLinkTarget(path string) (string, bool) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", false
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(path)
		if err != nil {
			return "", false
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(path), target)
		}
		absolute, err := filepath.Abs(target)
		return absolute, err == nil
	}
	if runtime.GOOS == "windows" {
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			return "", false
		}
		absolute, err := filepath.Abs(resolved)
		return absolute, err == nil
	}
	return "", false
}

func createDirectoryLink(source, destination string) error {
	if err := os.Symlink(source, destination); err == nil {
		return nil
	} else if runtime.GOOS != "windows" {
		return err
	}
	output, err := exec.Command("cmd", "/c", "mklink", "/J", destination, source).CombinedOutput()
	if err != nil {
		return fmt.Errorf("create directory junction: %w (%s)", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func installIntegrationLinks(store, target string, active map[string]bool) (LinkResult, error) {
	var result LinkResult
	if err := ensureSafeDirectory(target, 0o755); err != nil {
		return result, err
	}
	names := make([]string, 0, len(active))
	for name := range active {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		source := filepath.Join(store, name)
		destination := filepath.Join(target, name)
		if _, err := os.Lstat(destination); err == nil {
			if sameResolvedPath(destination, source) {
				result.Linked = append(result.Linked, name)
				continue
			}
			result.Conflicts = append(result.Conflicts, name)
			continue
		} else if !os.IsNotExist(err) {
			return result, err
		}
		if err := createDirectoryLink(source, destination); err != nil {
			return result, fmt.Errorf("link %s: %w", name, err)
		}
		result.Linked = append(result.Linked, name)
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return result, err
	}
	storeAbs, err := filepath.Abs(store)
	if err != nil {
		return result, err
	}
	for _, entry := range entries {
		if active[entry.Name()] {
			continue
		}
		path := filepath.Join(target, entry.Name())
		resolvedAbs, managedLink := managedLinkTarget(path)
		if !managedLink {
			continue
		}
		if filepath.Dir(filepath.Clean(resolvedAbs)) != filepath.Clean(storeAbs) {
			continue
		}
		if err := os.Remove(path); err != nil {
			return result, err
		}
		result.Removed = append(result.Removed, entry.Name())
	}
	sort.Strings(result.Removed)
	return result, nil
}

func normalizeTargets(values []string) ([]string, error) {
	selected := map[string]bool{}
	for _, value := range values {
		for _, item := range strings.Split(value, ",") {
			item = strings.ToLower(strings.TrimSpace(item))
			switch item {
			case "", "none":
				continue
			case "all":
				// The portable Agent Skills directory covers Codex, T3, Cursor,
				// and OpenCode. Claude needs its native personal directory.
				selected["agents"] = true
				selected["claude"] = true
			case "codex", "t3", "t3-code", "agents", "standard":
				selected["agents"] = true
			case "claude", "cursor", "opencode":
				selected[item] = true
			default:
				return nil, fmt.Errorf("unknown skill target %q (use all, codex, t3, claude, cursor, opencode, or agents)", item)
			}
		}
	}
	var result []string
	for _, target := range canonicalTargetOrder {
		if selected[target] {
			result = append(result, target)
		}
	}
	return result, nil
}

func integrationTarget(name string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch name {
	case "agents":
		return filepath.Join(home, ".agents", "skills"), nil
	case "claude":
		return filepath.Join(home, ".claude", "skills"), nil
	case "cursor":
		return filepath.Join(home, ".cursor", "skills"), nil
	case "opencode":
		return filepath.Join(home, ".config", "opencode", "skills"), nil
	default:
		return "", fmt.Errorf("unknown integration target %q", name)
	}
}

func managedSkillsDir() string {
	if dir := envValue("SKILLS_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".whagons-dev", "skills")
	}
	return filepath.Join(home, ".whagons-dev", "skills")
}

func ensureManagementKey(config *Config) ([]byte, bool, error) {
	if config.ManagementKey != "" {
		key, err := base64.RawURLEncoding.DecodeString(config.ManagementKey)
		if err != nil || len(key) < 32 {
			return nil, false, errors.New("invalid managed-skill signing key in CLI config")
		}
		return key, false, nil
	}
	key := make([]byte, 32)
	if _, err := randRead(key); err != nil {
		return nil, false, err
	}
	config.ManagementKey = base64.RawURLEncoding.EncodeToString(key)
	return key, true, nil
}

// randRead is replaceable in tests without weakening production key generation.
var randRead = func(value []byte) (int, error) { return rand.Read(value) }

func syncManagedSkills(client *Client, apiKey string, config *Config, targets []string) (SkillSyncResult, error) {
	result := SkillSyncResult{Links: map[string]LinkResult{}}
	key, changed, err := ensureManagementKey(config)
	if err != nil {
		return result, err
	}
	if changed {
		if err := writeConfig(*config); err != nil {
			return result, err
		}
	}
	store := managedSkillsDir()
	if err := ensureSafeDirectory(store, 0o700); err != nil {
		return result, err
	}
	var metadata []Skill
	if err := client.Query("agent.skills.list", map[string]any{"apiKey": apiKey}, &metadata); err != nil {
		return result, err
	}
	result.Revision = skillMetadataRevision(metadata)
	active := map[string]bool{}
	for _, meta := range metadata {
		var skill Skill
		if err := client.Query("agent.skills.get", map[string]any{"apiKey": apiKey, "id": meta.ID}, &skill); err != nil {
			// A skill can drop out between list and get: approval reset by a
			// re-upload, or deletion. That is a definitive server answer for
			// one skill, not a sync failure — keep the local copy and finish
			// syncing the rest instead of aborting the whole run.
			if strings.Contains(err.Error(), "skill not found") {
				if name := safePathName(meta.Name); name != "" && !active[name] {
					active[name] = true
					result.Skipped = append(result.Skipped, name)
				}
				continue
			}
			return result, fmt.Errorf("fetch %s: %w", meta.Name, err)
		}
		name := safePathName(skill.Name)
		if name == "" {
			return result, fmt.Errorf("skill %q has no safe local name", skill.Name)
		}
		if active[name] {
			return result, fmt.Errorf("multiple skills resolve to local name %q", name)
		}
		if len(skill.Content) > maxSkillBytes {
			return result, fmt.Errorf("refusing oversized skill %s (%d bytes)", skill.Name, len(skill.Content))
		}
		if err := writeManagedSkill(filepath.Join(store, name), skill, key); err != nil {
			if errors.Is(err, errLocallyModifiedSkill) {
				active[name] = true
				result.Preserved = append(result.Preserved, name)
				continue
			}
			return result, err
		}
		active[name] = true
		result.Installed++
	}
	for _, targetName := range targets {
		targetDir, err := integrationTarget(targetName)
		if err != nil {
			return result, err
		}
		linkResult, err := installIntegrationLinks(store, targetDir, active)
		if err != nil {
			return result, fmt.Errorf("install %s integration: %w", targetName, err)
		}
		result.Links[targetName] = linkResult
	}
	pruned, err := pruneManagedSkills(store, active, key)
	if err != nil {
		return result, err
	}
	result.Removed = pruned.Removed
	result.Preserved = append(result.Preserved, pruned.Preserved...)
	sort.Strings(result.Preserved)
	return result, nil
}

func skillMetadataRevision(skills []Skill) string {
	copyOfSkills := append([]Skill(nil), skills...)
	sort.Slice(copyOfSkills, func(i, j int) bool {
		if copyOfSkills[i].ID == copyOfSkills[j].ID {
			return copyOfSkills[i].UpdatedAt < copyOfSkills[j].UpdatedAt
		}
		return copyOfSkills[i].ID < copyOfSkills[j].ID
	})
	hash := sha256.New()
	for _, skill := range copyOfSkills {
		fmt.Fprintf(hash, "%s\x00%s\x00%s\x00%t\x00", skill.ID, skill.Name, skill.UpdatedAt, skill.Approved)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func installAndRememberSkills(client *Client, apiKey string, targets []string) error {
	targets, err := normalizeTargets(targets)
	if err != nil {
		return err
	}
	if len(targets) == 0 {
		return errors.New("choose at least one skill target")
	}
	config, _ := readConfig()
	previousTargets := append([]string(nil), config.SkillTargets...)
	config.SkillTargets = targets
	result, err := syncManagedSkills(client, apiKey, &config, targets)
	if err != nil {
		return err
	}
	if err := writeConfig(config); err != nil {
		return err
	}
	if err := removeDeselectedIntegrationLinks(previousTargets, targets); err != nil {
		return err
	}
	reportSkillSync(result, targets)
	return nil
}

func removeDeselectedIntegrationLinks(previous, current []string) error {
	selected := map[string]bool{}
	for _, name := range current {
		selected[name] = true
	}
	for _, name := range previous {
		if selected[name] {
			continue
		}
		target, err := integrationTarget(name)
		if err != nil {
			return err
		}
		if _, err := installIntegrationLinks(managedSkillsDir(), target, map[string]bool{}); err != nil {
			return fmt.Errorf("remove disabled %s integration links: %w", name, err)
		}
	}
	return nil
}

func installManagedSkillsToCustomDir(client *Client, apiKey, target string) error {
	config, _ := readConfig()
	result, err := syncManagedSkills(client, apiKey, &config, nil)
	if err != nil {
		return err
	}
	active, err := managedActiveNames(managedSkillsDir(), config.ManagementKey)
	if err != nil {
		return err
	}
	links, err := installIntegrationLinks(managedSkillsDir(), target, active)
	if err != nil {
		return err
	}
	result.Links["custom"] = links
	reportSkillSync(result, []string{"custom"})
	return nil
}

func managedActiveNames(store, encodedKey string) (map[string]bool, error) {
	key, err := base64.RawURLEncoding.DecodeString(encodedKey)
	if err != nil || len(key) < 32 {
		return nil, errors.New("invalid managed-skill signing key")
	}
	active := map[string]bool{}
	entries, err := os.ReadDir(store)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		_, valid, markerErr := readManagedMarker(filepath.Join(store, entry.Name()), key)
		if markerErr == nil && valid {
			active[entry.Name()] = true
		}
	}
	return active, nil
}

func reportSkillSync(result SkillSyncResult, targets []string) {
	fmt.Printf("\n✓ Synced %d vault skills into %s\n", result.Installed, managedSkillsDir())
	if len(targets) > 0 {
		fmt.Printf("✓ Integrations: %s\n", strings.Join(targets, ", "))
	}
	if len(result.Removed) > 0 {
		fmt.Printf("✓ Removed deleted managed skills: %s\n", strings.Join(result.Removed, ", "))
	}
	if len(result.Preserved) > 0 {
		fmt.Printf("! Preserved locally modified managed skills: %s\n", strings.Join(result.Preserved, ", "))
	}
	if len(result.Skipped) > 0 {
		fmt.Printf("! Kept local copies of skills the vault no longer serves (pending approval or deleted): %s\n", strings.Join(result.Skipped, ", "))
	}
	for target, links := range result.Links {
		if len(links.Conflicts) > 0 {
			fmt.Printf("! %s kept existing user-owned skills: %s\n", target, strings.Join(links.Conflicts, ", "))
		}
	}
}

func printSkillStatus() error {
	config, _ := readConfig()
	fmt.Printf("Managed store: %s\n", managedSkillsDir())
	if len(config.SkillTargets) == 0 {
		fmt.Println("Integrations: not configured")
	} else {
		fmt.Printf("Integrations: %s\n", strings.Join(config.SkillTargets, ", "))
	}
	if config.SyncIntervalSeconds > 0 {
		fmt.Printf("Background interval: %s\n", time.Duration(config.SyncIntervalSeconds)*time.Second)
	}
	fmt.Printf("Automatic CLI updates: %t\n", config.AutoSelfUpdate)
	status, err := startupStatus()
	if err != nil {
		return err
	}
	fmt.Printf("Startup service: %s\n", status)
	return nil
}
