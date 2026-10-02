package main

import (
	"bytes"
	"context"
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

// A published workspace skill goes live for every developer's agents within
// seconds, so publishing runs a gate first: deterministic checks on the
// added lines, then a model review for slop and contradictions.

const publishReviewTimeout = 6 * time.Minute

// reviewContextBudget caps the other skills and repo instructions sent to the
// reviewer so the prompt stays within one model context.
const reviewContextBudget = 300 << 10

var fillerPhrases = []string{
	"it's important to note", "it is important to note", "it's worth noting", "it is worth noting",
	"in conclusion", "in summary,", "delve", "seamless", "game-changer", "cutting-edge",
	"in today's", "feel free to", "i hope this helps", "let's dive", "as an ai",
	"comprehensive guide", "plays a crucial role", "navigate the complexities",
}

type publishGate struct {
	Problems []string
}

func (g publishGate) blocked() bool { return len(g.Problems) > 0 }

// lintSkillUpdate checks only lines the update adds, so existing content
// never blocks an unrelated fix.
func lintSkillUpdate(current, proposed string) []string {
	var problems []string
	name, description := parseFrontmatter(proposed, "")
	if name == "" || description == "" {
		problems = append(problems, "frontmatter needs both name and description")
	}
	if len(proposed) > maxSkillBytes {
		problems = append(problems, fmt.Sprintf("skill is larger than %d bytes", maxSkillBytes))
	}
	added := addedLines(current, proposed)
	for _, line := range added {
		lower := strings.ToLower(line)
		for _, phrase := range fillerPhrases {
			if strings.Contains(lower, phrase) {
				problems = append(problems, fmt.Sprintf("filler phrase %q in: %s", phrase, strings.TrimSpace(line)))
			}
		}
	}
	seen := map[string]int{}
	for _, line := range strings.Split(proposed, "\n") {
		if trimmed := strings.TrimSpace(line); len(trimmed) >= 40 {
			seen[trimmed]++
		}
	}
	for _, line := range added {
		if trimmed := strings.TrimSpace(line); seen[trimmed] > 1 {
			problems = append(problems, "repeated line: "+trimmed)
			seen[trimmed] = 0
		}
	}
	return problems
}

func addedLines(current, proposed string) []string {
	var added []string
	for _, line := range lineDiff(current, proposed) {
		if strings.HasPrefix(line, "+") {
			added = append(added, line[1:])
		}
	}
	return added
}

// lineDiff returns the proposed file as "+", "-" and " " prefixed lines.
func lineDiff(current, proposed string) []string {
	a, b := splitLines(current), splitLines(proposed)
	if len(a)*len(b) > 4_000_000 {
		var out []string
		for _, line := range a {
			out = append(out, "-"+line)
		}
		for _, line := range b {
			out = append(out, "+"+line)
		}
		return out
	}
	lcs := make([][]int, len(a)+1)
	for i := range lcs {
		lcs[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}
	var out []string
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] == b[j]:
			out = append(out, " "+a[i])
			i, j = i+1, j+1
		case lcs[i+1][j] >= lcs[i][j+1]:
			out = append(out, "-"+a[i])
			i++
		default:
			out = append(out, "+"+b[j])
			j++
		}
	}
	for ; i < len(a); i++ {
		out = append(out, "-"+a[i])
	}
	for ; j < len(b); j++ {
		out = append(out, "+"+b[j])
	}
	return out
}

func splitLines(value string) []string {
	if value == "" {
		return nil
	}
	return strings.Split(strings.TrimRight(value, "\n"), "\n")
}

// compactDiff keeps changed lines with two lines of context.
func compactDiff(lines []string) string {
	keep := make([]bool, len(lines))
	for index, line := range lines {
		if strings.HasPrefix(line, " ") {
			continue
		}
		for k := max(0, index-2); k <= min(len(lines)-1, index+2); k++ {
			keep[k] = true
		}
	}
	var out strings.Builder
	skipped := false
	for index, line := range lines {
		if !keep[index] {
			skipped = true
			continue
		}
		if skipped {
			out.WriteString("…\n")
			skipped = false
		}
		out.WriteString(line + "\n")
	}
	return out.String()
}

