package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func runSetup(args []string) error {
	fs := flag.NewFlagSet("setup", flag.ContinueOnError)
	targetValue := fs.String("targets", "", "comma-separated targets (default: detected local agents)")
	noStartup := fs.Bool("no-startup", false, "do not register the background sync at login")
	interval := fs.Duration("interval", defaultSyncInterval, "background sync interval")
	noAutoUpdate := fs.Bool("no-auto-update", false, "disable daily CLI self-updates")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *interval < 15*time.Second {
		return fmt.Errorf("sync interval must be at least 15 seconds")
	}
	var targets []string
	var err error
	if strings.TrimSpace(*targetValue) == "" {
		targets = detectedTargets()
	} else {
		targets, err = normalizeTargets([]string{*targetValue})
		if err != nil {
			return err
		}
	}
	if len(targets) == 0 {
		targets = []string{"agents"}
	}

	fmt.Println("Whagons Dev setup")
	fmt.Printf("  Managed store  %s\n", managedSkillsDir())
	fmt.Println("  Agent integrations")
	printTargetChecklist(targets)
	fmt.Printf("  Background     every %s\n", *interval)
	fmt.Printf("  CLI updates    %t\n\n", !*noAutoUpdate)

	if err := withClient(func(client *Client, apiKey string, config Config) error {
		previousTargets := append([]string(nil), config.SkillTargets...)
		config.SkillTargets = targets
		config.SyncIntervalSeconds = int(interval.Seconds())
		config.AutoSelfUpdate = !*noAutoUpdate
		if config.AutoSelfUpdate && config.LastSelfUpdate == "" {
			// Setup itself was just installed deliberately; wait a day before the
			// first unattended refresh instead of rebuilding immediately.
			config.LastSelfUpdate = time.Now().UTC().Format(time.RFC3339)
		}
		if goBinary, lookupErr := exec.LookPath("go"); lookupErr == nil {
			config.GoBinary = goBinary
		}
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
	}); err != nil {
		return err
	}
	if !*noStartup {
		if err := installStartupService(); err != nil {
			return err
		}
	}
	fmt.Println("\n✓ Setup complete. Run 'whagons-dev skills status' at any time.")
	return nil
}

func printTargetChecklist(targets []string) {
	selected := map[string]bool{}
	for _, target := range targets {
		selected[target] = true
	}
	labels := map[string]string{
		"agents":   "Portable Agent Skills (Codex, T3, Cursor, OpenCode)",
		"claude":   "Claude native",
		"cursor":   "Cursor native (optional; portable path already covers it)",
		"opencode": "OpenCode native (optional; portable path already covers it)",
	}
	for _, target := range canonicalTargetOrder {
		mark := "○"
		if selected[target] {
			mark = "✓"
		}
		fmt.Printf("    %s %s\n", mark, labels[target])
	}
}

func detectedTargets() []string {
	selected := []string{"agents"}
	home, _ := os.UserHomeDir()
	checks := []struct {
		name   string
		binary string
		path   string
	}{
		{name: "claude", binary: "claude", path: filepath.Join(home, ".claude")},
	}
	for _, check := range checks {
		_, binaryErr := exec.LookPath(check.binary)
		_, pathErr := os.Stat(check.path)
		if binaryErr == nil || pathErr == nil {
			selected = append(selected, check.name)
		}
	}
	targets, _ := normalizeTargets(selected)
	return targets
}
