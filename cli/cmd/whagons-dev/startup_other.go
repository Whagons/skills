//go:build !windows

package main

import "os/exec"

func detachDaemon(*exec.Cmd) {}