type reviewVerdict struct {
	Verdict  string   `json:"verdict"`
	Problems []string `json:"problems"`
}

// parseReviewVerdict takes the last JSON object with a verdict from the
// reviewer's output; models sometimes add prose around it.
func parseReviewVerdict(output string) (reviewVerdict, error) {
	for end := strings.LastIndex(output, "}"); end >= 0; end = strings.LastIndex(output[:end], "}") {
		for start := strings.LastIndex(output[:end], "{"); start >= 0; start = strings.LastIndex(output[:start], "{") {
			var verdict reviewVerdict
			if json.Unmarshal([]byte(output[start:end+1]), &verdict) == nil && verdict.Verdict != "" {
				verdict.Verdict = strings.ToLower(strings.TrimSpace(verdict.Verdict))
				if verdict.Verdict != "publish" && verdict.Verdict != "block" {
					return verdict, fmt.Errorf("reviewer returned unknown verdict %q", verdict.Verdict)
				}
				return verdict, nil
			}
			if start == 0 {
				break
			}
		}
		if end == 0 {
			break
		}
	}
	return reviewVerdict{}, errors.New("reviewer did not return a JSON verdict")
}

func buildReviewPrompt(name, current, proposed string, others map[string]string, instructions map[string]string) string {
	var b strings.Builder
	b.WriteString(`You are the publish gate for the Whagons Skills Vault. Publishing replaces this skill for every developer's coding agents immediately.

Block the update if any of these hold:
- Added text is filler, hedging, repetition, or generic advice an agent follows anyway; it is longer than the instructions need.
- An instruction contradicts itself, another published skill below, or the repository instructions below.
- The change rewrites parts unrelated to its purpose.
- The description no longer matches what the skill does.
Do not block for style preferences, or for unchanged text unless the change creates a contradiction with it.

Reply with only one JSON object: {"verdict":"publish"|"block","problems":["specific problem, quoting the text"]}

`)
	fmt.Fprintf(&b, "## Diff of %s (current published version -> proposed)\n", name)
	if current == "" {
		b.WriteString("(new skill)\n")
	} else {
		b.WriteString(compactDiff(lineDiff(current, proposed)))
	}
	b.WriteString("\n## Proposed SKILL.md\n" + proposed + "\n")
	budget := reviewContextBudget
	writeSection := func(title string, docs map[string]string) {
		if len(docs) == 0 {
			return
		}
		b.WriteString("\n## " + title + "\n")
		keys := make([]string, 0, len(docs))
		for key := range docs {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			content := docs[key]
			if len(content) > budget {
				content = content[:max(0, budget)] + "\n…(truncated)"
			}
			budget -= len(content)
			fmt.Fprintf(&b, "\n### %s\n%s\n", key, content)
		}
	}
	writeSection("Repository instructions", instructions)
	writeSection("Other published skills", others)
	return b.String()
}

// repoInstructions collects AGENTS.md and CLAUDE.md from the working
// directory up to the filesystem root, the files agents already obey there.
func repoInstructions(start string) map[string]string {
	found := map[string]string{}
	dir, err := filepath.Abs(start)
	if err != nil {
		return found
	}
	for {
		for _, name := range []string{"AGENTS.md", "CLAUDE.md"} {
			path := filepath.Join(dir, name)
			if data, err := readRegularFile(path, 512<<10); err == nil {
				found[path] = string(data)
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return found
		}
		dir = parent
	}
}

// reviewerCommand picks the model CLI that reviews a publish. An explicit
// WHAGONS_DEV_REVIEW_COMMAND runs through the shell with the prompt on stdin.
func reviewerCommand(ctx context.Context) (*exec.Cmd, error) {
	if command := envValue("REVIEW_COMMAND"); command != "" {
		if runtime.GOOS == "windows" {
			return exec.CommandContext(ctx, "cmd", "/C", command), nil
		}
		return exec.CommandContext(ctx, "sh", "-c", command), nil
	}
	if path, err := exec.LookPath("claude"); err == nil {
		return exec.CommandContext(ctx, path, "-p", "--output-format", "text"), nil
	}
	if path, err := exec.LookPath("codex"); err == nil {
		return exec.CommandContext(ctx, path, "exec", "--skip-git-repo-check", "-"), nil
	}
	return nil, errors.New("publishing needs a reviewer: install Claude Code or Codex, or set WHAGONS_DEV_REVIEW_COMMAND")
}

func runReviewer(prompt string) (reviewVerdict, error) {
	ctx, cancel := context.WithTimeout(context.Background(), publishReviewTimeout)
	defer cancel()
	cmd, err := reviewerCommand(ctx)
	if err != nil {
		return reviewVerdict{}, err
	}
	cmd.Stdin = strings.NewReader(prompt)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return reviewVerdict{}, errors.New("publish review timed out")
		}
		return reviewVerdict{}, fmt.Errorf("publish review failed: %w (%s)", err, strings.TrimSpace(stderr.String()))
	}
	return parseReviewVerdict(stdout.String())
}

