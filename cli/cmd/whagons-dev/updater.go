package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const cliInstallPackage = "github.com/whagons/skills/cli/cmd/whagons-dev@latest"

// Release builds may replace this with -ldflags "-X main.cliVersion=vX.Y.Z".
var cliVersion = "dev"

func runSelfUpdate(args []string) error {
	fs := flag.NewFlagSet("self-update", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}
	_, err := selfUpdate(false)
	return err
}

// selfUpdate returns handoff=true on Windows when a helper must finish the
// replacement after this process exits.
func selfUpdate(restartDaemon bool) (handoff bool, err error) {
	config, _ := readConfig()
	goBinary := config.GoBinary
	if goBinary == "" {
		goBinary, _ = exec.LookPath("go")
	}
	if goBinary == "" {
		return false, errors.New("automatic CLI update currently requires Go; install Go or reinstall a newer whagons-dev binary")
	}
	fmt.Printf("Updating whagons-dev %s from the official module…\n", cliVersion)
	updateDir := filepath.Join(filepath.Dir(configPath()), "updates")
	if err := ensureSafeDirectory(updateDir, 0o700); err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, goBinary, "install", cliInstallPackage)
	cmd.Stdin = os.Stdin
	cmd.Env = environmentOverride("GOBIN", updateDir)
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return false, errors.New("CLI update timed out")
	}
	if err != nil {
		return false, fmt.Errorf("CLI update failed: %w (%s)", err, strings.TrimSpace(string(output)))
	}
	name := "whagons-dev"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	source := filepath.Join(updateDir, name)
	destination, err := os.Executable()
	if err != nil {
		return false, err
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return false, err
	}
	if runtime.GOOS == "windows" {
		restart := "false"
		if restartDaemon {
			restart = "true"
		}
		helper := exec.Command(source, "apply-update", source, destination, restart)
		if err := helper.Start(); err != nil {
			return false, fmt.Errorf("start Windows update handoff: %w", err)
		}
		fmt.Println("✓ Update downloaded; finishing replacement after this process exits")
		return true, nil
	}
	if err := replaceExecutable(source, destination); err != nil {
		return false, err
	}
	fmt.Println("✓ whagons-dev updated; the new binary will be used on the next invocation")
	return false, nil
}

func environmentOverride(name, value string) []string {
	prefix := strings.ToUpper(name) + "="
	environment := make([]string, 0, len(os.Environ())+1)
	for _, item := range os.Environ() {
		if strings.HasPrefix(strings.ToUpper(item), prefix) {
			continue
		}
		environment = append(environment, item)
	}
	return append(environment, name+"="+value)
}

func replaceExecutable(source, destination string) error {
	sourceFile, err := os.Open(source)
	if err != nil {
		return err
	}
	defer sourceFile.Close()
	temp, err := os.CreateTemp(filepath.Dir(destination), ".whagons-dev-update-*")
	if err != nil {
		return fmt.Errorf("prepare executable update: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o755); err != nil {
		temp.Close()
		return err
	}
	if _, err := io.Copy(temp, sourceFile); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, destination); err != nil {
		return fmt.Errorf("replace CLI executable: %w", err)
	}
	return nil
}

func runApplyUpdate(args []string) error {
	if len(args) != 3 {
		return errors.New("invalid update handoff")
	}
	source, destination := args[0], args[1]
	restartDaemon := args[2] == "true"
	deadline := time.Now().Add(30 * time.Second)
	for {
		err := replaceExecutable(source, destination)
		if err == nil {
			if restartDaemon {
				cmd := exec.Command(destination, "daemon")
				if startErr := cmd.Start(); startErr != nil {
					return startErr
				}
			}
			return nil
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func selfUpdateDue(config Config, now time.Time) bool {
	if !config.AutoSelfUpdate {
		return false
	}
	last, err := time.Parse(time.RFC3339, config.LastSelfUpdate)
	return err != nil || now.Sub(last) >= 24*time.Hour
}
