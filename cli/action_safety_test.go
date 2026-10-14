package main

import (
	"encoding/json"
	"testing"
)

func TestActionSafetyCompatibility(t *testing.T) {
	for _, command := range []string{"rm -r /work", "sudo rm -rf /home", "mkfs.ext4 /dev/fake", "pkill sshd", "apt install example"} {
		args, _ := json.Marshal(map[string]string{"command": command})
		r := Request{Action: "shell", Args: args}
		if checkActionSafety(r) == nil {
			t.Fatal("old unconfirmed core permitted danger", command)
		}
		r.verifiedHuman = true
		if checkActionSafety(r) != nil {
			t.Fatal("confirmed rejected")
		}
	}
	args, _ := json.Marshal(map[string]string{"command": "pwd"})
	if checkActionSafety(Request{Action: "shell", Args: args}) != nil {
		t.Fatal("old benign request rejected")
	}
}

func TestLatestKillMockExecutionCounts(t *testing.T) {
	for _, command := range []string{"kill 12345", "kill -TERM 12345", "kill -9 12345", "pkill firefox", "pkill initialization-worker", "kill 1", "kill -s HUP 1", "pkill sshd", "pkill dockerd", "pkill systemd", "pkill init", "pkill kamakura-core", "kill -1", "killall node"} {
		args, _ := json.Marshal(map[string]string{"command": command, "risk": "normal", "purpose": "mock only"})
		r := Request{Action: "shell", Args: args}
		executions, pending := 0, 0
		if checkActionSafety(r) == nil {
			executions++
		} else {
			pending++
		}
		if criticalKill(command) {
			if executions != 0 || pending != 1 {
				t.Fatal(command, executions, pending)
			}
			r.verifiedHuman = true
			if checkActionSafety(r) != nil {
				t.Fatal(command)
			}
			executions++
			if executions != 1 {
				t.Fatal(command)
			}
		} else if executions != 1 || pending != 0 {
			t.Fatal(command, executions, pending)
		}
	}
}