// checkPublish runs the gate. current is the published content ("" for a
// new skill); others are the other published skills by name.
func checkPublish(name, current, proposed string, others map[string]string) (publishGate, error) {
	if strings.TrimSpace(current) == strings.TrimSpace(proposed) {
		return publishGate{}, errors.New("nothing to publish: the content matches the published version")
	}
	if problems := lintSkillUpdate(current, proposed); len(problems) > 0 {
		return publishGate{Problems: problems}, nil
	}
	cwd, _ := os.Getwd()
	verdict, err := runReviewer(buildReviewPrompt(name, current, proposed, others, repoInstructions(cwd)))
	if err != nil {
		return publishGate{}, err
	}
	if verdict.Verdict == "block" {
		problems := verdict.Problems
		if len(problems) == 0 {
			problems = []string{"reviewer blocked the update without details"}
		}
		return publishGate{Problems: problems}, nil
	}
	return publishGate{}, nil
}

// publishSkill gates and uploads a SKILL.md. The vault publishes it live when
// the API key belongs to the workspace owner; anyone else gets a pending
// proposal, and changes to a published skill are refused.
func publishSkill(client *Client, apiKey, path, id, name, summary string) (Skill, error) {
	contentBytes, err := readRegularFile(path, maxSkillBytes)
	if err != nil {
		return Skill{}, err
	}
	content := string(contentBytes)
	metadataName, metadataSummary := parseFrontmatter(content, filepath.Base(filepath.Dir(path)))
	name = firstNonEmpty(name, metadataName)
	summary = firstNonEmpty(summary, metadataSummary)

	var listed []Skill
	if err := client.Query("agent.skills.list", map[string]any{"apiKey": apiKey}, &listed); err != nil {
		return Skill{}, err
	}
	current := ""
	others := map[string]string{}
	for _, meta := range listed {
		var skill Skill
		if err := client.Query("agent.skills.get", map[string]any{"apiKey": apiKey, "id": meta.ID}, &skill); err != nil {
			continue
		}
		if strings.EqualFold(skill.Name, name) || (id != "" && skill.ID == id) {
			current = skill.Content
			id = firstNonEmpty(id, skill.ID)
			continue
		}
		others[skill.Name] = skill.Content
	}
	gate, err := checkPublish(name, current, content, others)
	if err != nil {
		return Skill{}, err
	}
	if gate.blocked() {
		return Skill{}, fmt.Errorf("publish blocked by the skill gate:\n  - %s\nFix the skill and publish again", strings.Join(gate.Problems, "\n  - "))
	}
	if id == "" {
		id = "cloud-" + name
	}
	var skill Skill
	err = client.Mutation("agent.skills.upload", map[string]any{"apiKey": apiKey, "id": id, "name": name, "summary": summary, "content": content, "publish": true}, &skill)
	return skill, err
}

func reportPublish(skill Skill) {
	if skill.Approved {
		fmt.Printf("✓ Published %s. It is live for every developer now; running whagons-dev daemons install it within seconds.\n", skill.Name)
		return
	}
	fmt.Printf("Submitted %s as a proposal. Only the workspace owner publishes skills; it stays pending until they do.\n", skill.Name)
}
