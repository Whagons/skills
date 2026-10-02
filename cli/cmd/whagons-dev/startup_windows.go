//go:build windows

package main

import (
	"context"
	"os/exec"
	"syscall"
)

// detachDaemon lets the daemon outlive the terminal that installed it.
func detachDaemon(cmd *exec.Cmd) {
	const detachedProcess = 0x00000008
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: detachedProcess | syscall.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
}

// shellCommand runs a user-supplied command line through cmd.exe. Go would
// escape embedded quotes as \" which cmd does not understand, so the raw
// line is passed; /S makes cmd strip only the outer quotes.
func shellCommand(ctx context.Context, command string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "cmd")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `cmd /S /C "` + command + `"`}
	return cmd
}
