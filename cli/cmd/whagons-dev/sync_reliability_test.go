package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeVault speaks the slice of the Gonvex WebSocket protocol the CLI uses:
// auth, agent.skills.list and agent.skills.get.
type fakeVault struct {
	mu     sync.Mutex
	skills map[string]Skill
}

func (v *fakeVault) put(skill Skill) {
	v.mu.Lock()
	defer v.mu.Unlock()
	skill.Approved = true
	v.skills[skill.ID] = skill
}

func (v *fakeVault) remove(id string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.skills, id)
}

func (v *fakeVault) serve(t *testing.T) string {
	t.Helper()
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			var msg map[string]any
			if err := conn.ReadJSON(&msg); err != nil {
				return
			}
			id := msg["id"]
			switch msg["type"] {
			case "auth":
				_ = conn.WriteJSON(map[string]any{"type": "auth.result", "id": id})
			case "query.subscribe":
				args, _ := msg["args"].(map[string]any)
				result, queryErr := v.query(msg["path"].(string), args)
				if queryErr != nil {
					_ = conn.WriteJSON(map[string]any{"type": "query.error", "id": id, "error": queryErr.Error()})
					continue
				}
				_ = conn.WriteJSON(map[string]any{"type": "query.result", "id": id, "result": result})
			}
		}
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http")
}

func (v *fakeVault) query(path string, args map[string]any) (any, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	switch path {
	case "agent.skills.list":
		list := []Skill{}
		for _, skill := range v.skills {
			meta := skill
			meta.Content = ""
			list = append(list, meta)
		}
		return list, nil
	case "agent.skills.get":
		if skill, ok := v.skills[args["id"].(string)]; ok {
			return skill, nil
		}
		return nil, errors.New("skill not found")
	}
	return nil, errors.New("unknown function " + path)
}

// isolateHome points every path the CLI writes (config, managed store, agent
// integration directories) at a temp directory on all three platforms.
func isolateHome(t *testing.T) (home, store string) {
	t.Helper()
	home = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("WHAGONS_DEV_CONFIG", filepath.Join(home, ".whagons-dev", "config.json"))
	store = filepath.Join(home, ".whagons-dev", "skills")
	t.Setenv("WHAGONS_DEV_SKILLS_DIR", store)
	return home, store
}

// forceJunctions makes symlink creation fail so Windows takes the junction
// fallback, as it does for users without Developer Mode.
func forceJunctions(t *testing.T) {
	t.Helper()
	previous := symlink
	symlink = func(string, string) error { return errors.New("symlink privilege not held") }
	t.Cleanup(func() { symlink = previous })
}

func syncOnce(t *testing.T, wsURL string, targets []string) SkillSyncResult {
	t.Helper()
	client, err := NewClient(wsURL, "test-project")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	config, _ := readConfig()
	result, err := syncManagedSkills(client, "test-key", &config, targets)
	if err != nil {
		t.Fatal(err)
	}
	for target, links := range result.Links {
		if len(links.Conflicts) > 0 {
			t.Fatalf("%s reported managed links as user-owned conflicts: %v", target, links.Conflicts)
		}
	}
	if len(result.Preserved) > 0 {
		t.Fatalf("sync preserved skills as locally modified: %v", result.Preserved)
	}
	return result
}

func readThroughAgent(t *testing.T, home, target, name string) string {
	t.Helper()
	dir, err := integrationTarget(target)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(dir, home) {
		t.Fatalf("integration target %s escaped the test home %s", dir, home)
	}
	data, err := os.ReadFile(filepath.Join(dir, name, "SKILL.md"))
	if err != nil {
		t.Fatalf("agent cannot read %s through %s: %v", name, target, err)
	}
	return string(data)
}

func TestManagedSkillsFollowVaultChangesThroughAgentLinks(t *testing.T) {
	modes := []string{"symlink"}
	if runtime.GOOS == "windows" {
		modes = append(modes, "junction")
	}
	for _, mode := range modes {
		t.Run(mode, func(t *testing.T) {
			if mode == "junction" {
				forceJunctions(t)
			}
			home, store := isolateHome(t)
			vault := &fakeVault{skills: map[string]Skill{}}
			wsURL := vault.serve(t)
			targets := []string{"agents", "claude"}

			vault.put(Skill{ID: "ws_cloud-deploy", Name: "deploy", Content: "deploy v1", UpdatedAt: "1"})
			vault.put(Skill{ID: "ws_cloud-review", Name: "review", Content: "review v1", UpdatedAt: "1"})
			first := syncOnce(t, wsURL, targets)
			if first.Installed != 2 {
				t.Fatalf("installed %d skills, want 2", first.Installed)
			}
			for _, target := range targets {
				if got := readThroughAgent(t, home, target, "deploy"); got != "deploy v1" {
					t.Fatalf("%s sees %q, want deploy v1", target, got)
				}
			}

			// An approved edit reaches every agent through the existing link.
			vault.put(Skill{ID: "ws_cloud-deploy", Name: "deploy", Content: "deploy v2", UpdatedAt: "2"})
			syncOnce(t, wsURL, targets)
			for _, target := range targets {
				if got := readThroughAgent(t, home, target, "deploy"); got != "deploy v2" {
					t.Fatalf("%s sees %q after update, want deploy v2", target, got)
				}
			}

			// A skill removed from the vault leaves no dangling agent link.
			vault.remove("ws_cloud-review")
			removed := syncOnce(t, wsURL, targets)
			if strings.Join(removed.Removed, ",") != "review" {
				t.Fatalf("removed = %v, want [review]", removed.Removed)
			}
			if _, err := os.Stat(filepath.Join(store, "review")); !os.IsNotExist(err) {
				t.Fatalf("store still holds removed skill: %v", err)
			}
			for _, target := range targets {
				dir, _ := integrationTarget(target)
				if links := removed.Links[target]; strings.Join(links.Removed, ",") != "review" {
					t.Fatalf("%s link removal = %v, want [review]", target, links.Removed)
				}
				if _, err := os.Lstat(filepath.Join(dir, "review")); !os.IsNotExist(err) {
					t.Fatalf("%s kept a link to the removed skill: %v", target, err)
				}
			}

			// A steady state stays quiet: no conflicts, nothing preserved.
			syncOnce(t, wsURL, targets)
		})
	}
}

