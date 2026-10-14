package main

import (
	"encoding/json"
	"testing"
)

func TestActionSafetyCompatibility(t *testing.T) {
	for _, command := range []string{"rm -rf /work", "sudo rm -rf /home", "mkfs.ext4 /dev/fake", "pkill mongod", "apt install example"} {
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
