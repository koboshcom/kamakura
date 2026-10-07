package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestBlockedStdinHelper(t *testing.T) {
	if os.Getenv("KAMA_BLOCKED_STDIN_HELPER") != "1" {
		return
	}
	fmt.Println("ready")
	time.Sleep(time.Hour) // Deliberately never read stdin.
	os.Exit(0)
}

func TestMCPBlockedStdinCancellation(t *testing.T) {
	for _, deadline := range []bool{true, false} {
		t.Run(fmt.Sprint("deadline=", deadline), func(t *testing.T) {
			c := exec.Command(os.Args[0], "-test.run=^TestBlockedStdinHelper$")
			c.Env = append(os.Environ(), "KAMA_BLOCKED_STDIN_HELPER=1")
			in, e := c.StdinPipe()
			if e != nil {
				t.Fatal(e)
			}
			out, e := c.StdoutPipe()
			if e != nil {
				t.Fatal(e)
			}
			if e = c.Start(); e != nil {
				t.Fatal(e)
			}
			defer func() { _ = in.Close(); _ = c.Process.Kill() }()
			if line, e := bufio.NewReader(out).ReadString('\n'); e != nil || line != "ready\n" {
				t.Fatalf("helper readiness %q %v", line, e)
			}
			m := &MCP{cmd: c, input: in, lines: make(chan []byte), stop: make(chan struct{})}
			ctx, cancel := context.WithCancel(context.Background())
			if deadline {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
			} else {
				time.AfterFunc(100*time.Millisecond, cancel)
			}
			defer cancel()
			args, _ := json.Marshal(map[string]string{"payload": strings.Repeat("x", 2<<20)})
			done := make(chan error, 1)
			go func() { _, e := m.Call(ctx, "test", args); done <- e }()
			select {
			case e := <-done:
				if e == nil || !strings.Contains(e.Error(), "cancelled") {
					t.Fatalf("expected cancellation, got %v", e)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("blocked stdin ignored cancellation")
			}
			if m.cmd != nil || c.ProcessState == nil {
				t.Fatal("driver not reaped/reset")
			}
			m.Close()
		})
	}
}
