package main

import (
	"errors"
	"flag"
	"fmt"
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func runStartup(command string, args []string) error {
	fs := flag.NewFlagSet("startup "+command, flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}
	switch command {
	case "install", "enable":
		return installStartupService()
	case "status":
		status, err := startupStatus()
		if err != nil {
			return err
		}
		fmt.Println(status)
		return nil
	case "remove", "uninstall", "disable":
		return removeStartupService()
	default:
		return errors.New("usage: whagons-dev startup install|status|remove")
	}
}

func startupDefinitionPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "linux":
		return filepath.Join(home, ".config", "systemd", "user", "whagons-dev.service"), nil
	case "darwin":
		return filepath.Join(home, "Library", "LaunchAgents", "com.whagons.dev.plist"), nil
	case "windows":
		return "WhagonsDev", nil
	default:
		return "", fmt.Errorf("startup services are not supported on %s", runtime.GOOS)
	}
}

func installStartupService() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return err
	}
	definition, err := startupDefinitionPath()
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "linux":
		if _, err := exec.LookPath("systemctl"); err != nil {
			return errors.New("systemctl is required to install the Linux user startup service")
		}
		content := fmt.Sprintf(`[Unit]
Description=Whagons Dev skill synchronization
After=network-online.target

[Service]
Type=simple
ExecStart=%q daemon
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
`, executable)
		if err := ensureSafeDirectory(filepath.Dir(definition), 0o755); err != nil {
			return err
		}
		if err := writeRegularFile(definition, []byte(content), 0o644); err != nil {
			return err
		}
		if output, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
			return fmt.Errorf("reload systemd user services: %w (%s)", err, strings.TrimSpace(string(output)))
		}
		if output, err := exec.Command("systemctl", "--user", "enable", "--now", "whagons-dev.service").CombinedOutput(); err != nil {
			return fmt.Errorf("enable startup service: %w (%s)", err, strings.TrimSpace(string(output)))
		}
	case "darwin":
		logDir := filepath.Join(filepath.Dir(configPath()), "logs")
		if err := ensureSafeDirectory(logDir, 0o700); err != nil {
			return err
		}
		content := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.whagons.dev</string>
<key>ProgramArguments</key><array><string>%s</string><string>daemon</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>%s</string>
<key>StandardErrorPath</key><string>%s</string>
</dict></plist>
`, html.EscapeString(executable), html.EscapeString(filepath.Join(logDir, "daemon.log")), html.EscapeString(filepath.Join(logDir, "daemon-error.log")))
		if err := ensureSafeDirectory(filepath.Dir(definition), 0o755); err != nil {
			return err
		}
		if err := writeRegularFile(definition, []byte(content), 0o644); err != nil {
			return err
		}
		_ = exec.Command("launchctl", "unload", definition).Run()
		if output, err := exec.Command("launchctl", "load", "-w", definition).CombinedOutput(); err != nil {
			return fmt.Errorf("load LaunchAgent: %w (%s)", err, strings.TrimSpace(string(output)))
		}
	case "windows":
		commands := windowsStartupCommands(executable)
		taskOutput, taskErr := exec.Command(commands.createTask[0], commands.createTask[1:]...).CombinedOutput()
		if taskErr == nil {
			_ = exec.Command(commands.runTask[0], commands.runTask[1:]...).Run()
			break
		}
		// Logon-triggered tasks can require elevation. The per-user Run key
		// never does, so a standard account still gets background sync.
		runOutput, runErr := exec.Command(commands.addRunKey[0], commands.addRunKey[1:]...).CombinedOutput()
		if runErr != nil {
			return fmt.Errorf("create scheduled task: %w (%s); add logon Run entry: %v (%s)", taskErr, strings.TrimSpace(string(taskOutput)), runErr, strings.TrimSpace(string(runOutput)))
		}
		daemon := exec.Command(executable, "daemon")
		detachDaemon(daemon)
		if err := daemon.Start(); err != nil {
			return fmt.Errorf("start background sync: %w", err)
		}
		_ = daemon.Process.Release()
	}
	fmt.Println("✓ Background skill sync installed and started")
	return nil
}

func startupStatus() (string, error) {
	definition, err := startupDefinitionPath()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		commands := windowsStartupCommands("")
		if exec.Command("schtasks", "/Query", "/TN", definition).Run() == nil {
			return "installed (scheduled task)", nil
		}
		if exec.Command(commands.queryRunKey[0], commands.queryRunKey[1:]...).Run() == nil {
			return "installed (logon Run entry)", nil
		}
		return "not installed", nil
	}
	if _, err := os.Stat(definition); os.IsNotExist(err) {
		return "not installed", nil
	} else if err != nil {
		return "", err
	}
	return "installed", nil
}

func removeStartupService() error {
	definition, err := startupDefinitionPath()
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "linux":
		_ = exec.Command("systemctl", "--user", "disable", "--now", "whagons-dev.service").Run()
		if err := os.Remove(definition); err != nil && !os.IsNotExist(err) {
			return err
		}
		_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	case "darwin":
		_ = exec.Command("launchctl", "unload", "-w", definition).Run()
		if err := os.Remove(definition); err != nil && !os.IsNotExist(err) {
			return err
		}
	case "windows":
		output, err := exec.Command("schtasks", "/Delete", "/TN", definition, "/F").CombinedOutput()
		if err != nil && !strings.Contains(strings.ToLower(string(output)), "cannot find") {
			return fmt.Errorf("delete scheduled task: %w (%s)", err, strings.TrimSpace(string(output)))
		}
		commands := windowsStartupCommands("")
		_ = exec.Command(commands.deleteRunKey[0], commands.deleteRunKey[1:]...).Run()
	}
	fmt.Println("✓ Background skill sync removed")
	return nil
}

const windowsRunKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

type windowsStartup struct {
	createTask, runTask, addRunKey, queryRunKey, deleteRunKey []string
}

// windowsStartupCommands builds the schtasks and reg invocations. The daemon
// command line quotes the executable because user profiles often contain
// spaces (C:\Users\Jane Doe\go\bin\whagons-dev.exe).
func windowsStartupCommands(executable string) windowsStartup {
	daemon := fmt.Sprintf("\"%s\" daemon", executable)
	return windowsStartup{
		createTask:   []string{"schtasks", "/Create", "/TN", "WhagonsDev", "/TR", daemon, "/SC", "ONLOGON", "/F"},
		runTask:      []string{"schtasks", "/Run", "/TN", "WhagonsDev"},
		addRunKey:    []string{"reg", "add", windowsRunKey, "/v", "WhagonsDev", "/t", "REG_SZ", "/d", daemon, "/f"},
		queryRunKey:  []string{"reg", "query", windowsRunKey, "/v", "WhagonsDev"},
		deleteRunKey: []string{"reg", "delete", windowsRunKey, "/v", "WhagonsDev", "/f"},
	}
}
