package main

import (
	"errors"
	"flag"
	"fmt"
	"time"
)

const defaultSyncInterval = time.Minute

// minFullResync bounds how often the daemon re-downloads every skill when
// nothing changed. Changes themselves are picked up by the 20-second metadata
// check, so the full resync is only a safety net (for example, to repair a
// locally edited managed skill).
const minFullResync = 30 * time.Minute

func fullResyncEvery(interval time.Duration) time.Duration {
	if interval > minFullResync {
		return interval
	}
	return minFullResync
}

func runDaemon(args []string) error {
	fs := flag.NewFlagSet("daemon", flag.ContinueOnError)
	intervalFlag := fs.Duration("interval", 0, "vault sync interval")
	once := fs.Bool("once", false, "sync once and exit")
	noSelfUpdate := fs.Bool("no-self-update", false, "skip the daily CLI update check")
	if err := fs.Parse(args); err != nil {
		return err
	}
	config, _ := readConfig()
	interval := *intervalFlag
	if interval == 0 && config.SyncIntervalSeconds > 0 {
		interval = time.Duration(config.SyncIntervalSeconds) * time.Second
	}
	if interval == 0 {
		interval = defaultSyncInterval
	}
	if interval < 15*time.Second {
		return errors.New("daemon interval must be at least 15 seconds")
	}

	for {
		revision, err := syncConfiguredOnce()
		if err != nil {
			fmt.Printf("%s sync failed: %v\n", time.Now().Format(time.RFC3339), err)
		} else {
			fmt.Printf("%s skills are current\n", time.Now().Format(time.RFC3339))
		}
		config, _ = readConfig()
		if !*noSelfUpdate && selfUpdateDue(config, time.Now()) {
			handoff, updateErr := selfUpdate(true)
			if updateErr != nil {
				fmt.Printf("%s self-update failed: %v\n", time.Now().Format(time.RFC3339), updateErr)
			}
			config.LastSelfUpdate = time.Now().UTC().Format(time.RFC3339)
			if err := writeConfig(config); err != nil {
				fmt.Printf("%s could not save update time: %v\n", time.Now().Format(time.RFC3339), err)
			}
			if handoff {
				return nil
			}
		}
		if *once {
			return nil
		}
		if err == nil {
			changed, watchErr := waitForSkillChange(revision, fullResyncEvery(interval))
			if watchErr != nil {
				fmt.Printf("%s change check failed, retrying: %v\n", time.Now().Format(time.RFC3339), watchErr)
				time.Sleep(15 * time.Second)
			} else if changed {
				fmt.Printf("%s vault edit detected\n", time.Now().Format(time.RFC3339))
			}
		} else {
			time.Sleep(interval)
		}
	}
}

func syncConfiguredOnce() (string, error) {
	config, err := readConfig()
	if err != nil {
		return "", errors.New("CLI is not configured; run whagons-dev setup")
	}
	apiKey := firstNonEmpty(envValue("API_KEY"), config.APIKey)
	if apiKey == "" {
		return "", errors.New("CLI is logged out; run whagons-dev auth login")
	}
	targets := config.SkillTargets
	if len(targets) == 0 {
		targets = []string{"agents"}
	}
	client, err := clientForConfig(config)
	if err != nil {
		return "", err
	}
	defer client.Close()
	result, err := syncManagedSkills(client, apiKey, &config, targets)
	if err != nil {
		return "", err
	}
	if len(result.Removed) > 0 || len(result.Preserved) > 0 || len(result.Skipped) > 0 {
		reportSkillSync(result, targets)
	}
	return result.Revision, nil
}

// changePollInterval is how often the daemon checks skill metadata between
// full syncs. A metadata list is one small HTTP request, so edits arrive
// within ~20 seconds without holding a connection open.
var changePollInterval = 20 * time.Second

// waitForSkillChange polls the published skill list until its revision differs
// from currentRevision or timeout passes.
func waitForSkillChange(currentRevision string, timeout time.Duration) (bool, error) {
	config, err := readConfig()
	if err != nil {
		return false, err
	}
	apiKey := firstNonEmpty(envValue("API_KEY"), config.APIKey)
	client, err := clientForConfig(config)
	if err != nil {
		return false, err
	}
	defer client.Close()
	deadline := time.Now().Add(timeout)
	for {
		wait := changePollInterval
		if remaining := time.Until(deadline); remaining < wait {
			wait = remaining
		}
		if wait <= 0 {
			return false, nil
		}
		time.Sleep(wait)
		var skills []Skill
		if err := client.Query("agent.skills.list", map[string]any{"apiKey": apiKey}, &skills); err != nil {
			return false, err
		}
		if skillMetadataRevision(skills) != currentRevision {
			return true, nil
		}
	}
}
