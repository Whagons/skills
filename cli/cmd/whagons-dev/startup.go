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
		command := fmt.Sprintf("\"%s\" daemon", executable)
		output, err := exec.Command("schtasks", "/Create", "/TN", definition, "/TR", command, "/SC", "ONLOGON", "/F").CombinedOutput()
		if err != nil {
			return fmt.Errorf("create scheduled task: %w (%s)", err, strings.TrimSpace(string(output)))
		}
		_ = exec.Command("schtasks", "/Run", "/TN", definition).Run()
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
		if err := exec.Command("schtasks", "/Query", "/TN", definition).Run(); err != nil {
			return "not installed", nil
		}
		return "installed", nil
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
	}
	fmt.Println("✓ Background skill sync removed")
	return nil
}