func TestWriteManagedSkillFinishesInterruptedUpdate(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	dir := filepath.Join(t.TempDir(), "deploy")
	if err := writeManagedSkill(dir, Skill{ID: "deploy-id", Name: "deploy", Content: "v1"}, key); err != nil {
		t.Fatal(err)
	}
	// The process stopped after replacing SKILL.md but before the marker.
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeManagedSkill(dir, Skill{ID: "deploy-id", Name: "deploy", Content: "v2"}, key); err != nil {
		t.Fatalf("interrupted update was treated as a local edit: %v", err)
	}
	_, valid, err := readManagedMarker(dir, key)
	if err != nil || !valid {
		t.Fatalf("marker after recovery valid=%v err=%v", valid, err)
	}
	// Later vault updates keep flowing.
	if err := writeManagedSkill(dir, Skill{ID: "deploy-id", Name: "deploy", Content: "v3"}, key); err != nil {
		t.Fatal(err)
	}
}

func TestStaleWriteTempDoesNotFreezeManagedSkill(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	root := t.TempDir()
	dir := filepath.Join(root, "deploy")
	if err := writeManagedSkill(dir, Skill{ID: "deploy-id", Name: "deploy", Content: "v1"}, key); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, writeTempPrefix+"killed")
	if err := os.WriteFile(stale, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-10 * time.Minute)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	if err := writeManagedSkill(dir, Skill{ID: "deploy-id", Name: "deploy", Content: "v2"}, key); err != nil {
		t.Fatalf("stale temp file blocked the update: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale temp file was not removed: %v", err)
	}

	// A fresh temp file may belong to a concurrent writer and is left alone.
	fresh := filepath.Join(dir, writeTempPrefix+"inflight")
	if err := os.WriteFile(fresh, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	removeStaleWriteTemps(dir)
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("fresh temp file was removed: %v", err)
	}
}

func TestWriteRegularFileWaitsForOpenReader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "SKILL.md")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	// An agent holding SKILL.md open blocks replacement on Windows until it
	// closes the file; elsewhere the rename succeeds immediately.
	reader, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		time.Sleep(300 * time.Millisecond)
		reader.Close()
		close(released)
	}()
	defer func() { <-released }()
	if err := writeRegularFile(path, []byte("new"), 0o644); err != nil {
		t.Fatalf("replace failed while a reader held the file: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new" {
		t.Fatalf("content = %q, want new", data)
	}
}

func TestCreateDirectoryLinkResolvesRelativeStore(t *testing.T) {
	root := t.TempDir()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
	if err := os.MkdirAll(filepath.Join("store", "deploy"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join("store", "deploy", "SKILL.md"), []byte("deploy"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "agents")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	result, err := installIntegrationLinks("store", target, map[string]bool{"deploy": true})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Conflicts) > 0 {
		t.Fatalf("conflicts = %v", result.Conflicts)
	}
	data, err := os.ReadFile(filepath.Join(target, "deploy", "SKILL.md"))
	if err != nil || string(data) != "deploy" {
		t.Fatalf("link from a relative store does not resolve: %q, %v", data, err)
	}
}

func TestSamePathIgnoresCaseOnlyOnWindows(t *testing.T) {
	left := filepath.Join("C:", "Users", "Dev", "skills")
	right := filepath.Join("c:", "users", "dev", "Skills")
	if got, want := samePath(left, right), runtime.GOOS == "windows"; got != want {
		t.Fatalf("samePath(%q, %q) = %v, want %v", left, right, got, want)
	}
}

func TestIsDirectoryLinkTreatsJunctionsAsLinksOnWindows(t *testing.T) {
	if !isDirectoryLink(os.ModeSymlink) {
		t.Fatal("symlink not recognized")
	}
	if got, want := isDirectoryLink(os.ModeIrregular), runtime.GOOS == "windows"; got != want {
		t.Fatalf("irregular (junction) = %v, want %v", got, want)
	}
	if isDirectoryLink(os.ModeDir) {
		t.Fatal("plain directory treated as a link")
	}
}
