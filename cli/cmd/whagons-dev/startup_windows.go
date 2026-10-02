//go:build windows

package main

import (
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
