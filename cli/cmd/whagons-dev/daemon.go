package main

import (
	"errors"
	"flag"
	"fmt"
	"time"
)

const defaultSyncInterval = time.Minute

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
			changed, watchErr := waitForSkillChange(revision, interval)
			if watchErr != nil {
				fmt.Printf("%s live watch reconnecting: %v\n", time.Now().Format(time.RFC3339), watchErr)
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
	wsURL := firstNonEmpty(envValue("WS_URL"), config.WSURL, defaultWSURL)
	project := firstNonEmpty(envValue("PROJECT"), config.Project, defaultProject)
	client, err := NewClient(wsURLWithProject(wsURL, project), project)
	if err != nil {
		return "", err
	}
	defer client.Close()
	result, err := syncManagedSkills(client, apiKey, &config, targets)
	if err != nil {
		return "", err
	}
	if len(result.Removed) > 0 || len(result.Preserved) > 0 {
		reportSkillSync(result, targets)
	}
	return result.Revision, nil
}

func waitForSkillChange(currentRevision string, timeout time.Duration) (bool, error) {
	config, err := readConfig()
	if err != nil {
		return false, err
	}
	apiKey := firstNonEmpty(envValue("API_KEY"), config.APIKey)
	wsURL := firstNonEmpty(envValue("WS_URL"), config.WSURL, defaultWSURL)
	project := firstNonEmpty(envValue("PROJECT"), config.Project, defaultProject)
	client, err := NewClient(wsURLWithProject(wsURL, project), project)
	if err != nil {
		return false, err
	}
	defer client.Close()
	id := randomID()
	if err := client.write(message{"type": "query.subscribe", "id": id, "path": "agent.skills.list", "args": map[string]any{"apiKey": apiKey}}); err != nil {
		return false, err
	}
	defer client.write(message{"type": "query.unsubscribe", "id": id})
	deadline := time.Now().Add(timeout)
	for {
		if err := client.conn.SetReadDeadline(deadline); err != nil {
			return false, err
		}
		var msg message
		if err := client.conn.ReadJSON(&msg); err != nil {
			if time.Now().After(deadline) {
				return false, nil
			}
			return false, err
		}
		if msg["id"] != id {
			continue
		}
		switch msg["type"] {
		case "query.error":
			return false, fmt.Errorf("%v", msg["error"])
		case "query.result":
			var skills []Skill
			if err := decodeResult(msg["result"], &skills); err != nil {
				return false, err
			}
			if skillMetadataRevision(skills) != currentRevision {
				return true, nil
			}
		}
	}
}
