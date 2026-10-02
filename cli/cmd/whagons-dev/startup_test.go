package main

import (
	"strings"
	"testing"
)

func TestWindowsStartupQuotesExecutableWithSpaces(t *testing.T) {
	exe := `C:\Users\Jane Doe\go\bin\whagons-dev.exe`
	commands := windowsStartupCommands(exe)
	want := `"C:\Users\Jane Doe\go\bin\whagons-dev.exe" daemon`
	if got := commands.createTask[5]; got != want {
		t.Fatalf("scheduled task command = %q, want %q", got, want)
	}
	if got := commands.addRunKey[len(commands.addRunKey)-2]; got != want {
		t.Fatalf("Run entry command = %q, want %q", got, want)
	}
}

func TestWindowsStartupRunEntryIsPerUser(t *testing.T) {
	commands := windowsStartupCommands(`C:\whagons-dev.exe`)
	for _, command := range [][]string{commands.addRunKey, commands.queryRunKey, commands.deleteRunKey} {
		if command[0] != "reg" || !strings.HasPrefix(command[2], `HKCU\`) {
			t.Fatalf("Run entry must live under HKCU so no elevation is needed: %v", command)
		}
		if !strings.Contains(strings.Join(command, " "), "/v WhagonsDev") {
			t.Fatalf("Run entry command does not target the WhagonsDev value: %v", command)
		}
	}
}
