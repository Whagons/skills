package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestHelperReviewer stands in for Claude Code or Codex when tests point
// WHAGONS_DEV_REVIEW_COMMAND at the test binary.
func TestHelperReviewer(t *testing.T) {
	verdict := os.Getenv("WHAGONS_TEST_REVIEWER_VERDICT")
	if verdict == "" {
		t.Skip("reviewer helper process only")
	}
	prompt, _ := io.ReadAll(os.Stdin)
	_ = os.WriteFile(os.Getenv("WHAGONS_TEST_REVIEWER_PROMPT"), prompt, 0o600)
	os.Stdout.WriteString("Reviewed.\n" + verdict + "\n")
	os.Exit(0)
}

func useHelperReviewer(t *testing.T, verdict string) string {
	t.Helper()
	promptFile := filepath.Join(t.TempDir(), "prompt.txt")
	t.Setenv("WHAGONS_TEST_REVIEWER_VERDICT", verdict)
	t.Setenv("WHAGONS_TEST_REVIEWER_PROMPT", promptFile)
	t.Setenv("WHAGONS_DEV_REVIEW_COMMAND", `"`+os.Args[0]+`" -test.run=TestHelperReviewer$`)
	return promptFile
}

func writeSkillFile(t *testing.T, name, body string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "SKILL.md")
	content := "---\nname: " + name + "\ndescription: Deploy the app safely.\n---\n" + body
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func inDirWithAgentsFile(t *testing.T, instructions string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(instructions), 0o644); err != nil {
		t.Fatal(err)
	}
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
}

func TestOwnerPublishGoesLiveThroughAgentLinks(t *testing.T) {
	home, _ := isolateHome(t)
	inDirWithAgentsFile(t, "Never merge into staging with --admin.")
	promptFile := useHelperReviewer(t, `{"verdict":"publish","problems":[]}`)
	vault := &fakeVault{skills: map[string]Skill{}}
	vault.put(Skill{ID: "ws_cloud-deploy", Name: "deploy", Content: "---\nname: deploy\ndescription: Deploy the app safely.\n---\nRun the release script.\n", UpdatedAt: "1"})
	vault.put(Skill{ID: "ws_cloud-review", Name: "review", Content: "review rules", UpdatedAt: "1"})
	wsURL := vault.serve(t)
	syncOnce(t, wsURL, []string{"claude"})

	client, err := NewClient(wsURL, "test-project")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	path := writeSkillFile(t, "deploy", "Run the release script.\nCheck /healthz afterwards.\n")
	skill, err := publishSkill(client, "owner-key", path, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !skill.Approved || skill.ID != "ws_cloud-deploy" {
		t.Fatalf("published = %+v; want the existing row, live", skill)
	}
	prompt, err := os.ReadFile(promptFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"+Check /healthz afterwards.", "### review", "review rules", "Never merge into staging with --admin."} {
		if !strings.Contains(string(prompt), want) {
			t.Fatalf("reviewer prompt lacks %q", want)
		}
	}
	syncOnce(t, wsURL, []string{"claude"})
	if got := readThroughAgent(t, home, "claude", "deploy"); !strings.Contains(got, "Check /healthz afterwards.") {
		t.Fatalf("agents still see the old skill: %q", got)
	}
}

func TestPublishGateBlocksBeforeUploading(t *testing.T) {
	isolateHome(t)
	inDirWithAgentsFile(t, "")
	useHelperReviewer(t, `{"verdict":"block","problems":["contradicts AGENTS.md: allows --admin"]}`)
	vault := &fakeVault{skills: map[string]Skill{}}
	wsURL := vault.serve(t)
	client, err := NewClient(wsURL, "test-project")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_, err = publishSkill(client, "owner-key", writeSkillFile(t, "deploy", "Merge with --admin when stuck.\n"), "", "", "")
	if err == nil || !strings.Contains(err.Error(), "contradicts AGENTS.md") {
		t.Fatalf("error = %v; want the reviewer's block reason", err)
	}
	_, err = publishSkill(client, "owner-key", writeSkillFile(t, "deploy", "It's important to note that deploys matter.\n"), "", "", "")
	if err == nil || !strings.Contains(err.Error(), "filler phrase") {
		t.Fatalf("error = %v; want the filler check", err)
	}
	if vault.uploads != 0 {
		t.Fatalf("blocked publishes reached the vault %d times", vault.uploads)
	}
}

func TestNonOwnerCannotChangePublishedSkill(t *testing.T) {
	isolateHome(t)
	inDirWithAgentsFile(t, "")
	useHelperReviewer(t, `{"verdict":"publish","problems":[]}`)
	vault := &fakeVault{skills: map[string]Skill{}}
	vault.put(Skill{ID: "ws_cloud-deploy", Name: "deploy", Content: "original", UpdatedAt: "1"})
	wsURL := vault.serve(t)
	client, err := NewClient(wsURL, "test-project")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := publishSkill(client, "member-key", writeSkillFile(t, "deploy", "Member edit.\n"), "", "", ""); err == nil || !strings.Contains(err.Error(), "only the workspace owner") {
		t.Fatalf("error = %v; want owner-only refusal", err)
	}
	proposal, err := publishSkill(client, "member-key", writeSkillFile(t, "rollback", "Roll back with the previous tag.\n"), "", "", "")
	if err != nil || proposal.Approved {
		t.Fatalf("member proposal = %+v, %v; want pending", proposal, err)
	}
	if vault.skills["ws_cloud-deploy"].Content != "original" {
		t.Fatal("published skill changed")
	}
}

func TestLintSkillUpdateOnlyJudgesAddedLines(t *testing.T) {
	current := "---\nname: deploy\ndescription: d\n---\nIt's important to note the old line.\n"
	if problems := lintSkillUpdate(current, current+"Run the script.\n"); len(problems) != 0 {
		t.Fatalf("unchanged filler blocked an unrelated edit: %v", problems)
	}
	repeated := "Always run the release gates before promoting production."
	problems := lintSkillUpdate(current, current+repeated+"\n"+repeated+"\n")
	if len(problems) != 1 || !strings.Contains(problems[0], "repeated line") {
		t.Fatalf("problems = %v; want one repeated line", problems)
	}
	if problems := lintSkillUpdate("", "no frontmatter\n"); len(problems) == 0 || !strings.Contains(problems[0], "frontmatter") {
		t.Fatalf("problems = %v; want frontmatter", problems)
	}
}

func TestLineDiffMarksChanges(t *testing.T) {
	got := strings.Join(lineDiff("a\nb\nc\n", "a\nc\nd\n"), "|")
	if got != " a|-b| c|+d" {
		t.Fatalf("diff = %q", got)
	}
}

func TestParseReviewVerdict(t *testing.T) {
	verdict, err := parseReviewVerdict("Looks fine.\n```json\n{\"verdict\":\"Block\",\"problems\":[\"x {y}\"]}\n```\n")
	if err != nil || verdict.Verdict != "block" || len(verdict.Problems) != 1 {
		t.Fatalf("verdict = %+v, %v", verdict, err)
	}
	if _, err := parseReviewVerdict("no json here"); err == nil {
		t.Fatal("missing verdict accepted")
	}
	if _, err := parseReviewVerdict(`{"verdict":"maybe"}`); err == nil {
		t.Fatal("unknown verdict accepted")
	}
}
